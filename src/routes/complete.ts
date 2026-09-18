import { json } from '@/http/json'
import type { RouteHandler } from '@/http/router'
import { guardLocalApi } from '@/routes/guard'
import type { Tunnel } from '@/tunnel'

/** POST /v1/complete — destination only; starts the CLOSE sequence (v2 §7.6). Idempotent while closing. */
export const complete =
    (tunnel: Tunnel): RouteHandler =>
    (req) => {
        const guard = guardLocalApi(tunnel, req, { roles: ['destination'], states: ['CHANNEL_UP', 'CLOSING'] })
        if (!guard.ok) return guard.response
        if (tunnel.lifecycle.state === 'CHANNEL_UP') tunnel.complete('rc requested completion')
        return json({ state: tunnel.lifecycle.state }, 202)
    }
