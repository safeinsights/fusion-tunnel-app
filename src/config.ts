// Environment parsing and the tuning table. Every number here is PROVISIONAL (v2 §15.6): the
// architecture fixes the mechanisms, not the values. Each knob is overridable through the named
// environment variable; tests and harnesses override the same names.

export class ConfigError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ConfigError'
    }
}

export const TUNING_DEFAULTS = Object.freeze({
    /** How long a long-poll route holds before answering empty. */
    longPollMs: 25_000,
    /** Relay heartbeat cadence and how many misses count as a dead connection (ADMITTED overrides the cadence). */
    heartbeatMs: 30_000,
    heartbeatMisses: 2,
    /** Exponential reconnect backoff bounds (jitter is applied on top). */
    reconnectMinMs: 500,
    reconnectMaxMs: 30_000,
    /** Fetch a replacement relay token / credential this long before the current one expires. */
    tokenRefreshLeadMs: 120_000,
    /** Content-free status report cadence to the BMA (§12). */
    statusIntervalMs: 60_000,
    /** Peer-key directory poll interval while the peer has not published (204). */
    peerKeyPollMs: 5_000,
    /** Bound on the CLOSE sequence before the tunnel gives up waiting for acks (§7.6). */
    closeTimeoutMs: 30_000,
    /** Initiator resends handshake message 1 at this cadence while the peer is attached, up to the bound. */
    handshakeRetryMs: 2_000,
    handshakeMaxAttempts: 300,
    /** Re-offer a sent-but-unacknowledged message this long after its last send; give up loudly after `maxSends`. */
    retransmitMs: 5_000,
    maxSends: 10,
    /** A message unacknowledged this long ends the leg loudly (replaces the relay's un-ACKed expiry). */
    unackedMaxMs: 24 * 3600 * 1000,
    /** Delay before re-offering a message the relay answered with BACKPRESSURE or RATE_LIMITED. */
    backpressureRetryMs: 500,
    /** Local outbox bound: sent-but-unacknowledged messages and their plaintext bytes. */
    inflightMaxMsgs: 64,
    outboxMaxBytes: 256 * 1024 * 1024,
    /** Largest plaintext one message may carry; the local API refuses bigger ones with 413. */
    maxMessageBytes: 64 * 1024 * 1024,
    /** Bound on bytes held in partially reassembled inbound messages. */
    inboxMaxBytes: 64 * 1024 * 1024,
    /** Keep the local API up this long after a terminal state so the RC can read the terminal body. */
    exitGraceMs: 5_000,
})

export type Tuning = { -readonly [K in keyof typeof TUNING_DEFAULTS]: number }

export const TUNING_ENV: Readonly<Record<keyof Tuning, string>> = Object.freeze({
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
    retransmitMs: 'FUSION_RETRANSMIT_MS',
    maxSends: 'FUSION_MAX_SENDS',
    unackedMaxMs: 'FUSION_UNACKED_MAX_MS',
    backpressureRetryMs: 'FUSION_BACKPRESSURE_RETRY_MS',
    inflightMaxMsgs: 'FUSION_INFLIGHT_MAX_MSGS',
    outboxMaxBytes: 'FUSION_OUTBOX_MAX_BYTES',
    maxMessageBytes: 'FUSION_MAX_MESSAGE_BYTES',
    inboxMaxBytes: 'FUSION_INBOX_MAX_BYTES',
    exitGraceMs: 'FUSION_EXIT_GRACE_MS',
})

type Env = Record<string, string | undefined>

const positiveInt = (name: string, raw: string): number => {
    const value = /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new ConfigError(`${name} must be a positive integer, got "${raw}"`)
    return value
}

export const loadTuning = (env: Env = process.env): Tuning => {
    const tuning = { ...TUNING_DEFAULTS } as Tuning
    for (const key of Object.keys(TUNING_DEFAULTS) as (keyof Tuning)[]) {
        const raw = env[TUNING_ENV[key]]
        if (raw !== undefined && raw !== '') tuning[key] = positiveInt(TUNING_ENV[key], raw)
    }
    if (tuning.reconnectMaxMs < tuning.reconnectMinMs) {
        throw new ConfigError(`${TUNING_ENV.reconnectMaxMs} must be >= ${TUNING_ENV.reconnectMinMs}`)
    }
    return tuning
}

export type ServerConfig = {
    port: number
    /**
     * Bearer token the Setup App presents on the provisioning API (/local/*). Injected into the
     * tunnel container's environment by the Setup App and never into the research container's, so
     * a co-located workload that can reach the port cannot provision (or race the Setup App to
     * provision) the tunnel. Undefined only when the variable is unset; `main()` refuses to boot then.
     */
    provisionToken: string | undefined
    tuning: Tuning
}

export const DEFAULT_PORT = 3003
export const PROVISION_TOKEN_ENV = 'FUSION_PROVISION_TOKEN'

export const loadConfig = (env: Env = process.env): ServerConfig => {
    const rawPort = env.PORT
    // PORT=0 is allowed so tests can bind an ephemeral port.
    const port =
        rawPort === undefined || rawPort === '' ? DEFAULT_PORT : rawPort === '0' ? 0 : positiveInt('PORT', rawPort)
    if (port > 65535) throw new ConfigError(`PORT must be <= 65535, got "${rawPort}"`)
    const token = env[PROVISION_TOKEN_ENV]
    if (token !== undefined && token !== '' && (token.length < 16 || token.length > 512 || /\s/.test(token))) {
        throw new ConfigError(`${PROVISION_TOKEN_ENV} must be 16-512 characters without whitespace`)
    }
    return { port, provisionToken: token || undefined, tuning: loadTuning(env) }
}
