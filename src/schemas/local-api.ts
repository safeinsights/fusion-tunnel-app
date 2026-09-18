import { z } from 'zod'
import { STATES } from '@/lib/lifecycle'
import { CapsSchema, GuardsSchema, OperationSchema, RoleSchema } from '@/schemas/provisioning'

// Research-container-facing local API contract (owned by this repo; the fusion SDK mirrors it).
// Incorporates the SDK's confirmed asks: client-supplied correlationId on re-issue (T1), budget
// hints (T2), apiVersion/guards/caps on /v1/info (T3), payload as a pass-through JSON value (T4),
// terminal states as 200 bodies on long-poll routes (T5), message shapes (T6).

export const API_VERSION = '1.0.0'

export { RoleSchema }
export type { Role } from '@/schemas/provisioning'

export const JsonValueSchema = z.json()
export type JsonValue = z.infer<typeof JsonValueSchema>

export const TunnelStateSchema = z.enum(STATES)

/** Remaining-budget hint piggybacked on responses (security review §7.3); the source's counters. */
export const BudgetSchema = z.object({
    roundsUsed: z.int().nonnegative(),
    roundsMax: z.int().positive().optional(),
    responseBytesUsed: z.int().nonnegative(),
    responseBytesMax: z.int().positive().optional(),
    queryBytesUsed: z.int().nonnegative(),
    queryBytesMax: z.int().positive().optional(),
    roundsPerHourUsed: z.int().nonnegative().optional(),
    roundsPerHourMax: z.int().positive().optional(),
})
export type Budget = z.infer<typeof BudgetSchema>

/** POST /v1/request (destination). `correlationId` only on a re-issue of a round this tunnel minted. */
export const RequestBodySchema = z.object({
    payload: JsonValueSchema,
    correlationId: z.uuid().optional(),
})
export type RequestBody = z.infer<typeof RequestBodySchema>

/** 202 from POST /v1/request. */
export const RequestAcceptedSchema = z.object({
    correlationId: z.uuid(),
    reissued: z.boolean(),
})

/** A delivered query (source, GET /v1/messages/next) or response (destination, GET /v1/responses/:id). */
export const DeliveredMessageSchema = z.object({
    messageId: z.uuid(),
    correlationId: z.uuid(),
    payload: JsonValueSchema,
    budget: BudgetSchema.optional(),
    receivedAt: z.iso.datetime(),
})
export type DeliveredMessage = z.infer<typeof DeliveredMessageSchema>

/** POST /v1/messages (source). */
export const PostMessageBodySchema = z.object({
    inReplyTo: z.uuid(),
    payload: JsonValueSchema,
})
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>

/** 202 from POST /v1/messages. */
export const MessageAcceptedSchema = z.object({
    messageId: z.uuid(),
    replayed: z.boolean(),
})

/** 200 from POST /v1/messages/:id/ack. */
export const AckResponseSchema = z.object({
    messageId: z.uuid(),
    acked: z.literal(true),
})

/** 202 from POST /v1/complete. */
export const CompleteAcceptedSchema = z.object({
    state: z.enum(['CLOSING', 'CLOSED']),
})

export const TerminalCodeSchema = z.enum(['STUDY_COMPLETE', 'SESSION_ERRORED', 'LIMIT_EXCEEDED'])

/**
 * Terminal body: 200 on the long-poll routes (the study ended — not an HTTP failure), 410 on
 * every other /v1 route once the session is ending or ended. Same shape either way.
 */
export const TerminalBodySchema = z.object({
    terminal: z.literal(true),
    code: TerminalCodeSchema,
    message: z.string().optional(),
})
export type TerminalBody = z.infer<typeof TerminalBodySchema>

export const ApiErrorCodeSchema = z.enum([
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_READY',
    'CONFLICT',
    'VALIDATION',
    'NOT_FOUND',
    'BACKPRESSURE',
    'LIMIT_EXCEEDED',
    'INTERNAL',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>

export const ApiErrorSchema = z.object({
    error: z.object({
        code: ApiErrorCodeSchema,
        message: z.string(),
        correlationId: z.string().optional(),
        issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    }),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

/** GET /v1/info — content-free discovery for the peer-addressed SDK (plan §10, SDK ask T3). */
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
