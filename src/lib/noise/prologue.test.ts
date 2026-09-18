import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encodePrologue, prologueInputsFor } from './prologue'
import { PROLOGUE_DOMAIN } from '@/schemas/channel'
import { makeBundle } from '@/testing/fixtures'

const nonce = Buffer.alloc(32, 7)
const inputs = {
    studyId: 'study-1',
    relaySessionId: 'rs-1',
    sourceOrgSlug: 'dp-a',
    destinationOrgSlug: 'si-hub',
    sourceGeneration: 3,
    destinationGeneration: 1,
    sessionNonce: nonce,
}

describe('encodePrologue', () => {
    it('produces the frozen v1 layout', () => {
        const bytes = encodePrologue(inputs)
        const expected = Buffer.concat([
            Buffer.from(PROLOGUE_DOMAIN, 'ascii'),
            Buffer.from([0, 7]),
            Buffer.from('study-1'),
            Buffer.from([0, 4]),
            Buffer.from('rs-1'),
            Buffer.from([0, 4]),
            Buffer.from('dp-a'),
            Buffer.from([0, 6]),
            Buffer.from('si-hub'),
            Buffer.from([0, 0, 0, 3]),
            Buffer.from([0, 0, 0, 1]),
            nonce,
        ])
        expect(bytes.equals(expected)).toBe(true)
        expect(encodePrologue(inputs).equals(bytes)).toBe(true)
    })

    it('changes when any field changes and is not fooled by shifted boundaries', () => {
        const base = encodePrologue(inputs)
        expect(encodePrologue({ ...inputs, studyId: 'study-2' }).equals(base)).toBe(false)
        expect(encodePrologue({ ...inputs, sourceGeneration: 4 }).equals(base)).toBe(false)
        expect(encodePrologue({ ...inputs, sessionNonce: randomBytes(32) }).equals(base)).toBe(false)
        // "dp-a" + "si-hub" vs "dp-as" + "i-hub" must differ thanks to length prefixes
        expect(encodePrologue({ ...inputs, sourceOrgSlug: 'dp-as', destinationOrgSlug: 'i-hub' }).equals(base)).toBe(
            false,
        )
    })

    it('rejects invalid inputs', () => {
        expect(() => encodePrologue({ ...inputs, sessionNonce: randomBytes(16) })).toThrow()
        expect(() => encodePrologue({ ...inputs, sourceGeneration: 0 })).toThrow()
        expect(() => encodePrologue({ ...inputs, studyId: '' })).toThrow()
    })
})

describe('prologueInputsFor', () => {
    it('places the source fields first regardless of which role this tunnel plays', () => {
        const nonceB64 = nonce.toString('base64url')
        const asDestination = prologueInputsFor(
            makeBundle({
                role: 'destination',
                orgSlug: 'si-hub',
                peerOrgSlug: 'dp-a',
                keyGeneration: 1,
                sessionNonce: nonceB64,
            }),
            3,
        )
        const asSource = prologueInputsFor(
            makeBundle({
                role: 'source',
                orgSlug: 'dp-a',
                peerOrgSlug: 'si-hub',
                keyGeneration: 3,
                sessionNonce: nonceB64,
            }),
            1,
        )
        expect(asDestination).toEqual(asSource)
        expect(asDestination).toMatchObject({
            sourceOrgSlug: 'dp-a',
            destinationOrgSlug: 'si-hub',
            sourceGeneration: 3,
            destinationGeneration: 1,
        })
        expect(encodePrologue(asDestination).equals(encodePrologue(asSource))).toBe(true)
    })
})
