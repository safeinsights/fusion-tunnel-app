import { z } from 'zod'
import { MAX_CHUNK_BYTES } from '@/relay-protocol'

// Byte layouts of the end-to-end channel — WIRE CONTRACTS between the two tunnels, frozen at v1.
// Both tunnels must produce identical bytes; any change is a protocol version bump.

export const NOISE_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_BLAKE2b'

/**
 * Handshake prologue (v2 §6) — binds studyId ‖ relaySessionId ‖ both org slugs ‖ both roles ‖
 * both key generations ‖ the BMA-minted session nonce. Roles are bound positionally: the source
 * fields always come first. Layout:
 *
 *   "SI-FUSION-PROLOGUE-v1"                      ascii, no terminator
 *   u16BE len ‖ studyId                           utf8
 *   u16BE len ‖ relaySessionId                    utf8
 *   u16BE len ‖ sourceOrgSlug                     utf8
 *   u16BE len ‖ destinationOrgSlug                utf8
 *   u32BE sourceGeneration
 *   u32BE destinationGeneration
 *   32 bytes sessionNonce
 */
export const PROLOGUE_DOMAIN = 'SI-FUSION-PROLOGUE-v1'

export const PrologueInputsSchema = z.object({
    studyId: z.string().min(1).max(128),
    relaySessionId: z.string().min(1).max(128),
    sourceOrgSlug: z.string().min(1).max(64),
    destinationOrgSlug: z.string().min(1).max(64),
    sourceGeneration: z.int().positive().max(0xffff_ffff),
    destinationGeneration: z.int().positive().max(0xffff_ffff),
    /** 32 raw bytes. */
    sessionNonce: z.instanceof(Buffer).refine((b) => b.byteLength === 32, { message: 'sessionNonce must be 32 bytes' }),
})
export type PrologueInputs = z.infer<typeof PrologueInputsSchema>

/**
 * Chunk header, fed as AEAD associated data on every transport frame (v2 §7.2). Layout:
 *
 *   "SI-FUSION-CHUNK-v1"                         ascii, no terminator
 *   16 bytes messageId                            UUID bytes
 *   u32BE chunkIndex
 *   u32BE chunkCount
 *   16 bytes senderConnectionId                   UUID bytes
 */
export const CHUNK_AAD_DOMAIN = 'SI-FUSION-CHUNK-v1'
export const CHUNK_HEADER_BYTES = CHUNK_AAD_DOMAIN.length + 16 + 4 + 4 + 16

/**
 * Transport frame = u64BE counter ‖ ChaCha20-Poly1305 ciphertext (plaintext ‖ 16-byte tag).
 * The counter is the AEAD nonce (Noise encoding: 32 zero bits ‖ u64LE n) and is carried
 * explicitly because frames can be lost or reordered across socket drops and retransmissions;
 * the receiver keeps a per-direction replay window instead of an implicit counter (ADR 0001).
 */
export const TRANSPORT_COUNTER_BYTES = 8
export const AEAD_TAG_BYTES = 16
export const TRANSPORT_FRAME_OVERHEAD = TRANSPORT_COUNTER_BYTES + AEAD_TAG_BYTES
/** Receive-side replay window: counters more than this far below the highest seen are rejected. */
export const REPLAY_WINDOW = 1024

/** Epoch tag = first 8 bytes of the Noise handshake hash, hex — identifies one set of session keys. */
export const EPOCH_TAG_BYTES = 8
export const EpochTagSchema = z.string().regex(/^[0-9a-f]{16}$/)

/**
 * Padding (v2 §7.2, §9): every transport frame on the wire is one of these sizes. Buckets are
 * security parameters, not tuning: they bound what the relay can learn from frame sizes, so they
 * are frozen here rather than read from the environment. Each chunk plaintext is
 * `u32BE dataLen ‖ data ‖ zero fill` up to `bucket − TRANSPORT_FRAME_OVERHEAD`.
 */
export const PAD_BUCKETS: readonly number[] = Object.freeze([1024, 2048, 4096, 8192, 16384, MAX_CHUNK_BYTES])
export const PAD_LENGTH_BYTES = 4

// ---- channel message (the plaintext inside the AEAD) ------------------------------------------

/**
 * What one logical message decrypts to, as canonical UTF-8 JSON. `correlationId` lives here,
 * inside the ciphertext, never in relay-visible metadata. The only control message is CLOSE, which
 * carries the terminal code (v2 §7.6): the peer learns whether the study completed, a cap was
 * breached, or the session errored from an authenticated message, never from the relay.
 */
export const CHANNEL_MESSAGE_VERSION = 1

export const JsonValueSchema = z.json()
export type JsonValue = z.infer<typeof JsonValueSchema>

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

/** Why a leg ended; carried in the authenticated CLOSE and echoed by the local API's terminal body. */
export const TerminalCodeSchema = z.enum(['STUDY_COMPLETE', 'SESSION_ERRORED', 'LIMIT_EXCEEDED'])
export type TerminalCode = z.infer<typeof TerminalCodeSchema>

export const LimitSchema = z.object({
    cap: z.string().min(1).max(64),
    limit: z.int().nonnegative(),
    observed: z.int().nonnegative(),
})
export type Limit = z.infer<typeof LimitSchema>

export const ChannelMessageSchema = z.discriminatedUnion('kind', [
    z.object({
        v: z.literal(CHANNEL_MESSAGE_VERSION),
        kind: z.literal('query'),
        correlationId: z.uuid(),
        payload: JsonValueSchema,
    }),
    z.object({
        v: z.literal(CHANNEL_MESSAGE_VERSION),
        kind: z.literal('response'),
        correlationId: z.uuid(),
        payload: JsonValueSchema,
        budget: BudgetSchema.optional(),
    }),
    z.object({
        v: z.literal(CHANNEL_MESSAGE_VERSION),
        kind: z.literal('control'),
        control: z.literal('CLOSE'),
        code: TerminalCodeSchema,
        reason: z.string().max(256).optional(),
        budget: BudgetSchema.optional(),
        limit: LimitSchema.optional(),
    }),
])
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>
export type CloseMessage = Extract<ChannelMessage, { kind: 'control' }>
