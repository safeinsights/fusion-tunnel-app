import { EventEmitter } from 'node:events'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import {
    PublishKeyRequestSchema,
    StatusReportSchema,
    TUNNEL_CREDENTIAL_AUDIENCE,
    DelegatedCredentialClaimsSchema,
    type DelegatedCredentialClaims,
    type PeerKeyResponse,
    type PublishKeyRequest,
    type RunLeg,
    type RunStatus,
    type StatusReport,
} from '@/schemas/bma'
import type { CapsConsumed, Role } from '@/schemas/provisioning'
import { mintRelayToken, testBmaKey, type BmaKeypair } from '@/testing/relay-tokens'

// In-repo test double for the Management App's fusion extensions (plan Phase 6), built on
// schemas/bma.ts so it doubles as the BMA team's executable contract. Directory rows and the
// generation counter are keyed by (study, leg, org); one relay session and one nonce per leg;
// run groups become visible only when every leg is launch-eligible and a launch-window expiry
// fails all legs atomically; status ingestion retains the cap counters and serves them back as
// capsConsumed. Org-JWT (Setup App) and delegated-credential (tunnel) authentication are real:
// RS256 against registered org keys and the BMA's own key respectively.

export const ORG_JWT_AUDIENCE = 'safeinsights:bma'

export type DirectoryRow = PublishKeyRequest & { orgSlug: string; generation: number; publishedAt: number }

export type LegSession = {
    relaySessionId: string
    sessionNonce: string
}

export type Run = {
    studyId: string
    legs: RunLeg[]
    status: RunStatus
    eligible: Set<string> // `${legId}:${role}`
    launched: Set<string>
    launchWindowMs: number
    windowTimer?: NodeJS.Timeout
    failureReason?: string
}

export type FakeBmaOptions = {
    key?: BmaKeypair
    relayEndpoint: string
    /** org slug → SPKI PEM; org-JWTs are verified against these. */
    orgs?: Record<string, string>
    relayTokenTtlS?: number
    credentialTtlS?: number
    defaultLaunchWindowMs?: number
}

export interface FakeBmaEvents {
    keyPublished: [row: DirectoryRow]
    peerKeyServed: [legId: string, forOrg: string, generation: number]
    relaySessionIssued: [legId: string, role: Role, caller: 'org' | 'tunnel']
    credentialIssued: [legId: string, role: Role]
    statusReceived: [report: StatusReport]
    runVisible: [studyId: string]
    runPaired: [studyId: string]
    runFailed: [studyId: string, reason: string]
    unauthorized: [path: string, reason: string]
}

type Auth =
    | { kind: 'org'; orgSlug: string }
    | { kind: 'tunnel'; claims: DelegatedCredentialClaims }
    | { kind: 'none'; reason: string }

export class FakeBma extends EventEmitter<FakeBmaEvents> {
    readonly key: BmaKeypair
    readonly rows: DirectoryRow[] = []
    readonly sessions = new Map<string, LegSession>() // `${studyId}/${legId}`
    readonly reports: StatusReport[] = []
    readonly runs = new Map<string, Run>()
    readonly orgs: Record<string, string>
    /** Pending failures to inject: path prefix → count. */
    private failures = new Map<string, number>()
    private latencyMs = 0
    private readonly server: http.Server
    private port = 0

    constructor(readonly options: FakeBmaOptions) {
        super()
        this.key = options.key ?? testBmaKey()
        this.orgs = { ...options.orgs }
        this.server = http.createServer((req, res) => void this.handle(req, res))
    }

    async start(port = 0): Promise<string> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject)
            this.server.listen(port, '127.0.0.1', () => resolve())
        })
        const address = this.server.address()
        this.port = typeof address === 'object' && address ? address.port : port
        return this.url
    }

    get url(): string {
        return `http://127.0.0.1:${this.port}`
    }

    async stop(): Promise<void> {
        for (const run of this.runs.values()) if (run.windowTimer) clearTimeout(run.windowTimer)
        await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }

    // ---- test hooks ---------------------------------------------------------------------------

    registerOrg(orgSlug: string, publicKeyPem: string): void {
        this.orgs[orgSlug] = publicKeyPem
    }

    /** Publish a row directly (a "Setup App" that already signed). Returns the assigned generation. */
    publishKey(row: PublishKeyRequest, orgSlug: string): number {
        const generation = this.nextGeneration(row.studyId, row.legId, orgSlug)
        const stored: DirectoryRow = { ...row, orgSlug, generation, publishedAt: Date.now() }
        this.rows.push(stored)
        this.emit('keyPublished', stored)
        return generation
    }

    /** Re-append the latest row for (study, leg, org) under a new generation. */
    advanceGeneration(studyId: string, legId: string, orgSlug: string): number | undefined {
        const latest = this.latest(studyId, legId, orgSlug)
        if (!latest) return undefined
        const { generation: _g, publishedAt: _p, orgSlug: _o, ...row } = latest
        return this.publishKey(row, orgSlug)
    }

    /** Make the next `count` requests to paths starting with `prefix` fail with 503. */
    failNext(prefix: string, count = 1): void {
        this.failures.set(prefix, (this.failures.get(prefix) ?? 0) + count)
    }

    setLatency(ms: number): void {
        this.latencyMs = ms
    }

    latest(studyId: string, legId: string, orgSlug: string): DirectoryRow | undefined {
        return this.rows
            .filter((r) => r.studyId === studyId && r.legId === legId && r.orgSlug === orgSlug)
            .sort((a, b) => b.generation - a.generation)[0]
    }

    /** Last reported cap counters for a source leg — what a re-provision re-seeds from. */
    consumedFor(studyId: string, legId: string): CapsConsumed | undefined {
        const last = [...this.reports]
            .reverse()
            .find((r) => r.studyId === studyId && r.legId === legId && r.role === 'source' && r.caps)
        return last?.caps?.consumed
    }

    /** Session (id + nonce) for a leg; created on first use so both sides get the same values. */
    sessionFor(studyId: string, legId: string): LegSession {
        const key = `${studyId}/${legId}`
        let session = this.sessions.get(key)
        if (!session) {
            session = { relaySessionId: `rs-${uuidv4()}`, sessionNonce: randomBytes(32).toString('base64url') }
            this.sessions.set(key, session)
        }
        return session
    }

    mintCredential(
        claims: Omit<DelegatedCredentialClaims, 'aud' | 'iss' | 'exp' | 'iat' | 'component'>,
        ttlS?: number,
    ): { credential: string; expiresAt: string } {
        const now = Math.floor(Date.now() / 1000)
        const exp = now + (ttlS ?? this.options.credentialTtlS ?? 900)
        const credential = jwt.sign(
            { aud: TUNNEL_CREDENTIAL_AUDIENCE, iss: 'fake-bma', iat: now, exp, component: 'tunnel', ...claims },
            this.key.privateKey,
            { algorithm: 'RS256' },
        )
        return { credential, expiresAt: new Date(exp * 1000).toISOString() }
    }

    // ---- run groups ---------------------------------------------------------------------------

    registerRun(studyId: string, legs: RunLeg[], launchWindowMs?: number): Run {
        const run: Run = {
            studyId,
            legs,
            status: 'pending',
            eligible: new Set(),
            launched: new Set(),
            launchWindowMs: launchWindowMs ?? this.options.defaultLaunchWindowMs ?? 900_000,
        }
        this.runs.set(studyId, run)
        return run
    }

    /** A side of a leg is launch-eligible; the run becomes visible only when every side of every leg is. */
    setEligible(studyId: string, legId: string, role: Role, eligible = true): void {
        const run = this.runs.get(studyId)
        if (!run) throw new Error(`unknown run ${studyId}`)
        const key = `${legId}:${role}`
        if (eligible) run.eligible.add(key)
        else run.eligible.delete(key)
        const all = run.legs.every(
            (leg) => run.eligible.has(`${leg.legId}:source`) && run.eligible.has(`${leg.legId}:destination`),
        )
        if (all && run.status === 'pending') {
            run.status = 'visible'
            this.emit('runVisible', studyId)
        }
    }

    /** A Setup App reports its side launched; the launch window starts at the first report. */
    reportLaunch(studyId: string, legId: string, role: Role): Run {
        const run = this.runs.get(studyId)
        if (!run) throw new Error(`unknown run ${studyId}`)
        if (run.status !== 'visible' && run.status !== 'paired-running') return run
        run.launched.add(`${legId}:${role}`)
        if (!run.windowTimer && run.status === 'visible') {
            run.windowTimer = setTimeout(() => this.failRun(studyId, 'launch window expired'), run.launchWindowMs)
            run.windowTimer.unref()
        }
        const all = run.legs.every(
            (leg) => run.launched.has(`${leg.legId}:source`) && run.launched.has(`${leg.legId}:destination`),
        )
        if (all) {
            if (run.windowTimer) clearTimeout(run.windowTimer)
            run.windowTimer = undefined
            run.status = 'paired-running'
            this.emit('runPaired', studyId)
        }
        return run
    }

    /** The hub's terminal job status: every source job of the study is marked complete. */
    completeRun(studyId: string): void {
        const run = this.runs.get(studyId)
        if (!run) return
        if (run.windowTimer) clearTimeout(run.windowTimer)
        run.status = 'complete'
    }

    /** Atomic: every leg of the run fails together (plan §10, memo §2.4). */
    failRun(studyId: string, reason: string): void {
        const run = this.runs.get(studyId)
        if (!run || run.status === 'complete' || run.status === 'failed') return
        if (run.windowTimer) clearTimeout(run.windowTimer)
        run.windowTimer = undefined
        run.status = 'failed'
        run.failureReason = reason
        this.emit('runFailed', studyId, reason)
    }

    // ---- http -------------------------------------------------------------------------------

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://bma')
        if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs))
        for (const [prefix, count] of this.failures) {
            if (count > 0 && url.pathname.startsWith(prefix)) {
                this.failures.set(prefix, count - 1)
                return this.json(res, 503, { error: 'injected failure' })
            }
        }
        const body = await this.readJson(req)
        const auth = this.authenticate(req)
        try {
            switch (`${req.method} ${url.pathname}`) {
                case 'PUT /tunnel/keys':
                    return this.putKeys(res, auth, body)
                case 'GET /tunnel/peer-key':
                    return this.getPeerKey(res, auth, url)
                case 'GET /tunnel/relay-session':
                    return this.getRelaySession(res, auth, url)
                case 'POST /tunnel/credential':
                    return this.postCredential(res, auth)
                case 'POST /tunnel/status':
                    return this.postStatus(res, auth, body)
                case 'GET /tunnel/consumed':
                    return this.getConsumed(res, auth, url)
                case 'GET /tunnel/runs':
                    return this.getRuns(res, auth, url)
                case 'POST /tunnel/runs/launched':
                    return this.postLaunched(res, auth, body)
                case 'GET /api/health':
                    return this.json(res, 200, { success: true })
                case 'GET /api/public-key':
                    // harness only: lets a containerized fake relay learn the BMA verification key
                    return this.json(res, 200, { pem: this.key.publicPem })
                case 'POST /api/orgs': {
                    // harness only: a containerized fake Setup App registers its freshly generated org key
                    const b = body as { slug?: string; pem?: string }
                    if (!b?.slug || !b.pem) return this.json(res, 400, { error: 'slug and pem required' })
                    this.registerOrg(b.slug, b.pem)
                    return this.json(res, 201, { slug: b.slug })
                }
                default:
                    return this.json(res, 404, { error: 'not found' })
            }
        } catch (error) {
            this.json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
    }

    private authenticate(req: http.IncomingMessage): Auth {
        const header = req.headers.authorization
        const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1]
        if (!token) return { kind: 'none', reason: 'missing bearer' }
        const decoded = jwt.decode(token)
        if (!decoded || typeof decoded !== 'object') return { kind: 'none', reason: 'undecodable' }
        if (decoded.aud === TUNNEL_CREDENTIAL_AUDIENCE) {
            try {
                const verified = jwt.verify(token, this.key.publicPem, {
                    algorithms: ['RS256'],
                    audience: TUNNEL_CREDENTIAL_AUDIENCE,
                })
                const claims = DelegatedCredentialClaimsSchema.safeParse(verified)
                if (!claims.success) return { kind: 'none', reason: 'bad credential claims' }
                return { kind: 'tunnel', claims: claims.data }
            } catch (error) {
                return { kind: 'none', reason: `credential: ${error instanceof Error ? error.message : 'invalid'}` }
            }
        }
        const iss = typeof decoded.iss === 'string' ? decoded.iss : undefined
        const orgKey = iss ? this.orgs[iss] : undefined
        if (!iss || !orgKey) return { kind: 'none', reason: 'unknown org' }
        try {
            jwt.verify(token, orgKey, { algorithms: ['RS256'], audience: ORG_JWT_AUDIENCE, maxAge: '10m' })
            return { kind: 'org', orgSlug: iss }
        } catch (error) {
            return { kind: 'none', reason: `org-jwt: ${error instanceof Error ? error.message : 'invalid'}` }
        }
    }

    private requireOrg(res: http.ServerResponse, auth: Auth, path: string): string | undefined {
        if (auth.kind === 'org') return auth.orgSlug
        this.emit('unauthorized', path, auth.kind === 'none' ? auth.reason : 'wrong credential kind')
        this.json(res, 401, { error: 'org-JWT required' })
        return undefined
    }

    private requireTunnel(res: http.ServerResponse, auth: Auth, path: string): DelegatedCredentialClaims | undefined {
        if (auth.kind === 'tunnel') return auth.claims
        this.emit('unauthorized', path, auth.kind === 'none' ? auth.reason : 'wrong credential kind')
        this.json(res, 401, { error: 'delegated tunnel credential required' })
        return undefined
    }

    private putKeys(res: http.ServerResponse, auth: Auth, body: unknown): void {
        const orgSlug = this.requireOrg(res, auth, '/tunnel/keys')
        if (!orgSlug) return
        const parsed = PublishKeyRequestSchema.safeParse(body)
        if (!parsed.success)
            return this.json(res, 400, {
                error: 'invalid key blob',
                issues: parsed.error.issues.map((i) => i.path.join('.')),
            })
        const generation = this.publishKey(parsed.data, orgSlug)
        this.json(res, 201, { generation })
    }

    private getPeerKey(res: http.ServerResponse, auth: Auth, url: URL): void {
        const claims = this.requireTunnel(res, auth, '/tunnel/peer-key')
        if (!claims) return
        const legId = url.searchParams.get('legId')
        if (!legId) return this.json(res, 400, { error: 'legId required' })
        if (legId !== claims.legId) return this.json(res, 403, { error: 'credential is not scoped to this leg' })
        const peerRow = this.rows
            .filter((r) => r.studyId === claims.studyId && r.legId === legId && r.orgSlug !== claims.orgSlug)
            .sort((a, b) => b.generation - a.generation)[0]
        if (!peerRow) {
            res.writeHead(204)
            res.end()
            return
        }
        const { publishedAt: _p, ...blob } = peerRow
        const response: PeerKeyResponse = blob
        this.emit('peerKeyServed', legId, claims.orgSlug, peerRow.generation)
        this.json(res, 200, response)
    }

    private getRelaySession(res: http.ServerResponse, auth: Auth, url: URL): void {
        const legId = url.searchParams.get('legId')
        if (!legId) return this.json(res, 400, { error: 'legId required' })
        let studyId: string
        let jobId: string
        let role: Role
        let orgSlug: string
        let caller: 'org' | 'tunnel'
        if (auth.kind === 'tunnel') {
            if (legId !== auth.claims.legId)
                return this.json(res, 403, { error: 'credential is not scoped to this leg' })
            ;({ studyId, jobId, role, orgSlug } = auth.claims)
            caller = 'tunnel'
        } else if (auth.kind === 'org') {
            const s = url.searchParams.get('studyId')
            const j = url.searchParams.get('jobId')
            const r = url.searchParams.get('role')
            if (!s || !j || (r !== 'source' && r !== 'destination'))
                return this.json(res, 400, { error: 'studyId, jobId and role required' })
            studyId = s
            jobId = j
            role = r
            orgSlug = auth.orgSlug
            caller = 'org'
        } else {
            this.emit('unauthorized', '/tunnel/relay-session', auth.reason)
            return this.json(res, 401, { error: 'authentication required' })
        }
        // Minted only after the caller's key is published (v2 §4.3): the token embeds its popKey.
        const row = this.latest(studyId, legId, orgSlug)
        if (!row) return this.json(res, 409, { error: 'publish the tunnel key before requesting a relay session' })
        const peerRow = this.rows.find((r) => r.studyId === studyId && r.legId === legId && r.orgSlug !== orgSlug)
        const run = this.runs.get(studyId)
        const leg = run?.legs.find((l) => l.legId === legId)
        // The leg's orgs come from the study record; the harness Setup App may also declare the peer.
        const declaredPeer = url.searchParams.get('peerOrgSlug') ?? undefined
        const peerOrgSlug = leg
            ? role === 'source'
                ? leg.destinationOrgSlug
                : leg.sourceOrgSlug
            : (declaredPeer ?? peerRow?.orgSlug ?? 'unknown')
        const [sourceOrg, destinationOrg] = role === 'source' ? [orgSlug, peerOrgSlug] : [peerOrgSlug, orgSlug]
        const session = this.sessionFor(studyId, legId)
        const ttl = this.options.relayTokenTtlS ?? 900
        const relayToken = mintRelayToken({
            relaySessionId: session.relaySessionId,
            role,
            fingerprint: row.fingerprint,
            popKey: Buffer.from(row.popKey, 'base64url'),
            studyId,
            jobId,
            legId,
            expiresInS: ttl,
            key: this.key,
            issuer: 'fake-bma',
        })
        const credential = caller === 'org' ? this.mintCredential({ studyId, jobId, legId, orgSlug, role }) : undefined
        if (credential) this.emit('credentialIssued', legId, role)
        this.emit('relaySessionIssued', legId, role, caller)
        this.json(res, 200, {
            relayEndpoint: this.options.relayEndpoint,
            relaySessionId: session.relaySessionId,
            relayToken,
            relayTokenExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
            role,
            direction: `${sourceOrg}->${destinationOrg}`,
            peerOrgSlug,
            sessionNonce: session.sessionNonce,
            ...(credential ? { credential: credential.credential, credentialExpiresAt: credential.expiresAt } : {}),
        })
    }

    private postCredential(res: http.ServerResponse, auth: Auth): void {
        const claims = this.requireTunnel(res, auth, '/tunnel/credential')
        if (!claims) return
        const { studyId, jobId, legId, orgSlug, role } = claims
        this.emit('credentialIssued', legId, role)
        this.json(res, 200, this.mintCredential({ studyId, jobId, legId, orgSlug, role }))
    }

    private postStatus(res: http.ServerResponse, auth: Auth, body: unknown): void {
        const claims = this.requireTunnel(res, auth, '/tunnel/status')
        if (!claims) return
        const parsed = StatusReportSchema.safeParse(body)
        if (!parsed.success)
            return this.json(res, 400, {
                error: 'invalid status report',
                issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            })
        if (
            parsed.data.legId !== claims.legId ||
            parsed.data.studyId !== claims.studyId ||
            parsed.data.role !== claims.role
        ) {
            return this.json(res, 403, { error: 'report does not match the credential scope' })
        }
        this.reports.push(parsed.data)
        this.emit('statusReceived', parsed.data)
        res.writeHead(204)
        res.end()
    }

    private getConsumed(res: http.ServerResponse, auth: Auth, url: URL): void {
        const orgSlug = this.requireOrg(res, auth, '/tunnel/consumed')
        if (!orgSlug) return
        const studyId = url.searchParams.get('studyId')
        const legId = url.searchParams.get('legId')
        if (!studyId || !legId) return this.json(res, 400, { error: 'studyId and legId required' })
        const consumed = this.consumedFor(studyId, legId)
        if (!consumed) {
            res.writeHead(204)
            res.end()
            return
        }
        this.json(res, 200, consumed)
    }

    /** Runs visible to an org: every leg where the org is a party, once all legs are launch-eligible. */
    private getRuns(res: http.ServerResponse, auth: Auth, _url: URL): void {
        const orgSlug = this.requireOrg(res, auth, '/tunnel/runs')
        if (!orgSlug) return
        const visible = [...this.runs.values()]
            .filter((run) => run.status === 'visible' || run.status === 'paired-running')
            .map((run) => ({
                studyId: run.studyId,
                status: run.status,
                legs: run.legs
                    .filter((leg) => leg.sourceOrgSlug === orgSlug || leg.destinationOrgSlug === orgSlug)
                    .map((leg) => ({
                        ...leg,
                        role: leg.sourceOrgSlug === orgSlug ? ('source' as Role) : ('destination' as Role),
                        jobId: leg.sourceOrgSlug === orgSlug ? leg.sourceJobId : leg.destinationJobId,
                    })),
            }))
            .filter((run) => run.legs.length > 0)
        this.json(res, 200, { runs: visible })
    }

    private postLaunched(res: http.ServerResponse, auth: Auth, body: unknown): void {
        const orgSlug = this.requireOrg(res, auth, '/tunnel/runs/launched')
        if (!orgSlug) return
        const b = body as { studyId?: string; legId?: string; role?: Role }
        if (!b?.studyId || !b.legId || (b.role !== 'source' && b.role !== 'destination')) {
            return this.json(res, 400, { error: 'studyId, legId and role required' })
        }
        if (!this.runs.has(b.studyId)) return this.json(res, 404, { error: 'unknown run' })
        const run = this.reportLaunch(b.studyId, b.legId, b.role)
        this.json(res, 200, { status: run.status })
    }

    private nextGeneration(studyId: string, legId: string, orgSlug: string): number {
        return (this.latest(studyId, legId, orgSlug)?.generation ?? 0) + 1
    }

    private async readJson(req: http.IncomingMessage): Promise<unknown> {
        if (req.method === 'GET' || req.method === 'HEAD') return undefined
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        if (!chunks.length) return undefined
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
            return undefined
        }
    }

    private json(res: http.ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
    }
}
