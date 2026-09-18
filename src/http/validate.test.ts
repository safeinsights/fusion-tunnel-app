import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { parseJsonBody } from './validate'

const schema = z.object({ name: z.string(), count: z.int().positive() })
const post = (body: string) =>
    new Request('http://localhost/x', { method: 'POST', body, headers: { 'content-type': 'application/json' } })

describe('parseJsonBody', () => {
    it('returns the parsed data on success', async () => {
        const result = await parseJsonBody(post('{"name":"a","count":2}'), schema)
        expect(result).toEqual({ ok: true, data: { name: 'a', count: 2 } })
    })

    it('answers 400 for malformed JSON', async () => {
        const result = await parseJsonBody(post('{nope'), schema)
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.response.status).toBe(400)
            const body = (await result.response.json()) as { error: { message: string } }
            expect(body.error.message).toMatch(/not valid JSON/)
        }
    })

    it('answers 400 with issue paths for schema failures, including an empty body', async () => {
        const result = await parseJsonBody(post('{"name":1,"count":-1}'), schema)
        expect(result.ok).toBe(false)
        if (!result.ok) {
            const body = (await result.response.json()) as { error: { code: string; issues: { path: string }[] } }
            expect(body.error.code).toBe('VALIDATION')
            expect(body.error.issues.map((i) => i.path).sort()).toEqual(['count', 'name'])
        }
        const empty = await parseJsonBody(post(''), schema)
        expect(empty.ok).toBe(false)
    })
})
