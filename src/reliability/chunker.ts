import { bucketFor, capacityOf } from '@/reliability/padding'

// Split one logical message into chunks whose sealed frames fit the largest bucket (≤ 32 KiB
// ciphertext, v2 §7.2). The declared `sizeBytes` a message reserves in the relay's window is the
// sum of its frame sizes — deterministic from the plaintext length and the bucket table, so it
// is the same under every epoch the message is (re)sent in.

export const maxChunkData = (buckets: readonly number[]): number => capacityOf(buckets[buckets.length - 1])

export const chunkCountFor = (plaintextLength: number, buckets: readonly number[]): number =>
    Math.max(1, Math.ceil(plaintextLength / maxChunkData(buckets)))

export const splitMessage = (plaintext: Buffer, buckets: readonly number[]): Buffer[] => {
    const size = maxChunkData(buckets)
    const count = chunkCountFor(plaintext.byteLength, buckets)
    const chunks: Buffer[] = []
    for (let i = 0; i < count; i++) chunks.push(Buffer.from(plaintext.subarray(i * size, (i + 1) * size)))
    return chunks
}

/** Wire frame size of every chunk of a message of `plaintextLength` bytes. */
export const frameSizesFor = (plaintextLength: number, buckets: readonly number[]): number[] => {
    const size = maxChunkData(buckets)
    const count = chunkCountFor(plaintextLength, buckets)
    const sizes: number[] = []
    for (let i = 0; i < count; i++) {
        const dataLength = Math.min(size, plaintextLength - i * size)
        sizes.push(bucketFor(Math.max(0, dataLength), buckets))
    }
    return sizes
}

export const declaredSizeFor = (plaintextLength: number, buckets: readonly number[]): number =>
    frameSizesFor(plaintextLength, buckets).reduce((sum, size) => sum + size, 0)
