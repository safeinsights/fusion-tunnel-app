import { apiError, notReady, terminal } from '@/http/errors'
import { isAuthorized } from '@/lib/auth'
import type { Exchange } from '@/lib/exchange'
import type { TunnelState } from '@/lib/lifecycle'
import type { ConfigurationBundle, Role } from '@/schemas/provisioning'
import type { Tunnel } from '@/tunnel'

export type GuardOptions = {
    /** Roles allowed to call the route (structural direction enforcement, v2 §7.6). */
    roles?: readonly Role[]
    /** Lifecycle states in which the route does its work. */
    states: readonly TunnelState[]
    /** Long-poll routes answer terminal states with 200 bodies (SDK ask T5); others with 410. */
    longPoll?: boolean
}

export type Guarded = { ok: true; bundle: ConfigurationBundle; exchange: Exchange } | { ok: false; response: Response }

const fail = (response: Response): Guarded => ({ ok: false, response })

/**
 * The common front door for every /v1/* route: configured → authenticated → permitted for the
 * role → session not ended → state ready. Order matters: an unauthenticated caller learns
 * nothing beyond "not configured yet", and role is checked before state so a source RC probing
 * a destination-only route gets a 403 rather than a retryable 503.
 */
export const guardLocalApi = (tunnel: Tunnel, req: Request, options: GuardOptions): Guarded => {
    const bundle = tunnel.bundle
    const exchange = tunnel.exchange
    if (!bundle || !exchange) return fail(notReady('tunnel is not configured'))
    if (!isAuthorized(req, bundle.localApiToken)) {
        return fail(apiError(401, 'UNAUTHORIZED', 'missing or invalid bearer token'))
    }
    if (options.roles && !options.roles.includes(bundle.role)) {
        return fail(apiError(403, 'FORBIDDEN', `not permitted for role ${bundle.role}`))
    }
    const state = tunnel.lifecycle.state
    if (options.states.includes(state)) return { ok: true, bundle, exchange }
    const code = tunnel.lifecycle.terminalCode()
    if (code) return fail(terminal(code, options.longPoll ? 200 : 410))
    return fail(notReady(`tunnel state is ${state}`))
}
