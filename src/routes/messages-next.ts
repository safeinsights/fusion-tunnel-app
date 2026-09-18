import { json } from '@/http/json'
import { noContent, terminal } from '@/http/errors'
import type { RouteHandler } from '@/http/router'
import { guardLocalApi } from '@/routes/guard'
import type { Tunnel } from '@/tunnel'

export const NEXT_QUERY_KEY = 'next'

/**
 * GET /v1/messages/next — source long-poll for the next inbound query. A delivered query is
 * returned on every poll until the RC acks it (v2 §8: an RC restart sees un-acked messages again).
 * In CLOSING/CLOSED the guard answers the terminal STUDY_COMPLETE body, ending the source loop.
 */
export const messagesNext =
    (tunnel: Tunnel): RouteHandler =>
    async (req) => {
        const guard = guardLocalApi(tunnel, req, { roles: ['source'], states: ['CHANNEL_UP'], longPoll: true })
        if (!guard.ok) return guard.response

        const existing = guard.exchange.nextQuery()
        if (existing) return json(existing)

        const message = await tunnel.queryWaiters.wait(NEXT_QUERY_KEY, tunnel.config.tuning.longPollMs)
        if (message) return json(message)
        const code = tunnel.lifecycle.terminalCode()
        if (code) return terminal(code, 200)
        return noContent()
    }
