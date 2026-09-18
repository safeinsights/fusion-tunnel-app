import type http from 'node:http'
import type { ServerConfig } from '@/config'
import { createHttpServer } from '@/http/server'
import type { Router } from '@/http/router'
import { canonicalJson } from '@/lib/canonical'
import { createIdentity, type Identity } from '@/lib/identity'
import { Exchange, nullTransport, type ExchangeTransport } from '@/lib/exchange'
import { Lifecycle, TERMINAL_STATES } from '@/lib/lifecycle'
import { LongPoll } from '@/lib/long-poll'
import { log } from '@/lib/logger'
import type { DeliveredMessage } from '@/schemas/local-api'
import type { ConfigurationBundle } from '@/schemas/provisioning'
import { health } from '@/routes/health'
import { localIdentity } from '@/routes/local-identity'
import { localConfigure } from '@/routes/local-configure'
import { info } from '@/routes/info'
import { request } from '@/routes/request'
import { responses } from '@/routes/responses'
import { messagesNext, NEXT_QUERY_KEY } from '@/routes/messages-next'
import { messages } from '@/routes/messages'
import { messageAck } from '@/routes/message-ack'
import { complete } from '@/routes/complete'

export type ConfigureResult = 'configured' | 'unchanged' | 'conflict' | 'terminal'

export type TunnelDeps = {
    identity?: Identity
    transport?: ExchangeTransport
    now?: () => Date
}

/**
 * One tunnel instance: identity, lifecycle, the configuration bundle once provisioned, the
 * plaintext exchange, the long-poll registries and the HTTP server that exposes all of it.
 * Nothing is module-level, so a process can host several instances (in-process harness).
 */
export type Tunnel = {
    readonly config: ServerConfig
    readonly identity: Identity
    readonly lifecycle: Lifecycle
    readonly router: Router
    readonly server: http.Server
    readonly responseWaiters: LongPoll<DeliveredMessage>
    readonly queryWaiters: LongPoll<DeliveredMessage>
    readonly bundle: ConfigurationBundle | undefined
    readonly exchange: Exchange | undefined
    configure(bundle: ConfigurationBundle): ConfigureResult
    setTransport(transport: ExchangeTransport): void
    complete(reason: string): void
}

export const registerRoutes = (router: Router, tunnel: Tunnel): void => {
    router.register('GET', '/health', health(tunnel))
    router.register('GET', '/local/identity', localIdentity(tunnel))
    router.register('POST', '/local/configure', localConfigure(tunnel))
    router.register('GET', '/v1/info', info(tunnel))
    router.register('POST', '/v1/request', request(tunnel))
    router.register('GET', '/v1/responses/:correlationId', responses(tunnel))
    router.register('GET', '/v1/messages/next', messagesNext(tunnel))
    router.register('POST', '/v1/messages', messages(tunnel))
    router.register('POST', '/v1/messages/:id/ack', messageAck(tunnel))
    router.register('POST', '/v1/complete', complete(tunnel))
}

export const createTunnel = (config: ServerConfig, deps: TunnelDeps = {}): Tunnel => {
    const now = deps.now ?? (() => new Date())
    const identity = deps.identity ?? createIdentity()
    const lifecycle = new Lifecycle(now)
    const responseWaiters = new LongPoll<DeliveredMessage>()
    const queryWaiters = new LongPoll<DeliveredMessage>()
    let transport: ExchangeTransport = deps.transport ?? nullTransport
    let bundle: ConfigurationBundle | undefined
    let exchange: Exchange | undefined

    lifecycle.onTransition((transition) => {
        log.info('lifecycle.transition', {
            from: transition.from,
            to: transition.to,
            reason: transition.reason,
            legId: bundle?.legId,
            role: bundle?.role,
        })
        // Ending or ended: wake every held long-poll so the RC sees the terminal body promptly.
        if (transition.to === 'CLOSING' || TERMINAL_STATES.has(transition.to)) {
            responseWaiters.resolveAll(undefined)
            queryWaiters.resolveAll(undefined)
        }
    })

    const onDelivered = (message: DeliveredMessage): void => {
        if (bundle?.role === 'source') queryWaiters.resolve(NEXT_QUERY_KEY, message)
        else responseWaiters.resolve(message.correlationId, message)
    }

    const tunnel: Tunnel = {
        config,
        identity,
        lifecycle,
        responseWaiters,
        queryWaiters,
        get bundle() {
            return bundle
        },
        get exchange() {
            return exchange
        },
        // Assigned below once the HTTP server exists.
        router: undefined as unknown as Router,
        server: undefined as unknown as http.Server,
        configure(next) {
            if (lifecycle.isTerminal()) return 'terminal'
            if (bundle) return canonicalJson(bundle) === canonicalJson(next) ? 'unchanged' : 'conflict'
            bundle = next
            exchange = new Exchange(next.role, { transport, onDelivered, now })
            lifecycle.transition('CONFIGURED', 'configuration bundle accepted')
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
            transport = next
            exchange?.setTransport(next)
        },
        complete(reason) {
            lifecycle.transition('CLOSING', reason)
        },
    }

    const app = createHttpServer((router) => registerRoutes(router, tunnel))
    Object.assign(tunnel, { router: app.router, server: app.server })
    log.info('tunnel.identity_generated', { connectionId: identity.connectionId, fingerprint: identity.fingerprint })
    return tunnel
}
