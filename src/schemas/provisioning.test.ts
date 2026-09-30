import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { ConfigurationBundleSchema, IdentityResponseSchema } from './provisioning'
import { makeBundle } from '@/testing/fixtures'

const parse = (value: unknown) => ConfigurationBundleSchema.safeParse(value)

describe('ConfigurationBundleSchema', () => {
    it('accepts the fixture bundle and defaults caps', () => {
        const { caps: _caps, ...withoutCaps } = makeBundle()
        const result = parse(withoutCaps)
        expect(result.success).toBe(true)
        if (result.success) expect(result.data.caps).toEqual({})
    })

    it('accepts hub extras: caps, capsConsumed, guards, operations', () => {
        const result = parse(
            makeBundle({
                caps: { maxRounds: 10, maxQueryPlaintextBytesPerRound: 1024 },
                capsConsumed: { rounds: 2, responsePlaintextBytes: 10, queryPlaintextBytes: 20 },
                guards: { maxDistinctPersonIds: 5000, minGroupSize: 10 },
                operations: [{ name: 'counts_by_group', cardinality: 'per-group' }],
            }),
        )
        expect(result.success).toBe(true)
    })

    it.each([
        ['missing studyId', { studyId: undefined }],
        ['bad role', { role: 'observer' }],
        ['short token', { localApiToken: 'short' }],
        ['bad nonce length', { sessionNonce: randomBytes(16).toString('base64url') }],
        ['non-base64url nonce', { sessionNonce: 'not*base64url!' }],
        ['bad relay endpoint scheme', { relay: { endpoint: 'ftp://relay', sessionId: 's', token: 't' } }],
        ['bad bma endpoint scheme', { bma: { endpoint: 'wss://bma', credential: 'c' } }],
        ['non-PEM org key', { peerOrgPublicKey: 'MIIB...' }],
        ['zero generation', { keyGeneration: 0 }],
        ['negative cap', { caps: { maxRounds: -1 } }],
        ['bad slug', { peerOrgSlug: '-leading-dash' }],
        ['bad cardinality', { operations: [{ name: 'x', cardinality: 'many' }] }],
    ] as const)('rejects %s', (_label, overrides) => {
        const result = parse({ ...makeBundle(), ...overrides })
        expect(result.success).toBe(false)
    })

    it('reports issue paths', () => {
        const result = parse({ ...makeBundle(), relay: { endpoint: 'nope', sessionId: '', token: 't' } })
        expect(result.success).toBe(false)
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'))
            expect(paths).toContain('relay.endpoint')
            expect(paths).toContain('relay.sessionId')
        }
    })
})

describe('IdentityResponseSchema', () => {
    it('requires 32-byte keys', () => {
        const good = {
            connectionId: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b',
            publicKey: randomBytes(32).toString('base64url'),
            popKey: randomBytes(32).toString('base64url'),
            fingerprint: randomBytes(32).toString('base64url'),
        }
        expect(IdentityResponseSchema.safeParse(good).success).toBe(true)
        expect(
            IdentityResponseSchema.safeParse({ ...good, publicKey: randomBytes(31).toString('base64url') }).success,
        ).toBe(false)
        expect(IdentityResponseSchema.safeParse({ ...good, connectionId: 'nope' }).success).toBe(false)
    })
})
