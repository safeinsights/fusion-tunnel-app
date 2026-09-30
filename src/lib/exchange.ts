import { randomUUID } from 'node:crypto'
import type { Budget, DeliveredMessage, JsonValue, Role } from '@/local-api'

// The plaintext view of analysis rounds as the research container sees them through the local
// API: one outstanding request at a time on the destination, unanswered queries on the source, and
// the end-to-end acknowledgement that fires when a message is handed to the RC. Direction is
// enforced structurally here as well as in the routes (v2 §7.6). Everything below the `transport`
// seam — encryption, chunking, outbox, relay — is the reliability layer's concern.

export type MessageKind = 'query' | 'response'

export type OutboundMessage = { kind: MessageKind; messageId: string; correlationId: string; payload: JsonValue }

export type InboundMessage = OutboundMessage & { budget?: Budget }

export interface ExchangeTransport {
    /** Hand a plaintext message to the encryption/outbox layer. */
    send(message: OutboundMessage): void
    /** The RC has this message: acknowledge it end to end so the sender's outbox can let go. */
    ack(messageId: string): void
    /** True while the outbox still holds this sent message (not yet acknowledged end to end). */
    holds(messageId: string): boolean
}

export const nullTransport: ExchangeTransport = { send: () => {}, ack: () => {}, holds: () => false }

export class InFlightConflictError extends Error {
    constructor(readonly correlationId: string) {
        super('a request is already in flight')
        this.name = 'InFlightConflictError'
    }
}

export class UnknownCorrelationError extends Error {
    constructor(readonly correlationId: string) {
        super('inReplyTo does not match a delivered query')
        this.name = 'UnknownCorrelationError'
    }
}

export class DirectionError extends Error {
    constructor(role: Role, operation: string) {
        super(`${operation} is not permitted for role ${role}`)
        this.name = 'DirectionError'
    }
}

export type DeliverResult = 'delivered' | 'duplicate' | 'stale' | 'rejected'

export type ExchangeOptions = {
    transport?: ExchangeTransport
    onDelivered?: (message: DeliveredMessage) => void
    now?: () => Date
    /** Bound on remembered message/correlation ids (plaintext ids only, never payloads). */
    memory?: number
}

type SourceRound = { responseMessageId?: string; responsePayload?: JsonValue }

const DEFAULT_MEMORY = 4096

export class Exchange {
    private transport: ExchangeTransport
    private readonly onDelivered: (message: DeliveredMessage) => void
    private readonly now: () => Date
    private readonly memory: number

    // destination
    private outstanding: { correlationId: string; messageId: string } | null = null
    private readonly responses = new Map<string, DeliveredMessage>() // by correlationId; delivered, not yet handed over
    private readonly finishedCorrelations = new Set<string>() // consumed or abandoned

    // source
    private readonly inboundQueries: DeliveredMessage[] = [] // unanswered, FIFO
    private readonly rounds = new Map<string, SourceRound>() // by correlationId

    // both
    private roundsCompleted = 0
    private readonly seen = new Set<string>() // every delivered messageId
    private readonly unconsumed = new Set<string>() // delivered, not yet handed to the RC

    constructor(
        readonly role: Role,
        options: ExchangeOptions = {},
    ) {
        this.transport = options.transport ?? nullTransport
        this.onDelivered = options.onDelivered ?? (() => {})
        this.now = options.now ?? (() => new Date())
        this.memory = options.memory ?? DEFAULT_MEMORY
    }

    setTransport(transport: ExchangeTransport): void {
        this.transport = transport
    }

    // ---- destination ---------------------------------------------------------------------

    /**
     * Submit a query. A re-issue carrying the in-flight correlationId (v2 §7.3, SDK ask T1) is
     * idempotent while the outbox still holds the query; once the source consumed it without
     * answering, the query is resent under a fresh messageId. A correlationId unknown to this
     * process (we restarted) starts a fresh round under that id.
     */
    request(payload: JsonValue, correlationId?: string): { correlationId: string; reissued: boolean } {
        this.assertRole('destination', 'request')
        if (this.outstanding) {
            if (correlationId !== undefined && correlationId === this.outstanding.correlationId) {
                if (this.transport.holds(this.outstanding.messageId)) return { correlationId, reissued: true }
                const messageId = randomUUID()
                this.transport.send({ kind: 'query', messageId, correlationId, payload })
                this.outstanding = { correlationId, messageId }
                return { correlationId, reissued: true }
            }
            throw new InFlightConflictError(this.outstanding.correlationId)
        }
        if (correlationId !== undefined && this.responses.has(correlationId)) return { correlationId, reissued: true }
        const cid = correlationId ?? randomUUID()
        const messageId = randomUUID()
        // send first: a refused send (backpressure) leaves no half-recorded round behind
        this.transport.send({ kind: 'query', messageId, correlationId: cid, payload })
        this.outstanding = { correlationId: cid, messageId }
        return { correlationId: cid, reissued: false }
    }

    /** The SDK gave up on a round (T7): free the slot; a late response is acknowledged and dropped. */
    abandon(correlationId: string): void {
        this.assertRole('destination', 'abandon')
        if (this.outstanding?.correlationId === correlationId) this.outstanding = null
        const waiting = this.responses.get(correlationId)
        if (waiting) this.consumed(waiting.messageId)
        this.remember(this.finishedCorrelations, correlationId)
    }

    hasOutstanding(): boolean {
        return this.outstanding !== null
    }

    outstandingCorrelationId(): string | undefined {
        return this.outstanding?.correlationId
    }

    /** The delivered, not-yet-handed-over response for a round, if any. */
    responseFor(correlationId: string): DeliveredMessage | undefined {
        return this.responses.get(correlationId)
    }

    correlationStatus(correlationId: string): 'in_flight' | 'delivered' | 'finished' | 'unknown' {
        if (this.outstanding?.correlationId === correlationId) return 'in_flight'
        if (this.responses.has(correlationId)) return 'delivered'
        if (this.finishedCorrelations.has(correlationId)) return 'finished'
        return 'unknown'
    }

    // ---- source --------------------------------------------------------------------------

    /** Oldest unanswered query — offered on every poll until the RC answers it (a restarted RC sees it again). */
    nextQuery(): DeliveredMessage | undefined {
        this.assertRole('source', 'nextQuery')
        return this.inboundQueries[0]
    }

    /** Send a response correlated to a delivered query. Re-posting for the same query is idempotent. */
    respond(inReplyTo: string, payload: JsonValue): { messageId: string; replayed: boolean } {
        this.assertRole('source', 'respond')
        const round = this.rounds.get(inReplyTo)
        if (!round) throw new UnknownCorrelationError(inReplyTo)
        if (round.responseMessageId) return { messageId: round.responseMessageId, replayed: true }
        const messageId = randomUUID()
        // send first: a refused send (caps, backpressure) must not mark the round answered
        this.transport.send({ kind: 'response', messageId, correlationId: inReplyTo, payload })
        round.responseMessageId = messageId
        round.responsePayload = payload
        this.retireQuery(inReplyTo)
        this.roundsCompleted++
        return { messageId, replayed: false }
    }

    // ---- inbound from the channel --------------------------------------------------------

    /**
     * Deliver a decrypted message. Duplicates by messageId are suppressed (the reliability layer
     * re-ACKs them once consumed). A message of the wrong kind for this role is rejected outright:
     * a source never receives responses, a destination never receives queries.
     */
    deliver(message: InboundMessage): DeliverResult {
        if (this.seen.has(message.messageId)) return 'duplicate'
        if (message.kind !== (this.role === 'source' ? 'query' : 'response')) return 'rejected'
        this.remember(this.seen, message.messageId)
        const delivered: DeliveredMessage = {
            messageId: message.messageId,
            correlationId: message.correlationId,
            payload: message.payload,
            budget: message.budget,
            receivedAt: this.now().toISOString(),
        }
        return this.role === 'source' ? this.deliverQuery(delivered) : this.deliverResponse(delivered)
    }

    private deliverQuery(query: DeliveredMessage): DeliverResult {
        const round = this.rounds.get(query.correlationId)
        if (round?.responseMessageId !== undefined && round.responsePayload !== undefined) {
            // A re-issued round we already answered: acknowledge the new copy and replay the cached
            // response as a new message (v2 §7.3) — the RC never runs the operation twice.
            this.transport.ack(query.messageId)
            const messageId = randomUUID()
            round.responseMessageId = messageId
            this.transport.send({
                kind: 'response',
                messageId,
                correlationId: query.correlationId,
                payload: round.responsePayload,
            })
            return 'stale'
        }
        if (round) {
            // Unanswered re-issue (the RC may have died mid-round, v2 §8 row 3): retire the earlier copy.
            const earlier = this.retireQuery(query.correlationId)
            if (earlier) this.consumed(earlier.messageId)
        } else {
            this.rounds.set(query.correlationId, {})
            this.trim(this.rounds)
        }
        this.inboundQueries.push(query)
        this.unconsumed.add(query.messageId)
        this.onDelivered(query)
        return 'delivered'
    }

    private deliverResponse(response: DeliveredMessage): DeliverResult {
        const cid = response.correlationId
        if (this.responses.has(cid) || this.finishedCorrelations.has(cid)) {
            // A second response for a round the RC already has or already finished (a replay after
            // re-issue, or an abandoned round): acknowledge it so the sender's outbox lets go.
            this.transport.ack(response.messageId)
            return 'stale'
        }
        if (this.outstanding?.correlationId === cid) this.outstanding = null
        this.responses.set(cid, response)
        this.unconsumed.add(response.messageId)
        this.onDelivered(response)
        return 'delivered'
    }

    // ---- consumption (the local API handed the message to the RC) ------------------------

    /** The RC has it: acknowledge end to end. A destination response is finished; a source query stays until answered. */
    consumed(messageId: string): 'acked' | 'unknown' {
        if (!this.seen.has(messageId)) return 'unknown'
        if (this.unconsumed.delete(messageId) && this.role === 'destination') {
            for (const [cid, response] of this.responses) {
                if (response.messageId !== messageId) continue
                this.responses.delete(cid)
                this.remember(this.finishedCorrelations, cid)
                this.roundsCompleted++
            }
        }
        this.transport.ack(messageId)
        return 'acked'
    }

    /** True once the RC has received this message. */
    isConsumed(messageId: string): boolean {
        return this.seen.has(messageId) && !this.unconsumed.has(messageId)
    }

    // ---- observability (content-free) ----------------------------------------------------

    /** Rounds completed from this side's view: responses handed over (destination) or sent (source). */
    stats(): { unconsumed: number; queuedQueries: number; inFlight: boolean; roundsCompleted: number } {
        return {
            unconsumed: this.unconsumed.size,
            queuedQueries: this.inboundQueries.length,
            inFlight: this.outstanding !== null,
            roundsCompleted: this.roundsCompleted,
        }
    }

    private retireQuery(correlationId: string): DeliveredMessage | undefined {
        const index = this.inboundQueries.findIndex((q) => q.correlationId === correlationId)
        if (index < 0) return undefined
        const [query] = this.inboundQueries.splice(index, 1)
        return query
    }

    private assertRole(role: Role, operation: string): void {
        if (this.role !== role) throw new DirectionError(this.role, operation)
    }

    private remember(set: Set<string>, id: string): void {
        set.add(id)
        if (set.size > this.memory) set.delete(set.values().next().value as string)
    }

    private trim(map: Map<string, unknown>): void {
        while (map.size > this.memory) map.delete(map.keys().next().value as string)
    }
}
