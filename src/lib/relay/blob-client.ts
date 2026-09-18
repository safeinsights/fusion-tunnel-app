import { log, errorFields } from '@/lib/logger'

// HTTPS PUT/GET of ciphertext blobs against the relay blob store (v2 §7.2): same host as the WSS
// endpoint, so the tunnel's egress posture is unchanged; authenticated with the relay token as a
// Bearer token (no PoP on this path — see the relay README on that asymmetry). Retries cover
// transient failures; the caller decides what a final failure means for the session.

export type BlobPutResult =
    { ok: true; sizeBytes: number } | { ok: false; status: number; code?: string; retryable: boolean }
export type BlobGetResult =
    { ok: true; bytes: Buffer } | { ok: false; status: number; notFound: boolean; code?: string; retryable: boolean }

export type BlobClientOptions = {
    /** The relay WSS/WS endpoint; the HTTP base is derived from it. */
    relayEndpoint: string
    tokenProvider: () => Promise<string> | string
    retryMs: number
    maxAttempts: number
    fetch?: typeof fetch
    sleep?: (ms: number) => Promise<void>
}

/** `wss://host/ws` → `https://host`, `ws://host:1234/ws` → `http://host:1234`. */
export const blobBaseUrl = (relayEndpoint: string): string => {
    const url = new URL(relayEndpoint)
    const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
    return `${protocol}//${url.host}`
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

const readCode = async (res: Response): Promise<string | undefined> => {
    try {
        const body = (await res.json()) as { error?: { code?: string } }
        return body?.error?.code
    } catch {
        return undefined
    }
}

export class BlobClient {
    private readonly base: string
    private readonly fetchImpl: typeof fetch
    private readonly sleep: (ms: number) => Promise<void>

    constructor(private readonly options: BlobClientOptions) {
        this.base = blobBaseUrl(options.relayEndpoint)
        this.fetchImpl = options.fetch ?? fetch
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    }

    async put(blobId: string, bytes: Buffer): Promise<BlobPutResult> {
        for (let attempt = 1; ; attempt++) {
            try {
                const res = await this.fetchImpl(`${this.base}/api/blobs/${encodeURIComponent(blobId)}`, {
                    method: 'PUT',
                    headers: {
                        authorization: `Bearer ${await this.options.tokenProvider()}`,
                        'content-type': 'application/octet-stream',
                        'content-length': String(bytes.byteLength),
                    },
                    body: new Uint8Array(bytes),
                })
                if (res.status === 201 || res.status === 200) {
                    await res.arrayBuffer().catch(() => undefined)
                    return { ok: true, sizeBytes: bytes.byteLength }
                }
                const code = await readCode(res)
                // QUOTA_EXCEEDED is not retryable even though it rides a 429.
                const retryable = RETRYABLE_STATUSES.has(res.status) && code !== 'QUOTA_EXCEEDED'
                log.warn('blob.put_rejected', { blobId, status: res.status, code, attempt })
                if (!retryable || attempt >= this.options.maxAttempts)
                    return { ok: false, status: res.status, code, retryable }
            } catch (error) {
                log.warn('blob.put_failed', { blobId, attempt, ...errorFields(error) })
                if (attempt >= this.options.maxAttempts) return { ok: false, status: 0, retryable: true }
            }
            await this.sleep(this.options.retryMs * attempt)
        }
    }

    async get(blobId: string): Promise<BlobGetResult> {
        for (let attempt = 1; ; attempt++) {
            try {
                const res = await this.fetchImpl(`${this.base}/api/blobs/${encodeURIComponent(blobId)}`, {
                    headers: {
                        authorization: `Bearer ${await this.options.tokenProvider()}`,
                        accept: 'application/octet-stream',
                    },
                })
                if (res.status === 200) return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) }
                const code = res.status === 404 ? undefined : await readCode(res)
                const retryable = RETRYABLE_STATUSES.has(res.status)
                log.warn('blob.get_rejected', { blobId, status: res.status, code, attempt })
                if (!retryable || attempt >= this.options.maxAttempts) {
                    return { ok: false, status: res.status, notFound: res.status === 404, code, retryable }
                }
            } catch (error) {
                log.warn('blob.get_failed', { blobId, attempt, ...errorFields(error) })
                if (attempt >= this.options.maxAttempts)
                    return { ok: false, status: 0, notFound: false, retryable: true }
            }
            await this.sleep(this.options.retryMs * attempt)
        }
    }
}
