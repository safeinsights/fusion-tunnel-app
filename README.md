# fusion-tunnel-app

The SafeInsights **Fusion Tunnel App**: a per-study-job, per-leg enclave container for the Enclave Fusion Framework. It owns all inter-enclave communication and end-to-end encryption (Noise_IK). Researcher code talks only to its enclave-local API through the fusion SDK; the tunnel talks only to the Fusion Relay and the Management App (BMA). It is launched, provisioned and torn down by the Setup App and holds no long-lived secrets: every keypair is minted in memory at launch and dies with the container.

**Status: branch `simplify` (2026-09-24).** Local API v2 (`apiVersion 2.0.0`) and relay wire protocol v2, against a memory-only pass-through relay (`fusion-relay`, branch `simplify`). The in-process harness runs two-party and hub studies against in-repo fakes of the relay and the BMA. Not yet exercised against a real BMA.

- Authoritative spec: `SafeInsights Enclave Fusion Architecture Doc-v2.md` (§4.1, §5–§8, §13) in the parent workspace; design changes are recorded in `fusion-program/products/fusion/DECISIONS.md`
- Local API contract for SDK authors: `fusion-sdk/spec/local-api.md`
- Decisions: [`docs/decisions/`](docs/decisions/) — 0001 Noise library and explicit transport counters, 0002 one tunnel per leg

## What it does

One instance serves exactly one source→destination **leg**. At the hub (a SafeInsights-hosted destination enclave) a job runs one instance per Data Partner source as sidecars; the tunnel is not topology-aware beyond carrying `legId`.

1. **Identity.** Fresh X25519 static + Ed25519 proof-of-possession keypairs and a `connectionId` at every launch; private halves never serialize.
2. **Provisioning** (`GET /local/identity`, `POST /local/configure`, bearer `FUSION_PROVISION_TOKEN`). The Setup App publishes the org-signed key blob and delivers the bundle: relay endpoint/session/token, delegated credential, role, `studyId`/`jobId`/`legId`, session nonce, the pinned peer-org key **for this leg**, the local bearer token, the manifest caps and (on re-provision) `capsConsumed`.
3. **Peer key.** Polled from the BMA directory (204 until published), verified against the **pinned** org key — never against anything in the directory response — with generation monotonicity (strictly newer after a peer restart).
4. **Relay + channel.** Outbound WSS, token + PoP challenge, `Noise_IK_25519_ChaChaPoly_BLAKE2b` (destination initiates and pre-shares the source's static; the source compares the destination's static against the pin-verified directory key before message 2). Prologue binds study, session, org slugs, roles, generations and the BMA nonce. The relay tells each side whether the peer is attached and the peer's key fingerprint; a changed fingerprint means the peer restarted and the tunnel re-fetches the key and re-handshakes by itself.
5. **Local API** (bearer-authenticated): `GET /v1/info`, `POST /v1/request`, `DELETE /v1/request/:correlationId`, `GET /v1/responses/:correlationId`, `GET /v1/messages/next`, `POST /v1/messages`, `POST /v1/complete`. A `200` on a long-poll **is** the acknowledgement; there is no ack route. Direction is structural: a source has no route through which to originate.
6. **Reliability, owned entirely by the two tunnels.** 32 KiB chunks with AEAD-bound headers, bucketed padding, a bounded plaintext outbox re-encrypted across epochs and retransmitted on a timer (`ERRORED` after `FUSION_MAX_SENDS` or `FUSION_UNACKED_MAX_MS`), end-to-end ACKs, dedup by AEAD-protected `messageId`, NACK-discard, explicit transport counters with a replay window, source-enforced caps on response **and** query plaintext bytes, budget hints, authenticated CLOSE carrying the terminal code, token pre-fetch, content-free status reports. The relay stores nothing: a relay restart is just a reconnect.

## Contracts this repo owns (mirrored elsewhere)

| File                          | Contract                                                                          | Consumer        |
| ----------------------------- | --------------------------------------------------------------------------------- | --------------- |
| `src/schemas/provisioning.ts` | `/local/identity`, `/local/configure` bundle                                      | setup-app       |
| `src/local-api.ts`            | the `/v1/*` API (schemas + routes in one file)                                    | fusion-sdk      |
| `src/schemas/bma.ts`          | key blob + signature payload, peer-key, relay-session, credential, status report  | management-app  |
| `src/schemas/channel.ts`      | prologue, chunk header, transport frame, channel message (frozen v1 byte layouts) | the peer tunnel |
| `src/relay-protocol.ts`       | **verbatim copy** of `fusion-relay/src/protocol.ts`; `pnpm run check:protocol`    | fusion-relay    |

The fakes in `testing/` are built on these schemas and are the executable form of each contract.

## Running

```sh
pnpm install
pnpm run checks        # typecheck + lint + protocol mirror check
pnpm run test          # unit + in-process integration (two-party, close, hub studies), with coverage
pnpm run build         # esbuild → dist/server.js (CJS; sodium-native external)
pnpm run dev           # tsx watch
```

Compose stacks (fake relay, fake BMA, one fake Setup App, tunnels, scripted RCs):

```sh
pnpm run compose:two-party   # one leg dp-a → si-hub; exits with the destination RC's code
pnpm run compose:hub         # two legs (dp-a, dp-b) into one destination enclave
```

Every tunnel container runs `read_only` with no volumes; CI also starts the runtime image with `docker run --read-only` and checks `/health`.

### Environment

| Variable                                          | Meaning                                                                                                               | Default     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------- |
| `PORT`                                            | enclave-local listen port                                                                                             | 3003        |
| `FUSION_PROVISION_TOKEN`                          | **required** bootstrap bearer for `/local/*`; the Setup App injects it into the tunnel container only, never the RC's | —           |
| `FUSION_LONGPOLL_MS`                              | long-poll hold                                                                                                        | 25000       |
| `FUSION_HEARTBEAT_MS` / `FUSION_HEARTBEAT_MISSES` | relay heartbeat watchdog (ADMITTED cadence overrides)                                                                 | 30000 / 2   |
| `FUSION_RECONNECT_MIN_MS` / `_MAX_MS`             | relay re-dial backoff                                                                                                 | 500 / 30000 |
| `FUSION_TOKEN_REFRESH_LEAD_MS`                    | pre-fetch relay token / refresh credential this long before `exp`                                                     | 120000      |
| `FUSION_STATUS_INTERVAL_MS`                       | BMA status report cadence (also on transitions, near a cap, and terminally)                                           | 60000       |
| `FUSION_PEERKEY_POLL_MS`                          | directory poll while the peer has not published                                                                       | 5000        |
| `FUSION_CLOSE_TIMEOUT_MS`                         | bound on the CLOSE sequence                                                                                           | 30000       |
| `FUSION_HANDSHAKE_RETRY_MS` / `_MAX_ATTEMPTS`     | message-1 retry cadence / bound                                                                                       | 2000 / 300  |
| `FUSION_RETRANSMIT_MS`                            | re-send an un-ACKed message after this long                                                                           | 5000        |
| `FUSION_MAX_SENDS`                                | sends of one message before the leg is `ERRORED`                                                                      | 10          |
| `FUSION_UNACKED_MAX_MS`                           | age of the oldest un-ACKed message before the leg is `ERRORED`                                                        | 24 h        |
| `FUSION_BACKPRESSURE_RETRY_MS`                    | re-offer after relay BACKPRESSURE / RATE_LIMITED                                                                      | 500         |
| `FUSION_INFLIGHT_MAX_MSGS`                        | un-ACKed messages the outbox holds before `POST` answers 429                                                          | 64          |
| `FUSION_OUTBOX_MAX_BYTES`                         | plaintext bytes the outbox holds before `POST` answers 429                                                            | 256 MiB     |
| `FUSION_MAX_MESSAGE_BYTES`                        | largest message payload accepted on the local API (413 above)                                                         | 64 MiB      |
| `FUSION_INBOX_MAX_BYTES`                          | bound on partially reassembled inbound bytes                                                                          | 64 MiB      |
| `FUSION_EXIT_GRACE_MS`                            | keep the local API up after a terminal state                                                                          | 5000        |

All tuning values are **provisional** (v2 §15.6) pending load testing against the real relay. Padding buckets are a frozen wire constant (`PAD_BUCKETS` in `src/schemas/channel.ts`), not tuning.

### RC-facing env contract (what the Setup App injects)

`FUSION_ROLE` (`source|destination`); one leg: `FUSION_TUNNEL_ENDPOINT` + `FUSION_TUNNEL_TOKEN`; N legs at the hub: `FUSION_TUNNEL_ENDPOINTS` + `FUSION_TUNNEL_TOKENS` JSON maps keyed by leg label. `GET /v1/info` returns `{legId, peerOrgSlug, role, direction, state, caps, guards?, operations?, apiVersion}` so a peer-addressed SDK maps each endpoint to a peer.

## Lifecycle, terminal states and exit codes

`AWAITING_CONFIG → CONFIGURED → PEER_KEY_VERIFIED → RELAY_ATTACHED → CHANNEL_UP → CLOSING → CLOSED`, with `ERRORED` and `LIMIT_EXCEEDED` as failure terminals and `CHANNEL_UP → RELAY_ATTACHED` as the re-handshake path after the peer restarts.

Once a leg has ended, every `/v1` route except `/v1/info` answers `200 {terminal: true, code, message?, detail?}` (`STUDY_COMPLETE | SESSION_ERRORED | LIMIT_EXCEEDED`; `detail = {cap, limit, observed}` on a cap breach). Before the channel is up they answer `503 {code: "NOT_READY"}` with `Retry-After`. Errors are flat bodies `{code, message, ...}`. The process exits **0 on CLOSED, 1 on ERRORED, 2 on LIMIT_EXCEEDED** after the terminal status report and a grace period (`FUSION_EXIT_GRACE_MS`); `SIGTERM` reports a shutdown and exits 0. In a hub task the Setup App stops the whole task once every leg's tunnel has exited; a non-zero exit on any leg fails the run and nothing restarts (a restart from round 1 would re-consume the sources' caps).

The terminal code always comes from the peer's **authenticated** CLOSE (or this tunnel's own decision): a relay that ends a session without one produces `SESSION_ERRORED`, never `STUDY_COMPLETE`.

## Layout

```
src/
  server.ts tunnel.ts config.ts    entrypoint, per-instance composition (incl. /local routes), tuning table
  http.ts                          router, node:http adapter, JSON helpers, flat error bodies
  local-api.ts                     the /v1 contract: schemas, guard, routes
  relay-protocol.ts                verbatim copy of the relay's wire contract
  schemas/                         provisioning bundle, BMA, channel byte layouts (zod)
  lib/identity lifecycle long-poll exchange channel relay-client exit logger
  lib/noise/                       NoiseSession over noise-handshake, transport cipher, prologue, chunk header
  lib/bma/                         peer-key verification, credential helpers, BMA client
  reliability/                     padding, chunker, outbox, inbox, caps, delivery (retransmit + ACK)
testing/                           fake relay, fake BMA, fake Setup App, RC drivers, harnesses, compose entrypoints
tests/integration/                 reliability, close and study (two-party + hub) scenarios
docs/decisions/                    ADRs
```

## Known gaps and hand-offs

- **Not run against a real BMA.** The BMA endpoints in `schemas/bma.ts` are this repo's proposal and need the BMA team's review (notably `legId`-scoped directory rows, the relay-session response carrying the delegated credential on org-JWT calls, `POST /tunnel/credential`, and the strict status-report shape).
- **`/local/*` requires the bootstrap bearer** `FUSION_PROVISION_TOKEN` (security review C18 / threat model EB-08): the RC shares the tunnel's network namespace and must not be able to win the provisioning race. The Setup App has to mint a per-tunnel token, put it in the tunnel container's environment (not the RC's) and present it on both `/local` calls — Setup App work outside this repo.
- **Setup App work outside this repo**: N sidecars per hub task, per-leg provisioning, explicit `StopTask`, `capsConsumed` re-seeding from the BMA's last report.
- A source's re-issued unanswered query is re-queued for a restarted RC (v2 §8 row 3); a live RC must dedup by `correlationId`, which the SDK does.
- Runtime image is `node:22-bookworm-slim`, not Alpine: the `sodium-native` prebuild links glibc (ADR 0001).
