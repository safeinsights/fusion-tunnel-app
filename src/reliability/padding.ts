import { PAD_LENGTH_BYTES, TRANSPORT_FRAME_OVERHEAD } from '@/schemas/channel'

// Bucketed padding (v2 §7.2, §9): every transport frame on the wire is one of the configured
// bucket sizes. Buckets are frame sizes; the plaintext a bucket can hold is the bucket minus the
// counter and tag, minus the u32 length prefix that tells the receiver where the data ends.

export class PaddingError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PaddingError'
    }
}

/** Plaintext data bytes a bucket (frame size) can carry. */
export const capacityOf = (bucket: number): number => bucket - TRANSPORT_FRAME_OVERHEAD - PAD_LENGTH_BYTES

/** Smallest bucket that holds `dataLength` bytes; throws if none does. */
export const bucketFor = (dataLength: number, buckets: readonly number[]): number => {
    for (const bucket of buckets) if (capacityOf(bucket) >= dataLength) return bucket
    throw new PaddingError(`no padding bucket holds ${dataLength} bytes`)
}

/** `u32BE len ‖ data ‖ zero fill`, sized so the sealed frame is exactly `bucket` bytes. */
export const pad = (data: Buffer, buckets: readonly number[]): Buffer => {
    const bucket = bucketFor(data.byteLength, buckets)
    const out = Buffer.alloc(bucket - TRANSPORT_FRAME_OVERHEAD)
    out.writeUInt32BE(data.byteLength, 0)
    data.copy(out, PAD_LENGTH_BYTES)
    return out
}

export const unpad = (padded: Buffer): Buffer => {
    if (padded.byteLength < PAD_LENGTH_BYTES) throw new PaddingError('padded chunk shorter than its length prefix')
    const length = padded.readUInt32BE(0)
    if (PAD_LENGTH_BYTES + length > padded.byteLength) throw new PaddingError('declared length exceeds chunk')
    return Buffer.from(padded.subarray(PAD_LENGTH_BYTES, PAD_LENGTH_BYTES + length))
}
