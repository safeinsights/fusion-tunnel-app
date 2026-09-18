# ADR 0001 — Noise implementation: `noise-handshake` 4.x, pattern IK

**Status:** accepted 2026-09-18 (design decision 2026-09-16; Phase 3 spike confirmed 2026-09-18)
**Spec:** Architecture Doc v2 §6, §15.1; plan §0.1, Phase 3

## Decision

The end-to-end channel uses `Noise_IK_25519_ChaChaPoly_BLAKE2b`, implemented by
[`noise-handshake`](https://github.com/holepunchto/noise-handshake) 4.2.0 (Holepunch, Apache-2.0)
for the handshake, wrapped behind the tunnel's `NoiseSession` (`src/lib/noise/session.ts`).
The destination is the initiator and pre-shares the source's directory-verified static; the
source is the responder. `NoiseSession` takes `expectedRemoteStatic` as a required constructor
argument for **both** roles and withholds transport keys until the peer static compares equal
(constant-time) — the responder checks right after message 1 and before it answers, the
initiator after message 2. Handshake payloads are always empty.

Transport frames are ChaCha20-Poly1305 via `node:crypto` over the Noise-derived session keys,
with the Noise nonce encoding (32 zero bits ‖ u64LE counter) and the counter carried
**explicitly** in the frame. The receiver keeps a per-direction sliding replay window
(`REPLAY_WINDOW` = 1024) instead of an implicit counter.

## Why IK, not KK

The 2026-07-09 revision chose KK so both statics would be bound in-protocol. Verified against
the npm registry and GitHub on 2026-09-16: `noise-handshake` implements NN, XX, IK and XK only;
`@libp2p/noise` 17.x is XX-only and coupled to libp2p's connection-encrypter interface. **No
maintained JavaScript/TypeScript Noise library implements KK.** The 2026-07-09 review (F22) had
already accepted "IK plus a mandatory directory-equality check" as equivalent to KK. IK keeps the
source's identity bound in-protocol (a source whose static differs from the directory copy cannot
decrypt message 1), completes in two messages, and has the initiator finish last and speak first
— no data frame can overtake the final handshake message through a relay that forwards handshake
frames directly but mailboxes data.

## Spike results (2026-09-18)

- IK handshake with `new Noise('IK', true, dstStatic).initialise(prologue, srcStatic)` /
  `new Noise('IK', false, srcStatic).initialise(prologue)` completes; `responder.rs` equals the
  initiator's static after `recv(msg1)` and before `send(msg2)` — the equality check has the hook
  it needs. `initiator.tx === responder.rx` (k1) and vice versa, per the Noise `Split()` convention.
- The library is CommonJS on `sodium-universal` → `sodium-native` (a N-API addon). esbuild cannot
  inline the addon, so the CJS bundle marks `sodium-native` external and the runtime image carries
  production `node_modules`. An ESM bundle fails (`Dynamic require of "sodium-native"`), so the
  build stays `--format=cjs` like trusted-output-app.
- The `sodium-native` 5.1.0 Linux prebuilds link glibc ≥ 2.33; the runtime image is therefore
  `node:22-bookworm-slim`, not the siblings' Alpine.
- The official `Noise_IK_25519_ChaChaPoly_BLAKE2b` vector (cacophony) reproduces byte-for-byte
  through the library for both handshake messages and the handshake hash, and through the
  tunnel's `TransportCipher` for the four transport messages (`session.test.ts`).
- `@types/noise-handshake` 3.0.3 is stale; a local declaration lives in `src/lib/noise/`.

## Why an explicit transport counter

The relay redelivers byte-identical frames within an epoch (un-ACKed items after a reconnect,
v2 §7.3). Under Noise's implicit nonce a redelivered frame is undecryptable and would be
NACK-discarded — wrong, it is a legitimate duplicate the receiver must re-ACK by `messageId`.
With the counter in the frame the receiver classifies a frame as fresh, replay, or too old
_before_ touching the key, decrypts fresh frames, and lets the reliability layer re-ACK
replays by the relay header's `messageId`. Only authenticated frames advance the window.
Retransmissions from the sender's outbox are fresh frames (new counter, same AEAD-protected
`messageId`), exactly as v2 §7.3 requires.

## Rejected

- Forking `noise-handshake` to add KK — a fork of a cryptographic library for one equality check.
- `noise-c.wasm` — unmaintained since 2018.
- Rust `snow` via WebAssembly or a native addon — disproportionate build and audit surface.
- `@libp2p/noise` — XX only, libp2p-coupled.
- Using `noise-handshake/cipher` for transport — its `setNonce` writes only 32 bits of the counter.

## Consequences

- Residual risk: the destination's identity binding rests on the wrapper's equality check, not
  on the handshake. The check is structural (required argument, keys withheld) and tested,
  including the "wrong destination static presented to the source" case.
- The native addon is the one component of the runtime image that is not JavaScript; Trivy
  scans it with everything else.
- Escalation path if the library fails a future audit: WASM `snow` behind the same interface.
