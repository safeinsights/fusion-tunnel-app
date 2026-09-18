import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { createHttpServer, listen, close, type HttpApp } from './server'
import { setLogSink } from '@/lib/logger'
import { json } from '@/http/json'

describe('createHttpServer', () => {
    let app: HttpApp
    let baseUrl: string
    const lines: string[] = []

    beforeAll(async () => {
        app = createHttpServer((router) => {
            router.register('GET', '/ok', () => json({ ok: true }))
            router.register('GET', '/boom', () => {
                throw new Error('handler exploded')
            })
            router.register('POST', '/echo/:name', async (req, params) =>
                json({ name: params.name, body: await req.text() }),
            )
        })
        const port = await listen(app.server, 0)
        baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(() => close(app.server))

    beforeEach(() => {
        lines.length = 0
        setLogSink((line) => lines.push(line))
    })

    afterEach(() => setLogSink(null))

    it('serves a registered route', async () => {
        const res = await fetch(`${baseUrl}/ok`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
    })

    it('returns 404 JSON for an unknown route', async () => {
        const res = await fetch(`${baseUrl}/nope`)
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } })
    })

    it('routes params and bodies to the handler', async () => {
        const res = await fetch(`${baseUrl}/echo/tunnel-a`, { method: 'POST', body: 'hi' })
        expect(await res.json()).toEqual({ name: 'tunnel-a', body: 'hi' })
    })

    it('answers 500 and logs event-level fields when a handler throws', async () => {
        const res = await fetch(`${baseUrl}/boom`)
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } })
        const record = JSON.parse(lines.find((l) => l.includes('http.unhandled_error'))!)
        expect(record.errorMessage).toBe('handler exploded')
        expect(record.path).toBe('/boom')
    })

    it('answers 413 for an oversized declared body without reading it', async () => {
        const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = http.request(
                `${baseUrl}/echo/x`,
                { method: 'POST', headers: { 'content-length': String(200 * 1024 * 1024) } },
                (res) => {
                    let body = ''
                    res.on('data', (chunk) => (body += chunk))
                    res.on('end', () => {
                        req.destroy()
                        resolve({ status: res.statusCode ?? 0, body })
                    })
                },
            )
            req.on('error', reject)
            req.flushHeaders()
        })
        expect(result.status).toBe(413)
        expect(JSON.parse(result.body).error.message).toMatch(/exceeds/)
        expect(lines.some((l) => l.includes('http.payload_too_large'))).toBe(true)
    })

    it('close is a no-op on a server that is not listening', async () => {
        const idle = createHttpServer(() => {})
        await expect(close(idle.server)).resolves.toBeUndefined()
    })
})
