# ADR 0003 — What the outbox keeps for a blob-path message

**Status:** accepted 2026-09-18
**Spec:** Architecture Doc v2 §7.2, §7.3; plan Phase 7 ("decision point")

## Decision

For a message above the inline cap the outbox keeps the **sealed blob** (content-key ciphertext)
and the **pointer** plaintext until the message is acknowledged end to end — not the original
plaintext. The local window bound counts pointer frames plus blob bytes; the relay window counts
only the pointer frames (`sizeBytes` in the DATA header).

## Why

- Re-upload must be possible without the plaintext: a relay that lost or expired a blob answers
  the receiver's GET with 404, the receiver NACKs the pointer with `blob_missing`, and the sender
  PUTs the same ciphertext again and re-sends the pointer. Keeping the ciphertext means the
  content key never changes and the pointer stays valid.
- Epoch changes re-encrypt only the pointer. Blobs are purged with the _session_, not with an
  epoch, so a peer restart costs one small re-send, not a multi-megabyte re-upload.
- Memory stays bounded by the same window that bounds inline messages; a blob message costs its
  ciphertext size, which is what the RC handed over anyway.

## Rejected

- Keeping the plaintext: no advantage (the content key is already in the pointer) and a second
  copy of source data in tunnel memory.
- Keeping nothing beyond the pointer: a purged blob would strand the round until the destination
  SDK re-issues, and a re-issue would re-run the source operation and spend a second round of the
  Data Partner's budget.
