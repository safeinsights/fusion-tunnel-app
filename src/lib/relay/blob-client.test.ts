import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { BlobClient, blobBaseUrl } from './blob-client'
import { RelayClient } from './client'
import { createIdentity } from '@/lib/identity'
import { FakeRelay } from '@/testing/fake-relay'
import { mintRelayToken, testBmaKey } from '@/testing/relay-tokens'

describe('blobBaseUrl', () => {
    it('derives the HTTP origin from the WSS endpoint', () => {
        expect(blobBaseUrl('wss://relay.example.org/ws')).toBe('https://relay.example.org')
        expect(blobBaseUrl('ws://127.0.0.1:4567/ws')).toBe('http://127.0.0.1:4567')
        expect(blobBaseUrl('https://relay.example.org/ws')).toBe('https://relay.example.org')
    })
})

describe('BlobClient against the fake relay', () => {
    let relay: FakeRelay
    let client: RelayClient
    let blobs: BlobClient
    const identity = createIdentity()
    const relaySessionId = `rs-${uuidv4()}`
    const token = () =>
        mintRelayToken({ relaySessionId, role: 'source', fingerprint: identity.fingerprint, popKey: identity.popKey })

    beforeAll(async () => {
        relay = new FakeRelay({ bmaPublicKeyPem: testBmaKey().publicPem, heartbeatIntervalMs: 0, maxBlobBytes: 10_000 })
        await relay.start()
        // the session must exist (the tunnel attaches before it uploads)
        client = new RelayClient({
            endpoint: relay.wsUrl,
            relaySessionId,
            legId: 'leg-a',
            role: 'source',
            tokenProvider: token,
            signChallenge: (p) => identity.signPop(p),
            tuning: { heartbeatMs: 30_000, heartbeatMisses: 2, reconnectMinMs: 10, reconnectMaxMs: 20 },
        })
        await new Promise<void>((resolve) => {
            client.once('admitted', () => resolve())
            client.start()
        })
        blobs = new BlobClient({ relayEndpoint: relay.wsUrl, tokenProvider: token, retryMs: 5, maxAttempts: 3 })
    })

    afterAll(async () => {
        client.stop()
        await relay.stop()
    })

    it('puts and gets bytes untouched, scoped to the session', async () => {
        const bytes = randomBytes(4000)
        const blobId = uuidv4()
        expect(await blobs.put(blobId, bytes)).toEqual({ ok: true, sizeBytes: 4000 })
        const got = await blobs.get(blobId)
        expect(got.ok && got.bytes.equals(bytes)).toBe(true)
        expect(relay.blobs(relaySessionId)).toEqual([blobId])
        const other = new BlobClient({
            relayEndpoint: relay.wsUrl,
            tokenProvider: () =>
                mintRelayToken({
                    relaySessionId: 'rs-other',
                    role: 'source',
                    fingerprint: 'x',
                    popKey: identity.popKey,
                }),
            retryMs: 5,
            maxAttempts: 2,
        })
        const cross = await other.get(blobId)
        expect(cross.ok).toBe(false)
        if (!cross.ok) expect(cross.notFound).toBe(true)
    })

    it('reports not-found, refuses bad tokens, oversized and empty blobs without retrying', async () => {
        const missing = await blobs.get(uuidv4())
        expect(missing).toMatchObject({ ok: false, status: 404, notFound: true, retryable: false })
        const unauthenticated = new BlobClient({
            relayEndpoint: relay.wsUrl,
            tokenProvider: () => 'garbage',
            retryMs: 5,
            maxAttempts: 3,
        })
        expect(await unauthenticated.put(uuidv4(), Buffer.alloc(10))).toMatchObject({
            ok: false,
            status: 401,
            code: 'AUTH_TOKEN_INVALID',
            retryable: false,
        })
        expect(await blobs.put(uuidv4(), randomBytes(10_001))).toMatchObject({
            ok: false,
            status: 413,
            code: 'BLOB_TOO_LARGE',
        })
        expect(await blobs.put(uuidv4(), Buffer.alloc(0))).toMatchObject({ ok: false, status: 400 })
        expect(await blobs.put('bad id!', Buffer.alloc(1))).toMatchObject({ ok: false, status: 400 })
    })

    it('retries transient failures and gives up after maxAttempts', async () => {
        relay.failNextBlob('put', 2)
        const puts: number[] = []
        relay.on('blobRejected', (status) => puts.push(status))
        expect((await blobs.put(uuidv4(), Buffer.alloc(5))).ok).toBe(true)
        expect(puts.filter((s) => s === 503)).toHaveLength(2)
        relay.failNextBlob('get', 5)
        const gaveUp = await blobs.get(uuidv4())
        expect(gaveUp).toMatchObject({ ok: false, status: 503, retryable: true, notFound: false })
        relay.failNextBlob('get', 0)
        // drain the remaining injected failures so later tests are clean
        for (let i = 0; i < 2; i++) await blobs.get(uuidv4())
    })

    it('treats an unreachable relay as retryable and exhausts attempts', async () => {
        const dead = new BlobClient({
            relayEndpoint: 'ws://127.0.0.1:1/ws',
            tokenProvider: token,
            retryMs: 1,
            maxAttempts: 2,
        })
        expect(await dead.put(uuidv4(), Buffer.alloc(1))).toEqual({ ok: false, status: 0, retryable: true })
        expect(await dead.get(uuidv4())).toEqual({ ok: false, status: 0, notFound: false, retryable: true })
    })
})
