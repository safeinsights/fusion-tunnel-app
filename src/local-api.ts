import { z } from 'zod'
import { bearerMatches, error, noContent, ok, parseBody, type Req, type Res, type Router } from '@/http'
import { InFlightConflictError, UnknownCorrelationError } from '@/lib/exchange'
import { STATES, type TunnelState } from '@/lib/lifecycle'
import { BackpressureError, LimitExceededError, MessageTooLargeError } from '@/reliability/delivery'
import { BudgetSchema, JsonValueSchema, TerminalCodeSchema } from '@/schemas/channel'
import { CapsSchema, GuardsSchema, OperationSchema, RoleSchema } from '@/schemas/provisioning'
import type { Tunnel } from '@/tunnel'

// Research-container-facing local API (owned by this repo; the fusion SDK mirrors it as
// fusion-sdk/spec/local-api.md). Schemas first, then the routes. Direction is structural: a source
// has no route through which to originate a query or complete the study.

export const API_VERSION = '2.0.0'

export { RoleSchema }
export type { Role } from '@/schemas/provisioning'
export { BudgetSchema, JsonValueSchema, TerminalCodeSchema } from '@/schemas/channel'
export type { Budget, JsonValue, TerminalCode } from '@/schemas/channel'

export const TunnelStateSchema = z.enum(STATES)

/** POST /v1/request (destination). `correlationId` only on a re-issue of a round this SDK started. */
export const RequestBodySchema = z.object({ payload: JsonValueSchema, correlationId: z.uuid().optional() })

/** A delivered query (source, GET /v1/messages/next) or response (destination, GET /v1/responses/:id). A 200 is the ack. */
export const DeliveredMessageSchema = z.object({
    messageId: z.uuid(),
    correlationId: z.uuid(),
    payload: JsonValueSchema,
    budget: BudgetSchema.optional(),
    receivedAt: z.iso.datetime(),
})
export type DeliveredMessage = z.infer<typeof DeliveredMessageSchema>

/** POST /v1/messages (source). */
export const PostMessageBodySchema = z.object({ inReplyTo: z.uuid(), payload: JsonValueSchema })

/** Once the leg has ended every /v1 route except /v1/info answers 200 with this body. */
export const TerminalBodySchema = z.object({
    terminal: z.literal(true),
    code: TerminalCodeSchema,
    message: z.string().optional(),
    detail: z.object({ cap: z.string(), limit: z.int(), observed: z.int() }).optional(),
})
export type TerminalBody = z.infer<typeof TerminalBodySchema>

/** GET /v1/info — content-free discovery for the peer-addressed SDK. */
export const InfoResponseSchema = z.object({
    apiVersion: z.string(),
    studyId: z.string(),
    jobId: z.string(),
    legId: z.string(),
    orgSlug: z.string(),
    peerOrgSlug: z.string(),
    role: RoleSchema,
    direction: z.string(),
    state: TunnelStateSchema,
    caps: CapsSchema,
    guards: GuardsSchema.optional(),
    operations: z.array(OperationSchema).optional(),
})
export type InfoResponse = z.infer<typeof InfoResponseSchema>

// ---- routes ---------------------------------------------------------------------------------

const uuid = z.uuid()

export const terminalBody = (tunnel: Tunnel): TerminalBody | undefined => {
    const code = tunnel.lifecycle.terminalCode()
    if (!code) return undefined
    const last = tunnel.lifecycle.history.at(-1)
    return {
        terminal: true,
        code,
        ...(last?.reason ? { message: last.reason } : {}),
        ...(last?.detail ? { detail: last.detail } : {}),
    }
}

/**
 * The common front door for every /v1 route: configured → authenticated → permitted for the role
 * → not ended → state ready. Order matters: an unauthenticated caller learns nothing beyond "not
 * configured yet", and role is checked before state so a source RC probing a destination-only
 * route gets a 403 rather than a retryable 503.
 */
const guard = (
    tunnel: Tunnel,
    req: Req,
    roles: readonly ('source' | 'destination')[],
    states: readonly TunnelState[],
): Res | undefined => {
    const bundle = tunnel.bundle
    if (!bundle || !tunnel.exchange) return notReady('tunnel is not configured')
    if (!bearerMatches(req.headers, bundle.localApiToken))
        return error(401, 'UNAUTHORIZED', 'missing or invalid bearer token')
    if (!roles.includes(bundle.role)) return error(403, 'FORBIDDEN', `not permitted for role ${bundle.role}`)
    if (states.includes(tunnel.lifecycle.state)) return undefined
    const terminal = terminalBody(tunnel)
    return terminal ? ok(terminal) : notReady(`tunnel state is ${tunnel.lifecycle.state}`)
}

const notReady = (message: string): Res => ({ ...error(503, 'NOT_READY', message), headers: { 'retry-after': '2' } })

const BOTH = ['source', 'destination'] as const
const UP = ['CHANNEL_UP'] as const
const UP_OR_CLOSING = ['CHANNEL_UP', 'CLOSING'] as const

const sendFailure = (e: unknown): Res => {
    if (e instanceof InFlightConflictError || e instanceof UnknownCorrelationError) {
        return error(409, 'CONFLICT', e.message, { correlationId: e.correlationId })
    }
    if (e instanceof BackpressureError)
        return { ...error(429, 'BACKPRESSURE', e.message), headers: { 'retry-after': '1' } }
    if (e instanceof MessageTooLargeError) return error(413, 'TOO_LARGE', e.message)
    throw e
}

export const registerLocalApi = (router: Router, tunnel: Tunnel): void => {
    const hold = () => tunnel.config.tuning.longPollMs

    router.register('GET', '/v1/info', (req) => {
        const bundle = tunnel.bundle
        if (!bundle) return notReady('tunnel is not configured')
        if (!bearerMatches(req.headers, bundle.localApiToken))
            return error(401, 'UNAUTHORIZED', 'missing or invalid bearer token')
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
        return ok(body)
    })

    router.register('POST', '/v1/request', (req) => {
        const denied = guard(tunnel, req, ['destination'], UP)
        if (denied) return denied
        const parsed = parseBody(req, RequestBodySchema)
        if (!parsed.ok) return parsed.res
        try {
            return ok(tunnel.exchange!.request(parsed.data.payload, parsed.data.correlationId), 202)
        } catch (e) {
            return sendFailure(e)
        }
    })

    router.register('DELETE', '/v1/request/:correlationId', (req) => {
        const denied = guard(tunnel, req, ['destination'], UP_OR_CLOSING)
        if (denied) return denied
        if (!uuid.safeParse(req.params.correlationId).success)
            return error(400, 'VALIDATION', 'correlationId is not a UUID')
        tunnel.exchange!.abandon(req.params.correlationId!)
        return noContent()
    })

    router.register('GET', '/v1/responses/:correlationId', async (req) => {
        const denied = guard(tunnel, req, ['destination'], UP_OR_CLOSING)
        if (denied) return denied
        const correlationId = req.params.correlationId!
        if (!uuid.safeParse(correlationId).success) return error(400, 'VALIDATION', 'correlationId is not a UUID')
        const exchange = tunnel.exchange!
        const existing = exchange.responseFor(correlationId)
        if (existing) return handOver(existing)
        if (exchange.correlationStatus(correlationId) === 'unknown')
            return error(404, 'NOT_FOUND', 'unknown correlationId', { correlationId })
        const message = await tunnel.waiters.wait(correlationId, hold())
        if (message) return handOver(message)
        return terminalBody(tunnel) ? ok(terminalBody(tunnel)) : noContent()
    })

    router.register('GET', '/v1/messages/next', async (req) => {
        const denied = guard(tunnel, req, ['source'], UP)
        if (denied) return denied
        const existing = tunnel.exchange!.nextQuery()
        if (existing) return handOver(existing)
        const message = await tunnel.waiters.wait(NEXT_QUERY_KEY, hold())
        if (message) return handOver(message)
        return terminalBody(tunnel) ? ok(terminalBody(tunnel)) : noContent()
    })

    router.register('POST', '/v1/messages', (req) => {
        const denied = guard(tunnel, req, ['source'], UP)
        if (denied) return denied
        const parsed = parseBody(req, PostMessageBodySchema)
        if (!parsed.ok) return parsed.res
        try {
            const result = tunnel.exchange!.respond(parsed.data.inReplyTo, parsed.data.payload)
            return ok({ ...result, ...(tunnel.caps ? { budget: tunnel.caps.budget() } : {}) }, 202)
        } catch (e) {
            // A cap breach has already ended the leg and told the destination: the terminal body says so.
            if (e instanceof LimitExceededError) return ok(terminalBody(tunnel))
            return sendFailure(e)
        }
    })

    router.register('POST', '/v1/complete', (req) => {
        const denied = guard(tunnel, req, ['destination'], UP_OR_CLOSING)
        if (denied) return denied
        if (tunnel.lifecycle.state === 'CHANNEL_UP') tunnel.complete('rc requested completion')
        return ok({ state: tunnel.lifecycle.state }, 202)
    })

    /** Answering a long-poll with a message IS the acknowledgement: the RC has it now. */
    const handOver = (message: DeliveredMessage): Res => {
        tunnel.exchange!.consumed(message.messageId)
        return ok(message)
    }
}

export const NEXT_QUERY_KEY = 'next'

export { BOTH as LOCAL_API_ROLES }
