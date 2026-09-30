import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { verifyPeerKey } from './verify-peer-key'
import { createIdentity } from '@/lib/identity'
import { signKeyBlob, type PeerKeyResponse } from '@/schemas/bma'
import { makeBundle, makeOrgKey, testOrgKey } from '@/testing/fixtures'

const org = testOrgKey()
const bundle = makeBundle({ role: 'destination', orgSlug: 'si-hub', peerOrgSlug: 'dp-a', peerOrgPublicKey: org.pem })

const blobFor = (overrides: Partial<PeerKeyResponse> = {}, signWith = org.privateKey): PeerKeyResponse => {
    const peer = createIdentity()
    const base = {
        studyId: bundle.studyId,
        jobId: 'job-peer',
        legId: bundle.legId,
        orgSlug: 'dp-a',
        generation: 1,
        ...peer.toIdentityResponse(),
    }
    const merged = { ...base, ...overrides }
    const keySignature = signKeyBlob(signWith, {
        studyId: base.studyId,
        jobId: base.jobId,
        legId: base.legId,
        connectionId: base.connectionId,
        publicKey: peer.publicKey,
        popKey: peer.popKey,
    }).toString('base64url')
    return { ...merged, keySignature: overrides.keySignature ?? keySignature }
}

describe('verifyPeerKey', () => {
    it('accepts a blob signed by the pinned org key for this study and leg', () => {
        const blob = blobFor()
        const verdict = verifyPeerKey(blob, { bundle })
        expect(verdict.ok).toBe(true)
        if (verdict.ok) {
            expect(verdict.peer.connectionId).toBe(blob.connectionId)
            expect(verdict.peer.generation).toBe(1)
            expect(verdict.peer.publicKey.toString('base64url')).toBe(blob.publicKey)
        }
    })

    it.each([
        ['wrong_study', { studyId: 'other-study' }],
        ['wrong_leg', { legId: 'leg-b' }],
        ['wrong_org', { orgSlug: 'dp-b' }],
        ['fingerprint_mismatch', { fingerprint: randomBytes(32).toString('base64url') }],
        ['bad_signature', { keySignature: randomBytes(256).toString('base64url') }],
    ] as const)('rejects %s', (reason, overrides) => {
        const verdict = verifyPeerKey(blobFor(overrides), { bundle })
        expect(verdict).toEqual({ ok: false, reason })
    })

    it('rejects a blob signed by a different org key (the directory cannot substitute the verifier)', () => {
        const verdict = verifyPeerKey(blobFor({}, makeOrgKey().privateKey), { bundle })
        expect(verdict).toEqual({ ok: false, reason: 'bad_signature' })
    })

    it('rejects a blob whose signed fields were tampered after signing', () => {
        const blob = blobFor()
        const tampered = { ...blob, jobId: 'job-other' } // signature covered jobId
        expect(verifyPeerKey(tampered, { bundle })).toEqual({ ok: false, reason: 'bad_signature' })
        const replayedIntoOtherLeg = { ...blob, legId: 'leg-b' }
        const otherLegBundle = makeBundle({ ...bundle, legId: 'leg-b' })
        expect(verifyPeerKey(replayedIntoOtherLeg, { bundle: otherLegBundle })).toEqual({
            ok: false,
            reason: 'bad_signature',
        })
    })

    it('enforces generation monotonicity, strictly after a peer rejoin', () => {
        expect(verifyPeerKey(blobFor({ generation: 3 }), { bundle, lastSeenGeneration: 3 }).ok).toBe(true)
        expect(verifyPeerKey(blobFor({ generation: 2 }), { bundle, lastSeenGeneration: 3 })).toEqual({
            ok: false,
            reason: 'stale_generation',
        })
        expect(
            verifyPeerKey(blobFor({ generation: 3 }), { bundle, lastSeenGeneration: 3, requireNewer: true }),
        ).toEqual({ ok: false, reason: 'stale_generation' })
        expect(
            verifyPeerKey(blobFor({ generation: 4 }), { bundle, lastSeenGeneration: 3, requireNewer: true }).ok,
        ).toBe(true)
        // bootstrapped from the first fetch: any generation is acceptable when none was seen
        expect(verifyPeerKey(blobFor({ generation: 7 }), { bundle }).ok).toBe(true)
    })
})
