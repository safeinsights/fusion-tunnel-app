import type { Budget, DeliveredMessage, InfoResponse, TerminalBody } from '@/schemas/local-api'
import type { TerminalCode } from '@/lib/lifecycle'

// Scripted research-container drivers for the harness (plan Phase 9) — not a product SDK. They
// mirror what the fusion SDK does over the tunnel's local API: the destination submits, long-polls
// the response, acks, re-issues by the same correlationId on timeout or 404, and fans complete()
// out to every peer; the source long-polls, acks first, dedups by correlationId, runs a handler and
// posts the correlated response until the terminal STUDY_COMPLETE.

export type TunnelEndpoint = { url: string; token: string }

export class TerminalError extends Error {
    constructor(
        readonly code: TerminalCode,
        readonly peer?: string,
    ) {
        super(`session ended: ${code}${peer ? ` (${peer})` : ''}`)
        this.name = 'TerminalError'
    }
}

export class RoundTimeoutError extends Error {
    constructor(readonly correlationId: string) {
        super(`round ${correlationId} timed out`)
        this.name = 'RoundTimeoutError'
    }
}

export class NotReadyError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'NotReadyError'
    }
}

export type Peer = {
    label: string
    peerOrgSlug: string
    legId: string
    endpoint: TunnelEndpoint
    info: InfoResponse
}

export type RcOptions = {
    fetch?: typeof fetch
    /** HTTP timeout per call; must exceed the tunnel's long-poll hold. */
    httpTimeoutMs?: number
    readinessTimeoutMs?: number
    pollMs?: number
}

type Json = Record<string, unknown>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const call = async (
    fetchImpl: typeof fetch,
    endpoint: TunnelEndpoint,
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
): Promise<{ status: number; body: Json | undefined }> => {
    const res = await fetchImpl(`${endpoint.url}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${endpoint.token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    return { status: res.status, body: text.length ? (JSON.parse(text) as Json) : undefined }
}

const isTerminal = (body: Json | undefined): body is TerminalBody & Json => body?.terminal === true

/** Wait until GET /v1/info reports CHANNEL_UP (or a terminal state, which throws). */
export const waitForChannelUp = async (endpoint: TunnelEndpoint, options: RcOptions = {}): Promise<InfoResponse> => {
    const fetchImpl = options.fetch ?? fetch
    const deadline = Date.now() + (options.readinessTimeoutMs ?? 30_000)
    for (;;) {
        try {
            const res = await call(fetchImpl, endpoint, 'GET', '/v1/info', undefined, options.httpTimeoutMs ?? 5_000)
            if (res.status === 200) {
                const info = res.body as unknown as InfoResponse
                if (info.state === 'CHANNEL_UP') return info
                if (info.state === 'ERRORED' || info.state === 'LIMIT_EXCEEDED' || info.state === 'CLOSED') {
                    throw new TerminalError(
                        info.state === 'ERRORED'
                            ? 'SESSION_ERRORED'
                            : info.state === 'CLOSED'
                              ? 'STUDY_COMPLETE'
                              : 'LIMIT_EXCEEDED',
                    )
                }
            } else if (res.status === 401) {
                throw new NotReadyError('bearer token rejected')
            }
        } catch (error) {
            if (error instanceof TerminalError || error instanceof NotReadyError) throw error
            // connection refused / timeout while the tunnel boots: keep waiting
        }
        if (Date.now() > deadline) throw new NotReadyError(`tunnel at ${endpoint.url} not CHANNEL_UP in time`)
        await sleep(options.pollMs ?? 50)
    }
}

export class DestinationRc {
    readonly peers = new Map<string, Peer>()
    private readonly fetchImpl: typeof fetch
    private readonly httpTimeoutMs: number
    readonly rounds: { peer: string; correlationId: string; reissues: number }[] = []
    private readonly budgets = new Map<string, Budget>()

    private constructor(private readonly options: RcOptions) {
        this.fetchImpl = options.fetch ?? fetch
        this.httpTimeoutMs = options.httpTimeoutMs ?? 40_000
    }

    /** Discover one or more tunnels (the FUSION_TUNNEL_ENDPOINTS map) and wait for each to be CHANNEL_UP. */
    static async connect(endpoints: Record<string, TunnelEndpoint>, options: RcOptions = {}): Promise<DestinationRc> {
        const rc = new DestinationRc(options)
        for (const [label, endpoint] of Object.entries(endpoints)) {
            const info = await waitForChannelUp(endpoint, options)
            if (info.role !== 'destination')
                throw new NotReadyError(`tunnel ${label} is a ${info.role}, not a destination`)
            rc.peers.set(info.peerOrgSlug, { label, peerOrgSlug: info.peerOrgSlug, legId: info.legId, endpoint, info })
        }
        return rc
    }

    /** By peerOrgSlug or label; with one peer, no argument needed. */
    peer(ref?: string): Peer {
        if (ref === undefined) {
            if (this.peers.size !== 1) throw new Error(`peer() needs a name when there are ${this.peers.size} peers`)
            return [...this.peers.values()][0]
        }
        const found = this.peers.get(ref) ?? [...this.peers.values()].find((p) => p.label === ref)
        if (!found) throw new Error(`unknown peer ${ref}`)
        return found
    }

    budget(ref?: string): Budget | undefined {
        return this.budgets.get(this.peer(ref).peerOrgSlug)
    }

    /** The blocking facade: submit, poll, ack. Re-issues by the same correlationId on timeout or 404. */
    async request(
        ref: string | undefined,
        payload: unknown,
        options: { roundTimeoutMs?: number; maxReissues?: number } = {},
    ): Promise<{ payload: unknown; budget?: Budget; correlationId: string; messageId: string }> {
        const peer = this.peer(ref)
        const roundTimeoutMs = options.roundTimeoutMs ?? 10_000
        const maxReissues = options.maxReissues ?? 3
        let correlationId: string | undefined
        let reissues = 0
        for (;;) {
            const submitted = await this.post(peer, '/v1/request', {
                payload,
                ...(correlationId ? { correlationId } : {}),
            })
            if (isTerminal(submitted.body)) throw new TerminalError(submitted.body.code, peer.peerOrgSlug)
            if (submitted.status === 429 || submitted.status === 503) {
                await sleep(200)
                continue
            }
            if (submitted.status !== 202)
                throw new Error(`request failed: ${submitted.status} ${JSON.stringify(submitted.body)}`)
            correlationId = submitted.body!.correlationId as string
            const deadline = Date.now() + roundTimeoutMs
            let reissue = false
            while (Date.now() < deadline) {
                const res = await this.get(peer, `/v1/responses/${correlationId}`)
                if (res.status === 200 && isTerminal(res.body)) throw new TerminalError(res.body.code, peer.peerOrgSlug)
                if (res.status === 200) {
                    const message = res.body as unknown as DeliveredMessage
                    await this.post(peer, `/v1/messages/${message.messageId}/ack`, undefined)
                    if (message.budget) this.budgets.set(peer.peerOrgSlug, message.budget)
                    this.rounds.push({ peer: peer.peerOrgSlug, correlationId, reissues })
                    return {
                        payload: message.payload,
                        budget: message.budget,
                        correlationId,
                        messageId: message.messageId,
                    }
                }
                if (res.status === 404) {
                    reissue = true // the tunnel restarted and lost the round
                    break
                }
                if (res.status === 410 && isTerminal(res.body)) throw new TerminalError(res.body.code, peer.peerOrgSlug)
                if (res.status !== 204) await sleep(this.options.pollMs ?? 50)
            }
            void reissue
            if (++reissues > maxReissues) throw new RoundTimeoutError(correlationId)
        }
    }

    /** Fan out to every peer; returns each leg's resulting state. */
    async complete(): Promise<Record<string, string>> {
        const results: Record<string, string> = {}
        for (const peer of this.peers.values()) {
            const res = await this.post(peer, '/v1/complete', undefined)
            results[peer.peerOrgSlug] = isTerminal(res.body)
                ? res.body.code
                : ((res.body?.state as string) ?? String(res.status))
        }
        return results
    }

    private get(peer: Peer, path: string) {
        return call(this.fetchImpl, peer.endpoint, 'GET', path, undefined, this.httpTimeoutMs)
    }

    private post(peer: Peer, path: string, body: unknown) {
        return call(this.fetchImpl, peer.endpoint, 'POST', path, body, this.httpTimeoutMs)
    }
}

export type SourceHandler = (
    payload: unknown,
    context: { correlationId: string; messageId: string },
) => unknown | Promise<unknown>

export class SourceRc {
    private readonly fetchImpl: typeof fetch
    private readonly httpTimeoutMs: number
    private stopped = false
    private readonly memo = new Map<string, unknown>()
    readonly served: { correlationId: string; messageId: string; payload: unknown; replayed: boolean }[] = []
    info: InfoResponse | undefined

    constructor(
        private readonly endpoint: TunnelEndpoint,
        private readonly handler: SourceHandler,
        private readonly options: RcOptions = {},
    ) {
        this.fetchImpl = options.fetch ?? fetch
        this.httpTimeoutMs = options.httpTimeoutMs ?? 40_000
    }

    async waitReady(): Promise<InfoResponse> {
        this.info = await waitForChannelUp(this.endpoint, this.options)
        if (this.info.role !== 'source') throw new NotReadyError(`tunnel is a ${this.info.role}, not a source`)
        return this.info
    }

    /** The serve loop; resolves with STUDY_COMPLETE, throws TerminalError on the failure codes. */
    async serve(): Promise<'STUDY_COMPLETE'> {
        if (!this.info) await this.waitReady()
        while (!this.stopped) {
            const res = await call(
                this.fetchImpl,
                this.endpoint,
                'GET',
                '/v1/messages/next',
                undefined,
                this.httpTimeoutMs,
            )
            if (res.status === 200 && isTerminal(res.body)) {
                if (res.body.code === 'STUDY_COMPLETE') return 'STUDY_COMPLETE'
                throw new TerminalError(res.body.code)
            }
            if (res.status === 204) continue
            if (res.status === 503) {
                await sleep(this.options.pollMs ?? 100)
                continue
            }
            if (res.status !== 200) throw new Error(`messages/next failed: ${res.status} ${JSON.stringify(res.body)}`)
            const message = res.body as unknown as DeliveredMessage
            // stage two first, then serve; a redelivered correlationId replays the memoized answer
            await call(
                this.fetchImpl,
                this.endpoint,
                'POST',
                `/v1/messages/${message.messageId}/ack`,
                undefined,
                this.httpTimeoutMs,
            )
            const replayed = this.memo.has(message.correlationId)
            const answer = replayed ? this.memo.get(message.correlationId) : await this.run(message)
            this.memo.set(message.correlationId, answer)
            this.served.push({
                correlationId: message.correlationId,
                messageId: message.messageId,
                payload: message.payload,
                replayed,
            })
            const posted = await call(
                this.fetchImpl,
                this.endpoint,
                'POST',
                '/v1/messages',
                { inReplyTo: message.correlationId, payload: answer },
                this.httpTimeoutMs,
            )
            if (posted.status === 410 && isTerminal(posted.body)) throw new TerminalError(posted.body.code)
            if (posted.status !== 202)
                throw new Error(`messages failed: ${posted.status} ${JSON.stringify(posted.body)}`)
        }
        throw new Error('stopped')
    }

    stop(): void {
        this.stopped = true
    }

    private async run(message: DeliveredMessage): Promise<unknown> {
        try {
            return await this.handler(message.payload, {
                correlationId: message.correlationId,
                messageId: message.messageId,
            })
        } catch (error) {
            // a handler exception never crashes the loop: it becomes an error answer (poison defense)
            return { error: { code: 'HANDLER_ERROR', message: error instanceof Error ? error.message : String(error) } }
        }
    }
}
