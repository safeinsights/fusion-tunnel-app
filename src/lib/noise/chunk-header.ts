import { parse as parseUuid, validate as isUuid } from 'uuid'
import { CHUNK_AAD_DOMAIN, CHUNK_HEADER_BYTES } from '@/schemas/channel'

export type ChunkHeader = {
    messageId: string
    chunkIndex: number
    chunkCount: number
    senderConnectionId: string
}

const uuidBytes = (value: string, field: string): Buffer => {
    if (!isUuid(value)) throw new TypeError(`${field} is not a UUID`)
    return Buffer.from(parseUuid(value))
}

const u32 = (value: number, field: string): Buffer => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new RangeError(`${field} must be a u32`)
    }
    const out = Buffer.alloc(4)
    out.writeUInt32BE(value, 0)
    return out
}

/** Canonical AEAD associated data for one chunk (schemas/channel.ts). */
export const encodeChunkHeader = (header: ChunkHeader): Buffer => {
    if (header.chunkCount < 1) throw new RangeError('chunkCount must be >= 1')
    if (header.chunkIndex >= header.chunkCount) throw new RangeError('chunkIndex must be < chunkCount')
    const out = Buffer.concat([
        Buffer.from(CHUNK_AAD_DOMAIN, 'ascii'),
        uuidBytes(header.messageId, 'messageId'),
        u32(header.chunkIndex, 'chunkIndex'),
        u32(header.chunkCount, 'chunkCount'),
        uuidBytes(header.senderConnectionId, 'senderConnectionId'),
    ])
    if (out.byteLength !== CHUNK_HEADER_BYTES) throw new Error('chunk header length invariant violated')
    return out
}
