import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { z } from 'zod'
import { log, errorFields } from '@/lib/logger'

// The whole HTTP layer: a tiny router over node:http, JSON in and out, a body cap, and the one
// error-body shape every route uses. Nothing here is module-level state, so a process can host
// several tunnels (the in-process harness does).

export type Req = {
    method: string
    path: string
    params: Record<string, string>
    headers: http.IncomingHttpHeaders
    /** Parsed JSON body, or undefined when there was none. */
    body: unknown
}

export type Res = { status: number; body?: unknown; headers?: Record<string, string> }
export type Handler = (req: Req) => Res | Promise<Res>

export type ApiErrorCode =
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_READY'
    | 'CONFLICT'
    | 'VALIDATION'
    | 'NOT_FOUND'
    | 'TOO_LARGE'
    | 'BACKPRESSURE'
    | 'INTERNAL'

/** Every error body: `{code, message, ...extra}`; extra fields are content-free (ids, issue paths). */
export const error = (
    status: number,
    code: ApiErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
): Res => ({
    status,
    body: { code, message, ...extra },
})

export const ok = (body: unknown, status = 200): Res => ({ status, body })
export const noContent = (): Res => ({ status: 204 })

/** Parse and validate a JSON body; failures name issue paths only (content-free). */
export const parseBody = <T>(req: Req, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; res: Res } => {
    const result = schema.safeParse(req.body)
    if (result.success) return { ok: true, data: result.data }
    const issues = result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
    return { ok: false, res: error(400, 'VALIDATION', 'request body failed validation', { issues }) }
}

/** Local-API bearer check: both sides hashed so the comparison is constant-time regardless of length. */
export const bearerMatches = (headers: http.IncomingHttpHeaders, expected: string): boolean => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? '')
    if (!match?.[1]) return false
    const a = createHash('sha256').update(match[1], 'utf8').digest()
    const b = createHash('sha256').update(expected, 'utf8').digest()
    return timingSafeEqual(a, b)
}

type Route = { method: string; regex: RegExp; keys: string[]; handler: Handler }

export class Router {
    private readonly routes: Route[] = []

    register(method: string, pattern: string, handler: Handler): void {
        const keys: string[] = []
        const source = pattern
            .split('/')
            .map((segment) =>
                segment.startsWith(':')
                    ? (keys.push(segment.slice(1)), '([^/]+)')
                    : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            )
            .join('/')
        this.routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler })
    }

    match(method: string, path: string): { handler: Handler; params: Record<string, string> } | undefined {
        for (const route of this.routes) {
            if (route.method !== method) continue
            const captured = path.match(route.regex)
            if (!captured) continue
            const params: Record<string, string> = {}
            route.keys.forEach((key, i) => (params[key] = decodeURIComponent(captured[i + 1] ?? '')))
            return { handler: route.handler, params }
        }
        return undefined
    }
}

class TooLarge extends Error {}

const readJson = async (req: http.IncomingMessage, maxBytes: number): Promise<unknown> => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) throw new TooLarge()
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
        received += (chunk as Buffer).byteLength
        if (received > maxBytes) throw new TooLarge()
        chunks.push(chunk as Buffer)
    }
    if (received === 0) return undefined
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const send = (res: http.ServerResponse, out: Res): void => {
    const body = out.body === undefined ? undefined : JSON.stringify(out.body)
    res.writeHead(out.status, { ...(body ? { 'content-type': 'application/json' } : {}), ...out.headers })
    res.end(body)
}

export const createHttpServer = (router: Router, options: { maxBodyBytes: number }): http.Server =>
    http.createServer(async (req, res) => {
        const path = new URL(req.url ?? '/', 'http://tunnel').pathname
        const method = req.method ?? 'GET'
        try {
            const matched = router.match(method, path)
            if (!matched) return send(res, error(404, 'NOT_FOUND', 'not found'))
            let body: unknown
            if (method !== 'GET' && method !== 'HEAD') {
                try {
                    body = await readJson(req, options.maxBodyBytes)
                } catch (e) {
                    if (e instanceof TooLarge) {
                        // Closing on a client still uploading resets the connection and loses the 413; drain first.
                        req.resume()
                        res.on('finish', () => setTimeout(() => req.socket.destroy(), 1_000).unref())
                        return send(res, error(413, 'TOO_LARGE', `request body exceeds ${options.maxBodyBytes} bytes`))
                    }
                    return send(res, error(400, 'VALIDATION', 'request body is not valid JSON'))
                }
            }
            send(res, await matched.handler({ method, path, params: matched.params, headers: req.headers, body }))
        } catch (e) {
            log.error('http.unhandled_error', { path, ...errorFields(e) })
            if (!res.headersSent) send(res, error(500, 'INTERNAL', 'internal server error'))
        }
    })

export const listen = (server: http.Server, port: number): Promise<number> =>
    new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, () => {
            server.off('error', reject)
            const address = server.address()
            resolve(typeof address === 'object' && address ? address.port : port)
        })
    })

export const close = (server: http.Server): Promise<void> =>
    new Promise((resolve, reject) => {
        if (!server.listening) return resolve()
        server.close((err) => (err ? reject(err) : resolve()))
    })
