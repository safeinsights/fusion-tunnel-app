import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { BLOB_KEY_BYTES, BLOB_NONCE_BYTES } from '@/schemas/channel'
import { AEAD_TAG_BYTES } from '@/schemas/channel'

// Content encryption for the blob path (v2 §7.2): a fresh key per blob, ChaCha20-Poly1305 via
// node:crypto, the blobId as associated data so a blob cannot be swapped under another pointer.

export type SealedBlob = { contentKey: Buffer; ciphertext: Buffer; sha256: Buffer }

export class BlobContentError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BlobContentError'
    }
}

export const sealBlob = (plaintext: Buffer, blobId: string): SealedBlob => {
    const contentKey = randomBytes(BLOB_KEY_BYTES)
    const nonce = randomBytes(BLOB_NONCE_BYTES)
    const cipher = createCipheriv('chacha20-poly1305', contentKey, nonce, { authTagLength: AEAD_TAG_BYTES })
    cipher.setAAD(Buffer.from(blobId, 'utf8'), { plaintextLength: plaintext.byteLength })
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
        contentKey,
        ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]),
        sha256: createHash('sha256').update(plaintext).digest(),
    }
}

export const openBlob = (ciphertext: Buffer, contentKey: Buffer, blobId: string, expectedSha256?: Buffer): Buffer => {
    if (contentKey.byteLength !== BLOB_KEY_BYTES) throw new BlobContentError('content key must be 32 bytes')
    if (ciphertext.byteLength < BLOB_NONCE_BYTES + AEAD_TAG_BYTES) throw new BlobContentError('blob too short')
    const nonce = ciphertext.subarray(0, BLOB_NONCE_BYTES)
    const body = ciphertext.subarray(BLOB_NONCE_BYTES, ciphertext.byteLength - AEAD_TAG_BYTES)
    const tag = ciphertext.subarray(ciphertext.byteLength - AEAD_TAG_BYTES)
    let plaintext: Buffer
    try {
        const decipher = createDecipheriv('chacha20-poly1305', contentKey, nonce, { authTagLength: AEAD_TAG_BYTES })
        decipher.setAAD(Buffer.from(blobId, 'utf8'), { plaintextLength: body.byteLength })
        decipher.setAuthTag(tag)
        plaintext = Buffer.concat([decipher.update(body), decipher.final()])
    } catch {
        throw new BlobContentError('blob failed authentication')
    }
    if (expectedSha256 && !createHash('sha256').update(plaintext).digest().equals(expectedSha256)) {
        throw new BlobContentError('blob digest mismatch')
    }
    return plaintext
}
