import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import Noise from 'noise-handshake'
import LibCipher from 'noise-handshake/cipher'
import { generateKeyPair } from 'noise-handshake/dh'
import vector from './vectors/ik-25519-chachapoly-blake2b.json'
import {
    NoiseSession,
    HandshakeStateError,
    HandshakeFailedError,
    PeerIdentityMismatchError,
    HandshakePayloadError,
    ReplayError,
    DecryptError,
} from './session'
import { TransportCipher, ReplayWindow, nonceFor, MAX_COUNTER, CounterExhaustedError } from './transport-cipher'
import { encodePrologue } from './prologue'
import { encodeChunkHeader } from './chunk-header'
import { createMemoryTransportPair, nextFrame } from '@/testing/memory-transport'
import { NOISE_PROTOCOL } from '@/schemas/channel'

const hex = (value: string) => Buffer.from(value, 'hex')

describe('official Noise_IK_25519_ChaChaPoly_BLAKE2b vector', () => {
    it('reproduces both handshake messages and the handshake hash through noise-handshake', () => {
        expect(vector.protocol_name).toBe(NOISE_PROTOCOL)
        const initiator = new Noise('IK', true, generateKeyPair(hex(vector.init_static)))
        const responder = new Noise('IK', false, generateKeyPair(hex(vector.resp_static)))
        initiator.e = generateKeyPair(hex(vector.init_ephemeral))
        responder.e = generateKeyPair(hex(vector.resp_ephemeral))
        initiator.initialise(hex(vector.init_prologue), hex(vector.init_remote_static))
        responder.initialise(hex(vector.resp_prologue))

        const m1 = initiator.send(hex(vector.messages[0].payload))
        expect(m1.toString('hex')).toBe(vector.messages[0].ciphertext)
        expect(responder.recv(m1).toString('hex')).toBe(vector.messages[0].payload)

        const m2 = responder.send(hex(vector.messages[1].payload))
        expect(m2.toString('hex')).toBe(vector.messages[1].ciphertext)
        expect(initiator.recv(m2).toString('hex')).toBe(vector.messages[1].payload)

        expect(initiator.complete && responder.complete).toBe(true)
        expect(initiator.hash!.toString('hex')).toBe(vector.handshake_hash)
        expect(responder.hash!.toString('hex')).toBe(vector.handshake_hash)

        // transport messages alternate initiator → responder → initiator → responder, n = 0,0,1,1
        const initSend = new TransportCipher(initiator.tx!)
        const respRecv = new TransportCipher(responder.rx!)
        const respSend = new TransportCipher(responder.tx!)
        const initRecv = new TransportCipher(initiator.rx!)
        const empty = Buffer.alloc(0)
        const [t0, t1, t2, t3] = vector.messages.slice(2)
        expect(initSend.seal(0n, empty, hex(t0.payload)).toString('hex')).toBe(t0.ciphertext)
        expect(respRecv.open(0n, empty, hex(t0.ciphertext))!.toString('hex')).toBe(t0.payload)
        expect(respSend.seal(0n, empty, hex(t1.payload)).toString('hex')).toBe(t1.ciphertext)
        expect(initRecv.open(0n, empty, hex(t1.ciphertext))!.toString('hex')).toBe(t1.payload)
        expect(initSend.seal(1n, empty, hex(t2.payload)).toString('hex')).toBe(t2.ciphertext)
        expect(respSend.seal(1n, empty, hex(t3.payload)).toString('hex')).toBe(t3.ciphertext)
    })

    it('TransportCipher agrees with the library CipherState for random inputs', () => {
        const key = randomBytes(32)
        const ours = new TransportCipher(key)
        const theirs = new LibCipher(Buffer.from(key))
        for (let n = 0; n < 5; n++) {
            const aad = randomBytes(20)
            const plaintext = randomBytes(1 + Math.floor(Math.random() * 500))
            theirs.setNonce(n)
            const expected = theirs.encrypt(plaintext, aad)
            expect(ours.seal(BigInt(n), aad, plaintext).equals(expected)).toBe(true)
            expect(ours.open(BigInt(n), aad, expected)!.equals(plaintext)).toBe(true)
        }
    })
})

describe('TransportCipher and ReplayWindow', () => {
    it('encodes the Noise nonce as 32 zero bits followed by a little-endian u64', () => {
        expect(nonceFor(0n).toString('hex')).toBe('000000000000000000000000')
        expect(nonceFor(1n).toString('hex')).toBe('000000000100000000000000')
        expect(nonceFor(0x0102030405060708n).toString('hex')).toBe('000000000807060504030201')
        expect(() => nonceFor(MAX_COUNTER + 1n)).toThrow(CounterExhaustedError)
        expect(() => nonceFor(-1n)).toThrow(CounterExhaustedError)
    })

    it('rejects a bad key, tampered ciphertext, wrong aad, wrong counter, and short input', () => {
        expect(() => new TransportCipher(randomBytes(16))).toThrow(TypeError)
        const cipher = new TransportCipher(randomBytes(32))
        const aad = Buffer.from('aad')
        const ct = cipher.seal(7n, aad, Buffer.from('secret'))
        expect(cipher.open(7n, aad, ct)!.toString()).toBe('secret')
        const tampered = Buffer.from(ct)
        tampered[0] ^= 1
        expect(cipher.open(7n, aad, tampered)).toBeNull()
        expect(cipher.open(7n, Buffer.from('other'), ct)).toBeNull()
        expect(cipher.open(8n, aad, ct)).toBeNull()
        expect(cipher.open(7n, aad, Buffer.alloc(3))).toBeNull()
        cipher.destroy()
        expect(cipher.destroyed).toBe(true)
        expect(() => cipher.seal(0n, aad, Buffer.alloc(1))).toThrow(/destroyed/)
    })

    it('classifies counters as fresh, replay or too old and only advances on mark', () => {
        const window = new ReplayWindow(4)
        expect(window.check(0n)).toBe('fresh')
        expect(window.highestSeen).toBe(-1n)
        window.mark(5n)
        expect(window.check(5n)).toBe('replay')
        expect(window.check(6n)).toBe('fresh')
        expect(window.check(2n)).toBe('fresh') // within the window, unseen
        expect(window.check(1n)).toBe('too_old')
        window.mark(2n)
        expect(window.check(2n)).toBe('replay')
        window.mark(10n) // prunes everything <= 6
        expect(window.check(2n)).toBe('too_old')
        expect(window.check(7n)).toBe('fresh')
        expect(window.highestSeen).toBe(10n)
    })
})

const keypair = () => generateKeyPair()

const prologue = () =>
    encodePrologue({
        studyId: 'study-1',
        relaySessionId: 'rs-1',
        sourceOrgSlug: 'dp-a',
        destinationOrgSlug: 'si-hub',
        sourceGeneration: 1,
        destinationGeneration: 1,
        sessionNonce: randomBytes(32),
    })

/** destination = initiator, source = responder (v2 §6). */
const pair = (opts: { prologueA?: Buffer; prologueB?: Buffer; expectAtDst?: Buffer; expectAtSrc?: Buffer } = {}) => {
    const src = keypair()
    const dst = keypair()
    const p = prologue()
    const destination = new NoiseSession({
        role: 'initiator',
        staticKeypair: dst,
        expectedRemoteStatic: opts.expectAtDst ?? src.publicKey,
        prologue: opts.prologueA ?? p,
    })
    const source = new NoiseSession({
        role: 'responder',
        staticKeypair: src,
        expectedRemoteStatic: opts.expectAtSrc ?? dst.publicKey,
        prologue: opts.prologueB ?? p,
    })
    return { src, dst, destination, source }
}

const handshake = (destination: NoiseSession, source: NoiseSession) => {
    const m1 = destination.writeHandshake()
    source.readHandshake(m1)
    const m2 = source.writeHandshake()
    destination.readHandshake(m2)
}

const header = (chunkIndex = 0) =>
    encodeChunkHeader({
        messageId: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b',
        chunkIndex,
        chunkCount: 4,
        senderConnectionId: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6c',
    })

describe('NoiseSession', () => {
    it('requires expectedRemoteStatic for both roles', () => {
        const kp = keypair()
        expect(() => new NoiseSession({ role: 'initiator', staticKeypair: kp, prologue: prologue() } as never)).toThrow(
            TypeError,
        )
        expect(
            () =>
                new NoiseSession({
                    role: 'responder',
                    staticKeypair: kp,
                    expectedRemoteStatic: randomBytes(31),
                    prologue: prologue(),
                }),
        ).toThrow(TypeError)
    })

    it('completes IK over the memory transport and carries AEAD frames both ways', async () => {
        const { destination, source } = pair()
        const [dstEnd, srcEnd] = createMemoryTransportPair()

        const m1Arrived = nextFrame(srcEnd)
        await dstEnd.send(destination.writeHandshake())
        source.readHandshake(await m1Arrived)
        expect(source.complete).toBe(false)
        const m2Arrived = nextFrame(dstEnd)
        await srcEnd.send(source.writeHandshake())
        expect(source.complete).toBe(true)
        destination.readHandshake(await m2Arrived)
        expect(destination.complete).toBe(true)

        expect(destination.epochTag).toMatch(/^[0-9a-f]{16}$/)
        expect(destination.epochTag).toBe(source.epochTag)
        expect(destination.handshakeHash!.equals(source.handshakeHash!)).toBe(true)

        const q = destination.encrypt(Buffer.from('query'), header(0))
        expect(q.readBigUInt64BE(0)).toBe(0n)
        expect(source.decrypt(q, header(0)).toString()).toBe('query')
        const r = source.encrypt(Buffer.from('response'), header(1))
        expect(destination.decrypt(r, header(1)).toString()).toBe('response')
        const q2 = destination.encrypt(Buffer.from('query2'), header(2))
        expect(q2.readBigUInt64BE(0)).toBe(1n)
        expect(destination.framesSent).toBe(2n)
        expect(source.decrypt(q2, header(2)).toString()).toBe('query2')
    })

    it('fails the handshake when any single prologue field differs', () => {
        const base = {
            studyId: 'study-1',
            relaySessionId: 'rs-1',
            sourceOrgSlug: 'dp-a',
            destinationOrgSlug: 'si-hub',
            sourceGeneration: 1,
            destinationGeneration: 1,
            sessionNonce: randomBytes(32),
        }
        const variants = [
            { studyId: 'study-2' },
            { relaySessionId: 'rs-2' },
            { sourceOrgSlug: 'dp-b' },
            { destinationOrgSlug: 'dp-a' },
            { sourceGeneration: 2 },
            { destinationGeneration: 2 },
            { sessionNonce: randomBytes(32) },
        ]
        for (const variant of variants) {
            const src = keypair()
            const dst = keypair()
            const destination = new NoiseSession({
                role: 'initiator',
                staticKeypair: dst,
                expectedRemoteStatic: src.publicKey,
                prologue: encodePrologue(base),
            })
            const source = new NoiseSession({
                role: 'responder',
                staticKeypair: src,
                expectedRemoteStatic: dst.publicKey,
                prologue: encodePrologue({ ...base, ...variant }),
            })
            expect(() => source.readHandshake(destination.writeHandshake()), JSON.stringify(variant)).toThrow(
                HandshakeFailedError,
            )
            expect(source.failed).toBe(true)
            expect(() => source.writeHandshake()).toThrow(HandshakeStateError)
        }
    })

    it('rejects a tampered chunk header (AAD) and a tampered frame', () => {
        const { destination, source } = pair()
        handshake(destination, source)
        const frame = destination.encrypt(Buffer.from('payload'), header(0))
        expect(() => source.decrypt(frame, header(1))).toThrow(DecryptError)
        const tampered = Buffer.from(frame)
        tampered[tampered.byteLength - 1] ^= 1
        expect(() => source.decrypt(tampered, header(0))).toThrow(DecryptError)
        expect(() => source.decrypt(Buffer.alloc(3), header(0))).toThrow(DecryptError)
        // failures did not consume the counter: the genuine frame still decrypts
        expect(source.decrypt(frame, header(0)).toString()).toBe('payload')
    })

    it('rejects replayed frames, accepts out-of-order frames inside the window, and rejects too-old ones', () => {
        const { destination, source } = pair()
        handshake(destination, source)
        const frames = Array.from({ length: 3 }, (_, i) => destination.encrypt(Buffer.from(`m${i}`), header(0)))
        expect(source.decrypt(frames[2], header(0)).toString()).toBe('m2')
        expect(() => source.decrypt(frames[2], header(0))).toThrow(ReplayError)
        expect(source.decrypt(frames[0], header(0)).toString()).toBe('m0')
        expect(source.decrypt(frames[1], header(0)).toString()).toBe('m1')
        try {
            source.decrypt(frames[1], header(0))
        } catch (error) {
            expect((error as ReplayError).verdict).toBe('replay')
        }
        // push the window far ahead so counter 0 falls out
        for (let i = 0; i < 1100; i++) destination.encrypt(Buffer.alloc(1), header(0))
        const far = destination.encrypt(Buffer.from('far'), header(0))
        expect(source.decrypt(far, header(0)).toString()).toBe('far')
        const old = new NoiseSession({
            role: 'initiator',
            staticKeypair: keypair(),
            expectedRemoteStatic: randomBytes(32),
            prologue: prologue(),
        })
        expect(old.complete).toBe(false)
        try {
            source.decrypt(frames[0], header(0))
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(ReplayError)
            expect((error as ReplayError).verdict).toBe('too_old')
        }
    })

    it('a wrong source static pre-shared at the destination fails cryptographically at message 1', () => {
        const { destination, source } = pair({ expectAtDst: keypair().publicKey })
        const m1 = destination.writeHandshake()
        expect(() => source.readHandshake(m1)).toThrow(HandshakeFailedError)
        expect(() => source.readHandshake(m1)).not.toThrow(PeerIdentityMismatchError)
        expect(source.failed).toBe(true)
        expect(() => source.writeHandshake()).toThrow(HandshakeStateError) // no message 2 is ever produced
        expect(() => source.encrypt(Buffer.alloc(1), header())).toThrow(HandshakeStateError)
    })

    it('a destination whose static differs from the pin-verified key is rejected by the source before message 2', () => {
        const { destination, source } = pair({ expectAtSrc: keypair().publicKey })
        const m1 = destination.writeHandshake()
        expect(() => source.readHandshake(m1)).toThrow(PeerIdentityMismatchError)
        expect(source.failed).toBe(true)
        expect(source.complete).toBe(false)
        expect(source.epochTag).toBeUndefined()
        expect(() => source.writeHandshake()).toThrow(HandshakeStateError)
        expect(() => source.encrypt(Buffer.alloc(1), header())).toThrow(HandshakeStateError)
        expect(() => source.decrypt(Buffer.alloc(30), header())).toThrow(HandshakeStateError)
        expect(destination.complete).toBe(false)
    })

    it('ignores handshake messages once established and refuses out-of-order handshake calls', () => {
        const { destination, source } = pair()
        const m1 = destination.writeHandshake()
        expect(() => destination.writeHandshake()).toThrow(HandshakeStateError)
        expect(() => destination.readHandshake(Buffer.alloc(48))).toThrow(HandshakeFailedError)
        const { destination: d2, source: s2 } = pair()
        expect(() => s2.writeHandshake()).toThrow(HandshakeStateError)
        const m1b = d2.writeHandshake()
        s2.readHandshake(m1b)
        d2.readHandshake(s2.writeHandshake())
        expect(() => s2.readHandshake(m1b)).toThrow(HandshakeStateError)
        expect(() => d2.readHandshake(m1b)).toThrow(HandshakeStateError)
        expect(() => s2.writeHandshake()).toThrow(HandshakeStateError)
        const f = d2.encrypt(Buffer.from('still fine'), header())
        expect(s2.decrypt(f, header()).toString()).toBe('still fine')
        void source
        void m1
    })

    it('rejects a handshake message that carries a payload', () => {
        const src = keypair()
        const dst = keypair()
        const p = prologue()
        const rawInitiator = new Noise('IK', true, dst)
        rawInitiator.initialise(p, src.publicKey)
        const source = new NoiseSession({
            role: 'responder',
            staticKeypair: src,
            expectedRemoteStatic: dst.publicKey,
            prologue: p,
        })
        expect(() => source.readHandshake(rawInitiator.send(Buffer.from('smuggled')))).toThrow(HandshakePayloadError)

        const rawResponder = new Noise('IK', false, src)
        rawResponder.initialise(p)
        const destination = new NoiseSession({
            role: 'initiator',
            staticKeypair: dst,
            expectedRemoteStatic: src.publicKey,
            prologue: p,
        })
        rawResponder.recv(destination.writeHandshake())
        expect(() => destination.readHandshake(rawResponder.send(Buffer.from('smuggled')))).toThrow(
            HandshakePayloadError,
        )
    })

    it('destroy zeroes keys and disables the session', () => {
        const { destination, source } = pair()
        handshake(destination, source)
        destination.destroy()
        expect(() => destination.encrypt(Buffer.alloc(1), header())).toThrow(HandshakeStateError)
        expect(destination.complete).toBe(false)
        expect(destination.failed).toBe(true)
    })
})
