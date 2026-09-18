import { describe, it, expect } from 'vitest'
import { Outbox } from './outbox'

const entry = (messageId: string, sizeBytes = 100) => ({
    messageId,
    kind: 'query' as const,
    correlationId: 'c',
    plaintext: Buffer.from('x'),
    sizeBytes,
    wireSizeBytes: sizeBytes,
})

describe('Outbox', () => {
    it('bounds by message count and bytes and keeps insertion order', () => {
        const outbox = new Outbox({ maxMsgs: 2, maxBytes: 250 })
        expect(outbox.add(entry('a'))).toBe(true)
        expect(outbox.add(entry('a'))).toBe(true) // idempotent
        expect(outbox.add(entry('b'))).toBe(true)
        expect(outbox.add(entry('c'))).toBe(false) // count
        outbox.remove('a')
        expect(outbox.add(entry('c', 200))).toBe(false) // bytes: 100 + 200 > 250
        expect(outbox.add(entry('c', 150))).toBe(true)
        expect(outbox.inOrder().map((e) => e.messageId)).toEqual(['b', 'c'])
        expect(outbox.depth).toBe(2)
        expect(outbox.bytesQueued).toBe(250)
        expect(outbox.has('b')).toBe(true)
        expect(outbox.remove('zzz')).toBeUndefined()
    })

    it('tracks sends per epoch and invalidates them all on a new epoch or reconnect', () => {
        const outbox = new Outbox({ maxMsgs: 10, maxBytes: 10_000 })
        outbox.add(entry('a'))
        outbox.add(entry('b'))
        expect(outbox.pendingFor('e1').map((e) => e.messageId)).toEqual(['a', 'b'])
        outbox.markSent('a', 'e1')
        expect(outbox.pendingFor('e1').map((e) => e.messageId)).toEqual(['b'])
        expect(outbox.get('a')?.sends).toBe(1)
        outbox.markSent('b', 'e1')
        expect(outbox.pendingFor('e2')).toHaveLength(2)
        outbox.invalidateSent()
        expect(outbox.pendingFor('e1')).toHaveLength(2)
        outbox.markSent('a', 'e1')
        outbox.resetSent('a')
        expect(outbox.pendingFor('e1')).toHaveLength(2)
        outbox.markSent('missing', 'e1')
        outbox.resetSent('missing')
        outbox.setLimits({ maxMsgs: 1, maxBytes: 1 })
        expect(outbox.limitsInEffect).toEqual({ maxMsgs: 1, maxBytes: 1 })
    })
})
