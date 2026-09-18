import { describe, it, expect } from 'vitest'
import { health } from './health'
import { createTunnel } from '@/tunnel'
import { loadConfig } from '@/config'

describe('Healthcheck Endpoint', () => {
    it('returns ok with the current lifecycle state', async () => {
        const tunnel = createTunnel(loadConfig({ PORT: '0' }))
        const response = await health(tunnel)(new Request('http://localhost/health'), {})
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            message: { status: 'ok', state: 'AWAITING_CONFIG' },
        })
    })
})
