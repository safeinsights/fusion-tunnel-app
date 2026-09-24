import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
    api,
    driveToChannelUp,
    LOCAL_API_TOKEN,
    makeBundle,
    PROVISION_TOKEN,
    RecordingTransport,
    startTunnel,
    tick,
    type RunningTunnel,
} from '@/testing/fixtures'
import { IdentityResponseSchema } from '@/schemas/provisioning'
import { API_VERSION, InfoResponseSchema } from './local-api'

describe('provisioning API', () => {
    let running: RunningTunnel

    beforeAll(async () => {
        running = await startTunnel()
    })
    afterAll(() => running.close())

    it('GET /local/identity and POST /local/configure require the provisioning bearer', async () => {
        for (const token of [undefined, 'wrong-provision-token-0123456789', LOCAL_API_TOKEN]) {
            const client = api(running.baseUrl, token)
            const identity = await client.get('/local/identity')
            expect(identity.status, `identity with ${token}`).toBe(401)
            expect(identity.body).toEqual({ code: 'UNAUTHORIZED', message: expect.any(String) })
            expect(JSON.stringify(identity.body)).not.toContain(running.tunnel.identity.connectionId)
            expect((await client.post('/local/configure', makeBundle())).status, `configure with ${token}`).toBe(401)
        }
        expect(running.tunnel.lifecycle.state).toBe('AWAITING_CONFIG')
        expect(running.tunnel.bundle).toBeUndefined()
    })

    it('a tunnel started without a provisioning token answers 401 to every /local call', async () => {
        const bare = await startTunnel({ env: { FUSION_PROVISION_TOKEN: '' } })
        try {
            expect(bare.tunnel.config.provisionToken).toBeUndefined()
            expect((await api(bare.baseUrl, PROVISION_TOKEN).get('/local/identity')).status).toBe(401)
            expect((await api(bare.baseUrl, PROVISION_TOKEN).post('/local/configure', makeBundle())).status).toBe(401)
        } finally {
            await bare.close()
        }
    })

    it('GET /local/identity returns the fresh public keys; /health needs no token', async () => {
        const res = await api(running.baseUrl, PROVISION_TOKEN).get('/local/identity')
        expect(res.status).toBe(200)
        expect(IdentityResponseSchema.safeParse(res.body).success).toBe(true)
        expect(res.body.connectionId).toBe(running.tunnel.identity.connectionId)
        expect((await api(running.baseUrl).get('/health')).body).toMatchObject({
            success: true,
            message: { state: 'AWAITING_CONFIG' },
        })
    })

    it('POST /local/configure rejects malformed JSON, schema failures and an unparseable org key', async () => {
        const client = api(running.baseUrl, PROVISION_TOKEN)
        expect((await client.postRaw('/local/configure', '{oops')).status).toBe(400)
        const invalid = await client.post('/local/configure', { ...makeBundle(), role: 'observer', localApiToken: 'x' })
        expect(invalid.status).toBe(400)
        expect(invalid.body.code).toBe('VALIDATION')
        const paths = invalid.body.issues.map((i: { path: string }) => i.path)
        expect(paths).toContain('role')
        expect(paths).toContain('localApiToken')
        expect(JSON.stringify(invalid.body)).not.toContain('observer')
        const badPem = await client.post('/local/configure', {
            ...makeBundle(),
            peerOrgPublicKey: '-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n',
        })
        expect(badPem.status).toBe(400)
        expect(badPem.body.issues[0].path).toBe('peerOrgPublicKey')
        expect(running.tunnel.lifecycle.state).toBe('AWAITING_CONFIG')
    })

    it('POST /local/configure accepts a bundle once, idempotently, conflicts on a different one, and reports terminal', async () => {
        const client = api(running.baseUrl, PROVISION_TOKEN)
        const bundle = makeBundle()
        expect(await client.post('/local/configure', bundle)).toMatchObject({
            status: 200,
            body: { state: 'CONFIGURED', configured: true },
        })
        expect((await client.post('/local/configure', bundle)).body).toEqual({ state: 'CONFIGURED', configured: false })
        const different = await client.post('/local/configure', makeBundle({ legId: 'leg-b' }))
        expect(different.status).toBe(409)
        expect(different.body.code).toBe('CONFLICT')
        running.tunnel.lifecycle.fail('ERRORED', 'test')
        const res = await client.post('/local/configure', makeBundle())
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ terminal: true, code: 'SESSION_ERRORED', message: 'test' })
    })
})

describe('local API gating', () => {
    let running: RunningTunnel

    beforeAll(async () => {
        running = await startTunnel()
    })
    afterAll(() => running.close())

    it('answers 503 NOT_READY on every /v1 route before configuration, without needing a token', async () => {
        const client = api(running.baseUrl)
        for (const [method, path] of [
            ['get', '/v1/info'],
            ['post', '/v1/request'],
            ['del', `/v1/request/${randomUUID()}`],
            ['get', `/v1/responses/${randomUUID()}`],
            ['get', '/v1/messages/next'],
            ['post', '/v1/messages'],
            ['post', '/v1/complete'],
        ] as const) {
            const res =
                method === 'get'
                    ? await client.get(path)
                    : method === 'del'
                      ? await client.del(path)
                      : await client.post(path, {})
            expect(res.status, `${method} ${path}`).toBe(503)
            expect(res.body.code).toBe('NOT_READY')
            expect(res.headers.get('retry-after')).toBe('2')
        }
    })

    it('requires the bearer token once configured and reports discovery content-free', async () => {
        await api(running.baseUrl, PROVISION_TOKEN).post('/local/configure', makeBundle())
        expect((await api(running.baseUrl).get('/v1/info')).status).toBe(401)
        expect((await api(running.baseUrl, 'wrong-token-0123456789').get('/v1/info')).status).toBe(401)
        for (const path of ['/v1/request', '/v1/messages', '/v1/complete']) {
            expect((await api(running.baseUrl, 'wrong-token-0123456789').post(path, {})).status).toBe(401)
        }
        const res = await api(running.baseUrl, LOCAL_API_TOKEN).get('/v1/info')
        expect(res.status).toBe(200)
        expect(InfoResponseSchema.safeParse(res.body).success).toBe(true)
        expect(res.body).toMatchObject({
            apiVersion: API_VERSION,
            legId: 'leg-a',
            peerOrgSlug: 'dp-a',
            role: 'destination',
            state: 'CONFIGURED',
        })
        expect(JSON.stringify(res.body)).not.toContain(LOCAL_API_TOKEN)
        expect(JSON.stringify(res.body)).not.toContain('relay-token')
    })

    it('holds /v1 traffic with 503 until CHANNEL_UP, then admits it', async () => {
        const client = api(running.baseUrl, LOCAL_API_TOKEN)
        for (const state of ['PEER_KEY_VERIFIED', 'RELAY_ATTACHED'] as const) {
            running.tunnel.lifecycle.transition(state, 'test')
            const res = await client.post('/v1/request', { payload: 1 })
            expect(res.status).toBe(503)
            expect(res.body.message).toContain(state)
        }
        running.tunnel.lifecycle.transition('CHANNEL_UP', 'test')
        expect((await client.post('/v1/request', { payload: 1 })).status).toBe(202)
    })
})

describe('destination local API', () => {
    let running: RunningTunnel
    let transport: RecordingTransport
    const client = () => api(running.baseUrl, LOCAL_API_TOKEN)

    beforeEach(async () => {
        transport = new RecordingTransport()
        running = await startTunnel({ deps: { transport } })
        running.tunnel.configure(makeBundle({ role: 'destination' }))
        driveToChannelUp(running.tunnel)
    })
    afterEach(() => running.close())

    it('forbids the source-only routes', async () => {
        expect((await client().get('/v1/messages/next')).status).toBe(403)
        const res = await client().post('/v1/messages', { inReplyTo: randomUUID(), payload: 1 })
        expect(res.status).toBe(403)
        expect(res.body.code).toBe('FORBIDDEN')
    })

    it('runs a round: request → hold → deliver wakes the poll; the 200 is the ack', async () => {
        const submitted = await client().post('/v1/request', { payload: { params: [1, 2] } })
        expect(submitted.status).toBe(202)
        const { correlationId } = submitted.body
        expect(submitted.body.reissued).toBe(false)
        expect(transport.sent[0]).toMatchObject({ kind: 'query', correlationId, payload: { params: [1, 2] } })

        const conflict = await client().post('/v1/request', { payload: 2 })
        expect(conflict.status).toBe(409)
        expect(conflict.body).toMatchObject({ code: 'CONFLICT', correlationId })
        expect((await client().post('/v1/request', { payload: 2, correlationId })).body).toEqual({
            correlationId,
            reissued: true,
        })
        expect(transport.sent).toHaveLength(1)

        expect((await client().get(`/v1/responses/${correlationId}`)).status).toBe(204)

        const held = client().get(`/v1/responses/${correlationId}`)
        await tick()
        const messageId = randomUUID()
        running.tunnel.exchange!.deliver({ kind: 'response', messageId, correlationId, payload: { rows: 3 } })
        const delivered = await held
        expect(delivered.status).toBe(200)
        expect(delivered.body).toMatchObject({ messageId, correlationId, payload: { rows: 3 } })
        expect(transport.acks).toEqual([messageId])

        // handed over: a second poll for the same round finds nothing to deliver and holds
        expect((await client().get(`/v1/responses/${correlationId}`)).status).toBe(204)
        expect((await client().post('/v1/request', { payload: 3 })).status).toBe(202)
    })

    it('abandons a round (DELETE) so the next request is accepted and a late response is acked and dropped', async () => {
        const { correlationId } = (await client().post('/v1/request', { payload: 1 })).body
        expect((await client().del(`/v1/request/${correlationId}`)).status).toBe(204)
        expect((await client().del(`/v1/request/${correlationId}`)).status).toBe(204) // idempotent
        expect((await client().del(`/v1/request/${randomUUID()}`)).status).toBe(204) // unknown ids too
        expect((await client().del('/v1/request/not-a-uuid')).status).toBe(400)
        const next = await client().post('/v1/request', { payload: 2 })
        expect(next.status).toBe(202)
        const late = randomUUID()
        expect(running.tunnel.exchange!.deliver({ kind: 'response', messageId: late, correlationId, payload: 1 })).toBe(
            'stale',
        )
        expect(transport.acks).toEqual([late])
        expect((await client().get(`/v1/responses/${correlationId}`)).status).toBe(204)
    })

    it('validates ids and bodies; refuses a message above the plaintext bound with 413', async () => {
        expect((await client().get('/v1/responses/not-a-uuid')).status).toBe(400)
        expect((await client().get(`/v1/responses/${randomUUID()}`)).status).toBe(404)
        expect((await client().post('/v1/request', { nope: 1 })).status).toBe(400)
        expect((await client().postRaw('/v1/request', 'not json')).status).toBe(400)
        const small = await startTunnel({ env: { FUSION_MAX_MESSAGE_BYTES: '1000' } })
        try {
            small.tunnel.configure(makeBundle({ role: 'destination' }))
            driveToChannelUp(small.tunnel)
            const res = await api(small.baseUrl, LOCAL_API_TOKEN).post('/v1/request', { payload: 'x'.repeat(2000) })
            expect(res.status).toBe(413)
            expect(res.body.code).toBe('TOO_LARGE')
        } finally {
            await small.close()
        }
    })

    it('POST /v1/complete starts closing, is idempotent, and later calls see terminal bodies', async () => {
        const first = await client().post('/v1/complete')
        expect(first.status).toBe(202)
        expect(first.body).toEqual({ state: 'CLOSING' })
        expect((await client().post('/v1/complete')).body).toEqual({ state: 'CLOSING' })
        const request = await client().post('/v1/request', { payload: 1 })
        expect(request.status).toBe(200)
        expect(request.body).toMatchObject({ terminal: true, code: 'STUDY_COMPLETE' })
        expect((await client().get(`/v1/responses/${randomUUID()}`)).status).toBe(404) // unknown id still wins over the hold
        const info = await client().get('/v1/info')
        expect(info.status).toBe(200)
        expect(info.body.state).toBe('CLOSING')
    })

    it('a held response poll returns the terminal body, with detail, when the session fails mid-hold', async () => {
        const { correlationId } = (await client().post('/v1/request', { payload: 1 })).body
        const held = client().get(`/v1/responses/${correlationId}`)
        await tick()
        running.tunnel.lifecycle.fail('LIMIT_EXCEEDED', 'peer reported', { cap: 'maxRounds', limit: 1, observed: 2 })
        const res = await held
        expect(res.status).toBe(200)
        expect(res.body).toEqual({
            terminal: true,
            code: 'LIMIT_EXCEEDED',
            message: 'peer reported',
            detail: { cap: 'maxRounds', limit: 1, observed: 2 },
        })
        expect((await client().post('/v1/request', { payload: 1 })).body.code).toBe('LIMIT_EXCEEDED')
    })
})

describe('source local API', () => {
    let running: RunningTunnel
    let transport: RecordingTransport
    const client = () => api(running.baseUrl, LOCAL_API_TOKEN)

    beforeEach(async () => {
        transport = new RecordingTransport()
        running = await startTunnel({ deps: { transport } })
        running.tunnel.configure(makeBundle({ role: 'source', orgSlug: 'dp-a', peerOrgSlug: 'si-hub' }))
        driveToChannelUp(running.tunnel)
    })
    afterEach(() => running.close())

    it('has no route through which to originate a query, abandon one, or complete the study', async () => {
        for (const [path, body] of [
            ['/v1/request', { payload: 1 }],
            ['/v1/complete', undefined],
        ] as const) {
            const res = await client().post(path, body)
            expect(res.status, path).toBe(403)
            expect(res.body.code).toBe('FORBIDDEN')
        }
        expect((await client().get(`/v1/responses/${randomUUID()}`)).status).toBe(403)
        expect((await client().del(`/v1/request/${randomUUID()}`)).status).toBe(403)
        expect(transport.sent).toHaveLength(0)
    })

    it('serves a round: long-poll → query wakes it (acked on the way out) → offered again until answered → correlated response', async () => {
        expect((await client().get('/v1/messages/next')).status).toBe(204)
        const held = client().get('/v1/messages/next')
        await tick()
        const query = {
            kind: 'query' as const,
            messageId: randomUUID(),
            correlationId: randomUUID(),
            payload: { op: 'count' },
        }
        running.tunnel.exchange!.deliver(query)
        const delivered = await held
        expect(delivered.status).toBe(200)
        expect(delivered.body).toMatchObject({
            messageId: query.messageId,
            correlationId: query.correlationId,
            payload: { op: 'count' },
        })
        expect(transport.acks).toEqual([query.messageId])

        // not yet answered (the RC may have died): the next poll offers the same query again
        expect((await client().get('/v1/messages/next')).body.messageId).toBe(query.messageId)

        const wrong = await client().post('/v1/messages', { inReplyTo: randomUUID(), payload: 1 })
        expect(wrong.status).toBe(409)
        expect(wrong.body.code).toBe('CONFLICT')

        const response = await client().post('/v1/messages', { inReplyTo: query.correlationId, payload: { n: 42 } })
        expect(response.status).toBe(202)
        expect(response.body.replayed).toBe(false)
        expect(transport.sent[0]).toMatchObject({
            kind: 'response',
            messageId: response.body.messageId,
            correlationId: query.correlationId,
            payload: { n: 42 },
        })
        expect((await client().get('/v1/messages/next')).status).toBe(204)

        const again = await client().post('/v1/messages', { inReplyTo: query.correlationId, payload: { n: 43 } })
        expect(again.body).toMatchObject({ messageId: response.body.messageId, replayed: true })
        expect(transport.sent).toHaveLength(1)
    })

    it('ends the long-poll loop with STUDY_COMPLETE when the session closes, and with typed errors otherwise', async () => {
        const held = client().get('/v1/messages/next')
        await tick()
        running.tunnel.lifecycle.transition('CLOSING', 'peer CLOSE received')
        const res = await held
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ terminal: true, code: 'STUDY_COMPLETE' })
        expect((await client().get('/v1/messages/next')).body).toMatchObject({ terminal: true, code: 'STUDY_COMPLETE' })
        expect((await client().post('/v1/messages', { inReplyTo: randomUUID(), payload: 1 })).body.code).toBe(
            'STUDY_COMPLETE',
        )

        const limited = await startTunnel()
        limited.tunnel.configure(makeBundle({ role: 'source' }))
        driveToChannelUp(limited.tunnel)
        limited.tunnel.lifecycle.fail('LIMIT_EXCEEDED', 'caps')
        const poll = await api(limited.baseUrl, LOCAL_API_TOKEN).get('/v1/messages/next')
        expect(poll.body).toMatchObject({ terminal: true, code: 'LIMIT_EXCEEDED' })
        await limited.close()
    })
})
