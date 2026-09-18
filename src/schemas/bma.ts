import { sign as rsaSign, verify as rsaVerify, createPublicKey, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { STATES } from '@/lib/lifecycle'
import { EpochTagSchema } from '@/schemas/relay-wire'
import { BudgetSchema } from '@/schemas/local-api'
import { CapsConsumedSchema, RoleSchema } from '@/schemas/provisioning'

// Management-App (BMA) fusion contract as the tunnel consumes it (owned here — plan §0.3; the
// BMA team implements against it). Everything is scoped by legId: directory rows and the
// generation counter per (study, leg, org), one relay session and one nonce per leg (plan §10).

const base64urlBytes = (bytes: number) =>
    z.base64url().refine((value) => Buffer.from(value, 'base64url').byteLength === bytes, {
        message: `must decode to ${bytes} bytes`,
    })
const Id = z.string().min(1).max(128)
const OrgSlug = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

// ---- key blobs -------------------------------------------------------------------------------

export const TUNNEL_KEY_DOMAIN = 'SI-FUSION-TUNNEL-KEY-v1'

export const KeyBlobSchema = z.object({
    connectionId: z.uuid(),
    publicKey: base64urlBytes(32),
    popKey: base64urlBytes(32),
    fingerprint: base64urlBytes(32),
    /** base64url RSASSA-PKCS1-v1_5/SHA-256 signature by the publishing org's key over keyBlobSignaturePayload. */
    keySignature: z.base64url().min(1),
})
export type KeyBlob = z.infer<typeof KeyBlobSchema>

/** PUT /tunnel/keys — Setup App, org-JWT. Append-only; the directory assigns the generation. */
export const PublishKeyRequestSchema = KeyBlobSchema.extend({ studyId: Id, jobId: Id, legId: Id })
export type PublishKeyRequest = z.infer<typeof PublishKeyRequestSchema>
export const PublishKeyResponseSchema = z.object({ generation: z.int().positive() })

/** GET /tunnel/peer-key?legId= — delegated credential. 204 until the peer has published. */
export const PeerKeyResponseSchema = KeyBlobSchema.extend({
    studyId: Id,
    jobId: Id,
    legId: Id,
    /** The publishing org — must equal the pinned peerOrgSlug; the verifier never trusts its key from here. */
    orgSlug: OrgSlug,
    generation: z.int().positive(),
})
export type PeerKeyResponse = z.infer<typeof PeerKeyResponseSchema>

export type KeyBlobSignatureInput = {
    studyId: string
    jobId: string
    legId: string
    connectionId: string
    publicKey: Buffer
    popKey: Buffer
}

const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    if (bytes.byteLength > 0xffff) throw new RangeError('signature field exceeds 65535 bytes')
    const out = Buffer.alloc(2 + bytes.byteLength)
    out.writeUInt16BE(bytes.byteLength, 0)
    bytes.copy(out, 2)
    return out
}

/**
 * `"SI-FUSION-TUNNEL-KEY-v1" ‖ studyId ‖ jobId ‖ legId ‖ connectionId ‖ publicKey ‖ popKey`
 * (v2 §4.3, plan Phase 6 — legId added so a hub tunnel's blob cannot be replayed into the
 * sibling leg's slot). String fields are u16BE-length-prefixed utf8; keys are raw 32 bytes.
 */
export const keyBlobSignaturePayload = (input: KeyBlobSignatureInput): Buffer =>
    Buffer.concat([
        Buffer.from(TUNNEL_KEY_DOMAIN, 'ascii'),
        lengthPrefixed(input.studyId),
        lengthPrefixed(input.jobId),
        lengthPrefixed(input.legId),
        lengthPrefixed(input.connectionId),
        input.publicKey,
        input.popKey,
    ])

/** Org-key signature (RSASSA-PKCS1-v1_5 with SHA-256 — the org key's RS256 family). Setup App side. */
export const signKeyBlob = (orgPrivateKey: KeyObject, input: KeyBlobSignatureInput): Buffer =>
    rsaSign('sha256', keyBlobSignaturePayload(input), orgPrivateKey)

export const verifyKeyBlobSignature = (
    orgPublicKeyPem: string,
    input: KeyBlobSignatureInput,
    signature: Buffer,
): boolean => {
    try {
        return rsaVerify('sha256', keyBlobSignaturePayload(input), createPublicKey(orgPublicKeyPem), signature)
    } catch {
        return false
    }
}

// ---- relay session and credentials -----------------------------------------------------------

export const TUNNEL_CREDENTIAL_AUDIENCE = 'safeinsights:fusion-tunnel-api'

/** Claims of the delegated tunnel credential (v2 §5). The tunnel carries it; it never verifies it. */
export const DelegatedCredentialClaimsSchema = z.object({
    aud: z.literal(TUNNEL_CREDENTIAL_AUDIENCE),
    iss: z.string().min(1),
    exp: z.int(),
    iat: z.int(),
    component: z.literal('tunnel'),
    studyId: Id,
    jobId: Id,
    legId: Id,
    orgSlug: OrgSlug,
    role: RoleSchema,
})
export type DelegatedCredentialClaims = z.infer<typeof DelegatedCredentialClaimsSchema>

/**
 * GET /tunnel/relay-session?legId= — org-JWT (Setup App at provisioning, also receives the
 * delegated credential) or delegated credential (tunnel refreshing its relay token).
 */
export const RelaySessionResponseSchema = z.object({
    relayEndpoint: z.url({ protocol: /^(wss|ws|https|http)$/ }),
    relaySessionId: Id,
    relayToken: z.string().min(1),
    relayTokenExpiresAt: z.iso.datetime(),
    role: RoleSchema,
    direction: z.string().min(1).max(128),
    peerOrgSlug: OrgSlug,
    sessionNonce: base64urlBytes(32),
    /** Present only on org-JWT calls (provisioning). */
    credential: z.string().min(1).optional(),
    credentialExpiresAt: z.iso.datetime().optional(),
})
export type RelaySessionResponse = z.infer<typeof RelaySessionResponseSchema>

/** POST /tunnel/credential — delegated credential; returns a fresh one. */
export const CredentialResponseSchema = z.object({
    credential: z.string().min(1),
    expiresAt: z.iso.datetime(),
})
export type CredentialResponse = z.infer<typeof CredentialResponseSchema>

// ---- status reports --------------------------------------------------------------------------

/**
 * POST /tunnel/status — delegated credential. Content-free by construction (v2 §12): a strict
 * object of counters and identifiers; no field can carry payload content. The cap counters let
 * the BMA serve `capsConsumed` back on re-provision (plan §10).
 */
export const StatusReportSchema = z.strictObject({
    studyId: Id,
    jobId: Id,
    legId: Id,
    orgSlug: OrgSlug,
    role: RoleSchema,
    connectionId: z.uuid(),
    state: z.enum(STATES),
    relayAdmitted: z.boolean(),
    epochTag: EpochTagSchema.optional(),
    ownGeneration: z.int().positive(),
    peerGeneration: z.int().positive().optional(),
    framesSent: z.int().nonnegative(),
    messagesSent: z.int().nonnegative(),
    messagesAcked: z.int().nonnegative(),
    messagesReceived: z.int().nonnegative(),
    lastSeqReceived: z.int().nonnegative().optional(),
    roundsCompleted: z.int().nonnegative(),
    outboxDepth: z.int().nonnegative(),
    pendingAcks: z.int().nonnegative(),
    caps: z
        .strictObject({
            consumed: CapsConsumedSchema,
            budget: BudgetSchema,
        })
        .optional(),
    peerKeyRejected: z.boolean(),
    terminal: z
        .strictObject({
            code: z.enum(['STUDY_COMPLETE', 'SESSION_ERRORED', 'LIMIT_EXCEEDED']),
            reason: z.string().max(256),
        })
        .optional(),
    reason: z.enum(['interval', 'near_limit', 'transition', 'terminal', 'round']),
    reportedAt: z.iso.datetime(),
})
export type StatusReport = z.infer<typeof StatusReportSchema>

// ---- run groups (BMA state machine, mirrored for the harness) -------------------------------

export const RunLegSchema = z.object({
    legId: Id,
    sourceOrgSlug: OrgSlug,
    destinationOrgSlug: OrgSlug,
    sourceJobId: Id,
    destinationJobId: Id,
})
export type RunLeg = z.infer<typeof RunLegSchema>

export const RunStatusSchema = z.enum(['pending', 'visible', 'paired-running', 'complete', 'failed'])
export type RunStatus = z.infer<typeof RunStatusSchema>
