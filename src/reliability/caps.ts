import type { Budget } from '@/schemas/local-api'
import type { Caps, CapsConsumed } from '@/schemas/provisioning'

// Source-enforced per-study caps (security review §7.3; hub memo §2.3; plan §10). The source
// tunnel meters plaintext: response bytes per round and cumulative, query bytes per round and
// cumulative (the decrypted query may carry information derived from another source's answers),
// rounds, and rounds per hour. Limits come from the Data-Partner-approved manifest through the
// configuration bundle; cumulative counters are re-seeded from `capsConsumed` on re-provision
// because the tunnel persists nothing. A breach is loud and terminal — never silent throttling.

export type CapLimit = keyof Caps

export type CapsVerdict = { ok: true } | { ok: false; limit: CapLimit; used: number; max: number }

const HOUR_MS = 60 * 60 * 1000

export class CapsMeter {
    private rounds: number
    private responseBytes: number
    private queryBytes: number
    private readonly roundTimes: number[] = []

    constructor(
        readonly caps: Caps,
        consumed?: CapsConsumed,
        private readonly now: () => number = Date.now,
    ) {
        this.rounds = consumed?.rounds ?? 0
        this.responseBytes = consumed?.responsePlaintextBytes ?? 0
        this.queryBytes = consumed?.queryPlaintextBytes ?? 0
    }

    /** Would delivering a query of `bytes` plaintext breach a cap? Checked before delivery. */
    checkQuery(bytes: number): CapsVerdict {
        const c = this.caps
        if (c.maxRounds !== undefined && this.rounds + 1 > c.maxRounds) {
            return { ok: false, limit: 'maxRounds', used: this.rounds + 1, max: c.maxRounds }
        }
        if (c.maxRoundsPerHour !== undefined && this.roundsInLastHour() + 1 > c.maxRoundsPerHour) {
            return { ok: false, limit: 'maxRoundsPerHour', used: this.roundsInLastHour() + 1, max: c.maxRoundsPerHour }
        }
        if (c.maxQueryPlaintextBytesPerRound !== undefined && bytes > c.maxQueryPlaintextBytesPerRound) {
            return {
                ok: false,
                limit: 'maxQueryPlaintextBytesPerRound',
                used: bytes,
                max: c.maxQueryPlaintextBytesPerRound,
            }
        }
        if (
            c.maxCumulativeQueryPlaintextBytes !== undefined &&
            this.queryBytes + bytes > c.maxCumulativeQueryPlaintextBytes
        ) {
            return {
                ok: false,
                limit: 'maxCumulativeQueryPlaintextBytes',
                used: this.queryBytes + bytes,
                max: c.maxCumulativeQueryPlaintextBytes,
            }
        }
        return { ok: true }
    }

    recordQuery(bytes: number): void {
        this.rounds++
        this.queryBytes += bytes
        this.roundTimes.push(this.now())
        this.pruneRoundTimes()
    }

    /** Would sending a response of `bytes` plaintext breach a cap? Checked at POST /v1/messages. */
    checkResponse(bytes: number): CapsVerdict {
        const c = this.caps
        if (c.maxResponsePlaintextBytesPerRound !== undefined && bytes > c.maxResponsePlaintextBytesPerRound) {
            return {
                ok: false,
                limit: 'maxResponsePlaintextBytesPerRound',
                used: bytes,
                max: c.maxResponsePlaintextBytesPerRound,
            }
        }
        if (
            c.maxCumulativeResponsePlaintextBytes !== undefined &&
            this.responseBytes + bytes > c.maxCumulativeResponsePlaintextBytes
        ) {
            return {
                ok: false,
                limit: 'maxCumulativeResponsePlaintextBytes',
                used: this.responseBytes + bytes,
                max: c.maxCumulativeResponsePlaintextBytes,
            }
        }
        return { ok: true }
    }

    recordResponse(bytes: number): void {
        this.responseBytes += bytes
    }

    /** Content-free consumption hint for the destination SDK and the status reports. */
    budget(): Budget {
        const c = this.caps
        return {
            roundsUsed: this.rounds,
            ...(c.maxRounds !== undefined ? { roundsMax: c.maxRounds } : {}),
            responseBytesUsed: this.responseBytes,
            ...(c.maxCumulativeResponsePlaintextBytes !== undefined
                ? { responseBytesMax: c.maxCumulativeResponsePlaintextBytes }
                : {}),
            queryBytesUsed: this.queryBytes,
            ...(c.maxCumulativeQueryPlaintextBytes !== undefined
                ? { queryBytesMax: c.maxCumulativeQueryPlaintextBytes }
                : {}),
            ...(c.maxRoundsPerHour !== undefined
                ? { roundsPerHourUsed: this.roundsInLastHour(), roundsPerHourMax: c.maxRoundsPerHour }
                : {}),
        }
    }

    /** The counters a status report carries and a re-provision re-seeds from. */
    consumed(): CapsConsumed {
        return { rounds: this.rounds, responsePlaintextBytes: this.responseBytes, queryPlaintextBytes: this.queryBytes }
    }

    /** True when any cumulative counter is within `fraction` of its limit (tightens report cadence). */
    nearLimit(fraction = 0.1): boolean {
        const near = (used: number, max: number | undefined) => max !== undefined && used >= max * (1 - fraction)
        return (
            near(this.rounds, this.caps.maxRounds) ||
            near(this.responseBytes, this.caps.maxCumulativeResponsePlaintextBytes) ||
            near(this.queryBytes, this.caps.maxCumulativeQueryPlaintextBytes)
        )
    }

    private roundsInLastHour(): number {
        this.pruneRoundTimes()
        return this.roundTimes.length
    }

    private pruneRoundTimes(): void {
        const floor = this.now() - HOUR_MS
        while (this.roundTimes.length && this.roundTimes[0] <= floor) this.roundTimes.shift()
    }
}

/** Plaintext bytes a payload is metered as: its canonical JSON serialization (the SDK envelope). */
export const payloadBytes = (payload: unknown): number => Buffer.byteLength(JSON.stringify(payload), 'utf8')
