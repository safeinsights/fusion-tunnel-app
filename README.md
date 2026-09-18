# fusion-tunnel-app

The SafeInsights **Fusion Tunnel App**: a per-study-job, per-leg enclave container for the Enclave Fusion Framework. It owns all inter-enclave communication and end-to-end encryption (Noise_IK). Researcher code talks only to its enclave-local API through the fusion SDK; the tunnel talks only to the Fusion Relay and the Management App (BMA). It is launched, provisioned and torn down by the Setup App and holds no long-lived secrets: every keypair is minted in memory at launch and dies with the container.

**Status: implemented through plan Phase 9 on `feat/tunnel-app`** — provisioning and local API, Noise_IK channel, reliability protocol, BMA client, blob path, CLOSE and failure flows, and an in-process harness that runs two-party and hub studies against in-repo fakes of the relay and the BMA. Not yet exercised against the real relay (`fusion-relay`, branch `feat/relay-implementation`) or a real BMA; the compose stacks are built in CI but were not run on the authoring machine (no Docker daemon).

- Authoritative spec: `SafeInsights Enclave Fusion Architecture Doc-v2.md` (§4.1, §5–§8, §13) in the parent workspace
- Sequence diagrams: `fusion-rc-querys.md` (two-party); `drawings/fusion/FusionWithSafeInsightsEnclave-technical-phases/` (hub)
- Implementation plan: [`.claude/plans/2026-07-09-implementation-plan.md`](.claude/plans/2026-07-09-implementation-plan.md)
- Decisions: [`docs/decisions/`](docs/decisions/) — 0001 Noise library and explicit transport counters, 0002 one tunnel per leg, 0003 blob outbox retention

## What it does

One instance serves exactly one source→destination **leg**. At the hub (a SafeInsights-hosted destination enclave) a job runs one instance per Data Partner source as sidecars; the tunnel is not topology-aware beyond carrying `legId`.

1. **Identity.** Fresh X25519 static + Ed25519 proof-of-possession keypairs and a `connectionId` at every launch; private halves never serialize.
2. **Provisioning** (`GET /local/identity`, `POST /local/configure`). The Setup App publishes the org-signed key blob and delivers the bundle: relay endpoint/session/token, delegated credential, role, `studyId`/`jobId`/`legId`, session nonce, the pinned peer-org key **for this leg**, the local bearer token, the manifest caps and (on re-provision) `capsConsumed`.
3. **Peer key.** Polled from the BMA directory (204 until published), verified against the **pinned** org key — never against anything in the directory response — with generation monotonicity (strictly newer after a peer rejoin).
4. **Relay + channel.** Outbound WSS, token + PoP challenge, `Noise_IK_25519_ChaChaPoly_BLAKE2b` (destination initiates and pre-shares the source's static; the source compares the destination's static against the pin-verified directory key before message 2). Prologue binds study, session, org slugs, roles, generations and the BMA nonce.
5. **Local API** (bearer-authenticated): `GET /v1/info`, `POST /v1/request`, `GET /v1/responses/:correlationId`, `GET /v1/messages/next`, `POST /v1/messages`, `POST /v1/messages/:id/ack`, `POST /v1/complete`. Direction is structural: a source has no route through which to originate.
6. **Reliability.** 32 KiB chunks with AEAD-bound headers, bucketed padding, a bounded plaintext outbox re-encrypted across epochs, two-stage ACK, dedup by AEAD-protected `messageId`, NACK-discard, explicit transport counters with a replay window, source-enforced caps on response **and** query plaintext bytes, budget hints, blob path above the inline cap, authenticated CLOSE, token pre-fetch, content-free status reports.

## Contracts this repo owns (mirrored elsewhere)

| File                          | Contract                                                                                        | Consumer        |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | --------------- |
| `src/schemas/provisioning.ts` | `/local/identity`, `/local/configure` bundle                                                    | setup-app       |
| `src/schemas/local-api.ts`    | the `/v1/*` API, incl. SDK asks T1–T6                                                           | fusion-sdk      |
| `src/schemas/bma.ts`          | key blob + signature payload, peer-key, relay-session, credential, status report                | management-app  |
| `src/schemas/channel.ts`      | prologue, chunk header, transport frame, channel message, blob pointer (frozen v1 byte layouts) | the peer tunnel |
| `src/schemas/relay-wire.ts`   | **mirror** of `fusion-relay/src/protocol/` (reviewed 2026-09-18)                                | fusion-relay    |

The fakes in `testing/` are built on these schemas and are the executable form of each contract.

## Running

```sh
pnpm install
pnpm run checks        # typecheck + lint
pnpm run test          # unit + in-process integration (two-party, blob, close, hub studies)
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

| Variable                                          | Meaning                                                                                        | Default     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| `PORT`                                            | enclave-local listen port                                                                      | 3003        |
| `FUSION_INLINE_CAP_BYTES`                         | above this plaintext size a message takes the blob path (the relay's ADMITTED limit overrides) | 262144      |
| `FUSION_PAD_BUCKETS`                              | wire frame sizes for padding, ascending, ≤ 32768                                               | 1024…32768  |
| `FUSION_INFLIGHT_MAX_MSGS` / `_BYTES`             | local window (ADMITTED overrides)                                                              | 64 / 32 MiB |
| `FUSION_LONGPOLL_MS`                              | long-poll hold                                                                                 | 25000       |
| `FUSION_HEARTBEAT_MS` / `FUSION_HEARTBEAT_MISSES` | relay heartbeat watchdog (ADMITTED cadence overrides; 0 = off)                                 | 30000 / 2   |
| `FUSION_RECONNECT_MIN_MS` / `_MAX_MS`             | relay re-dial backoff                                                                          | 500 / 30000 |
| `FUSION_TOKEN_REFRESH_LEAD_MS`                    | pre-fetch relay token / refresh credential this long before `exp`                              | 120000      |
| `FUSION_STATUS_INTERVAL_MS`                       | BMA status report cadence (also on transitions, near a cap, and terminally)                    | 60000       |
| `FUSION_PEERKEY_POLL_MS`                          | directory poll while the peer has not published                                                | 5000        |
| `FUSION_CLOSE_TIMEOUT_MS`                         | bound on the CLOSE sequence                                                                    | 30000       |
| `FUSION_HANDSHAKE_RETRY_MS` / `_MAX_ATTEMPTS`     | message-1 retry cadence / bound                                                                | 2000 / 300  |
| `FUSION_BACKPRESSURE_RETRY_MS`                    | re-offer after relay BACKPRESSURE                                                              | 500         |
| `FUSION_INBOX_MAX_BYTES`                          | bound on partially reassembled inbound bytes                                                   | 64 MiB      |
| `FUSION_BLOB_RETRY_MS` / `_MAX_ATTEMPTS`          | blob store retry                                                                               | 500 / 8     |
| `FUSION_EXIT_GRACE_MS`                            | keep the local API up after a terminal state                                                   | 5000        |

All tuning values are **provisional** (v2 §15.6) pending load testing against the real relay.

### RC-facing env contract (what the Setup App injects, SDK ask S1)

`FUSION_ROLE` (`source|destination`); one leg: `FUSION_TUNNEL_ENDPOINT` + `FUSION_TUNNEL_TOKEN`; N legs at the hub: `FUSION_TUNNEL_ENDPOINTS` + `FUSION_TUNNEL_TOKENS` JSON maps keyed by leg label. `GET /v1/info` returns `{legId, peerOrgSlug, role, direction, state, caps, guards?, operations?, apiVersion}` so a peer-addressed SDK maps each endpoint to a peer.

## Lifecycle, terminal states and exit codes

`AWAITING_CONFIG → CONFIGURED → PEER_KEY_VERIFIED → RELAY_ATTACHED → CHANNEL_UP → CLOSING → CLOSED`, with `ERRORED` and `LIMIT_EXCEEDED` as failure terminals and `CHANNEL_UP → RELAY_ATTACHED` as the re-handshake path after `PEER_REJOINED`.

Long-poll routes answer terminal states with `200 {terminal: true, code}` (`STUDY_COMPLETE | SESSION_ERRORED | LIMIT_EXCEEDED`); every other `/v1` route with `410` and the same body. The process exits **0 on CLOSED, 1 on ERRORED, 2 on LIMIT_EXCEEDED** after the terminal status report and a grace period (`FUSION_EXIT_GRACE_MS`); `SIGTERM` reports a shutdown and exits 0. In a hub task the Setup App stops the whole task once every leg's tunnel has exited; a non-zero exit on any leg fails the run and nothing restarts (a restart from round 1 would re-consume the sources' caps).

## Layout

```
src/
  server.ts tunnel.ts config.ts    entrypoint, per-instance composition, tuning table
  http/                            router, node:http adapter, JSON helpers, error bodies
  schemas/                         the contracts above (zod)
  routes/                          one file per endpoint + guard
  lib/identity lifecycle auth long-poll exchange channel exit recovery logger
  lib/noise/                       NoiseSession over noise-handshake, transport cipher, prologue, chunk header
  lib/relay/                       WSS client, blob client
  lib/bma/                         peer-key verification, credential helpers, BMA client
  reliability/                     padding, chunker, outbox, inbox, caps, blob content, delivery
testing/                           fake relay, fake BMA, fake Setup App, RC drivers, harnesses, compose entrypoints
tests/integration/                 reliability, blob, close and study (two-party + hub) scenarios
docs/decisions/                    ADRs
```

## Known gaps and hand-offs

- **Not run against the real relay or BMA.** `schemas/relay-wire.ts` was reviewed against `fusion-relay/src/protocol/` on 2026-09-18; the BMA endpoints in `schemas/bma.ts` are this repo's proposal and need the BMA team's review (notably `legId`-scoped directory rows, the relay-session response carrying the delegated credential on org-JWT calls, `POST /tunnel/credential`, and the strict status-report shape).
- **Compose stacks unverified locally** (no Docker daemon on the authoring machine); CI's `compose-smoke` job is the first run.
- **`/local/*` is unauthenticated** by design (network posture, v2 §4.1); whether a bootstrap token is wanted is a setup-app question (plan risk 8).
- **Setup App work outside this repo** (plan §10): N sidecars per hub task (the `aws.ts` image override), per-leg provisioning, explicit `StopTask`, `capsConsumed` re-seeding from the BMA's last report.
- A source's re-issued unanswered query is re-queued for a restarted RC (v2 §8 row 3); a live RC must dedup by `correlationId`, which the SDK does.
- Runtime image is `node:22-bookworm-slim`, not Alpine: the `sodium-native` prebuild links glibc (ADR 0001).
