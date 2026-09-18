import { describe, it, expect, afterEach } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { startPair, runRound, until, type Pair } from '@/testing/pair-harness'
import { encodeChunkHeader } from '@/lib/noise/chunk-header'
import { pad, capacityOf } from '@/reliability/padding'
import { declaredSizeFor } from '@/reliability/chunker'
import { TUNING_DEFAULTS } from '@/config'
import type { DeliveryEvent } from '@/reliability/delivery'
import type { ApiResult } from '@/testing/fixtures'

const T = 20_000

const poll200 = (call: () => Promise<ApiResult>, label: string, timeoutMs = 5000) =>
    until(
        async () => {
            const res = await call()
            return res.status === 200 ? res.body : undefined
        },
        timeoutMs,
        label,
    )

describe('two tunnels through the fake relay', () => {
    let pair: Pair

    afterEach(async () => {
        await pair?.close()
    })

    it(
        'runs N rounds with payloads from one byte to many chunks and leaves nothing in the relay',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            expect(pair.source.tunnel.channel!.epochTag).toBe(pair.destination.tunnel.channel!.epochTag)
            expect((await pair.dstApi().get('/v1/info')).body.state).toBe('CHANNEL_UP')

            const sizes = [1, 100, capacityOf(1024) - 60, capacityOf(1024), 40_000, 120_000]
            for (const [i, size] of sizes.entries()) {
                const payload = { round: i, blob: 'q'.repeat(size) }
                const result = await runRound(pair, payload, (q) => ({
                    echoed: (q as { round: number }).round,
                    blob: 'r'.repeat(size),
                }))
                expect(result.query.payload).toEqual(payload)
                expect(result.response.payload).toEqual({ echoed: i, blob: 'r'.repeat(size) })
                expect(result.response.budget).toMatchObject({ roundsUsed: i + 1 })
            }
            await until(() =>
                pair.relay.messages(pair.relaySessionId, 'dstToSrc').length +
                    pair.relay.messages(pair.relaySessionId, 'srcToDst').length ===
                0
                    ? true
                    : undefined,
            )
            await until(() => (pair.source.tunnel.channel!.delivery.stats().outboxDepth === 0 ? true : undefined))
            expect(pair.destination.tunnel.channel!.delivery.stats().outboxDepth).toBe(0)
            expect(pair.destination.tunnel.exchange!.stats().inFlight).toBe(false)
        },
    )

    it('declares wire sizes that match the bucket table and pads frames onto buckets', { timeout: T }, async () => {
        pair = await startPair()
        await pair.connect()
        const payload = { blob: 'x'.repeat(5000) }
        const submitted = await pair.dstApi().post('/v1/request', { payload })
        expect(submitted.status).toBe(202)
        const lead = await until(() => pair.relay.messages(pair.relaySessionId, 'dstToSrc')[0])
        const plaintextLength = Buffer.byteLength(
            JSON.stringify({ v: 1, kind: 'query', correlationId: submitted.body.correlationId, payload }),
        )
        expect(lead.sizeBytes).toBe(declaredSizeFor(plaintextLength, TUNING_DEFAULTS.padBuckets))
        expect(TUNING_DEFAULTS.padBuckets).toContain(lead.payload.byteLength)
    })

    it(
        'converges a lost stage-two ACK: the relay redelivers, the source re-ACKs, the RC sees the query once',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            pair.relay.dropNextAcks('source', 1)
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 1 } })).body
            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query')
            expect((await pair.srcApi().post(`/v1/messages/${query.messageId}/ack`)).status).toBe(200)
            expect(pair.relay.messages(pair.relaySessionId, 'dstToSrc')[0]?.msgState).toBe('delivered')

            const events: DeliveryEvent[] = []
            pair.source.tunnel.channel!.on('delivery', (e) => events.push(e))
            pair.relay.dropSocket(pair.relaySessionId, 'source')
            await until(
                () => (events.some((e) => e.type === 'duplicate' && e.reacked) ? true : undefined),
                5000,
                're-ACK',
            )
            await until(() =>
                pair.relay.messages(pair.relaySessionId, 'dstToSrc')[0]?.msgState === 'consumed' ? true : undefined,
            )
            expect((await pair.srcApi().get('/v1/messages/next')).status).toBe(204)
            expect(pair.relay.session(pair.relaySessionId)!.epoch).toBe(0)

            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 1 } })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            await pair.dstApi().post(`/v1/messages/${response.messageId}/ack`)
            await until(() => (pair.relay.messages(pair.relaySessionId, 'dstToSrc').length === 0 ? true : undefined))
        },
    )

    it('survives a destination socket drop mid-round without duplicating anything', { timeout: T }, async () => {
        pair = await startPair()
        await pair.connect()
        const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 'drop' } })).body
        await until(() => (pair.relay.messages(pair.relaySessionId, 'dstToSrc').length ? true : undefined))
        pair.relay.dropSocket(pair.relaySessionId, 'destination')
        await until(() => (pair.relay.isLive(pair.relaySessionId, 'destination') ? true : undefined), 5000, 're-attach')
        const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query')
        await pair.srcApi().post(`/v1/messages/${query.messageId}/ack`)
        await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 'ok' } })
        const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
        expect(response.payload).toEqual({ a: 'ok' })
        expect(pair.relay.messages(pair.relaySessionId, 'dstToSrc')).toHaveLength(1)
        await pair.dstApi().post(`/v1/messages/${response.messageId}/ack`)
    })

    it(
        're-encrypts the outbox across an epoch change when the source restarts mid-flight; stale frames are NACKed',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            const oldEpoch = pair.destination.tunnel.channel!.epochTag!
            pair.source.tunnel.stop()
            await pair.source.close()
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 'buffered' } })).body
            await until(() => (pair.relay.messages(pair.relaySessionId, 'dstToSrc').length === 1 ? true : undefined))
            expect(pair.destination.tunnel.channel!.delivery.stats().outboxDepth).toBe(1)

            const events: DeliveryEvent[] = []
            pair.destination.tunnel.channel!.on('delivery', (e) => events.push(e))
            const fresh = await pair.restart('source')
            expect(pair.relay.session(pair.relaySessionId)!.epoch).toBe(1)
            expect(pair.destination.tunnel.channel!.epochTag).not.toBe(oldEpoch)
            expect(fresh.tunnel.channel!.epochTag).toBe(pair.destination.tunnel.channel!.epochTag)
            expect(pair.destination.tunnel.lifecycle.history.map((t) => t.to)).toEqual(
                expect.arrayContaining(['CHANNEL_UP', 'RELAY_ATTACHED', 'CHANNEL_UP']),
            )

            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'redelivered query')
            expect(query.correlationId).toBe(correlationId)
            expect(query.payload).toEqual({ q: 'buffered' })
            expect(events.filter((e) => e.type === 'sent')).toHaveLength(1)
            expect(events.find((e) => e.type === 'sent')).toMatchObject({
                resend: true,
                epochTag: pair.destination.tunnel.channel!.epochTag,
            })

            // a frame from the superseded epoch is discarded, not redelivered forever
            const nacked = new Promise<string>((resolve) =>
                pair.relay.once('nack', (_s, messageId) => resolve(messageId)),
            )
            const staleId = uuidv4()
            pair.relay.injectFrame(pair.relaySessionId, 'source', {
                type: 'DATA',
                header: { messageId: staleId, chunkIndex: 0, chunkCount: 1, epochTag: oldEpoch, sizeBytes: 1024 },
                payload: Buffer.alloc(1024),
            })
            expect(await nacked).toBe(staleId)

            await pair.srcApi().post(`/v1/messages/${query.messageId}/ack`)
            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 'after restart' } })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            expect(response.payload).toEqual({ a: 'after restart' })
            await pair.dstApi().post(`/v1/messages/${response.messageId}/ack`)
            expect((await pair.srcApi().get('/v1/messages/next')).status).toBe(204)
        },
    )

    it(
        'recovers a destination restart through same-correlationId re-issue and cached-response replay',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 'round' } })).body
            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query')
            await pair.srcApi().post(`/v1/messages/${query.messageId}/ack`)
            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 'answer' } })
            await until(() => (pair.relay.messages(pair.relaySessionId, 'srcToDst').length === 1 ? true : undefined))

            // the destination dies before its RC ever polls the response
            await pair.restart('destination')
            expect(pair.relay.session(pair.relaySessionId)!.epoch).toBe(1)

            // the source's un-ACKed response was purged with the old epoch; the source re-encrypts it
            // from its outbox under the new keys and re-sends (v2 §7.3), so the new destination holds it
            const stored = await until(
                () => pair.destination.tunnel.exchange!.responseFor(correlationId),
                5000,
                're-sent response',
            )
            expect(stored.payload).toEqual({ a: 'answer' })
            expect(pair.relay.messages(pair.relaySessionId, 'srcToDst')).toHaveLength(1)

            // the SDK re-issues the round under the same correlationId (T1): idempotent, nothing new is sent
            const reissued = await pair.dstApi().post('/v1/request', { payload: { q: 'round' }, correlationId })
            expect(reissued.status).toBe(202)
            expect(reissued.body).toEqual({ correlationId, reissued: true })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            expect(response.payload).toEqual({ a: 'answer' })
            expect((await pair.srcApi().get('/v1/messages/next')).status).toBe(204)
            await pair.dstApi().post(`/v1/messages/${response.messageId}/ack`)
            await until(() =>
                pair.relay.messages(pair.relaySessionId, 'dstToSrc').length +
                    pair.relay.messages(pair.relaySessionId, 'srcToDst').length ===
                0
                    ? true
                    : undefined,
            )
        },
    )

    it(
        'surfaces a full window as a retryable 429 and retries relay-side BACKPRESSURE from the outbox',
        { timeout: T },
        async () => {
            pair = await startPair({ relayOptions: { limits: { windowBytes: 64 } } })
            await pair.connect()
            const refused = await pair.dstApi().post('/v1/request', { payload: { q: 1 } })
            expect(refused.status).toBe(429)
            expect(refused.body.error.code).toBe('BACKPRESSURE')
            expect(refused.headers.get('retry-after')).toBe('1')
            expect(pair.destination.tunnel.exchange!.stats().inFlight).toBe(false)
            await pair.close()

            pair = await startPair({ env: { FUSION_BACKPRESSURE_RETRY_MS: '50' } })
            await pair.connect()
            const backpressured = new Promise<string>((resolve) =>
                pair.relay.once('backpressure', (_s, _d, messageId) => resolve(messageId)),
            )
            pair.relay.limits.windowBytes = 64 // the relay tightens after admission
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 1 } })).body
            await backpressured
            expect((await pair.dstApi().get(`/v1/responses/${correlationId}`)).status).toBe(204)
            expect(pair.destination.tunnel.channel!.delivery.stats().outboxDepth).toBe(1)
            pair.relay.limits.windowBytes = 32 * 1024 * 1024
            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query after backpressure')
            expect(query.correlationId).toBe(correlationId)
        },
    )

    it(
        'rejects a query injected toward the destination at the transport level (direction is structural)',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            const session = pair.source.tunnel.channel!.currentSession!
            const messageId = uuidv4()
            const plaintext = Buffer.from(JSON.stringify({ v: 1, kind: 'query', correlationId: uuidv4(), payload: 1 }))
            const aad = encodeChunkHeader({
                messageId,
                chunkIndex: 0,
                chunkCount: 1,
                senderConnectionId: pair.source.tunnel.identity.connectionId,
            })
            const events: DeliveryEvent[] = []
            pair.destination.tunnel.channel!.on('delivery', (e) => events.push(e))
            const nacked = new Promise<string>((resolve) => pair.relay.once('nack', (_s, id) => resolve(id)))
            expect(
                pair.source.tunnel.channel!.relay.send({
                    type: 'DATA',
                    header: { messageId, chunkIndex: 0, chunkCount: 1, epochTag: session.epochTag!, sizeBytes: 1024 },
                    payload: session.encrypt(pad(plaintext, TUNING_DEFAULTS.padBuckets), aad),
                }),
            ).toBe(true)
            expect(await nacked).toBe(messageId)
            expect(events.find((e) => e.type === 'nack')).toMatchObject({ messageId, reason: 'direction' })
            expect(pair.destination.tunnel.exchange!.stats()).toEqual({
                pendingAcks: 0,
                queuedQueries: 0,
                inFlight: false,
            })
        },
    )

    it(
        'query-side cap breach terminates the leg loudly on both sides with no partial delivery',
        { timeout: T },
        async () => {
            pair = await startPair({ sourceBundle: { caps: { maxRounds: 1 } } })
            await pair.connect()
            const first = await runRound(pair, { q: 1 }, () => ({ a: 1 }))
            expect(first.response.budget).toMatchObject({ roundsUsed: 1, roundsMax: 1 })

            const limit = new Promise<string>((resolve) =>
                pair.source.tunnel.channel!.once('limitExceeded', (e) => resolve(e.limit)),
            )
            const second = await pair.dstApi().post('/v1/request', { payload: { q: 2 } })
            expect(second.status).toBe(202)
            expect(await limit).toBe('maxRounds')
            expect(pair.source.tunnel.lifecycle.state).toBe('LIMIT_EXCEEDED')
            await until(
                () => (pair.destination.tunnel.lifecycle.state === 'LIMIT_EXCEEDED' ? true : undefined),
                5000,
                'destination terminal',
            )

            const dstPoll = await pair.dstApi().get(`/v1/responses/${second.body.correlationId}`)
            expect(dstPoll.status).toBe(200)
            expect(dstPoll.body).toEqual({ terminal: true, code: 'LIMIT_EXCEEDED' })
            const srcPoll = await pair.srcApi().get('/v1/messages/next')
            expect(srcPoll.body).toEqual({ terminal: true, code: 'LIMIT_EXCEEDED' })
            expect(pair.source.tunnel.exchange!.stats().queuedQueries).toBe(0)
            expect(pair.source.tunnel.caps!.consumed().rounds).toBe(1)
            expect((await pair.dstApi().post('/v1/request', { payload: 3 })).status).toBe(410)
        },
    )

    it(
        'response-side cap breach refuses the response with a typed terminal error and notifies the destination',
        { timeout: T },
        async () => {
            pair = await startPair({ sourceBundle: { caps: { maxResponsePlaintextBytesPerRound: 20 } } })
            await pair.connect()
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 1 } })).body
            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query')
            await pair.srcApi().post(`/v1/messages/${query.messageId}/ack`)
            const refused = await pair
                .srcApi()
                .post('/v1/messages', { inReplyTo: correlationId, payload: { big: 'x'.repeat(100) } })
            expect(refused.status).toBe(410)
            expect(refused.body).toMatchObject({ terminal: true, code: 'LIMIT_EXCEEDED' })
            expect(refused.body.message).toContain('maxResponsePlaintextBytesPerRound')
            await until(
                () => (pair.destination.tunnel.lifecycle.state === 'LIMIT_EXCEEDED' ? true : undefined),
                5000,
                'destination terminal',
            )
            const dstPoll = await pair.dstApi().get(`/v1/responses/${correlationId}`)
            expect(dstPoll.body).toEqual({ terminal: true, code: 'LIMIT_EXCEEDED' })
            expect(pair.destination.tunnel.exchange!.responseFor(correlationId)).toBeUndefined()
        },
    )

    it(
        're-seeds cumulative counters from capsConsumed so a restart cannot reset the budget',
        { timeout: T },
        async () => {
            pair = await startPair({
                sourceBundle: {
                    caps: { maxRounds: 3 },
                    capsConsumed: { rounds: 2, responsePlaintextBytes: 10, queryPlaintextBytes: 10 },
                },
            })
            await pair.connect()
            const first = await runRound(pair, { q: 1 }, () => ({ a: 1 }))
            expect(first.response.budget).toMatchObject({ roundsUsed: 3, roundsMax: 3, responseBytesUsed: 10 + 7 })
            const limit = new Promise<string>((resolve) =>
                pair.source.tunnel.channel!.once('limitExceeded', (e) => resolve(e.limit)),
            )
            await pair.dstApi().post('/v1/request', { payload: { q: 2 } })
            expect(await limit).toBe('maxRounds')
            expect(pair.source.tunnel.caps!.consumed()).toEqual({
                rounds: 3,
                responsePlaintextBytes: 17,
                queryPlaintextBytes: 17,
            })
        },
    )
})
