import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
    encodeFrame,
    decodeFrame,
    WireError,
    FrameType,
    frameTypeName,
    popPayload,
    verifyPop,
    POP_DOMAIN,
    RelayTokenClaimsSchema,
    RELAY_TOKEN_AUDIENCE,
    type Frame,
} from './relay-wire'
import { createIdentity } from '@/lib/identity'

const uuid = '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b'

const samples: Frame[] = [
    { type: 'HELLO', header: { token: 'jwt', relaySessionId: 'rs', role: 'source' } },
    { type: 'CHALLENGE', header: { nonce: randomBytes(32).toString('base64url') } },
    { type: 'CHALLENGE_RESPONSE', header: { signature: randomBytes(64).toString('base64url') } },
    {
        type: 'ADMITTED',
        header: {
            relaySessionId: 'rs',
            legId: 'leg-a',
            role: 'source',
            heartbeatIntervalMs: 30000,
            limits: { windowMsgs: 64, windowBytes: 1, maxChunkBytes: 32768, inlineCapBytes: 262144 },
        },
    },
    {
        type: 'DATA',
        header: {
            messageId: uuid,
            chunkIndex: 0,
            chunkCount: 2,
            epochTag: 'deadbeefdeadbeef',
            sizeBytes: 10,
            respondsTo: uuid,
            seq: 4,
        },
        payload: Buffer.from('ciphertext'),
    },
    { type: 'ACK', header: { messageId: uuid } },
    { type: 'NACK_DISCARD', header: { messageId: uuid, reason: 'stale_epoch' } },
    { type: 'CLOSE', header: {}, payload: Buffer.from('authenticated close') },
    { type: 'CLOSE_ACK', header: {} },
    { type: 'PEER_REJOINED', header: { peerRole: 'destination', epoch: 2 } },
    {
        type: 'ERROR',
        header: { code: 'QUOTA_EXCEEDED', retryable: false, messageId: uuid, detail: 'study budget', scope: 'study' },
    },
    { type: 'HANDSHAKE', header: {}, payload: Buffer.alloc(96, 1) },
]

describe('relay frame codec', () => {
    it.each(samples.map((f) => [f.type, f] as const))('round-trips %s', (_type, frame) => {
        const encoded = encodeFrame(frame)
        expect(encoded.readUInt8(0)).toBe(1)
        expect(encoded.readUInt8(1)).toBe(FrameType[frame.type])
        const decoded = decodeFrame(encoded)
        expect(decoded.type).toBe(frame.type)
        expect(decoded.header).toEqual(frame.header)
        if ('payload' in frame) expect((decoded as { payload: Buffer }).payload.equals(frame.payload)).toBe(true)
        else expect('payload' in decoded).toBe(false)
    })

    it('an empty payload on a payload type decodes to an empty buffer', () => {
        const decoded = decodeFrame(encodeFrame({ type: 'HANDSHAKE', header: {}, payload: Buffer.alloc(0) }))
        expect((decoded as { payload: Buffer }).payload.byteLength).toBe(0)
    })

    it.each([
        ['too_short', Buffer.from([1, 1])],
        ['bad_version', Buffer.concat([Buffer.from([2, 1, 0, 0, 0, 2]), Buffer.from('{}')])],
        ['unknown_type', Buffer.concat([Buffer.from([1, 99, 0, 0, 0, 2]), Buffer.from('{}')])],
        ['header_length', Buffer.concat([Buffer.from([1, 9, 0, 0, 0, 50]), Buffer.from('{}')])],
        ['header_length', Buffer.concat([Buffer.from([1, 9, 0, 1, 0, 1]), Buffer.alloc(70000)])],
        ['header_json', Buffer.concat([Buffer.from([1, 9, 0, 0, 0, 2]), Buffer.from('{x')])],
        ['header_schema', Buffer.concat([Buffer.from([1, 6, 0, 0, 0, 2]), Buffer.from('{}')])],
        ['unexpected_payload', Buffer.concat([Buffer.from([1, 9, 0, 0, 0, 2]), Buffer.from('{}'), Buffer.from('x')])],
    ] as const)('rejects %s', (reason, bytes) => {
        try {
            decodeFrame(bytes)
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(WireError)
            expect((error as WireError).reason).toBe(reason)
        }
    })

    it('refuses to encode a payload on a payload-less type or an oversized header', () => {
        expect(() =>
            encodeFrame({ type: 'ACK', header: { messageId: uuid }, payload: Buffer.alloc(1) } as unknown as Frame),
        ).toThrow(WireError)
        expect(() => encodeFrame({ type: 'HELLO', header: { token: 'x'.repeat(70_000) } })).toThrow(WireError)
    })

    it('never crashes on random bytes — every failure is a WireError', () => {
        for (let i = 0; i < 300; i++) {
            const bytes = randomBytes(Math.floor(Math.random() * 64))
            try {
                decodeFrame(bytes)
            } catch (error) {
                expect(error).toBeInstanceOf(WireError)
            }
        }
    })

    it('maps codes to names', () => {
        expect(frameTypeName(5)).toBe('DATA')
        expect(frameTypeName(0)).toBeUndefined()
    })

    it('rejects unknown header fields and a chunkIndex past chunkCount (strict, as canonical)', () => {
        const withExtra = Buffer.concat([Buffer.from([1, 6, 0, 0, 0, 0]), Buffer.alloc(0)])
        const ack = JSON.stringify({ messageId: uuid, extra: 1 })
        const buf = Buffer.concat([Buffer.from([1, 6, 0, 0, 0, ack.length]), Buffer.from(ack)])
        expect(() => decodeFrame(buf)).toThrow(WireError)
        void withExtra
        expect(() =>
            encodeFrame({
                type: 'DATA',
                header: { messageId: uuid, chunkIndex: 2, chunkCount: 2, epochTag: 'e', sizeBytes: 1 },
                payload: Buffer.alloc(1),
            }),
        ).not.toThrow()
        expect(() =>
            decodeFrame(
                encodeFrame({
                    type: 'DATA',
                    header: { messageId: uuid, chunkIndex: 2, chunkCount: 2, epochTag: 'e', sizeBytes: 1 },
                    payload: Buffer.alloc(1),
                }),
            ),
        ).toThrow(WireError)
    })
})

describe('proof of possession', () => {
    it('signs and verifies the domain-separated payload', () => {
        const identity = createIdentity()
        const nonce = randomBytes(32)
        const payload = popPayload(nonce, 'rs-1', 'source')
        expect(payload.subarray(0, POP_DOMAIN.length).toString('ascii')).toBe(POP_DOMAIN)
        expect(payload.subarray(POP_DOMAIN.length, POP_DOMAIN.length + 32).equals(nonce)).toBe(true)
        expect(payload.subarray(POP_DOMAIN.length + 32).toString()).toBe('rs-1source')
        const signature = identity.signPop(payload)
        expect(verifyPop(identity.popKey, payload, signature)).toBe(true)
        expect(verifyPop(identity.popKey, popPayload(nonce, 'rs-1', 'destination'), signature)).toBe(false)
        expect(verifyPop(identity.popKey, popPayload(randomBytes(32), 'rs-1', 'source'), signature)).toBe(false)
        expect(verifyPop(createIdentity().popKey, payload, signature)).toBe(false)
        expect(verifyPop(randomBytes(31), payload, signature)).toBe(false)
        expect(verifyPop(identity.popKey, payload, randomBytes(64))).toBe(false)
        expect(verifyPop(identity.popKey, payload, randomBytes(63))).toBe(false)
    })
})

describe('relay token claims', () => {
    const claims = {
        aud: RELAY_TOKEN_AUDIENCE,
        iss: 'bma',
        exp: 1,
        iat: 0,
        relaySessionId: 'rs',
        role: 'source',
        fingerprint: 'fp',
        popKey: randomBytes(32).toString('base64url'),
        studyId: 's',
        jobId: 'j',
        legId: 'leg-a',
    }

    it('accepts the contract shape and rejects a wrong audience or a short popKey', () => {
        expect(RelayTokenClaimsSchema.safeParse(claims).success).toBe(true)
        expect(RelayTokenClaimsSchema.safeParse({ ...claims, aud: 'other' }).success).toBe(false)
        expect(
            RelayTokenClaimsSchema.safeParse({ ...claims, popKey: randomBytes(16).toString('base64url') }).success,
        ).toBe(false)
        expect(RelayTokenClaimsSchema.safeParse({ ...claims, legId: undefined }).success).toBe(false)
    })
})
