import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { log, setLogSink, errorFields, type LogLevel } from './logger'

describe('logger', () => {
    const lines: { line: string; level: LogLevel }[] = []

    beforeEach(() => {
        lines.length = 0
        setLogSink((line, level) => lines.push({ line, level }))
    })

    afterEach(() => setLogSink(null))

    it('emits one JSON line with ts, level, event and scalar fields', () => {
        log.info('tunnel.started', { port: 3003, role: 'source', ready: false, nothing: null, skipped: undefined })
        expect(lines).toHaveLength(1)
        const record = JSON.parse(lines[0].line)
        expect(record.level).toBe('info')
        expect(record.event).toBe('tunnel.started')
        expect(record.port).toBe(3003)
        expect(record.role).toBe('source')
        expect(record.ready).toBe(false)
        expect(record.nothing).toBeNull()
        expect('skipped' in record).toBe(false)
        expect(new Date(record.ts).toISOString()).toBe(record.ts)
    })

    it('routes warn and error to their levels', () => {
        log.warn('a')
        log.error('b')
        expect(lines.map((l) => l.level)).toEqual(['warn', 'error'])
    })

    it('reduces an Error to name and message and a non-Error to a string', () => {
        expect(errorFields(new TypeError('boom'))).toEqual({ errorName: 'TypeError', errorMessage: 'boom' })
        expect(errorFields('raw')).toEqual({ errorMessage: 'raw' })
    })

    it('falls back to console when the sink is cleared', () => {
        setLogSink(null)
        const info = vi.spyOn(console, 'log').mockImplementation(() => {})
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        log.info('x')
        log.warn('y')
        log.error('z')
        expect(info).toHaveBeenCalledOnce()
        expect(warn).toHaveBeenCalledOnce()
        expect(error).toHaveBeenCalledOnce()
    })
})
