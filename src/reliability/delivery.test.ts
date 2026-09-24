import { describe, it, expect } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Delivery, BackpressureError, LimitExceededError, MessageTooLargeError, type DeliveryEvent } from './delivery'
import { Exchange } from '@/lib/exchange'
import { createIdentity } from '@/lib/identity'
import { NoiseSession } from '@/lib/noise/session'
import { encodePrologue } from '@/lib/noise/prologue'
import { CapsMeter } from '@/reliability/caps'
import type { Frame } from '@/relay-protocol'
import type { DeliveredMessage } from '@/local-api'
import { encodeChunkHeader } from '@/lib/noise/chunk-header'
import { pad } from '@/reliability/padding'
import { PAD_BUCKETS } from '@/schemas/channel'

// Two Delivery instances wired back to back through a scripted "relay": every frame one side
// sends is handed to the other's onFrame (optionally held or duplicated), with no sockets.

const wire = () => {
    const queues: Record<'toSource' | 'toDestination', Frame[]> = { toSource: [], toDestination: [] }
    let connected = true
    let peerAttached = true
    const held: Frame[] = []
    let hold = false
    return {
        queues,
        held,
        setHold: (value: boolean) => (hold = value),
        setConnected: (value: boolean) => (connected = value),
        setPeerAttached: (value: boolean) => (peerAttached = value),
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
            get peerAttached() {
                return peerAttached
            },
        }),
    }
}

const sessions = (src: ReturnType<typeof createIdentity>, dst: ReturnType<typeof createIdentity>, generation = 1) => {
    const prologue = encodePrologue({
        studyId: 's',
        relaySessionId: 'rs',
        sourceOrgSlug: 'dp-a',
        destinationOrgSlug: 'si',
        sourceGeneration: generation,
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
    return { srcSession, dstSession }
}

const setup = (
    options: {
        caps?: CapsMeter
        window?: { maxMsgs: number; maxBytes: number }
        retransmitMs?: number
        maxSends?: number
        now?: () => number
    } = {},
) => {
    const src = createIdentity()
    const dst = createIdentity()
    const { srcSession, dstSession } = sessions(src, dst)
    const w = wire()
    const events: Record<'source' | 'destination', DeliveryEvent[]> = { source: [], destination: [] }
    const delivered: Record<'source' | 'destination', DeliveredMessage[]> = { source: [], destination: [] }
    const limits: LimitExceededError[] = []
    const fatal: string[] = []
    const srcExchange = new Exchange('source', { onDelivered: (m) => delivered.source.push(m) })
    const dstExchange = new Exchange('destination', { onDelivered: (m) => delivered.destination.push(m) })
    const common = {
        window: options.window ?? { maxMsgs: 64, maxBytes: 256 * 1024 * 1024 },
        maxMessageBytes: 1024 * 1024,
        inbox: { maxPartialMessages: 64, maxPartialBytes: 64 * 1024 * 1024 },
        backpressureRetryMs: 5,
        retransmitMs: options.retransmitMs ?? 60_000,
        maxSends: options.maxSends ?? 10,
        unackedMaxMs: 3600_000,
        onFatal: (reason: string) => fatal.push(reason),
        now: options.now,
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
        limits,
        fatal,
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

const flush = () => new Promise((r) => setTimeout(r, 0))
const dataFrames = (frames: Frame[]) => frames.filter((f): f is Extract<Frame, { type: 'DATA' }> => f.type === 'DATA')

describe('Delivery back to back', () => {
    it('carries a round with a multi-chunk query, budget hints, ACK eviction and FIFO ordering', async () => {
        const caps = new CapsMeter({ maxRounds: 10 })
        const t = setup({ caps })
        const big = 'x'.repeat(100_000)
        const { correlationId } = t.dstExchange.request({ big })
        expect(t.destinationDelivery.outbox.depth).toBe(1)
        await flush()
        expect(t.delivered.source).toHaveLength(1)
        expect(t.delivered.source[0]!.payload).toEqual({ big })
        const queryFrames = dataFrames(t.w.queues.toSource)
        expect(queryFrames).toHaveLength(4)
        expect(queryFrames.map((f) => f.header.chunkIndex)).toEqual([0, 1, 2, 3])
        expect(queryFrames[0]!.payload.byteLength).toBe(32768)
        expect(queryFrames[0]!.header).toEqual({
            messageId: t.delivered.source[0]!.messageId,
            chunkIndex: 0,
            chunkCount: 4,
        })

        const query = t.delivered.source[0]!
        t.srcExchange.consumed(query.messageId)
        await flush()
        expect(t.destinationDelivery.outbox.depth).toBe(0) // the e2e ACK evicted the query
        const { messageId: responseId } = t.srcExchange.respond(correlationId, { n: 1 })
        await flush()
        expect(t.delivered.destination).toHaveLength(1)
        expect(t.delivered.destination[0]!.budget).toMatchObject({ roundsUsed: 1, roundsMax: 10 })
        expect(t.sourceDelivery.outbox.depth).toBe(1)
        t.dstExchange.consumed(responseId)
        await flush()
        expect(t.sourceDelivery.outbox.depth).toBe(0)
        expect(t.events.source.some((e) => e.type === 'acked')).toBe(true)
        t.sourceDelivery.stop()
        t.destinationDelivery.stop()
    })

    it('re-ACKs a duplicate frame only once the RC has it, and NACKs undecryptable ones', async () => {
        const t = setup()
        t.dstExchange.request({ q: 1 })
        await flush()
        const frame = dataFrames(t.w.queues.toSource)[0]!
        t.sourceDelivery.onFrame(frame) // the same bytes again, RC has not received it yet
        expect(t.events.source.filter((e) => e.type === 'duplicate')).toEqual([
            { type: 'duplicate', messageId: t.delivered.source[0]!.messageId, reacked: false },
        ])
        t.srcExchange.consumed(t.delivered.source[0]!.messageId)
        const acksBefore = t.w.queues.toDestination.filter((f) => f.type === 'ACK').length
        t.sourceDelivery.onFrame(frame)
        expect(t.w.queues.toDestination.filter((f) => f.type === 'ACK').length).toBe(acksBefore + 1)
        expect(t.delivered.source).toHaveLength(1)

        // a fresh counter (so the replay window passes) whose ciphertext was tampered with
        const tamperedId = randomUUID()
        const aad = encodeChunkHeader({
            messageId: tamperedId,
            chunkIndex: 0,
            chunkCount: 1,
            senderConnectionId: t.dst.connectionId,
        })
        const tampered = t.dstSession.encrypt(pad(Buffer.from('x'), PAD_BUCKETS), aad)
        tampered[tampered.byteLength - 1]! ^= 1
        t.sourceDelivery.onFrame({
            type: 'DATA',
            header: { messageId: tamperedId, chunkIndex: 0, chunkCount: 1 },
            payload: tampered,
        })
        expect(t.events.source.at(-1)).toMatchObject({ type: 'nack', messageId: tamperedId, reason: 'undecryptable' })

        // a frame from a superseded epoch fails authentication under the new keys
        const { dstSession: d2 } = sessions(t.src, t.dst, 2)
        const staleId = randomUUID()
        const staleAad = encodeChunkHeader({
            messageId: staleId,
            chunkIndex: 0,
            chunkCount: 1,
            senderConnectionId: t.dst.connectionId,
        })
        for (let i = 0; i < 16; i++) d2.encrypt(Buffer.alloc(1), staleAad) // past the counters the live session has seen
        t.sourceDelivery.onFrame({
            type: 'DATA',
            header: { messageId: staleId, chunkIndex: 0, chunkCount: 1 },
            payload: d2.encrypt(pad(Buffer.from('x'), PAD_BUCKETS), staleAad),
        })
        expect(t.events.source.at(-1)).toMatchObject({ type: 'nack', messageId: staleId, reason: 'undecryptable' })
        t.sourceDelivery.stop()
        t.destinationDelivery.stop()
    })

    it('rejects a query arriving at the destination (direction) and a CLOSE riding a DATA frame with a NACK', async () => {
        const t = setup()
        // the source misbehaves: it enqueues a query-kind message
        t.sourceDelivery.send({ kind: 'query', messageId: randomUUID(), correlationId: randomUUID(), payload: 1 })
        await flush()
        expect(t.delivered.destination).toHaveLength(0)
        expect(t.events.destination.at(-1)).toMatchObject({ type: 'nack', reason: 'direction' })
        const controlId = randomUUID()
        const aad = encodeChunkHeader({
            messageId: controlId,
            chunkIndex: 0,
            chunkCount: 1,
            senderConnectionId: t.src.connectionId,
        })
        const control = JSON.stringify({ v: 1, kind: 'control', control: 'CLOSE', code: 'STUDY_COMPLETE' })
        t.destinationDelivery.onFrame({
            type: 'DATA',
            header: { messageId: controlId, chunkIndex: 0, chunkCount: 1 },
            payload: t.srcSession.encrypt(pad(Buffer.from(control), PAD_BUCKETS), aad),
        })
        expect(t.events.destination.at(-1)).toMatchObject({ type: 'nack', messageId: controlId, reason: 'malformed' })
        t.sourceDelivery.stop()
        t.destinationDelivery.stop()
    })

    it('surfaces a full local window as BackpressureError, an oversized message as MessageTooLargeError, and retries relay BACKPRESSURE', async () => {
        const t = setup({ window: { maxMsgs: 1, maxBytes: 10_000 } })
        t.dstExchange.request({ q: 1 })
        expect(() =>
            t.destinationDelivery.send({
                kind: 'query',
                messageId: randomUUID(),
                correlationId: randomUUID(),
                payload: 2,
            }),
        ).toThrow(BackpressureError)
        const messageId = t.destinationDelivery.outbox.inOrder()[0]!.messageId
        const sentBefore = dataFrames(t.w.queues.toSource).length
        t.destinationDelivery.onFrame({ type: 'ERROR', header: { code: 'BACKPRESSURE', retryable: true, messageId } })
        expect(t.events.destination.at(-1)).toMatchObject({ type: 'backpressure', messageId })
        await new Promise((r) => setTimeout(r, 20))
        expect(dataFrames(t.w.queues.toSource).length).toBe(sentBefore + 1)
        expect(t.events.destination.filter((e) => e.type === 'sent').at(-1)).toMatchObject({ resend: true })
        t.destinationDelivery.onFrame({ type: 'ERROR', header: { code: 'QUOTA_EXCEEDED', retryable: false } })
        const t2 = setup()
        expect(() =>
            t2.destinationDelivery.send({
                kind: 'query',
                messageId: randomUUID(),
                correlationId: randomUUID(),
                payload: 'x'.repeat(2 * 1024 * 1024),
            }),
        ).toThrow(MessageTooLargeError)
        for (const d of [t.sourceDelivery, t.destinationDelivery, t2.sourceDelivery, t2.destinationDelivery]) d.stop()
    })

    it('holds sends while the peer is absent, re-offers on re-attach, and re-encrypts the outbox under a new epoch', async () => {
        const t = setup()
        t.w.setPeerAttached(false)
        t.dstExchange.request({ q: 1 })
        expect(t.destinationDelivery.outbox.depth).toBe(1)
        expect(t.w.queues.toSource).toHaveLength(0)
        t.w.setPeerAttached(true)
        t.destinationDelivery.reoffer()
        await flush()
        expect(t.delivered.source).toHaveLength(1)
        // new epoch on both sides (a re-handshake): the un-ACKed query is re-sent under the new keys
        const { srcSession: s2, dstSession: d2 } = sessions(t.src, t.dst, 2)
        t.sourceDelivery.setSession(s2, t.dst.connectionId)
        t.destinationDelivery.setSession(d2, t.src.connectionId)
        await flush()
        expect(t.destinationDelivery.epochTag).toBe(d2.epochTag)
        const sent = t.events.destination.filter((e) => e.type === 'sent')
        expect(sent).toHaveLength(2)
        expect(sent[1]).toMatchObject({ resend: true, epochTag: d2.epochTag })
        expect(t.delivered.source).toHaveLength(1) // dedup by messageId; the source re-ACKs once consumed
        expect(t.destinationDelivery.stats()).toMatchObject({ outboxDepth: 1 })
        t.sourceDelivery.stop()
        t.destinationDelivery.stop()
    })

    it('queues ACKs while disconnected and flushes them on reconnect', async () => {
        const t = setup()
        t.dstExchange.request({ q: 1 })
        await flush()
        t.w.setConnected(false)
        t.srcExchange.consumed(t.delivered.source[0]!.messageId)
        expect(t.sourceDelivery.stats().pendingAcks).toBe(1)
        t.w.setConnected(true)
        t.sourceDelivery.reoffer()
        expect(t.sourceDelivery.stats().pendingAcks).toBe(0)
        expect(t.w.queues.toDestination.filter((f) => f.type === 'ACK')).toHaveLength(1)
        t.sourceDelivery.stop()
        t.destinationDelivery.stop()
    })

    it('retransmits an unacknowledged message on the timer and ends the leg after too many sends', async () => {
        let now = 1_000_000
        const t = setup({ retransmitMs: 10, maxSends: 3, now: () => now })
        t.w.setHold(true) // frames leave but never arrive
        t.dstExchange.request({ q: 1 })
        const id = t.destinationDelivery.outbox.inOrder()[0]!.messageId
        for (let i = 0; i < 4; i++) {
            now += 1000
            await new Promise((r) => setTimeout(r, 15))
        }
        expect(t.destinationDelivery.outbox.get(id)?.sends ?? 3).toBeGreaterThanOrEqual(3)
        expect(t.fatal[0]).toMatch(new RegExp(`message ${id} unacknowledged after 3 sends`))
        t.sourceDelivery.stop()
        t.destinationDelivery.stop()
    })

    it('enforces source caps: response breach refuses the send; query breach refuses delivery', async () => {
        const caps = new CapsMeter({ maxResponsePlaintextBytesPerRound: 10, maxQueryPlaintextBytesPerRound: 100 })
        const t = setup({ caps })
        t.dstExchange.request({ q: 1 })
        await flush()
        const query = t.delivered.source[0]!
        t.srcExchange.consumed(query.messageId)
        expect(() => t.srcExchange.respond(query.correlationId, { big: 'x'.repeat(50) })).toThrow(LimitExceededError)
        expect(t.limits[0]).toMatchObject({ side: 'response', limit: 'maxResponsePlaintextBytesPerRound' })
        expect(t.limits[0]!.detail).toEqual({ cap: 'maxResponsePlaintextBytesPerRound', limit: 10, observed: 60 })
        expect(t.srcExchange.respond(query.correlationId, { ok: 1 }).replayed).toBe(false) // round still answerable
        await flush()
        t.dstExchange.consumed(t.delivered.destination[0]!.messageId)

        const t2 = setup({ caps: new CapsMeter({ maxQueryPlaintextBytesPerRound: 10 }) })
        t2.dstExchange.request({ big: 'x'.repeat(50) })
        await flush()
        expect(t2.delivered.source).toHaveLength(0)
        expect(t2.limits[0]).toMatchObject({ side: 'query', limit: 'maxQueryPlaintextBytesPerRound' })
        expect(t2.events.source.at(-1)).toMatchObject({ type: 'limit_exceeded', side: 'query' })
        for (const d of [t.sourceDelivery, t.destinationDelivery, t2.sourceDelivery, t2.destinationDelivery]) d.stop()
    })

    it('seals and verifies an authenticated CLOSE carrying the terminal code and cap detail', () => {
        const t = setup({ caps: new CapsMeter({ maxRounds: 1 }) })
        const sealed = t.sourceDelivery.sealClose('LIMIT_EXCEEDED', 'query:maxRounds', {
            cap: 'maxRounds',
            limit: 1,
            observed: 2,
        })!
        const opened = t.destinationDelivery.openClose(sealed)!
        expect(opened).toMatchObject({
            code: 'LIMIT_EXCEEDED',
            reason: 'query:maxRounds',
            limit: { cap: 'maxRounds', limit: 1, observed: 2 },
        })
        expect(opened.messageId).toMatch(/^[0-9a-f-]{36}$/)
        expect(t.destinationDelivery.openClose(Buffer.alloc(10))).toBeUndefined()
        const forged = Buffer.from(sealed)
        forged[forged.byteLength - 1]! ^= 1
        expect(t.destinationDelivery.openClose(forged)).toBeUndefined()
        expect(t.sourceDelivery.openClose(sealed)).toBeUndefined() // sealed by us, not by the peer
        t.sourceDelivery.stop()
        t.destinationDelivery.stop()
        const idle = setup()
        idle.destinationDelivery.setSession(undefined)
        expect(idle.destinationDelivery.sealClose('STUDY_COMPLETE')).toBeUndefined()
        idle.sourceDelivery.stop()
        idle.destinationDelivery.stop()
    })

    it('NACKs malformed plaintext and handles a peer NACK by re-offering', async () => {
        const t = setup()
        const messageId = randomUUID()
        const aad = encodeChunkHeader({
            messageId,
            chunkIndex: 0,
            chunkCount: 1,
            senderConnectionId: t.dst.connectionId,
        })
        t.sourceDelivery.onFrame({
            type: 'DATA',
            header: { messageId, chunkIndex: 0, chunkCount: 1 },
            payload: t.dstSession.encrypt(pad(Buffer.from('not json'), PAD_BUCKETS), aad),
        })
        expect(t.events.source.at(-1)).toMatchObject({ type: 'nack', messageId, reason: 'malformed' })
        t.dstExchange.request({ q: 1 })
        await flush()
        const sent = t.destinationDelivery.outbox.inOrder()[0]!
        t.destinationDelivery.onFrame({ type: 'NACK', header: { messageId: sent.messageId, reason: 'undecryptable' } })
        expect(t.events.destination.at(-1)).toMatchObject({ type: 'peer_nack', messageId: sent.messageId })
        await new Promise((r) => setTimeout(r, 20))
        expect(t.destinationDelivery.outbox.get(sent.messageId)?.sends).toBe(2)
        t.sourceDelivery.stop()
        t.destinationDelivery.stop()
    })
})
