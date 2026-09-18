import { describe, it, expect } from 'vitest'
import {
    loadTuning,
    loadConfig,
    TUNING_DEFAULTS,
    TUNING_ENV,
    CHUNK_CIPHERTEXT_MAX_BYTES,
    ConfigError,
    DEFAULT_PORT,
} from './config'

describe('loadTuning', () => {
    it('returns the provisional defaults when nothing is set', () => {
        expect(loadTuning({})).toEqual(TUNING_DEFAULTS)
    })

    it('treats an empty variable as unset', () => {
        expect(loadTuning({ [TUNING_ENV.longPollMs]: '' }).longPollMs).toBe(TUNING_DEFAULTS.longPollMs)
    })

    it('overrides a numeric knob from its env var', () => {
        expect(loadTuning({ [TUNING_ENV.longPollMs]: '1000' }).longPollMs).toBe(1000)
    })

    it.each(['abc', '-5', '0', '1.5', '1e3'])('rejects the non-positive-integer value %s', (raw) => {
        expect(() => loadTuning({ [TUNING_ENV.heartbeatMs]: raw })).toThrow(ConfigError)
    })

    it('parses padding buckets as an ascending list', () => {
        expect(loadTuning({ [TUNING_ENV.padBuckets]: '512,1024,4096' }).padBuckets).toEqual([512, 1024, 4096])
    })

    it('rejects buckets that are not strictly ascending', () => {
        expect(() => loadTuning({ [TUNING_ENV.padBuckets]: '1024,1024' })).toThrow(/strictly ascending/)
        expect(() => loadTuning({ [TUNING_ENV.padBuckets]: '2048,1024' })).toThrow(/strictly ascending/)
    })

    it('rejects a bucket above the chunk ciphertext ceiling', () => {
        expect(() => loadTuning({ [TUNING_ENV.padBuckets]: String(CHUNK_CIPHERTEXT_MAX_BYTES + 1) })).toThrow(
            /must not exceed/,
        )
    })

    it('rejects a reconnect ceiling below the floor', () => {
        expect(() => loadTuning({ [TUNING_ENV.reconnectMinMs]: '5000', [TUNING_ENV.reconnectMaxMs]: '1000' })).toThrow(
            ConfigError,
        )
    })

    it('does not share the default bucket array between calls', () => {
        const a = loadTuning({})
        a.padBuckets.push(1)
        expect(loadTuning({}).padBuckets).toEqual(TUNING_DEFAULTS.padBuckets)
    })
})

describe('loadConfig', () => {
    it('defaults the port', () => {
        expect(loadConfig({}).port).toBe(DEFAULT_PORT)
    })

    it('accepts PORT=0 for an ephemeral port', () => {
        expect(loadConfig({ PORT: '0' }).port).toBe(0)
    })

    it('parses and bounds PORT', () => {
        expect(loadConfig({ PORT: '4010' }).port).toBe(4010)
        expect(() => loadConfig({ PORT: '70000' })).toThrow(/<= 65535/)
        expect(() => loadConfig({ PORT: 'http' })).toThrow(ConfigError)
    })

    it('includes the tuning table', () => {
        expect(loadConfig({}).tuning).toEqual(TUNING_DEFAULTS)
    })
})
