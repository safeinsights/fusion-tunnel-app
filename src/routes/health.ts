import { json } from '@/http/json'
import type { RouteHandler } from '@/http/router'
import type { Tunnel } from '@/tunnel'

export const health =
    (tunnel: Tunnel): RouteHandler =>
    () =>
        json({ success: true, message: { status: 'ok', state: tunnel.lifecycle.state } })
