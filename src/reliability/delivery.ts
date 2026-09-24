import { randomUUID } from 'node:crypto'
import { parse as parseUuid, stringify as stringifyUuid } from 'uuid'
import type { Exchange, ExchangeTransport, OutboundMessage } from '@/lib/exchange'
import type { TerminalDetail } from '@/lib/lifecycle'
import { log } from '@/lib/logger'
import { encodeChunkHeader } from '@/lib/noise/chunk-header'
import { DecryptError, NoiseSession, ReplayError } from '@/lib/noise/session'
import type { Budget, Role, TerminalCode } from '@/local-api'
import { CapsMeter, payloadBytes, type CapLimit } from '@/reliability/caps'
import { splitMessage } from '@/reliability/chunker'
import { Inbox } from '@/reliability/inbox'
import { Outbox } from '@/reliability/outbox'
import { pad, PaddingError, unpad } from '@/reliability/padding'
import type { DataHeader, Frame, NackHeader } from '@/relay-protocol'
import {
    ChannelMessageSchema,
    CHANNEL_MESSAGE_VERSION,
    PAD_BUCKETS,
    type ChannelMessage,
    type CloseMessage,
} from '@/schemas/channel'

// Everything between the plaintext Exchange and relay frames (v2 §7.2, §7.3, §7.5, §7.6): pad →
// chunk → seal under the current epoch → DATA frames; inbound DATA → replay window → open → unpad
// → reassemble → parse → deliver with dedup. The relay stores nothing, so this layer owns
// retransmission: the outbox is re-offered whenever the peer (re)attaches or the epoch changes, and
// a retransmit timer re-sends anything unacknowledged for too long. Too many sends without an ACK,
// or an ACK that never comes, end the leg loudly. Source-side caps are metered here on plaintext,
// before padding and encryption.

export class BackpressureError extends Error {
    constructor() {
        super('in-flight window is full; retry shortly')
        this.name = 'BackpressureError'
    }
}

export class MessageTooLargeError extends Error {
    constructor(
        readonly bytes: number,
        readonly max: number,
    ) {
        super(`message plaintext is ${bytes} bytes; the limit is ${max}`)
        this.name = 'MessageTooLargeError'
    }
}

export class LimitExceededError extends Error {
    constructor(
        readonly side: 'query' | 'response',
        readonly limit: CapLimit,
        readonly used: number,
        readonly max: number,
    ) {
        super(`${side} cap ${limit} exceeded (${used} > ${max})`)
        this.name = 'LimitExceededError'
    }

    get detail(): TerminalDetail {
        return { cap: this.limit, limit: this.max, observed: this.used }
    }
}

export type FrameSender = {
    send(frame: Frame): boolean
    readonly connected: boolean
    readonly peerAttached: boolean
}

export type DeliveryEvent =
    | { type: 'sent'; messageId: string; kind: string; chunks: number; epochTag: string; resend: boolean }
    | { type: 'acked'; messageId: string }
    | { type: 'delivered'; messageId: string; kind: string }
    | { type: 'duplicate'; messageId: string; reacked: boolean }
    | { type: 'nack'; messageId: string; reason: string }
    | { type: 'peer_nack'; messageId: string; reason: string }
    | { type: 'backpressure'; messageId: string }
    | { type: 'limit_exceeded'; side: 'query' | 'response'; limit: CapLimit }

export type DeliveryOptions = {
    role: Role
    connectionId: string
    window: { maxMsgs: number; maxBytes: number }
    maxMessageBytes: number
    inbox: { maxPartialMessages: number; maxPartialBytes: number }
    backpressureRetryMs: number
    retransmitMs: number
    maxSends: number
    unackedMaxMs: number
    exchange: Exchange
    sender: FrameSender
    caps?: CapsMeter
    onLimitExceeded: (error: LimitExceededError) => void
    /** A message can never be delivered: the session cannot continue. */
    onFatal: (reason: string) => void
    onEvent?: (event: DeliveryEvent) => void
    now?: () => number
}

export type VerifiedClose = { messageId: string; code: TerminalCode; reason?: string; limit?: TerminalDetail }

export class Delivery implements ExchangeTransport {
    readonly outbox: Outbox
    readonly inbox: Inbox
    private session: NoiseSession | undefined
    private peerConnectionId: string | undefined
    private readonly pendingAcks = new Set<string>()
    private retryTimer: NodeJS.Timeout | null = null
    private readonly retransmitTimer: NodeJS.Timeout
    private readonly now: () => number
    private stopped = false

    constructor(private readonly options: DeliveryOptions) {
        this.now = options.now ?? Date.now
        this.outbox = new Outbox(options.window, this.now)
        this.inbox = new Inbox(options.inbox, this.now)
        this.retransmitTimer = setInterval(() => this.retransmit(), options.retransmitMs)
        this.retransmitTimer.unref()
    }

    // ---- session lifecycle ---------------------------------------------------------------

    /** A new epoch is up: everything un-ACKed is re-encrypted under it and re-sent (v2 §7.3). */
    setSession(session: NoiseSession | undefined, peerConnectionId?: string): void {
        this.session = session
        this.peerConnectionId = peerConnectionId
        this.inbox.clear()
        this.outbox.invalidateSent()
        if (session) this.flush()
    }

    /** The relay re-admitted us, or the peer came back: re-offer everything un-ACKed and any pending ACKs. */
    reoffer(): void {
        this.outbox.invalidateSent()
        this.flush()
    }

    get epochTag(): string | undefined {
        return this.session?.epochTag
    }

    stop(): void {
        this.stopped = true
        clearInterval(this.retransmitTimer)
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = null
    }

    // ---- ExchangeTransport (plaintext in) ------------------------------------------------

    send(message: OutboundMessage): void {
        let channelMessage: ChannelMessage
        if (message.kind === 'query') {
            channelMessage = {
                v: CHANNEL_MESSAGE_VERSION,
                kind: 'query',
                correlationId: message.correlationId,
                payload: message.payload,
            }
        } else {
            let budget: Budget | undefined
            if (this.options.caps) {
                // Metered on plaintext, before padding and encryption (security review §7.3).
                const bytes = payloadBytes(message.payload)
                const verdict = this.options.caps.checkResponse(bytes)
                if (!verdict.ok) {
                    const error = new LimitExceededError('response', verdict.limit, verdict.used, verdict.max)
                    this.emit({ type: 'limit_exceeded', side: 'response', limit: verdict.limit })
                    this.options.onLimitExceeded(error)
                    throw error
                }
                this.options.caps.recordResponse(bytes)
                budget = this.options.caps.budget()
            }
            channelMessage = {
                v: CHANNEL_MESSAGE_VERSION,
                kind: 'response',
                correlationId: message.correlationId,
                payload: message.payload,
                ...(budget ? { budget } : {}),
            }
        }
        const plaintext = Buffer.from(JSON.stringify(channelMessage), 'utf8')
        if (plaintext.byteLength > this.options.maxMessageBytes) {
            throw new MessageTooLargeError(plaintext.byteLength, this.options.maxMessageBytes)
        }
        if (
            !this.outbox.add({
                messageId: message.messageId,
                kind: message.kind,
                correlationId: message.correlationId,
                plaintext,
            })
        ) {
            throw new BackpressureError()
        }
        this.flush()
    }

    ack(messageId: string): void {
        if (!this.options.sender.send({ type: 'ACK', header: { messageId } })) this.pendingAcks.add(messageId)
    }

    holds(messageId: string): boolean {
        return this.outbox.has(messageId)
    }

    // ---- authenticated CLOSE (v2 §7.6) --------------------------------------------------

    /**
     * The CLOSE frame's payload: `messageId(16) ‖ transport frame` carrying a control CLOSE with the
     * terminal code, sealed under the current epoch, so the peer can trust how the study ended.
     * Undefined when no channel is established (the relay still purges; the peer then ends ERRORED).
     */
    sealClose(code: TerminalCode, reason?: string, limit?: TerminalDetail): Buffer | undefined {
        const session = this.session
        if (!session?.complete) return undefined
        const messageId = randomUUID()
        const message: CloseMessage = {
            v: CHANNEL_MESSAGE_VERSION,
            kind: 'control',
            control: 'CLOSE',
            code,
            ...(reason ? { reason: reason.slice(0, 256) } : {}),
            ...(this.options.caps ? { budget: this.options.caps.budget() } : {}),
            ...(limit ? { limit } : {}),
        }
        const aad = encodeChunkHeader({
            messageId,
            chunkIndex: 0,
            chunkCount: 1,
            senderConnectionId: this.options.connectionId,
        })
        const frame = session.encrypt(pad(Buffer.from(JSON.stringify(message), 'utf8'), PAD_BUCKETS), aad)
        return Buffer.concat([Buffer.from(parseUuid(messageId)), frame])
    }

    /** Verify a peer's CLOSE payload; undefined when it cannot be authenticated (logged, not trusted). */
    openClose(payload: Buffer): VerifiedClose | undefined {
        const session = this.session
        if (!session?.complete || !this.peerConnectionId || payload.byteLength < 16) return undefined
        let messageId: string
        try {
            messageId = stringifyUuid(payload.subarray(0, 16))
        } catch {
            return undefined
        }
        const aad = encodeChunkHeader({
            messageId,
            chunkIndex: 0,
            chunkCount: 1,
            senderConnectionId: this.peerConnectionId,
        })
        try {
            const plaintext = unpad(session.decrypt(payload.subarray(16), aad))
            const parsed = ChannelMessageSchema.safeParse(JSON.parse(plaintext.toString('utf8')))
            if (!parsed.success || parsed.data.kind !== 'control') return undefined
            const { code, reason, limit } = parsed.data
            return { messageId, code, ...(reason ? { reason } : {}), ...(limit ? { limit } : {}) }
        } catch {
            return undefined
        }
    }

    // ---- outbound frames -----------------------------------------------------------------

    /** Seal and send every outbox entry not yet sent under the current epoch, in FIFO order — only when the peer can hear us. */
    flush(): void {
        const session = this.session
        const { sender } = this.options
        if (!session?.complete || !sender.connected || !sender.peerAttached) return
        const epochTag = session.epochTag!
        for (const messageId of this.pendingAcks) {
            if (!sender.send({ type: 'ACK', header: { messageId } })) return
            this.pendingAcks.delete(messageId)
        }
        for (const entry of this.outbox.pendingFor(epochTag)) {
            const chunks = splitMessage(entry.plaintext, PAD_BUCKETS)
            for (const [chunkIndex, chunk] of chunks.entries()) {
                const aad = encodeChunkHeader({
                    messageId: entry.messageId,
                    chunkIndex,
                    chunkCount: chunks.length,
                    senderConnectionId: this.options.connectionId,
                })
                const frame: Frame = {
                    type: 'DATA',
                    header: { messageId: entry.messageId, chunkIndex, chunkCount: chunks.length },
                    payload: session.encrypt(pad(chunk, PAD_BUCKETS), aad),
                }
                if (!sender.send(frame)) return
            }
            const resend = entry.sends > 0
            this.outbox.markSent(entry.messageId, epochTag)
            this.emit({
                type: 'sent',
                messageId: entry.messageId,
                kind: entry.kind,
                chunks: chunks.length,
                epochTag,
                resend,
            })
            log.info('channel.message_sent', {
                messageId: entry.messageId,
                kind: entry.kind,
                correlationId: entry.correlationId,
                chunks: chunks.length,
                epochTag,
                resend,
            })
        }
    }

    /** Timer tick: re-offer what has waited too long for its ACK; give up loudly past the bounds. */
    private retransmit(): void {
        const epochTag = this.session?.epochTag
        if (this.stopped || !epochTag) return
        const now = this.now()
        for (const entry of this.outbox.staleSince(epochTag, now - this.options.retransmitMs)) {
            if (entry.sends >= this.options.maxSends || now - entry.createdAt > this.options.unackedMaxMs) {
                log.error('channel.message_unacknowledged', {
                    messageId: entry.messageId,
                    sends: entry.sends,
                    ageMs: now - entry.createdAt,
                })
                this.options.onFatal(`message ${entry.messageId} unacknowledged after ${entry.sends} sends`)
                return
            }
            this.outbox.resetSent(entry.messageId)
        }
        this.flush()
    }

    // ---- inbound frames ------------------------------------------------------------------

    onFrame(frame: Frame): void {
        switch (frame.type) {
            case 'DATA':
                return this.onData(frame.header, frame.payload)
            case 'ACK':
                if (this.outbox.remove(frame.header.messageId)) {
                    this.emit({ type: 'acked', messageId: frame.header.messageId })
                    log.info('channel.message_acked', { messageId: frame.header.messageId })
                }
                return
            case 'NACK':
                return this.onPeerNack(frame.header)
            case 'ERROR':
                if (
                    (frame.header.code === 'BACKPRESSURE' || frame.header.code === 'RATE_LIMITED') &&
                    frame.header.messageId
                ) {
                    this.outbox.resetSent(frame.header.messageId)
                    this.emit({ type: 'backpressure', messageId: frame.header.messageId })
                    log.warn('channel.backpressure', { code: frame.header.code, messageId: frame.header.messageId })
                    this.scheduleRetry()
                } else {
                    log.warn('channel.relay_error', { code: frame.header.code, retryable: frame.header.retryable })
                }
                return
            default:
                return
        }
    }

    private onPeerNack(header: NackHeader): void {
        // The peer could not decrypt our frame. Across an epoch change the re-send under the new
        // epoch already covers it; within an epoch, re-offer it a few times, then let the retransmit
        // bound end the leg.
        this.emit({ type: 'peer_nack', messageId: header.messageId, reason: header.reason })
        log.warn('channel.peer_nack', { messageId: header.messageId, reason: header.reason })
        const entry = this.outbox.get(header.messageId)
        if (entry && entry.sends < 3) {
            this.outbox.resetSent(header.messageId)
            this.scheduleRetry()
        }
    }

    private onData(header: DataHeader, payload: Buffer): void {
        const session = this.session
        if (!session?.complete || !this.peerConnectionId) return this.nack(header.messageId, 'stale_epoch')
        const aad = encodeChunkHeader({
            messageId: header.messageId,
            chunkIndex: header.chunkIndex,
            chunkCount: header.chunkCount,
            senderConnectionId: this.peerConnectionId,
        })
        let padded: Buffer
        try {
            padded = session.decrypt(payload, aad)
        } catch (error) {
            if (error instanceof ReplayError) return this.onDuplicateFrame(header.messageId)
            if (error instanceof DecryptError) return this.nack(header.messageId, 'undecryptable')
            throw error
        }
        let data: Buffer
        try {
            data = unpad(padded)
        } catch (error) {
            if (error instanceof PaddingError) return this.nack(header.messageId, 'malformed')
            throw error
        }
        const result = this.inbox.accept(header.messageId, header.chunkIndex, header.chunkCount, data)
        switch (result.status) {
            case 'partial':
            case 'duplicate_chunk':
                return
            case 'inconsistent':
            case 'overflow':
                return this.nack(header.messageId, 'malformed')
            case 'complete':
                return this.onMessage(header.messageId, result.plaintext)
        }
    }

    /** A byte-identical redelivery: re-ACK if the RC already has it, otherwise let it ride. */
    private onDuplicateFrame(messageId: string): void {
        const reacked = this.options.exchange.isConsumed(messageId)
        if (reacked) this.ack(messageId)
        this.emit({ type: 'duplicate', messageId, reacked })
    }

    private onMessage(messageId: string, plaintext: Buffer): void {
        let parsed: ChannelMessage
        try {
            const result = ChannelMessageSchema.safeParse(JSON.parse(plaintext.toString('utf8')))
            if (!result.success) return this.nack(messageId, 'malformed')
            parsed = result.data
        } catch {
            return this.nack(messageId, 'malformed')
        }
        // CLOSE rides its own frame, never a DATA message.
        if (parsed.kind === 'control') return this.nack(messageId, 'malformed')

        if (parsed.kind === 'query' && this.options.caps) {
            // Query-side caps (hub memo §2.3): metered on the decrypted plaintext before delivery.
            const bytes = payloadBytes(parsed.payload)
            const verdict = this.options.caps.checkQuery(bytes)
            if (!verdict.ok) {
                const error = new LimitExceededError('query', verdict.limit, verdict.used, verdict.max)
                this.emit({ type: 'limit_exceeded', side: 'query', limit: verdict.limit })
                this.options.onLimitExceeded(error)
                return
            }
        }
        const outcome = this.options.exchange.deliver({
            kind: parsed.kind,
            messageId,
            correlationId: parsed.correlationId,
            payload: parsed.payload,
            ...(parsed.kind === 'response' && parsed.budget ? { budget: parsed.budget } : {}),
        })
        switch (outcome) {
            case 'delivered':
                if (parsed.kind === 'query' && this.options.caps)
                    this.options.caps.recordQuery(payloadBytes(parsed.payload))
                this.emit({ type: 'delivered', messageId, kind: parsed.kind })
                log.info('channel.message_delivered', {
                    messageId,
                    kind: parsed.kind,
                    correlationId: parsed.correlationId,
                })
                return
            case 'duplicate':
                return this.onDuplicateFrame(messageId)
            case 'stale':
                return
            case 'rejected':
                // Structural direction enforcement at the transport level (v2 §7.6).
                log.error('channel.direction_violation', { messageId, kind: parsed.kind })
                return this.nack(messageId, 'direction')
        }
    }

    private nack(messageId: string, reason: string): void {
        this.emit({ type: 'nack', messageId, reason })
        log.warn('channel.nack_discard', { messageId, reason })
        this.options.sender.send({ type: 'NACK', header: { messageId, reason } })
    }

    private scheduleRetry(): void {
        if (this.retryTimer || this.stopped) return
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            this.flush()
        }, this.options.backpressureRetryMs)
        this.retryTimer.unref()
    }

    private emit(event: DeliveryEvent): void {
        this.options.onEvent?.(event)
    }

    stats(): { outboxDepth: number; pendingAcks: number } {
        return { outboxDepth: this.outbox.depth, pendingAcks: this.pendingAcks.size }
    }
}
