import { describe, it, expect, afterEach } from 'vitest'
import { createTunnel } from './tunnel'
import { loadConfig } from '@/config'
import { makeBundle, RecordingTransport, driveToChannelUp } from '@/testing/fixtures'
import { setLogSink } from '@/lib/logger'

describe('createTunnel', () => {
    afterEach(() => setLogSink(null))

    it('boots awaiting configuration with a fresh identity and no exchange', () => {
        const tunnel = createTunnel(loadConfig({ PORT: '0' }), { bma: null })
        expect(tunnel.lifecycle.state).toBe('AWAITING_CONFIG')
        expect(tunnel.bundle).toBeUndefined()
        expect(tunnel.exchange).toBeUndefined()
        expect(tunnel.identity.publicKey).toHaveLength(32)
        expect(tunnel.server.listening).toBe(false)
    })

    it('configure is idempotent for an equal bundle regardless of key order and conflicts otherwise', () => {
        const tunnel = createTunnel(loadConfig({ PORT: '0' }), { bma: null })
        const bundle = makeBundle({ role: 'source' })
        expect(tunnel.configure(bundle)).toBe('configured')
        expect(tunnel.lifecycle.state).toBe('CONFIGURED')
        expect(tunnel.exchange?.role).toBe('source')
        const reordered = {
            ...bundle,
            relay: { token: bundle.relay.token, sessionId: bundle.relay.sessionId, endpoint: bundle.relay.endpoint },
        }
        expect(tunnel.configure(reordered)).toBe('unchanged')
        expect(tunnel.configure(makeBundle({ role: 'source', legId: 'leg-b' }))).toBe('conflict')
        expect(tunnel.lifecycle.history).toHaveLength(1)
    })

    it('refuses configuration once terminal', () => {
        const tunnel = createTunnel(loadConfig({ PORT: '0' }), { bma: null })
        tunnel.lifecycle.fail('ERRORED', 'boot')
        expect(tunnel.configure(makeBundle())).toBe('terminal')
    })

    it('wires the exchange to the injected transport and lets it be swapped', () => {
        const initial = new RecordingTransport()
        const tunnel = createTunnel(loadConfig({ PORT: '0' }), { transport: initial, bma: null })
        tunnel.configure(makeBundle())
        driveToChannelUp(tunnel)
        tunnel.exchange!.request({ q: 1 })
        expect(initial.sent).toHaveLength(1)
        const replacement = new RecordingTransport()
        tunnel.setTransport(replacement)
        tunnel.exchange!.deliver({
            kind: 'response',
            messageId: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b',
            correlationId: initial.sent[0].correlationId,
            payload: 1,
        })
        tunnel.exchange!.ack('3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b')
        expect(replacement.acks).toEqual(['3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b'])
    })

    it('wakes held long-polls when the session starts closing and logs transitions content-free', async () => {
        const lines: string[] = []
        setLogSink((line) => lines.push(line))
        const tunnel = createTunnel(loadConfig({ PORT: '0' }), { bma: null })
        tunnel.configure(makeBundle())
        driveToChannelUp(tunnel)
        const held = tunnel.responseWaiters.wait('cid', 5_000)
        const heldQuery = tunnel.queryWaiters.wait('next', 5_000)
        tunnel.complete('test')
        await expect(held).resolves.toBeUndefined()
        await expect(heldQuery).resolves.toBeUndefined()
        expect(tunnel.lifecycle.state).toBe('CLOSING')
        const transitions = lines.filter((l) => l.includes('lifecycle.transition')).map((l) => JSON.parse(l))
        expect(transitions.at(-1)).toMatchObject({
            from: 'CHANNEL_UP',
            to: 'CLOSING',
            reason: 'test',
            legId: 'leg-a',
            role: 'destination',
        })
        expect(lines.join('\n')).not.toContain('localApiToken')
        expect(lines.join('\n')).not.toContain('relay-token')
    })

    it('uses an injected identity and clock', () => {
        const other = createTunnel(loadConfig({ PORT: '0' }), { bma: null })
        const at = new Date('2026-01-01T00:00:00Z')
        const tunnel = createTunnel(loadConfig({ PORT: '0' }), { identity: other.identity, now: () => at, bma: null })
        expect(tunnel.identity).toBe(other.identity)
        tunnel.configure(makeBundle())
        expect(tunnel.lifecycle.history[0].at).toBe(at)
    })
})
