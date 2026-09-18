import http from 'node:http'
import { Router } from '@/http/router'
import { toWebRequest, sendWebResponse, requestUrl, PayloadTooLargeError } from '@/http/adapter'
import { json } from '@/http/json'
import { log, errorFields } from '@/lib/logger'
import { health } from '@/routes/health'
import type { ServerConfig } from '@/config'

const LINGER_MS = 1_000

export type App = {
    config: ServerConfig
    router: Router
    server: http.Server
}

export const registerRoutes = (router: Router): void => {
    router.register('GET', '/health', health)
}

// One App per tunnel instance: nothing here is module-level state, so an in-process test harness
// can run several tunnels (a hub's two legs and their sources) side by side.
export const createApp = (config: ServerConfig): App => {
    const router = new Router()
    registerRoutes(router)

    const server = http.createServer(async (req, res) => {
        try {
            const url = requestUrl(req)
            const matched = router.match(req.method ?? 'GET', url.pathname)

            if (!matched) {
                await sendWebResponse(res, json({ error: 'Not found' }, 404))
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
                await sendWebResponse(res, json({ error: error.message }, 413))
                return
            }
            log.error('http.unhandled_error', { path: req.url ?? '/', ...errorFields(error) })
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'Internal server error' }))
        }
    })

    return { config, router, server }
}
