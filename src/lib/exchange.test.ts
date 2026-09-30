import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Exchange, InFlightConflictError, UnknownCorrelationError, DirectionError, nullTransport } from './exchange'
import type { DeliveredMessage, JsonValue } from '@/local-api'
import { RecordingTransport } from '@/testing/fixtures'

const now = () => new Date('2026-09-18T12:00:00Z')

const make = (role: 'source' | 'destination') => {
    const transport = new RecordingTransport()
    const delivered: DeliveredMessage[] = []
    const exchange = new Exchange(role, { transport, onDelivered: (m) => delivered.push(m), now })
    return { transport, delivered, exchange }
}

describe('Exchange (destination)', () => {
    it('sends a query, mints a correlationId, and enforces a single in-flight round', () => {
        const { transport, exchange } = make('destination')
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
        expect(() => exchange.request({ q: 2 }, randomUUID())).toThrow(InFlightConflictError)
        expect(transport.sent).toHaveLength(1)
    })

    it('treats a re-issue of the in-flight correlationId as idempotent while the outbox holds it', () => {
        const { transport, exchange } = make('destination')
        const { correlationId } = exchange.request({ q: 1 })
        expect(exchange.request({ q: 1 }, correlationId)).toEqual({ correlationId, reissued: true })
        expect(transport.sent).toHaveLength(1)
    })

    it('resends a re-issued round under a fresh messageId once the query left the outbox unanswered', () => {
        const { transport, exchange } = make('destination')
        const { correlationId } = exchange.request({ q: 1 })
        transport.ackedByPeer.add(transport.sent[0]!.messageId) // the source RC received it… and then died
        expect(exchange.request({ q: 1 }, correlationId)).toEqual({ correlationId, reissued: true })
        expect(transport.sent).toHaveLength(2)
        expect(transport.sent[1]).toMatchObject({ kind: 'query', correlationId, payload: { q: 1 } })
        expect(transport.sent[1]!.messageId).not.toBe(transport.sent[0]!.messageId)
        expect(exchange.hasOutstanding()).toBe(true)
    })

    it('starts a fresh round under a client-supplied correlationId it does not know (post-restart re-issue)', () => {
        const { transport, exchange } = make('destination')
        const cid = randomUUID()
        expect(exchange.request({ q: 1 }, cid)).toEqual({ correlationId: cid, reissued: false })
        expect(transport.sent[0]!.correlationId).toBe(cid)
    })

    it('delivers the correlated response, frees the slot, and acknowledges when the RC receives it', () => {
        const { transport, delivered, exchange } = make('destination')
        const { correlationId } = exchange.request({ q: 1 })
        const messageId = randomUUID()
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
        expect(exchange.isConsumed(messageId)).toBe(false)

        // a re-issue while the response waits is idempotent too
        expect(exchange.request({ q: 1 }, correlationId)).toEqual({ correlationId, reissued: true })
        expect(transport.sent).toHaveLength(1)

        expect(exchange.consumed(messageId)).toBe('acked')
        expect(transport.acks).toEqual([messageId])
        expect(exchange.isConsumed(messageId)).toBe(true)
        expect(exchange.responseFor(correlationId)).toBeUndefined()
        expect(exchange.correlationStatus(correlationId)).toBe('finished')
        expect(exchange.consumed(messageId)).toBe('acked') // idempotent: re-ack
        expect(transport.acks).toHaveLength(2)
        expect(exchange.consumed(randomUUID())).toBe('unknown')
        expect(exchange.stats()).toEqual({ unconsumed: 0, queuedQueries: 0, inFlight: false, roundsCompleted: 1 })
    })

    it('suppresses duplicate messageIds and rejects queries', () => {
        const { exchange } = make('destination')
        const { correlationId } = exchange.request({ q: 1 })
        const messageId = randomUUID()
        exchange.deliver({ kind: 'response', messageId, correlationId, payload: 1 })
        expect(exchange.deliver({ kind: 'response', messageId, correlationId, payload: 1 })).toBe('duplicate')
        expect(
            exchange.deliver({ kind: 'query', messageId: randomUUID(), correlationId: randomUUID(), payload: 1 }),
        ).toBe('rejected')
    })

    it('auto-acks a second response for a round already delivered, finished or abandoned (stale replay)', () => {
        const { transport, exchange } = make('destination')
        const { correlationId } = exchange.request({ q: 1 })
        const first = randomUUID()
        exchange.deliver({ kind: 'response', messageId: first, correlationId, payload: 1 })
        const replayWhileDelivered = randomUUID()
        expect(exchange.deliver({ kind: 'response', messageId: replayWhileDelivered, correlationId, payload: 1 })).toBe(
            'stale',
        )
        expect(transport.acks).toEqual([replayWhileDelivered])
        exchange.consumed(first)
        const replayAfterFinished = randomUUID()
        expect(exchange.deliver({ kind: 'response', messageId: replayAfterFinished, correlationId, payload: 1 })).toBe(
            'stale',
        )
        expect(transport.acks).toEqual([replayWhileDelivered, first, replayAfterFinished])

        const { correlationId: abandoned } = exchange.request({ q: 2 })
        exchange.abandon(abandoned)
        expect(exchange.hasOutstanding()).toBe(false)
        expect(exchange.correlationStatus(abandoned)).toBe('finished')
        const late = randomUUID()
        expect(exchange.deliver({ kind: 'response', messageId: late, correlationId: abandoned, payload: 1 })).toBe(
            'stale',
        )
        expect(transport.acks.at(-1)).toBe(late)
        // abandoning a round whose response already waits hands it over silently
        const { correlationId: third } = exchange.request({ q: 3 })
        const waiting = randomUUID()
        exchange.deliver({ kind: 'response', messageId: waiting, correlationId: third, payload: 1 })
        exchange.abandon(third)
        expect(transport.acks.at(-1)).toBe(waiting)
        expect(exchange.responseFor(third)).toBeUndefined()
    })

    it('stores a response for a correlationId that is not the outstanding one without clearing the slot', () => {
        const { exchange } = make('destination')
        const { correlationId } = exchange.request({ q: 1 })
        const other = randomUUID()
        expect(exchange.deliver({ kind: 'response', messageId: randomUUID(), correlationId: other, payload: 1 })).toBe(
            'delivered',
        )
        expect(exchange.hasOutstanding()).toBe(true)
        expect(exchange.outstandingCorrelationId()).toBe(correlationId)
        expect(exchange.responseFor(other)).toBeDefined()
    })

    it('refuses source operations', () => {
        const { exchange } = make('destination')
        expect(() => exchange.nextQuery()).toThrow(DirectionError)
        expect(() => exchange.respond(randomUUID(), 1)).toThrow(DirectionError)
    })
})

describe('Exchange (source)', () => {
    const query = (payload: JsonValue = 1) => ({
        kind: 'query' as const,
        messageId: randomUUID(),
        correlationId: randomUUID(),
        payload,
    })

    it('queues delivered queries FIFO, acks on hand-over, and offers a query until it is answered', () => {
        const { transport, delivered, exchange } = make('source')
        const q1 = query({ p: 1 })
        const q2 = query({ p: 2 })
        expect(exchange.deliver(q1)).toBe('delivered')
        expect(exchange.deliver(q2)).toBe('delivered')
        expect(delivered.map((m) => m.messageId)).toEqual([q1.messageId, q2.messageId])
        expect(exchange.nextQuery()?.messageId).toBe(q1.messageId)
        expect(exchange.stats()).toEqual({ unconsumed: 2, queuedQueries: 2, inFlight: false, roundsCompleted: 0 })
        expect(exchange.consumed(q1.messageId)).toBe('acked')
        expect(transport.acks).toEqual([q1.messageId])
        expect(exchange.nextQuery()?.messageId).toBe(q1.messageId) // still unanswered: a restarted RC sees it again
        exchange.respond(q1.correlationId, { r: 1 })
        expect(exchange.nextQuery()?.messageId).toBe(q2.messageId)
        exchange.consumed(q2.messageId)
        exchange.respond(q2.correlationId, { r: 2 })
        expect(exchange.nextQuery()).toBeUndefined()
        expect(exchange.stats()).toMatchObject({ unconsumed: 0, queuedQueries: 0, roundsCompleted: 2 })
    })

    it('sends a response only for a delivered query and is idempotent per query', () => {
        const { transport, exchange } = make('source')
        expect(() => exchange.respond(randomUUID(), 1)).toThrow(UnknownCorrelationError)
        const q = query()
        exchange.deliver(q)
        exchange.consumed(q.messageId)
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
        const { transport, delivered, exchange } = make('source')
        const q = query()
        exchange.deliver(q)
        exchange.consumed(q.messageId)
        const response = exchange.respond(q.correlationId, { r: 1 })
        const reissued = { ...q, messageId: randomUUID() }
        expect(exchange.deliver(reissued)).toBe('stale')
        expect(delivered).toHaveLength(1)
        expect(transport.acks).toEqual([q.messageId, reissued.messageId])
        expect(transport.sent).toHaveLength(2)
        expect(transport.sent[1]).toMatchObject({ kind: 'response', correlationId: q.correlationId, payload: { r: 1 } })
        expect(transport.sent[1]!.messageId).not.toBe(response.messageId)
        expect(exchange.nextQuery()).toBeUndefined()
    })

    it('delivers a re-issued unanswered query again under its new id, retiring the earlier copy', () => {
        const { transport, delivered, exchange } = make('source')
        const q = query()
        exchange.deliver(q)
        exchange.consumed(q.messageId) // the RC received it… and then died before responding
        const reissued = { ...q, messageId: randomUUID() }
        expect(exchange.deliver(reissued)).toBe('delivered')
        expect(delivered.map((m) => m.messageId)).toEqual([q.messageId, reissued.messageId])
        expect(exchange.nextQuery()?.messageId).toBe(reissued.messageId)
        expect(exchange.stats().queuedQueries).toBe(1)
        expect(transport.sent).toHaveLength(0)
        // an unconsumed earlier copy is retired and acked on the RC's behalf
        const q2 = query(2)
        exchange.deliver(q2)
        const q2again = { ...q2, messageId: randomUUID() }
        expect(exchange.deliver(q2again)).toBe('delivered')
        expect(transport.acks).toContain(q2.messageId)
        expect(exchange.stats().queuedQueries).toBe(2)
    })

    it('rejects responses and refuses destination operations', () => {
        const { exchange } = make('source')
        expect(
            exchange.deliver({ kind: 'response', messageId: randomUUID(), correlationId: randomUUID(), payload: 1 }),
        ).toBe('rejected')
        expect(() => exchange.request(1)).toThrow(DirectionError)
        expect(() => exchange.abandon(randomUUID())).toThrow(DirectionError)
        expect(() => exchange.responseFor(randomUUID())).not.toThrow()
    })

    it('bounds its memory of ids', () => {
        const exchange = new Exchange('source', { memory: 2, now })
        const ids = [randomUUID(), randomUUID(), randomUUID()]
        for (const messageId of ids)
            exchange.deliver({ kind: 'query', messageId, correlationId: randomUUID(), payload: 1 })
        // the oldest id fell out of `seen`, so it is no longer recognized as a duplicate
        expect(exchange.deliver({ kind: 'query', messageId: ids[0]!, correlationId: randomUUID(), payload: 1 })).toBe(
            'delivered',
        )
        expect(exchange.deliver({ kind: 'query', messageId: ids[2]!, correlationId: randomUUID(), payload: 1 })).toBe(
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
        nullTransport.send({ kind: 'query', messageId: randomUUID(), correlationId: randomUUID(), payload: 1 })
        expect(spy).toHaveBeenCalled()
        expect(nullTransport.holds('x')).toBe(false)
    })
})
