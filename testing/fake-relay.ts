import { EventEmitter } from 'node:events'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import WebSocket, { WebSocketServer } from 'ws'
import {
    decodeFrame,
    encodeFrame,
    popPayload,
    verifyPop,
    RelayTokenClaimsSchema,
    RELAY_TOKEN_AUDIENCE,
    type DataHeader,
    type ErrorHeader,
    type Frame,
    type RelayErrorCode,
    type RelayLimits,
    type RelayRole,
    type RelayTokenClaims,
} from '@/schemas/relay-wire'

// In-repo test double for the Fusion Relay (plan Phase 4), built on schemas/relay-wire.ts so it
// doubles as the relay team's executable contract: token + PoP admission, one live connection per
// role with displacement, pairing by relaySessionId, per-direction FIFO mailboxes with the
// buffered → delivered → consumed → deleted states and the query-retention rule, NACK-discard,
// old-epoch purge on new-fingerprint admission, in-flight window with BACKPRESSURE, PEER_REJOINED,
// HANDSHAKE forwarding (live peer only, never mailboxed), CLOSE orchestration, delivery counting
// with dead-letter, and heartbeats. Everything is in memory. It reads routing metadata only —
// payloads are opaque Buffers it never inspects.

export type Direction = 'dstToSrc' | 'srcToDst'
export type MessageState = 'buffered' | 'delivered' | 'consumed'

export type MailboxItem = {
    seq: number
    messageId: string
    chunkIndex: number
    chunkCount: number
    epochTag: string
    respondsTo?: string
    sizeBytes: number
    payload: Buffer
    /** Meaningful on the lead chunk (chunkIndex 0). */
    msgState: MessageState
    deliveryCount: number
    createdAt: number
}

type Conn = {
    id: number
    ws: WebSocket
    phase: 'hello' | 'challenge' | 'admitted'
    claims?: RelayTokenClaims
    nonce?: Buffer
    missedPongs: number
    challengeTimer?: NodeJS.Timeout
}

export type SessionStatus = 'active' | 'closing' | 'closed' | 'errored'

export type Session = {
    relaySessionId: string
    studyId: string
    legId: string
    epoch: number
    status: SessionStatus
    sockets: Partial<Record<RelayRole, Conn>>
    fingerprints: Partial<Record<RelayRole, string>>
    mailbox: Record<Direction, MailboxItem[]>
    nextSeq: Record<Direction, number>
    closeAcks: Partial<Record<RelayRole, boolean>>
    closeTimer?: NodeJS.Timeout
    createdAt: number
}

export type FakeRelayOptions = {
    bmaPublicKeyPem: string
    heartbeatIntervalMs?: number
    limits?: Partial<RelayLimits>
    maxDeliveries?: number
    challengeTimeoutMs?: number
    closeTimeoutMs?: number
    tokenMaxAgeS?: number
    tokenGraceS?: number
    path?: string
}

export const DEFAULT_LIMITS: RelayLimits = {
    windowMsgs: 64,
    windowBytes: 32 * 1024 * 1024,
    maxChunkBytes: 32 * 1024,
    inlineCapBytes: 256 * 1024,
}

export const DISPLACED_CLOSE_CODE = 4000
export const REJECTED_CLOSE_CODE = 4001
export const SESSION_ENDED_CLOSE_CODE = 4002

export interface FakeRelayEvents {
    admitted: [relaySessionId: string, role: RelayRole, fingerprint: string]
    rejected: [code: RelayErrorCode]
    displaced: [relaySessionId: string, role: RelayRole]
    peerRejoined: [relaySessionId: string, peerRole: RelayRole]
    epochPurge: [relaySessionId: string, epoch: number, purged: number]
    data: [relaySessionId: string, direction: Direction, messageId: string, chunkIndex: number]
    delivered: [relaySessionId: string, direction: Direction, messageId: string, deliveryCount: number]
    ack: [relaySessionId: string, messageId: string, effect: 'consumed' | 'deleted' | 'noop']
    nack: [relaySessionId: string, messageId: string]
    backpressure: [relaySessionId: string, direction: Direction, messageId: string]
    deadLetter: [relaySessionId: string, messageId: string]
    close: [relaySessionId: string, phase: 'requested' | 'acked' | 'purged' | 'timeout']
    handshakeDropped: [relaySessionId: string, toRole: RelayRole]
}

const directionFor = (senderRole: RelayRole): Direction => (senderRole === 'destination' ? 'dstToSrc' : 'srcToDst')
const receivesFrom = (receiverRole: RelayRole): Direction => (receiverRole === 'source' ? 'dstToSrc' : 'srcToDst')
const peerOf = (role: RelayRole): RelayRole => (role === 'source' ? 'destination' : 'source')

export class FakeRelay extends EventEmitter<FakeRelayEvents> {
    readonly sessions = new Map<string, Session>()
    readonly limits: RelayLimits
    private readonly http: http.Server
    private readonly wss: WebSocketServer
    private conns = new Set<Conn>()
    private connSeq = 0
    private heartbeat: NodeJS.Timeout | null = null
    private pingEnabled = true
    private port = 0

    constructor(readonly options: FakeRelayOptions) {
        super()
        this.limits = { ...DEFAULT_LIMITS, ...options.limits }
        this.http = http.createServer((req, res) => this.handleHttp(req, res))
        this.wss = new WebSocketServer({ server: this.http, path: options.path ?? '/ws' })
        this.wss.on('connection', (ws) => this.onConnection(ws))
    }

    async start(port = 0): Promise<{ port: number; wsUrl: string; httpUrl: string }> {
        await new Promise<void>((resolve, reject) => {
            this.http.once('error', reject)
            this.http.listen(port, '127.0.0.1', () => resolve())
        })
        const address = this.http.address()
        this.port = typeof address === 'object' && address ? address.port : port
        const interval = this.options.heartbeatIntervalMs ?? 30_000
        this.heartbeat = setInterval(() => this.pingAll(), interval)
        this.heartbeat.unref()
        return { port: this.port, wsUrl: this.wsUrl, httpUrl: this.httpUrl }
    }

    get wsUrl(): string {
        return `ws://127.0.0.1:${this.port}${this.options.path ?? '/ws'}`
    }

    get httpUrl(): string {
        return `http://127.0.0.1:${this.port}`
    }

    async stop(): Promise<void> {
        if (this.heartbeat) clearInterval(this.heartbeat)
        for (const session of this.sessions.values()) if (session.closeTimer) clearTimeout(session.closeTimer)
        for (const conn of this.conns) {
            if (conn.challengeTimer) clearTimeout(conn.challengeTimer)
            conn.ws.terminate()
        }
        await new Promise<void>((resolve) => this.wss.close(() => resolve()))
        await new Promise<void>((resolve) => this.http.close(() => resolve()))
    }

    // ---- test hooks ---------------------------------------------------------------------------

    /** Drop a live socket without a close frame (simulates a network cut). */
    dropSocket(relaySessionId: string, role: RelayRole): boolean {
        const conn = this.sessions.get(relaySessionId)?.sockets[role]
        if (!conn) return false
        conn.ws.terminate()
        return true
    }

    setPingEnabled(enabled: boolean): void {
        this.pingEnabled = enabled
    }

    session(relaySessionId: string): Session | undefined {
        return this.sessions.get(relaySessionId)
    }

    isLive(relaySessionId: string, role: RelayRole): boolean {
        const conn = this.sessions.get(relaySessionId)?.sockets[role]
        return !!conn && conn.ws.readyState === WebSocket.OPEN
    }

    /** Messages (lead chunks) in a direction, in seq order — for assertions. */
    messages(relaySessionId: string, direction: Direction): MailboxItem[] {
        return (this.sessions.get(relaySessionId)?.mailbox[direction] ?? []).filter((i) => i.chunkIndex === 0)
    }

    // ---- HTTP (blob store lands in Phase 7) -------------------------------------------------------

    private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.url === '/api/health') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
            return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
    }

    // ---- admission --------------------------------------------------------------------------------

    private onConnection(ws: WebSocket): void {
        const conn: Conn = { id: ++this.connSeq, ws, phase: 'hello', missedPongs: 0 }
        this.conns.add(conn)
        ws.binaryType = 'nodebuffer'
        ws.on('message', (data) =>
            this.onMessage(conn, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)),
        )
        ws.on('pong', () => (conn.missedPongs = 0))
        ws.on('close', () => this.onClose(conn))
        ws.on('error', () => {})
    }

    private onMessage(conn: Conn, data: Buffer): void {
        let frame: Frame
        try {
            frame = decodeFrame(data)
        } catch {
            return this.reject(conn, 'PROTOCOL_VIOLATION', false, { detail: { reason: 'malformed frame' } })
        }
        switch (conn.phase) {
            case 'hello':
                if (frame.type !== 'HELLO') return this.reject(conn, 'PROTOCOL_VIOLATION', false)
                return this.onHello(conn, frame.header.token)
            case 'challenge':
                if (frame.type !== 'CHALLENGE_RESPONSE') return this.reject(conn, 'PROTOCOL_VIOLATION', false)
                return this.onChallengeResponse(conn, Buffer.from(frame.header.signature, 'base64url'))
            case 'admitted':
                return this.onAdmittedFrame(conn, frame)
        }
    }

    private onHello(conn: Conn, token: string): void {
        let decoded: unknown
        try {
            decoded = jwt.verify(token, this.options.bmaPublicKeyPem, {
                algorithms: ['RS256'],
                audience: RELAY_TOKEN_AUDIENCE,
                maxAge: `${this.options.tokenMaxAgeS ?? 900}s`,
                clockTolerance: this.options.tokenGraceS ?? 60,
            })
        } catch (error) {
            const expired = error instanceof jwt.TokenExpiredError
            return this.reject(conn, expired ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID', true)
        }
        const claims = RelayTokenClaimsSchema.safeParse(decoded)
        if (!claims.success) return this.reject(conn, 'AUTH_TOKEN_INVALID', false)
        conn.claims = claims.data
        conn.nonce = randomBytes(32)
        conn.phase = 'challenge'
        conn.challengeTimer = setTimeout(
            () => this.reject(conn, 'AUTH_POP_FAILED', false, { detail: { reason: 'challenge timeout' } }),
            this.options.challengeTimeoutMs ?? 10_000,
        )
        conn.challengeTimer.unref()
        this.sendFrame(conn.ws, { type: 'CHALLENGE', header: { nonce: conn.nonce.toString('base64url') } })
    }

    private onChallengeResponse(conn: Conn, signature: Buffer): void {
        if (conn.challengeTimer) clearTimeout(conn.challengeTimer)
        const claims = conn.claims!
        const payload = popPayload(conn.nonce!, claims.relaySessionId, claims.role)
        if (!verifyPop(Buffer.from(claims.popKey, 'base64url'), payload, signature)) {
            return this.reject(conn, 'AUTH_POP_FAILED', false)
        }
        this.admit(conn, claims)
    }

    private admit(conn: Conn, claims: RelayTokenClaims): void {
        let session = this.sessions.get(claims.relaySessionId)
        if (!session) {
            session = {
                relaySessionId: claims.relaySessionId,
                studyId: claims.studyId,
                legId: claims.legId,
                epoch: 0,
                status: 'active',
                sockets: {},
                fingerprints: {},
                mailbox: { dstToSrc: [], srcToDst: [] },
                nextSeq: { dstToSrc: 1, srcToDst: 1 },
                closeAcks: {},
                createdAt: Date.now(),
            }
            this.sessions.set(claims.relaySessionId, session)
        }
        if (session.status === 'closed' || session.status === 'errored') {
            return this.reject(
                conn,
                session.status === 'closed' ? 'SESSION_CLOSED' : 'SESSION_ERRORED_DEAD_LETTER',
                false,
            )
        }

        // One live connection per role: a valid re-admission displaces the previous socket.
        const previous = session.sockets[claims.role]
        if (previous && previous !== conn) {
            this.sendError(previous.ws, { code: 'AUTH_ROLE_OCCUPIED_DISPLACED', retryable: false })
            previous.phase = 'hello'
            delete session.sockets[claims.role]
            previous.ws.close(DISPLACED_CLOSE_CODE, 'displaced')
            this.emit('displaced', session.relaySessionId, claims.role)
        }

        conn.phase = 'admitted'
        session.sockets[claims.role] = conn
        const newFingerprint = session.fingerprints[claims.role] !== claims.fingerprint
        const firstAttach = session.fingerprints[claims.role] === undefined
        session.fingerprints[claims.role] = claims.fingerprint

        this.sendFrame(conn.ws, {
            type: 'ADMITTED',
            header: {
                relaySessionId: session.relaySessionId,
                legId: session.legId,
                role: claims.role,
                heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? 30_000,
                limits: this.limits,
            },
        })
        this.emit('admitted', session.relaySessionId, claims.role, claims.fingerprint)

        if (newFingerprint && !firstAttach) {
            // A restarted tunnel: everything buffered predates the handshake it is about to run.
            session.epoch++
            const purged = session.mailbox.dstToSrc.length + session.mailbox.srcToDst.length
            session.mailbox = { dstToSrc: [], srcToDst: [] }
            this.emit('epochPurge', session.relaySessionId, session.epoch, purged)
        }
        const peer = session.sockets[peerOf(claims.role)]
        if (peer && newFingerprint && !firstAttach) {
            this.sendFrame(peer.ws, { type: 'PEER_REJOINED', header: { peerRole: claims.role } })
            this.emit('peerRejoined', session.relaySessionId, claims.role)
        }
        this.redeliver(session, claims.role)
    }

    private reject(conn: Conn, code: RelayErrorCode, retryable: boolean, extra: Partial<ErrorHeader> = {}): void {
        if (conn.challengeTimer) clearTimeout(conn.challengeTimer)
        this.sendError(conn.ws, { code, retryable, ...extra })
        this.emit('rejected', code)
        conn.ws.close(REJECTED_CLOSE_CODE, code)
    }

    private onClose(conn: Conn): void {
        this.conns.delete(conn)
        if (conn.challengeTimer) clearTimeout(conn.challengeTimer)
        if (conn.phase !== 'admitted' || !conn.claims) return
        const session = this.sessions.get(conn.claims.relaySessionId)
        if (session && session.sockets[conn.claims.role] === conn) delete session.sockets[conn.claims.role]
    }

    // ---- admitted traffic -------------------------------------------------------------------------

    private onAdmittedFrame(conn: Conn, frame: Frame): void {
        const claims = conn.claims!
        const session = this.sessions.get(claims.relaySessionId)
        if (!session) return
        const role = claims.role
        switch (frame.type) {
            case 'DATA':
                return this.onData(session, role, frame.header, frame.payload)
            case 'ACK':
                return this.onAck(session, role, frame.header.messageId)
            case 'NACK_DISCARD':
                return this.onNack(session, role, frame.header.messageId)
            case 'HANDSHAKE': {
                const peer = session.sockets[peerOf(role)]
                if (peer && peer.ws.readyState === WebSocket.OPEN) this.sendFrame(peer.ws, frame)
                else this.emit('handshakeDropped', session.relaySessionId, peerOf(role))
                return
            }
            case 'CLOSE':
                return this.onCloseRequest(session, role, frame.payload)
            case 'CLOSE_ACK':
                return this.onCloseAck(session, role)
            default:
                this.sendError(conn.ws, { code: 'PROTOCOL_VIOLATION', retryable: false, detail: { frame: frame.type } })
        }
    }

    private onData(
        session: Session,
        sender: RelayRole,
        header: Frame extends { type: 'DATA'; header: infer H } ? H : never,
        payload: Buffer,
    ): void {
        if (session.status !== 'active') return
        const direction = directionFor(sender)
        const conn = session.sockets[sender]!
        if (payload.byteLength > this.limits.maxChunkBytes) {
            return this.sendError(conn.ws, { code: 'FRAME_TOO_LARGE', retryable: false, messageId: header.messageId })
        }
        if (header.chunkIndex === 0) {
            const leads = session.mailbox[direction].filter((i) => i.chunkIndex === 0 && i.msgState !== 'consumed')
            const bytes = leads.reduce((sum, i) => sum + i.sizeBytes, 0)
            if (leads.length >= this.limits.windowMsgs || bytes + header.sizeBytes > this.limits.windowBytes) {
                this.emit('backpressure', session.relaySessionId, direction, header.messageId)
                return this.sendError(conn.ws, { code: 'BACKPRESSURE', retryable: true, messageId: header.messageId })
            }
        }
        const item: MailboxItem = {
            seq: session.nextSeq[direction]++,
            messageId: header.messageId,
            chunkIndex: header.chunkIndex,
            chunkCount: header.chunkCount,
            epochTag: header.epochTag,
            respondsTo: header.respondsTo,
            sizeBytes: header.sizeBytes,
            payload: Buffer.from(payload),
            msgState: 'buffered',
            deliveryCount: 0,
            createdAt: Date.now(),
        }
        session.mailbox[direction].push(item)
        this.emit('data', session.relaySessionId, direction, header.messageId, header.chunkIndex)
        // store-then-push: only when the whole message is present do we push it, in seq order
        this.pushReady(session, peerOf(sender))
    }

    /** Push every complete, not-yet-delivered message toward `receiver` if its socket is live. */
    private pushReady(session: Session, receiver: RelayRole): void {
        const peer = session.sockets[receiver]
        if (!peer || peer.ws.readyState !== WebSocket.OPEN) return
        const direction = receivesFrom(receiver)
        for (const lead of session.mailbox[direction].filter((i) => i.chunkIndex === 0 && i.msgState === 'buffered')) {
            const chunks = session.mailbox[direction].filter((i) => i.messageId === lead.messageId)
            if (chunks.length < lead.chunkCount) continue
            this.deliver(session, receiver, lead, chunks)
        }
    }

    private deliver(session: Session, receiver: RelayRole, lead: MailboxItem, chunks: MailboxItem[]): void {
        const peer = session.sockets[receiver]
        if (!peer) return
        lead.deliveryCount++
        if (lead.deliveryCount > (this.options.maxDeliveries ?? 5)) return this.deadLetter(session, lead.messageId)
        if (lead.msgState === 'buffered') lead.msgState = 'delivered'
        for (const chunk of [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
            this.sendFrame(peer.ws, {
                type: 'DATA',
                header: {
                    messageId: chunk.messageId,
                    chunkIndex: chunk.chunkIndex,
                    chunkCount: chunk.chunkCount,
                    epochTag: chunk.epochTag,
                    ...(chunk.respondsTo ? { respondsTo: chunk.respondsTo } : {}),
                    sizeBytes: chunk.sizeBytes,
                    seq: chunk.seq,
                },
                payload: chunk.payload,
            })
        }
        this.emit('delivered', session.relaySessionId, receivesFrom(receiver), lead.messageId, lead.deliveryCount)
    }

    /** On (re)attach: redeliver every complete un-consumed message toward this role, in seq order. */
    private redeliver(session: Session, receiver: RelayRole): void {
        const direction = receivesFrom(receiver)
        for (const lead of session.mailbox[direction].filter((i) => i.chunkIndex === 0 && i.msgState !== 'consumed')) {
            const chunks = session.mailbox[direction].filter((i) => i.messageId === lead.messageId)
            if (chunks.length < lead.chunkCount) continue
            this.deliver(session, receiver, lead, chunks)
            if (session.status !== 'active') return
        }
    }

    private onAck(session: Session, acker: RelayRole, messageId: string): void {
        const direction = receivesFrom(acker)
        const lead = session.mailbox[direction].find((i) => i.messageId === messageId && i.chunkIndex === 0)
        // Forward the end-to-end ACK to the sender so it can evict its outbox (v2 §7.1 step 6).
        const sender = session.sockets[peerOf(acker)]
        if (sender && sender.ws.readyState === WebSocket.OPEN)
            this.sendFrame(sender.ws, { type: 'ACK', header: { messageId } })
        if (!lead) return void this.emit('ack', session.relaySessionId, messageId, 'noop')
        if (lead.respondsTo) {
            // A response: delete it and the retained query it answers (the round is complete).
            this.remove(session, direction, messageId)
            this.remove(session, direction === 'dstToSrc' ? 'srcToDst' : 'dstToSrc', lead.respondsTo)
            this.emit('ack', session.relaySessionId, messageId, 'deleted')
        } else {
            // A query: consumed but retained until its correlated response completes stage two.
            lead.msgState = 'consumed'
            this.emit('ack', session.relaySessionId, messageId, 'consumed')
        }
    }

    private onNack(session: Session, receiver: RelayRole, messageId: string): void {
        this.remove(session, receivesFrom(receiver), messageId)
        this.emit('nack', session.relaySessionId, messageId)
    }

    private remove(session: Session, direction: Direction, messageId: string): void {
        session.mailbox[direction] = session.mailbox[direction].filter((i) => i.messageId !== messageId)
    }

    private deadLetter(session: Session, messageId: string): void {
        session.status = 'errored'
        this.emit('deadLetter', session.relaySessionId, messageId)
        this.endSession(session, { code: 'SESSION_ERRORED_DEAD_LETTER', retryable: false, messageId })
    }

    // ---- close ------------------------------------------------------------------------------------

    private onCloseRequest(session: Session, requester: RelayRole, payload: Buffer): void {
        if (session.status !== 'active' && session.status !== 'closing') return
        session.status = 'closing'
        this.emit('close', session.relaySessionId, 'requested')
        const peer = session.sockets[peerOf(requester)]
        if (peer && peer.ws.readyState === WebSocket.OPEN)
            this.sendFrame(peer.ws, { type: 'CLOSE', header: {}, payload })
        if (!session.closeTimer) {
            session.closeTimer = setTimeout(() => {
                this.emit('close', session.relaySessionId, 'timeout')
                this.finishClose(session)
            }, this.options.closeTimeoutMs ?? 30_000)
            session.closeTimer.unref()
        }
    }

    private onCloseAck(session: Session, acker: RelayRole): void {
        if (session.status !== 'closing') return
        session.closeAcks[acker] = true
        this.emit('close', session.relaySessionId, 'acked')
        const peer = session.sockets[peerOf(acker)]
        if (peer && peer.ws.readyState === WebSocket.OPEN) this.sendFrame(peer.ws, { type: 'CLOSE_ACK', header: {} })
        if (session.closeAcks.source && session.closeAcks.destination) this.finishClose(session)
    }

    private finishClose(session: Session): void {
        if (session.closeTimer) clearTimeout(session.closeTimer)
        session.closeTimer = undefined
        session.status = 'closed'
        this.endSession(session, { code: 'SESSION_CLOSED', retryable: false })
        this.emit('close', session.relaySessionId, 'purged')
    }

    /** Purge mailboxes, notify live sockets, and close them. */
    private endSession(session: Session, error: ErrorHeader): void {
        session.mailbox = { dstToSrc: [], srcToDst: [] }
        for (const role of ['source', 'destination'] as const) {
            const conn = session.sockets[role]
            if (!conn) continue
            if (conn.ws.readyState === WebSocket.OPEN) {
                this.sendError(conn.ws, error)
                conn.ws.close(SESSION_ENDED_CLOSE_CODE, error.code)
            }
            delete session.sockets[role]
        }
    }

    // ---- plumbing ---------------------------------------------------------------------------------

    private pingAll(): void {
        if (!this.pingEnabled) return
        for (const conn of this.conns) {
            if (conn.ws.readyState !== WebSocket.OPEN) continue
            if (conn.missedPongs >= 2) {
                conn.ws.terminate()
                continue
            }
            conn.missedPongs++
            conn.ws.ping()
        }
    }

    private sendFrame(ws: WebSocket, frame: Frame): void {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame))
    }

    private sendError(ws: WebSocket, header: ErrorHeader): void {
        this.sendFrame(ws, { type: 'ERROR', header })
    }
}

export const startFakeRelay = async (options: Partial<FakeRelayOptions> & { bmaPublicKeyPem: string }) => {
    const relay = new FakeRelay(options)
    await relay.start()
    return relay
}
