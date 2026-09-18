import { describe, it, expect } from 'vitest'
import { Inbox } from './inbox'

describe('Inbox', () => {
    const id = 'm1'
    const epoch = '0123456789abcdef'

    it('reassembles chunks in any order and clears the partial on completion', () => {
        const inbox = new Inbox({ maxPartialMessages: 4, maxPartialBytes: 1000 })
        expect(inbox.accept(id, 2, 3, epoch, Buffer.from('c'))).toEqual({ status: 'partial', received: 1, of: 3 })
        expect(inbox.accept(id, 0, 3, epoch, Buffer.from('a'))).toEqual({ status: 'partial', received: 2, of: 3 })
        expect(inbox.partialCount).toBe(1)
        expect(inbox.partialBytes).toBe(2)
        const done = inbox.accept(id, 1, 3, epoch, Buffer.from('b'))
        expect(done.status).toBe('complete')
        if (done.status === 'complete') expect(done.plaintext.toString()).toBe('abc')
        expect(inbox.partialCount).toBe(0)
        expect(inbox.partialBytes).toBe(0)
    })

    it('ignores duplicate chunks and rejects inconsistent headers', () => {
        const inbox = new Inbox({ maxPartialMessages: 4, maxPartialBytes: 1000 })
        inbox.accept(id, 0, 2, epoch, Buffer.from('a'))
        expect(inbox.accept(id, 0, 2, epoch, Buffer.from('a')).status).toBe('duplicate_chunk')
        expect(inbox.accept(id, 1, 3, epoch, Buffer.from('b')).status).toBe('inconsistent')
        expect(inbox.partialCount).toBe(0)
        expect(inbox.accept('m2', 5, 2, epoch, Buffer.alloc(1)).status).toBe('inconsistent')
        inbox.accept('m3', 0, 2, epoch, Buffer.alloc(1))
        expect(inbox.accept('m3', 1, 2, 'fedcba9876543210', Buffer.alloc(1)).status).toBe('inconsistent')
    })

    it('bounds partial messages and bytes', () => {
        const inbox = new Inbox({ maxPartialMessages: 1, maxPartialBytes: 5 })
        inbox.accept('a', 0, 2, epoch, Buffer.alloc(3))
        expect(inbox.accept('b', 0, 2, epoch, Buffer.alloc(1)).status).toBe('overflow')
        expect(inbox.accept('a', 1, 2, epoch, Buffer.alloc(3)).status).toBe('overflow')
        expect(inbox.partialCount).toBe(0)
        inbox.accept('c', 0, 2, epoch, Buffer.alloc(1))
        inbox.clear()
        expect(inbox.partialCount).toBe(0)
        inbox.drop('nothing')
    })
})
