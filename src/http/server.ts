import http from 'node:http'
import { Router } from '@/http/router'
import { toWebRequest, sendWebResponse, requestUrl, PayloadTooLargeError } from '@/http/adapter'
import { json } from '@/http/json'
import { log, errorFields } from '@/lib/logger'

const LINGER_MS = 1_000

export type HttpApp = {
    router: Router
    server: http.Server
}

// One HttpApp per tunnel instance: nothing here is module-level state, so an in-process harness
// can run several tunnels (a hub's two legs and their sources) side by side.
export const createHttpServer = (register: (router: Router) => void): HttpApp => {
    const router = new Router()
    register(router)

    const server = http.createServer(async (req, res) => {
        try {
            const url = requestUrl(req)
            const matched = router.match(req.method ?? 'GET', url.pathname)

            if (!matched) {
                await sendWebResponse(res, json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404))
                return
            }

            const webReq = await toWebRequest(req, url)
            await sendWebResponse(res, await matched.handler(webReq, matched.params))
        } catch (error) {
            if (error instanceof PayloadTooLargeError) {
                log.warn('http.payload_too_large', { path: req.url ?? '/' })
                // Closing on a client that is still uploading resets the connection, and the RST
                // discards the 413 before it is read. Drain what is in flight instead, then close.
                const socket = res.socket
                res.on('finish', () => {
                    if (!socket) return
                    socket.resume()
                    socket.end()
                    setTimeout(() => socket.destroy(), LINGER_MS).unref()
                })
                await sendWebResponse(res, json({ error: { code: 'VALIDATION', message: error.message } }, 413))
                return
            }
            log.error('http.unhandled_error', { path: req.url ?? '/', ...errorFields(error) })
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal server error' } }))
        }
    })

    return { router, server }
}

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
