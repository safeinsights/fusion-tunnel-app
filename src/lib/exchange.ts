import { v4 as uuidv4 } from 'uuid'
import type { Budget, DeliveredMessage, JsonValue, Role } from '@/schemas/local-api'

// The plaintext view of analysis rounds as the research container sees them through the local
// API: one outstanding request at a time on the destination, delivered-but-unacknowledged
// queries on the source, and stage-two ACK bookkeeping on both. Direction is enforced
// structurally here as well as in the routes (v2 §7.6). Everything below the `transport` seam
// — encryption, chunking, outbox, relay — is the reliability layer's concern.

export type MessageKind = 'query' | 'response'

export type OutboundMessage = {
    kind: MessageKind
    messageId: string
    correlationId: string
    payload: JsonValue
}

export type InboundMessage = {
    kind: MessageKind
    messageId: string
    correlationId: string
    payload: JsonValue
    budget?: Budget
}

export interface ExchangeTransport {
    /** Hand a plaintext message to the encryption/outbox layer. */
    send(message: OutboundMessage): void
    /** Forward a stage-two ACK (RC consumption) end to end. */
    ack(messageId: string): void
}

export const nullTransport: ExchangeTransport = {
    send: () => {},
    ack: () => {},
}

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

export type RequestResult = { correlationId: string; reissued: boolean }
export type RespondResult = { messageId: string; replayed: boolean }
export type DeliverResult = 'delivered' | 'duplicate' | 'stale' | 'rejected'

export type ExchangeOptions = {
    transport?: ExchangeTransport
    onDelivered?: (message: DeliveredMessage) => void
    now?: () => Date
    /** Bound on remembered message/correlation ids (plaintext ids only, never payloads). */
    memory?: number
}

type SourceRound = { queryMessageId: string; responseMessageId?: string; responsePayload?: JsonValue }

const DEFAULT_MEMORY = 4096

export class Exchange {
    private transport: ExchangeTransport
    private readonly onDelivered: (message: DeliveredMessage) => void
    private readonly now: () => Date
    private readonly memory: number

    // destination
    private outstanding: { correlationId: string; messageId: string } | null = null
    private readonly responses = new Map<string, DeliveredMessage>() // by correlationId; delivered, not yet acked
    private readonly consumedCorrelations = new Set<string>()

    // source
    private readonly inboundQueries: DeliveredMessage[] = [] // delivered, not yet acked, FIFO
    private readonly rounds = new Map<string, SourceRound>() // by correlationId

    // both
    private roundsCompleted = 0
    private readonly seen = new Set<string>() // every delivered messageId, acked or not
    private readonly pending = new Map<string, DeliveredMessage>() // delivered, not yet acked, by messageId

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
     * idempotent: nothing new is sent, the outbox and relay redelivery already cover it. A
     * correlationId unknown to this process (we restarted) starts a fresh round under that id.
     */
    request(payload: JsonValue, correlationId?: string): RequestResult {
        this.assertRole('destination', 'request')
        if (this.outstanding) {
            if (correlationId !== undefined && correlationId === this.outstanding.correlationId) {
                return { correlationId, reissued: true }
            }
            throw new InFlightConflictError(this.outstanding.correlationId)
        }
        if (correlationId !== undefined && this.responses.has(correlationId)) {
            return { correlationId, reissued: true }
        }
        const cid = correlationId ?? uuidv4()
        const messageId = uuidv4()
        // send first: a refused send (backpressure) leaves no half-recorded round behind
        this.transport.send({ kind: 'query', messageId, correlationId: cid, payload })
        this.outstanding = { correlationId: cid, messageId }
        return { correlationId: cid, reissued: false }
    }

    hasOutstanding(): boolean {
        return this.outstanding !== null
    }

    outstandingCorrelationId(): string | undefined {
        return this.outstanding?.correlationId
    }

    /** The delivered, not-yet-acked response for a round, if any. */
    responseFor(correlationId: string): DeliveredMessage | undefined {
        return this.responses.get(correlationId)
    }

    correlationStatus(correlationId: string): 'in_flight' | 'delivered' | 'consumed' | 'unknown' {
        if (this.outstanding?.correlationId === correlationId) return 'in_flight'
        if (this.responses.has(correlationId)) return 'delivered'
        if (this.consumedCorrelations.has(correlationId)) return 'consumed'
        return 'unknown'
    }

    // ---- source --------------------------------------------------------------------------

    /** Oldest delivered, not-yet-acked query — redelivered on every poll until the RC acks it. */
    nextQuery(): DeliveredMessage | undefined {
        this.assertRole('source', 'nextQuery')
        return this.inboundQueries[0]
    }

    /** Send a response correlated to a delivered query. Re-posting for the same query is idempotent. */
    respond(inReplyTo: string, payload: JsonValue): RespondResult {
        this.assertRole('source', 'respond')
        const round = this.rounds.get(inReplyTo)
        if (!round) throw new UnknownCorrelationError(inReplyTo)
        if (round.responseMessageId) return { messageId: round.responseMessageId, replayed: true }
        const messageId = uuidv4()
        // send first: a refused send (caps, backpressure) must not mark the round answered
        this.transport.send({ kind: 'response', messageId, correlationId: inReplyTo, payload })
        round.responseMessageId = messageId
        round.responsePayload = payload
        this.roundsCompleted++
        return { messageId, replayed: false }
    }

    /** The most recent query messageId for a round — what a response cites as `respondsTo`. */
    latestQueryMessageId(correlationId: string): string | undefined {
        return this.rounds.get(correlationId)?.queryMessageId
    }

    // ---- inbound from the channel --------------------------------------------------------

    /**
     * Deliver a decrypted message. Duplicates by messageId are suppressed (the reliability layer
     * re-ACKs them). A message of the wrong kind for this role is rejected outright: a source
     * never receives responses, a destination never receives queries.
     */
    deliver(message: InboundMessage): DeliverResult {
        if (this.seen.has(message.messageId)) return 'duplicate'
        const expectedKind: MessageKind = this.role === 'source' ? 'query' : 'response'
        if (message.kind !== expectedKind) return 'rejected'

        this.remember(this.seen, message.messageId)
        const delivered: DeliveredMessage = {
            messageId: message.messageId,
            correlationId: message.correlationId,
            payload: message.payload,
            budget: message.budget,
            receivedAt: this.now().toISOString(),
        }

        if (this.role === 'source') return this.deliverQuery(delivered)
        return this.deliverResponse(delivered)
    }

    private deliverQuery(query: DeliveredMessage): DeliverResult {
        const round = this.rounds.get(query.correlationId)
        if (round) {
            // The destination re-issued a round we already know (fresh messageId, same correlationId).
            // Stage two for the new query id is ours to complete; the RC never sees it twice.
            round.queryMessageId = query.messageId
            this.transport.ack(query.messageId)
            if (round.responseMessageId !== undefined && round.responsePayload !== undefined) {
                // Cached-response replay (v2 §7.3): a new frame, same correlation, no RC involvement.
                const messageId = uuidv4()
                round.responseMessageId = messageId
                this.transport.send({
                    kind: 'response',
                    messageId,
                    correlationId: query.correlationId,
                    payload: round.responsePayload,
                })
            }
            return 'stale'
        }
        this.rounds.set(query.correlationId, { queryMessageId: query.messageId })
        this.trim(this.rounds)
        this.inboundQueries.push(query)
        this.pending.set(query.messageId, query)
        this.onDelivered(query)
        return 'delivered'
    }

    private deliverResponse(response: DeliveredMessage): DeliverResult {
        const cid = response.correlationId
        if (this.responses.has(cid) || this.consumedCorrelations.has(cid)) {
            // A second response for a round the RC already has or already consumed (a replay
            // after re-issue): complete stage two ourselves so the relay can purge it.
            this.transport.ack(response.messageId)
            return 'stale'
        }
        if (this.outstanding?.correlationId === cid) this.outstanding = null
        this.responses.set(cid, response)
        this.pending.set(response.messageId, response)
        this.onDelivered(response)
        return 'delivered'
    }

    // ---- stage-two ACK -------------------------------------------------------------------

    ack(messageId: string): 'acked' | 'unknown' {
        const delivered = this.pending.get(messageId)
        if (!delivered) return this.seen.has(messageId) ? 'acked' : 'unknown'
        this.pending.delete(messageId)
        if (this.role === 'source') {
            const index = this.inboundQueries.findIndex((query) => query.messageId === messageId)
            if (index >= 0) this.inboundQueries.splice(index, 1)
        } else {
            this.responses.delete(delivered.correlationId)
            this.remember(this.consumedCorrelations, delivered.correlationId)
            this.roundsCompleted++
        }
        this.transport.ack(messageId)
        return 'acked'
    }

    /** True once the RC has acknowledged this message (stage two complete). */
    isConsumed(messageId: string): boolean {
        return this.seen.has(messageId) && !this.pending.has(messageId)
    }

    // ---- observability (content-free) ----------------------------------------------------

    /** Rounds completed from this side's view: responses consumed (destination) or sent (source). */
    stats(): { pendingAcks: number; queuedQueries: number; inFlight: boolean; roundsCompleted: number } {
        return {
            pendingAcks: this.pending.size,
            queuedQueries: this.inboundQueries.length,
            inFlight: this.outstanding !== null,
            roundsCompleted: this.roundsCompleted,
        }
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
