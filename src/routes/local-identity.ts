import { json } from '@/http/json'
import type { RouteHandler } from '@/http/router'
import type { Tunnel } from '@/tunnel'

/** GET /local/identity — the Setup App reads the fresh public keys to publish (v2 §4.1). */
export const localIdentity =
    (tunnel: Tunnel): RouteHandler =>
    () =>
        json(tunnel.identity.toIdentityResponse())
