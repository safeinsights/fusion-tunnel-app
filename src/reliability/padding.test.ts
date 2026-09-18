import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { pad, unpad, bucketFor, capacityOf, PaddingError } from './padding'
import { TUNING_DEFAULTS } from '@/config'
import { TRANSPORT_FRAME_OVERHEAD } from '@/schemas/channel'

const buckets = TUNING_DEFAULTS.padBuckets

describe('padding', () => {
    it('pads to the smallest bucket that fits and unpads exactly', () => {
        for (const length of [0, 1, capacityOf(1024), capacityOf(1024) + 1, 5000, capacityOf(32768)]) {
            const data = randomBytes(length)
            const padded = pad(data, buckets)
            expect(padded.byteLength + TRANSPORT_FRAME_OVERHEAD).toBe(bucketFor(length, buckets))
            expect(buckets).toContain(padded.byteLength + TRANSPORT_FRAME_OVERHEAD)
            expect(unpad(padded).equals(data)).toBe(true)
        }
    })

    it('capacity leaves room for the counter, tag and length prefix', () => {
        expect(capacityOf(1024)).toBe(1024 - 24 - 4)
        expect(bucketFor(capacityOf(1024), buckets)).toBe(1024)
        expect(bucketFor(capacityOf(1024) + 1, buckets)).toBe(2048)
    })

    it('rejects data larger than the largest bucket and malformed padding', () => {
        expect(() => pad(randomBytes(capacityOf(32768) + 1), buckets)).toThrow(PaddingError)
        expect(() => unpad(Buffer.alloc(3))).toThrow(PaddingError)
        const lying = Buffer.alloc(8)
        lying.writeUInt32BE(100, 0)
        expect(() => unpad(lying)).toThrow(PaddingError)
    })

    it('round-trips random sizes (fuzz)', () => {
        for (let i = 0; i < 200; i++) {
            const data = randomBytes(Math.floor(Math.random() * capacityOf(32768)))
            expect(unpad(pad(data, buckets)).equals(data)).toBe(true)
        }
    })
})
