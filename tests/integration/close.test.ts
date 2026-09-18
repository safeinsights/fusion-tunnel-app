import { describe, it, expect, afterEach } from 'vitest'
import { startPair, runRound, until, type Pair } from '@/testing/pair-harness'
import { installExitPolicy } from '@/lib/exit'
import type { ApiResult } from '@/testing/fixtures'

const T = 30_000

const poll200 = (call: () => Promise<ApiResult>, label: string, timeoutMs = 8000) =>
    until(
        async () => {
            const res = await call()
            return res.status === 200 ? res.body : undefined
        },
        timeoutMs,
        label,
    )

/** Fake process exits for both sides; resolves with [sourceCode, destinationCode]. */
const armExits = (pair: Pair, graceMs = 10) => {
    const codes: Record<'source' | 'destination', number | undefined> = { source: undefined, destination: undefined }
    for (const side of ['source', 'destination'] as const) {
        installExitPolicy(pair[side].tunnel, { exit: (code) => (codes[side] = code), graceMs })
    }
    return () =>
        until(
            () =>
                codes.source !== undefined && codes.destination !== undefined
                    ? [codes.source, codes.destination]
                    : undefined,
            15_000,
            'both exits',
        )
}

describe('close and failure flows', () => {
    let pair: Pair

    afterEach(async () => {
        await pair?.close().catch(() => undefined)
    })

    it('completes: authenticated CLOSE, STUDY_COMPLETE at the source, purge, both exit 0', { timeout: T }, async () => {
        pair = await startPair({
            env: { FUSION_INLINE_CAP_BYTES: '512' },
            relayOptions: { limits: { inlineCapBytes: 512 } },
        })
        await pair.connect()
        await runRound(pair, { q: 'x'.repeat(2000) }, () => ({ a: 1 })) // leaves a blob behind to be purged
        expect(pair.relay.blobs(pair.relaySessionId)).toHaveLength(1)
        const bothExited = armExits(pair)
        const closeSeen = new Promise<string>((resolve) =>
            pair.source.tunnel.channel!.once(
                'control',
                (control, messageId) => control === 'CLOSE' && resolve(messageId),
            ),
        )
        const acked = new Promise<void>((resolve) =>
            pair.destination.tunnel.channel!.once('closeAcked', () => resolve()),
        )

        const completed = await pair.dstApi().post('/v1/complete')
        expect(completed.status).toBe(202)
        expect(completed.body).toEqual({ state: 'CLOSING' })
        expect(await closeSeen).toMatch(/^[0-9a-f-]{36}$/) // a verified, messageId-bearing CLOSE, not a relay signal
        const srcPoll = await pair.srcApi().get('/v1/messages/next')
        expect(srcPoll.status).toBe(200)
        expect(srcPoll.body).toEqual({ terminal: true, code: 'STUDY_COMPLETE' })
        await acked

        expect(await bothExited()).toEqual([0, 0])
        expect(pair.source.tunnel.lifecycle.state).toBe('CLOSED')
        expect(pair.destination.tunnel.lifecycle.state).toBe('CLOSED')
        const session = pair.relay.session(pair.relaySessionId)!
        expect(session.status).toBe('closed')
        expect(pair.relay.messages(pair.relaySessionId, 'dstToSrc')).toHaveLength(0)
        expect(pair.relay.blobs(pair.relaySessionId)).toHaveLength(0)
        expect(pair.destination.tunnel.lifecycle.history.map((t) => t.to).slice(-2)).toEqual(['CLOSING', 'CLOSED'])
    })

    it(
        'a lost CLOSE_ACK is covered by the relay close timeout: both still end CLOSED with exit 0',
        { timeout: T },
        async () => {
            pair = await startPair({ relayOptions: { closeTimeoutMs: 300 } })
            await pair.connect()
            pair.relay.dropNext('source', 'CLOSE_ACK')
            const bothExited = armExits(pair)
            const purged = new Promise<string>((resolve) =>
                pair.relay.on('close', (_s, phase) => phase === 'timeout' && resolve(phase)),
            )
            await pair.dstApi().post('/v1/complete')
            expect(await purged).toBe('timeout')
            expect(await bothExited()).toEqual([0, 0])
            expect(pair.relay.session(pair.relaySessionId)!.status).toBe('closed')
            expect(pair.source.tunnel.lifecycle.history.at(-1)?.reason).toMatch(/relay purged/)
        },
    )

    it(
        "the destination's own close timeout ends the session when neither ack nor purge arrives",
        { timeout: T },
        async () => {
            pair = await startPair({
                env: { FUSION_CLOSE_TIMEOUT_MS: '300' },
                relayOptions: { closeTimeoutMs: 20_000 },
            })
            await pair.connect()
            pair.source.tunnel.stop() // the source is gone; nobody will CLOSE_ACK
            await pair.source.close()
            const exits: number[] = []
            installExitPolicy(pair.destination.tunnel, { exit: (c) => exits.push(c), graceMs: 10 })
            const started = Date.now()
            await pair.dstApi().post('/v1/complete')
            await until(() => (exits.length ? true : undefined), 5000, 'destination exit')
            expect(exits).toEqual([0])
            expect(Date.now() - started).toBeGreaterThanOrEqual(250)
            expect(pair.destination.tunnel.lifecycle.history.at(-1)?.reason).toBe('close timeout')
        },
    )

    it(
        'a dead-lettered message errors the session on both sides: typed terminal errors and exit 1',
        { timeout: T },
        async () => {
            pair = await startPair({ relayOptions: { maxDeliveries: 2 } })
            await pair.connect()
            // a long grace keeps the local APIs up so the terminal bodies can be observed before exit
            const bothExited = armExits(pair, 1500)
            const deadLettered = new Promise<string>((resolve) =>
                pair.relay.once('deadLetter', (_s, id) => resolve(id)),
            )
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { poison: true } })).body
            // the source RC never acks; every re-attach redelivers the query until the relay gives up
            await poll200(() => pair.srcApi().get('/v1/messages/next'), 'first delivery')
            pair.relay.dropSocket(pair.relaySessionId, 'source')
            await until(
                () => (pair.relay.isLive(pair.relaySessionId, 'source') ? true : undefined),
                5000,
                're-attach 1',
            )
            pair.relay.dropSocket(pair.relaySessionId, 'source')
            await deadLettered
            await until(
                () =>
                    pair.source.tunnel.lifecycle.state === 'ERRORED' &&
                    pair.destination.tunnel.lifecycle.state === 'ERRORED'
                        ? true
                        : undefined,
                5000,
                'both errored',
            )
            expect(pair.source.tunnel.lifecycle.history.at(-1)?.reason).toContain('SESSION_ERRORED_DEAD_LETTER')
            const dstPoll = await pair.dstApi().get(`/v1/responses/${correlationId}`)
            expect(dstPoll.body).toEqual({ terminal: true, code: 'SESSION_ERRORED' })
            expect((await pair.srcApi().get('/v1/messages/next')).body).toEqual({
                terminal: true,
                code: 'SESSION_ERRORED',
            })
            expect(await bothExited()).toEqual([1, 1])
        },
    )

    it(
        'a cap breach closes the relay session too: both exit 2, nothing lingers in the relay',
        { timeout: T },
        async () => {
            pair = await startPair({ sourceBundle: { caps: { maxRounds: 1 } } })
            await pair.connect()
            await runRound(pair, { q: 1 }, () => ({ a: 1 }))
            const bothExited = armExits(pair)
            const purged = new Promise<void>((resolve) =>
                pair.relay.on('close', (_s, phase) => phase === 'purged' && resolve()),
            )
            await pair.dstApi().post('/v1/request', { payload: { q: 2 } })
            expect(await bothExited()).toEqual([2, 2])
            await purged
            expect(pair.relay.session(pair.relaySessionId)!.status).toBe('closed')
            expect(pair.relay.messages(pair.relaySessionId, 'dstToSrc')).toHaveLength(0)
        },
    )

    it(
        'a source RC that dies after acking gets the re-issued query again and the round completes',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 'crash' } })).body
            const first = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'first delivery')
            await pair.srcApi().post(`/v1/messages/${first.messageId}/ack`)
            // …the RC crashes here. The relay retains the consumed query and redelivers nothing.
            await until(() =>
                pair.relay.messages(pair.relaySessionId, 'dstToSrc')[0]?.msgState === 'consumed' ? true : undefined,
            )
            await until(() => (pair.destination.tunnel.channel!.delivery.stats().outboxDepth === 0 ? true : undefined))
            expect((await pair.srcApi().get('/v1/messages/next')).status).toBe(204)

            // the destination SDK's round timeout re-issues the same correlationId: the query has left the
            // outbox unanswered, so the tunnel resends it under a fresh messageId (v2 §7.3, §8 row 3)
            const reissued = await pair.dstApi().post('/v1/request', { payload: { q: 'crash' }, correlationId })
            expect(reissued.body).toEqual({ correlationId, reissued: true })
            const second = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'redelivery to the restarted RC')
            expect(second.correlationId).toBe(correlationId)
            expect(second.messageId).not.toBe(first.messageId)
            expect(second.payload).toEqual({ q: 'crash' })
            await pair.srcApi().post(`/v1/messages/${second.messageId}/ack`)
            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 'recovered' } })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            expect(response.payload).toEqual({ a: 'recovered' })
            await pair.dstApi().post(`/v1/messages/${response.messageId}/ack`)
            // the response released the query it cites; the earlier retained copy is purged at close
            await until(() => (pair.relay.messages(pair.relaySessionId, 'dstToSrc').length <= 1 ? true : undefined))
            await pair.dstApi().post('/v1/complete')
            await until(
                () => (pair.relay.session(pair.relaySessionId)!.status === 'closed' ? true : undefined),
                10_000,
                'purge',
            )
            expect(pair.relay.messages(pair.relaySessionId, 'dstToSrc')).toHaveLength(0)
        },
    )
})
