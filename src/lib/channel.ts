import { EventEmitter } from 'node:events'
import type { Tuning } from '@/config'
import type { Exchange } from '@/lib/exchange'
import type { Identity } from '@/lib/identity'
import type { Lifecycle, TerminalDetail } from '@/lib/lifecycle'
import { log, errorFields } from '@/lib/logger'
import { encodePrologue, prologueInputsFor } from '@/lib/noise/prologue'
import { HandshakeFailedError, NoiseSession, PeerIdentityMismatchError } from '@/lib/noise/session'
import { RelayClient, type RelayClientOptions } from '@/lib/relay-client'
import type { VerifiedPeer } from '@/lib/bma/verify-peer-key'
import type { TerminalCode } from '@/local-api'
import type { CapsMeter } from '@/reliability/caps'
import { Delivery, LimitExceededError, type DeliveryEvent, type VerifiedClose } from '@/reliability/delivery'
import type { Frame, PeerHeader } from '@/relay-protocol'
import type { ConfigurationBundle } from '@/schemas/provisioning'

// The channel orchestrator: one relay attachment, one Noise_IK session (per epoch) and one
// Delivery, driven by the lifecycle machine. The peer's verified key arrives from the BMA client
// (or the test harness) via setPeer(); the relay's PEER frames say when the peer is attached and
// with which fingerprint. A fingerprint we did not handshake with means the peer restarted: the
// session is torn down and the caller re-fetches the key and re-handshakes. The destination
// initiates and retries message 1 while the peer is attached; the source answers, and re-answers a
// byte-identical message 1 so a lost message 2 converges without a new epoch.

export type { VerifiedPeer }

export interface ChannelEvents {
    attached: []
    closeAcked: []
    closed: [reason: string]
    channelUp: [epochTag: string]
    peerRejoined: [fingerprint: string]
    handshakeFailed: [reason: string]
    limitExceeded: [error: LimitExceededError]
    peerClose: [close: VerifiedClose]
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
            tuning,
        }
        this.relay = deps.relayFactory ? deps.relayFactory(options) : new RelayClient(options)
        const relay = this.relay
        this.delivery = new Delivery({
            role: bundle.role,
            connectionId: identity.connectionId,
            window: { maxMsgs: tuning.inflightMaxMsgs, maxBytes: tuning.outboxMaxBytes },
            maxMessageBytes: tuning.maxMessageBytes,
            inbox: { maxPartialMessages: tuning.inflightMaxMsgs, maxPartialBytes: tuning.inboxMaxBytes },
            backpressureRetryMs: tuning.backpressureRetryMs,
            retransmitMs: tuning.retransmitMs,
            maxSends: tuning.maxSends,
            unackedMaxMs: tuning.unackedMaxMs,
            exchange: deps.exchange,
            sender: {
                send: (frame) => relay.send(frame),
                get connected() {
                    return relay.admitted
                },
                get peerAttached() {
                    return relay.peerAttached
                },
            },
            caps: deps.caps,
            onLimitExceeded: (error) => this.onLimitExceeded(error),
            onFatal: (reason) => this.deps.lifecycle.fail('ERRORED', reason),
            onEvent: (event) => this.emit('delivery', event),
            now: deps.now,
        })

        this.relay.on('admitted', () => {
            if (this.deps.lifecycle.state === 'PEER_KEY_VERIFIED')
                this.deps.lifecycle.transition('RELAY_ATTACHED', 'relay admitted')
            this.emit('attached')
        })
        this.relay.on('peer', (peer) => this.onPeer(peer))
        this.relay.on('frame', (frame) => this.onFrame(frame))
        this.relay.on('disconnected', () => this.emit('disconnected'))
        this.relay.on('fatal', (reason) => {
            this.emit('relayFatal', reason)
            if (reason === 'SESSION_CLOSED') return this.finishClosed('relay purged the session')
            this.deps.lifecycle.fail('ERRORED', `relay: ${reason}`)
        })
        // How we ended travels to the peer inside the authenticated CLOSE, whatever ended us.
        this.deps.lifecycle.onTransition((t) => {
            if (t.to === 'ERRORED') this.close('SESSION_ERRORED', t.reason)
            else if (t.to === 'LIMIT_EXCEEDED') this.close('LIMIT_EXCEEDED', t.reason, t.detail)
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

    /** The peer's pin-verified directory key. Also (re)starts the handshake when the peer is attached. */
    setPeer(peer: VerifiedPeer): void {
        this.peer = peer
        this.tearDownSession()
        if (this.relay.peerAttached) this.startHandshake()
    }

    stop(): void {
        this.stopped = true
        this.clearHandshakeTimer()
        this.clearCloseTimer()
        this.delivery.stop()
        this.relay.stop()
        this.tearDownSession()
    }

    // ---- peer presence -------------------------------------------------------------------

    private onPeer(peer: PeerHeader): void {
        if (!peer.attached) {
            this.clearHandshakeTimer()
            return
        }
        if (this.peer && peer.fingerprint && peer.fingerprint !== this.peer.fingerprint) {
            // The peer restarted with new keys: everything we sealed for the old ones is void.
            log.info('channel.peer_rejoined', { fingerprint: peer.fingerprint })
            this.clearHandshakeTimer()
            this.tearDownSession()
            if (this.deps.lifecycle.state === 'CHANNEL_UP') {
                this.deps.lifecycle.transition('RELAY_ATTACHED', 'peer rejoined with a new identity')
            }
            this.emit('peerRejoined', peer.fingerprint)
            return
        }
        if (this.session?.complete) return this.delivery.reoffer()
        if (this.peer) this.startHandshake()
    }

    /** Destination: send message 1 and retry it while the peer is attached; source: arm a responder. */
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

    private sendMsg1(): void {
        if (!this.msg1 || this.stopped || !this.relay.peerAttached) return
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

    // ---- CLOSE (v2 §7.6) -----------------------------------------------------------------

    /**
     * Send an authenticated CLOSE carrying how this side ended (STUDY_COMPLETE from the RC's
     * complete(), LIMIT_EXCEEDED from a cap breach, SESSION_ERRORED from a failure), then wait for
     * the peer's CLOSE_ACK / the relay's SESSION_CLOSED, bounded by the close timeout. The caller
     * moves the lifecycle; this only speaks to the peer.
     */
    close(code: TerminalCode, reason = 'rc requested completion', limit?: TerminalDetail): void {
        if (this.closing || this.stopped) return
        this.closing = true
        const payload = this.delivery.sealClose(code, reason, limit) ?? Buffer.alloc(0)
        const sent = this.relay.send({ type: 'CLOSE', header: {}, payload })
        log.info('channel.close_sent', { code, sent, authenticated: payload.byteLength > 0 })
        if (code === 'STUDY_COMPLETE') this.armCloseTimer()
    }

    private onCloseFrame(payload: Buffer): void {
        const verified = this.delivery.openClose(payload)
        // Acknowledge regardless so the relay can purge promptly; only a verified CLOSE moves the lifecycle.
        this.relay.send({ type: 'CLOSE_ACK', header: {} })
        if (!verified) {
            log.warn('channel.close_unverified', { bytes: payload.byteLength })
            return
        }
        log.info('channel.close_received', { messageId: verified.messageId, code: verified.code })
        const lifecycle = this.deps.lifecycle
        const why = `peer CLOSE received (${verified.messageId}${verified.reason ? `: ${verified.reason}` : ''})`
        if (verified.code === 'STUDY_COMPLETE') {
            if (lifecycle.state === 'CHANNEL_UP') lifecycle.transition('CLOSING', why)
        } else {
            lifecycle.fail(verified.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'ERRORED', why, verified.limit)
        }
        this.closing = true
        this.armCloseTimer()
        this.emit('peerClose', verified)
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
            // The relay ended the session before any authenticated CLOSE reached us. Only the peer's
            // authenticated CLOSE completes a study (v2 §7.6): a relay can end a session early, but
            // it must not be able to make that look like completion.
            log.error('channel.closed_without_close', { state: lifecycle.state, reason })
            lifecycle.fail('ERRORED', `relay closed the session without an authenticated CLOSE: ${reason}`)
            this.relay.stop()
            return
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

    // ---- frames ----------------------------------------------------------------------------

    private onFrame(frame: Frame): void {
        switch (frame.type) {
            case 'HANDSHAKE':
                return this.onHandshakeFrame(frame.payload)
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
        if (!session) return log.warn('channel.handshake_ignored', { reason: 'no session armed (peer key pending)' })
        if (this.deps.bundle.role === 'source') {
            if (session.complete) {
                // A byte-identical message 1 means our message 2 was lost: re-answer, no new epoch.
                if (this.cachedMsg2?.msg1.equals(payload)) {
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
        if (session.complete) return log.warn('channel.handshake_ignored', { reason: 'channel already established' })
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

    private onLimitExceeded(error: LimitExceededError): void {
        log.error('channel.limit_exceeded', { side: error.side, limit: error.limit, used: error.used, max: error.max })
        this.deps.lifecycle.fail('LIMIT_EXCEEDED', error.message, error.detail)
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
