import { EventEmitter } from 'node:events'
import http from 'node:http'
import jwt from 'jsonwebtoken'
import WebSocket, { WebSocketServer } from 'ws'
import {
    closeCodeFor,
    decodeFrame,
    encodeFrame,
    newNonce,
    popPublicKeyFromRaw,
    RELAY_TOKEN_AUDIENCE,
    RelayTokenClaims,
    verifyPop,
    type ErrorHeader,
    type ErrorCode,
    type Frame,
    type PeerHeader,
    type Role,
} from '@/relay-protocol'

// In-repo test double for the Fusion Relay, built on the verbatim protocol copy: token + PoP
// admission, one live socket per role with displacement, pairing by relaySessionId, peer-presence
// frames carrying the peer's fingerprint, forwarding of DATA/ACK/NACK/HANDSHAKE to a live peer
// (dropped otherwise), CLOSE orchestration with a close timeout, and heartbeats. It stores nothing
// and reads routing metadata only — payloads are opaque Buffers it never inspects.

type Conn = {
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
    status: SessionStatus
    sockets: Partial<Record<Role, Conn>>
    fingerprints: Partial<Record<Role, string>>
    closeAcks: Partial<Record<Role, boolean>>
    closeTimer?: NodeJS.Timeout
    /** The authenticated CLOSE payload, held for a peer that attaches during `closing`. */
    pendingClose?: { from: Role; payload: Buffer }
    forwarded: number
}

export type FakeRelayOptions = {
    bmaPublicKeyPem: string
    heartbeatIntervalMs?: number
    challengeTimeoutMs?: number
    closeTimeoutMs?: number
    tokenMaxAgeS?: number
    tokenGraceS?: number
    /** Bind address; 127.0.0.1 by default, 0.0.0.0 for compose. */
    host?: string
    path?: string
}

export interface FakeRelayEvents {
    admitted: [relaySessionId: string, role: Role, fingerprint: string]
    rejected: [code: ErrorCode]
    displaced: [relaySessionId: string, role: Role]
    peer: [relaySessionId: string, toRole: Role, peer: PeerHeader]
    forwarded: [relaySessionId: string, from: Role, frame: Frame]
    dropped: [relaySessionId: string, from: Role, frame: Frame]
    close: [relaySessionId: string, phase: 'requested' | 'acked' | 'purged' | 'timeout' | 'forced']
}

const peerOf = (role: Role): Role => (role === 'source' ? 'destination' : 'source')

export class FakeRelay extends EventEmitter<FakeRelayEvents> {
    readonly sessions = new Map<string, Session>()
    private readonly http: http.Server
    private readonly wss: WebSocketServer
    private readonly conns = new Set<Conn>()
    private heartbeat: NodeJS.Timeout | null = null
    private pingEnabled = true
    private port = 0
    private readonly frameDrops = new Map<string, number>() // `${role}:${type}` → count

    constructor(readonly options: FakeRelayOptions) {
        super()
        this.http = http.createServer((req, res) => {
            const health = new URL(req.url ?? '/', 'http://relay').pathname === '/api/health'
            res.writeHead(health ? 200 : 404, { 'content-type': 'application/json' })
            res.end(JSON.stringify(health ? { success: true } : { error: 'not found' }))
        })
        this.wss = new WebSocketServer({ server: this.http, path: options.path ?? '/ws' })
        this.wss.on('connection', (ws) => this.onConnection(ws))
    }

    async start(port = 0): Promise<{ port: number; wsUrl: string; httpUrl: string }> {
        await new Promise<void>((resolve, reject) => {
            this.http.once('error', reject)
            this.http.listen(port, this.options.host ?? '127.0.0.1', () => resolve())
        })
        const address = this.http.address()
        this.port = typeof address === 'object' && address ? address.port : port
        const interval = this.options.heartbeatIntervalMs ?? 30_000
        if (interval > 0) {
            this.heartbeat = setInterval(() => this.pingAll(), interval)
            this.heartbeat.unref()
        }
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
    dropSocket(relaySessionId: string, role: Role): boolean {
        const conn = this.sessions.get(relaySessionId)?.sockets[role]
        if (!conn) return false
        conn.ws.terminate()
        return true
    }

    setPingEnabled(enabled: boolean): void {
        this.pingEnabled = enabled
    }

    /** Swallow the next `count` frames of `type` sent by `role` (a lost ACK, a lost CLOSE_ACK…). */
    dropNext(role: Role, type: Frame['type'], count = 1): void {
        const key = `${role}:${type}`
        this.frameDrops.set(key, (this.frameDrops.get(key) ?? 0) + count)
    }

    /** Push an arbitrary frame to a live socket as if the relay had originated it. */
    injectFrame(relaySessionId: string, role: Role, frame: Frame): boolean {
        const conn = this.sessions.get(relaySessionId)?.sockets[role]
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false
        this.sendFrame(conn.ws, frame)
        return true
    }

    /** End a session with SESSION_CLOSED without any CLOSE having been exchanged (a relay-forced end). */
    forceClose(relaySessionId: string): boolean {
        const session = this.sessions.get(relaySessionId)
        if (!session) return false
        this.endSession(session, 'closed', 'SESSION_CLOSED')
        this.emit('close', relaySessionId, 'forced')
        return true
    }

    session(relaySessionId: string): Session | undefined {
        return this.sessions.get(relaySessionId)
    }

    isLive(relaySessionId: string, role: Role): boolean {
        const conn = this.sessions.get(relaySessionId)?.sockets[role]
        return !!conn && conn.ws.readyState === WebSocket.OPEN
    }

    // ---- admission --------------------------------------------------------------------------------

    private onConnection(ws: WebSocket): void {
        const conn: Conn = { ws, phase: 'hello', missedPongs: 0 }
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
            return this.reject(conn, 'PROTOCOL_VIOLATION', 'malformed frame')
        }
        switch (conn.phase) {
            case 'hello':
                if (frame.type !== 'HELLO')
                    return this.reject(conn, 'PROTOCOL_VIOLATION', `expected HELLO, got ${frame.type}`)
                return this.onHello(conn, frame.header)
            case 'challenge':
                if (frame.type !== 'CHALLENGE_RESPONSE') return this.reject(conn, 'PROTOCOL_VIOLATION')
                return this.onChallengeResponse(conn, Buffer.from(frame.header.signature, 'base64url'))
            case 'admitted':
                return this.onAdmittedFrame(conn, frame)
        }
    }

    private onHello(conn: Conn, hello: { token: string; relaySessionId: string; role: Role }): void {
        let decoded: unknown
        try {
            decoded = jwt.verify(hello.token, this.options.bmaPublicKeyPem, {
                algorithms: ['RS256'],
                audience: RELAY_TOKEN_AUDIENCE,
                maxAge: `${this.options.tokenMaxAgeS ?? 900}s`,
                clockTolerance: this.options.tokenGraceS ?? 60,
            })
        } catch (error) {
            return this.reject(
                conn,
                error instanceof jwt.TokenExpiredError ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID',
            )
        }
        const claims = RelayTokenClaims.safeParse(decoded)
        if (!claims.success) return this.reject(conn, 'AUTH_TOKEN_INVALID')
        if (hello.relaySessionId !== claims.data.relaySessionId || hello.role !== claims.data.role) {
            return this.reject(conn, 'AUTH_TOKEN_INVALID', 'token does not match the declared session/role')
        }
        conn.claims = claims.data
        conn.nonce = newNonce()
        conn.phase = 'challenge'
        conn.challengeTimer = setTimeout(
            () => this.reject(conn, 'PROTOCOL_VIOLATION', 'challenge timeout'),
            this.options.challengeTimeoutMs ?? 10_000,
        )
        conn.challengeTimer.unref()
        this.sendFrame(conn.ws, { type: 'CHALLENGE', header: { nonce: conn.nonce.toString('base64url') } })
    }

    private onChallengeResponse(conn: Conn, signature: Buffer): void {
        if (conn.challengeTimer) clearTimeout(conn.challengeTimer)
        const claims = conn.claims!
        let ok: boolean
        try {
            ok = verifyPop(
                popPublicKeyFromRaw(claims.popKey),
                conn.nonce!,
                claims.relaySessionId,
                claims.role,
                signature,
            )
        } catch {
            ok = false
        }
        if (!ok) return this.reject(conn, 'AUTH_POP_FAILED')
        this.admit(conn, claims)
    }

    private admit(conn: Conn, claims: RelayTokenClaims): void {
        let session = this.sessions.get(claims.relaySessionId)
        if (!session) {
            session = {
                relaySessionId: claims.relaySessionId,
                studyId: claims.studyId,
                legId: claims.legId,
                status: 'active',
                sockets: {},
                fingerprints: {},
                closeAcks: {},
                forwarded: 0,
            }
            this.sessions.set(claims.relaySessionId, session)
        }
        if (session.status === 'closed' || session.status === 'errored') return this.reject(conn, 'SESSION_CLOSED')

        // One live connection per role: a valid re-admission displaces the previous socket.
        const previous = session.sockets[claims.role]
        if (previous && previous !== conn) {
            previous.phase = 'hello'
            delete session.sockets[claims.role]
            this.sendError(previous.ws, { code: 'AUTH_ROLE_OCCUPIED_DISPLACED', retryable: false })
            previous.ws.close(closeCodeFor('AUTH_ROLE_OCCUPIED_DISPLACED'), 'AUTH_ROLE_OCCUPIED_DISPLACED')
            this.emit('displaced', session.relaySessionId, claims.role)
        }
        conn.phase = 'admitted'
        session.sockets[claims.role] = conn
        session.fingerprints[claims.role] = claims.fingerprint
        const peerRole = peerOf(claims.role)
        this.sendFrame(conn.ws, {
            type: 'ADMITTED',
            header: {
                relaySessionId: session.relaySessionId,
                legId: session.legId,
                role: claims.role,
                heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? 30_000,
                peer: this.peerHeader(session, peerRole),
            },
        })
        this.emit('admitted', session.relaySessionId, claims.role, claims.fingerprint)
        const peer = session.sockets[peerRole]
        if (peer && peer.ws.readyState === WebSocket.OPEN) {
            const header = this.peerHeader(session, claims.role)
            this.sendFrame(peer.ws, { type: 'PEER', header })
            this.emit('peer', session.relaySessionId, peerRole, header)
        }
        if (session.status === 'closing' && session.pendingClose && session.pendingClose.from !== claims.role) {
            this.sendFrame(conn.ws, { type: 'CLOSE', header: {}, payload: session.pendingClose.payload })
        }
    }

    private reject(conn: Conn, code: ErrorCode, detail?: string): void {
        if (conn.challengeTimer) clearTimeout(conn.challengeTimer)
        this.sendError(conn.ws, { code, retryable: code === 'AUTH_TOKEN_EXPIRED', ...(detail ? { detail } : {}) })
        this.emit('rejected', code)
        conn.ws.close(closeCodeFor(code), code)
    }

    private onClose(conn: Conn): void {
        this.conns.delete(conn)
        if (conn.challengeTimer) clearTimeout(conn.challengeTimer)
        if (conn.phase !== 'admitted' || !conn.claims) return
        const session = this.sessions.get(conn.claims.relaySessionId)
        if (!session || session.sockets[conn.claims.role] !== conn) return
        delete session.sockets[conn.claims.role]
        const peer = session.sockets[peerOf(conn.claims.role)]
        if (peer && peer.ws.readyState === WebSocket.OPEN) {
            const header: PeerHeader = { attached: false, fingerprint: session.fingerprints[conn.claims.role] }
            this.sendFrame(peer.ws, { type: 'PEER', header })
            this.emit('peer', session.relaySessionId, peerOf(conn.claims.role), header)
        }
    }

    // ---- admitted traffic -------------------------------------------------------------------------

    private onAdmittedFrame(conn: Conn, frame: Frame): void {
        const claims = conn.claims!
        const session = this.sessions.get(claims.relaySessionId)
        if (!session || session.sockets[claims.role] !== conn) return
        const role = claims.role
        const dropKey = `${role}:${frame.type}`
        const drops = this.frameDrops.get(dropKey) ?? 0
        if (drops > 0) {
            this.frameDrops.set(dropKey, drops - 1)
            return
        }
        switch (frame.type) {
            case 'DATA':
            case 'ACK':
            case 'NACK':
            case 'HANDSHAKE':
                if (frame.type === 'DATA' && session.status !== 'active' && session.status !== 'closing') return
                return this.forward(session, role, frame)
            case 'CLOSE':
                return this.onCloseRequest(session, role, frame)
            case 'CLOSE_ACK':
                return this.onCloseAck(session, role, frame)
            default:
                this.sendError(conn.ws, {
                    code: 'PROTOCOL_VIOLATION',
                    retryable: false,
                    detail: `unexpected ${frame.type}`,
                })
        }
    }

    private forward(session: Session, from: Role, frame: Frame): void {
        const peer = session.sockets[peerOf(from)]
        if (peer && peer.ws.readyState === WebSocket.OPEN) {
            this.sendFrame(peer.ws, frame)
            session.forwarded++
            this.emit('forwarded', session.relaySessionId, from, frame)
        } else {
            this.emit('dropped', session.relaySessionId, from, frame)
        }
    }

    // ---- close ------------------------------------------------------------------------------------

    private onCloseRequest(session: Session, requester: Role, frame: Extract<Frame, { type: 'CLOSE' }>): void {
        if (session.status !== 'active' && session.status !== 'closing') return
        const first = session.status === 'active'
        session.status = 'closing'
        session.closeAcks[requester] = true // the requester's own CLOSE is its acknowledgement
        session.pendingClose = { from: requester, payload: Buffer.from(frame.payload) }
        if (first) this.emit('close', session.relaySessionId, 'requested')
        this.forward(session, requester, frame)
        if (!session.closeTimer) {
            session.closeTimer = setTimeout(() => {
                this.emit('close', session.relaySessionId, 'timeout')
                this.endSession(session, 'closed', 'SESSION_CLOSED')
                this.emit('close', session.relaySessionId, 'purged')
            }, this.options.closeTimeoutMs ?? 30_000)
            session.closeTimer.unref()
        }
    }

    private onCloseAck(session: Session, acker: Role, frame: Extract<Frame, { type: 'CLOSE_ACK' }>): void {
        if (session.status !== 'closing') return
        session.closeAcks[acker] = true
        this.emit('close', session.relaySessionId, 'acked')
        this.forward(session, acker, frame)
        if (session.closeAcks.source && session.closeAcks.destination) {
            this.endSession(session, 'closed', 'SESSION_CLOSED')
            this.emit('close', session.relaySessionId, 'purged')
        }
    }

    /** Notify live sockets, close them, forget the session. */
    private endSession(session: Session, status: 'closed' | 'errored', code: ErrorCode): void {
        if (session.closeTimer) clearTimeout(session.closeTimer)
        session.closeTimer = undefined
        session.status = status
        session.pendingClose = undefined
        for (const role of ['source', 'destination'] as const) {
            const conn = session.sockets[role]
            if (!conn) continue
            if (conn.ws.readyState === WebSocket.OPEN) {
                this.sendError(conn.ws, { code, retryable: false })
                conn.ws.close(closeCodeFor(code), code)
            }
            delete session.sockets[role]
        }
    }

    // ---- plumbing ---------------------------------------------------------------------------------

    private peerHeader(session: Session, role: Role): PeerHeader {
        const conn = session.sockets[role]
        const fingerprint = session.fingerprints[role]
        return { attached: !!conn && conn.ws.readyState === WebSocket.OPEN, ...(fingerprint ? { fingerprint } : {}) }
    }

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
