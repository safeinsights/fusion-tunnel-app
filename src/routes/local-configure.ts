import { createPublicKey } from 'node:crypto'
import { json } from '@/http/json'
import { apiError, terminal } from '@/http/errors'
import { parseJsonBody } from '@/http/validate'
import type { RouteHandler } from '@/http/router'
import { guardProvisioning } from '@/routes/guard'
import { ConfigurationBundleSchema } from '@/schemas/provisioning'
import type { Tunnel } from '@/tunnel'

/**
 * POST /local/configure — the Setup App delivers the configuration bundle. Re-posting the same
 * bundle is idempotent (200); a different bundle on a configured tunnel is a 409 — a tunnel is
 * re-provisioned by restarting it, never by reconfiguring a running one. Only the holder of the
 * provisioning token (the Setup App) gets this far: the bundle carries the trust anchors (relay
 * and BMA endpoints, the pinned peer-org key, the RC bearer), so a first-come caller could
 * otherwise redirect the leg.
 */
export const localConfigure =
    (tunnel: Tunnel): RouteHandler =>
    async (req) => {
        const denied = guardProvisioning(tunnel, req)
        if (denied) return denied
        const parsed = await parseJsonBody(req, ConfigurationBundleSchema)
        if (!parsed.ok) return parsed.response
        try {
            createPublicKey(parsed.data.peerOrgPublicKey)
        } catch {
            return apiError(400, 'VALIDATION', 'peerOrgPublicKey is not a valid public key PEM', {
                issues: [{ path: 'peerOrgPublicKey', message: 'unparseable public key' }],
            })
        }
        const result = tunnel.configure(parsed.data)
        switch (result) {
            case 'conflict':
                return apiError(409, 'CONFLICT', 'tunnel is already configured with a different bundle')
            case 'terminal':
                return terminal(tunnel.lifecycle.terminalCode()!, 410)
            default:
                return json({ state: tunnel.lifecycle.state, configured: result === 'configured' })
        }
    }
