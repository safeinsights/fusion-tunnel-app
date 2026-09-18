import { describe, it, expect } from 'vitest'
import { canonicalJson } from './canonical'

describe('canonicalJson', () => {
    it('is independent of key order at every depth', () => {
        expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } })).toBe(
            canonicalJson({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 }),
        )
    })

    it('preserves array order and drops undefined members', () => {
        expect(canonicalJson([2, 1])).toBe('[2,1]')
        expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
    })

    it('passes scalars through', () => {
        expect(canonicalJson('x')).toBe('"x"')
        expect(canonicalJson(3)).toBe('3')
    })
})
