import { json } from '@/http/json'
import type { RouteHandler } from '@/http/router'
import { guardProvisioning } from '@/routes/guard'
import type { Tunnel } from '@/tunnel'

/** GET /local/identity — the Setup App reads the fresh public keys to publish (v2 §4.1). */
export const localIdentity =
    (tunnel: Tunnel): RouteHandler =>
    (req) =>
        guardProvisioning(tunnel, req) ?? json(tunnel.identity.toIdentityResponse())
