# ADR 0002 — One tunnel instance per leg

**Status:** accepted 2026-09-17 (hub topology decision, product owner 2026-09-16)
**Spec:** plan §10; hub topology review memo 2026-09-16 §2.4

## Decision

A tunnel instance serves exactly one source→destination **leg**. In the two-party topology a
job has one leg and one tunnel. In the hub topology a SafeInsights-hosted destination job runs
one tunnel per Data Partner source as sidecars in one task — tunnel-A (peer = Data Partner A)
and tunnel-B (peer = Data Partner B) — each with its own in-memory keypairs, `connectionId`,
`relaySessionId`, session nonce, delegated credential, pinned peer-org key and local bearer
token. Each instance runs the two-party protocol verbatim; the research container addresses
them through the peer-addressed SDK (`GET /v1/info` → `legId`, `peerOrgSlug`).

## Why instances, not one multiplexing process

- Every §4.1 invariant (one session, one outbox, one epoch, one identity) stays per process.
- The customers' hard requirement — B's traffic never reaches A — becomes process isolation
  rather than an in-process routing table. A bug that hands B's response to A's `correlationId`
  cannot exist in code that has no notion of a second peer.
- The "nothing else in the box" argument the relay makes for itself applies to the tunnel too.
- The tunnel is not topology-aware beyond carrying `legId` in its bundle, key-blob signature
  payload, directory queries, `/v1/info` and status reports.

## Cost

One more sidecar and one more local bearer token per hub job; the Setup App must launch N
sidecars and provision each with the correct pinned peer key (owned by setup-app).
