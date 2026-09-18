import { timingSafeEqual } from 'node:crypto'
import Noise from 'noise-handshake'
import { EPOCH_TAG_BYTES, TRANSPORT_COUNTER_BYTES } from '@/schemas/channel'
import { ReplayWindow, TransportCipher, MAX_COUNTER, CounterExhaustedError } from '@/lib/noise/transport-cipher'

// NoiseSession: the tunnel's wrapper around noise-handshake's IK state (ADR 0001).
//
// Role mapping (v2 §6): the DESTINATION is the Noise initiator and pre-shares the source's
// directory-verified static; the SOURCE is the responder. Both roles take `expectedRemoteStatic`
// as a required argument and compare the peer static constant-time before any transport key is
// exposed — the responder right after message 1 and before it answers, the initiator after
// message 2 (redundant with IK's in-protocol binding; kept so both roles share one code path).
// Handshake payloads are always empty.

export type NoiseRole = 'initiator' | 'responder'

type State = 'idle' | 'awaiting_msg1' | 'awaiting_msg2' | 'ready_for_msg2' | 'established' | 'failed'

export class HandshakeStateError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'HandshakeStateError'
    }
}

export class HandshakeFailedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'HandshakeFailedError'
    }
}

export class PeerIdentityMismatchError extends HandshakeFailedError {
    constructor() {
        super('peer static key does not match the directory-verified key')
        this.name = 'PeerIdentityMismatchError'
    }
}

export class HandshakePayloadError extends HandshakeFailedError {
    constructor() {
        super('handshake message carried a payload; payloads must be empty')
        this.name = 'HandshakePayloadError'
    }
}

export class ReplayError extends Error {
    constructor(readonly verdict: 'replay' | 'too_old') {
        super(`transport frame rejected: ${verdict}`)
        this.name = 'ReplayError'
    }
}

export class DecryptError extends Error {
    constructor() {
        super('transport frame failed authentication')
        this.name = 'DecryptError'
    }
}

export type NoiseSessionOptions = {
    role: NoiseRole
    staticKeypair: Noise.Keypair
    /** The peer's pin-verified, directory-published static. Required for both roles. */
    expectedRemoteStatic: Buffer
    prologue: Buffer
}

const EMPTY = Buffer.alloc(0)

export class NoiseSession {
    readonly role: NoiseRole
    private readonly expectedRemoteStatic: Buffer
    private noise: Noise | null
    private state: State
    private sendCipher: TransportCipher | null = null
    private recvCipher: TransportCipher | null = null
    private sendCounter = 0n
    private readonly window = new ReplayWindow()
    private hash: Buffer | null = null

    constructor(options: NoiseSessionOptions) {
        if (!Buffer.isBuffer(options.expectedRemoteStatic) || options.expectedRemoteStatic.byteLength !== 32) {
            throw new TypeError('expectedRemoteStatic is required and must be 32 bytes')
        }
        this.role = options.role
        this.expectedRemoteStatic = Buffer.from(options.expectedRemoteStatic)
        const initiator = options.role === 'initiator'
        this.noise = new Noise('IK', initiator, options.staticKeypair)
        this.noise.initialise(options.prologue, initiator ? this.expectedRemoteStatic : undefined)
        this.state = initiator ? 'idle' : 'awaiting_msg1'
    }

    get complete(): boolean {
        return this.state === 'established'
    }

    get failed(): boolean {
        return this.state === 'failed'
    }

    /** Hex of the first 8 handshake-hash bytes; identifies this epoch's keys on relay headers. */
    get epochTag(): string | undefined {
        return this.hash?.subarray(0, EPOCH_TAG_BYTES).toString('hex')
    }

    get handshakeHash(): Buffer | undefined {
        return this.hash ? Buffer.from(this.hash) : undefined
    }

    /** Initiator: message 1. Responder: message 2, only after message 1 passed the identity check. */
    writeHandshake(): Buffer {
        const noise = this.requireNoise()
        if (this.role === 'initiator') {
            if (this.state !== 'idle') throw new HandshakeStateError(`initiator cannot send in state ${this.state}`)
            const message = this.guarded(() => noise.send(EMPTY))
            this.state = 'awaiting_msg2'
            return message
        }
        if (this.state !== 'ready_for_msg2') {
            throw new HandshakeStateError(`responder cannot send in state ${this.state}`)
        }
        const message = this.guarded(() => noise.send(EMPTY))
        this.establish()
        return message
    }

    /** Responder: message 1 (then the mandatory identity check). Initiator: message 2. */
    readHandshake(message: Buffer): void {
        const noise = this.requireNoise()
        if (this.role === 'responder') {
            if (this.state !== 'awaiting_msg1') {
                throw new HandshakeStateError(`responder cannot receive in state ${this.state}`)
            }
            const payload = this.guarded(() => noise.recv(message))
            if (payload.byteLength !== 0) return this.fail(new HandshakePayloadError())
            // The destination's identity is bound here, not by the protocol (v2 §6).
            if (!noise.rs || !timingSafeEqual(noise.rs, this.expectedRemoteStatic)) {
                return this.fail(new PeerIdentityMismatchError())
            }
            this.state = 'ready_for_msg2'
            return
        }
        if (this.state !== 'awaiting_msg2') {
            throw new HandshakeStateError(`initiator cannot receive in state ${this.state}`)
        }
        const payload = this.guarded(() => noise.recv(message))
        if (payload.byteLength !== 0) return this.fail(new HandshakePayloadError())
        this.establish()
    }

    /** Transport frame = u64BE counter ‖ AEAD(counter, aad, plaintext). */
    encrypt(plaintext: Buffer, aad: Buffer): Buffer {
        const cipher = this.requireEstablished(this.sendCipher)
        if (this.sendCounter > MAX_COUNTER) throw new CounterExhaustedError()
        const counter = this.sendCounter++
        const frame = Buffer.alloc(TRANSPORT_COUNTER_BYTES)
        frame.writeBigUInt64BE(counter, 0)
        return Buffer.concat([frame, cipher.seal(counter, aad, plaintext)])
    }

    /** Throws ReplayError (seen / too old) before touching the key, DecryptError on auth failure. */
    decrypt(frame: Buffer, aad: Buffer): Buffer {
        const cipher = this.requireEstablished(this.recvCipher)
        if (frame.byteLength < TRANSPORT_COUNTER_BYTES) throw new DecryptError()
        const counter = frame.readBigUInt64BE(0)
        const verdict = this.window.check(counter)
        if (verdict !== 'fresh') throw new ReplayError(verdict)
        const plaintext = cipher.open(counter, aad, frame.subarray(TRANSPORT_COUNTER_BYTES))
        if (plaintext === null) throw new DecryptError()
        this.window.mark(counter)
        return plaintext
    }

    get framesSent(): bigint {
        return this.sendCounter
    }

    destroy(): void {
        this.sendCipher?.destroy()
        this.recvCipher?.destroy()
        this.sendCipher = null
        this.recvCipher = null
        this.noise = null
        this.state = 'failed'
    }

    private establish(): void {
        const noise = this.requireNoise()
        if (!noise.complete || !noise.tx || !noise.rx || !noise.rs || !noise.hash) {
            return this.fail(new HandshakeFailedError('handshake did not complete'))
        }
        if (!timingSafeEqual(noise.rs, this.expectedRemoteStatic)) return this.fail(new PeerIdentityMismatchError())
        this.sendCipher = new TransportCipher(noise.tx)
        this.recvCipher = new TransportCipher(noise.rx)
        this.hash = Buffer.from(noise.hash)
        noise.tx.fill(0)
        noise.rx.fill(0)
        this.noise = null
        this.state = 'established'
    }

    private guarded<T>(fn: () => T): T {
        try {
            return fn()
        } catch (error) {
            // Library errors leave the handshake state unusable; surface a typed failure and pin it.
            return this.fail(new HandshakeFailedError(error instanceof Error ? error.message : String(error)))
        }
    }

    private fail(error: Error): never {
        this.state = 'failed'
        this.noise = null
        throw error
    }

    private requireNoise(): Noise {
        if (this.state === 'established') throw new HandshakeStateError('handshake already complete')
        if (!this.noise) throw new HandshakeStateError('handshake failed; start a new session')
        return this.noise
    }

    private requireEstablished(cipher: TransportCipher | null): TransportCipher {
        if (this.state !== 'established' || !cipher) throw new HandshakeStateError('channel is not established')
        return cipher
    }
}
