import type { MessageKind } from '@/lib/exchange'

// Bounded in-memory plaintext outbox of sent-but-unacknowledged messages (v2 §4.1, §7.3). The
// bound mirrors the relay's in-flight window; retransmission across an epoch change re-encrypts
// from here, never from relay ciphertext. Eviction is the end-to-end stage-two ACK.

export type OutboundKind = MessageKind | 'control'

export type OutboxEntry = {
    messageId: string
    kind: OutboundKind
    correlationId?: string
    /** Canonical channel-message bytes; what gets padded, chunked and sealed on every (re)send. */
    plaintext: Buffer
    /** Declared wire size the message reserves in the relay window (sum of its frame sizes). */
    sizeBytes: number
    /** Plaintext messageId of the query a response answers (relay retention rule). */
    respondsTo?: string
    /** Epoch tag the entry was last fully sent under; undefined means it needs (re)sending. */
    sentEpoch?: string
    sends: number
    createdAt: number
}

export class Outbox {
    private readonly entries = new Map<string, OutboxEntry>()
    private bytes = 0

    constructor(
        private limits: { maxMsgs: number; maxBytes: number },
        private readonly now: () => number = Date.now,
    ) {}

    setLimits(limits: { maxMsgs: number; maxBytes: number }): void {
        this.limits = limits
    }

    get limitsInEffect(): { maxMsgs: number; maxBytes: number } {
        return this.limits
    }

    /** False when the window is full — the caller surfaces back-pressure instead of queueing. */
    add(entry: Omit<OutboxEntry, 'sends' | 'createdAt' | 'sentEpoch'>): boolean {
        if (this.entries.has(entry.messageId)) return true
        if (this.entries.size >= this.limits.maxMsgs) return false
        if (this.bytes + entry.sizeBytes > this.limits.maxBytes) return false
        this.entries.set(entry.messageId, { ...entry, sends: 0, createdAt: this.now() })
        this.bytes += entry.sizeBytes
        return true
    }

    remove(messageId: string): OutboxEntry | undefined {
        const entry = this.entries.get(messageId)
        if (!entry) return undefined
        this.entries.delete(messageId)
        this.bytes -= entry.sizeBytes
        return entry
    }

    has(messageId: string): boolean {
        return this.entries.has(messageId)
    }

    get(messageId: string): OutboxEntry | undefined {
        return this.entries.get(messageId)
    }

    /** Insertion order == send order == relay FIFO order. */
    inOrder(): OutboxEntry[] {
        return [...this.entries.values()]
    }

    /** Entries not yet fully sent under `epochTag`. */
    pendingFor(epochTag: string): OutboxEntry[] {
        return this.inOrder().filter((entry) => entry.sentEpoch !== epochTag)
    }

    markSent(messageId: string, epochTag: string): void {
        const entry = this.entries.get(messageId)
        if (!entry) return
        entry.sentEpoch = epochTag
        entry.sends++
    }

    /** Forget every send: after a new epoch (relay purged the old one) or a reconnect. */
    invalidateSent(): void {
        for (const entry of this.entries.values()) entry.sentEpoch = undefined
    }

    resetSent(messageId: string): void {
        const entry = this.entries.get(messageId)
        if (entry) entry.sentEpoch = undefined
    }

    get depth(): number {
        return this.entries.size
    }

    get bytesQueued(): number {
        return this.bytes
    }
}
