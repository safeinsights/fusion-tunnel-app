import { describe, it, expect, vi } from 'vitest'
import { Lifecycle, IllegalTransitionError, LifecycleTimeoutError, STATES, TERMINAL_STATES } from './lifecycle'

describe('Lifecycle', () => {
    const happyPath = ['CONFIGURED', 'PEER_KEY_VERIFIED', 'RELAY_ATTACHED', 'CHANNEL_UP', 'CLOSING', 'CLOSED'] as const

    it('starts awaiting configuration and walks the happy path', () => {
        const lifecycle = new Lifecycle()
        expect(lifecycle.state).toBe('AWAITING_CONFIG')
        for (const state of happyPath) lifecycle.transition(state, 'test')
        expect(lifecycle.state).toBe('CLOSED')
        expect(lifecycle.isTerminal()).toBe(true)
        expect(lifecycle.history.map((t) => t.to)).toEqual([...happyPath])
    })

    it('rejects illegal transitions', () => {
        const lifecycle = new Lifecycle()
        expect(() => lifecycle.transition('CHANNEL_UP', 'skip')).toThrow(IllegalTransitionError)
        expect(lifecycle.state).toBe('AWAITING_CONFIG')
        expect(lifecycle.canTransition('CONFIGURED')).toBe(true)
        expect(lifecycle.canTransition('CLOSING')).toBe(false)
    })

    it('allows the re-handshake path CHANNEL_UP -> RELAY_ATTACHED -> CHANNEL_UP', () => {
        const lifecycle = new Lifecycle()
        for (const state of ['CONFIGURED', 'PEER_KEY_VERIFIED', 'RELAY_ATTACHED', 'CHANNEL_UP'] as const) {
            lifecycle.transition(state, 'test')
        }
        lifecycle.transition('RELAY_ATTACHED', 'peer rejoined')
        lifecycle.transition('CHANNEL_UP', 're-handshake complete')
        expect(lifecycle.state).toBe('CHANNEL_UP')
    })

    it('terminal states accept nothing further', () => {
        for (const terminal of TERMINAL_STATES) {
            const lifecycle = new Lifecycle()
            lifecycle.transition('CONFIGURED', 'test')
            if (terminal === 'CLOSED') {
                for (const s of ['PEER_KEY_VERIFIED', 'RELAY_ATTACHED', 'CHANNEL_UP', 'CLOSING'] as const) {
                    lifecycle.transition(s, 'test')
                }
            }
            lifecycle.transition(terminal, 'test')
            for (const state of STATES) expect(lifecycle.canTransition(state)).toBe(false)
        }
    })

    it('fail() enters a terminal failure from any non-terminal state and is a no-op afterwards', () => {
        const lifecycle = new Lifecycle()
        lifecycle.transition('CONFIGURED', 'test')
        expect(lifecycle.fail('LIMIT_EXCEEDED', 'caps')?.to).toBe('LIMIT_EXCEEDED')
        expect(lifecycle.fail('ERRORED', 'again')).toBeUndefined()
        expect(lifecycle.state).toBe('LIMIT_EXCEEDED')
    })

    it('fail() refuses LIMIT_EXCEEDED before caps exist (AWAITING_CONFIG)', () => {
        const lifecycle = new Lifecycle()
        expect(lifecycle.fail('LIMIT_EXCEEDED', 'too early')).toBeUndefined()
        expect(lifecycle.fail('ERRORED', 'boot failure')?.to).toBe('ERRORED')
    })

    it('maps ending and ended states to terminal codes', () => {
        const lifecycle = new Lifecycle()
        expect(lifecycle.terminalCode()).toBeUndefined()
        for (const s of ['CONFIGURED', 'PEER_KEY_VERIFIED', 'RELAY_ATTACHED', 'CHANNEL_UP'] as const) {
            lifecycle.transition(s, 'test')
        }
        expect(lifecycle.terminalCode()).toBeUndefined()
        lifecycle.transition('CLOSING', 'test')
        expect(lifecycle.terminalCode()).toBe('STUDY_COMPLETE')
        lifecycle.transition('CLOSED', 'test')
        expect(lifecycle.terminalCode()).toBe('STUDY_COMPLETE')
        const errored = new Lifecycle()
        errored.fail('ERRORED', 'x')
        expect(errored.terminalCode()).toBe('SESSION_ERRORED')
        const limited = new Lifecycle()
        limited.transition('CONFIGURED', 'x')
        limited.fail('LIMIT_EXCEEDED', 'x')
        expect(limited.terminalCode()).toBe('LIMIT_EXCEEDED')
    })

    it('notifies listeners and lets them unsubscribe', () => {
        const lifecycle = new Lifecycle(() => new Date('2026-09-18T00:00:00Z'))
        const seen: string[] = []
        const off = lifecycle.onTransition((t) => seen.push(`${t.from}>${t.to}:${t.reason}@${t.at.toISOString()}`))
        lifecycle.transition('CONFIGURED', 'bundle')
        off()
        lifecycle.transition('PEER_KEY_VERIFIED', 'key')
        expect(seen).toEqual(['AWAITING_CONFIG>CONFIGURED:bundle@2026-09-18T00:00:00.000Z'])
    })

    it('waitFor resolves immediately when already there, on arrival, or on a pre-empting terminal', async () => {
        const lifecycle = new Lifecycle()
        await expect(lifecycle.waitFor('AWAITING_CONFIG')).resolves.toBe('AWAITING_CONFIG')

        const arrival = lifecycle.waitFor('CONFIGURED')
        lifecycle.transition('CONFIGURED', 'test')
        await expect(arrival).resolves.toBe('CONFIGURED')

        const preempted = lifecycle.waitFor('CHANNEL_UP')
        lifecycle.fail('ERRORED', 'boom')
        await expect(preempted).resolves.toBe('ERRORED')
        await expect(lifecycle.waitFor('CHANNEL_UP')).resolves.toBe('ERRORED')
    })

    it('waitFor rejects on timeout', async () => {
        vi.useFakeTimers()
        try {
            const lifecycle = new Lifecycle()
            const waiting = lifecycle.waitFor('CONFIGURED', { timeoutMs: 1000 })
            const settled = waiting.catch((e) => e)
            vi.advanceTimersByTime(1000)
            await expect(settled).resolves.toBeInstanceOf(LifecycleTimeoutError)
            lifecycle.transition('CONFIGURED', 'late')
        } finally {
            vi.useRealTimers()
        }
    })
})
