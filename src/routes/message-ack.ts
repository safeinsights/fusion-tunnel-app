import { validate as isUuid } from 'uuid'
import { json } from '@/http/json'
import { apiError } from '@/http/errors'
import type { RouteHandler } from '@/http/router'
import { guardLocalApi } from '@/routes/guard'
import type { Tunnel } from '@/tunnel'

/** POST /v1/messages/:id/ack — both roles; stage two of the two-stage ACK (v2 §7.3). Idempotent. */
export const messageAck =
    (tunnel: Tunnel): RouteHandler =>
    (req, params) => {
        const guard = guardLocalApi(tunnel, req, { states: ['CHANNEL_UP', 'CLOSING'] })
        if (!guard.ok) return guard.response
        const messageId = params.id
        if (!isUuid(messageId)) return apiError(400, 'VALIDATION', 'message id is not a UUID')
        if (guard.exchange.ack(messageId) === 'unknown') {
            return apiError(404, 'NOT_FOUND', 'unknown message id')
        }
        return json({ messageId, acked: true })
    }
