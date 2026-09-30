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
        expect(mod.tunnel).toBeUndefined()
    })

    it('boots and listens outside of test', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        vi.stubEnv('PORT', '0')
        vi.stubEnv('FUSION_PROVISION_TOKEN', 'boot-test-provision-token-0123456789')
        const mod = await import('@/server')
        expect(mod.tunnel).toBeDefined()
        await new Promise<void>((resolve) => {
            if (mod.tunnel!.server.listening) resolve()
            else mod.tunnel!.server.once('listening', () => resolve())
        })
        expect(mod.tunnel!.server.listening).toBe(true)
        expect(mod.tunnel!.lifecycle.state).toBe('AWAITING_CONFIG')
        await new Promise<void>((resolve) => mod.tunnel!.server.close(() => resolve()))
    })

    it('refuses to boot without a provisioning token', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        vi.stubEnv('PORT', '0')
        vi.stubEnv('FUSION_PROVISION_TOKEN', '')
        const booted = await import('@/server').catch((error: Error) => error)
        expect(booted).toBeInstanceOf(Error)
        expect((booted as Error).message).toContain('FUSION_PROVISION_TOKEN')
    })

    it('refuses to boot on an invalid tuning value', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        vi.stubEnv('PORT', '0')
        vi.stubEnv('FUSION_PROVISION_TOKEN', 'boot-test-provision-token-0123456789')
        vi.stubEnv('FUSION_LONGPOLL_MS', 'soon')
        const booted = await import('@/server').catch((error: Error) => error)
        expect(booted).toBeInstanceOf(Error)
        expect((booted as Error).message).toContain('FUSION_LONGPOLL_MS')
    })
})
