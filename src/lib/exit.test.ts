import { describe, it, expect, afterEach } from 'vitest'
import { installExitPolicy, exitCodeFor, EXIT_CODES } from './exit'
import { loadConfig } from '@/config'
import { createTunnel, type Tunnel } from '@/tunnel'
import { listen } from '@/http/server'
import { makeBundle, driveToChannelUp } from '@/testing/fixtures'

const start = async () => {
    const tunnel = createTunnel(loadConfig({ PORT: '0' }), { bma: null })
    await listen(tunnel.server, 0)
    return tunnel
}

describe('exit policy', () => {
    let tunnel: Tunnel

    afterEach(() => {
        tunnel?.stop()
        tunnel?.server.close()
    })

    it('maps terminal states to the Setup App exit-code contract', () => {
        expect(exitCodeFor('CLOSED')).toBe(0)
        expect(exitCodeFor('ERRORED')).toBe(1)
        expect(exitCodeFor('LIMIT_EXCEEDED')).toBe(2)
        expect(exitCodeFor('CHANNEL_UP')).toBeUndefined()
        expect(EXIT_CODES.CLOSED).toBe(0)
    })

    it.each([
        ['CLOSED', 0],
        ['ERRORED', 1],
        ['LIMIT_EXCEEDED', 2],
    ] as const)('exits %s with code %d after the grace period, with the server closed', async (state, code) => {
        tunnel = await start()
        tunnel.configure(makeBundle({ role: 'source' }))
        driveToChannelUp(tunnel)
        const exits: number[] = []
        const exited = new Promise<void>((resolve) =>
            installExitPolicy(tunnel, {
                exit: (c) => {
                    exits.push(c)
                    resolve()
                },
                graceMs: 10,
            }),
        )
        if (state === 'CLOSED') {
            tunnel.lifecycle.transition('CLOSING', 'test')
            tunnel.lifecycle.transition('CLOSED', 'test')
        } else {
            tunnel.lifecycle.fail(state, 'test')
        }
        await exited
        expect(exits).toEqual([code])
        expect(tunnel.server.listening).toBe(false)
    })

    it('exits once even if several terminal-adjacent transitions fire, and uninstall stops it', async () => {
        tunnel = await start()
        const exits: number[] = []
        const policy = installExitPolicy(tunnel, { exit: (c) => exits.push(c), graceMs: 5 })
        policy.uninstall()
        tunnel.lifecycle.fail('ERRORED', 'ignored')
        await new Promise((r) => setTimeout(r, 30))
        expect(exits).toEqual([])
    })

    it('shutdown on a signal stops the tunnel and exits 0', async () => {
        tunnel = await start()
        const exits: number[] = []
        const policy = installExitPolicy(tunnel, { exit: (c) => exits.push(c), graceMs: 5 })
        await policy.shutdown('SIGTERM')
        await policy.shutdown('SIGTERM') // idempotent
        expect(exits).toEqual([0])
        expect(tunnel.server.listening).toBe(false)
    })
})
