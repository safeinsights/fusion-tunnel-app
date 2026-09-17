# Fusion Tunnel App — Implementation Plan

**Date:** 2026-07-09 — **revised 2026-09-17 for the hub topology** (SafeInsights-hosted destination enclave; see §10 and the inline "§10" tags)
**Status:** Plan only — no fusion component is implemented yet; this repo is an empty scaffold.
**Authoritative spec:** `../SafeInsights Enclave Fusion Architecture Doc-v2.md` (v2, 2026-07-09) — especially §3 (invariants), §4.1 (Tunnel App), §5 (identity/keys), §6 (Noise_IK), §7 (message flow & reliability), §8 (failure recovery), §13 (deployment), §15 (open items).
**Authoritative sequence:** `../fusion-rc-querys.md` (two-party); `../drawings/fusion/FusionWithSafeInsightsEnclave-EnclaveSequence-Technical.md` and its `FusionWithSafeInsightsEnclave-technical-phases/` split (hub topology).
**Hub topology analysis:** `../.claude/fusion-hub-topology-review-2026-09-16.md` — §2.3 (query-side caps), §2.4 (per-leg items), §3 (tunnel/SDK rows), §5.2–§5.4 (read-only, StopTask, logging).
**Convention templates:** `../trusted-output-app` (primary) and `../setup-app`.

## What we're building

A per-study-job, **per-leg** TypeScript container, launched by the Setup App as a sidecar of the research container. One instance serves exactly one source→destination session. In the two-party topology a job has one leg and one tunnel; in the **hub topology** (§10) a SafeInsights-hosted destination job runs one tunnel instance per Data Partner source, as sidecars in the same task, each provisioned independently with its own leg's peer key, relay session, nonce and local bearer token. The tunnel itself is not topology-aware beyond carrying `legId`. It owns all inter-enclave communication and end-to-end encryption:

1. Generates in-memory X25519 static + Ed25519 proof-of-possession keypairs + a `connectionId` at every launch; nothing persisted, nothing leaves the container.
2. Exposes an enclave-local **provisioning API** (`GET /local/identity`, `POST /local/configure`) to the Setup App, which publishes the key blob and delivers the configuration bundle (relay endpoint/session/token, delegated JWT credential, role, direction, `studyId`/`jobId`/**`legId`**, session nonce, the pinned peer-org public key **for this leg**, the local API bearer token, the **per-study caps** from the Data-Partner-approved manifest and, on re-provision, **`capsConsumed`** — §10).
3. Fetches the peer tunnel key **for its leg** from the BMA directory (`GET /tunnel/peer-key?legId=…`, poll, 204 until published) and verifies the org signature against the **pinned** peer-org key plus generation monotonicity.
4. Dials outbound WSS to the relay, presents its token, answers the Ed25519 PoP challenge, and runs **Noise_IK** (destination initiates, pre-sharing the source's directory-verified static; the source verifies the destination's static from message 1 against the directory before replying) with a prologue binding `studyId ‖ relaySessionId ‖ org slugs ‖ roles ‖ generations ‖ session nonce`.
5. Exposes a bearer-authenticated **local API** to the research container: `POST /v1/request`, `GET /v1/responses/{correlationId}`, `GET /v1/messages/next`, `POST /v1/messages`, `POST /v1/messages/{id}/ack`, `POST /v1/complete`.
6. Implements the §7 reliability machinery: 32 KiB chunking with AEAD-bound chunk headers, bucketed padding, bounded in-memory plaintext outbox with re-encrypt-and-retransmit across epoch changes, two-stage ACK, dedup by AEAD-protected `messageId`, NACK-discard, blob-store path for large payloads, structural direction enforcement, **source-enforced per-study caps on response bytes out and on query bytes in (§10)**, CLOSE sequence, token pre-fetch/refresh, periodic content-free status reports (carrying `legId` and the cap counters), event-level logging.

## Hard constraint shaping this plan

**The Fusion Relay and the BMA fusion extensions do not exist** (`../fusion-relay` is an empty scaffold). Every phase must be testable standalone. The plan therefore builds **in-repo test doubles** — a fake relay and a fake BMA — on top of shared zod schemas, so that (a) two tunnel instances can run the full protocol through the fake relay in CI, and (b) the schemas + fakes become the executable wire contract the relay/BMA teams implement against.

---

## 0. Guiding decisions

### 0.1 Library choices

| Concern | Choice | Rationale |
| --- | --- | --- |
| WebSocket client | `ws` | §13 already commits the relay to a "`ws`-based Node service"; same library on both ends means one framing/heartbeat behavior to reason about. Explicit ping/pong control is needed for the heartbeat spec. Mature, zero-dep. |
| Noise implementation | `noise-handshake` (Holepunch) 4.x, pattern **IK** (`Noise_IK_25519_ChaChaPoly_BLAKE2b`), wrapped behind an in-repo `NoiseSession` interface — **decided 2026-09-16** (v2 §6, §15.1); the Phase 3 spike confirms against the official IK vectors and records ADR 0001 | Must be a vetted implementation, never hand-assembled primitives. Verified 2026-09-16 against the npm registry and GitHub: `noise-handshake` 4.2.0 (released 2025-12-01; its parent `@hyperswarm/secret-stream` released 2026-09-10) implements **NN, XX, IK, XK only — no KK**, so the earlier claim that it "supports arbitrary patterns including KK" was wrong; `@libp2p/noise` 17.0.2 (the ChainSafe package, merged into the js-libp2p monorepo 2026-09-02) is **XX-only** and coupled to libp2p's connection-encrypter interface. No maintained JS/TS Noise library implements KK, hence the pattern change to IK. `noise-handshake` runs IK in production for every hyperdht connection and ships reference-implementation tests for XX and IK. It is plain JavaScript — `@types/noise-handshake` 3.0.3 is stale (types the pattern as `'XX' \| 'IK'` against the 3.x API) — so ship a local `.d.ts` in `lib/noise/`. It is CommonJS on `sodium-universal` (`sodium-native` addon with JS fallback): confirm the CJS bundle and the Alpine/musl build in Phase 3. Rejected: forking `noise-handshake` to add KK; `noise-c.wasm` (unmaintained since 2018); WASM/native Rust `snow` (disproportionate build and audit surface for one equality check). |
| Ed25519 PoP + org-signature verify | `node:crypto` | Zero new deps. `@noble/curves` only if raw-byte key interop with the chosen Noise library makes `KeyObject`s awkward (decide in the Phase 3 spike). |
| Validation | `zod` (net-new, justified) | ~10 external JSON boundaries (config bundle, six local endpoints, BMA responses, relay control frames). Hand-written guards à la TOA would be hundreds of lines of unreviewable boilerplate; zod schemas double as the cross-team contract artifacts (§0.3). Confined to boundary parsing; internal code uses inferred types. |
| JWT | `jsonwebtoken` | House style (both siblings use it). The tunnel only *carries* the delegated credential and decodes `exp` for refresh scheduling; it never verifies BMA-issued JWTs. |
| IDs | `uuid` | House style. `messageId`, `correlationId`, `connectionId`. |
| Blob content keys | `node:crypto` ChaCha20-Poly1305 | Fresh content key per blob (§7.2); no new dependency. |

### 0.2 Protocol tuning defaults (§15.6)

All values live in `src/config.ts`, env-overridable, marked `// PROVISIONAL — §15.6, tune during load testing`:

| Knob | Env var | Placeholder default |
| --- | --- | --- |
| Chunk ciphertext max | (fixed by spec §7.2) | 32 KiB |
| Inline cap (above → blob path) | `FUSION_INLINE_CAP_BYTES` | 262144 (256 KiB) |
| Padding buckets | `FUSION_PAD_BUCKETS` | 1, 2, 4, 8, 16, 32 KiB |
| In-flight window (local default — the relay's `ADMITTED` frame advertises the authoritative limits, which the tunnel adopts on admission) | `FUSION_INFLIGHT_MAX_MSGS` / `_BYTES` | 64 msgs / 32 MiB (matches the relay plan's defaults) |
| Round timeout (SDK-facing default) | `FUSION_ROUND_TIMEOUT_MS` | 600000 |
| Long-poll hold time | `FUSION_LONGPOLL_MS` | 25000 |
| Heartbeat interval / miss threshold | `FUSION_HEARTBEAT_MS` | 30000 / 2 misses |
| Reconnect backoff | `FUSION_RECONNECT_*` | 500 ms → 30 s exponential + jitter |
| Token refresh lead time | `FUSION_TOKEN_REFRESH_LEAD_MS` | 120000 |
| Status report interval | `FUSION_STATUS_INTERVAL_MS` | 60000 |
| Peer-key poll interval | `FUSION_PEERKEY_POLL_MS` | 5000 |
| Close timeout | `FUSION_CLOSE_TIMEOUT_MS` | 30000 |

### 0.3 Contract-first schemas

Every cross-process message gets a zod schema in `src/schemas/` (`local-api.ts`, `provisioning.ts`, `bma.ts`, `relay-wire.ts`). `provisioning.ts` carries `legId`, the leg's pinned peer-org key, the `caps` object and `capsConsumed`; `bma.ts` scopes `peer-key` and `relay-session` by `legId`; `local-api.ts` includes the content-free `GET /v1/info` a peer-addressed SDK uses to learn which leg a tunnel serves (§10). The in-repo fakes (Phases 4/6) import these same schemas, so the fakes are executable contract documentation.

**Contract ownership (decided):** the **canonical relay wire contract lives in `fusion-relay/src/protocol/`** (frame codec, frame types, token claims, error codes, defaults — see `../fusion-relay/.claude/plans/2026-07-09-fusion-relay-implementation.md` §4), to be extracted to a shared package once both services exist. This repo's `schemas/relay-wire.ts` **mirrors** that contract and must be reviewed against it; `local-api.ts`, `provisioning.ts`, and `bma.ts` are owned here (the tunnel defines the Setup-App and RC-facing contracts).

### 0.4 Repo layout (mirrors TOA)

```
src/
  server.ts                     # entrypoint: wire state, start node:http server
  config.ts                     # env parsing + §0.2 tuning defaults + runtime bundle store
  http/                         # ported TOA pattern: router.ts, adapter.ts, json.ts
  schemas/                      # zod contracts: local-api, provisioning, bma, relay-wire
  routes/                       # one file per endpoint + co-located *.test.ts
    health.ts
    local-identity.ts  local-configure.ts
    request.ts  responses.ts  messages-next.ts  messages.ts  message-ack.ts  complete.ts  info.ts
  lib/
    identity.ts                 # X25519 + Ed25519 keygen, connectionId (in-memory only)
    auth.ts                     # local-API bearer-token check (net-new vs TOA)
    lifecycle.ts                # tunnel state machine (Phase 2) + recovery orchestrator (Phase 8)
    long-poll.ts                # waiter registry with hold-timeout for the two long-poll routes
    logger.ts                   # event-level, content-free structured logging
    noise/
      session.ts                # NoiseSession interface + prologue builder + epoch handle
      noise-handshake.ts        # adapter over the chosen library
      chunk-header.ts           # AEAD-bound header {messageId, chunkIndex, chunkCount, connectionId}
    relay/
      wire.ts                   # frame envelope encode/decode (DATA/ACK/NACK/CLOSE/peer-rejoined/backpressure/PoP)
      client.ts                 # WSS dial, token, PoP challenge, heartbeats, reconnect, displacement
      blob-client.ts            # HTTPS PUT/GET ciphertext blobs
    reliability/
      chunker.ts  padding.ts    # split/reassemble; bucket padding
      outbox.ts                 # bounded plaintext outbox, re-encrypt-and-retransmit on epoch change
      inbox.ts                  # reassembly buffers, messageId dedup + consumed-set, re-ACK
      delivery.ts               # two-stage ACK orchestration, direction enforcement, NACK-discard
      caps.ts                   # source-enforced per-study caps: query bytes in, response bytes out, rounds (§10)
    bma/
      client.ts                 # peer-key poll, relay-session/token refresh, status reports
      verify-peer-key.ts        # org-signature (domain-separated) + generation monotonicity
      credential.ts             # delegated JWT refresh scheduling
testing/
  fake-relay.ts  fake-bma.ts    # in-repo doubles (Phases 4/6)
  memory-transport.ts           # in-process duplex for Noise tests
  rc-client.ts                  # scripted research-container driver for the harness
tests/
  integration/                  # two-tunnel harness scenarios (Phase 9)
docs/decisions/                 # ADRs (0001 = Noise library, 0002 = one tunnel instance per leg — §10)
```

---

## Phase 1 — Scaffolding and toolchain

**Goal:** repo builds, lints, tests, and containerizes exactly like TOA; hand-rolled router serving `/health`.

**Work**
- `package.json`: pnpm 11 + corepack, Node ≥22, TOA's script names (`dev` via `tsx watch`, `build` via esbuild bundle to `dist/server.js`, `lint`, `typecheck`, `test`), ESM.
- `tsconfig.json` strict with `@/*` alias; ESLint flat config + Prettier (`semi: never`); `vitest.config.mjs` with `vite-tsconfig-paths` and coverage thresholds; husky + lint-staged.
- Port `src/http/{router,adapter,json}.ts` from `../trusted-output-app/src/http/` (copy the pattern, not a dependency); the router already supports `:param` paths — needed for `/v1/responses/:correlationId` and `/v1/messages/:id/ack`.
- `src/routes/health.ts`, `src/server.ts`, `src/config.ts` skeleton with the §0.2 tuning table.
- Multi-stage `node:22-alpine` Dockerfile (non-root, `HEALTHCHECK` on `/health`); the image must run with a **read-only root filesystem and no writable mounts** — the tunnel writes nothing to disk (memory-only outbox, no temp files) — so add a CI step that starts the container with `docker run --read-only` and hits `/health`. Mandatory at the hub (persistence policy none, §10), desirable everywhere; `.github/workflows/checks.yml` (lint → trivy fs + license → sonar → typecheck → test → build); `sonar-project.properties`, `trivy.yaml`, `.env.example`, `docker-compose.yml` stub.

**Tests:** router/adapter unit tests; CI green; `docker build` + healthcheck passes.

**Risk note:** TOA bundles to CJS (`--format=cjs`); the chosen Noise lib may be ESM/WASM. Confirm in Phase 3 that it survives `--bundle --format=cjs`; if not, this repo diverges to `--format=esm` — a deliberate, documented deviation.

## Phase 2 — Identity, provisioning API, local API skeleton

**Goal:** a tunnel that boots, mints its identity, can be provisioned by a (simulated) Setup App, and rejects/holds RC traffic correctly — no networking yet.

**Work**
- `lib/identity.ts`: X25519 static + Ed25519 PoP keypairs + `connectionId` generated at process start; module-private key state; expose public halves only.
- `lib/lifecycle.ts`: explicit state machine — `AWAITING_CONFIG → CONFIGURED → PEER_KEY_VERIFIED → RELAY_ATTACHED → CHANNEL_UP → CLOSING → CLOSED | ERRORED | LIMIT_EXCEEDED` (the last is the caps terminal state, §10). Every route and background loop keys off this. This is the spine of the app; get it right early.
- Routes: `GET /local/identity`; `POST /local/configure` validating the full bundle via `schemas/provisioning.ts`. Idempotent re-POST of the same bundle returns 200. `GET /v1/info` (bearer-authenticated, content-free): `{legId, peerOrgSlug, role, direction, state}` so a peer-addressed SDK can map each entry of its `FUSION_TUNNEL_ENDPOINTS` map to a peer (§10). (`/local/*` is protected by network posture per spec — see risk 8.)
- `lib/auth.ts`: constant-time bearer check on all `/v1/*` routes (net-new — TOA's local API is unauthenticated).
- All six `/v1/*` routes with `schemas/local-api.ts` validation, `lib/long-poll.ts` waiter registry, and correct pre-channel behavior (503/retry until `CHANNEL_UP`).
- **Direction enforcement lands here structurally** (§7.6 "structural, not advisory"): on `role=source`, `POST /v1/request` and `GET /v1/responses/*` return 403; `POST /v1/messages` requires `inReplyTo` matching a delivered query. On `role=destination`, `GET /v1/messages/next` is forbidden; single-in-flight is enforced (409 on a second concurrent `POST /v1/request`).

**Tests:** auth (missing/wrong token); state gating; the role × endpoint direction matrix; long-poll hold/timeout/wakeup; bundle-validation failures; in-process boot → identity → configure → state-transition assertions.

## Phase 3 — Crypto core: Noise_IK over an in-memory transport

**Goal:** two `NoiseSession` instances in one process handshake and exchange AEAD frames; the §15.1 library decision is resolved and recorded.

**Work**
- **Timeboxed spike first:** implement IK with `noise-handshake` — destination `new Noise('IK', true, static).initialise(prologue, sourceStatic)`; source `new Noise('IK', false, static).initialise(prologue)` then compare `rs` after `recv(msg1)` and before `send(msg2)`; confirm the CJS bundle and the `sodium-native` build on the Alpine image; record the decision in `docs/decisions/0001-noise-library.md` (library, pattern, the 2026-09-16 verification evidence from the §0 table, and the rejected alternatives).
- `lib/noise/session.ts`: `NoiseSession` interface — `initiate()/respond()`, `writeMessage(plaintext, aad)`, `readMessage(ciphertext, aad)`, epoch id. **Both roles take `expectedRemoteStatic` as a required constructor argument and compare `rs` constant-time (`crypto.timingSafeEqual`) before exposing transport keys** — the source right after `recv(msg1)` and before `send(msg2)`, the destination after `recv(msg2)` (redundant with IK's in-protocol binding; kept so both roles share one code path). Handshake payloads are always empty (IK's message-1 payload has weaker properties). A handshake message arriving on an established session is ignored unless the lifecycle machine is in a re-handshake state (`peer-rejoined` or own reconnect). Prologue builder producing the canonical byte encoding of `studyId ‖ relaySessionId ‖ org slugs ‖ roles ‖ generations ‖ sessionNonce` (§6). **This byte layout is a wire contract — document it in `schemas/` and freeze it.**
- `lib/noise/chunk-header.ts`: canonical encoding of `{messageId, chunkIndex, chunkCount, senderConnectionId}` fed as AEAD associated data (§7.2).
- Per-direction monotonic nonce / replay rejection via the library's transport state; verify with out-of-order and repeated ciphertexts.
- `testing/memory-transport.ts`: in-process duplex pipe.

**Tests:** official Noise IK/25519/ChaChaPoly/BLAKE2b test vectors through the adapter; full handshake over memory transport; prologue mismatch (any single field differing) fails; tampered chunk header (AAD) fails decrypt; replayed ciphertext rejected; wrong source static at the destination fails cryptographically (no msg 2 is ever produced); wrong destination static presented to the source is rejected before msg 2 and no transport key is exposed; a `NoiseSession` cannot be constructed without `expectedRemoteStatic`; a replayed msg 1 on an established session is ignored.

## Phase 4 — Relay client and fake relay

**Goal:** a tunnel attaches to a relay over real WSS on localhost, survives disconnects, and two tunnels complete the Noise handshake through it.

**Work**
- `schemas/relay-wire.ts`: **mirror of the canonical contract in `fusion-relay/src/protocol/` (§0.3)** — binary frame `[ver u8][type u8][headerLen u32BE][JSON header][payload]`; types HELLO / CHALLENGE / CHALLENGE_RESPONSE / ADMITTED / DATA / ACK / NACK_DISCARD / CLOSE / CLOSE_ACK / PEER_REJOINED / ERROR / HANDSHAKE. Tunnel-sent DATA headers carry `{messageId, chunkIndex, chunkCount, epochTag, respondsTo?, sizeBytes}` — `respondsTo` (plaintext messageId linkage) is what lets the relay implement the query-retention rule, and the declared `sizeBytes` is how a message reserves its window slot at the lead chunk; `seq` is **relay-assigned** and appears only on relay→tunnel pushes. `BACKPRESSURE` is an ERROR *code*, not a frame type. The relay's `ADMITTED` frame advertises `{relaySessionId, legId, role, heartbeatIntervalMs, limits{windowMsgs, windowBytes, maxChunkBytes, inlineCapBytes}}`, which the tunnel adopts over its local defaults (and cross-checks `legId`/`role` against its bundle — a mismatch is a provisioning error, §10).
- `lib/relay/client.ts`: outbound WSS dial with token; PoP challenge signing — Ed25519 over the **domain-separated payload** `"SI-FUSION-RELAY-POP-v1" ‖ nonce ‖ relaySessionId ‖ role` (matching the relay plan's `protocol/pop.ts`); admission (adopt `ADMITTED` limits); heartbeat monitoring; exponential-backoff reconnect using the pre-fetched token; displacement semantics (a valid re-admission closes the previous socket — treat unexpected close + successful re-dial as normal); event emission into the lifecycle machine. Keep a transport seam for the future long-poll fallback (§15.3).
- `testing/fake-relay.ts`: an in-repo `ws` server implementing the §4.2 contract — token verification (against a test keypair standing in for the BMA), PoP challenge, one-live-connection-per-role displacement, per-direction FIFO mailboxes (in-memory), buffered/delivered/consumed/deleted states with the query-retention rule, NACK-discard, old-epoch purge on new-epoch admission, in-flight window with `BACKPRESSURE`, `peer-rejoined` signal, CLOSE purge. Built on `schemas/relay-wire.ts` so it doubles as the relay team's executable contract.

**Tests:** wire encode/decode and PoP signing units; single tunnel admission (bad token rejected, bad PoP rejected, valid pair admitted); kill socket → reconnect resumes session; displacement; two tunnels complete IK through the fake relay (handshake frames as opaque payloads); heartbeat miss triggers re-dial.

## Phase 5 — Reliability layer

**Goal:** end-to-end message delivery with full §7.3 semantics between two tunnels through the fake relay.

**Work**
- `reliability/chunker.ts` + `padding.ts`: split plaintext into ≤32 KiB-ciphertext chunks with AEAD-bound headers; pad each frame to the next configured bucket (length-prefixed inside plaintext); strip on receive.
- `reliability/outbox.ts`: bounded (by the in-flight window) in-memory plaintext store of un-ACKed sent messages keyed by `messageId`; on epoch change, re-encrypt under the new session keys and re-send in seq order; evict on stage-two ACK.
- `reliability/inbox.ts`: per-message reassembly buffers; dedup by AEAD-protected `messageId` with idempotent re-ACK of already-consumed messages; NACK-discard emission for undecryptable (stale-epoch) frames.
- `reliability/delivery.ts`: two-stage ACK orchestration (stage one implicit on tunnel receipt, stage two driven by `POST /v1/messages/{id}/ack` and forwarded end-to-end); query↔response correlation (`inReplyTo`); `BACKPRESSURE` surfaced to the local API as a retryable 429; source-side cached-response replay for re-delivered `correlationId`s.
- `reliability/caps.ts` (§10; security review §7.3 + memo §2.3): the **source** tunnel meters plaintext — response bytes per round and cumulative, `maxRounds`, `maxRoundsPerHour`, and **query bytes per round and cumulative** (decrypted query size on receipt — in the hub topology a query to this source may carry information derived from the *other* source's answers, and the Data Partner approved a bound on that). Limits arrive in the configuration bundle from the Data-Partner-approved manifest. On breach: refuse the message, return a typed `LIMIT_EXCEEDED` error to the RC, send an authenticated `LIMIT_EXCEEDED` control message to the destination through the channel (same class as CLOSE), transition to the terminal `LIMIT_EXCEEDED` state, and report it to the BMA — never silent throttling. The destination surfaces it as a typed terminal SDK error; remaining-budget hints piggyback on responses so researcher code sees consumption approaching limits. **Counter durability:** the tunnel persists nothing, so cumulative counters are re-seeded on re-provision from `capsConsumed` in the bundle (the Setup App obtains it from the BMA's last status report); status reports therefore carry the counters, and the report cadence bounds the under-count window after a restart — tighten by reporting after every completed round once any counter is within 10 % of its limit.
- Wire the routes to this layer: `POST /v1/request` → outbox/send; delivered messages → long-poll waiters; source `POST /v1/messages` validated against delivered-query correlation.

**Tests** (scenario-heavy, all against the fake relay): N-round happy path with payloads spanning 1..many chunks and bucket boundaries; duplicate delivery → single RC delivery + re-ACK; lost-ACK convergence; epoch change mid-flight (restart one tunnel: new identity, re-handshake via `peer-rejoined`) → outbox re-encrypt/re-send with no RC-visible duplicate; stale-epoch NACK-discard; window exhaustion → backpressure; transport-level direction enforcement; FIFO ordering across messages; chunker/padding round-trip fuzzing; caps — a query-side breach and a response-side breach each yield `LIMIT_EXCEEDED` at the source, a typed terminal error at the destination and a status report, with no partial delivery; counters re-seeded from `capsConsumed` survive a simulated restart (§10).

## Phase 6 — BMA client: peer key, credentials, status

**Goal:** the tunnel performs every Management-App interaction against an in-repo fake BMA.

**Work**
- `testing/fake-bma.ts`: `node:http` server implementing `GET /tunnel/peer-key` (204-until-published, then signed key blob with directory-assigned generation), `GET /tunnel/relay-session` (issuance + token refresh), status-report ingestion — built on `schemas/bma.ts`; all scoped by `legId` (directory rows and the generation counter per `(study, leg, org)`, one relay session and one nonce per leg); run-group semantics for the Phase 9 harness — a run becomes visible only when every leg is launch-eligible, and a launch-window expiry fails all legs atomically; status ingestion retains the cap counters and serves them back as `capsConsumed` on re-provision (§10); test hooks (publish key, advance generation, expire tokens) plus the provisioning-side flavor the Phase 9 harness's fake Setup App uses.
- `lib/bma/verify-peer-key.ts`: verify `keySignature` over the domain-separated payload (`"SI-FUSION-TUNNEL-KEY-v1" ‖ studyId ‖ jobId ‖ legId ‖ connectionId ‖ publicKey ‖ popKey` — `legId` added 2026-09-17 so a hub tunnel's blob cannot be replayed into the sibling leg's directory slot, §10) against the **pinned** peer-org key from the config bundle — never against anything in the directory response (invariant 8); enforce generation ≥ last-seen (bootstrapped from the first fetch); on failure, stay in polling state with a loud log/status flag.
- `lib/bma/client.ts`: peer-key poll loop (drives `CONFIGURED → PEER_KEY_VERIFIED`; re-fetch on `peer-rejoined`); relay-token pre-fetch before expiry using the delegated credential; periodic content-free status reports (channel state, key generations in use, last seq sent/ACKed per direction, rounds completed, outbox depth — §12 — plus `legId` and the cap counters: query bytes received, response bytes served, rounds, §10).
- `lib/bma/credential.ts`: schedule delegated-JWT refresh from its `exp`.

**Tests:** signature verification against known-good/known-bad blobs (wrong org key, tampered field, wrong domain prefix, stale generation); 204-poll loop; token pre-fetch timing (fake clock); status-report payload shape and content-freeness (assert no payload-derived fields); `peer-rejoined` → re-fetch → higher generation accepted, rollback rejected.

## Phase 7 — Blob path for large payloads

**Goal:** payloads above the inline cap travel via the relay blob store (§7.2).

**Work**
- `lib/relay/blob-client.ts`: HTTPS PUT/GET of ciphertext blobs to the relay endpoint (same host — egress posture unchanged), authenticated with the relay token, with retries.
- Sender path in `delivery.ts`: size > `FUSION_INLINE_CAP_BYTES` → encrypt under a fresh ChaCha20-Poly1305 content key → PUT → send pointer message `{blobId, wrappedContentKey, size, contentHash}` through the channel (the pointer chunk/pad/outbox/ACKs like any message). Receiver: GET → decrypt → deliver. **Decision point:** whether the outbox retains large plaintexts or ciphertext+key for epoch-retransmit (memory bound) — re-upload if the relay purged the blob.
- Extend `testing/fake-relay.ts` with blob endpoints + session-scoped purge.

**Tests:** round trip at cap±1 byte; multi-MiB payload; blob GET failure → retry → round-timeout backstop; blob purged at close; pointer retransmission across an epoch change.

## Phase 8 — Close and failure flows

**Goal:** every tunnel-observable row of the §8 failure table has an implemented, tested behavior.

**Work**
- `POST /v1/complete` → authenticated CLOSE through the channel + session-close control to the relay → await acks bounded by `FUSION_CLOSE_TIMEOUT_MS` → source long-poll returns terminal `STUDY_COMPLETE` → terminal status report to the BMA → `CLOSED`, process exits **0**. Terminal `ERRORED` / `LIMIT_EXCEEDED` exit **non-zero**. Exit codes are a contract with the Setup App (§10): in the hub's multi-sidecar task the Setup App stops the whole task explicitly once every leg's tunnel has exited (memo §5.3), and a non-zero exit on any leg marks the run failed — the hub restarts nothing, because restarting from round 1 would re-consume the sources' caps.
- Terminal errors: dead-letter notification from the relay, TTL-expiry-of-unACKed signal, poison session → `ERRORED`, error status report, all local API calls return a typed terminal error the fusion SDK can surface.
- Consolidate the reconnect/re-handshake paths from Phases 4–6 into a single recovery orchestrator in `lifecycle.ts` (who re-fetches what, in what order, on `peer-rejoined` vs own reconnect).

**Tests** (failure injection against the fakes): close happy path; close with lost ack (relay purge-after-timeout); peer restart mid-round; own restart (new process, harness Setup App re-provisions, destination re-issues by `correlationId`); dead-letter → both sides errored; source RC crash after stage-two ACK (query retained → redelivered → cached-response replay).

## Phase 9 — Integration harness and docker-compose wiring

**Goal:** one command runs two real tunnel instances through an N-round analysis via the fake relay, with no real Core services; this suite becomes the regression bed the real relay/BMA are later swapped into.

**Work**
- `tests/integration/harness.ts`: boots fake BMA + fake relay + two tunnels (in-process for CI speed; containers for compose), plays the Setup App (provision both sides, publish keys, deliver bundles) and both RCs via `testing/rc-client.ts` (destination request/poll/ack loop; source long-poll/handler/respond loop).
- Scenario suite: multi-round happy path, every Phase 8 failure scenario, chunk/blob/padding boundary cases.
- **Hub scenario suite (§10):** three simulated enclaves — a hub running **two** tunnel instances (legs A and B) plus one scripted hub RC driving the peer-addressed `rc-client` (queries alternate legs, the query to B derived from A's answer), and two source enclaves each with one tunnel and a scripted handler. Assertions: frames of leg A never reach leg B's tunnel or RC; a key blob signed by source B's org key fails verification at source A (the isolation guarantee, memo §2.2); `complete()` fans out and both legs CLOSE; restarting hub tunnel-A re-handshakes leg A only; a query-side cap breach on leg B terminates leg B alone with a typed error at the hub; the fake BMA's run group fails atomically when one leg never launches.
- `docker-compose.yml`: two profiles — *two-party* (two tunnel containers + fake-relay + fake-bma + tiny scripted RC containers on per-job bridge networks, mirroring the Docker backend, §4.4/§13) and *hub* (§10: a hub network with two tunnel containers and one RC, plus two source networks). Every tunnel container runs `read_only: true` with no volumes — the tunnel must write nothing to disk, which is mandatory at the hub (persistence policy none). Documents the env contract setup-app's launchers will use: `FUSION_TUNNEL_ENDPOINT` (single leg) or the `FUSION_TUNNEL_ENDPOINTS` map (hub), one bearer token per tunnel, port.
- Coordinate (outside this repo, flagged): setup-app's fusion launch work consumes `/local/identity` + `/local/configure` per `schemas/provisioning.ts`.

**Tests:** the harness is the test; the in-process harness always runs in `checks.yml`; add a compose smoke job if CI runtime permits.

---

## Risks and open questions

1. **Noise library maturity (highest risk).** Resolved at design level 2026-09-16: `noise-handshake` with IK (§0 table). Residual: the library is production-used but less formally audited than libp2p's, and the destination's identity binding now rests on the wrapper's equality check rather than on the handshake. Mitigation: the check is structural (required constructor argument, transport keys withheld until it passes) and tested; official IK vectors through the adapter; the C13 formal model includes the check. Escalate only if the Phase 3 spike fails on the CJS bundle, the musl build, or the vectors — next: WASM `snow`. Record as ADR 0001.
2. **Contract drift.** The fakes become the de-facto wire spec before the real services exist. Mitigation: `src/schemas/` as single source of truth, versioned frame envelope, early review of `relay-wire.ts`/`bma.ts` with the relay/BMA teams; consider a shared package once `fusion-relay` starts.
3. **Long-poll fallback (§15.3) deferred.** WSS-only here; `relay/client.ts` keeps a transport seam.
4. **Outbox memory bounds vs blob retransmit** (Phase 7 decision point).
5. **CJS bundle vs ESM/WASM deps** (Phase 1 note) — may force `--format=esm`, a documented deviation from TOA.
6. **Single-process concurrency.** Long-poll waiters, WSS events, reconnect, and refresh timers interleave; the lifecycle state machine + fake-clock tests are the mitigation — no ad-hoc booleans.
7. **All §0.2 tuning values are provisional** pending load testing with the real relay (§15.6).
8. **`/local/*` trust.** Protected by network posture only per spec; confirm with the setup-app team whether a bootstrap token is wanted (per-backend enforcement is §13's problem).
9. **Setup App backend unification (§15.5)** is upstream pre-work owned by setup-app; this plan fixes the tunnel-side contract so fusion wiring lands once regardless of that decision.
10. **Cumulative caps in a stateless tunnel (§10).** The source tunnel enforces per-study cumulative limits but persists nothing; a restart forgets consumption. Mitigation: counters ride the content-free status reports and are re-seeded from `capsConsumed` at re-provision; the residual under-count is bounded by the report cadence and shrinks to one round near the limit. Accept and document, or have the Setup App hold the counters locally as a second source.
11. **N sidecars per hub task is blocked upstream** (§10): `../setup-app/src/lib/aws.ts` overwrites `image` on every container of a derived task definition and drops `volumes`/`ephemeralStorage`, so a second tunnel sidecar cannot launch on ECS today. Owned by setup-app; this plan's Phase 9 compose profile is the contract they implement against.
12. **The peer-addressed SDK lives outside this repo** (§10). Its contract with the tunnel is `GET /v1/info` plus the `FUSION_TUNNEL_ENDPOINTS` map and one bearer token per tunnel; the source-side distinct-Person-ID guard (`maxDistinctPersonIds`, `minGroupSize`) is an SDK handler-wrapper concern, not a tunnel one — the tunnel cannot parse query semantics.

## 10. Hub topology (recorded 2026-09-17): SafeInsights-hosted destination enclave

**Status: decided as an additional topology** (product owner, 2026-09-16); the two-party, Data-Partner-hosted destination remains supported. Data Partners A and B are **sources**; SafeInsights hosts a data-less, ephemeral **destination** enclave in a dedicated AWS account; the two Data Partner enclaves never connect to each other. Authoritative analysis: `../.claude/fusion-hub-topology-review-2026-09-16.md`. Drawings: `../drawings/fusion/FusionWithSafeInsightsEnclave-*`.

**Model.** One tunnel instance per **leg**. A hub destination job runs two instances — tunnel-A (peer = Data Partner A) and tunnel-B (peer = Data Partner B) — as sidecars in one task, each with its own in-memory keypairs, `connectionId`, `relaySessionId`, nonce, delegated credential, pinned peer-org key and local bearer token. Each instance runs the two-party protocol verbatim; the research container addresses them through a peer-addressed SDK. Choosing instances over one multiplexing process keeps every §4.1 invariant (one session, one outbox, one epoch) per process and makes the customers' hard requirement — B's traffic never reaches A — a matter of process isolation rather than an in-process routing table.

**What this repo does NOT change:** Noise_IK and the `NoiseSession` equality check, the prologue contents (`relaySessionId` is already per leg), chunking/padding/outbox/inbox/two-stage ACK, the relay wire contract (mirrored from `fusion-relay/src/protocol/`, which gains only `legId` routing metadata), structural direction enforcement, CLOSE, token refresh, the fake relay.

**Deltas absorbed into Phases 1–9 (tagged §10 inline):**

1. **`legId`** in the configuration bundle, the org-signed key-blob payload, the delegated credential's claims, the `peer-key`/`relay-session` queries, `GET /v1/info`, and status reports (Phases 2, 6).
2. **`GET /v1/info`** (Phase 2) — the discovery hook for the peer-addressed SDK.
3. **`reliability/caps.ts`** (Phase 5): source-enforced per-study caps on response bytes *and* query bytes, `maxRounds`/`maxRoundsPerHour`, the terminal `LIMIT_EXCEEDED` state, the authenticated `LIMIT_EXCEEDED` control message, budget hints, and counter re-seeding from `capsConsumed`. The query-side cap is the tunnel's share of bounding the A → hub → B information path (memo §2.3, proposed threat-model entry AP-08).
4. **Exit-code contract** (Phase 8): 0 on `CLOSED`, non-zero on `ERRORED`/`LIMIT_EXCEEDED`, so the Setup App can stop a multi-sidecar hub task explicitly and fail the run without restart.
5. **Read-only root filesystem** proven in CI (Phase 1) and in compose (Phase 9).
6. **Fake BMA** run-group and per-leg semantics (Phase 6); **hub scenario suite** and compose *hub* profile (Phase 9).
7. **ADR 0002** — one tunnel instance per leg.

**Outside this repo, flagged for the owning teams:** BMA run-group state machine, leg-scoped directory and credential issuance, reviewer-key union over source orgs with no SafeInsights reviewer, C19 release hop; Setup App N-sidecar launch (the `aws.ts` image-override fix), per-leg provisioning, explicit `StopTask`; the fusion SDK's peer handle, `complete()` fan-out and distinct-Person-ID guard; `iac/fusion-enclave` (dedicated account, KMS Sign-only org key, SCPs, Config, no IAM path to Core).

## Key reference files

- `../SafeInsights Enclave Fusion Architecture Doc-v2.md` — §4.1, §5–§8 drive nearly every module
- `../fusion-rc-querys.md` — authoritative phase ordering for the lifecycle machine and harness scenarios
- `../trusted-output-app/src/http/{router,adapter,json}.ts` — the router pattern to port in Phase 1
- `../trusted-output-app/package.json`, `Dockerfile`, `eslint.config.mjs`, `vitest.config.mjs`, `.github/workflows/checks.yml` — toolchain templates
- `../setup-app/src/lib/` (`enclave.ts`, `docker-enclave.ts`, `kube-enclave.ts`, `docker.ts`, `api.ts`) — the launcher this app's provisioning contract must integrate with
- `../.claude/fusion-hub-topology-review-2026-09-16.md` — hub-topology review memo (§10 of this plan)
- `../drawings/fusion/FusionWithSafeInsightsEnclave-EnclaveSequence-Technical.md` and `FusionWithSafeInsightsEnclave-technical-phases/` — hub-topology sequences (two tunnel instances at the destination)
- `../fusion_security_review.md` §7.3 — the caps design `reliability/caps.ts` implements
