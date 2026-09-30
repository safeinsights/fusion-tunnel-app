// In-process duplex pipe for Noise and reliability tests: two endpoints, each delivering what the
// other sends on the next macrotask, with hooks to drop, duplicate, delay or tamper with frames.

export type Interceptor = (frame: Buffer, index: number) => Buffer[] | Promise<Buffer[]>

export class MemoryEndpoint {
    private peer: MemoryEndpoint | null = null
    private listeners: ((frame: Buffer) => void)[] = []
    private interceptors: Interceptor[] = []
    private sentCount = 0
    readonly sent: Buffer[] = []
    readonly received: Buffer[] = []

    connect(peer: MemoryEndpoint): void {
        this.peer = peer
    }

    onMessage(listener: (frame: Buffer) => void): () => void {
        this.listeners.push(listener)
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener)
        }
    }

    /** Interceptors run on the sender in order; each may return zero, one or many frames. */
    intercept(interceptor: Interceptor): () => void {
        this.interceptors.push(interceptor)
        return () => {
            this.interceptors = this.interceptors.filter((i) => i !== interceptor)
        }
    }

    async send(frame: Buffer): Promise<void> {
        const peer = this.peer
        if (!peer) throw new Error('endpoint is not connected')
        const index = this.sentCount++
        this.sent.push(frame)
        let frames: Buffer[] = [Buffer.from(frame)]
        for (const interceptor of this.interceptors) {
            const next: Buffer[] = []
            for (const f of frames) next.push(...(await interceptor(f, index)))
            frames = next
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
        for (const f of frames) peer.deliver(f)
    }

    private deliver(frame: Buffer): void {
        this.received.push(frame)
        for (const listener of this.listeners) listener(frame)
    }
}

export const createMemoryTransportPair = (): [MemoryEndpoint, MemoryEndpoint] => {
    const a = new MemoryEndpoint()
    const b = new MemoryEndpoint()
    a.connect(b)
    b.connect(a)
    return [a, b]
}

/** Resolve with the next frame the endpoint receives. */
export const nextFrame = (endpoint: MemoryEndpoint, timeoutMs = 1000): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            off()
            reject(new Error('no frame received in time'))
        }, timeoutMs)
        const off = endpoint.onMessage((frame) => {
            clearTimeout(timer)
            off()
            resolve(frame)
        })
    })

export const dropEvery = (n: number): Interceptor => {
    return (frame, index) => ((index + 1) % n === 0 ? [] : [frame])
}

export const duplicateAll: Interceptor = (frame) => [frame, frame]

export const flipLastByte: Interceptor = (frame) => {
    const copy = Buffer.from(frame)
    copy[copy.byteLength - 1] ^= 0x01
    return [copy]
}
