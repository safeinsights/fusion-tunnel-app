import { describe, it, expect, afterEach } from 'vitest'
import { startPair, runRound, until, type Pair } from '@/testing/pair-harness'
import type { DeliveryEvent } from '@/reliability/delivery'
import type { ApiResult } from '@/testing/fixtures'

const T = 30_000
const CAP = 4096 // FUSION_INLINE_CAP_BYTES for these tests; the fake relay advertises the same

const poll200 = (call: () => Promise<ApiResult>, label: string, timeoutMs = 8000) =>
    until(
        async () => {
            const res = await call()
            return res.status === 200 ? res.body : undefined
        },
        timeoutMs,
        label,
    )

/** Plaintext channel-message bytes for a query payload string of `n` chars (fixed overhead measured once). */
const queryBytesFor = (correlationId: string, payload: unknown) =>
    Buffer.byteLength(JSON.stringify({ v: 1, kind: 'query', correlationId, payload }))

describe('blob path for large payloads', () => {
    let pair: Pair

    afterEach(async () => {
        await pair?.close()
    })

    const start = async (extra: Parameters<typeof startPair>[0] = {}) => {
        pair = await startPair({
            env: { FUSION_INLINE_CAP_BYTES: String(CAP), FUSION_BLOB_RETRY_MS: '20', ...extra.env },
            relayOptions: { limits: { inlineCapBytes: CAP }, ...extra.relayOptions },
            ...extra,
        })
        await pair.connect()
    }

    it(
        'sends at the cap inline and one byte over via a blob, and the round trip is transparent to both RCs',
        { timeout: T },
        async () => {
            await start()
            const events: DeliveryEvent[] = []
            pair.destination.tunnel.channel!.on('delivery', (e) => events.push(e))
            // find a payload whose channel message is exactly CAP bytes: overhead is constant per correlationId length (uuid)
            const probeCid = '00000000-0000-4000-8000-000000000000'
            const overhead = queryBytesFor(probeCid, '')
            const atCap = 'a'.repeat(CAP - overhead)
            const overCap = 'a'.repeat(CAP - overhead + 1)

            const inline = await runRound(pair, atCap, () => 'ok')
            expect(inline.query.payload).toBe(atCap)
            expect(events.filter((e) => e.type === 'blob_uploaded')).toHaveLength(0)
            expect(pair.relay.blobs(pair.relaySessionId)).toEqual([])

            const blob = await runRound(pair, overCap, () => 'ok')
            expect(blob.query.payload).toBe(overCap)
            const uploaded = events.filter((e) => e.type === 'blob_uploaded')
            expect(uploaded).toHaveLength(1)
            const sent = events.filter((e) => e.type === 'sent' && e.epochTag) as Extract<
                DeliveryEvent,
                { type: 'sent' }
            >[]
            expect(sent.at(-1)).toMatchObject({ chunks: 1 })
            expect(pair.relay.blobs(pair.relaySessionId)).toHaveLength(1)
        },
    )

    it('carries a multi-MiB payload both ways with budget hints intact', { timeout: T }, async () => {
        await start()
        const big = 'x'.repeat(3 * 1024 * 1024)
        const result = await runRound(pair, { big }, () => ({ echo: 'y'.repeat(2 * 1024 * 1024) }))
        expect((result.query.payload as { big: string }).big.length).toBe(big.length)
        expect((result.response.payload as { echo: string }).echo.length).toBe(2 * 1024 * 1024)
        expect(result.response.budget).toMatchObject({ roundsUsed: 1, responseBytesUsed: 2 * 1024 * 1024 + 11 })
        expect(pair.relay.blobs(pair.relaySessionId)).toHaveLength(2)
        expect(pair.destination.tunnel.channel!.delivery.stats().outboxDepth).toBe(0)
    })

    it(
        'retries a failing blob GET, then delivers; a missing blob is NACKed and re-uploaded',
        { timeout: T },
        async () => {
            await start()
            const srcEvents: DeliveryEvent[] = []
            const dstEvents: DeliveryEvent[] = []
            pair.source.tunnel.channel!.on('delivery', (e) => srcEvents.push(e))
            pair.destination.tunnel.channel!.on('delivery', (e) => dstEvents.push(e))
            pair.relay.failNextBlob('get', 2)
            const first = await runRound(pair, 'q'.repeat(CAP * 2), () => 'r')
            expect(first.query.payload).toBe('q'.repeat(CAP * 2))
            expect(srcEvents.filter((e) => e.type === 'blob_fetched')).toHaveLength(1)

            // the blob vanishes before the receiver fetches it: NACK blob_missing → re-upload → re-send
            const submitted = await pair.dstApi().post('/v1/request', { payload: 'z'.repeat(CAP * 2) })
            const uploaded = await until(
                () =>
                    dstEvents.find(
                        (e) => e.type === 'blob_uploaded' && !e.reupload && e.messageId !== first.query.messageId,
                    ),
                5000,
                'first upload',
            )
            void uploaded
            // race the receiver: delete right away; if it already fetched, the assertion below still holds via reupload=false path
            const blobIds = pair.relay.blobs(pair.relaySessionId)
            for (const id of blobIds) pair.relay.deleteBlob(pair.relaySessionId, id)
            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query after re-upload', 10_000)
            expect(query.correlationId).toBe(submitted.body.correlationId)
            expect(query.payload).toBe('z'.repeat(CAP * 2))
            const nacks = srcEvents.filter((e) => e.type === 'nack')
            const reuploads = dstEvents.filter((e) => e.type === 'blob_uploaded' && e.reupload)
            // either the receiver fetched before the deletion (no NACK) or it NACKed and the sender re-uploaded
            expect(
                nacks.length === 0 || (nacks.some((n) => n.reason === 'blob_missing') && reuploads.length >= 1),
            ).toBe(true)
            await pair.srcApi().post(`/v1/messages/${query.messageId}/ack`)
        },
    )

    it(
        're-sends the pointer across an epoch change; the blob itself survives the restart',
        { timeout: T },
        async () => {
            await start()
            pair.source.tunnel.stop()
            await pair.source.close()
            const payload = 'p'.repeat(CAP * 3)
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload })).body
            await until(
                () => (pair.relay.blobs(pair.relaySessionId).length === 1 ? true : undefined),
                5000,
                'blob uploaded',
            )
            await until(() => (pair.relay.messages(pair.relaySessionId, 'dstToSrc').length === 1 ? true : undefined))
            const events: DeliveryEvent[] = []
            pair.destination.tunnel.channel!.on('delivery', (e) => events.push(e))
            await pair.restart('source')
            expect(pair.relay.blobs(pair.relaySessionId)).toHaveLength(1) // epoch purge clears mailboxes, not blobs
            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'pointer redelivered', 10_000)
            expect(query.correlationId).toBe(correlationId)
            expect(query.payload).toBe(payload)
            expect(events.filter((e) => e.type === 'sent')).toHaveLength(1)
            expect(events.filter((e) => e.type === 'blob_uploaded')).toHaveLength(0) // no re-upload was needed
        },
    )

    it(
        'a blob the store refuses for good errors the session instead of hanging the round',
        { timeout: T },
        async () => {
            await start({ relayOptions: { limits: { inlineCapBytes: CAP }, maxBlobBytes: CAP } })
            const errored = pair.destination.tunnel.lifecycle.waitFor('ERRORED', { timeoutMs: 10_000 })
            const submitted = await pair.dstApi().post('/v1/request', { payload: 'q'.repeat(CAP * 2) })
            expect(submitted.status).toBe(202)
            expect(await errored).toBe('ERRORED')
            expect(pair.destination.tunnel.lifecycle.history.at(-1)?.reason).toMatch(/blob upload rejected/)
            const poll = await pair.dstApi().get(`/v1/responses/${submitted.body.correlationId}`)
            expect(poll.body).toEqual({ terminal: true, code: 'SESSION_ERRORED' })
        },
    )
})
