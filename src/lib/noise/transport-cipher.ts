import { createCipheriv, createDecipheriv } from 'node:crypto'
import { AEAD_TAG_BYTES, REPLAY_WINDOW } from '@/schemas/channel'

// ChaCha20-Poly1305 transport AEAD over the Noise-derived session keys, with the Noise nonce
// encoding (32 zero bits ‖ u64LE counter) and an explicit counter per frame. node:crypto rather
// than the handshake library's CipherState because its nonce is set explicitly per call and its
// counter width is the full 64 bits; the two agree byte-for-byte (verified against the official
// vectors in session.test.ts).

export const MAX_COUNTER = 2n ** 64n - 2n // 2^64-1 is reserved by the Noise spec

export class CounterExhaustedError extends Error {
    constructor() {
        super('transport counter exhausted; re-handshake required')
        this.name = 'CounterExhaustedError'
    }
}

export const nonceFor = (counter: bigint): Buffer => {
    if (counter < 0n || counter > MAX_COUNTER) throw new CounterExhaustedError()
    const nonce = Buffer.alloc(12)
    nonce.writeBigUInt64LE(counter, 4)
    return nonce
}

export class TransportCipher {
    private key: Buffer | null

    constructor(key: Buffer) {
        if (key.byteLength !== 32) throw new TypeError('transport key must be 32 bytes')
        this.key = Buffer.from(key)
    }

    get destroyed(): boolean {
        return this.key === null
    }

    seal(counter: bigint, aad: Buffer, plaintext: Buffer): Buffer {
        const key = this.requireKey()
        const cipher = createCipheriv('chacha20-poly1305', key, nonceFor(counter), { authTagLength: AEAD_TAG_BYTES })
        cipher.setAAD(aad, { plaintextLength: plaintext.byteLength })
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
        return Buffer.concat([body, cipher.getAuthTag()])
    }

    /** Returns null on authentication failure. */
    open(counter: bigint, aad: Buffer, ciphertext: Buffer): Buffer | null {
        const key = this.requireKey()
        if (ciphertext.byteLength < AEAD_TAG_BYTES) return null
        const body = ciphertext.subarray(0, ciphertext.byteLength - AEAD_TAG_BYTES)
        const tag = ciphertext.subarray(ciphertext.byteLength - AEAD_TAG_BYTES)
        try {
            const decipher = createDecipheriv('chacha20-poly1305', key, nonceFor(counter), {
                authTagLength: AEAD_TAG_BYTES,
            })
            decipher.setAAD(aad, { plaintextLength: body.byteLength })
            decipher.setAuthTag(tag)
            return Buffer.concat([decipher.update(body), decipher.final()])
        } catch {
            return null
        }
    }

    destroy(): void {
        this.key?.fill(0)
        this.key = null
    }

    private requireKey(): Buffer {
        if (!this.key) throw new Error('transport cipher destroyed')
        return this.key
    }
}

export type ReplayVerdict = 'fresh' | 'replay' | 'too_old'

/**
 * Sliding replay window (WireGuard/IPsec style). `check` never mutates; `mark` is called only
 * after a frame authenticated, so garbage counters cannot advance the window.
 */
export class ReplayWindow {
    private highest = -1n
    private readonly seen = new Set<bigint>()

    constructor(private readonly size: number = REPLAY_WINDOW) {}

    check(counter: bigint): ReplayVerdict {
        if (counter > this.highest) return 'fresh'
        if (this.highest - counter >= BigInt(this.size)) return 'too_old'
        return this.seen.has(counter) ? 'replay' : 'fresh'
    }

    mark(counter: bigint): void {
        this.seen.add(counter)
        if (counter > this.highest) {
            this.highest = counter
            const floor = this.highest - BigInt(this.size)
            for (const value of this.seen) if (value <= floor) this.seen.delete(value)
        }
    }

    get highestSeen(): bigint {
        return this.highest
    }
}
