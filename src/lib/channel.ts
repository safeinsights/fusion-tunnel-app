import { EventEmitter } from 'node:events'
import type { Tuning } from '@/config'
import type { Exchange } from '@/lib/exchange'
import type { Identity } from '@/lib/identity'
import type { Lifecycle } from '@/lib/lifecycle'
import { log, errorFields } from '@/lib/logger'
import { encodePrologue, prologueInputsFor } from '@/lib/noise/prologue'
import { HandshakeFailedError, NoiseSession, PeerIdentityMismatchError } from '@/lib/noise/session'
import { RelayClient, type RelayClientOptions } from '@/lib/relay/client'
import { BlobClient } from '@/lib/relay/blob-client'
import type { CapsMeter } from '@/reliability/caps'
import { Delivery, LimitExceededError, type ControlKind, type DeliveryEvent } from '@/reliability/delivery'
import type { ConfigurationBundle } from '@/schemas/provisioning'
import type { Frame } from '@/schemas/relay-wire'

// The channel orchestrator: one relay attachment, one Noise_IK session (per epoch) and one
// Delivery, driven by the lifecycle machine. The peer's verified key arrives from the BMA client
// (or the test harness) via setPeer(); the destination initiates the handshake and retries the
// same message 1 until message 2 arrives; the source answers, and re-answers a byte-identical
// message 1 so a lost message 2 converges without a new epoch. PEER_REJOINED tears the session
// down and hands re-fetch + re-handshake back to the caller.

export type VerifiedPeer = {
    publicKey: Buffer
    connectionId: string
    generation: number
}

export interface ChannelEvents {
    attached: []
    closeAcked: []
    closed: [reason: string]
    channelUp: [epochTag: string]
    peerRejoined: [peerRole: 'source' | 'destination']
    handshakeFailed: [reason: string]
    limitExceeded: [error: LimitExceededError]
    control: [control: ControlKind, messageId: string, reason: string | undefined]
    delivery: [event: DeliveryEvent]
    relayFatal: [reason: string]
    disconnected: []
}

export type ChannelDeps = {
    bundle: ConfigurationBundle
    identity: Identity
    tuning: Tuning
    exchange: Exchange
    lifecycle: Lifecycle
    caps?: CapsMeter
    tokenProvider?: () => Promise<string> | string
    relayFactory?: (options: RelayClientOptions) => RelayClient
    /** Blob client override (tests); `null` disables the blob path so everything travels inline. */
    blobClient?: BlobClient | null
    fetch?: typeof fetch
    now?: () => number
}

export class Channel extends EventEmitter<ChannelEvents> {
    readonly relay: RelayClient
    readonly delivery: Delivery
    private session: NoiseSession | undefined
    private peer: VerifiedPeer | undefined
    private msg1: Buffer | undefined
    private cachedMsg2: { msg1: Buffer; msg2: Buffer } | undefined
    private handshakeTimer: NodeJS.Timeout | null = null
    private handshakeAttempts = 0
    private closeTimer: NodeJS.Timeout | null = null
    private closing = false
    private stopped = false

    constructor(private readonly deps: ChannelDeps) {
        super()
        const { bundle, identity, tuning } = deps
        const options: RelayClientOptions = {
            endpoint: bundle.relay.endpoint,
            relaySessionId: bundle.relay.sessionId,
            legId: bundle.legId,
            role: bundle.role,
            tokenProvider: deps.tokenProvider ?? (() => bundle.relay.token),
            signChallenge: (payload) => identity.signPop(payload),
            tuning: {
                heartbeatMs: tuning.heartbeatMs,
                heartbeatMisses: tuning.heartbeatMisses,
                reconnectMinMs: tuning.reconnectMinMs,
                reconnectMaxMs: tuning.reconnectMaxMs,
            },
        }
        this.relay = deps.relayFactory ? deps.relayFactory(options) : new RelayClient(options)
        const blobs =
            deps.blobClient === null
                ? undefined
                : (deps.blobClient ??
                  new BlobClient({
                      relayEndpoint: bundle.relay.endpoint,
                      tokenProvider: options.tokenProvider,
                      retryMs: tuning.blobRetryMs,
                      maxAttempts: tuning.blobMaxAttempts,
                      fetch: deps.fetch,
                  }))
        this.delivery = new Delivery({
            role: bundle.role,
            connectionId: identity.connectionId,
            buckets: tuning.padBuckets,
            window: { maxMsgs: tuning.inflightMaxMsgs, maxBytes: tuning.inflightMaxBytes },
            inbox: { maxPartialMessages: tuning.inflightMaxMsgs, maxPartialBytes: tuning.inboxMaxPartialBytes },
            backpressureRetryMs: tuning.backpressureRetryMs,
            exchange: deps.exchange,
            sender: {
                send: (frame) => this.relay.send(frame),
                get connected() {
                    return self.relay.admitted
                },
            },
            caps: deps.caps,
            blobs,
            inlineCapBytes: tuning.inlineCapBytes,
            onControl: (control, messageId, reason) => this.onControl(control, messageId, reason),
            onLimitExceeded: (error) => this.onLimitExceeded(error),
            onFatal: (reason) => this.deps.lifecycle.fail('ERRORED', reason),
            onEvent: (event) => this.emit('delivery', event),
            now: deps.now,
        })
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this

        this.relay.on('admitted', (header) => {
            if (this.deps.lifecycle.state === 'PEER_KEY_VERIFIED') {
                this.deps.lifecycle.transition('RELAY_ATTACHED', 'relay admitted')
            }
            this.delivery.onReconnected({
                maxMsgs: header.limits.windowMsgs,
                maxBytes: header.limits.windowBytes,
                inlineCapBytes: header.limits.inlineCapBytes,
            })
            this.emit('attached')
            // Destination: send message 1. Source: arm a responder. A same-epoch reconnect keeps its session.
            if (this.peer && !this.session?.complete) this.startHandshake()
        })
        this.relay.on('frame', (frame) => this.onFrame(frame))
        this.relay.on('disconnected', () => this.emit('disconnected'))
        this.relay.on('fatal', (reason) => {
            this.emit('relayFatal', reason)
            if (reason === 'SESSION_CLOSED') return this.finishClosed('relay purged the session')
            this.deps.lifecycle.fail('ERRORED', `relay: ${reason}`)
        })
        // A failed session tells the relay to purge (best effort); the relay's own fatal codes need no reply.
        this.deps.lifecycle.onTransition((transition) => {
            if (transition.to === 'ERRORED' || transition.to === 'LIMIT_EXCEEDED')
                this.sendCloseBestEffort(transition.reason)
        })
    }

    get established(): boolean {
        return this.session?.complete === true
    }

    get epochTag(): string | undefined {
        return this.session?.epochTag
    }

    get verifiedPeer(): VerifiedPeer | undefined {
        return this.peer
    }

    /** Exposed for tests and the harness only. */
    get currentSession(): NoiseSession | undefined {
        return this.session
    }

    attach(): void {
        this.relay.start()
    }

    /** The peer's pin-verified directory key. Also (re)starts the handshake when attached. */
    setPeer(peer: VerifiedPeer): void {
        this.peer = peer
        this.tearDownSession()
        if (this.relay.admitted) this.startHandshake()
    }

    /** Destination: send message 1 and retry it; source: arm a responder for message 1. */
    startHandshake(): void {
        if (!this.peer || this.stopped) return
        this.clearHandshakeTimer()
        this.tearDownSession()
        const prologue = encodePrologue(prologueInputsFor(this.deps.bundle, this.peer.generation))
        const role = this.deps.bundle.role === 'destination' ? 'initiator' : 'responder'
        this.session = new NoiseSession({
            role,
            staticKeypair: this.deps.identity.noiseStatic,
            expectedRemoteStatic: this.peer.publicKey,
            prologue,
        })
        this.cachedMsg2 = undefined
        if (role === 'initiator') {
            this.msg1 = this.session.writeHandshake()
            this.handshakeAttempts = 0
            this.sendMsg1()
        }
    }

    stop(): void {
        this.stopped = true
        this.clearHandshakeTimer()
        this.clearCloseTimer()
        this.delivery.stop()
        this.relay.stop()
        this.tearDownSession()
    }

    // ---- CLOSE (v2 §7.6) -----------------------------------------------------------------

    /**
     * Destination: start the CLOSE sequence — an authenticated CLOSE to the peer through the relay,
     * then wait for the peer's CLOSE_ACK / the relay's SESSION_CLOSED, bounded by the close timeout.
     * The lifecycle is CLOSING from the caller's transition until finishClosed().
     */
    close(reason = 'rc requested completion'): void {
        if (this.closing || this.stopped) return
        this.closing = true
        const payload = this.delivery.sealClose(reason) ?? Buffer.alloc(0)
        const sent = this.relay.send({ type: 'CLOSE', header: {}, payload })
        log.info('channel.close_sent', { sent, authenticated: payload.byteLength > 0 })
        this.armCloseTimer()
    }

    private sendCloseBestEffort(reason: string): void {
        if (this.closing) return
        this.closing = true
        const payload = this.delivery.sealClose(reason) ?? Buffer.alloc(0)
        const sent = this.relay.send({ type: 'CLOSE', header: {}, payload })
        log.info('channel.close_sent', { sent, authenticated: payload.byteLength > 0, terminal: true })
    }

    private onCloseFrame(payload: Buffer): void {
        const verified = this.delivery.openClose(payload)
        // Acknowledge regardless so the relay can purge promptly; only a verified CLOSE moves the lifecycle.
        this.relay.send({ type: 'CLOSE_ACK', header: {} })
        if (!verified) {
            log.warn('channel.close_unverified', { bytes: payload.byteLength })
            return
        }
        log.info('channel.close_received', { messageId: verified.messageId })
        if (this.deps.lifecycle.state === 'CHANNEL_UP') {
            this.deps.lifecycle.transition(
                'CLOSING',
                `peer CLOSE received (${verified.messageId}${verified.reason ? `: ${verified.reason}` : ''})`,
            )
        }
        this.closing = true
        this.armCloseTimer()
        this.emit('control', 'CLOSE', verified.messageId, verified.reason)
    }

    private armCloseTimer(): void {
        if (this.closeTimer) return
        this.closeTimer = setTimeout(() => {
            this.closeTimer = null
            this.finishClosed('close timeout')
        }, this.deps.tuning.closeTimeoutMs)
        this.closeTimer.unref()
    }

    private finishClosed(reason: string): void {
        this.clearCloseTimer()
        const lifecycle = this.deps.lifecycle
        if (lifecycle.isTerminal()) return
        if (lifecycle.state !== 'CLOSING') {
            // The relay ended the session before any CLOSE reached us: a study ending we cannot
            // authenticate. Ending early is the only thing a relay can force, so log it loudly.
            log.warn('channel.closed_without_close', { state: lifecycle.state, reason })
            if (!lifecycle.canTransition('CLOSING'))
                return void lifecycle.fail('ERRORED', `session closed by relay: ${reason}`)
            lifecycle.transition('CLOSING', `relay closed the session: ${reason}`)
        }
        lifecycle.transition('CLOSED', reason)
        log.info('channel.closed', { reason })
        this.emit('closed', reason)
        this.relay.stop()
    }

    private clearCloseTimer(): void {
        if (this.closeTimer) clearTimeout(this.closeTimer)
        this.closeTimer = null
    }

    private sendMsg1(): void {
        if (!this.msg1 || this.stopped) return
        this.handshakeAttempts++
        if (this.handshakeAttempts > this.deps.tuning.handshakeMaxAttempts) {
            log.error('channel.handshake_exhausted', { attempts: this.handshakeAttempts - 1 })
            this.emit('handshakeFailed', 'max attempts')
            return
        }
        const sent = this.relay.send({ type: 'HANDSHAKE', header: {}, payload: this.msg1 })
        log.info('channel.handshake_sent', { attempt: this.handshakeAttempts, sent })
        this.handshakeTimer = setTimeout(() => this.sendMsg1(), this.deps.tuning.handshakeRetryMs)
        this.handshakeTimer.unref()
    }

    private onFrame(frame: Frame): void {
        switch (frame.type) {
            case 'HANDSHAKE':
                return this.onHandshakeFrame(frame.payload)
            case 'PEER_REJOINED':
                return this.onPeerRejoined(frame.header.peerRole)
            case 'CLOSE':
                return this.onCloseFrame(frame.payload)
            case 'CLOSE_ACK':
                // The peer acknowledged; the relay purges next and closes us with SESSION_CLOSED.
                log.info('channel.close_acked', {})
                this.emit('closeAcked')
                return
            default:
                return this.delivery.onFrame(frame)
        }
    }

    private onHandshakeFrame(payload: Buffer): void {
        const session = this.session
        if (!session) {
            log.warn('channel.handshake_ignored', { reason: 'no session armed (peer key pending)' })
            return
        }
        if (this.deps.bundle.role === 'source') {
            if (session.complete) {
                // A byte-identical message 1 means our message 2 was lost: re-answer, no new epoch.
                if (this.cachedMsg2 && this.cachedMsg2.msg1.equals(payload)) {
                    this.relay.send({ type: 'HANDSHAKE', header: {}, payload: this.cachedMsg2.msg2 })
                    log.info('channel.handshake_reanswered', {})
                } else {
                    log.warn('channel.handshake_ignored', { reason: 'channel already established' })
                }
                return
            }
            try {
                session.readHandshake(payload)
                const msg2 = session.writeHandshake()
                this.cachedMsg2 = { msg1: Buffer.from(payload), msg2 }
                this.relay.send({ type: 'HANDSHAKE', header: {}, payload: msg2 })
                this.onEstablished()
            } catch (error) {
                this.onHandshakeError(error)
            }
            return
        }
        // destination (initiator)
        if (session.complete) {
            log.warn('channel.handshake_ignored', { reason: 'channel already established' })
            return
        }
        try {
            session.readHandshake(payload)
            this.clearHandshakeTimer()
            this.onEstablished()
        } catch (error) {
            this.onHandshakeError(error)
        }
    }

    private onHandshakeError(error: unknown): void {
        const mismatch = error instanceof PeerIdentityMismatchError
        log.error(mismatch ? 'channel.peer_identity_mismatch' : 'channel.handshake_failed', errorFields(error))
        if (!(error instanceof HandshakeFailedError)) throw error
        // The failed state object is unusable; arm a fresh one and let the initiator retry.
        if (this.deps.bundle.role === 'source') this.startHandshake()
        else this.emit('handshakeFailed', mismatch ? 'peer identity mismatch' : 'handshake failed')
    }

    private onEstablished(): void {
        const session = this.session!
        if (this.deps.lifecycle.state === 'RELAY_ATTACHED') {
            this.deps.lifecycle.transition('CHANNEL_UP', `noise handshake complete (epoch ${session.epochTag})`)
        }
        this.delivery.setSession(session, this.peer!.connectionId)
        log.info('channel.up', { epochTag: session.epochTag, peerGeneration: this.peer!.generation })
        this.emit('channelUp', session.epochTag!)
    }

    private onPeerRejoined(peerRole: 'source' | 'destination'): void {
        log.info('channel.peer_rejoined', { peerRole })
        this.clearHandshakeTimer()
        this.tearDownSession()
        if (this.deps.lifecycle.state === 'CHANNEL_UP') {
            this.deps.lifecycle.transition('RELAY_ATTACHED', 'peer rejoined with a new identity')
        }
        this.emit('peerRejoined', peerRole)
    }

    private onControl(control: ControlKind, messageId: string, reason?: string): void {
        if (control === 'LIMIT_EXCEEDED') {
            this.deps.lifecycle.fail('LIMIT_EXCEEDED', `peer reported cap breach${reason ? `: ${reason}` : ''}`)
        }
        this.emit('control', control, messageId, reason)
    }

    private onLimitExceeded(error: LimitExceededError): void {
        log.error('channel.limit_exceeded', { side: error.side, limit: error.limit, used: error.used, max: error.max })
        // Tell the destination through the authenticated channel, then stop for good.
        try {
            this.delivery.sendControl('LIMIT_EXCEEDED', `${error.side}:${error.limit}`)
        } catch (sendError) {
            log.warn('channel.limit_notice_not_sent', errorFields(sendError))
        }
        this.deps.lifecycle.fail('LIMIT_EXCEEDED', error.message)
        this.emit('limitExceeded', error)
    }

    private tearDownSession(): void {
        this.session?.destroy()
        this.session = undefined
        this.msg1 = undefined
        this.cachedMsg2 = undefined
        this.delivery.setSession(undefined)
    }

    private clearHandshakeTimer(): void {
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
    }
}
