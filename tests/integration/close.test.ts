import { describe, it, expect, afterEach } from 'vitest'
import { startPair, runRound, until, poll200, type Pair } from '@/testing/pair-harness'
import { installExitPolicy } from '@/lib/exit'

const T = 30_000

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

    it('completes: authenticated CLOSE carrying STUDY_COMPLETE, purge, both exit 0', { timeout: T }, async () => {
        pair = await startPair()
        await pair.connect()
        await runRound(pair, { q: 1 }, () => ({ a: 1 }))
        const bothExited = armExits(pair)
        const closeSeen = new Promise<{ code: string; messageId: string }>((resolve) =>
            pair.source.tunnel.channel!.once('peerClose', resolve),
        )
        const acked = new Promise<void>((resolve) =>
            pair.destination.tunnel.channel!.once('closeAcked', () => resolve()),
        )

        const completed = await pair.dstApi().post('/v1/complete')
        expect(completed.status).toBe(202)
        expect(completed.body).toEqual({ state: 'CLOSING' })
        const close = await closeSeen
        expect(close.code).toBe('STUDY_COMPLETE')
        expect(close.messageId).toMatch(/^[0-9a-f-]{36}$/) // a verified, messageId-bearing CLOSE, not a relay signal
        const srcPoll = await pair.srcApi().get('/v1/messages/next')
        expect(srcPoll.status).toBe(200)
        expect(srcPoll.body).toMatchObject({ terminal: true, code: 'STUDY_COMPLETE' })
        await acked

        expect(await bothExited()).toEqual([0, 0])
        expect(pair.source.tunnel.lifecycle.state).toBe('CLOSED')
        expect(pair.destination.tunnel.lifecycle.state).toBe('CLOSED')
        expect(pair.relay.session(pair.relaySessionId)!.status).toBe('closed')
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

    it('a message the peer never acknowledges ends the leg loudly on both sides: exit 1', { timeout: T }, async () => {
        pair = await startPair({ env: { FUSION_RETRANSMIT_MS: '100', FUSION_MAX_SENDS: '3' } })
        await pair.connect()
        const bothExited = armExits(pair, 1500)
        pair.relay.dropNext('source', 'ACK', 10) // the source's end-to-end ACKs never reach the destination
        const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { poison: true } })).body
        await poll200(() => pair.srcApi().get('/v1/messages/next'), 'first delivery')
        await until(
            () =>
                pair.source.tunnel.lifecycle.state === 'ERRORED' &&
                pair.destination.tunnel.lifecycle.state === 'ERRORED'
                    ? true
                    : undefined,
            8000,
            'both errored',
        )
        expect(pair.destination.tunnel.lifecycle.history.at(-1)?.reason).toMatch(/unacknowledged after 3 sends/)
        expect(pair.source.tunnel.lifecycle.history.at(-1)?.reason).toMatch(/peer CLOSE received/)
        expect((await pair.dstApi().get(`/v1/responses/${correlationId}`)).body).toMatchObject({
            terminal: true,
            code: 'SESSION_ERRORED',
        })
        expect((await pair.srcApi().get('/v1/messages/next')).body).toMatchObject({
            terminal: true,
            code: 'SESSION_ERRORED',
        })
        expect(await bothExited()).toEqual([1, 1])
    })

    it(
        'a relay ending the session without an authenticated CLOSE errors both sides: exit 1, never STUDY_COMPLETE',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            await runRound(pair, { q: 1 }, () => ({ a: 1 }))
            const bothExited = armExits(pair, 1500)
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 2 } })).body
            await poll200(() => pair.srcApi().get('/v1/messages/next'), 'query delivered')
            // The relay purges the session outright: SESSION_CLOSED on both sockets, no CLOSE exchanged.
            expect(pair.relay.forceClose(pair.relaySessionId)).toBe(true)
            await until(
                () =>
                    pair.source.tunnel.lifecycle.state === 'ERRORED' &&
                    pair.destination.tunnel.lifecycle.state === 'ERRORED'
                        ? true
                        : undefined,
                5000,
                'both errored',
            )
            for (const side of [pair.source, pair.destination]) {
                const last = side.tunnel.lifecycle.history.at(-1)!
                expect(last.from).toBe('CHANNEL_UP')
                expect(last.reason).toMatch(/without an authenticated CLOSE/)
                expect(side.tunnel.lifecycle.history.map((t) => t.to)).not.toContain('CLOSING')
            }
            expect((await pair.dstApi().get(`/v1/responses/${correlationId}`)).body).toMatchObject({
                terminal: true,
                code: 'SESSION_ERRORED',
            })
            expect((await pair.srcApi().get('/v1/messages/next')).body).toMatchObject({
                terminal: true,
                code: 'SESSION_ERRORED',
            })
            expect(await bothExited()).toEqual([1, 1])
        },
    )

    it(
        'a cap breach travels as an authenticated LIMIT_EXCEEDED close: both exit 2 and the relay purges',
        { timeout: T },
        async () => {
            pair = await startPair({ sourceBundle: { caps: { maxRounds: 1 } } })
            await pair.connect()
            await runRound(pair, { q: 1 }, () => ({ a: 1 }))
            const bothExited = armExits(pair)
            const closeSeen = new Promise<{ code: string; limit?: { cap: string } }>((resolve) =>
                pair.destination.tunnel.channel!.once('peerClose', resolve),
            )
            const purged = new Promise<void>((resolve) =>
                pair.relay.on('close', (_s, phase) => phase === 'purged' && resolve()),
            )
            await pair.dstApi().post('/v1/request', { payload: { q: 2 } })
            expect(await closeSeen).toMatchObject({
                code: 'LIMIT_EXCEEDED',
                limit: { cap: 'maxRounds', limit: 1, observed: 2 },
            })
            expect(await bothExited()).toEqual([2, 2])
            await purged
            expect(pair.relay.session(pair.relaySessionId)!.status).toBe('closed')
            expect(pair.destination.tunnel.lifecycle.terminalDetail()).toEqual({
                cap: 'maxRounds',
                limit: 1,
                observed: 2,
            })
        },
    )

    it(
        'a source RC that dies after receiving a query sees it again on its next poll, and the round completes',
        { timeout: T },
        async () => {
            pair = await startPair()
            await pair.connect()
            const { correlationId } = (await pair.dstApi().post('/v1/request', { payload: { q: 'crash' } })).body
            const first = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'first delivery')
            // …the RC crashes here. The destination's outbox let go (the query was acknowledged end to end).
            await until(() => (pair.destination.tunnel.channel!.delivery.stats().outboxDepth === 0 ? true : undefined))
            // A restarted RC polls again and is offered the unanswered query without any destination re-issue.
            const second = await poll200(() => pair.srcApi().get('/v1/messages/next'), 'offered again')
            expect(second.messageId).toBe(first.messageId)
            expect(second.payload).toEqual({ q: 'crash' })
            // The destination SDK's round timeout may still re-issue the same correlationId: the tunnel resends
            // it under a fresh messageId and the source retires the earlier copy (v2 §7.3, §8 row 3).
            const reissued = await pair.dstApi().post('/v1/request', { payload: { q: 'crash' }, correlationId })
            expect(reissued.body).toEqual({ correlationId, reissued: true })
            const third = await until(
                async () => {
                    const res = await pair.srcApi().get('/v1/messages/next')
                    return res.status === 200 && res.body.messageId !== first.messageId ? res.body : undefined
                },
                5000,
                'redelivery under a new id',
            )
            expect(third.correlationId).toBe(correlationId)
            await pair.srcApi().post('/v1/messages', { inReplyTo: correlationId, payload: { a: 'recovered' } })
            const response = await poll200(() => pair.dstApi().get(`/v1/responses/${correlationId}`), 'response')
            expect(response.payload).toEqual({ a: 'recovered' })
            expect((await pair.srcApi().get('/v1/messages/next')).status).toBe(204)
            await pair.dstApi().post('/v1/complete')
            await until(
                () => (pair.relay.session(pair.relaySessionId)!.status === 'closed' ? true : undefined),
                10_000,
                'purge',
            )
        },
    )
})
