import { z } from 'zod'
import { BudgetSchema, JsonValueSchema } from '@/schemas/local-api'

// Byte layouts of the end-to-end channel — WIRE CONTRACTS, frozen at v1 (plan Phase 3). Both
// tunnels must produce identical bytes; any change is a protocol version bump.

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
 * explicitly because the relay redelivers byte-identical frames within an epoch; the receiver
 * keeps a per-direction replay window instead of an implicit counter (ADR 0001).
 */
export const TRANSPORT_COUNTER_BYTES = 8
export const AEAD_TAG_BYTES = 16
export const TRANSPORT_FRAME_OVERHEAD = TRANSPORT_COUNTER_BYTES + AEAD_TAG_BYTES
/** Receive-side replay window: counters more than this far below the highest seen are rejected. */
export const REPLAY_WINDOW = 1024

/** Epoch tag = first 8 bytes of the Noise handshake hash, hex — identifies one set of session keys. */
export const EPOCH_TAG_BYTES = 8

// ---- channel message (the plaintext inside the AEAD) ------------------------------------------

/**
 * What one logical message decrypts to, as canonical UTF-8 JSON. `correlationId` lives here,
 * inside the ciphertext, never in relay-visible metadata. Control messages ride the same path so
 * they are authenticated end to end: LIMIT_EXCEEDED (source → destination, caps breach) and CLOSE
 * (destination → source, v2 §7.6). `budget` is the source's content-free consumption hint.
 */
export const CHANNEL_MESSAGE_VERSION = 1

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
        control: z.enum(['CLOSE', 'LIMIT_EXCEEDED']),
        reason: z.string().max(256).optional(),
        budget: BudgetSchema.optional(),
    }),
])
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>

/** Padding: each chunk plaintext is `u32BE dataLen ‖ data ‖ zero fill` up to `bucket − TRANSPORT_FRAME_OVERHEAD`. */
export const PAD_LENGTH_BYTES = 4
/** Smallest sensible padding bucket (frame size): room for the counter, tag, length prefix and some data. */
export const MIN_PAD_BUCKET = 64
