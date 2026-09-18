// Environment parsing and the protocol tuning table.
//
// Every tuning value below is PROVISIONAL — v2 §15.6: the architecture fixes the mechanisms,
// not the numbers. Defaults are placeholders to be tuned during load testing against the real
// relay; each is overridable through the named environment variable.

/** Maximum ciphertext bytes per chunk. Fixed by the spec (v2 §7.2), deliberately not tunable. */
export const CHUNK_CIPHERTEXT_MAX_BYTES = 32 * 1024
/** Smallest padding bucket (a transport frame size) — mirrors schemas/channel.ts MIN_PAD_BUCKET. */
export const MIN_PAD_BUCKET = 64

export class ConfigError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ConfigError'
    }
}

export type Tuning = {
    /** Plaintext size above which a message travels via the relay blob store (§7.2). */
    inlineCapBytes: number
    /** Ascending padding buckets in bytes, measured as transport-frame (wire) sizes (§7.2, §9). */
    padBuckets: number[]
    /** Local in-flight window defaults; the relay's ADMITTED frame advertises the authoritative limits. */
    inflightMaxMsgs: number
    inflightMaxBytes: number
    /** SDK-facing default round timeout. */
    roundTimeoutMs: number
    /** How long a long-poll route holds before answering empty. */
    longPollMs: number
    /** Relay heartbeat cadence and how many misses count as a dead connection. */
    heartbeatMs: number
    heartbeatMisses: number
    /** Exponential reconnect backoff bounds (jitter is applied on top). */
    reconnectMinMs: number
    reconnectMaxMs: number
    /** Fetch a replacement relay token this long before the current one expires. */
    tokenRefreshLeadMs: number
    /** Content-free status report cadence to the BMA (§12). */
    statusIntervalMs: number
    /** Peer-key directory poll interval while the peer has not published (204). */
    peerKeyPollMs: number
    /** Bound on the CLOSE sequence before the tunnel gives up waiting for acks (§7.6). */
    closeTimeoutMs: number
    /** Initiator resends handshake message 1 at this cadence until message 2 arrives. */
    handshakeRetryMs: number
    handshakeMaxAttempts: number
    /** Delay before re-offering a message the relay answered with BACKPRESSURE. */
    backpressureRetryMs: number
    /** Bound on bytes held in partially reassembled inbound messages. */
    inboxMaxPartialBytes: number
    /** Blob store PUT/GET retry cadence and attempt bound (v2 §7.2). */
    blobRetryMs: number
    blobMaxAttempts: number
}

// PROVISIONAL — §15.6, tune during load testing
export const TUNING_DEFAULTS: Readonly<Tuning> = Object.freeze({
    inlineCapBytes: 256 * 1024,
    padBuckets: [1024, 2048, 4096, 8192, 16384, 32768],
    inflightMaxMsgs: 64,
    inflightMaxBytes: 32 * 1024 * 1024,
    roundTimeoutMs: 600_000,
    longPollMs: 25_000,
    heartbeatMs: 30_000,
    heartbeatMisses: 2,
    reconnectMinMs: 500,
    reconnectMaxMs: 30_000,
    tokenRefreshLeadMs: 120_000,
    statusIntervalMs: 60_000,
    peerKeyPollMs: 5_000,
    closeTimeoutMs: 30_000,
    handshakeRetryMs: 2_000,
    handshakeMaxAttempts: 300,
    backpressureRetryMs: 500,
    inboxMaxPartialBytes: 64 * 1024 * 1024,
    blobRetryMs: 500,
    blobMaxAttempts: 8,
})

export const TUNING_ENV: Readonly<Record<keyof Tuning, string>> = Object.freeze({
    inlineCapBytes: 'FUSION_INLINE_CAP_BYTES',
    padBuckets: 'FUSION_PAD_BUCKETS',
    inflightMaxMsgs: 'FUSION_INFLIGHT_MAX_MSGS',
    inflightMaxBytes: 'FUSION_INFLIGHT_MAX_BYTES',
    roundTimeoutMs: 'FUSION_ROUND_TIMEOUT_MS',
    longPollMs: 'FUSION_LONGPOLL_MS',
    heartbeatMs: 'FUSION_HEARTBEAT_MS',
    heartbeatMisses: 'FUSION_HEARTBEAT_MISSES',
    reconnectMinMs: 'FUSION_RECONNECT_MIN_MS',
    reconnectMaxMs: 'FUSION_RECONNECT_MAX_MS',
    tokenRefreshLeadMs: 'FUSION_TOKEN_REFRESH_LEAD_MS',
    statusIntervalMs: 'FUSION_STATUS_INTERVAL_MS',
    peerKeyPollMs: 'FUSION_PEERKEY_POLL_MS',
    closeTimeoutMs: 'FUSION_CLOSE_TIMEOUT_MS',
    handshakeRetryMs: 'FUSION_HANDSHAKE_RETRY_MS',
    handshakeMaxAttempts: 'FUSION_HANDSHAKE_MAX_ATTEMPTS',
    backpressureRetryMs: 'FUSION_BACKPRESSURE_RETRY_MS',
    inboxMaxPartialBytes: 'FUSION_INBOX_MAX_BYTES',
    blobRetryMs: 'FUSION_BLOB_RETRY_MS',
    blobMaxAttempts: 'FUSION_BLOB_MAX_ATTEMPTS',
})

type Env = Record<string, string | undefined>

const parsePositiveInt = (name: string, raw: string): number => {
    if (!/^\d+$/.test(raw.trim())) {
        throw new ConfigError(`${name} must be a positive integer, got "${raw}"`)
    }
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ConfigError(`${name} must be a positive integer, got "${raw}"`)
    }
    return value
}

const envPositiveInt = (env: Env, name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    return parsePositiveInt(name, raw)
}

const envBuckets = (env: Env, name: string, fallback: number[]): number[] => {
    const raw = env[name]
    if (raw === undefined || raw === '') return [...fallback]
    const buckets = raw.split(',').map((part) => parsePositiveInt(name, part))
    for (let i = 1; i < buckets.length; i++) {
        if (buckets[i] <= buckets[i - 1]) {
            throw new ConfigError(`${name} must be strictly ascending, got "${raw}"`)
        }
    }
    if (buckets[0] < MIN_PAD_BUCKET) {
        throw new ConfigError(`${name} buckets must be >= ${MIN_PAD_BUCKET} bytes, got "${raw}"`)
    }
    if (buckets[buckets.length - 1] > CHUNK_CIPHERTEXT_MAX_BYTES) {
        throw new ConfigError(`${name} buckets must not exceed ${CHUNK_CIPHERTEXT_MAX_BYTES} bytes, got "${raw}"`)
    }
    return buckets
}

export const loadTuning = (env: Env = process.env): Tuning => {
    const tuning: Tuning = {
        inlineCapBytes: envPositiveInt(env, TUNING_ENV.inlineCapBytes, TUNING_DEFAULTS.inlineCapBytes),
        padBuckets: envBuckets(env, TUNING_ENV.padBuckets, TUNING_DEFAULTS.padBuckets),
        inflightMaxMsgs: envPositiveInt(env, TUNING_ENV.inflightMaxMsgs, TUNING_DEFAULTS.inflightMaxMsgs),
        inflightMaxBytes: envPositiveInt(env, TUNING_ENV.inflightMaxBytes, TUNING_DEFAULTS.inflightMaxBytes),
        roundTimeoutMs: envPositiveInt(env, TUNING_ENV.roundTimeoutMs, TUNING_DEFAULTS.roundTimeoutMs),
        longPollMs: envPositiveInt(env, TUNING_ENV.longPollMs, TUNING_DEFAULTS.longPollMs),
        heartbeatMs: envPositiveInt(env, TUNING_ENV.heartbeatMs, TUNING_DEFAULTS.heartbeatMs),
        heartbeatMisses: envPositiveInt(env, TUNING_ENV.heartbeatMisses, TUNING_DEFAULTS.heartbeatMisses),
        reconnectMinMs: envPositiveInt(env, TUNING_ENV.reconnectMinMs, TUNING_DEFAULTS.reconnectMinMs),
        reconnectMaxMs: envPositiveInt(env, TUNING_ENV.reconnectMaxMs, TUNING_DEFAULTS.reconnectMaxMs),
        tokenRefreshLeadMs: envPositiveInt(env, TUNING_ENV.tokenRefreshLeadMs, TUNING_DEFAULTS.tokenRefreshLeadMs),
        statusIntervalMs: envPositiveInt(env, TUNING_ENV.statusIntervalMs, TUNING_DEFAULTS.statusIntervalMs),
        peerKeyPollMs: envPositiveInt(env, TUNING_ENV.peerKeyPollMs, TUNING_DEFAULTS.peerKeyPollMs),
        closeTimeoutMs: envPositiveInt(env, TUNING_ENV.closeTimeoutMs, TUNING_DEFAULTS.closeTimeoutMs),
        handshakeRetryMs: envPositiveInt(env, TUNING_ENV.handshakeRetryMs, TUNING_DEFAULTS.handshakeRetryMs),
        handshakeMaxAttempts: envPositiveInt(
            env,
            TUNING_ENV.handshakeMaxAttempts,
            TUNING_DEFAULTS.handshakeMaxAttempts,
        ),
        backpressureRetryMs: envPositiveInt(env, TUNING_ENV.backpressureRetryMs, TUNING_DEFAULTS.backpressureRetryMs),
        inboxMaxPartialBytes: envPositiveInt(
            env,
            TUNING_ENV.inboxMaxPartialBytes,
            TUNING_DEFAULTS.inboxMaxPartialBytes,
        ),
        blobRetryMs: envPositiveInt(env, TUNING_ENV.blobRetryMs, TUNING_DEFAULTS.blobRetryMs),
        blobMaxAttempts: envPositiveInt(env, TUNING_ENV.blobMaxAttempts, TUNING_DEFAULTS.blobMaxAttempts),
    }
    if (tuning.reconnectMaxMs < tuning.reconnectMinMs) {
        throw new ConfigError(`${TUNING_ENV.reconnectMaxMs} must be >= ${TUNING_ENV.reconnectMinMs}`)
    }
    return tuning
}

export type ServerConfig = {
    port: number
    tuning: Tuning
}

export const DEFAULT_PORT = 3003

export const loadConfig = (env: Env = process.env): ServerConfig => {
    const rawPort = env.PORT
    // PORT=0 is allowed so tests can bind an ephemeral port.
    const port =
        rawPort === undefined || rawPort === '' ? DEFAULT_PORT : rawPort === '0' ? 0 : parsePositiveInt('PORT', rawPort)
    if (port > 65535) throw new ConfigError(`PORT must be <= 65535, got "${rawPort}"`)
    return { port, tuning: loadTuning(env) }
}
