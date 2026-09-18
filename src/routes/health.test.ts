import { health } from './health'
import { describe, it, expect } from 'vitest'

describe('Healthcheck Endpoint', () => {
    it('returns the healthcheck response', async () => {
        const response = await health(new Request('http://localhost/health'), {})
        const data = await response.json()

        expect(response.status).toBe(200)
        expect(data).toEqual({
            success: true,
            message: { status: 'ok' },
        })
    })
})
