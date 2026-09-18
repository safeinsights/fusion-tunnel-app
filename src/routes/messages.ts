import { json } from '@/http/json'
import { apiError, terminal } from '@/http/errors'
import { parseJsonBody } from '@/http/validate'
import type { RouteHandler } from '@/http/router'
import { UnknownCorrelationError } from '@/lib/exchange'
import { BackpressureError, LimitExceededError } from '@/reliability/delivery'
import { PostMessageBodySchema } from '@/schemas/local-api'
import { guardLocalApi } from '@/routes/guard'
import type { Tunnel } from '@/tunnel'

/**
 * POST /v1/messages — source only; a response must cite a delivered query via `inReplyTo`. This
 * is the structural half of direction enforcement: there is no route through which a source RC
 * can originate a message (v2 §7.6).
 */
export const messages =
    (tunnel: Tunnel): RouteHandler =>
    async (req) => {
        const guard = guardLocalApi(tunnel, req, { roles: ['source'], states: ['CHANNEL_UP'] })
        if (!guard.ok) return guard.response
        const parsed = await parseJsonBody(req, PostMessageBodySchema)
        if (!parsed.ok) return parsed.response
        try {
            const result = guard.exchange.respond(parsed.data.inReplyTo, parsed.data.payload)
            return json(result, 202)
        } catch (error) {
            if (error instanceof UnknownCorrelationError) {
                return apiError(409, 'CONFLICT', error.message, { correlationId: error.correlationId })
            }
            if (error instanceof BackpressureError) {
                return apiError(429, 'BACKPRESSURE', error.message, {}, { 'retry-after': '1' })
            }
            if (error instanceof LimitExceededError) {
                // The tunnel has already told the destination and entered the terminal state.
                return terminal('LIMIT_EXCEEDED', 410, error.message)
            }
            throw error
        }
    }
