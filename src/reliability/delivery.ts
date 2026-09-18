import { v4 as uuidv4 } from 'uuid'
import { Exchange, type OutboundMessage, type ExchangeTransport } from '@/lib/exchange'
import { log } from '@/lib/logger'
import { encodeChunkHeader } from '@/lib/noise/chunk-header'
import { DecryptError, NoiseSession, ReplayError } from '@/lib/noise/session'
import { CapsMeter, payloadBytes, type CapLimit } from '@/reliability/caps'
import { declaredSizeFor, splitMessage } from '@/reliability/chunker'
import { Inbox } from '@/reliability/inbox'
import { Outbox } from '@/reliability/outbox'
import { pad, PaddingError, unpad } from '@/reliability/padding'
import { ChannelMessageSchema, CHANNEL_MESSAGE_VERSION, type ChannelMessage } from '@/schemas/channel'
import type { Budget, Role } from '@/schemas/local-api'
import type { DataHeader, Frame, NackDiscardHeader } from '@/schemas/relay-wire'

// Two-stage ACK orchestration and everything between the plaintext Exchange and relay frames
// (v2 §7.2, §7.3, §7.5, §7.6): pad → chunk → seal under the current epoch → DATA frames; inbound
// DATA → replay window → open → unpad → reassemble → parse → deliver with dedup. Retransmission
// re-encrypts from the outbox; duplicates re-ACK; undecryptable frames NACK-discard; the relay's
// BACKPRESSURE is retried from the outbox and surfaced as a retryable 429 when the local window
// is full. Source-side caps are metered here on plaintext, before padding and encryption.

export class BackpressureError extends Error {
    constructor() {
        super('in-flight window is full; retry shortly')
        this.name = 'BackpressureError'
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
}

export type FrameSender = {
    send(frame: Frame): boolean
    readonly connected: boolean
}

export type ControlKind = 'CLOSE' | 'LIMIT_EXCEEDED'

export type DeliveryEvent =
    | { type: 'sent'; messageId: string; kind: string; chunks: number; epochTag: string; resend: boolean }
    | { type: 'acked'; messageId: string }
    | { type: 'delivered'; messageId: string; kind: string }
    | { type: 'duplicate'; messageId: string; reacked: boolean }
    | { type: 'nack'; messageId: string; reason: string }
    | { type: 'backpressure'; messageId: string }
    | { type: 'peer_nack'; messageId: string; reason: string }
    | { type: 'control'; control: ControlKind; messageId: string }
    | { type: 'limit_exceeded'; side: 'query' | 'response'; limit: CapLimit }

export type DeliveryOptions = {
    role: Role
    connectionId: string
    buckets: readonly number[]
    window: { maxMsgs: number; maxBytes: number }
    inbox: { maxPartialMessages: number; maxPartialBytes: number }
    backpressureRetryMs: number
    exchange: Exchange
    sender: FrameSender
    caps?: CapsMeter
    onControl: (control: ControlKind, messageId: string, reason?: string) => void
    onLimitExceeded: (error: LimitExceededError) => void
    onEvent?: (event: DeliveryEvent) => void
    now?: () => number
}

export class Delivery implements ExchangeTransport {
    readonly outbox: Outbox
    readonly inbox: Inbox
    private session: NoiseSession | undefined
    private peerConnectionId: string | undefined
    private readonly pendingAcks = new Set<string>()
    private retryTimer: NodeJS.Timeout | null = null
    private readonly now: () => number

    constructor(private readonly options: DeliveryOptions) {
        this.now = options.now ?? Date.now
        this.outbox = new Outbox(options.window, this.now)
        this.inbox = new Inbox(options.inbox, this.now)
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

    /** The relay re-admitted us: re-offer un-ACKed sends (the relay appends idempotently) and pending ACKs. */
    onReconnected(limits?: { maxMsgs: number; maxBytes: number }): void {
        if (limits) this.outbox.setLimits(limits)
        this.outbox.invalidateSent()
        this.flush()
    }

    get epochTag(): string | undefined {
        return this.session?.epochTag
    }

    stop(): void {
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
        const respondsTo =
            message.kind === 'response' ? this.options.exchange.latestQueryMessageId(message.correlationId) : undefined
        this.enqueue(message.messageId, message.kind, channelMessage, message.correlationId, respondsTo)
    }

    /** Authenticated control message through the channel, same reliability as any message. */
    sendControl(control: ControlKind, reason?: string): string {
        const messageId = uuidv4()
        const channelMessage: ChannelMessage = {
            v: CHANNEL_MESSAGE_VERSION,
            kind: 'control',
            control,
            ...(reason ? { reason } : {}),
            ...(this.options.caps ? { budget: this.options.caps.budget() } : {}),
        }
        this.enqueue(messageId, 'control', channelMessage)
        return messageId
    }

    ack(messageId: string): void {
        if (!this.options.sender.send({ type: 'ACK', header: { messageId } })) this.pendingAcks.add(messageId)
    }

    private enqueue(
        messageId: string,
        kind: OutboundMessage['kind'] | 'control',
        channelMessage: ChannelMessage,
        correlationId?: string,
        respondsTo?: string,
    ): void {
        const plaintext = Buffer.from(JSON.stringify(channelMessage), 'utf8')
        const sizeBytes = declaredSizeFor(plaintext.byteLength, this.options.buckets)
        if (!this.outbox.add({ messageId, kind, correlationId, plaintext, sizeBytes, respondsTo })) {
            throw new BackpressureError()
        }
        this.flush()
    }

    // ---- outbound frames -----------------------------------------------------------------

    /** Seal and send every outbox entry not yet sent under the current epoch, in FIFO order. */
    flush(): void {
        const session = this.session
        if (!session?.complete || !this.options.sender.connected) return
        const epochTag = session.epochTag!
        for (const messageId of this.pendingAcks) {
            if (!this.options.sender.send({ type: 'ACK', header: { messageId } })) return
            this.pendingAcks.delete(messageId)
        }
        for (const entry of this.outbox.pendingFor(epochTag)) {
            const chunks = splitMessage(entry.plaintext, this.options.buckets)
            const frames: Frame[] = chunks.map((chunk, chunkIndex) => {
                const aad = encodeChunkHeader({
                    messageId: entry.messageId,
                    chunkIndex,
                    chunkCount: chunks.length,
                    senderConnectionId: this.options.connectionId,
                })
                return {
                    type: 'DATA',
                    header: {
                        messageId: entry.messageId,
                        chunkIndex,
                        chunkCount: chunks.length,
                        epochTag,
                        ...(entry.respondsTo ? { respondsTo: entry.respondsTo } : {}),
                        sizeBytes: entry.sizeBytes,
                    },
                    payload: session.encrypt(pad(chunk, this.options.buckets), aad),
                }
            })
            for (const frame of frames) if (!this.options.sender.send(frame)) return
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
                sizeBytes: entry.sizeBytes,
                epochTag,
                resend,
            })
        }
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
            case 'NACK_DISCARD':
                return this.onPeerNack(frame.header)
            case 'ERROR':
                if (frame.header.code === 'BACKPRESSURE' && frame.header.messageId) {
                    this.outbox.resetSent(frame.header.messageId)
                    this.emit({ type: 'backpressure', messageId: frame.header.messageId })
                    log.warn('channel.backpressure', { messageId: frame.header.messageId })
                    this.scheduleRetry()
                } else {
                    log.warn('channel.relay_error', { code: frame.header.code, retryable: frame.header.retryable })
                }
                return
            default:
                return
        }
    }

    private onPeerNack(header: NackDiscardHeader): void {
        // The peer could not decrypt our frame. Across an epoch change the relay purge plus our
        // re-send under the new epoch already cover it; within an epoch, re-offer it once.
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
        if (header.epochTag !== session.epochTag) return this.nack(header.messageId, 'stale_epoch')

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
        const result = this.inbox.accept(header.messageId, header.chunkIndex, header.chunkCount, header.epochTag, data)
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

    /** A byte-identical redelivery: re-ACK if the RC already consumed it, otherwise let it ride. */
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

        if (parsed.kind === 'control') {
            this.ack(messageId)
            this.emit({ type: 'control', control: parsed.control, messageId })
            log.info('channel.control_received', { messageId, control: parsed.control })
            this.options.onControl(parsed.control, messageId, parsed.reason)
            return
        }

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
        this.options.sender.send({ type: 'NACK_DISCARD', header: { messageId, reason } })
    }

    private scheduleRetry(): void {
        if (this.retryTimer) return
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            this.flush()
        }, this.options.backpressureRetryMs)
        this.retryTimer.unref()
    }

    private emit(event: DeliveryEvent): void {
        this.options.onEvent?.(event)
    }

    stats(): { outboxDepth: number; outboxBytes: number; inboxPartials: number; pendingAcks: number } {
        return {
            outboxDepth: this.outbox.depth,
            outboxBytes: this.outbox.bytesQueued,
            inboxPartials: this.inbox.partialCount,
            pendingAcks: this.pendingAcks.size,
        }
    }
}
