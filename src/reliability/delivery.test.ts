import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { Delivery, BackpressureError, LimitExceededError, type DeliveryEvent } from './delivery'
import { Exchange } from '@/lib/exchange'
import { createIdentity } from '@/lib/identity'
import { NoiseSession } from '@/lib/noise/session'
import { encodePrologue } from '@/lib/noise/prologue'
import { CapsMeter } from '@/reliability/caps'
import { TUNING_DEFAULTS } from '@/config'
import type { Frame } from '@/schemas/relay-wire'
import type { DeliveredMessage } from '@/schemas/local-api'
import { encodeChunkHeader } from '@/lib/noise/chunk-header'
import { pad } from '@/reliability/padding'

// Two Delivery instances wired back to back through a scripted "relay": every frame one side
// sends is handed to the other's onFrame (optionally held or duplicated), with no sockets.

const wire = () => {
    const queues: Record<'toSource' | 'toDestination', Frame[]> = { toSource: [], toDestination: [] }
    let connected = true
    const held: Frame[] = []
    let hold = false
    return {
        queues,
        held,
        setHold: (value: boolean) => (hold = value),
        setConnected: (value: boolean) => (connected = value),
        senderFor: (direction: 'toSource' | 'toDestination', deliverTo: () => Delivery | undefined) => ({
            send: (frame: Frame) => {
                if (!connected) return false
                queues[direction].push(frame)
                if (hold) held.push(frame)
                else queueMicrotask(() => deliverTo()?.onFrame(frame))
                return true
            },
            get connected() {
                return connected
            },
        }),
        release: (to: Delivery) => {
            const frames = held.splice(0)
            for (const f of frames) to.onFrame(f)
        },
    }
}

const setup = (options: { caps?: CapsMeter; window?: { maxMsgs: number; maxBytes: number } } = {}) => {
    const src = createIdentity()
    const dst = createIdentity()
    const prologue = encodePrologue({
        studyId: 's',
        relaySessionId: 'rs',
        sourceOrgSlug: 'dp-a',
        destinationOrgSlug: 'si',
        sourceGeneration: 1,
        destinationGeneration: 1,
        sessionNonce: randomBytes(32),
    })
    const srcSession = new NoiseSession({
        role: 'responder',
        staticKeypair: src.noiseStatic,
        expectedRemoteStatic: dst.publicKey,
        prologue,
    })
    const dstSession = new NoiseSession({
        role: 'initiator',
        staticKeypair: dst.noiseStatic,
        expectedRemoteStatic: src.publicKey,
        prologue,
    })
    srcSession.readHandshake(dstSession.writeHandshake())
    dstSession.readHandshake(srcSession.writeHandshake())

    const w = wire()
    const events: Record<'source' | 'destination', DeliveryEvent[]> = { source: [], destination: [] }
    const delivered: Record<'source' | 'destination', DeliveredMessage[]> = { source: [], destination: [] }
    const controls: string[] = []
    const limits: LimitExceededError[] = []

    const srcExchange = new Exchange('source', { onDelivered: (m) => delivered.source.push(m) })
    const dstExchange = new Exchange('destination', { onDelivered: (m) => delivered.destination.push(m) })
    const window = options.window ?? {
        maxMsgs: TUNING_DEFAULTS.inflightMaxMsgs,
        maxBytes: TUNING_DEFAULTS.inflightMaxBytes,
    }
    const common = {
        buckets: TUNING_DEFAULTS.padBuckets,
        window,
        inbox: { maxPartialMessages: 64, maxPartialBytes: 64 * 1024 * 1024 },
        backpressureRetryMs: 5,
        onControl: (control: string) => controls.push(control),
    }
    const sourceDelivery: Delivery = new Delivery({
        ...common,
        role: 'source',
        connectionId: src.connectionId,
        exchange: srcExchange,
        sender: w.senderFor('toDestination', () => destinationDelivery),
        caps: options.caps,
        onLimitExceeded: (e) => limits.push(e),
        onEvent: (e) => events.source.push(e),
    })
    const destinationDelivery: Delivery = new Delivery({
        ...common,
        role: 'destination',
        connectionId: dst.connectionId,
        exchange: dstExchange,
        sender: w.senderFor('toSource', () => sourceDelivery),
        onLimitExceeded: (e) => limits.push(e),
        onEvent: (e) => events.destination.push(e),
    })
    srcExchange.setTransport(sourceDelivery)
    dstExchange.setTransport(destinationDelivery)
    sourceDelivery.setSession(srcSession, dst.connectionId)
    destinationDelivery.setSession(dstSession, src.connectionId)
    return {
        w,
        events,
        delivered,
        controls,
        limits,
        srcExchange,
        dstExchange,
        sourceDelivery,
        destinationDelivery,
        srcSession,
        dstSession,
        src,
        dst,
    }
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

describe('Delivery back to back', () => {
    it('carries a round with a multi-chunk query, budget hints, ACK eviction and FIFO ordering', async () => {
        const caps = new CapsMeter({ maxRounds: 10 })
        const t = setup({ caps })
        const big = 'x'.repeat(100_000)
        const { correlationId } = t.dstExchange.request({ big })
        expect(t.destinationDelivery.outbox.depth).toBe(1)
        await flushMicrotasks()
        expect(t.delivered.source).toHaveLength(1)
        expect(t.delivered.source[0].payload).toEqual({ big })
        const queryFrames = t.w.queues.toSource.filter((f) => f.type === 'DATA')
        expect(queryFrames).toHaveLength(4)
        expect(queryFrames.map((f) => (f as { header: { chunkIndex: number } }).header.chunkIndex)).toEqual([
            0, 1, 2, 3,
        ])
        expect((queryFrames[0] as { payload: Buffer }).payload.byteLength).toBe(32768)

        const query = t.delivered.source[0]
        t.srcExchange.ack(query.messageId)
        const { messageId: responseId } = t.srcExchange.respond(correlationId, { n: 1 })
        await flushMicrotasks()
        expect(t.delivered.destination).toHaveLength(1)
        expect(t.delivered.destination[0].budget).toMatchObject({ roundsUsed: 1, roundsMax: 10 })
        const responseFrame = t.w.queues.toDestination.find((f) => f.type === 'DATA') as {
            header: { respondsTo?: string }
        }
        expect(responseFrame.header.respondsTo).toBe(query.messageId)
        expect(t.sourceDelivery.outbox.depth).toBe(1)
        t.dstExchange.ack(responseId)
        await flushMicrotasks()
        expect(t.sourceDelivery.outbox.depth).toBe(0)
        expect(t.destinationDelivery.outbox.depth).toBe(0)
        expect(t.events.source.some((e) => e.type === 'acked')).toBe(true)
    })

    it('re-ACKs a duplicate frame only once the RC consumed it, and NACKs undecryptable ones', async () => {
        const t = setup()
        t.dstExchange.request({ q: 1 })
        await flushMicrotasks()
        const frame = t.w.queues.toSource.find((f) => f.type === 'DATA')!
        t.sourceDelivery.onFrame(frame) // relay redelivery of the same bytes, RC not yet acked
        expect(t.events.source.filter((e) => e.type === 'duplicate')).toEqual([
            { type: 'duplicate', messageId: t.delivered.source[0].messageId, reacked: false },
        ])
        t.srcExchange.ack(t.delivered.source[0].messageId)
        const acksBefore = t.w.queues.toDestination.filter((f) => f.type === 'ACK').length
        t.sourceDelivery.onFrame(frame)
        expect(t.w.queues.toDestination.filter((f) => f.type === 'ACK').length).toBe(acksBefore + 1)
        expect(t.delivered.source).toHaveLength(1)

        // a fresh counter (so the replay window passes) whose ciphertext was tampered with
        const tamperedId = uuidv4()
        const tamperedAad = encodeChunkHeader({
            messageId: tamperedId,
            chunkIndex: 0,
            chunkCount: 1,
            senderConnectionId: t.dst.connectionId,
        })
        const tampered = t.dstSession.encrypt(pad(Buffer.from('x'), TUNING_DEFAULTS.padBuckets), tamperedAad)
        tampered[tampered.byteLength - 1] ^= 1
        t.sourceDelivery.onFrame({
            type: 'DATA',
            header: {
                messageId: tamperedId,
                chunkIndex: 0,
                chunkCount: 1,
                epochTag: t.dstSession.epochTag!,
                sizeBytes: 1024,
            },
            payload: tampered,
        })
        expect(t.events.source.at(-1)).toMatchObject({ type: 'nack', messageId: tamperedId, reason: 'undecryptable' })
        const stale = {
            ...frame,
            header: { ...(frame as { header: object }).header, epochTag: '0000000000000000' },
        } as Frame
        t.sourceDelivery.onFrame(stale)
        expect(t.events.source.at(-1)).toMatchObject({ type: 'nack', reason: 'stale_epoch' })
    })

    it('rejects a query arriving at the destination (direction) with a NACK', async () => {
        const t = setup()
        // the source misbehaves: it enqueues a query-kind message
        t.sourceDelivery.send({ kind: 'query', messageId: uuidv4(), correlationId: uuidv4(), payload: 1 })
        await flushMicrotasks()
        expect(t.delivered.destination).toHaveLength(0)
        expect(t.events.destination.at(-1)).toMatchObject({ type: 'nack', reason: 'direction' })
    })

    it('surfaces a full local window as BackpressureError and retries relay BACKPRESSURE', async () => {
        const t = setup({ window: { maxMsgs: 1, maxBytes: 10_000 } })
        t.dstExchange.request({ q: 1 })
        expect(() => t.destinationDelivery.sendControl('CLOSE')).toThrow(BackpressureError)
        const messageId = t.destinationDelivery.outbox.inOrder()[0].messageId
        const sentBefore = t.w.queues.toSource.filter((f) => f.type === 'DATA').length
        t.destinationDelivery.onFrame({ type: 'ERROR', header: { code: 'BACKPRESSURE', retryable: true, messageId } })
        expect(t.events.destination.at(-1)).toMatchObject({ type: 'backpressure', messageId })
        await new Promise((r) => setTimeout(r, 20))
        expect(t.w.queues.toSource.filter((f) => f.type === 'DATA').length).toBe(sentBefore + 1)
        expect(t.events.destination.filter((e) => e.type === 'sent').at(-1)).toMatchObject({ resend: true })
        t.destinationDelivery.onFrame({ type: 'ERROR', header: { code: 'RATE_LIMITED', retryable: true } })
        t.destinationDelivery.stop()
    })

    it('re-encrypts the outbox under a new epoch and drops stale inbox partials', async () => {
        const t = setup()
        t.w.setConnected(false)
        t.dstExchange.request({ q: 1 })
        expect(t.destinationDelivery.outbox.depth).toBe(1)
        expect(t.w.queues.toSource).toHaveLength(0)
        // new epoch on both sides (simulating a re-handshake), then reconnect
        const prologue = encodePrologue({
            studyId: 's',
            relaySessionId: 'rs',
            sourceOrgSlug: 'dp-a',
            destinationOrgSlug: 'si',
            sourceGeneration: 2,
            destinationGeneration: 1,
            sessionNonce: randomBytes(32),
        })
        const s2 = new NoiseSession({
            role: 'responder',
            staticKeypair: t.src.noiseStatic,
            expectedRemoteStatic: t.dst.publicKey,
            prologue,
        })
        const d2 = new NoiseSession({
            role: 'initiator',
            staticKeypair: t.dst.noiseStatic,
            expectedRemoteStatic: t.src.publicKey,
            prologue,
        })
        s2.readHandshake(d2.writeHandshake())
        d2.readHandshake(s2.writeHandshake())
        t.sourceDelivery.setSession(s2, t.dst.connectionId)
        t.w.setConnected(true)
        t.destinationDelivery.setSession(d2, t.src.connectionId)
        await flushMicrotasks()
        expect(t.delivered.source).toHaveLength(1)
        expect((t.w.queues.toSource[0] as { header: { epochTag: string } }).header.epochTag).toBe(d2.epochTag)
        expect(t.destinationDelivery.epochTag).toBe(d2.epochTag)
        expect(t.destinationDelivery.stats()).toMatchObject({ outboxDepth: 1, inboxPartials: 0 })
    })

    it('queues ACKs while disconnected and flushes them on reconnect', async () => {
        const t = setup()
        t.dstExchange.request({ q: 1 })
        await flushMicrotasks()
        t.w.setConnected(false)
        t.srcExchange.ack(t.delivered.source[0].messageId)
        expect(t.sourceDelivery.stats().pendingAcks).toBe(1)
        t.w.setConnected(true)
        t.sourceDelivery.onReconnected()
        expect(t.sourceDelivery.stats().pendingAcks).toBe(0)
        expect(t.w.queues.toDestination.filter((f) => f.type === 'ACK')).toHaveLength(1)
    })

    it('enforces source caps: response breach refuses the send and notifies; query breach refuses delivery', async () => {
        const caps = new CapsMeter({ maxResponsePlaintextBytesPerRound: 10, maxQueryPlaintextBytesPerRound: 100 })
        const t = setup({ caps })
        t.dstExchange.request({ q: 1 })
        await flushMicrotasks()
        const query = t.delivered.source[0]
        t.srcExchange.ack(query.messageId)
        expect(() => t.srcExchange.respond(query.correlationId, { big: 'x'.repeat(50) })).toThrow(LimitExceededError)
        expect(t.limits[0]).toMatchObject({ side: 'response', limit: 'maxResponsePlaintextBytesPerRound' })
        expect(t.srcExchange.respond(query.correlationId, { ok: 1 }).replayed).toBe(false) // round still answerable
        await flushMicrotasks()
        t.dstExchange.ack(t.delivered.destination[0].messageId)

        // a control message travels the same path and is acked by the receiving tunnel
        const controlId = t.sourceDelivery.sendControl('LIMIT_EXCEEDED', 'test')
        await flushMicrotasks()
        expect(t.controls).toEqual(['LIMIT_EXCEEDED'])
        expect(t.w.queues.toSource.filter((f) => f.type === 'ACK' && f.header.messageId === controlId)).toHaveLength(1)

        const t2 = setup({ caps: new CapsMeter({ maxQueryPlaintextBytesPerRound: 10 }) })
        t2.dstExchange.request({ big: 'x'.repeat(50) })
        await flushMicrotasks()
        expect(t2.delivered.source).toHaveLength(0)
        expect(t2.limits[0]).toMatchObject({ side: 'query', limit: 'maxQueryPlaintextBytesPerRound' })
        expect(t2.events.source.at(-1)).toMatchObject({ type: 'limit_exceeded', side: 'query' })
    })

    it('NACKs malformed plaintext and handles a peer NACK by re-offering once', async () => {
        const t = setup()
        const aad = (messageId: string) =>
            encodeChunkHeader({ messageId, chunkIndex: 0, chunkCount: 1, senderConnectionId: t.dst.connectionId })
        const messageId = uuidv4()
        const junk = t.dstSession.encrypt(pad(Buffer.from('not json'), TUNING_DEFAULTS.padBuckets), aad(messageId))
        t.sourceDelivery.onFrame({
            type: 'DATA',
            header: { messageId, chunkIndex: 0, chunkCount: 1, epochTag: t.dstSession.epochTag!, sizeBytes: 1 },
            payload: junk,
        })
        expect(t.events.source.at(-1)).toMatchObject({ type: 'nack', messageId, reason: 'malformed' })

        t.dstExchange.request({ q: 1 })
        await flushMicrotasks()
        const sent = t.destinationDelivery.outbox.inOrder()[0]
        t.destinationDelivery.onFrame({
            type: 'NACK_DISCARD',
            header: { messageId: sent.messageId, reason: 'undecryptable' },
        })
        expect(t.events.destination.at(-1)).toMatchObject({ type: 'peer_nack', messageId: sent.messageId })
        await new Promise((r) => setTimeout(r, 20))
        expect(t.destinationDelivery.outbox.get(sent.messageId)?.sends).toBe(2)
        t.destinationDelivery.stop()
    })
})
