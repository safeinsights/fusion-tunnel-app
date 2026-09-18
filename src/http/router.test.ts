import { describe, it, expect } from 'vitest'
import { Router, type RouteHandler } from './router'

const ok: RouteHandler = () => new Response('ok')

describe('Router', () => {
    it('matches a static path and method', () => {
        const r = new Router()
        r.register('GET', '/health', ok)
        const match = r.match('GET', '/health')
        expect(match).not.toBeNull()
        expect(match!.params).toEqual({})
    })

    it('extracts a :param and URL-decodes it', () => {
        const r = new Router()
        r.register('POST', '/v1/messages/:id/ack', ok)
        const match = r.match('POST', '/v1/messages/abc%20123/ack')
        expect(match).not.toBeNull()
        expect(match!.params).toEqual({ id: 'abc 123' })
    })

    it('is method-sensitive', () => {
        const r = new Router()
        r.register('GET', '/health', ok)
        expect(r.match('POST', '/health')).toBeNull()
    })

    it('returns null when no route matches', () => {
        const r = new Router()
        r.register('GET', '/health', ok)
        expect(r.match('GET', '/nope')).toBeNull()
    })

    it('does not let a :param span path segments', () => {
        const r = new Router()
        r.register('GET', '/v1/responses/:correlationId', ok)
        expect(r.match('GET', '/v1/responses/abc/extra')).toBeNull()
    })
})
