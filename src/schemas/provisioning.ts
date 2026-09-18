import { z } from 'zod'

// Setup-App-facing provisioning contract (owned by this repo — plan §0.3). `GET /local/identity`
// returns IdentityResponse; `POST /local/configure` accepts ConfigurationBundle. Payloads on
// this API are plaintext and never leave the enclave in that form.

export const KEY_BYTES = 32

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

export const RoleSchema = z.enum(['source', 'destination'])
export type Role = z.infer<typeof RoleSchema>

/** What the tunnel hands the Setup App at launch; `fingerprint = base64url(SHA-256(publicKey ‖ popKey))`. */
export const IdentityResponseSchema = z.object({
    connectionId: z.uuid(),
    publicKey: base64urlBytes(KEY_BYTES),
    popKey: base64urlBytes(KEY_BYTES),
    fingerprint: base64urlBytes(KEY_BYTES),
})
export type IdentityResponse = z.infer<typeof IdentityResponseSchema>

/**
 * Per-study caps from the Data-Partner-approved manifest, enforced by the source tunnel
 * (security review §7.3; hub memo §2.3). An absent field means no limit on that dimension.
 */
export const CapsSchema = z.object({
    maxRounds: z.int().positive().optional(),
    maxRoundsPerHour: z.int().positive().optional(),
    maxResponsePlaintextBytesPerRound: z.int().positive().optional(),
    maxCumulativeResponsePlaintextBytes: z.int().positive().optional(),
    maxQueryPlaintextBytesPerRound: z.int().positive().optional(),
    maxCumulativeQueryPlaintextBytes: z.int().positive().optional(),
})
export type Caps = z.infer<typeof CapsSchema>

/** Cumulative consumption re-seeded on re-provision (the tunnel persists nothing — plan §10). */
export const CapsConsumedSchema = z.object({
    rounds: z.int().nonnegative(),
    responsePlaintextBytes: z.int().nonnegative(),
    queryPlaintextBytes: z.int().nonnegative(),
})
export type CapsConsumed = z.infer<typeof CapsConsumedSchema>

/** SDK handler-wrapper guards passed through untouched on GET /v1/info (SDK ask T3). */
export const GuardsSchema = z.object({
    maxDistinctPersonIds: z.int().positive().optional(),
    minGroupSize: z.int().positive().optional(),
})
export type Guards = z.infer<typeof GuardsSchema>

export const OperationSchema = z.object({
    name: z.string().min(1).max(128),
    cardinality: z.enum(['aggregate', 'per-group', 'per-record']),
})
export type Operation = z.infer<typeof OperationSchema>

export const PemPublicKeySchema = z
    .string()
    .max(16_384)
    .regex(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/, {
        message: 'must be an SPKI public key PEM',
    })

export const ConfigurationBundleSchema = z.object({
    studyId: Id,
    jobId: Id,
    /** The source→destination leg this instance serves; a two-party study has one leg (plan §10). */
    legId: Id,
    role: RoleSchema,
    /** Informational label of the approved direction of flow; enforcement is structural via `role`. */
    direction: z.string().min(1).max(128),
    orgSlug: OrgSlug,
    peerOrgSlug: OrgSlug,
    /** This tunnel's directory-assigned key generation, learned by the Setup App at PUT /tunnel/keys. */
    keyGeneration: z.int().positive(),
    relay: z.object({
        endpoint: z.url({ protocol: /^(wss|ws|https|http)$/ }),
        sessionId: Id,
        token: z.string().min(1).max(8192),
    }),
    bma: z.object({
        endpoint: z.url({ protocol: /^https?$/ }),
        /** The delegated tunnel credential (short-lived, job-scoped JWT — v2 §5). */
        credential: z.string().min(1).max(8192),
    }),
    /** BMA-minted 32-byte nonce, identical on both sides of the leg (v2 §6). */
    sessionNonce: base64urlBytes(KEY_BYTES),
    /** The pinned peer-org public key from the approved study configuration (invariant 8). */
    peerOrgPublicKey: PemPublicKeySchema,
    /** Bearer token the RC presents on every /v1/* call; minted by the Setup App per tunnel. */
    localApiToken: z.string().min(16).max(512),
    caps: CapsSchema.default({}),
    capsConsumed: CapsConsumedSchema.optional(),
    guards: GuardsSchema.optional(),
    operations: z.array(OperationSchema).max(256).optional(),
})
export type ConfigurationBundle = z.infer<typeof ConfigurationBundleSchema>

export const ConfigureResponseSchema = z.object({
    state: z.string(),
    configured: z.boolean(),
})
