import { EventEmitter } from 'node:events'
import type { Tuning } from '@/config'
import type { Channel } from '@/lib/channel'
import type { Exchange } from '@/lib/exchange'
import type { Identity } from '@/lib/identity'
import type { Lifecycle, TerminalCode } from '@/lib/lifecycle'
import { log, errorFields } from '@/lib/logger'
import { refreshDelayMs } from '@/lib/bma/credential'
import { verifyPeerKey, type PeerKeyRejection, type VerifiedPeer } from '@/lib/bma/verify-peer-key'
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
// PEER_KEY_VERIFIED, and the re-fetch after a peer restart), relay-token pre-fetch before expiry,
// credential refresh, and periodic content-free status reports carrying legId and the cap
// counters. Egress from this client goes to exactly one endpoint: the BMA.

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
    peerKeyRejected: [reason: PeerKeyRejection]
    requestFailed: [operation: string, error: unknown]
}

export class BmaClient extends EventEmitter<BmaClientEvents> {
    private relayToken: string
    private credential: string
    private lastSeenGeneration: number | undefined
    private requireNewer = false
    private peerKeyRejected = false
    private peerGeneration: number | undefined
    private readonly timers = new Map<'peerKey' | 'relayToken' | 'credential', NodeJS.Timeout>()
    private statusTimer: NodeJS.Timeout | null = null
    private stopped = false
    private polling = false
    private messagesSent = 0
    private messagesAcked = 0
    private messagesReceived = 0
    private readonly fetchImpl: typeof fetch
    private readonly now: () => number
    private terminalReportDone!: () => void
    private readonly terminalReport = new Promise<void>((resolve) => {
        this.terminalReportDone = resolve
    })

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

    start(): void {
        this.deps.channel.on('delivery', (event) => {
            if (event.type === 'sent' && !event.resend) this.messagesSent++
            if (event.type === 'acked') this.messagesAcked++
            if (event.type === 'delivered') {
                this.messagesReceived++
                if (this.deps.caps?.nearLimit()) void this.report('near_limit')
            }
        })
        this.deps.lifecycle.onTransition((transition) => {
            if (transition.to === 'CHANNEL_UP') this.stopPeerKeyPoll()
            if (this.deps.lifecycle.isTerminal()) {
                this.clearTimers()
                void this.report('terminal', { code: this.deps.lifecycle.terminalCode()!, reason: transition.reason })
            } else if (transition.to === 'CHANNEL_UP' || transition.to === 'CLOSING') {
                void this.report('transition')
            }
        })
        this.startPeerKeyPoll()
        this.scheduleRefresh('relayToken')
        this.scheduleRefresh('credential')
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

    /** Resolves once the terminal status report has been attempted (sent or failed). */
    terminalReported(): Promise<void> {
        return this.terminalReport
    }

    // ---- peer key ------------------------------------------------------------------------

    /** The peer restarted: its new key has a higher directory generation. Poll until it appears. */
    refetchPeerKey(): void {
        this.requireNewer = true
        this.startPeerKeyPoll()
    }

    private startPeerKeyPoll(): void {
        if (this.stopped || this.polling) return
        this.polling = true
        void this.pollPeerKey()
    }

    private stopPeerKeyPoll(): void {
        this.clearTimer('peerKey')
        this.polling = false
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
                        this.peerKeyRejected = false
                        log.info('bma.peer_key_verified', {
                            legId: this.deps.bundle.legId,
                            generation: verdict.peer.generation,
                        })
                        this.deps.verifiedPeer(verdict.peer)
                        // Keep watching for a strictly newer key until the channel is up: a peer re-provisioned
                        // before it ever attached publishes a new generation without any presence change reaching us.
                        this.requireNewer = true
                        if (this.deps.lifecycle.state === 'CHANNEL_UP') {
                            this.polling = false
                            return
                        }
                    } else if (!(verdict.reason === 'stale_generation' && this.requireNewer)) {
                        // A stale generation while waiting for a newer key just means the peer has not published yet.
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
        if (this.stopped || !this.polling) return
        this.setTimer('peerKey', () => void this.pollPeerKey(), this.deps.tuning.peerKeyPollMs)
    }

    private rejectPeerKey(reason: PeerKeyRejection, detail: string): void {
        // Loud, and the tunnel stays in its polling state: a bad blob never advances the lifecycle.
        this.peerKeyRejected = true
        log.error('bma.peer_key_rejected', { legId: this.deps.bundle.legId, reason, detail })
        this.emit('peerKeyRejected', reason)
    }

    // ---- tokens --------------------------------------------------------------------------

    /** Both BMA-issued JWTs are refreshed the same way: `lead` before their `exp`, retried on the poll cadence. */
    private scheduleRefresh(which: 'relayToken' | 'credential', delayMs?: number): void {
        const token = which === 'relayToken' ? this.relayToken : this.credential
        const delay = delayMs ?? refreshDelayMs(token, this.now(), this.deps.tuning.tokenRefreshLeadMs)
        if (delay === undefined) return log.warn('bma.token_without_exp', { which })
        this.setTimer(which, () => void this.refresh(which), delay)
    }

    private async refresh(which: 'relayToken' | 'credential'): Promise<void> {
        if (this.stopped) return
        try {
            if (which === 'relayToken') {
                const res = await this.get(`/tunnel/relay-session?legId=${encodeURIComponent(this.deps.bundle.legId)}`)
                if (res.status !== 200) throw new Error(`relay-session returned ${res.status}`)
                const parsed = RelaySessionResponseSchema.parse(await res.json())
                if (
                    parsed.relaySessionId !== this.deps.bundle.relay.sessionId ||
                    parsed.role !== this.deps.bundle.role
                ) {
                    throw new Error('relay-session response does not match the bundle')
                }
                this.relayToken = parsed.relayToken
                log.info('bma.relay_token_refreshed', { expiresAt: parsed.relayTokenExpiresAt })
            } else {
                const res = await this.post('/tunnel/credential', {})
                if (res.status !== 200) throw new Error(`credential returned ${res.status}`)
                this.credential = CredentialResponseSchema.parse(await res.json()).credential
                log.info('bma.credential_refreshed', {})
            }
            this.scheduleRefresh(which)
        } catch (error) {
            this.emit('requestFailed', which, error)
            log.warn('bma.refresh_failed', { which, ...errorFields(error) })
            this.scheduleRefresh(which, this.deps.tuning.peerKeyPollMs)
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
            if (res.status >= 300) log.warn('bma.status_report_rejected', { status: res.status, reason })
        } catch (error) {
            this.emit('requestFailed', 'status', error)
            log.warn('bma.status_report_failed', { reason, ...errorFields(error) })
        } finally {
            if (reason === 'terminal') this.terminalReportDone()
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

    private setTimer(name: 'peerKey' | 'relayToken' | 'credential', fn: () => void, delayMs: number): void {
        this.clearTimer(name)
        const timer = setTimeout(fn, delayMs)
        timer.unref()
        this.timers.set(name, timer)
    }

    private clearTimer(name: 'peerKey' | 'relayToken' | 'credential'): void {
        const timer = this.timers.get(name)
        if (timer) clearTimeout(timer)
        this.timers.delete(name)
    }

    private clearTimers(): void {
        for (const name of [...this.timers.keys()]) this.clearTimer(name)
        if (this.statusTimer) clearInterval(this.statusTimer)
        this.statusTimer = null
        this.polling = false
    }
}
