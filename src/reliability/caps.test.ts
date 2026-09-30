import { describe, it, expect } from 'vitest'
import { CapsMeter, payloadBytes } from './caps'

describe('CapsMeter', () => {
    it('enforces nothing when the manifest sets no limits', () => {
        const meter = new CapsMeter({})
        expect(meter.checkQuery(10 ** 9)).toEqual({ ok: true })
        expect(meter.checkResponse(10 ** 9)).toEqual({ ok: true })
        meter.recordQuery(5)
        meter.recordResponse(7)
        expect(meter.budget()).toEqual({ roundsUsed: 1, responseBytesUsed: 7, queryBytesUsed: 5 })
        expect(meter.consumed()).toEqual({ rounds: 1, responsePlaintextBytes: 7, queryPlaintextBytes: 5 })
        expect(meter.nearLimit()).toBe(false)
    })

    it('trips each query-side cap with the offending limit named', () => {
        expect(
            new CapsMeter(
                { maxRounds: 1 },
                { rounds: 1, responsePlaintextBytes: 0, queryPlaintextBytes: 0 },
            ).checkQuery(1),
        ).toMatchObject({
            ok: false,
            limit: 'maxRounds',
            used: 2,
            max: 1,
        })
        expect(new CapsMeter({ maxQueryPlaintextBytesPerRound: 10 }).checkQuery(11)).toMatchObject({
            ok: false,
            limit: 'maxQueryPlaintextBytesPerRound',
        })
        const cumulative = new CapsMeter({ maxCumulativeQueryPlaintextBytes: 15 })
        expect(cumulative.checkQuery(10)).toEqual({ ok: true })
        cumulative.recordQuery(10)
        expect(cumulative.checkQuery(6)).toMatchObject({
            ok: false,
            limit: 'maxCumulativeQueryPlaintextBytes',
            used: 16,
            max: 15,
        })
    })

    it('trips each response-side cap', () => {
        expect(new CapsMeter({ maxResponsePlaintextBytesPerRound: 10 }).checkResponse(11)).toMatchObject({
            ok: false,
            limit: 'maxResponsePlaintextBytesPerRound',
        })
        const cumulative = new CapsMeter(
            { maxCumulativeResponsePlaintextBytes: 15 },
            { rounds: 0, responsePlaintextBytes: 10, queryPlaintextBytes: 0 },
        )
        expect(cumulative.checkResponse(5)).toEqual({ ok: true })
        expect(cumulative.checkResponse(6)).toMatchObject({ ok: false, limit: 'maxCumulativeResponsePlaintextBytes' })
    })

    it('meters rounds per hour on a sliding window', () => {
        let now = 0
        const meter = new CapsMeter({ maxRoundsPerHour: 2 }, undefined, () => now)
        meter.recordQuery(1)
        now += 1000
        meter.recordQuery(1)
        expect(meter.checkQuery(1)).toMatchObject({ ok: false, limit: 'maxRoundsPerHour', used: 3, max: 2 })
        expect(meter.budget()).toMatchObject({ roundsPerHourUsed: 2, roundsPerHourMax: 2 })
        now += 60 * 60 * 1000 - 1 // the first round is now a full hour old, the second is not
        expect(meter.checkQuery(1)).toEqual({ ok: true })
        expect(meter.budget().roundsPerHourUsed).toBe(1)
    })

    it('reports budget maxima and near-limit within 10 percent', () => {
        const meter = new CapsMeter(
            { maxRounds: 100, maxCumulativeResponsePlaintextBytes: 1000, maxCumulativeQueryPlaintextBytes: 500 },
            { rounds: 89, responsePlaintextBytes: 0, queryPlaintextBytes: 0 },
        )
        expect(meter.budget()).toMatchObject({
            roundsUsed: 89,
            roundsMax: 100,
            responseBytesMax: 1000,
            queryBytesMax: 500,
        })
        expect(meter.nearLimit()).toBe(false)
        meter.recordQuery(0)
        expect(meter.nearLimit()).toBe(true)
        expect(meter.nearLimit(0.05)).toBe(false)
    })

    it('meters the canonical JSON size of a payload', () => {
        expect(payloadBytes({ a: 1 })).toBe(7)
        expect(payloadBytes('é')).toBe(4)
    })
})
