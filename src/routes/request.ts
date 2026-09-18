import { json } from '@/http/json'
import { apiError } from '@/http/errors'
import { parseJsonBody } from '@/http/validate'
import type { RouteHandler } from '@/http/router'
import { InFlightConflictError } from '@/lib/exchange'
import { RequestBodySchema } from '@/schemas/local-api'
import { guardLocalApi } from '@/routes/guard'
import type { Tunnel } from '@/tunnel'

/** POST /v1/request — destination only; single in-flight round (409 on a second concurrent request). */
export const request =
    (tunnel: Tunnel): RouteHandler =>
    async (req) => {
        const guard = guardLocalApi(tunnel, req, { roles: ['destination'], states: ['CHANNEL_UP'] })
        if (!guard.ok) return guard.response
        const parsed = await parseJsonBody(req, RequestBodySchema)
        if (!parsed.ok) return parsed.response
        try {
            const result = guard.exchange.request(parsed.data.payload, parsed.data.correlationId)
            return json(result, 202)
        } catch (error) {
            if (error instanceof InFlightConflictError) {
                return apiError(409, 'CONFLICT', error.message, { correlationId: error.correlationId })
            }
            throw error
        }
    }
