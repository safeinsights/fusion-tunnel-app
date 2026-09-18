import { json } from '@/http/json'
import { apiError, notReady } from '@/http/errors'
import type { RouteHandler } from '@/http/router'
import { isAuthorized } from '@/lib/auth'
import { API_VERSION, type InfoResponse } from '@/schemas/local-api'
import type { Tunnel } from '@/tunnel'

/**
 * GET /v1/info — content-free discovery for the peer-addressed SDK (plan §10): which leg this
 * tunnel serves, its role, its state, and the manifest's caps/guards. Available in every state
 * once configured, including terminal ones, so the SDK can log progress and diagnose.
 */
export const info =
    (tunnel: Tunnel): RouteHandler =>
    (req) => {
        const bundle = tunnel.bundle
        if (!bundle) return notReady('tunnel is not configured')
        if (!isAuthorized(req, bundle.localApiToken)) {
            return apiError(401, 'UNAUTHORIZED', 'missing or invalid bearer token')
        }
        const body: InfoResponse = {
            apiVersion: API_VERSION,
            studyId: bundle.studyId,
            jobId: bundle.jobId,
            legId: bundle.legId,
            orgSlug: bundle.orgSlug,
            peerOrgSlug: bundle.peerOrgSlug,
            role: bundle.role,
            direction: bundle.direction,
            state: tunnel.lifecycle.state,
            caps: bundle.caps,
            ...(bundle.guards ? { guards: bundle.guards } : {}),
            ...(bundle.operations ? { operations: bundle.operations } : {}),
        }
        return json(body)
    }
