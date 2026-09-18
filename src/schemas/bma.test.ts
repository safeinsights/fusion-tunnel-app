import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
    keyBlobSignaturePayload,
    signKeyBlob,
    verifyKeyBlobSignature,
    TUNNEL_KEY_DOMAIN,
    StatusReportSchema,
} from './bma'
import { makeOrgKey, testOrgKey } from '@/testing/fixtures'

const input = {
    studyId: 'study-1',
    jobId: 'job-1',
    legId: 'leg-a',
    connectionId: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b',
    publicKey: Buffer.alloc(32, 1),
    popKey: Buffer.alloc(32, 2),
}

describe('key blob signature', () => {
    it('encodes the domain-separated, length-prefixed payload', () => {
        const payload = keyBlobSignaturePayload(input)
        expect(payload.subarray(0, TUNNEL_KEY_DOMAIN.length).toString('ascii')).toBe(TUNNEL_KEY_DOMAIN)
        expect(payload.byteLength).toBe(TUNNEL_KEY_DOMAIN.length + (2 + 7) + (2 + 5) + (2 + 5) + (2 + 36) + 32 + 32)
        expect(keyBlobSignaturePayload({ ...input, legId: 'leg-b' }).equals(payload)).toBe(false)
        // no field can bleed into its neighbour
        expect(keyBlobSignaturePayload({ ...input, studyId: 'study-1j', jobId: 'ob-1' }).equals(payload)).toBe(false)
    })

    it('signs with the org key and verifies against the pinned PEM only', () => {
        const org = testOrgKey()
        const signature = signKeyBlob(org.privateKey, input)
        expect(verifyKeyBlobSignature(org.pem, input, signature)).toBe(true)
        expect(verifyKeyBlobSignature(makeOrgKey().pem, input, signature)).toBe(false)
        expect(verifyKeyBlobSignature(org.pem, { ...input, legId: 'leg-b' }, signature)).toBe(false)
        expect(verifyKeyBlobSignature(org.pem, { ...input, popKey: randomBytes(32) }, signature)).toBe(false)
        expect(verifyKeyBlobSignature('not a pem', input, signature)).toBe(false)
        const flipped = Buffer.from(signature)
        flipped[0] ^= 1
        expect(verifyKeyBlobSignature(org.pem, input, flipped)).toBe(false)
    })
})

describe('StatusReportSchema', () => {
    it('is strict: an unknown field (a payload smuggling attempt) is rejected', () => {
        const report = {
            studyId: 's',
            jobId: 'j',
            legId: 'leg-a',
            orgSlug: 'dp-a',
            role: 'source',
            connectionId: input.connectionId,
            state: 'CHANNEL_UP',
            relayAdmitted: true,
            ownGeneration: 1,
            framesSent: 0,
            messagesSent: 0,
            messagesAcked: 0,
            messagesReceived: 0,
            roundsCompleted: 0,
            outboxDepth: 0,
            pendingAcks: 0,
            peerKeyRejected: false,
            reason: 'interval',
            reportedAt: new Date().toISOString(),
        }
        expect(StatusReportSchema.safeParse(report).success).toBe(true)
        expect(StatusReportSchema.safeParse({ ...report, payload: { rows: [1, 2] } }).success).toBe(false)
        expect(
            StatusReportSchema.safeParse({
                ...report,
                caps: {
                    consumed: { rounds: 1, responsePlaintextBytes: 0, queryPlaintextBytes: 0 },
                    budget: { roundsUsed: 1, responseBytesUsed: 0, queryBytesUsed: 0 },
                    extra: 1,
                },
            }).success,
        ).toBe(false)
    })
})
