import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { createApp, type App } from './app'
import { loadConfig } from './config'
import { setLogSink } from '@/lib/logger'
import { json } from '@/http/json'

const listen = (app: App): Promise<string> =>
    new Promise((resolve) => {
        app.server.listen(0, () => {
            const address = app.server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            resolve(`http://127.0.0.1:${port}`)
        })
    })

const close = (app: App): Promise<void> =>
    new Promise((resolve, reject) => app.server.close((err) => (err ? reject(err) : resolve())))

describe('createApp', () => {
    let app: App
    let baseUrl: string
    const lines: string[] = []

    beforeAll(async () => {
        app = createApp(loadConfig({ PORT: '0' }))
        app.router.register('GET', '/boom', () => {
            throw new Error('handler exploded')
        })
        app.router.register('POST', '/echo/:name', async (req, params) =>
            json({ name: params.name, body: await req.text() }),
        )
        baseUrl = await listen(app)
    })

    afterAll(() => close(app))

    beforeEach(() => {
        lines.length = 0
        setLogSink((line) => lines.push(line))
    })

    afterEach(() => setLogSink(null))

    it('serves /health', async () => {
        const res = await fetch(`${baseUrl}/health`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ success: true, message: { status: 'ok' } })
    })

    it('returns 404 JSON for an unknown route', async () => {
        const res = await fetch(`${baseUrl}/nope`)
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'Not found' })
    })

    it('routes params and bodies to the handler', async () => {
        const res = await fetch(`${baseUrl}/echo/tunnel-a`, { method: 'POST', body: 'hi' })
        expect(await res.json()).toEqual({ name: 'tunnel-a', body: 'hi' })
    })

    it('answers 500 and logs event-level fields when a handler throws', async () => {
        const res = await fetch(`${baseUrl}/boom`)
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: 'Internal server error' })
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
        expect(JSON.parse(result.body).error).toMatch(/exceeds/)
        expect(lines.some((l) => l.includes('http.payload_too_large'))).toBe(true)
    })

    it('exposes the config it was built from', () => {
        expect(app.config.port).toBe(0)
    })
})
