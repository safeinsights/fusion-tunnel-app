import { describe, it, expect } from 'vitest'
import { apiError, notReady, terminal, terminalBody, noContent } from './errors'

describe('http error helpers', () => {
    it('apiError builds a typed error body with optional extras and headers', async () => {
        const res = apiError(409, 'CONFLICT', 'busy', { correlationId: 'c' }, { 'x-test': '1' })
        expect(res.status).toBe(409)
        expect(res.headers.get('x-test')).toBe('1')
        expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'busy', correlationId: 'c' } })
    })

    it('notReady is a 503 with Retry-After', async () => {
        const res = notReady('later')
        expect(res.status).toBe(503)
        expect(res.headers.get('retry-after')).toBe('2')
        const body = (await res.json()) as { error: { code: string } }
        expect(body.error.code).toBe('NOT_READY')
    })

    it('terminal bodies carry the code and optional message', async () => {
        expect(terminalBody('STUDY_COMPLETE')).toEqual({ terminal: true, code: 'STUDY_COMPLETE' })
        expect(terminalBody('LIMIT_EXCEEDED', 'caps')).toEqual({
            terminal: true,
            code: 'LIMIT_EXCEEDED',
            message: 'caps',
        })
        const res = terminal('SESSION_ERRORED', 410)
        expect(res.status).toBe(410)
        expect(await res.json()).toEqual({ terminal: true, code: 'SESSION_ERRORED' })
    })

    it('noContent is an empty 204', () => {
        expect(noContent().status).toBe(204)
    })
})
