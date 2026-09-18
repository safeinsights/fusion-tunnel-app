import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import {
    api,
    driveToChannelUp,
    LOCAL_API_TOKEN,
    makeBundle,
    RecordingTransport,
    startTunnel,
    tick,
    type RunningTunnel,
} from '@/testing/fixtures'
import { IdentityResponseSchema } from '@/schemas/provisioning'
import { InfoResponseSchema } from '@/schemas/local-api'

describe('provisioning API', () => {
    let running: RunningTunnel

    beforeAll(async () => {
        running = await startTunnel()
    })
    afterAll(() => running.close())

    it('GET /local/identity returns the fresh public keys', async () => {
        const res = await api(running.baseUrl).get('/local/identity')
        expect(res.status).toBe(200)
        expect(IdentityResponseSchema.safeParse(res.body).success).toBe(true)
        expect(res.body.connectionId).toBe(running.tunnel.identity.connectionId)
    })

    it('POST /local/configure rejects malformed JSON, schema failures and an unparseable org key', async () => {
        const client = api(running.baseUrl)
        expect((await client.postRaw('/local/configure', '{oops')).status).toBe(400)

        const invalid = await client.post('/local/configure', { ...makeBundle(), role: 'observer', localApiToken: 'x' })
        expect(invalid.status).toBe(400)
        expect(invalid.body.error.code).toBe('VALIDATION')
        const paths = invalid.body.error.issues.map((i: { path: string }) => i.path)
        expect(paths).toContain('role')
        expect(paths).toContain('localApiToken')
        expect(JSON.stringify(invalid.body)).not.toContain('observer')

        const badPem = await client.post('/local/configure', {
            ...makeBundle(),
            peerOrgPublicKey: '-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n',
        })
        expect(badPem.status).toBe(400)
        expect(badPem.body.error.issues[0].path).toBe('peerOrgPublicKey')
        expect(running.tunnel.lifecycle.state).toBe('AWAITING_CONFIG')
    })

    it('POST /local/configure accepts a bundle once, idempotently, and conflicts on a different one', async () => {
        const client = api(running.baseUrl)
        const bundle = makeBundle()
        const first = await client.post('/local/configure', bundle)
        expect(first.status).toBe(200)
        expect(first.body).toEqual({ state: 'CONFIGURED', configured: true })

        const again = await client.post('/local/configure', bundle)
        expect(again.status).toBe(200)
        expect(again.body).toEqual({ state: 'CONFIGURED', configured: false })

        const different = await client.post('/local/configure', makeBundle({ legId: 'leg-b' }))
        expect(different.status).toBe(409)
        expect(different.body.error.code).toBe('CONFLICT')
    })

    it('POST /local/configure answers 410 once the tunnel is terminal', async () => {
        running.tunnel.lifecycle.fail('ERRORED', 'test')
        const res = await api(running.baseUrl).post('/local/configure', makeBundle())
        expect(res.status).toBe(410)
        expect(res.body).toEqual({ terminal: true, code: 'SESSION_ERRORED' })
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
            ['get', `/v1/responses/${uuidv4()}`],
            ['get', '/v1/messages/next'],
            ['post', '/v1/messages'],
            ['post', `/v1/messages/${uuidv4()}/ack`],
            ['post', '/v1/complete'],
        ] as const) {
            const res = method === 'get' ? await client.get(path) : await client.post(path, {})
            expect(res.status, `${method} ${path}`).toBe(503)
            expect(res.body.error.code).toBe('NOT_READY')
            expect(res.headers.get('retry-after')).toBe('2')
        }
    })

    it('requires the bearer token once configured', async () => {
        await api(running.baseUrl).post('/local/configure', makeBundle())
        expect((await api(running.baseUrl).get('/v1/info')).status).toBe(401)
        expect((await api(running.baseUrl, 'wrong-token-0123456789').get('/v1/info')).status).toBe(401)
        expect((await api(running.baseUrl, LOCAL_API_TOKEN).get('/v1/info')).status).toBe(200)
        for (const path of ['/v1/request', '/v1/messages', '/v1/complete', `/v1/messages/${uuidv4()}/ack`]) {
            expect((await api(running.baseUrl, 'wrong-token-0123456789').post(path, {})).status).toBe(401)
        }
    })

    it('GET /v1/info reports the leg, role and state content-free', async () => {
        const res = await api(running.baseUrl, LOCAL_API_TOKEN).get('/v1/info')
        expect(InfoResponseSchema.safeParse(res.body).success).toBe(true)
        expect(res.body).toMatchObject({
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
            expect(res.body.error.message).toContain(state)
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
        const res = await client().post('/v1/messages', { inReplyTo: uuidv4(), payload: 1 })
        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('runs a round: request → hold → deliver wakes the poll → ack', async () => {
        const submitted = await client().post('/v1/request', { payload: { params: [1, 2] } })
        expect(submitted.status).toBe(202)
        const { correlationId } = submitted.body
        expect(submitted.body.reissued).toBe(false)
        expect(transport.sent[0]).toMatchObject({ kind: 'query', correlationId, payload: { params: [1, 2] } })

        expect((await client().post('/v1/request', { payload: 2 })).status).toBe(409)
        expect((await client().post('/v1/request', { payload: 2, correlationId })).body).toEqual({
            correlationId,
            reissued: true,
        })
        expect(transport.sent).toHaveLength(1)

        const emptyHold = await client().get(`/v1/responses/${correlationId}`)
        expect(emptyHold.status).toBe(204)

        const held = client().get(`/v1/responses/${correlationId}`)
        await tick()
        const messageId = uuidv4()
        running.tunnel.exchange!.deliver({ kind: 'response', messageId, correlationId, payload: { rows: 3 } })
        const delivered = await held
        expect(delivered.status).toBe(200)
        expect(delivered.body).toMatchObject({ messageId, correlationId, payload: { rows: 3 } })

        expect((await client().get(`/v1/responses/${correlationId}`)).status).toBe(200)

        const acked = await client().post(`/v1/messages/${messageId}/ack`)
        expect(acked.status).toBe(200)
        expect(acked.body).toEqual({ messageId, acked: true })
        expect(transport.acks).toEqual([messageId])
        expect((await client().post(`/v1/messages/${messageId}/ack`)).status).toBe(200)

        const consumed = await client().get(`/v1/responses/${correlationId}`)
        expect(consumed.status).toBe(409)
        expect((await client().post('/v1/request', { payload: 3 })).status).toBe(202)
    })

    it('validates ids and bodies', async () => {
        expect((await client().get('/v1/responses/not-a-uuid')).status).toBe(400)
        expect((await client().post('/v1/messages/not-a-uuid/ack')).status).toBe(400)
        expect((await client().post(`/v1/messages/${uuidv4()}/ack`)).status).toBe(404)
        expect((await client().get(`/v1/responses/${uuidv4()}`)).status).toBe(404)
        expect((await client().post('/v1/request', { nope: 1 })).status).toBe(400)
        expect((await client().postRaw('/v1/request', 'not json')).status).toBe(400)
    })

    it('POST /v1/complete starts closing, is idempotent, and later calls see terminal bodies', async () => {
        const first = await client().post('/v1/complete')
        expect(first.status).toBe(202)
        expect(first.body).toEqual({ state: 'CLOSING' })
        expect((await client().post('/v1/complete')).body).toEqual({ state: 'CLOSING' })

        const request = await client().post('/v1/request', { payload: 1 })
        expect(request.status).toBe(410)
        expect(request.body).toEqual({ terminal: true, code: 'STUDY_COMPLETE' })

        const poll = await client().get(`/v1/responses/${uuidv4()}`)
        expect(poll.status).toBe(404) // unknown id still wins over the hold

        const info = await client().get('/v1/info')
        expect(info.status).toBe(200)
        expect(info.body.state).toBe('CLOSING')
    })

    it('a held response poll returns the terminal body when the session fails mid-hold', async () => {
        const { correlationId } = (await client().post('/v1/request', { payload: 1 })).body
        const held = client().get(`/v1/responses/${correlationId}`)
        await tick()
        running.tunnel.lifecycle.fail('ERRORED', 'dead-letter')
        const res = await held
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ terminal: true, code: 'SESSION_ERRORED' })
        expect((await client().post(`/v1/messages/${uuidv4()}/ack`)).status).toBe(410)
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

    it('has no route through which to originate a query or complete the study', async () => {
        for (const [path, body] of [
            ['/v1/request', { payload: 1 }],
            ['/v1/complete', undefined],
        ] as const) {
            const res = await client().post(path, body)
            expect(res.status, path).toBe(403)
            expect(res.body.error.code).toBe('FORBIDDEN')
        }
        expect((await client().get(`/v1/responses/${uuidv4()}`)).status).toBe(403)
        expect(transport.sent).toHaveLength(0)
    })

    it('serves a round: long-poll → query wakes it → redelivered until ack → correlated response', async () => {
        expect((await client().get('/v1/messages/next')).status).toBe(204)

        const held = client().get('/v1/messages/next')
        await tick()
        const query = { kind: 'query' as const, messageId: uuidv4(), correlationId: uuidv4(), payload: { op: 'count' } }
        running.tunnel.exchange!.deliver(query)
        const delivered = await held
        expect(delivered.status).toBe(200)
        expect(delivered.body).toMatchObject({
            messageId: query.messageId,
            correlationId: query.correlationId,
            payload: { op: 'count' },
        })

        // not yet acked: the next poll returns the same query immediately
        expect((await client().get('/v1/messages/next')).body.messageId).toBe(query.messageId)

        const wrong = await client().post('/v1/messages', { inReplyTo: uuidv4(), payload: 1 })
        expect(wrong.status).toBe(409)
        expect(wrong.body.error.code).toBe('CONFLICT')

        expect((await client().post(`/v1/messages/${query.messageId}/ack`)).status).toBe(200)
        expect(transport.acks).toEqual([query.messageId])
        expect((await client().get('/v1/messages/next')).status).toBe(204)

        const response = await client().post('/v1/messages', { inReplyTo: query.correlationId, payload: { n: 42 } })
        expect(response.status).toBe(202)
        expect(response.body.replayed).toBe(false)
        expect(transport.sent[0]).toMatchObject({
            kind: 'response',
            messageId: response.body.messageId,
            correlationId: query.correlationId,
            payload: { n: 42 },
        })

        const again = await client().post('/v1/messages', { inReplyTo: query.correlationId, payload: { n: 43 } })
        expect(again.body).toEqual({ messageId: response.body.messageId, replayed: true })
        expect(transport.sent).toHaveLength(1)
    })

    it('ends the long-poll loop with STUDY_COMPLETE when the session closes, and with typed errors otherwise', async () => {
        const held = client().get('/v1/messages/next')
        await tick()
        running.tunnel.lifecycle.transition('CLOSING', 'peer CLOSE received')
        const res = await held
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ terminal: true, code: 'STUDY_COMPLETE' })
        expect((await client().get('/v1/messages/next')).body).toEqual({ terminal: true, code: 'STUDY_COMPLETE' })
        expect((await client().post('/v1/messages', { inReplyTo: uuidv4(), payload: 1 })).status).toBe(410)

        const limited = await startTunnel()
        limited.tunnel.configure(makeBundle({ role: 'source' }))
        driveToChannelUp(limited.tunnel)
        limited.tunnel.lifecycle.fail('LIMIT_EXCEEDED', 'caps')
        const poll = await api(limited.baseUrl, LOCAL_API_TOKEN).get('/v1/messages/next')
        expect(poll.body).toEqual({ terminal: true, code: 'LIMIT_EXCEEDED' })
        await limited.close()
    })
})
