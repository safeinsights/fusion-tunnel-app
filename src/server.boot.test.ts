import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setLogSink } from '@/lib/logger'

describe('server startup', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.unstubAllEnvs()
        setLogSink(() => {})
    })

    afterEach(() => setLogSink(null))

    it('does not listen under NODE_ENV=test', async () => {
        vi.stubEnv('NODE_ENV', 'test')
        const mod = await import('@/server')
        expect(mod.app).toBeUndefined()
    })

    it('boots and listens outside of test', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        vi.stubEnv('PORT', '0')
        const mod = await import('@/server')
        expect(mod.app).toBeDefined()
        await new Promise<void>((resolve) => {
            if (mod.app!.server.listening) resolve()
            else mod.app!.server.once('listening', () => resolve())
        })
        expect(mod.app!.server.listening).toBe(true)
        await new Promise<void>((resolve) => mod.app!.server.close(() => resolve()))
    })

    it('refuses to boot on an invalid tuning value', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        vi.stubEnv('PORT', '0')
        vi.stubEnv('FUSION_LONGPOLL_MS', 'soon')
        const booted = await import('@/server').catch((error: Error) => error)
        expect(booted).toBeInstanceOf(Error)
        expect((booted as Error).message).toContain('FUSION_LONGPOLL_MS')
    })
})
