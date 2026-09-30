import { describe, it, expect, afterEach } from 'vitest'
import { z } from 'zod'
import {
    bearerMatches,
    close,
    createHttpServer,
    error,
    listen,
    noContent,
    ok,
    parseBody,
    Router,
    type Req,
} from './http'

const req = (over: Partial<Req> = {}): Req => ({
    method: 'GET',
    path: '/',
    params: {},
    headers: {},
    body: undefined,
    ...over,
})

describe('http helpers', () => {
    it('matches routes with params and rejects the rest', () => {
        const router = new Router()
        router.register('GET', '/v1/responses/:id', (r) => ok(r.params))
        router.register('POST', '/v1/x.y', () => noContent())
        expect(router.match('GET', '/v1/responses/abc%20d')?.params).toEqual({ id: 'abc d' })
        expect(router.match('POST', '/v1/responses/abc')).toBeUndefined()
        expect(router.match('POST', '/v1/x.y')).toBeDefined()
        expect(router.match('POST', '/v1/xzy')).toBeUndefined()
    })

    it('validates bodies content-free and compares bearers constant-time', () => {
        const schema = z.object({ payload: z.json(), n: z.int() })
        const bad = parseBody(req({ body: { payload: 'secret-value', n: 'x' } }), schema)
        expect(bad.ok).toBe(false)
        if (!bad.ok) {
            expect(bad.res.status).toBe(400)
            expect(JSON.stringify(bad.res.body)).not.toContain('secret-value')
            expect((bad.res.body as { issues: { path: string }[] }).issues.map((i) => i.path)).toEqual(['n'])
        }
        expect(parseBody(req({ body: { payload: 1, n: 2 } }), schema)).toEqual({ ok: true, data: { payload: 1, n: 2 } })
        expect(bearerMatches({ authorization: 'Bearer abc' }, 'abc')).toBe(true)
        expect(bearerMatches({ authorization: 'bearer abc ' }, 'abc')).toBe(true)
        expect(bearerMatches({ authorization: 'Bearer abcd' }, 'abc')).toBe(false)
        expect(bearerMatches({ authorization: 'Basic abc' }, 'abc')).toBe(false)
        expect(bearerMatches({}, 'abc')).toBe(false)
        expect(error(409, 'CONFLICT', 'x', { correlationId: 'c' })).toEqual({
            status: 409,
            body: { code: 'CONFLICT', message: 'x', correlationId: 'c' },
        })
    })
})

describe('http server', () => {
    const servers: import('node:http').Server[] = []
    afterEach(async () => {
        for (const s of servers.splice(0)) await close(s)
    })

    const start = async (maxBodyBytes = 64) => {
        const router = new Router()
        router.register('POST', '/echo', (r) => ok({ got: r.body }))
        router.register('GET', '/boom', () => {
            throw new Error('nope')
        })
        router.register('GET', '/empty', () => noContent())
        const server = createHttpServer(router, { maxBodyBytes })
        servers.push(server)
        const port = await listen(server, 0)
        return `http://127.0.0.1:${port}`
    }

    it('parses JSON, answers 404/400/413/500 with the one error shape', async () => {
        const base = await start()
        const post = (path: string, body: string, headers: Record<string, string> = {}) =>
            fetch(`${base}${path}`, {
                method: 'POST',
                body,
                headers: { 'content-type': 'application/json', ...headers },
            })
        expect(await (await post('/echo', '{"a":1}')).json()).toEqual({ got: { a: 1 } })
        expect((await post('/echo', '')).status).toBe(200)
        const notJson = await post('/echo', '{oops')
        expect(notJson.status).toBe(400)
        expect(await notJson.json()).toMatchObject({ code: 'VALIDATION' })
        const tooBig = await post('/echo', JSON.stringify({ big: 'x'.repeat(200) }))
        expect(tooBig.status).toBe(413)
        expect(await tooBig.json()).toMatchObject({ code: 'TOO_LARGE' })
        const declared = await post('/echo', '{}', { 'content-length': '999999' }).catch(() => undefined)
        if (declared) expect(declared.status).toBe(413)
        expect((await fetch(`${base}/nowhere`)).status).toBe(404)
        expect((await fetch(`${base}/boom`)).status).toBe(500)
        expect((await fetch(`${base}/empty`)).status).toBe(204)
        await close(servers[0]!)
        await close(servers[0]!) // idempotent
    })
})
