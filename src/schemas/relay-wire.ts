import { createPublicKey, verify as edVerify } from 'node:crypto'
import { z } from 'zod'

// MIRROR of the canonical relay wire contract in fusion-relay/src/protocol/ (plan §0.3) — frame
// codec, frame types, token claims, PoP payload, error codes. Reviewed against that module on
// branch feat/relay-implementation (2026-09-18); the in-repo fake relay is built on this file so it
// doubles as the relay team's executable contract.
//
// Frame codec: [version u8=1][type u8][headerLen u32BE][header JSON utf8][payload bytes].
// Payload is opaque bytes end to end — the codec never inspects it.

export const WIRE_VERSION = 1
export const MAX_HEADER_BYTES = 64 * 1024

export const FrameType = {
    HELLO: 1,
    CHALLENGE: 2,
    CHALLENGE_RESPONSE: 3,
    ADMITTED: 4,
    DATA: 5,
    ACK: 6,
    NACK_DISCARD: 7,
    CLOSE: 8,
    CLOSE_ACK: 9,
    PEER_REJOINED: 10,
    ERROR: 11,
    HANDSHAKE: 12,
} as const
export type FrameTypeName = keyof typeof FrameType

const TYPE_NAMES = new Map<number, FrameTypeName>(
    (Object.entries(FrameType) as [FrameTypeName, number][]).map(([name, code]) => [code, name]),
)
export const frameTypeName = (code: number): FrameTypeName | undefined => TYPE_NAMES.get(code)

/** Types whose frames carry opaque payload bytes; every other type must have none. */
export const PAYLOAD_TYPES: ReadonlySet<FrameTypeName> = new Set<FrameTypeName>(['DATA', 'CLOSE', 'HANDSHAKE'])

export const RelayRoleSchema = z.enum(['source', 'destination'])
export type RelayRole = z.infer<typeof RelayRoleSchema>

const base64urlBytes = (bytes: number) =>
    z.base64url().refine((value) => Buffer.from(value, 'base64url').byteLength === bytes, {
        message: `must decode to ${bytes} bytes`,
    })
const Id = z.string().min(1).max(128)

// ---- token claims (the BMA contract artifact; the fake BMA/harness mints exactly this) -------

export const RELAY_TOKEN_AUDIENCE = 'safeinsights:fusion-relay'

export const RelayTokenClaimsSchema = z.object({
    aud: z.literal(RELAY_TOKEN_AUDIENCE),
    iss: z.string().min(1),
    exp: z.int(),
    iat: z.int(),
    relaySessionId: Id,
    role: RelayRoleSchema,
    fingerprint: z.string().min(1),
    /** base64url raw 32-byte Ed25519 proof-of-possession public key. */
    popKey: base64urlBytes(32),
    studyId: Id,
    jobId: Id,
    /** Routing metadata only — pairing is by relaySessionId alone. */
    legId: Id,
})
export type RelayTokenClaims = z.infer<typeof RelayTokenClaimsSchema>

// ---- proof of possession ----------------------------------------------------------------------

export const POP_DOMAIN = 'SI-FUSION-RELAY-POP-v1'

/** `"SI-FUSION-RELAY-POP-v1" ‖ nonce ‖ relaySessionId ‖ role` (relay protocol/pop.ts). */
export const popPayload = (nonce: Buffer, relaySessionId: string, role: RelayRole): Buffer =>
    Buffer.concat([
        Buffer.from(POP_DOMAIN, 'ascii'),
        nonce,
        Buffer.from(relaySessionId, 'utf8'),
        Buffer.from(role, 'utf8'),
    ])

export const verifyPop = (popKey: Buffer, payload: Buffer, signature: Buffer): boolean => {
    if (popKey.byteLength !== 32 || signature.byteLength !== 64) return false
    try {
        const key = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: popKey.toString('base64url') },
            format: 'jwk',
        })
        return edVerify(null, payload, key, signature)
    } catch {
        return false
    }
}

// ---- error codes ------------------------------------------------------------------------------

export const RelayErrorCodeSchema = z.enum([
    'AUTH_TOKEN_INVALID',
    'AUTH_TOKEN_EXPIRED',
    'AUTH_POP_FAILED',
    'AUTH_ROLE_OCCUPIED_DISPLACED',
    'BACKPRESSURE',
    'QUOTA_EXCEEDED',
    'RATE_LIMITED',
    'SESSION_ERRORED_DEAD_LETTER',
    'SESSION_ERRORED_EXPIRY',
    'SESSION_ERRORED_DETACHED',
    'SESSION_CLOSED',
    'SESSION_UNPAIRED_TIMEOUT',
    'PROTOCOL_VIOLATION',
    'FRAME_TOO_LARGE',
    'BLOB_TOO_LARGE',
])
export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>

/** Codes after which this session can never carry traffic again. */
export const SESSION_FATAL_CODES: ReadonlySet<RelayErrorCode> = new Set<RelayErrorCode>([
    'SESSION_ERRORED_DEAD_LETTER',
    'SESSION_ERRORED_EXPIRY',
    'SESSION_ERRORED_DETACHED',
    'SESSION_CLOSED',
    'SESSION_UNPAIRED_TIMEOUT',
])

/** Application WebSocket close codes the relay uses when an error also terminates the socket. */
export const CLOSE_CODES = {
    AUTH_TOKEN_INVALID: 4001,
    AUTH_TOKEN_EXPIRED: 4002,
    AUTH_POP_FAILED: 4003,
    AUTH_ROLE_OCCUPIED_DISPLACED: 4004,
    PROTOCOL_VIOLATION: 4005,
    FRAME_TOO_LARGE: 4006,
    CHALLENGE_TIMEOUT: 4007,
    SESSION_CLOSED: 4010,
    SESSION_ERRORED_DEAD_LETTER: 4011,
    SESSION_ERRORED_EXPIRY: 4012,
    SESSION_UNPAIRED_TIMEOUT: 4013,
    SESSION_ERRORED_DETACHED: 4014,
    HEARTBEAT_TIMEOUT: 4020,
    SERVER_SHUTDOWN: 4021,
} as const

// ---- headers (all strict, as in the canonical module) --------------------------------------------

const MessageId = z.string().min(1).max(64)

export const RelayLimitsSchema = z.strictObject({
    windowMsgs: z.int().nonnegative(),
    windowBytes: z.int().nonnegative(),
    maxChunkBytes: z.int().positive(),
    inlineCapBytes: z.int().positive(),
})
export type RelayLimits = z.infer<typeof RelayLimitsSchema>

/** A tunnel may declare the session and role it was provisioned for; a mismatch with the token is rejected. */
export const HelloHeaderSchema = z.strictObject({
    token: z.string().min(1).max(8192),
    relaySessionId: Id.optional(),
    role: RelayRoleSchema.optional(),
})
export const ChallengeHeaderSchema = z.strictObject({ nonce: base64urlBytes(32) })
export const ChallengeResponseHeaderSchema = z.strictObject({ signature: base64urlBytes(64) })
export const AdmittedHeaderSchema = z.strictObject({
    relaySessionId: Id,
    legId: Id,
    role: RelayRoleSchema,
    /** 0 means the relay sends no heartbeats. */
    heartbeatIntervalMs: z.int().nonnegative(),
    limits: RelayLimitsSchema,
})
/** The tunnel's own epoch tags are 16 hex characters (first 8 bytes of the handshake hash). */
export const EpochTagSchema = z.string().regex(/^[0-9a-f]{16}$/)
export const DataHeaderSchema = z
    .strictObject({
        messageId: MessageId,
        chunkIndex: z.int().nonnegative(),
        chunkCount: z.int().positive(),
        epochTag: z.string().min(1).max(128),
        /** Plaintext messageId of the query this response answers — the relay's retention rule. */
        respondsTo: MessageId.optional(),
        /** Declared total ciphertext size of the message; reserves the window slot at the lead chunk. */
        sizeBytes: z.int().nonnegative(),
        /** Relay-assigned; present only on relay→tunnel pushes. */
        seq: z.int().nonnegative().optional(),
    })
    .refine((h) => h.chunkIndex < h.chunkCount, { message: 'chunkIndex must be < chunkCount' })
export const AckHeaderSchema = z.strictObject({ messageId: MessageId })
export const NackDiscardHeaderSchema = z.strictObject({ messageId: MessageId, reason: z.string().min(1).max(256) })
export const EmptyHeaderSchema = z.strictObject({})
export const PeerRejoinedHeaderSchema = z.strictObject({ peerRole: RelayRoleSchema, epoch: z.int().nonnegative() })
export const ErrorHeaderSchema = z.strictObject({
    code: RelayErrorCodeSchema,
    retryable: z.boolean(),
    detail: z.string().max(512).optional(),
    messageId: MessageId.optional(),
    /** QUOTA_EXCEEDED only: which budget was breached. */
    scope: z.enum(['session', 'study']).optional(),
})

export type HelloHeader = z.infer<typeof HelloHeaderSchema>
export type ChallengeHeader = z.infer<typeof ChallengeHeaderSchema>
export type ChallengeResponseHeader = z.infer<typeof ChallengeResponseHeaderSchema>
export type AdmittedHeader = z.infer<typeof AdmittedHeaderSchema>
export type DataHeader = z.infer<typeof DataHeaderSchema>
export type AckHeader = z.infer<typeof AckHeaderSchema>
export type NackDiscardHeader = z.infer<typeof NackDiscardHeaderSchema>
export type PeerRejoinedHeader = z.infer<typeof PeerRejoinedHeaderSchema>
export type ErrorHeader = z.infer<typeof ErrorHeaderSchema>

const HEADER_SCHEMAS: Record<FrameTypeName, z.ZodType> = {
    HELLO: HelloHeaderSchema,
    CHALLENGE: ChallengeHeaderSchema,
    CHALLENGE_RESPONSE: ChallengeResponseHeaderSchema,
    ADMITTED: AdmittedHeaderSchema,
    DATA: DataHeaderSchema,
    ACK: AckHeaderSchema,
    NACK_DISCARD: NackDiscardHeaderSchema,
    CLOSE: EmptyHeaderSchema,
    CLOSE_ACK: EmptyHeaderSchema,
    PEER_REJOINED: PeerRejoinedHeaderSchema,
    ERROR: ErrorHeaderSchema,
    HANDSHAKE: EmptyHeaderSchema,
}

export type Frame =
    | { type: 'HELLO'; header: HelloHeader }
    | { type: 'CHALLENGE'; header: ChallengeHeader }
    | { type: 'CHALLENGE_RESPONSE'; header: ChallengeResponseHeader }
    | { type: 'ADMITTED'; header: AdmittedHeader }
    | { type: 'DATA'; header: DataHeader; payload: Buffer }
    | { type: 'ACK'; header: AckHeader }
    | { type: 'NACK_DISCARD'; header: NackDiscardHeader }
    | { type: 'CLOSE'; header: Record<string, never>; payload: Buffer }
    | { type: 'CLOSE_ACK'; header: Record<string, never> }
    | { type: 'PEER_REJOINED'; header: PeerRejoinedHeader }
    | { type: 'ERROR'; header: ErrorHeader }
    | { type: 'HANDSHAKE'; header: Record<string, never>; payload: Buffer }

export type WireErrorReason =
    | 'too_short'
    | 'bad_version'
    | 'unknown_type'
    | 'header_length'
    | 'header_json'
    | 'header_schema'
    | 'unexpected_payload'

export class WireError extends Error {
    constructor(
        readonly reason: WireErrorReason,
        detail?: string,
    ) {
        super(`malformed relay frame: ${reason}${detail ? ` (${detail})` : ''}`)
        this.name = 'WireError'
    }
}

const FIXED_HEADER_BYTES = 1 + 1 + 4

export const encodeFrame = (frame: Frame): Buffer => {
    const header = Buffer.from(JSON.stringify(frame.header ?? {}), 'utf8')
    if (header.byteLength > MAX_HEADER_BYTES) throw new WireError('header_length', 'encode')
    const payload = 'payload' in frame && frame.payload ? frame.payload : Buffer.alloc(0)
    if (payload.byteLength > 0 && !PAYLOAD_TYPES.has(frame.type)) throw new WireError('unexpected_payload', frame.type)
    const out = Buffer.alloc(FIXED_HEADER_BYTES + header.byteLength + payload.byteLength)
    out.writeUInt8(WIRE_VERSION, 0)
    out.writeUInt8(FrameType[frame.type], 1)
    out.writeUInt32BE(header.byteLength, 2)
    header.copy(out, FIXED_HEADER_BYTES)
    payload.copy(out, FIXED_HEADER_BYTES + header.byteLength)
    return out
}

export const decodeFrame = (buf: Buffer): Frame => {
    if (buf.byteLength < FIXED_HEADER_BYTES) throw new WireError('too_short')
    if (buf.readUInt8(0) !== WIRE_VERSION) throw new WireError('bad_version', String(buf.readUInt8(0)))
    const type = frameTypeName(buf.readUInt8(1))
    if (!type) throw new WireError('unknown_type', String(buf.readUInt8(1)))
    const headerLen = buf.readUInt32BE(2)
    if (headerLen > MAX_HEADER_BYTES || FIXED_HEADER_BYTES + headerLen > buf.byteLength) {
        throw new WireError('header_length', String(headerLen))
    }
    let raw: unknown
    try {
        raw = JSON.parse(buf.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + headerLen).toString('utf8'))
    } catch {
        throw new WireError('header_json')
    }
    const parsed = HEADER_SCHEMAS[type].safeParse(raw)
    if (!parsed.success) {
        throw new WireError('header_schema', parsed.error.issues.map((i) => i.path.join('.')).join(','))
    }
    const payload = Buffer.from(buf.subarray(FIXED_HEADER_BYTES + headerLen))
    if (payload.byteLength > 0 && !PAYLOAD_TYPES.has(type)) throw new WireError('unexpected_payload', type)
    if (PAYLOAD_TYPES.has(type)) return { type, header: parsed.data, payload } as Frame
    return { type, header: parsed.data } as Frame
}
