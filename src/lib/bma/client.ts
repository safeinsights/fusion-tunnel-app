import { EventEmitter } from 'node:events'
import type { Tuning } from '@/config'
import type { Channel, VerifiedPeer } from '@/lib/channel'
import type { Exchange } from '@/lib/exchange'
import type { Identity } from '@/lib/identity'
import type { Lifecycle, TerminalCode } from '@/lib/lifecycle'
import { log, errorFields } from '@/lib/logger'
import { refreshDelayMs } from '@/lib/bma/credential'
import { verifyPeerKey, type PeerKeyRejection } from '@/lib/bma/verify-peer-key'
import type { CapsMeter } from '@/reliability/caps'
import {
    CredentialResponseSchema,
    PeerKeyResponseSchema,
    RelaySessionResponseSchema,
    type StatusReport,
} from '@/schemas/bma'
import type { ConfigurationBundle } from '@/schemas/provisioning'

// Every Management-App interaction the tunnel performs on its own behalf (v2 §4.3, §5, §12),
// authenticated by the delegated tunnel credential: the peer-key poll (drives CONFIGURED →
// PEER_KEY_VERIFIED, and the re-fetch after PEER_REJOINED), relay-token pre-fetch before
// expiry, credential refresh, and periodic content-free status reports carrying legId and the
// cap counters. Egress from this client goes to exactly one endpoint: the BMA.

export type BmaClientDeps = {
    bundle: ConfigurationBundle
    identity: Identity
    lifecycle: Lifecycle
    channel: Channel
    exchange: Exchange
    tuning: Tuning
    caps?: CapsMeter
    verifiedPeer: (peer: VerifiedPeer) => void
    fetch?: typeof fetch
    now?: () => number
}

export interface BmaClientEvents {
    peerKeyVerified: [peer: VerifiedPeer]
    peerKeyRejected: [reason: PeerKeyRejection]
    relayTokenRefreshed: [expiresAt: string]
    credentialRefreshed: [expiresAt: string]
    statusReported: [report: StatusReport, status: number]
    requestFailed: [operation: string, error: unknown]
}

export class BmaClient extends EventEmitter<BmaClientEvents> {
    private relayToken: string
    private credential: string
    private lastSeenGeneration: number | undefined
    private requireNewer = false
    private peerKeyRejected = false
    private peerGeneration: number | undefined
    private peerKeyTimer: NodeJS.Timeout | null = null
    private relayTokenTimer: NodeJS.Timeout | null = null
    private credentialTimer: NodeJS.Timeout | null = null
    private statusTimer: NodeJS.Timeout | null = null
    private stopped = false
    private polling = false
    private lastSeqReceived: number | undefined
    private messagesSent = 0
    private messagesAcked = 0
    private messagesReceived = 0
    private readonly fetchImpl: typeof fetch
    private readonly now: () => number

    constructor(private readonly deps: BmaClientDeps) {
        super()
        this.relayToken = deps.bundle.relay.token
        this.credential = deps.bundle.bma.credential
        this.fetchImpl = deps.fetch ?? fetch
        this.now = deps.now ?? Date.now
    }

    /** The current relay token — the relay client's token provider. */
    currentRelayToken(): string {
        return this.relayToken
    }

    currentCredential(): string {
        return this.credential
    }

    start(): void {
        this.deps.channel.on('peerRejoined', () => {
            // The peer restarted: its new key has a higher directory generation. Poll until it appears.
            this.requireNewer = true
            this.startPeerKeyPoll()
        })
        this.deps.channel.on('delivery', (event) => {
            if (event.type === 'sent' && !event.resend) this.messagesSent++
            if (event.type === 'acked') this.messagesAcked++
            if (event.type === 'delivered') {
                this.messagesReceived++
                if (this.deps.caps?.nearLimit()) void this.report('near_limit')
            }
        })
        this.deps.channel.relay.on('frame', (frame) => {
            if (frame.type === 'DATA' && frame.header.seq !== undefined) this.lastSeqReceived = frame.header.seq
        })
        this.deps.lifecycle.onTransition((transition) => {
            if (this.deps.lifecycle.isTerminal()) {
                this.clearTimers()
                void this.report('terminal', { code: this.deps.lifecycle.terminalCode()!, reason: transition.reason })
            } else if (transition.to === 'CHANNEL_UP' || transition.to === 'CLOSING') {
                void this.report('transition')
            }
        })
        this.startPeerKeyPoll()
        this.scheduleRelayTokenRefresh()
        this.scheduleCredentialRefresh()
        this.statusTimer = setInterval(() => void this.report('interval'), this.deps.tuning.statusIntervalMs)
        this.statusTimer.unref()
    }

    stop(): void {
        this.stopped = true
        this.clearTimers()
    }

    get peerKeyStatus(): { rejected: boolean; lastSeenGeneration?: number } {
        return { rejected: this.peerKeyRejected, lastSeenGeneration: this.lastSeenGeneration }
    }

    // ---- peer key ------------------------------------------------------------------------

    private startPeerKeyPoll(): void {
        if (this.stopped || this.polling) return
        this.polling = true
        void this.pollPeerKey()
    }

    private async pollPeerKey(): Promise<void> {
        if (this.stopped) return
        try {
            const res = await this.get(`/tunnel/peer-key?legId=${encodeURIComponent(this.deps.bundle.legId)}`)
            if (res.status === 200) {
                const parsed = PeerKeyResponseSchema.safeParse(await res.json())
                if (!parsed.success) {
                    this.rejectPeerKey('bad_signature', 'unparseable blob')
                } else {
                    const verdict = verifyPeerKey(parsed.data, {
                        bundle: this.deps.bundle,
                        lastSeenGeneration: this.lastSeenGeneration,
                        requireNewer: this.requireNewer,
                    })
                    if (verdict.ok) {
                        this.lastSeenGeneration = verdict.peer.generation
                        this.peerGeneration = verdict.peer.generation
                        this.requireNewer = false
                        this.peerKeyRejected = false
                        this.polling = false
                        log.info('bma.peer_key_verified', {
                            legId: this.deps.bundle.legId,
                            generation: verdict.peer.generation,
                        })
                        this.emit('peerKeyVerified', verdict.peer)
                        this.deps.verifiedPeer(verdict.peer)
                        return
                    }
                    // A stale generation right after PEER_REJOINED just means the peer has not published yet.
                    if (!(verdict.reason === 'stale_generation' && this.requireNewer)) {
                        this.rejectPeerKey(verdict.reason, `generation ${parsed.data.generation}`)
                    }
                }
            } else if (res.status !== 204) {
                this.emit('requestFailed', 'peer-key', new Error(`peer-key returned ${res.status}`))
                log.warn('bma.peer_key_unexpected_status', { status: res.status })
            }
        } catch (error) {
            this.emit('requestFailed', 'peer-key', error)
            log.warn('bma.peer_key_fetch_failed', errorFields(error))
        }
        if (this.stopped) return
        this.peerKeyTimer = setTimeout(() => void this.pollPeerKey(), this.deps.tuning.peerKeyPollMs)
        this.peerKeyTimer.unref()
    }

    private rejectPeerKey(reason: PeerKeyRejection, detail: string): void {
        // Loud, and the tunnel stays in its polling state: a bad blob never advances the lifecycle.
        this.peerKeyRejected = true
        log.error('bma.peer_key_rejected', { legId: this.deps.bundle.legId, reason, detail })
        this.emit('peerKeyRejected', reason)
    }

    // ---- tokens --------------------------------------------------------------------------

    private scheduleRelayTokenRefresh(): void {
        if (this.relayTokenTimer) clearTimeout(this.relayTokenTimer)
        const delay = refreshDelayMs(this.relayToken, this.now(), this.deps.tuning.tokenRefreshLeadMs)
        if (delay === undefined) {
            log.warn('bma.relay_token_without_exp', {})
            return
        }
        this.relayTokenTimer = setTimeout(() => void this.refreshRelayToken(), delay)
        this.relayTokenTimer.unref()
    }

    private async refreshRelayToken(): Promise<void> {
        if (this.stopped) return
        try {
            const res = await this.get(`/tunnel/relay-session?legId=${encodeURIComponent(this.deps.bundle.legId)}`)
            if (res.status !== 200) throw new Error(`relay-session returned ${res.status}`)
            const parsed = RelaySessionResponseSchema.parse(await res.json())
            if (parsed.relaySessionId !== this.deps.bundle.relay.sessionId || parsed.role !== this.deps.bundle.role) {
                throw new Error('relay-session response does not match the bundle')
            }
            this.relayToken = parsed.relayToken
            log.info('bma.relay_token_refreshed', { expiresAt: parsed.relayTokenExpiresAt })
            this.emit('relayTokenRefreshed', parsed.relayTokenExpiresAt)
            this.scheduleRelayTokenRefresh()
        } catch (error) {
            this.emit('requestFailed', 'relay-session', error)
            log.warn('bma.relay_token_refresh_failed', errorFields(error))
            this.relayTokenTimer = setTimeout(() => void this.refreshRelayToken(), this.deps.tuning.peerKeyPollMs)
            this.relayTokenTimer.unref()
        }
    }

    private scheduleCredentialRefresh(): void {
        if (this.credentialTimer) clearTimeout(this.credentialTimer)
        const delay = refreshDelayMs(this.credential, this.now(), this.deps.tuning.tokenRefreshLeadMs)
        if (delay === undefined) {
            log.warn('bma.credential_without_exp', {})
            return
        }
        this.credentialTimer = setTimeout(() => void this.refreshCredential(), delay)
        this.credentialTimer.unref()
    }

    private async refreshCredential(): Promise<void> {
        if (this.stopped) return
        try {
            const res = await this.post('/tunnel/credential', {})
            if (res.status !== 200) throw new Error(`credential returned ${res.status}`)
            const parsed = CredentialResponseSchema.parse(await res.json())
            this.credential = parsed.credential
            log.info('bma.credential_refreshed', { expiresAt: parsed.expiresAt })
            this.emit('credentialRefreshed', parsed.expiresAt)
            this.scheduleCredentialRefresh()
        } catch (error) {
            this.emit('requestFailed', 'credential', error)
            log.warn('bma.credential_refresh_failed', errorFields(error))
            this.credentialTimer = setTimeout(() => void this.refreshCredential(), this.deps.tuning.peerKeyPollMs)
            this.credentialTimer.unref()
        }
    }

    // ---- status reports ------------------------------------------------------------------

    buildReport(reason: StatusReport['reason'], terminal?: { code: TerminalCode; reason: string }): StatusReport {
        const { bundle, identity, lifecycle, channel, exchange, caps } = this.deps
        const delivery = channel.delivery.stats()
        return {
            studyId: bundle.studyId,
            jobId: bundle.jobId,
            legId: bundle.legId,
            orgSlug: bundle.orgSlug,
            role: bundle.role,
            connectionId: identity.connectionId,
            state: lifecycle.state,
            relayAdmitted: channel.relay.admitted,
            ...(channel.epochTag ? { epochTag: channel.epochTag } : {}),
            ownGeneration: bundle.keyGeneration,
            ...(this.peerGeneration !== undefined ? { peerGeneration: this.peerGeneration } : {}),
            framesSent: Number(channel.currentSession?.framesSent ?? 0n),
            messagesSent: this.messagesSent,
            messagesAcked: this.messagesAcked,
            messagesReceived: this.messagesReceived,
            ...(this.lastSeqReceived !== undefined ? { lastSeqReceived: this.lastSeqReceived } : {}),
            roundsCompleted: exchange.stats().roundsCompleted,
            outboxDepth: delivery.outboxDepth,
            pendingAcks: delivery.pendingAcks,
            ...(caps ? { caps: { consumed: caps.consumed(), budget: caps.budget() } } : {}),
            peerKeyRejected: this.peerKeyRejected,
            ...(terminal ? { terminal: { code: terminal.code, reason: terminal.reason.slice(0, 256) } } : {}),
            reason,
            reportedAt: new Date(this.now()).toISOString(),
        }
    }

    async report(reason: StatusReport['reason'], terminal?: { code: TerminalCode; reason: string }): Promise<void> {
        const report = this.buildReport(reason, terminal)
        try {
            const res = await this.post('/tunnel/status', report)
            this.emit('statusReported', report, res.status)
            if (res.status >= 300) log.warn('bma.status_report_rejected', { status: res.status, reason })
        } catch (error) {
            this.emit('requestFailed', 'status', error)
            log.warn('bma.status_report_failed', { reason, ...errorFields(error) })
        }
    }

    // ---- http ----------------------------------------------------------------------------

    private get(path: string): Promise<Response> {
        return this.fetchImpl(new URL(path, this.deps.bundle.bma.endpoint), {
            headers: { authorization: `Bearer ${this.credential}`, accept: 'application/json' },
        })
    }

    private post(path: string, body: unknown): Promise<Response> {
        return this.fetchImpl(new URL(path, this.deps.bundle.bma.endpoint), {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.credential}`,
                accept: 'application/json',
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        })
    }

    private clearTimers(): void {
        for (const timer of [this.peerKeyTimer, this.relayTokenTimer, this.credentialTimer])
            if (timer) clearTimeout(timer)
        if (this.statusTimer) clearInterval(this.statusTimer)
        this.peerKeyTimer = this.relayTokenTimer = this.credentialTimer = this.statusTimer = null
        this.polling = false
    }
}
