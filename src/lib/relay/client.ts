import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { log, errorFields } from '@/lib/logger'
import {
    decodeFrame,
    encodeFrame,
    popPayload,
    SESSION_FATAL_CODES,
    WireError,
    type AdmittedHeader,
    type ErrorHeader,
    type Frame,
    type RelayLimits,
    type RelayRole,
} from '@/schemas/relay-wire'

// Outbound WSS client to the relay (v2 §4.2, §6 phase 5): dial with the relay token, answer the
// Ed25519 proof-of-possession challenge, adopt the ADMITTED limits, watch heartbeats, and
// reconnect with exponential backoff. The relay never dials in; every byte the tunnel receives
// rides a socket this client opened. Transport seam for the long-poll fallback (v2 §15.3): the
// rest of the tunnel sees only `send()` and the events below.

export type RelayClientState = 'idle' | 'connecting' | 'authenticating' | 'admitted' | 'backoff' | 'stopped' | 'fatal'

export type RelayClientTuning = {
    heartbeatMs: number
    heartbeatMisses: number
    reconnectMinMs: number
    reconnectMaxMs: number
}

export type RelayClientOptions = {
    endpoint: string
    relaySessionId: string
    legId: string
    role: RelayRole
    /** Returns the current (pre-fetched) relay token; called on every dial. */
    tokenProvider: () => Promise<string> | string
    /** Ed25519 signature over the domain-separated PoP payload (identity.signPop). */
    signChallenge: (payload: Buffer) => Buffer
    tuning: RelayClientTuning
    wsFactory?: (url: string) => WebSocket
    random?: () => number
    now?: () => number
}

export type DisconnectInfo = { code: number; reason: string; wasAdmitted: boolean }
export type ReconnectInfo = { attempt: number; delayMs: number; cause: string }

export interface RelayClientEvents {
    admitted: [header: AdmittedHeader]
    frame: [frame: Frame]
    rejected: [header: ErrorHeader]
    displaced: [header: ErrorHeader]
    fatal: [reason: string, header?: ErrorHeader]
    disconnected: [info: DisconnectInfo]
    reconnecting: [info: ReconnectInfo]
    protocolError: [error: Error]
}

export class RelayClient extends EventEmitter<RelayClientEvents> {
    private ws: WebSocket | null = null
    private dialId = 0
    private attempt = 0
    private reconnectTimer: NodeJS.Timeout | null = null
    private heartbeatTimer: NodeJS.Timeout | null = null
    private lastActivity = 0
    private currentState: RelayClientState = 'idle'
    private admittedHeader: AdmittedHeader | null = null
    private readonly now: () => number
    private readonly random: () => number

    constructor(private readonly options: RelayClientOptions) {
        super()
        this.now = options.now ?? Date.now
        this.random = options.random ?? Math.random
    }

    get state(): RelayClientState {
        return this.currentState
    }

    get admitted(): boolean {
        return this.currentState === 'admitted'
    }

    get limits(): RelayLimits | undefined {
        return this.admittedHeader?.limits
    }

    get reconnectAttempts(): number {
        return this.attempt
    }

    start(): void {
        if (this.currentState !== 'idle' && this.currentState !== 'stopped') return
        this.attempt = 0
        void this.dial('start')
    }

    stop(): void {
        this.setState('stopped')
        this.clearTimers()
        const ws = this.ws
        this.ws = null
        this.dialId++
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
            ws.close(1000, 'stopping')
    }

    /** Sends when admitted; returns false otherwise so the caller keeps the frame in its outbox. */
    send(frame: Frame): boolean {
        if (this.currentState !== 'admitted' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false
        this.ws.send(encodeFrame(frame))
        return true
    }

    /** Drop the socket without a close frame — used by tests and by the heartbeat watchdog. */
    terminate(): void {
        this.ws?.terminate()
    }

    private async dial(cause: string): Promise<void> {
        if (this.currentState === 'stopped' || this.currentState === 'fatal') return
        this.setState('connecting')
        const id = ++this.dialId
        let token: string
        try {
            token = await this.options.tokenProvider()
        } catch (error) {
            log.warn('relay.token_unavailable', { relaySessionId: this.options.relaySessionId, ...errorFields(error) })
            this.scheduleReconnect('token_unavailable')
            return
        }
        if (id !== this.dialId) return

        const ws = (this.options.wsFactory ?? ((url) => new WebSocket(url)))(this.options.endpoint)
        this.ws = ws
        ws.binaryType = 'nodebuffer'

        ws.on('open', () => {
            if (id !== this.dialId) return ws.terminate()
            this.touch()
            this.setState('authenticating')
            ws.send(encodeFrame({ type: 'HELLO', header: { token } }))
        })
        ws.on('message', (data) => {
            if (id !== this.dialId) return
            this.touch()
            let frame: Frame
            try {
                frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
            } catch (error) {
                this.emit('protocolError', error instanceof Error ? error : new WireError('header_json'))
                log.warn('relay.malformed_frame', {
                    relaySessionId: this.options.relaySessionId,
                    ...errorFields(error),
                })
                return
            }
            this.handle(frame)
        })
        ws.on('ping', () => this.touch())
        ws.on('pong', () => this.touch())
        ws.on('error', (error) => {
            if (id !== this.dialId) return
            log.warn('relay.socket_error', { relaySessionId: this.options.relaySessionId, ...errorFields(error) })
        })
        ws.on('close', (code, reason) => {
            if (id !== this.dialId) return
            this.stopHeartbeat()
            this.ws = null
            const wasAdmitted = this.currentState === 'admitted'
            this.admittedHeader = wasAdmitted ? this.admittedHeader : null
            if (this.currentState === 'stopped' || this.currentState === 'fatal') return
            this.emit('disconnected', { code, reason: reason.toString('utf8'), wasAdmitted })
            log.info('relay.disconnected', { relaySessionId: this.options.relaySessionId, code, wasAdmitted })
            this.scheduleReconnect(`close:${code}`)
        })
        log.info('relay.dialing', {
            relaySessionId: this.options.relaySessionId,
            role: this.options.role,
            cause,
            attempt: this.attempt,
        })
    }

    private handle(frame: Frame): void {
        switch (frame.type) {
            case 'CHALLENGE': {
                if (this.currentState !== 'authenticating') return this.violation('CHALLENGE outside authentication')
                const nonce = Buffer.from(frame.header.nonce, 'base64url')
                const signature = this.options.signChallenge(
                    popPayload(nonce, this.options.relaySessionId, this.options.role),
                )
                this.ws?.send(
                    encodeFrame({ type: 'CHALLENGE_RESPONSE', header: { signature: signature.toString('base64url') } }),
                )
                return
            }
            case 'ADMITTED': {
                if (this.currentState !== 'authenticating') return this.violation('ADMITTED outside authentication')
                const h = frame.header
                if (
                    h.relaySessionId !== this.options.relaySessionId ||
                    h.legId !== this.options.legId ||
                    h.role !== this.options.role
                ) {
                    // The relay's view of our session disagrees with the bundle — a provisioning error.
                    this.fatal('admitted_mismatch')
                    return
                }
                this.admittedHeader = h
                this.attempt = 0
                this.setState('admitted')
                this.startHeartbeat(h.heartbeatIntervalMs)
                log.info('relay.admitted', { relaySessionId: h.relaySessionId, legId: h.legId, role: h.role })
                this.emit('admitted', h)
                return
            }
            case 'ERROR':
                return this.handleError(frame.header)
            default:
                if (this.currentState !== 'admitted') return this.violation(`${frame.type} before admission`)
                this.emit('frame', frame)
        }
    }

    private handleError(header: ErrorHeader): void {
        log.warn('relay.error_frame', {
            relaySessionId: this.options.relaySessionId,
            code: header.code,
            retryable: header.retryable,
            messageId: header.messageId,
        })
        if (header.code === 'AUTH_ROLE_OCCUPIED_DISPLACED') {
            // A valid re-admission (normally our own re-dial) took the slot; the relay closes this socket.
            this.emit('displaced', header)
            return
        }
        if (SESSION_FATAL_CODES.has(header.code) || header.code === 'AUTH_POP_FAILED') {
            this.fatal(header.code, header)
            return
        }
        if (this.currentState !== 'admitted') {
            // Admission refused; the relay closes the socket and the close handler backs off. An
            // expired/invalid token is retried with whatever the token provider hands us next.
            this.emit('rejected', header)
            return
        }
        this.emit('frame', { type: 'ERROR', header })
    }

    private violation(detail: string): void {
        log.warn('relay.protocol_violation', { relaySessionId: this.options.relaySessionId, detail })
        this.emit('protocolError', new Error(detail))
    }

    private fatal(reason: string, header?: ErrorHeader): void {
        this.setState('fatal')
        this.clearTimers()
        log.error('relay.fatal', { relaySessionId: this.options.relaySessionId, reason })
        this.emit('fatal', reason, header)
        const ws = this.ws
        this.ws = null
        this.dialId++
        ws?.close(1000, reason)
    }

    private scheduleReconnect(cause: string): void {
        if (this.currentState === 'stopped' || this.currentState === 'fatal') return
        this.setState('backoff')
        const { reconnectMinMs, reconnectMaxMs } = this.options.tuning
        const base = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** this.attempt)
        const delayMs = Math.round(base * (0.5 + this.random() * 0.5))
        this.attempt++
        this.emit('reconnecting', { attempt: this.attempt, delayMs, cause })
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            void this.dial(cause)
        }, delayMs)
        this.reconnectTimer.unref()
    }

    private startHeartbeat(intervalMs: number): void {
        this.stopHeartbeat()
        const interval = intervalMs > 0 ? intervalMs : this.options.tuning.heartbeatMs
        const limit = interval * this.options.tuning.heartbeatMisses
        this.heartbeatTimer = setInterval(() => {
            if (this.now() - this.lastActivity > limit) {
                log.warn('relay.heartbeat_missed', {
                    relaySessionId: this.options.relaySessionId,
                    silentMs: this.now() - this.lastActivity,
                })
                this.ws?.terminate()
            }
        }, interval)
        this.heartbeatTimer.unref()
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
    }

    private clearTimers(): void {
        this.stopHeartbeat()
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
    }

    private touch(): void {
        this.lastActivity = this.now()
    }

    private setState(state: RelayClientState): void {
        this.currentState = state
    }
}
