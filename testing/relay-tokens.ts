import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { RELAY_TOKEN_AUDIENCE, type RelayRole, type RelayTokenClaims } from '@/schemas/relay-wire'

// The harness stands in for the BMA's relay-token issuance: an RSA keypair per test process,
// RS256 tokens minted exactly to schemas/relay-wire.ts RelayTokenClaims, verified by the fake
// relay through the same public key a production relay would read from BMA_RELAY_PUBLIC_KEY_PEM.

export type BmaKeypair = { publicKey: KeyObject; privateKey: KeyObject; publicPem: string }

let shared: BmaKeypair | undefined
export const testBmaKey = (): BmaKeypair => (shared ??= makeBmaKey())

export const makeBmaKey = (): BmaKeypair => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    return { ...pair, publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) as string }
}

export type MintOptions = {
    relaySessionId: string
    role: RelayRole
    fingerprint: string
    popKey: Buffer
    studyId?: string
    jobId?: string
    legId?: string
    expiresInS?: number
    issuer?: string
    key?: BmaKeypair
    /** Override any claim (tests of the relay's verification). */
    overrides?: Partial<Record<keyof RelayTokenClaims, unknown>>
    algorithm?: jwt.Algorithm
}

export const mintRelayToken = (options: MintOptions): string => {
    const key = options.key ?? testBmaKey()
    const now = Math.floor(Date.now() / 1000)
    const claims: Record<string, unknown> = {
        aud: RELAY_TOKEN_AUDIENCE,
        iss: options.issuer ?? 'fake-bma',
        iat: now,
        exp: now + (options.expiresInS ?? 900),
        relaySessionId: options.relaySessionId,
        role: options.role,
        fingerprint: options.fingerprint,
        popKey: options.popKey.toString('base64url'),
        studyId: options.studyId ?? 'study-1',
        jobId: options.jobId ?? 'job-1',
        legId: options.legId ?? 'leg-a',
        ...options.overrides,
    }
    return jwt.sign(claims, key.privateKey, { algorithm: options.algorithm ?? 'RS256' })
}
