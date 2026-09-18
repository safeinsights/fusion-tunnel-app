import { validate as isUuid } from 'uuid'
import { json } from '@/http/json'
import { apiError, noContent, terminal } from '@/http/errors'
import type { RouteHandler } from '@/http/router'
import { guardLocalApi } from '@/routes/guard'
import type { Tunnel } from '@/tunnel'

/**
 * GET /v1/responses/:correlationId — destination long-poll for a round's response. 404 for a
 * correlationId this process does not know (the SDK re-issues by the same id — v2 §7.3), 204 when
 * the hold expires empty, a terminal body once the session is ending.
 */
export const responses =
    (tunnel: Tunnel): RouteHandler =>
    async (req, params) => {
        const guard = guardLocalApi(tunnel, req, {
            roles: ['destination'],
            states: ['CHANNEL_UP', 'CLOSING'],
            longPoll: true,
        })
        if (!guard.ok) return guard.response
        const correlationId = params.correlationId
        if (!isUuid(correlationId)) return apiError(400, 'VALIDATION', 'correlationId is not a UUID')

        const existing = guard.exchange.responseFor(correlationId)
        if (existing) return json(existing)
        switch (guard.exchange.correlationStatus(correlationId)) {
            case 'unknown':
                return apiError(404, 'NOT_FOUND', 'unknown correlationId', { correlationId })
            case 'consumed':
                return apiError(409, 'CONFLICT', 'response already acknowledged', { correlationId })
        }

        const message = await tunnel.responseWaiters.wait(correlationId, tunnel.config.tuning.longPollMs)
        if (message) return json(message)
        const code = tunnel.lifecycle.terminalCode()
        if (code) return terminal(code, 200)
        return noContent()
    }
