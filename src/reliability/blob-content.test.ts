import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sealBlob, openBlob, BlobContentError } from './blob-content'

describe('blob content encryption', () => {
    it('seals under a fresh key with the blobId as associated data and opens with digest verification', () => {
        const plaintext = randomBytes(5000)
        const a = sealBlob(plaintext, 'blob-a')
        const b = sealBlob(plaintext, 'blob-a')
        expect(a.contentKey.equals(b.contentKey)).toBe(false)
        expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
        expect(a.ciphertext.byteLength).toBe(12 + plaintext.byteLength + 16)
        expect(openBlob(a.ciphertext, a.contentKey, 'blob-a', a.sha256).equals(plaintext)).toBe(true)
        expect(openBlob(a.ciphertext, a.contentKey, 'blob-a').equals(plaintext)).toBe(true)
    })

    it('refuses the wrong blobId, key, tampered bytes, wrong digest, and short input', () => {
        const plaintext = Buffer.from('payload')
        const sealed = sealBlob(plaintext, 'blob-a')
        expect(() => openBlob(sealed.ciphertext, sealed.contentKey, 'blob-b')).toThrow(BlobContentError)
        expect(() => openBlob(sealed.ciphertext, randomBytes(32), 'blob-a')).toThrow(BlobContentError)
        expect(() => openBlob(sealed.ciphertext, randomBytes(16), 'blob-a')).toThrow(/32 bytes/)
        const tampered = Buffer.from(sealed.ciphertext)
        tampered[20] ^= 1
        expect(() => openBlob(tampered, sealed.contentKey, 'blob-a')).toThrow(BlobContentError)
        expect(() => openBlob(sealed.ciphertext, sealed.contentKey, 'blob-a', randomBytes(32))).toThrow(/digest/)
        expect(() => openBlob(Buffer.alloc(10), sealed.contentKey, 'blob-a')).toThrow(/too short/)
    })
})
