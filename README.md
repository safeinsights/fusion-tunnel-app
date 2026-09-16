# fusion-tunnel-app

The SafeInsights **Fusion Tunnel App**: a per-study-job enclave container for the Enclave Fusion Framework. It owns all inter-enclave communication and end-to-end encryption (Noise_IK) — researcher code talks only to its enclave-local API via the fusion SDK, and the tunnel talks only to the Fusion Relay and the Management App. Launched, provisioned, and torn down by the Setup App; holds no long-lived secrets.

**Status: design only — no implementation yet.**

- Authoritative spec: `SafeInsights Enclave Fusion Architecture Doc-v2.md` (§4.1, §5–§8, §13) in the parent workspace
- Sequence diagram: `fusion-rc-querys.md`
- Implementation plan: [`.claude/plans/2026-07-09-implementation-plan.md`](.claude/plans/2026-07-09-implementation-plan.md) — the relay wire contract is mirrored from `fusion-relay/src/protocol/` (canonical)
