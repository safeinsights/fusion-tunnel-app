import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LongPoll } from './long-poll'

describe('LongPoll', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('resolves undefined when the hold expires', async () => {
        const poll = new LongPoll<string>()
        const held = poll.wait('k', 500)
        expect(poll.pending('k')).toBe(1)
        vi.advanceTimersByTime(499)
        expect(poll.pending()).toBe(1)
        vi.advanceTimersByTime(1)
        await expect(held).resolves.toBeUndefined()
        expect(poll.pending()).toBe(0)
    })

    it('wakes every waiter on the key with the value and clears their timers', async () => {
        const poll = new LongPoll<string>()
        const a = poll.wait('k', 1000)
        const b = poll.wait('k', 1000)
        const other = poll.wait('other', 1000)
        expect(poll.resolve('k', 'v')).toBe(2)
        await expect(a).resolves.toBe('v')
        await expect(b).resolves.toBe('v')
        expect(poll.pending('k')).toBe(0)
        expect(poll.pending('other')).toBe(1)
        vi.advanceTimersByTime(1000)
        await expect(other).resolves.toBeUndefined()
    })

    it('resolve on an idle key wakes nobody', () => {
        const poll = new LongPoll<string>()
        expect(poll.resolve('nobody', 'v')).toBe(0)
    })

    it('resolveAll wakes every key', async () => {
        const poll = new LongPoll<string>()
        const a = poll.wait('a', 1000)
        const b = poll.wait('b', 1000)
        expect(poll.resolveAll(undefined)).toBe(2)
        await expect(a).resolves.toBeUndefined()
        await expect(b).resolves.toBeUndefined()
        expect(poll.pending()).toBe(0)
    })
})
