// Per-message reassembly buffers for decrypted chunks (v2 §7.2). Dedup by messageId lives in the
// Exchange; this holds only the plaintext of messages still missing chunks, bounded in count and
// bytes so a misbehaving peer cannot grow memory without limit.

type Partial = {
    chunkCount: number
    epochTag: string
    chunks: Map<number, Buffer>
    bytes: number
    firstSeenAt: number
}

export type InboxResult =
    | { status: 'partial'; received: number; of: number }
    | { status: 'complete'; plaintext: Buffer }
    | { status: 'duplicate_chunk' }
    | { status: 'inconsistent' }
    | { status: 'overflow' }

export class Inbox {
    private readonly partials = new Map<string, Partial>()
    private bytes = 0

    constructor(
        private readonly limits: { maxPartialMessages: number; maxPartialBytes: number },
        private readonly now: () => number = Date.now,
    ) {}

    accept(messageId: string, chunkIndex: number, chunkCount: number, epochTag: string, data: Buffer): InboxResult {
        if (chunkIndex >= chunkCount) return { status: 'inconsistent' }
        let partial = this.partials.get(messageId)
        if (!partial) {
            if (this.partials.size >= this.limits.maxPartialMessages) return { status: 'overflow' }
            partial = { chunkCount, epochTag, chunks: new Map(), bytes: 0, firstSeenAt: this.now() }
            this.partials.set(messageId, partial)
        }
        if (partial.chunkCount !== chunkCount || partial.epochTag !== epochTag) {
            this.drop(messageId)
            return { status: 'inconsistent' }
        }
        if (partial.chunks.has(chunkIndex)) return { status: 'duplicate_chunk' }
        if (this.bytes + data.byteLength > this.limits.maxPartialBytes) {
            this.drop(messageId)
            return { status: 'overflow' }
        }
        partial.chunks.set(chunkIndex, data)
        partial.bytes += data.byteLength
        this.bytes += data.byteLength
        if (partial.chunks.size < chunkCount)
            return { status: 'partial', received: partial.chunks.size, of: chunkCount }
        const ordered: Buffer[] = []
        for (let i = 0; i < chunkCount; i++) ordered.push(partial.chunks.get(i)!)
        this.drop(messageId)
        return { status: 'complete', plaintext: Buffer.concat(ordered) }
    }

    drop(messageId: string): void {
        const partial = this.partials.get(messageId)
        if (!partial) return
        this.bytes -= partial.bytes
        this.partials.delete(messageId)
    }

    clear(): void {
        this.partials.clear()
        this.bytes = 0
    }

    get partialCount(): number {
        return this.partials.size
    }

    get partialBytes(): number {
        return this.bytes
    }
}
