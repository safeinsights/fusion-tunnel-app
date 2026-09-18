import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { tokenExpiryMs, refreshDelayMs } from './credential'

describe('credential helpers', () => {
    it('reads exp without verifying', () => {
        const token = jwt.sign({ exp: 1_800_000_000, foo: 'bar' }, 'not-verified', { algorithm: 'HS256' })
        expect(tokenExpiryMs(token)).toBe(1_800_000_000_000)
        expect(tokenExpiryMs('garbage')).toBeUndefined()
        expect(tokenExpiryMs(jwt.sign({ foo: 'bar' }, 'x', { algorithm: 'HS256' }))).toBeUndefined()
    })

    it('schedules the refresh lead-time before expiry, never sooner than the minimum delay', () => {
        const exp = 2_000_000 // seconds
        const token = jwt.sign({ exp }, 'x', { algorithm: 'HS256' })
        const nowMs = (exp - 600) * 1000
        expect(refreshDelayMs(token, nowMs, 120_000)).toBe(480_000)
        expect(refreshDelayMs(token, (exp - 10) * 1000, 120_000)).toBe(1000)
        expect(refreshDelayMs(token, (exp - 10) * 1000, 120_000, 50)).toBe(50)
        expect(refreshDelayMs('garbage', nowMs, 120_000)).toBeUndefined()
    })
})
