import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { RelayClient, type RelayClientOptions } from './relay-client'
import { createIdentity, type Identity } from '@/lib/identity'
import { NoiseSession } from '@/lib/noise/session'
import { encodePrologue } from '@/lib/noise/prologue'
import type { Frame, Role } from '@/relay-protocol'
import { FakeRelay } from '@/testing/fake-relay'
import { mintRelayToken, testBmaKey, makeBmaKey } from '@/testing/relay-tokens'
import { until } from '@/testing/pair-harness'

const TUNING = { heartbeatMs: 30_000, heartbeatMisses: 2, reconnectMinMs: 10, reconnectMaxMs: 40 }

const once = <T>(
    client: RelayClient,
    event: 'admitted' | 'fatal' | 'disconnected' | 'peer',
    timeoutMs = 2000,
): Promise<T> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${event} in time`)), timeoutMs)
        client.once(event, ((...args: unknown[]) => {
            clearTimeout(timer)
            resolve(args[0] as T)
        }) as never)
    })

const makeClient = (
    relay: FakeRelay,
    identity: Identity,
    role: Role,
    relaySessionId: string,
    overrides: Partial<RelayClientOptions> = {},
) =>
    new RelayClient({
        endpoint: relay.wsUrl,
        relaySessionId,
        legId: 'leg-a',
        role,
        tokenProvider: () =>
            mintRelayToken({ relaySessionId, role, fingerprint: identity.fingerprint, popKey: identity.popKey }),
        signChallenge: (payload) => identity.signPop(payload),
        tuning: TUNING,
        ...overrides,
    })

describe('RelayClient against the fake relay', () => {
    let relay: FakeRelay
    const clients: RelayClient[] = []

    beforeEach(async () => {
        relay = new FakeRelay({
            bmaPublicKeyPem: testBmaKey().publicPem,
            heartbeatIntervalMs: 5_000,
            challengeTimeoutMs: 500,
        })
        await relay.start()
    })

    afterEach(async () => {
        for (const client of clients) client.stop()
        clients.length = 0
        await relay.stop()
    })

    const track = (client: RelayClient) => {
        clients.push(client)
        return client
    }

    it('admits a valid token + proof of possession and learns the peer is absent', async () => {
        const identity = createIdentity()
        const client = track(makeClient(relay, identity, 'source', 'rs-admit'))
        const admitted = once<{ peer: { attached: boolean } }>(client, 'admitted')
        client.start()
        const header = await admitted
        expect(client.state).toBe('admitted')
        expect(header.peer).toEqual({ attached: false })
        expect(client.peerAttached).toBe(false)
        expect(relay.isLive('rs-admit', 'source')).toBe(true)
        expect(relay.session('rs-admit')?.fingerprints.source).toBe(identity.fingerprint)
        client.start() // no-op while running
        expect(client.state).toBe('admitted')
    })

    it('tells each side about the other with its fingerprint, on attach and on detach', async () => {
        const src = createIdentity()
        const dst = createIdentity()
        const source = track(makeClient(relay, src, 'source', 'rs-peer'))
        const srcAdmitted = once(source, 'admitted')
        source.start()
        await srcAdmitted
        const peerSeen = once<{ attached: boolean; fingerprint?: string }>(source, 'peer')
        const destination = track(makeClient(relay, dst, 'destination', 'rs-peer'))
        const dstAdmitted = once<{ peer: { attached: boolean; fingerprint?: string } }>(destination, 'admitted')
        destination.start()
        expect((await dstAdmitted).peer).toEqual({ attached: true, fingerprint: src.fingerprint })
        expect(await peerSeen).toEqual({ attached: true, fingerprint: dst.fingerprint })
        expect(source.peerAttached).toBe(true)
        const gone = once<{ attached: boolean; fingerprint?: string }>(source, 'peer')
        destination.stop()
        expect(await gone).toEqual({ attached: false, fingerprint: dst.fingerprint })
        expect(source.peerAttached).toBe(false)
    })

    it('rejects a token signed by the wrong key, an expired token, and a bad audience, then keeps retrying', async () => {
        const identity = createIdentity()
        const wrongKey = makeBmaKey()
        let attempts = 0
        const base = {
            relaySessionId: 'rs-badtoken',
            role: 'source' as const,
            fingerprint: identity.fingerprint,
            popKey: identity.popKey,
        }
        const client = track(
            makeClient(relay, identity, 'source', 'rs-badtoken', {
                tokenProvider: () => {
                    attempts++
                    if (attempts === 1) return mintRelayToken({ ...base, key: wrongKey })
                    if (attempts === 2) return mintRelayToken({ ...base, expiresInS: -3600 })
                    if (attempts === 3) return mintRelayToken({ ...base, overrides: { aud: 'other' } })
                    return mintRelayToken(base)
                },
            }),
        )
        const rejections: string[] = []
        relay.on('rejected', (code) => rejections.push(code))
        const admitted = once(client, 'admitted', 5000)
        client.start()
        await admitted
        expect(rejections).toEqual(['AUTH_TOKEN_INVALID', 'AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID'])
        expect(attempts).toBe(4)
    })

    it('a token whose popKey does not match our signing key fails PoP and is fatal (provisioning error)', async () => {
        const identity = createIdentity()
        const other = createIdentity()
        const client = track(
            makeClient(relay, identity, 'source', 'rs-pop', {
                tokenProvider: () =>
                    mintRelayToken({
                        relaySessionId: 'rs-pop',
                        role: 'source',
                        fingerprint: identity.fingerprint,
                        popKey: other.popKey,
                    }),
            }),
        )
        const fatal = once<string>(client, 'fatal')
        client.start()
        expect(await fatal).toBe('AUTH_POP_FAILED')
        expect(client.state).toBe('fatal')
        expect(relay.isLive('rs-pop', 'source')).toBe(false)
    })

    it('an ADMITTED whose legId disagrees with the bundle is a fatal provisioning mismatch', async () => {
        const identity = createIdentity()
        const client = track(
            makeClient(relay, identity, 'source', 'rs-leg', {
                tokenProvider: () =>
                    mintRelayToken({
                        relaySessionId: 'rs-leg',
                        role: 'source',
                        fingerprint: identity.fingerprint,
                        popKey: identity.popKey,
                        legId: 'leg-b',
                    }),
            }),
        )
        const fatal = once<string>(client, 'fatal')
        client.start()
        expect(await fatal).toBe('admitted_mismatch')
    })

    it('a killed socket triggers a backoff re-dial that resumes the same session', async () => {
        const identity = createIdentity()
        const client = track(makeClient(relay, identity, 'destination', 'rs-drop', { random: () => 0.5 }))
        let admissions = 0
        client.on('admitted', () => admissions++)
        const disconnected = once<{ code: number; wasAdmitted: boolean }>(client, 'disconnected')
        client.start()
        await until(() => (admissions === 1 ? true : undefined))
        expect(relay.dropSocket('rs-drop', 'destination')).toBe(true)
        expect((await disconnected).wasAdmitted).toBe(true)
        await until(() => (admissions === 2 ? true : undefined))
        expect(relay.isLive('rs-drop', 'destination')).toBe(true)
    })

    it('a second admission for the same role displaces the first socket', async () => {
        const identity = createIdentity()
        const first = track(makeClient(relay, identity, 'source', 'rs-displace'))
        const firstAdmitted = once(first, 'admitted')
        first.start()
        await firstAdmitted
        const displaced = new Promise<void>((resolve) => relay.once('displaced', () => resolve()))
        const second = track(makeClient(relay, identity, 'source', 'rs-displace'))
        const secondAdmitted = once(second, 'admitted')
        second.start()
        await secondAdmitted
        await displaced
        expect(second.state).toBe('admitted')
        // the displaced client re-dials and takes the slot back — flapping is the caller's problem to avoid
        await until(() => (first.state === 'admitted' ? true : undefined))
        second.stop()
    })

    it('terminates and re-dials when the relay stops sending heartbeats', async () => {
        await relay.stop()
        relay = new FakeRelay({ bmaPublicKeyPem: testBmaKey().publicPem, heartbeatIntervalMs: 40 })
        await relay.start()
        const identity = createIdentity()
        const client = track(makeClient(relay, identity, 'source', 'rs-hb', { random: () => 0 }))
        let admissions = 0
        client.on('admitted', () => admissions++)
        const disconnected = once<{ wasAdmitted: boolean }>(client, 'disconnected')
        client.start()
        await until(() => (admissions === 1 ? true : undefined))
        relay.setPingEnabled(false)
        expect((await disconnected).wasAdmitted).toBe(true)
        relay.setPingEnabled(true)
        await until(() => (admissions === 2 ? true : undefined))
    })

    it('send() returns false when not admitted and delivers frames when it is', async () => {
        const identity = createIdentity()
        const client = track(makeClient(relay, identity, 'source', 'rs-send'))
        expect(client.send({ type: 'ACK', header: { messageId: randomUUID() } })).toBe(false)
        const admitted = once(client, 'admitted')
        client.start()
        await admitted
        expect(client.send({ type: 'ACK', header: { messageId: randomUUID() } })).toBe(true)
        client.stop()
        expect(client.state).toBe('stopped')
        expect(client.send({ type: 'ACK', header: { messageId: randomUUID() } })).toBe(false)
        await until(() => (relay.isLive('rs-send', 'source') ? undefined : true))
    })

    it('ignores malformed frames from the relay without dropping the socket', async () => {
        const identity = createIdentity()
        const client = track(makeClient(relay, identity, 'source', 'rs-proto'))
        const admitted = once(client, 'admitted')
        client.start()
        await admitted
        relay.session('rs-proto')!.sockets.source!.ws.send(Buffer.from([9, 9, 9]))
        await new Promise((r) => setTimeout(r, 30))
        expect(client.state).toBe('admitted')
    })

    it('two tunnels complete Noise_IK through the relay with HANDSHAKE frames as opaque payloads', async () => {
        const srcId = createIdentity()
        const dstId = createIdentity()
        const source = track(makeClient(relay, srcId, 'source', 'rs-ik'))
        const destination = track(makeClient(relay, dstId, 'destination', 'rs-ik'))
        const prologue = encodePrologue({
            studyId: 's',
            relaySessionId: 'rs-ik',
            sourceOrgSlug: 'dp-a',
            destinationOrgSlug: 'si',
            sourceGeneration: 1,
            destinationGeneration: 1,
            sessionNonce: randomBytes(32),
        })
        const srcSession = new NoiseSession({
            role: 'responder',
            staticKeypair: srcId.noiseStatic,
            expectedRemoteStatic: dstId.publicKey,
            prologue,
        })
        const dstSession = new NoiseSession({
            role: 'initiator',
            staticKeypair: dstId.noiseStatic,
            expectedRemoteStatic: srcId.publicKey,
            prologue,
        })
        const received: Record<string, Frame[]> = { source: [], destination: [] }
        source.on('frame', (f) => received.source.push(f))
        destination.on('frame', (f) => received.destination.push(f))
        source.on('frame', (f) => {
            if (f.type !== 'HANDSHAKE') return
            srcSession.readHandshake(f.payload)
            source.send({ type: 'HANDSHAKE', header: {}, payload: srcSession.writeHandshake() })
        })
        destination.on('frame', (f) => {
            if (f.type === 'HANDSHAKE') dstSession.readHandshake(f.payload)
        })
        const bothAdmitted = Promise.all([once(source, 'admitted'), once(destination, 'admitted')])
        source.start()
        destination.start()
        await bothAdmitted
        await until(() => (source.peerAttached && destination.peerAttached ? true : undefined))
        expect(destination.send({ type: 'HANDSHAKE', header: {}, payload: dstSession.writeHandshake() })).toBe(true)
        await until(() => (dstSession.complete && srcSession.complete ? true : undefined))
        expect(dstSession.epochTag).toBe(srcSession.epochTag)
        expect(received.source.filter((f) => f.type === 'HANDSHAKE')).toHaveLength(1)
        expect(received.destination.filter((f) => f.type === 'HANDSHAKE')).toHaveLength(1)
    })

    it('a HANDSHAKE frame sent while the peer is absent is dropped by the relay', async () => {
        const dstId = createIdentity()
        const destination = track(makeClient(relay, dstId, 'destination', 'rs-lonely'))
        const admitted = once(destination, 'admitted')
        destination.start()
        await admitted
        const dropped = new Promise<string>((resolve) => relay.once('dropped', (_s, from) => resolve(from)))
        destination.send({ type: 'HANDSHAKE', header: {}, payload: Buffer.alloc(96) })
        expect(await dropped).toBe('destination')
    })
})
