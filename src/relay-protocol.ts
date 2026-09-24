import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    randomBytes,
    sign,
    verify,
    type KeyObject,
} from 'node:crypto'
import { z } from 'zod'

/**
 * THE relay wire contract, in one file. Canonical copy: fusion-relay/src/protocol.ts.
 * fusion-tunnel-app carries a VERBATIM copy at src/relay-protocol.ts (checked by `pnpm check:protocol`
 * there), so this file depends on nothing but zod and node:crypto.
 *
 * The relay pairs two tunnels by relaySessionId and forwards opaque frames between them. It stores
 * nothing: end-to-end reliability (outbox, retransmission, dedup, ACK) lives in the tunnels.
 *
 * Frame codec: `[version u8=2][type u8][headerLen u32BE][header JSON utf8][payload bytes]`.
 * Payload bytes are never inspected by the relay.
 */

export const WIRE_VERSION = 2
export const MAX_HEADER_BYTES = 16 * 1024
/** Maximum ciphertext bytes per DATA chunk. Fixed by the protocol, not tunable. */
export const MAX_CHUNK_BYTES = 32 * 1024
const PREAMBLE_BYTES = 6

// ---- roles ---------------------------------------------------------------------------------------

export const RoleSchema = z.enum(['source', 'destination'])
export type Role = z.infer<typeof RoleSchema>
export const otherRole = (role: Role): Role => (role === 'source' ? 'destination' : 'source')

// ---- error codes ---------------------------------------------------------------------------------

export const ERROR_CODES = [
    'AUTH_TOKEN_INVALID',
    'AUTH_TOKEN_EXPIRED',
    'AUTH_POP_FAILED',
    'AUTH_ROLE_OCCUPIED_DISPLACED',
    'BACKPRESSURE',
    'QUOTA_EXCEEDED',
    'RATE_LIMITED',
    'SESSION_CLOSED',
    'SESSION_UNPAIRED_TIMEOUT',
    'SESSION_ERRORED_DETACHED',
    'PROTOCOL_VIOLATION',
    'FRAME_TOO_LARGE',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** Whether the same operation may be retried on this session after the error. */
export const RETRYABLE: Record<ErrorCode, boolean> = {
    AUTH_TOKEN_INVALID: false,
    AUTH_TOKEN_EXPIRED: true, // fetch a fresh token and re-dial
    AUTH_POP_FAILED: false,
    AUTH_ROLE_OCCUPIED_DISPLACED: false, // informational: a newer connection took the slot
    BACKPRESSURE: true,
    QUOTA_EXCEEDED: false,
    RATE_LIMITED: true,
    SESSION_CLOSED: false,
    SESSION_UNPAIRED_TIMEOUT: false,
    SESSION_ERRORED_DETACHED: false,
    PROTOCOL_VIOLATION: false,
    FRAME_TOO_LARGE: false,
}

/** Codes after which this session can never carry traffic again. */
export const SESSION_FATAL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
    'SESSION_CLOSED',
    'SESSION_UNPAIRED_TIMEOUT',
    'SESSION_ERRORED_DETACHED',
])

/** Application WebSocket close codes (4000–4999) used when an error also terminates the socket. */
export const CLOSE_CODES = {
    AUTH_TOKEN_INVALID: 4001,
    AUTH_TOKEN_EXPIRED: 4002,
    AUTH_POP_FAILED: 4003,
    AUTH_ROLE_OCCUPIED_DISPLACED: 4004,
    PROTOCOL_VIOLATION: 4005,
    FRAME_TOO_LARGE: 4006,
    CHALLENGE_TIMEOUT: 4007,
    SESSION_CLOSED: 4010,
    SESSION_UNPAIRED_TIMEOUT: 4013,
    SESSION_ERRORED_DETACHED: 4014,
    HEARTBEAT_TIMEOUT: 4020,
    SERVER_SHUTDOWN: 4021,
} as const

export const closeCodeFor = (code: ErrorCode): number =>
    code in CLOSE_CODES ? CLOSE_CODES[code as keyof typeof CLOSE_CODES] : CLOSE_CODES.PROTOCOL_VIOLATION

export class RelayError extends Error {
    readonly retryable: boolean
    constructor(
        readonly code: ErrorCode,
        readonly detail?: string,
        readonly messageId?: string,
        readonly scope?: 'session' | 'study',
    ) {
        super(detail ? `${code}: ${detail}` : code)
        this.name = 'RelayError'
        this.retryable = RETRYABLE[code]
    }
}

// ---- frame headers -------------------------------------------------------------------------------

export const FrameType = {
    HELLO: 1,
    CHALLENGE: 2,
    CHALLENGE_RESPONSE: 3,
    ADMITTED: 4,
    PEER: 5,
    DATA: 6,
    ACK: 7,
    NACK: 8,
    HANDSHAKE: 9,
    CLOSE: 10,
    CLOSE_ACK: 11,
    ERROR: 12,
} as const
export type FrameTypeName = keyof typeof FrameType

const TYPE_NAMES = new Map<number, FrameTypeName>(
    (Object.entries(FrameType) as [FrameTypeName, number][]).map(([name, code]) => [code, name]),
)

/** Frame types that carry a payload after the header. Every other type must have an empty payload. */
export const PAYLOAD_TYPES: ReadonlySet<FrameTypeName> = new Set<FrameTypeName>(['DATA', 'HANDSHAKE', 'CLOSE'])

const base64url = (bytes: number) =>
    z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .refine((s) => Buffer.from(s, 'base64url').byteLength === bytes, { message: `must decode to ${bytes} bytes` })

/**
 * Identifier claims become map keys and log fields, so their charset is pinned: no `#`, `/` or
 * whitespace can alias one session onto another, whatever the issuer minted.
 */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const Id = z.string().regex(IDENTIFIER_PATTERN, 'must be 1-128 chars of [A-Za-z0-9_-]')
const MessageId = z.string().min(1).max(64)
const Fingerprint = z.string().min(1).max(256)

export const HelloHeader = z.strictObject({ token: z.string().min(1).max(8192), relaySessionId: Id, role: RoleSchema })
export const ChallengeHeader = z.strictObject({ nonce: base64url(32) })
export const ChallengeResponseHeader = z.strictObject({ signature: base64url(64) })
/** Who is on the other side of the session, if anyone. A fingerprint the tunnel did not handshake with means the peer restarted. */
export const PeerHeader = z.strictObject({ attached: z.boolean(), fingerprint: Fingerprint.optional() })
export const AdmittedHeader = z.strictObject({
    relaySessionId: Id,
    legId: Id,
    role: RoleSchema,
    /** WSS ping cadence the relay uses; 0 means it sends none. */
    heartbeatIntervalMs: z.int().nonnegative(),
    peer: PeerHeader,
})
export const DataHeader = z
    .strictObject({ messageId: MessageId, chunkIndex: z.int().nonnegative(), chunkCount: z.int().positive() })
    .refine((h) => h.chunkIndex < h.chunkCount, { message: 'chunkIndex must be < chunkCount' })
export const AckHeader = z.strictObject({ messageId: MessageId })
export const NackHeader = z.strictObject({ messageId: MessageId, reason: z.string().min(1).max(64) })
export const EmptyHeader = z.strictObject({})
export const ErrorHeader = z.strictObject({
    code: z.enum(ERROR_CODES),
    retryable: z.boolean(),
    detail: z.string().max(512).optional(),
    messageId: MessageId.optional(),
    /** QUOTA_EXCEEDED only: which budget was breached. */
    scope: z.enum(['session', 'study']).optional(),
})

export type HelloHeader = z.infer<typeof HelloHeader>
export type ChallengeHeader = z.infer<typeof ChallengeHeader>
export type ChallengeResponseHeader = z.infer<typeof ChallengeResponseHeader>
export type PeerHeader = z.infer<typeof PeerHeader>
export type AdmittedHeader = z.infer<typeof AdmittedHeader>
export type DataHeader = z.infer<typeof DataHeader>
export type AckHeader = z.infer<typeof AckHeader>
export type NackHeader = z.infer<typeof NackHeader>
export type ErrorHeader = z.infer<typeof ErrorHeader>

const HEADER_SCHEMAS: Record<FrameTypeName, z.ZodType> = {
    HELLO: HelloHeader,
    CHALLENGE: ChallengeHeader,
    CHALLENGE_RESPONSE: ChallengeResponseHeader,
    ADMITTED: AdmittedHeader,
    PEER: PeerHeader,
    DATA: DataHeader,
    ACK: AckHeader,
    NACK: NackHeader,
    HANDSHAKE: EmptyHeader,
    CLOSE: EmptyHeader,
    CLOSE_ACK: EmptyHeader,
    ERROR: ErrorHeader,
}

export type Frame =
    | { type: 'HELLO'; header: HelloHeader }
    | { type: 'CHALLENGE'; header: ChallengeHeader }
    | { type: 'CHALLENGE_RESPONSE'; header: ChallengeResponseHeader }
    | { type: 'ADMITTED'; header: AdmittedHeader }
    | { type: 'PEER'; header: PeerHeader }
    | { type: 'DATA'; header: DataHeader; payload: Buffer }
    | { type: 'ACK'; header: AckHeader }
    | { type: 'NACK'; header: NackHeader }
    | { type: 'HANDSHAKE'; header: Record<string, never>; payload: Buffer }
    | { type: 'CLOSE'; header: Record<string, never>; payload: Buffer }
    | { type: 'CLOSE_ACK'; header: Record<string, never> }
    | { type: 'ERROR'; header: ErrorHeader }

export type FrameOf<T extends FrameTypeName> = Extract<Frame, { type: T }>

// ---- codec ----------------------------------------------------------------------------------------

export class FrameDecodeError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'FrameDecodeError'
    }
}

export const encodeFrame = (frame: Frame): Buffer => {
    const header = Buffer.from(JSON.stringify(frame.header ?? {}), 'utf8')
    if (header.byteLength > MAX_HEADER_BYTES) throw new FrameDecodeError(`header exceeds ${MAX_HEADER_BYTES} bytes`)
    const payload = 'payload' in frame && frame.payload ? frame.payload : Buffer.alloc(0)
    if (payload.byteLength > 0 && !PAYLOAD_TYPES.has(frame.type)) {
        throw new FrameDecodeError(`frame type ${frame.type} does not carry a payload`)
    }
    const out = Buffer.allocUnsafe(PREAMBLE_BYTES + header.byteLength + payload.byteLength)
    out.writeUInt8(WIRE_VERSION, 0)
    out.writeUInt8(FrameType[frame.type], 1)
    out.writeUInt32BE(header.byteLength, 2)
    header.copy(out, PREAMBLE_BYTES)
    payload.copy(out, PREAMBLE_BYTES + header.byteLength)
    return out
}

/** Total over arbitrary input: every malformed shape throws FrameDecodeError, never anything else. */
export const decodeFrame = (input: Uint8Array): Frame => {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    if (buf.byteLength < PREAMBLE_BYTES) throw new FrameDecodeError('frame shorter than preamble')
    const version = buf.readUInt8(0)
    if (version !== WIRE_VERSION) throw new FrameDecodeError(`unsupported frame version ${version}`)
    const type = TYPE_NAMES.get(buf.readUInt8(1))
    if (!type) throw new FrameDecodeError(`unknown frame type ${buf.readUInt8(1)}`)
    const headerLen = buf.readUInt32BE(2)
    if (headerLen > MAX_HEADER_BYTES || PREAMBLE_BYTES + headerLen > buf.byteLength) {
        throw new FrameDecodeError(`invalid header length ${headerLen}`)
    }
    let raw: unknown
    try {
        raw = JSON.parse(buf.toString('utf8', PREAMBLE_BYTES, PREAMBLE_BYTES + headerLen))
    } catch {
        throw new FrameDecodeError('header is not valid JSON')
    }
    const parsed = HEADER_SCHEMAS[type].safeParse(raw)
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const where = issue?.path.length ? issue.path.join('.') : 'header'
        throw new FrameDecodeError(`invalid ${type} header: ${where} ${issue?.message ?? 'invalid'}`)
    }
    // Copy so the frame never aliases the socket's receive buffer.
    const payload = Buffer.from(buf.subarray(PREAMBLE_BYTES + headerLen))
    if (payload.byteLength > 0 && !PAYLOAD_TYPES.has(type)) {
        throw new FrameDecodeError(`frame type ${type} does not carry a payload`)
    }
    if (PAYLOAD_TYPES.has(type)) return { type, header: parsed.data, payload } as Frame
    return { type, header: parsed.data } as Frame
}

// ---- relay token claims (the BMA issuance contract) -----------------------------------------------

export const RELAY_TOKEN_AUDIENCE = 'safeinsights:fusion-relay'
/** The issuer the relay pins by default; overridable per deployment through `BMA_RELAY_TOKEN_ISSUER`. */
export const RELAY_TOKEN_ISSUER = 'safeinsights:bma'

export const RelayTokenClaims = z
    .object({
        aud: z.union([
            z.literal(RELAY_TOKEN_AUDIENCE),
            z.array(z.string()).refine((a) => a.includes(RELAY_TOKEN_AUDIENCE)),
        ]),
        iss: z.string().min(1),
        exp: z.int(),
        iat: z.int(),
        relaySessionId: Id,
        role: RoleSchema,
        /** Fingerprint of the tunnel's published static key: `base64url(SHA-256(publicKey ‖ popKey))`. */
        fingerprint: Fingerprint,
        /** base64url raw 32-byte Ed25519 public key for the PoP challenge. */
        popKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        studyId: Id,
        jobId: Id,
        /** The source→destination leg within the study — routing metadata only, never pairing. */
        legId: Id,
    })
    .passthrough()
export type RelayTokenClaims = z.infer<typeof RelayTokenClaims>

// ---- proof of possession ---------------------------------------------------------------------------

/**
 * The relay challenges a connecting tunnel to sign a fresh nonce with the Ed25519 key embedded in
 * its token. The signed payload is domain-separated and binds the session and role, so a signature
 * can neither be confused with any other use of the key nor replayed toward another session or role.
 */
export const POP_DOMAIN = 'SI-FUSION-RELAY-POP-v1'
export const POP_NONCE_BYTES = 32

export const popPayload = (nonce: Uint8Array, relaySessionId: string, role: Role): Buffer => {
    if (nonce.byteLength !== POP_NONCE_BYTES) throw new Error(`nonce must be ${POP_NONCE_BYTES} bytes`)
    return Buffer.concat([
        Buffer.from(POP_DOMAIN, 'utf8'),
        Buffer.from(nonce),
        Buffer.from(relaySessionId, 'utf8'),
        Buffer.from(role, 'utf8'),
    ])
}

export const newNonce = (): Buffer => randomBytes(POP_NONCE_BYTES)

/** Raw 32-byte Ed25519 public key (base64url in the token) → KeyObject. */
export const popPublicKeyFromRaw = (rawBase64url: string): KeyObject => {
    const raw = Buffer.from(rawBase64url, 'base64url')
    if (raw.byteLength !== 32) throw new Error('popKey must be a raw 32-byte Ed25519 public key')
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

export const popPublicKeyToRaw = (publicKey: KeyObject): string => {
    const jwk = publicKey.export({ format: 'jwk' }) as { x?: string }
    if (!jwk.x) throw new Error('not an Ed25519 public key')
    return Buffer.from(jwk.x, 'base64url').toString('base64url')
}

export const signPop = (privateKey: KeyObject, nonce: Uint8Array, relaySessionId: string, role: Role): Buffer =>
    sign(null, popPayload(nonce, relaySessionId, role), privateKey)

export const verifyPop = (
    publicKey: KeyObject,
    nonce: Uint8Array,
    relaySessionId: string,
    role: Role,
    signature: Uint8Array,
): boolean => {
    if (signature.byteLength !== 64) return false
    try {
        return verify(null, popPayload(nonce, relaySessionId, role), publicKey, signature)
    } catch {
        return false
    }
}

export type PopKeyPair = { publicKey: KeyObject; privateKey: KeyObject; popKey: string }

export const generatePopKeyPair = (): PopKeyPair => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    return { publicKey, privateKey, popKey: popPublicKeyToRaw(publicKey) }
}

export const popPrivateKeyFromPem = (pem: string): KeyObject => createPrivateKey(pem)
