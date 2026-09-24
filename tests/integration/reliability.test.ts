import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startPair, runRound, until, poll200, type Pair } from '@/testing/pair-harness'
import { encodeChunkHeader } from '@/lib/noise/chunk-header'
import { pad, capacityOf } from '@/reliability/padding'
import { PAD_BUCKETS } from '@/schemas/channel'
import type { DeliveryEvent } from '@/reliability/delivery'
import type { Frame } from '@/relay-protocol'

const T = 20_000

describe('two tunnels through the fake relay', () => {
    let pair: Pair

    afterEach(async () => {
        await pair?.close()
    })

    it(
        'runs N rounds with payloads from one byte to many chunks; the relay forwards and keeps nothing',
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
            await until(() => (pair.source.tunnel.channel!.delivery.stats().outboxDepth === 0 ? true : undefined))
            await until(() => (pair.destination.tunnel.channel!.delivery.stats().outboxDepth === 0 ? true : undefined))
            expect(pair.destination.tunnel.exchange!.stats().inFlight).toBe(false)
            expect(pair.relay.session(pair.relaySessionId)!.forwarded).toBeGreaterThan(sizes.length * 4)
        },
    )

    it(
        'pads every frame onto a bucket and never puts the correlationId in relay-visible metadata',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            const seen: Frame[] = []
            pair.relay.on('forwarded', (_s, _from, frame) => seen.push(frame))
            const submitted = await pair.dstApi().post('/v1/request', { payload: { blob: 'x'.repeat(5000) } })
            expect(submitted.status).toBe(202)
            const data = await until(() => seen.find((f): f is Extract<Frame, { type: 'DATA' }> => f.type === 'DATA'))
            expect(PAD_BUCKETS).toContain(data.payload.byteLength)
            expect(JSON.stringify(data.header)).not.toContain(submitted.body.correlationId)
            expect(Object.keys(data.header).sort()).toEqual(['chunkCount', 'chunkIndex', 'messageId'])
        },
    )

    it(
        'converges a lost end-to-end ACK: the retransmit re-offers, the source re-ACKs, the RC sees the query once',
        { timeout: T },
        async () => {
            pair = await startPair({ env: { FUSION_RETRANSMIT_MS: '100' } })
            await pair.connect()
            pair.relay.dropNext('source', 'ACK', 1)
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 1 } })).body
            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query')
            const events: DeliveryEvent[] = []
            pair.source.tunnel.channel!.on('delivery', (e) => events.push(e))
            await until(
                () => (events.some((e) => e.type === 'duplicate' && e.reacked) ? true : undefined),
                5000,
                're-ACK',
            )
            await until(() => (pair.destination.tunnel.channel!.delivery.stats().outboxDepth === 0 ? true : undefined))
            expect((await pair.srcApi().get('/v1/messages/next')).body.messageId).toBe(query.messageId) // unanswered: offered again, once
            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 1 } })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            expect(response.payload).toEqual({ a: 1 })
            expect(pair.source.tunnel.exchange!.stats().queuedQueries).toBe(0)
        },
    )

    it(
        'survives a destination socket drop mid-round: the query is re-offered when the peer is back',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            pair.relay.dropSocket(pair.relaySessionId, 'source') // the query has nobody to go to
            await until(() => (pair.relay.isLive(pair.relaySessionId, 'source') ? undefined : true))
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 'drop' } })).body
            await until(() => (pair.relay.isLive(pair.relaySessionId, 'source') ? true : undefined), 5000, 're-attach')
            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query')
            expect(query.correlationId).toBe(correlationId)
            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 'ok' } })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            expect(response.payload).toEqual({ a: 'ok' })
        },
    )

    it(
        're-encrypts the outbox across an epoch change when the source restarts mid-flight; stale frames are NACKed',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            const oldEpoch = pair.destination.tunnel.channel!.epochTag!
            // a frame sealed under the soon-to-be superseded epoch, prepared while those keys still exist
            const oldSession = pair.source.tunnel.channel!.currentSession!
            const staleId = randomUUID()
            const staleAad = encodeChunkHeader({
                messageId: staleId,
                chunkIndex: 0,
                chunkCount: 1,
                senderConnectionId: pair.destination.tunnel.identity.connectionId,
            })
            for (let i = 0; i < 16; i++) oldSession.encrypt(Buffer.alloc(1), staleAad) // counter past the new window
            const stale = oldSession.encrypt(pad(Buffer.from('{}'), PAD_BUCKETS), staleAad)
            pair.source.tunnel.stop()
            await pair.source.close()
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 'buffered' } })).body
            expect(pair.destination.tunnel.channel!.delivery.stats().outboxDepth).toBe(1)

            const events: DeliveryEvent[] = []
            pair.destination.tunnel.channel!.on('delivery', (e) => events.push(e))
            const fresh = await pair.restart('source')
            expect(pair.destination.tunnel.channel!.epochTag).not.toBe(oldEpoch)
            expect(fresh.tunnel.channel!.epochTag).toBe(pair.destination.tunnel.channel!.epochTag)
            expect(pair.destination.tunnel.lifecycle.history.map((t) => t.to)).toEqual(
                expect.arrayContaining(['CHANNEL_UP', 'RELAY_ATTACHED', 'CHANNEL_UP']),
            )

            const query = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'redelivered query')
            expect(query.correlationId).toBe(correlationId)
            expect(query.payload).toEqual({ q: 'buffered' })
            expect(events.find((e) => e.type === 'sent')).toMatchObject({
                epochTag: pair.destination.tunnel.channel!.epochTag,
            })

            // a frame sealed under the superseded epoch is discarded with a NACK
            const nacked = new Promise<string>((resolve) =>
                pair.relay.on(
                    'forwarded',
                    (_s, from, frame) => from === 'source' && frame.type === 'NACK' && resolve(frame.header.messageId),
                ),
            )
            pair.relay.injectFrame(pair.relaySessionId, 'source', {
                type: 'DATA',
                header: { messageId: staleId, chunkIndex: 0, chunkCount: 1 },
                payload: stale,
            })
            expect(await nacked).toBe(staleId)

            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 'after restart' } })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            expect(response.payload).toEqual({ a: 'after restart' })
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
            await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query')
            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 'answer' } })
            // the destination dies before its RC ever polls the response
            await pair.restart('destination')
            // the source's un-ACKed response is re-encrypted from its outbox under the new keys and re-sent
            const stored = await until(
                () => pair.destination.tunnel.exchange!.responseFor(correlationId),
                5000,
                're-sent response',
            )
            expect(stored.payload).toEqual({ a: 'answer' })
            // the SDK re-issues the round under the same correlationId (T1): idempotent, nothing new is sent
            const reissued = await pair.dstApi().post('/v1/request', { payload: { q: 'round' }, correlationId })
            expect(reissued.body).toEqual({ correlationId, reissued: true })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            expect(response.payload).toEqual({ a: 'answer' })
            expect((await pair.srcApi().get('/v1/messages/next')).status).toBe(204)
            await until(() => (pair.source.tunnel.channel!.delivery.stats().outboxDepth === 0 ? true : undefined))
        },
    )

    it(
        'surfaces a full local window as a retryable 429 and retries relay-side BACKPRESSURE from the outbox',
        { timeout: T },
        async () => {
            pair = await startPair({ env: { FUSION_INFLIGHT_MAX_MSGS: '1', FUSION_BACKPRESSURE_RETRY_MS: '50' } })
            await pair.connect()
            pair.relay.dropSocket(pair.relaySessionId, 'source')
            await until(() => (pair.relay.isLive(pair.relaySessionId, 'source') ? undefined : true))
            const first = await pair.dstApi().post('/v1/request', { payload: { q: 1 } })
            expect(first.status).toBe(202)
            // a second message cannot be queued behind the un-ACKed first one
            const refused = await pair
                .dstApi()
                .post('/v1/request', { payload: { q: 2 }, correlationId: randomUUID() })
                .then(
                    (r) => r,
                    () => undefined,
                )
            expect(refused?.status).toBe(409) // single in-flight round wins before the window is even consulted
            expect(() =>
                pair.destination.tunnel.channel!.delivery.send({
                    kind: 'query',
                    messageId: randomUUID(),
                    correlationId: randomUUID(),
                    payload: 2,
                }),
            ).toThrow(/window is full/)
            await until(() => (pair.relay.isLive(pair.relaySessionId, 'source') ? true : undefined), 5000, 're-attach')
            await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query after re-attach')
            await pair.srcApi().post('/v1/messages', { inReplyTo: first.body.correlationId, payload: { a: 1 } })
            await poll200(() => pair.dstApi().get(`/v1/responses/${first.body.correlationId}`), 'first response')

            // relay BACKPRESSURE against a message still in the outbox (its end-to-end ACK is lost):
            // re-offered after the retry delay, not dropped
            const events: DeliveryEvent[] = []
            pair.destination.tunnel.channel!.on('delivery', (e) => events.push(e))
            pair.relay.dropNext('source', 'ACK', 1)
            await pair.dstApi().post('/v1/request', { payload: { q: 2 } })
            await poll200(() => pair.srcApi().get('/v1/messages/next'), 'second query')
            const id = pair.destination.tunnel.channel!.delivery.outbox.inOrder()[0]?.messageId
            expect(id).toBeDefined()
            pair.relay.injectFrame(pair.relaySessionId, 'destination', {
                type: 'ERROR',
                header: { code: 'BACKPRESSURE', retryable: true, messageId: id! },
            })
            await until(() => (events.some((e) => e.type === 'sent' && e.resend) ? true : undefined), 5000, 'resend')
            expect(events.some((e) => e.type === 'backpressure')).toBe(true)
        },
    )

    it(
        'rejects a query injected toward the destination at the transport level (direction is structural)',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            const session = pair.source.tunnel.channel!.currentSession!
            const messageId = randomUUID()
            const plaintext = Buffer.from(
                JSON.stringify({ v: 1, kind: 'query', correlationId: randomUUID(), payload: 1 }),
            )
            const aad = encodeChunkHeader({
                messageId,
                chunkIndex: 0,
                chunkCount: 1,
                senderConnectionId: pair.source.tunnel.identity.connectionId,
            })
            const events: DeliveryEvent[] = []
            pair.destination.tunnel.channel!.on('delivery', (e) => events.push(e))
            expect(
                pair.source.tunnel.channel!.relay.send({
                    type: 'DATA',
                    header: { messageId, chunkIndex: 0, chunkCount: 1 },
                    payload: session.encrypt(pad(plaintext, PAD_BUCKETS), aad),
                }),
            ).toBe(true)
            await until(() => events.find((e) => e.type === 'nack'), 5000, 'nack')
            expect(events.find((e) => e.type === 'nack')).toMatchObject({ messageId, reason: 'direction' })
            expect(pair.destination.tunnel.exchange!.stats()).toMatchObject({
                unconsumed: 0,
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
            expect(dstPoll.body).toMatchObject({
                terminal: true,
                code: 'LIMIT_EXCEEDED',
                detail: { cap: 'maxRounds', limit: 1, observed: 2 },
            })
            expect((await pair.srcApi().get('/v1/messages/next')).body).toMatchObject({
                terminal: true,
                code: 'LIMIT_EXCEEDED',
            })
            expect(pair.source.tunnel.exchange!.stats().queuedQueries).toBe(0)
            expect(pair.source.tunnel.caps!.consumed().rounds).toBe(1)
            expect((await pair.dstApi().post('/v1/request', { payload: 3 })).body.code).toBe('LIMIT_EXCEEDED')
        },
    )

    it(
        'response-side cap breach refuses the response with a typed terminal body and notifies the destination',
        { timeout: T },
        async () => {
            pair = await startPair({ sourceBundle: { caps: { maxResponsePlaintextBytesPerRound: 20 } } })
            await pair.connect()
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 1 } })).body
            await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query')
            const refused = await pair
                .srcApi()
                .post('/v1/messages', { inReplyTo: correlationId, payload: { big: 'x'.repeat(100) } })
            expect(refused.status).toBe(200)
            expect(refused.body).toMatchObject({
                terminal: true,
                code: 'LIMIT_EXCEEDED',
                detail: { cap: 'maxResponsePlaintextBytesPerRound', limit: 20 },
            })
            await until(
                () => (pair.destination.tunnel.lifecycle.state === 'LIMIT_EXCEEDED' ? true : undefined),
                5000,
                'destination terminal',
            )
            const dstPoll = await pair.dstApi().get(`/v1/responses/${correlationId}`)
            expect(dstPoll.body).toMatchObject({
                terminal: true,
                code: 'LIMIT_EXCEEDED',
                detail: { cap: 'maxResponsePlaintextBytesPerRound' },
            })
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
