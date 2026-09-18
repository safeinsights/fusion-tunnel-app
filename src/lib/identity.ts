import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { generateKeyPair as generateX25519 } from 'noise-handshake/dh'
import type Noise from 'noise-handshake'
import type { IdentityResponse } from '@/schemas/provisioning'

export const KEY_BYTES = 32

/** `fingerprint = base64url(SHA-256(x25519PublicKey ‖ ed25519PopKey))` — the identity the relay token binds. */
export const fingerprintOf = (publicKey: Buffer, popKey: Buffer): string =>
    createHash('sha256').update(publicKey).update(popKey).digest('base64url')

export const rawEd25519PublicKey = (key: KeyObject): Buffer => {
    const jwk = key.export({ format: 'jwk' })
    return Buffer.from(jwk.x as string, 'base64url')
}

/**
 * Per-launch tunnel session identity (v2 §5): an X25519 static for Noise_IK, an Ed25519
 * keypair for the relay's proof-of-possession challenge, and a fresh connectionId. Private
 * halves live only in this object's closure; nothing here is ever persisted.
 */
export type Identity = {
    readonly connectionId: string
    /** X25519 static public key, 32 bytes. */
    readonly publicKey: Buffer
    /** Ed25519 proof-of-possession public key, 32 bytes. */
    readonly popKey: Buffer
    readonly fingerprint: string
    /** Ed25519 signature (64 bytes) over an already domain-separated payload. */
    signPop(payload: Buffer): Buffer
    /** The static keypair for the Noise adapter only — non-enumerable so it never serializes. */
    readonly noiseStatic: Noise.Keypair
    toIdentityResponse(): IdentityResponse
}

export const createIdentity = (): Identity => {
    const x25519 = generateX25519()
    const ed25519 = generateKeyPairSync('ed25519')
    const publicKey = Buffer.from(x25519.publicKey)
    const popKey = rawEd25519PublicKey(ed25519.publicKey)
    const connectionId = uuidv4()
    const fingerprint = fingerprintOf(publicKey, popKey)

    const identity = {
        connectionId,
        publicKey,
        popKey,
        fingerprint,
        signPop: (payload: Buffer): Buffer => edSign(null, payload, ed25519.privateKey),
        toIdentityResponse: (): IdentityResponse => ({
            connectionId,
            publicKey: publicKey.toString('base64url'),
            popKey: popKey.toString('base64url'),
            fingerprint,
        }),
    } as Identity

    Object.defineProperty(identity, 'noiseStatic', { value: x25519, enumerable: false, writable: false })
    return Object.freeze(identity)
}
