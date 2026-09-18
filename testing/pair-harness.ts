import { randomBytes } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import type { VerifiedPeer } from '@/lib/channel'
import type { ConfigurationBundle, Role } from '@/schemas/provisioning'
import { FakeRelay, type FakeRelayOptions } from '@/testing/fake-relay'
import { api, makeBundle, startTunnel, type RunningTunnel } from '@/testing/fixtures'
import { mintRelayToken, testBmaKey } from '@/testing/relay-tokens'

// Two real tunnels (in-process, real HTTP and real WebSockets) through the fake relay, with the
// harness playing the Setup App and the key directory: it provisions both bundles, hands each
// side the other's verified key, and re-runs both on a restart.

export type Side = RunningTunnel & { role: Role; keyGeneration: number }

export type PairOptions = {
    relay?: FakeRelay
    relayOptions?: Partial<FakeRelayOptions>
    env?: Record<string, string>
    sourceEnv?: Record<string, string>
    destinationEnv?: Record<string, string>
    sourceBundle?: Partial<ConfigurationBundle>
    destinationBundle?: Partial<ConfigurationBundle>
    channelUpTimeoutMs?: number
}

export type Pair = {
    relay: FakeRelay
    relaySessionId: string
    source: Side
    destination: Side
    connect(): Promise<void>
    /** Stop one side and bring up a replacement with a new identity and generation; re-handshake. */
    restart(role: Role): Promise<Side>
    srcApi(): ReturnType<typeof api>
    dstApi(): ReturnType<typeof api>
    close(): Promise<void>
}

export const peerOf = (side: Side): VerifiedPeer => ({
    publicKey: side.tunnel.identity.publicKey,
    connectionId: side.tunnel.identity.connectionId,
    generation: side.keyGeneration,
})

export const until = async <T>(
    fn: () => T | undefined | Promise<T | undefined>,
    timeoutMs = 3000,
    label = 'condition',
): Promise<T> => {
    const started = Date.now()
    for (;;) {
        const value = await fn()
        if (value !== undefined) return value
        if (Date.now() - started > timeoutMs) throw new Error(`${label} not met within ${timeoutMs} ms`)
        await new Promise((r) => setTimeout(r, 5))
    }
}

export const startPair = async (options: PairOptions = {}): Promise<Pair> => {
    const relay =
        options.relay ??
        new FakeRelay({ bmaPublicKeyPem: testBmaKey().publicPem, heartbeatIntervalMs: 5_000, ...options.relayOptions })
    if (!options.relay) await relay.start()
    const relaySessionId = `rs-${uuidv4()}`
    const sessionNonce = randomBytes(32).toString('base64url')
    const timeoutMs = options.channelUpTimeoutMs ?? 5_000
    const generations: Record<Role, number> = { source: 0, destination: 0 }

    const makeSide = async (role: Role): Promise<Side> => {
        const running = await startTunnel({
            env: {
                FUSION_HANDSHAKE_RETRY_MS: '50',
                ...options.env,
                ...(role === 'source' ? options.sourceEnv : options.destinationEnv),
            },
        })
        const identity = running.tunnel.identity
        const keyGeneration = ++generations[role]
        const token = mintRelayToken({
            relaySessionId,
            role,
            fingerprint: identity.fingerprint,
            popKey: identity.popKey,
        })
        const own =
            role === 'source' ? { orgSlug: 'dp-a', peerOrgSlug: 'si-hub' } : { orgSlug: 'si-hub', peerOrgSlug: 'dp-a' }
        running.tunnel.configure(
            makeBundle({
                role,
                ...own,
                keyGeneration,
                sessionNonce,
                relay: { endpoint: relay.wsUrl, sessionId: relaySessionId, token },
                ...(role === 'source' ? options.sourceBundle : options.destinationBundle),
            }),
        )
        return { ...running, role, keyGeneration }
    }

    const pair = {
        relay,
        relaySessionId,
        source: await makeSide('source'),
        destination: await makeSide('destination'),
    } as Pair

    pair.connect = async () => {
        pair.source.tunnel.verifiedPeer(peerOf(pair.destination))
        pair.destination.tunnel.verifiedPeer(peerOf(pair.source))
        await Promise.all([
            pair.source.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs }),
            pair.destination.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs }),
        ])
    }

    pair.restart = async (role) => {
        const old = role === 'source' ? pair.source : pair.destination
        const survivor = role === 'source' ? pair.destination : pair.source
        const rejoined = new Promise<void>((resolve) => survivor.tunnel.channel!.once('peerRejoined', () => resolve()))
        old.tunnel.stop()
        await old.close()
        const next = await makeSide(role)
        if (role === 'source') pair.source = next
        else pair.destination = next
        next.tunnel.verifiedPeer(peerOf(survivor))
        await rejoined
        survivor.tunnel.verifiedPeer(peerOf(next))
        await Promise.all([
            next.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs }),
            survivor.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs }),
        ])
        return next
    }

    pair.srcApi = () => api(pair.source.baseUrl, pair.source.tunnel.bundle!.localApiToken)
    pair.dstApi = () => api(pair.destination.baseUrl, pair.destination.tunnel.bundle!.localApiToken)

    pair.close = async () => {
        pair.source.tunnel.stop()
        pair.destination.tunnel.stop()
        await Promise.all([pair.source.close(), pair.destination.close()])
        if (!options.relay) await relay.stop()
    }

    return pair
}

/** Drive one full round through the local APIs; returns what each RC saw. */
export const runRound = async (pair: Pair, query: unknown, answer: (query: unknown) => unknown) => {
    const dst = pair.dstApi()
    const src = pair.srcApi()
    const submitted = await dst.post('/v1/request', { payload: query })
    if (submitted.status !== 202)
        throw new Error(`request failed: ${submitted.status} ${JSON.stringify(submitted.body)}`)
    const { correlationId } = submitted.body as { correlationId: string }
    const delivered = await until(
        async () => {
            const res = await src.get('/v1/messages/next')
            return res.status === 200 ? res : undefined
        },
        5000,
        'query delivery',
    )
    const q = delivered.body as { messageId: string; correlationId: string; payload: unknown }
    await src.post(`/v1/messages/${q.messageId}/ack`)
    const responded = await src.post('/v1/messages', { inReplyTo: q.correlationId, payload: answer(q.payload) })
    const response = await until(
        async () => {
            const res = await dst.get(`/v1/responses/${correlationId}`)
            return res.status === 200 ? res : undefined
        },
        5000,
        'response delivery',
    )
    const r = response.body as { messageId: string; correlationId: string; payload: unknown; budget?: unknown }
    await dst.post(`/v1/messages/${r.messageId}/ack`)
    return { correlationId, query: q, responded, response: r }
}
