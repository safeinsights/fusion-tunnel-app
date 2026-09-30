import { describe, it, expect } from 'vitest'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createIdentity, fingerprintOf, rawEd25519PublicKey } from './identity'
import { IdentityResponseSchema } from '@/schemas/provisioning'

describe('identity', () => {
    const identity = createIdentity()

    it('mints 32-byte X25519 and Ed25519 public keys and a UUID connectionId', () => {
        expect(identity.publicKey).toHaveLength(32)
        expect(identity.popKey).toHaveLength(32)
        expect(identity.connectionId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('derives the fingerprint as SHA-256 over publicKey ‖ popKey', () => {
        const expected = createHash('sha256').update(identity.publicKey).update(identity.popKey).digest('base64url')
        expect(identity.fingerprint).toBe(expected)
        expect(fingerprintOf(identity.publicKey, identity.popKey)).toBe(expected)
    })

    it('produces Ed25519 signatures that verify against popKey', () => {
        const payload = Buffer.from('SI-FUSION-RELAY-POP-v1nonce')
        const signature = identity.signPop(payload)
        expect(signature).toHaveLength(64)
        const publicKey = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: identity.popKey.toString('base64url') },
            format: 'jwk',
        })
        expect(verify(null, payload, publicKey, signature)).toBe(true)
        expect(verify(null, Buffer.from('other'), publicKey, signature)).toBe(false)
        expect(rawEd25519PublicKey(publicKey)).toEqual(identity.popKey)
    })

    it('exposes a Noise static keypair whose public half matches publicKey', () => {
        expect(Buffer.from(identity.noiseStatic.publicKey)).toEqual(identity.publicKey)
        expect(identity.noiseStatic.secretKey).toHaveLength(32)
    })

    it('never serializes the static keypair', () => {
        expect(JSON.stringify(identity)).not.toContain('secretKey')
        expect(Object.keys(identity)).not.toContain('noiseStatic')
    })

    it('is fresh on every launch', () => {
        const other = createIdentity()
        expect(other.connectionId).not.toBe(identity.connectionId)
        expect(other.publicKey.equals(identity.publicKey)).toBe(false)
        expect(other.popKey.equals(identity.popKey)).toBe(false)
    })

    it('renders a valid /local/identity response', () => {
        const response = identity.toIdentityResponse()
        expect(IdentityResponseSchema.safeParse(response).success).toBe(true)
        expect(Buffer.from(response.publicKey, 'base64url')).toEqual(identity.publicKey)
        expect(Buffer.from(response.popKey, 'base64url')).toEqual(identity.popKey)
    })
})
