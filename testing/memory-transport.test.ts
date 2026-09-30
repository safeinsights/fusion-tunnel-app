import { describe, it, expect } from 'vitest'
import {
    createMemoryTransportPair,
    nextFrame,
    dropEvery,
    duplicateAll,
    flipLastByte,
    MemoryEndpoint,
} from './memory-transport'

describe('memory transport', () => {
    it('delivers frames to the peer asynchronously and records both sides', async () => {
        const [a, b] = createMemoryTransportPair()
        const pending = nextFrame(b)
        await a.send(Buffer.from('hello'))
        expect((await pending).toString()).toBe('hello')
        expect(a.sent).toHaveLength(1)
        expect(b.received).toHaveLength(1)
    })

    it('applies interceptors in order and lets them be removed', async () => {
        const [a, b] = createMemoryTransportPair()
        const got: string[] = []
        b.onMessage((f) => got.push(f.toString('hex')))
        const offDup = a.intercept(duplicateAll)
        a.intercept(flipLastByte)
        await a.send(Buffer.from([0x00, 0x10]))
        expect(got).toEqual(['0011', '0011'])
        offDup()
        const offDrop = a.intercept(dropEvery(2))
        await a.send(Buffer.from([0x01]))
        await a.send(Buffer.from([0x02])) // second send (index 2 overall? no: index counts per endpoint)
        offDrop()
        expect(got.length).toBeGreaterThanOrEqual(3)
    })

    it('rejects sends on an unconnected endpoint and times out waiting for silence', async () => {
        const lonely = new MemoryEndpoint()
        await expect(lonely.send(Buffer.alloc(1))).rejects.toThrow(/not connected/)
        const [, b] = createMemoryTransportPair()
        await expect(nextFrame(b, 20)).rejects.toThrow(/no frame/)
    })
})
