import type { MessageKind } from '@/lib/exchange'

// Bounded in-memory plaintext outbox of sent-but-unacknowledged messages (v2 §4.1, §7.3).
// Retransmission — across an epoch change, a reconnect, a peer re-attach, or a retransmit timer
// tick — re-encrypts from here, never from relay ciphertext. Eviction is the end-to-end ACK.

export type OutboxEntry = {
    messageId: string
    kind: MessageKind
    correlationId: string
    /** Canonical channel-message bytes; what gets padded, chunked and sealed on every (re)send. */
    plaintext: Buffer
    /** Epoch tag the entry was last fully sent under; undefined means it needs (re)sending. */
    sentEpoch?: string
    sends: number
    lastSentAt?: number
    createdAt: number
}

export class Outbox {
    private readonly entries = new Map<string, OutboxEntry>()
    private bytes = 0

    constructor(
        private readonly limits: { maxMsgs: number; maxBytes: number },
        private readonly now: () => number = Date.now,
    ) {}

    /** False when the window is full — the caller surfaces back-pressure instead of queueing. */
    add(entry: Pick<OutboxEntry, 'messageId' | 'kind' | 'correlationId' | 'plaintext'>): boolean {
        if (this.entries.has(entry.messageId)) return true
        if (this.entries.size >= this.limits.maxMsgs) return false
        if (this.bytes + entry.plaintext.byteLength > this.limits.maxBytes) return false
        this.entries.set(entry.messageId, { ...entry, sends: 0, createdAt: this.now() })
        this.bytes += entry.plaintext.byteLength
        return true
    }

    remove(messageId: string): OutboxEntry | undefined {
        const entry = this.entries.get(messageId)
        if (!entry) return undefined
        this.entries.delete(messageId)
        this.bytes -= entry.plaintext.byteLength
        return entry
    }

    has(messageId: string): boolean {
        return this.entries.has(messageId)
    }

    get(messageId: string): OutboxEntry | undefined {
        return this.entries.get(messageId)
    }

    /** Insertion order == send order. */
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
        entry.lastSentAt = this.now()
    }

    /** Forget every send: after a new epoch, a reconnect, or the peer re-attaching. */
    invalidateSent(): void {
        for (const entry of this.entries.values()) entry.sentEpoch = undefined
    }

    resetSent(messageId: string): void {
        const entry = this.entries.get(messageId)
        if (entry) entry.sentEpoch = undefined
    }

    /** Entries sent under `epochTag` whose last send is older than `before`. */
    staleSince(epochTag: string, before: number): OutboxEntry[] {
        return this.inOrder().filter((e) => e.sentEpoch === epochTag && (e.lastSentAt ?? 0) < before)
    }

    get depth(): number {
        return this.entries.size
    }

    get bytesQueued(): number {
        return this.bytes
    }
}
