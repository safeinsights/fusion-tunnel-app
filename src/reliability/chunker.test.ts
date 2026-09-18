import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { splitMessage, frameSizesFor, declaredSizeFor, maxChunkData, chunkCountFor } from './chunker'
import { TUNING_DEFAULTS } from '@/config'
import { TRANSPORT_FRAME_OVERHEAD } from '@/schemas/channel'
import { capacityOf, pad } from './padding'

const buckets = TUNING_DEFAULTS.padBuckets

describe('chunker', () => {
    it('sizes chunks so every sealed frame fits the largest bucket', () => {
        expect(maxChunkData(buckets)).toBe(32768 - TRANSPORT_FRAME_OVERHEAD - 4)
        const plaintext = randomBytes(100_000)
        const chunks = splitMessage(plaintext, buckets)
        expect(chunks).toHaveLength(Math.ceil(100_000 / maxChunkData(buckets)))
        expect(Buffer.concat(chunks).equals(plaintext)).toBe(true)
        for (const chunk of chunks)
            expect(pad(chunk, buckets).byteLength + TRANSPORT_FRAME_OVERHEAD).toBeLessThanOrEqual(32768)
    })

    it('an empty message is one chunk', () => {
        expect(chunkCountFor(0, buckets)).toBe(1)
        expect(splitMessage(Buffer.alloc(0), buckets)).toEqual([Buffer.alloc(0)])
        expect(frameSizesFor(0, buckets)).toEqual([1024])
    })

    it('declares the exact wire size: full buckets then a smaller tail', () => {
        const full = maxChunkData(buckets)
        expect(frameSizesFor(full, buckets)).toEqual([32768])
        expect(frameSizesFor(full + 1, buckets)).toEqual([32768, 1024])
        expect(frameSizesFor(full + capacityOf(1024) + 1, buckets)).toEqual([32768, 2048])
        expect(declaredSizeFor(full + 1, buckets)).toBe(32768 + 1024)
    })

    it('is deterministic for the same length (epoch-independent)', () => {
        expect(declaredSizeFor(77_777, buckets)).toBe(declaredSizeFor(77_777, buckets))
    })
})
