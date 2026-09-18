import { describe, it, expect } from 'vitest'
import {
    RequestBodySchema,
    DeliveredMessageSchema,
    PostMessageBodySchema,
    TerminalBodySchema,
    InfoResponseSchema,
    BudgetSchema,
    API_VERSION,
} from './local-api'

describe('local API schemas', () => {
    it('RequestBody passes any JSON payload through and accepts an optional UUID correlationId', () => {
        expect(RequestBodySchema.safeParse({ payload: { a: [1, 'x', null] } }).success).toBe(true)
        expect(RequestBodySchema.safeParse({ payload: 'plain string' }).success).toBe(true)
        expect(RequestBodySchema.safeParse({ payload: null }).success).toBe(true)
        expect(
            RequestBodySchema.safeParse({ payload: 1, correlationId: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b' }).success,
        ).toBe(true)
        expect(RequestBodySchema.safeParse({ payload: 1, correlationId: 'not-a-uuid' }).success).toBe(false)
        expect(RequestBodySchema.safeParse({}).success).toBe(false)
    })

    it('DeliveredMessage carries ids, payload, optional budget and an ISO timestamp', () => {
        const message = {
            messageId: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b',
            correlationId: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6c',
            payload: { rows: [] },
            budget: { roundsUsed: 1, roundsMax: 10, responseBytesUsed: 0, queryBytesUsed: 12 },
            receivedAt: '2026-09-18T12:00:00.000Z',
        }
        expect(DeliveredMessageSchema.safeParse(message).success).toBe(true)
        expect(DeliveredMessageSchema.safeParse({ ...message, receivedAt: 'yesterday' }).success).toBe(false)
        expect(BudgetSchema.safeParse({ roundsUsed: -1, responseBytesUsed: 0, queryBytesUsed: 0 }).success).toBe(false)
    })

    it('PostMessageBody requires inReplyTo', () => {
        expect(
            PostMessageBodySchema.safeParse({ inReplyTo: '3f2b6f7c-1f1c-4e3e-9a4b-1c9d0e8f7a6b', payload: 1 }).success,
        ).toBe(true)
        expect(PostMessageBodySchema.safeParse({ payload: 1 }).success).toBe(false)
    })

    it('TerminalBody is the closed set of codes', () => {
        expect(TerminalBodySchema.safeParse({ terminal: true, code: 'STUDY_COMPLETE' }).success).toBe(true)
        expect(TerminalBodySchema.safeParse({ terminal: true, code: 'DONE' }).success).toBe(false)
        expect(TerminalBodySchema.safeParse({ terminal: false, code: 'STUDY_COMPLETE' }).success).toBe(false)
    })

    it('InfoResponse validates the discovery shape', () => {
        expect(
            InfoResponseSchema.safeParse({
                apiVersion: API_VERSION,
                studyId: 's',
                jobId: 'j',
                legId: 'leg-a',
                orgSlug: 'si',
                peerOrgSlug: 'dp-a',
                role: 'destination',
                direction: 'dp-a->si',
                state: 'CONFIGURED',
                caps: {},
            }).success,
        ).toBe(true)
        expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    })
})
