import { describe, it, expect } from 'vitest'
import {
    loadTuning,
    loadConfig,
    TUNING_DEFAULTS,
    TUNING_ENV,
    ConfigError,
    DEFAULT_PORT,
    PROVISION_TOKEN_ENV,
} from './config'

describe('loadTuning', () => {
    it('returns the provisional defaults when nothing is set, treating an empty variable as unset', () => {
        expect(loadTuning({})).toEqual(TUNING_DEFAULTS)
        expect(loadTuning({ [TUNING_ENV.longPollMs]: '' }).longPollMs).toBe(TUNING_DEFAULTS.longPollMs)
    })

    it('overrides a knob from its env var', () => {
        expect(loadTuning({ [TUNING_ENV.longPollMs]: '1000' }).longPollMs).toBe(1000)
        expect(loadTuning({ [TUNING_ENV.maxSends]: '3' }).maxSends).toBe(3)
    })

    it.each(['abc', '-5', '0', '1.5', '1e3'])('rejects the non-positive-integer value %s', (raw) => {
        expect(() => loadTuning({ [TUNING_ENV.heartbeatMs]: raw })).toThrow(ConfigError)
    })

    it('rejects a reconnect ceiling below the floor', () => {
        expect(() => loadTuning({ [TUNING_ENV.reconnectMinMs]: '5000', [TUNING_ENV.reconnectMaxMs]: '1000' })).toThrow(
            ConfigError,
        )
    })
})

describe('loadConfig', () => {
    it('defaults the port, accepts PORT=0 and bounds PORT', () => {
        expect(loadConfig({}).port).toBe(DEFAULT_PORT)
        expect(loadConfig({ PORT: '0' }).port).toBe(0)
        expect(loadConfig({ PORT: '4010' }).port).toBe(4010)
        expect(() => loadConfig({ PORT: '70000' })).toThrow(/<= 65535/)
        expect(() => loadConfig({ PORT: 'http' })).toThrow(ConfigError)
        expect(loadConfig({}).tuning).toEqual(TUNING_DEFAULTS)
    })

    it('reads the provisioning token, treating unset and empty as absent', () => {
        expect(loadConfig({}).provisionToken).toBeUndefined()
        expect(loadConfig({ [PROVISION_TOKEN_ENV]: '' }).provisionToken).toBeUndefined()
        expect(loadConfig({ [PROVISION_TOKEN_ENV]: 'a-provisioning-token-0123456789' }).provisionToken).toBe(
            'a-provisioning-token-0123456789',
        )
    })

    it.each(['short', 'x'.repeat(513), 'has whitespace in it 0123'])('rejects the provisioning token %s', (raw) => {
        expect(() => loadConfig({ [PROVISION_TOKEN_ENV]: raw })).toThrow(ConfigError)
    })
})
