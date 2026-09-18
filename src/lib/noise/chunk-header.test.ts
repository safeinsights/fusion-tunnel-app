import { describe, it, expect } from 'vitest'
import { parse as parseUuid } from 'uuid'
import { encodeChunkHeader } from './chunk-header'
import { CHUNK_AAD_DOMAIN, CHUNK_HEADER_BYTES } from '@/schemas/channel'

const messageId = '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b'
const senderConnectionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

describe('encodeChunkHeader', () => {
    it('produces the frozen v1 layout', () => {
        const bytes = encodeChunkHeader({ messageId, chunkIndex: 2, chunkCount: 5, senderConnectionId })
        expect(bytes.byteLength).toBe(CHUNK_HEADER_BYTES)
        const expected = Buffer.concat([
            Buffer.from(CHUNK_AAD_DOMAIN, 'ascii'),
            Buffer.from(parseUuid(messageId)),
            Buffer.from([0, 0, 0, 2]),
            Buffer.from([0, 0, 0, 5]),
            Buffer.from(parseUuid(senderConnectionId)),
        ])
        expect(bytes.equals(expected)).toBe(true)
    })

    it('differs when any field differs', () => {
        const base = encodeChunkHeader({ messageId, chunkIndex: 0, chunkCount: 1, senderConnectionId })
        expect(
            encodeChunkHeader({
                messageId: senderConnectionId,
                chunkIndex: 0,
                chunkCount: 1,
                senderConnectionId,
            }).equals(base),
        ).toBe(false)
        expect(encodeChunkHeader({ messageId, chunkIndex: 0, chunkCount: 2, senderConnectionId }).equals(base)).toBe(
            false,
        )
        expect(
            encodeChunkHeader({ messageId, chunkIndex: 0, chunkCount: 1, senderConnectionId: messageId }).equals(base),
        ).toBe(false)
    })

    it('rejects invalid ids and ranges', () => {
        expect(() =>
            encodeChunkHeader({ messageId: 'nope', chunkIndex: 0, chunkCount: 1, senderConnectionId }),
        ).toThrow(TypeError)
        expect(() => encodeChunkHeader({ messageId, chunkIndex: 0, chunkCount: 1, senderConnectionId: 'x' })).toThrow(
            TypeError,
        )
        expect(() => encodeChunkHeader({ messageId, chunkIndex: 1, chunkCount: 1, senderConnectionId })).toThrow(
            RangeError,
        )
        expect(() => encodeChunkHeader({ messageId, chunkIndex: 0, chunkCount: 0, senderConnectionId })).toThrow(
            RangeError,
        )
        expect(() => encodeChunkHeader({ messageId, chunkIndex: -1, chunkCount: 1, senderConnectionId })).toThrow(
            RangeError,
        )
        expect(() => encodeChunkHeader({ messageId, chunkIndex: 0, chunkCount: 2 ** 32, senderConnectionId })).toThrow(
            RangeError,
        )
    })
})
