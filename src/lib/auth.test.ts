import { describe, it, expect } from 'vitest'
import { bearerFrom, tokensMatch, isAuthorized } from './auth'

const req = (authorization?: string) =>
    new Request('http://localhost/v1/info', { headers: authorization ? { authorization } : {} })

describe('auth', () => {
    it('extracts a bearer token case-insensitively and tolerates whitespace', () => {
        expect(bearerFrom(req('Bearer abc'))).toBe('abc')
        expect(bearerFrom(req('bearer abc  '))).toBe('abc')
        expect(bearerFrom(req('Basic abc'))).toBeUndefined()
        expect(bearerFrom(req('Bearer'))).toBeUndefined()
        expect(bearerFrom(req())).toBeUndefined()
    })

    it('matches equal tokens and rejects unequal ones of any length', () => {
        expect(tokensMatch('secret-token', 'secret-token')).toBe(true)
        expect(tokensMatch('secret-token', 'secret-tokeN')).toBe(false)
        expect(tokensMatch('short', 'a-much-longer-token')).toBe(false)
        expect(tokensMatch('', 'x')).toBe(false)
    })

    it('authorizes only a correct bearer', () => {
        expect(isAuthorized(req('Bearer good'), 'good')).toBe(true)
        expect(isAuthorized(req('Bearer bad'), 'good')).toBe(false)
        expect(isAuthorized(req(), 'good')).toBe(false)
    })
})
