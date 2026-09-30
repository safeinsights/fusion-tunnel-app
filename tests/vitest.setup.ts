import { afterEach, beforeEach } from 'vitest'
import { setLogSink } from '@/lib/logger'

const OLD_ENV = process.env

beforeEach(() => {
    process.env = { ...OLD_ENV } // Make a copy
    // Keep test output readable; tests that assert on log lines install their own sink.
    setLogSink(() => {})
})

afterEach(() => {
    process.env = OLD_ENV // Restore old environment
    setLogSink(null)
})
