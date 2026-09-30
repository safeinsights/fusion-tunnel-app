import type http from 'node:http'
import { createPublicKey } from 'node:crypto'
import type { ServerConfig } from '@/config'
import { bearerMatches, createHttpServer, error, ok, parseBody, Router, type Req, type Res } from '@/http'
import { BmaClient } from '@/lib/bma/client'
import type { VerifiedPeer } from '@/lib/bma/verify-peer-key'
import { Channel, type ChannelDeps } from '@/lib/channel'
import { createIdentity, type Identity } from '@/lib/identity'
import { Exchange, type ExchangeTransport } from '@/lib/exchange'
import { Lifecycle, TERMINAL_STATES } from '@/lib/lifecycle'
import { LongPoll } from '@/lib/long-poll'
import { log } from '@/lib/logger'
import { NEXT_QUERY_KEY, registerLocalApi, terminalBody, type DeliveredMessage } from '@/local-api'
import { CapsMeter } from '@/reliability/caps'
import { ConfigurationBundleSchema, type ConfigurationBundle } from '@/schemas/provisioning'

export type ConfigureResult = 'configured' | 'unchanged' | 'conflict' | 'terminal'

export type TunnelDeps = {
    identity?: Identity
    /** Replaces the channel's delivery as the exchange transport (unit tests). */
    transport?: ExchangeTransport
    now?: () => Date
    channelDeps?: Pick<ChannelDeps, 'relayFactory' | 'tokenProvider'>
    /** `null` disables the BMA client (harnesses that play the directory themselves). */
    bma?: null | { fetch?: typeof fetch }
}

/**
 * One tunnel instance: identity, lifecycle, the configuration bundle once provisioned, the
 * plaintext exchange, the channel (relay + Noise + delivery), the long-poll registry and the HTTP
 * server that exposes all of it. Nothing is module-level, so a process can host several instances
 * (in-process harness).
 */
export type Tunnel = {
    readonly config: ServerConfig
    readonly identity: Identity
    readonly lifecycle: Lifecycle
    readonly server: http.Server
    /** Long-poll waiters keyed by correlationId (destination) or NEXT_QUERY_KEY (source). */
    readonly waiters: LongPoll<DeliveredMessage>
    readonly bundle: ConfigurationBundle | undefined
    readonly exchange: Exchange | undefined
    readonly channel: Channel | undefined
    readonly caps: CapsMeter | undefined
    readonly bma: BmaClient | undefined
    configure(bundle: ConfigurationBundle): ConfigureResult
    setTransport(transport: ExchangeTransport): void
    /** The peer's key passed verification: attach to the relay (first time) or re-handshake. */
    verifiedPeer(peer: VerifiedPeer): void
    complete(reason: string): void
    stop(): void
}

// Deterministic JSON so an identical bundle compares equal regardless of key order (idempotent configure).
const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(
                  Object.keys(v as object)
                      .sort()
                      .map((k) => [k, (v as Record<string, unknown>)[k]]),
              )
            : v,
    )

export const createTunnel = (config: ServerConfig, deps: TunnelDeps = {}): Tunnel => {
    const now = deps.now ?? (() => new Date())
    const identity = deps.identity ?? createIdentity()
    const lifecycle = new Lifecycle(now)
    const waiters = new LongPoll<DeliveredMessage>()
    let bundle: ConfigurationBundle | undefined
    let exchange: Exchange | undefined
    let channel: Channel | undefined
    let caps: CapsMeter | undefined
    let bma: BmaClient | undefined

    lifecycle.onTransition((transition) => {
        log.info('lifecycle.transition', {
            from: transition.from,
            to: transition.to,
            reason: transition.reason,
            legId: bundle?.legId,
            role: bundle?.role,
        })
        // Ending or ended: wake every held long-poll so the RC sees the terminal body promptly.
        if (transition.to === 'CLOSING' || TERMINAL_STATES.has(transition.to)) waiters.resolveAll(undefined)
    })

    const onDelivered = (message: DeliveredMessage): void => {
        waiters.resolve(bundle?.role === 'source' ? NEXT_QUERY_KEY : message.correlationId, message)
    }

    const tunnel: Tunnel = {
        config,
        identity,
        lifecycle,
        waiters,
        get bundle() {
            return bundle
        },
        get exchange() {
            return exchange
        },
        get channel() {
            return channel
        },
        get caps() {
            return caps
        },
        get bma() {
            return bma
        },
        server: undefined as unknown as http.Server, // assigned below
        configure(next) {
            if (lifecycle.isTerminal()) return 'terminal'
            if (bundle) return canonical(bundle) === canonical(next) ? 'unchanged' : 'conflict'
            bundle = next
            exchange = new Exchange(next.role, { onDelivered, now })
            // Only the source meters caps: the party whose data is at risk enforces (§7.3).
            caps =
                next.role === 'source' ? new CapsMeter(next.caps, next.capsConsumed, () => now().getTime()) : undefined
            channel = new Channel({
                bundle: next,
                identity,
                tuning: config.tuning,
                exchange,
                lifecycle,
                caps,
                now: () => now().getTime(),
                // The relay client dials with whatever token the BMA client has most recently pre-fetched.
                tokenProvider: () => bma?.currentRelayToken() ?? next.relay.token,
                ...deps.channelDeps,
            })
            exchange.setTransport(deps.transport ?? channel.delivery)
            lifecycle.transition('CONFIGURED', 'configuration bundle accepted')
            if (deps.bma !== null) {
                bma = new BmaClient({
                    bundle: next,
                    identity,
                    lifecycle,
                    channel,
                    exchange,
                    tuning: config.tuning,
                    caps,
                    verifiedPeer: (peer) => tunnel.verifiedPeer(peer),
                    fetch: deps.bma?.fetch,
                    now: () => now().getTime(),
                })
                bma.start()
            }
            // Recovery (v2 §8): a peer that rejoined with new keys needs a fresh directory fetch; an
            // initiator that exhausted its handshake attempts cannot come up.
            channel.on('peerRejoined', () => bma?.refetchPeerKey())
            channel.on('handshakeFailed', (reason) => lifecycle.fail('ERRORED', `handshake: ${reason}`))
            log.info('tunnel.configured', {
                studyId: next.studyId,
                jobId: next.jobId,
                legId: next.legId,
                role: next.role,
                peerOrgSlug: next.peerOrgSlug,
                keyGeneration: next.keyGeneration,
                connectionId: identity.connectionId,
            })
            return 'configured'
        },
        setTransport(next) {
            exchange?.setTransport(next)
        },
        verifiedPeer(peer) {
            if (!channel) throw new Error('tunnel is not configured')
            channel.setPeer(peer)
            if (lifecycle.state === 'CONFIGURED') {
                lifecycle.transition('PEER_KEY_VERIFIED', `peer key verified (generation ${peer.generation})`)
                channel.attach()
            }
        },
        complete(reason) {
            lifecycle.transition('CLOSING', reason)
            channel?.close('STUDY_COMPLETE', reason)
        },
        stop() {
            bma?.stop()
            channel?.stop()
        },
    }

    const router = new Router()
    router.register('GET', '/health', () => ok({ success: true, message: { status: 'ok', state: lifecycle.state } }))
    router.register('GET', '/local/identity', (req) => provisioning(req) ?? ok(identity.toIdentityResponse()))
    router.register('POST', '/local/configure', (req) => {
        const denied = provisioning(req)
        if (denied) return denied
        const parsed = parseBody(req, ConfigurationBundleSchema)
        if (!parsed.ok) return parsed.res
        try {
            createPublicKey(parsed.data.peerOrgPublicKey)
        } catch {
            return error(400, 'VALIDATION', 'peerOrgPublicKey is not a valid public key PEM', {
                issues: [{ path: 'peerOrgPublicKey', message: 'unparseable public key' }],
            })
        }
        const result = tunnel.configure(parsed.data)
        if (result === 'conflict') return error(409, 'CONFLICT', 'tunnel is already configured with a different bundle')
        if (result === 'terminal') return ok(terminalBody(tunnel))
        return ok({ state: lifecycle.state, configured: result === 'configured' })
    })
    registerLocalApi(router, tunnel)

    /**
     * The front door for the provisioning API: the Setup App's bootstrap bearer, checked constant-time
     * like the RC token. The research container shares the tunnel's network namespace and must not be
     * able to provision it. A tunnel without a token configured (tests only; `main()` refuses to boot)
     * answers 401 to all.
     */
    function provisioning(req: Req): Res | undefined {
        const expected = config.provisionToken
        if (expected === undefined || !bearerMatches(req.headers, expected))
            return error(401, 'UNAUTHORIZED', 'missing or invalid provisioning token')
        return undefined
    }

    // Local-API bodies are plaintext; the RC hands a whole message over in one request.
    Object.assign(tunnel, {
        server: createHttpServer(router, { maxBodyBytes: config.tuning.maxMessageBytes + 64 * 1024 }),
    })
    log.info('tunnel.identity_generated', { connectionId: identity.connectionId, fingerprint: identity.fingerprint })
    return tunnel
}
