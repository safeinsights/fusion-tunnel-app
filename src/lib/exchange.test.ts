import { describe, it, expect, vi } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { Exchange, InFlightConflictError, UnknownCorrelationError, DirectionError, nullTransport } from './exchange'
import type { DeliveredMessage } from '@/schemas/local-api'
import { RecordingTransport } from '@/testing/fixtures'

const now = () => new Date('2026-09-18T12:00:00Z')

const destination = () => {
    const transport = new RecordingTransport()
    const delivered: DeliveredMessage[] = []
    const exchange = new Exchange('destination', { transport, onDelivered: (m) => delivered.push(m), now })
    return { transport, delivered, exchange }
}

const source = () => {
    const transport = new RecordingTransport()
    const delivered: DeliveredMessage[] = []
    const exchange = new Exchange('source', { transport, onDelivered: (m) => delivered.push(m), now })
    return { transport, delivered, exchange }
}

describe('Exchange (destination)', () => {
    it('sends a query, mints a correlationId, and enforces a single in-flight round', () => {
        const { transport, exchange } = destination()
        const first = exchange.request({ q: 1 })
        expect(first.reissued).toBe(false)
        expect(transport.sent).toHaveLength(1)
        expect(transport.sent[0]).toMatchObject({
            kind: 'query',
            correlationId: first.correlationId,
            payload: { q: 1 },
        })
        expect(exchange.hasOutstanding()).toBe(true)
        expect(exchange.outstandingCorrelationId()).toBe(first.correlationId)
        expect(exchange.correlationStatus(first.correlationId)).toBe('in_flight')

        expect(() => exchange.request({ q: 2 })).toThrow(InFlightConflictError)
        expect(() => exchange.request({ q: 2 }, uuidv4())).toThrow(InFlightConflictError)
        expect(transport.sent).toHaveLength(1)
    })

    it('treats a re-issue of the in-flight correlationId as idempotent (no second send)', () => {
        const { transport, exchange } = destination()
        const { correlationId } = exchange.request({ q: 1 })
        expect(exchange.request({ q: 1 }, correlationId)).toEqual({ correlationId, reissued: true })
        expect(transport.sent).toHaveLength(1)
    })

    it('starts a fresh round under a client-supplied correlationId it does not know (post-restart re-issue)', () => {
        const { transport, exchange } = destination()
        const cid = uuidv4()
        expect(exchange.request({ q: 1 }, cid)).toEqual({ correlationId: cid, reissued: false })
        expect(transport.sent[0].correlationId).toBe(cid)
    })

    it('delivers the correlated response, frees the in-flight slot, and hands it to the RC until acked', () => {
        const { transport, delivered, exchange } = destination()
        const { correlationId } = exchange.request({ q: 1 })
        const messageId = uuidv4()
        expect(
            exchange.deliver({
                kind: 'response',
                messageId,
                correlationId,
                payload: { a: 1 },
                budget: { roundsUsed: 1, responseBytesUsed: 5, queryBytesUsed: 5 },
            }),
        ).toBe('delivered')
        expect(exchange.hasOutstanding()).toBe(false)
        expect(exchange.correlationStatus(correlationId)).toBe('delivered')
        const response = exchange.responseFor(correlationId)!
        expect(response).toMatchObject({
            messageId,
            correlationId,
            payload: { a: 1 },
            receivedAt: '2026-09-18T12:00:00.000Z',
        })
        expect(response.budget?.roundsUsed).toBe(1)
        expect(delivered).toEqual([response])

        // a re-issue while the response waits is idempotent too
        expect(exchange.request({ q: 1 }, correlationId)).toEqual({ correlationId, reissued: true })
        expect(transport.sent).toHaveLength(1)

        expect(exchange.ack(messageId)).toBe('acked')
        expect(transport.acks).toEqual([messageId])
        expect(exchange.responseFor(correlationId)).toBeUndefined()
        expect(exchange.correlationStatus(correlationId)).toBe('consumed')
        expect(exchange.ack(messageId)).toBe('acked')
        expect(transport.acks).toHaveLength(1)
        expect(exchange.ack(uuidv4())).toBe('unknown')
        expect(exchange.stats()).toEqual({ pendingAcks: 0, queuedQueries: 0, inFlight: false, roundsCompleted: 1 })
    })

    it('suppresses duplicate messageIds and rejects queries', () => {
        const { exchange } = destination()
        const { correlationId } = exchange.request({ q: 1 })
        const messageId = uuidv4()
        exchange.deliver({ kind: 'response', messageId, correlationId, payload: 1 })
        expect(exchange.deliver({ kind: 'response', messageId, correlationId, payload: 1 })).toBe('duplicate')
        expect(exchange.deliver({ kind: 'query', messageId: uuidv4(), correlationId: uuidv4(), payload: 1 })).toBe(
            'rejected',
        )
    })

    it('auto-acks a second response for a round already delivered or consumed (stale replay)', () => {
        const { transport, exchange } = destination()
        const { correlationId } = exchange.request({ q: 1 })
        const first = uuidv4()
        exchange.deliver({ kind: 'response', messageId: first, correlationId, payload: 1 })
        const replayWhileDelivered = uuidv4()
        expect(exchange.deliver({ kind: 'response', messageId: replayWhileDelivered, correlationId, payload: 1 })).toBe(
            'stale',
        )
        expect(transport.acks).toEqual([replayWhileDelivered])
        exchange.ack(first)
        const replayAfterConsumed = uuidv4()
        expect(exchange.deliver({ kind: 'response', messageId: replayAfterConsumed, correlationId, payload: 1 })).toBe(
            'stale',
        )
        expect(transport.acks).toEqual([replayWhileDelivered, first, replayAfterConsumed])
    })

    it('stores a response for a correlationId that is not the outstanding one without clearing the slot', () => {
        const { exchange } = destination()
        const { correlationId } = exchange.request({ q: 1 })
        const other = uuidv4()
        expect(exchange.deliver({ kind: 'response', messageId: uuidv4(), correlationId: other, payload: 1 })).toBe(
            'delivered',
        )
        expect(exchange.hasOutstanding()).toBe(true)
        expect(exchange.outstandingCorrelationId()).toBe(correlationId)
        expect(exchange.responseFor(other)).toBeDefined()
    })

    it('refuses source operations', () => {
        const { exchange } = destination()
        expect(() => exchange.nextQuery()).toThrow(DirectionError)
        expect(() => exchange.respond(uuidv4(), 1)).toThrow(DirectionError)
    })
})

describe('Exchange (source)', () => {
    it('queues delivered queries FIFO, redelivers until acked, and forwards the ack', () => {
        const { transport, delivered, exchange } = source()
        const q1 = { kind: 'query' as const, messageId: uuidv4(), correlationId: uuidv4(), payload: { p: 1 } }
        const q2 = { kind: 'query' as const, messageId: uuidv4(), correlationId: uuidv4(), payload: { p: 2 } }
        expect(exchange.deliver(q1)).toBe('delivered')
        expect(exchange.deliver(q2)).toBe('delivered')
        expect(delivered.map((m) => m.messageId)).toEqual([q1.messageId, q2.messageId])
        expect(exchange.nextQuery()?.messageId).toBe(q1.messageId)
        expect(exchange.nextQuery()?.messageId).toBe(q1.messageId)
        expect(exchange.stats()).toEqual({ pendingAcks: 2, queuedQueries: 2, inFlight: false, roundsCompleted: 0 })
        expect(exchange.ack(q1.messageId)).toBe('acked')
        expect(transport.acks).toEqual([q1.messageId])
        expect(exchange.nextQuery()?.messageId).toBe(q2.messageId)
        exchange.ack(q2.messageId)
        expect(exchange.nextQuery()).toBeUndefined()
    })

    it('sends a response only for a delivered query and is idempotent per query', () => {
        const { transport, exchange } = source()
        expect(() => exchange.respond(uuidv4(), 1)).toThrow(UnknownCorrelationError)
        const q = { kind: 'query' as const, messageId: uuidv4(), correlationId: uuidv4(), payload: 1 }
        exchange.deliver(q)
        exchange.ack(q.messageId)
        const first = exchange.respond(q.correlationId, { r: 1 })
        expect(first.replayed).toBe(false)
        expect(transport.sent).toHaveLength(1)
        expect(transport.sent[0]).toMatchObject({
            kind: 'response',
            messageId: first.messageId,
            correlationId: q.correlationId,
            payload: { r: 1 },
        })
        expect(exchange.respond(q.correlationId, { r: 2 })).toEqual({ messageId: first.messageId, replayed: true })
        expect(transport.sent).toHaveLength(1)
    })

    it('replays the cached response to a re-issued query without involving the RC', () => {
        const { transport, delivered, exchange } = source()
        const q = { kind: 'query' as const, messageId: uuidv4(), correlationId: uuidv4(), payload: 1 }
        exchange.deliver(q)
        exchange.ack(q.messageId)
        const response = exchange.respond(q.correlationId, { r: 1 })
        const reissued = { ...q, messageId: uuidv4() }
        expect(exchange.deliver(reissued)).toBe('stale')
        expect(delivered).toHaveLength(1)
        expect(transport.acks).toEqual([q.messageId, reissued.messageId])
        expect(transport.sent).toHaveLength(2)
        expect(transport.sent[1]).toMatchObject({ kind: 'response', correlationId: q.correlationId, payload: { r: 1 } })
        expect(transport.sent[1].messageId).not.toBe(response.messageId)
        expect(exchange.nextQuery()).toBeUndefined()
    })

    it('acks a re-issued query still being processed without queuing it twice', () => {
        const { transport, exchange } = source()
        const q = { kind: 'query' as const, messageId: uuidv4(), correlationId: uuidv4(), payload: 1 }
        exchange.deliver(q)
        const reissued = { ...q, messageId: uuidv4() }
        expect(exchange.deliver(reissued)).toBe('stale')
        expect(transport.acks).toEqual([reissued.messageId])
        expect(transport.sent).toHaveLength(0)
        expect(exchange.stats().queuedQueries).toBe(1)
    })

    it('rejects responses and refuses destination operations', () => {
        const { exchange } = source()
        expect(exchange.deliver({ kind: 'response', messageId: uuidv4(), correlationId: uuidv4(), payload: 1 })).toBe(
            'rejected',
        )
        expect(() => exchange.request(1)).toThrow(DirectionError)
        expect(() => exchange.responseFor(uuidv4())).not.toThrow()
    })

    it('bounds its memory of ids', () => {
        const exchange = new Exchange('source', { memory: 2, now })
        const ids = [uuidv4(), uuidv4(), uuidv4()]
        for (const messageId of ids) exchange.deliver({ kind: 'query', messageId, correlationId: uuidv4(), payload: 1 })
        // the oldest id fell out of `seen`, so it is no longer recognized as a duplicate
        expect(exchange.deliver({ kind: 'query', messageId: ids[0], correlationId: uuidv4(), payload: 1 })).toBe(
            'delivered',
        )
        expect(exchange.deliver({ kind: 'query', messageId: ids[2], correlationId: uuidv4(), payload: 1 })).toBe(
            'duplicate',
        )
    })

    it('can swap its transport and defaults to the null transport', () => {
        const exchange = new Exchange('destination')
        expect(() => exchange.request(1)).not.toThrow()
        const transport = new RecordingTransport()
        exchange.setTransport(transport)
        const { correlationId } = exchange.request(1, exchange.outstandingCorrelationId())
        expect(correlationId).toBeDefined()
        const spy = vi.spyOn(nullTransport, 'send')
        nullTransport.send({ kind: 'query', messageId: uuidv4(), correlationId: uuidv4(), payload: 1 })
        expect(spy).toHaveBeenCalled()
    })
})
