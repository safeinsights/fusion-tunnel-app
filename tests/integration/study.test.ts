import { describe, it, expect, afterEach } from 'vitest'
import { startStudy, type Study } from '@/testing/study-harness'
import { DestinationRc, SourceRc, TerminalError } from '@/testing/rc-client'
import { installExitPolicy } from '@/lib/exit'
import { until } from '@/testing/pair-harness'
import { signKeyBlob } from '@/schemas/bma'
import { createIdentity } from '@/lib/identity'

const T = 60_000

// Source handlers: a counting operation whose answer depends on the query, so the hub can derive
// the next query from the previous answer. Markers prove which source saw what.
const handlerFor = (marker: string) => (payload: unknown) => {
    const q = payload as { op: string; ids?: string[]; marker?: string }
    if (q.op === 'count') return { marker, n: (q.ids ?? []).length, seen: q.marker }
    if (q.op === 'ids') return { marker, ids: Array.from({ length: 3 }, (_, i) => `${marker}-${i}`) }
    throw new Error(`unknown op ${q.op}`)
}

describe('two-party study through the fake BMA and relay', () => {
    let study: Study

    afterEach(async () => {
        await study?.close()
    })

    it(
        'provisions both sides via the Setup Apps, runs N rounds through scripted RCs, completes, and both tunnels exit 0',
        { timeout: T },
        async () => {
            study = await startStudy({ legs: [{ legId: 'leg-a', sourceOrg: 'dp-a', caps: { maxRounds: 50 } }] })
            await study.waitChannelsUp()
            const exits: number[] = []
            for (const side of [study.leg('leg-a').source, study.leg('leg-a').destination]) {
                installExitPolicy(side.tunnel, { exit: (c) => exits.push(c), graceMs: 10 })
            }
            const source = new SourceRc(study.sourceEndpoint('leg-a'), handlerFor('A'), { readinessTimeoutMs: 15_000 })
            const serving = source.serve()
            const hub = await DestinationRc.connect({
                a: { url: study.leg('leg-a').destination.baseUrl, token: study.leg('leg-a').destination.token },
            })
            expect(hub.peer().peerOrgSlug).toBe('dp-a')
            expect(hub.peer().legId).toBe('leg-a')

            let ids: string[] = []
            for (let round = 0; round < 5; round++) {
                const answer = await hub.request(undefined, round === 0 ? { op: 'ids' } : { op: 'count', ids })
                const body = answer.payload as { marker: string; ids?: string[]; n?: number }
                expect(body.marker).toBe('A')
                if (round === 0) ids = body.ids!
                else expect(body.n).toBe(3)
                expect(answer.budget).toMatchObject({ roundsUsed: round + 1, roundsMax: 50 })
            }
            expect(hub.budget()?.roundsUsed).toBe(5)
            expect(source.served).toHaveLength(5)

            expect(await hub.complete()).toEqual({ 'dp-a': 'CLOSING' })
            expect(await serving).toBe('STUDY_COMPLETE')
            await until(() => (exits.length === 2 ? true : undefined), 15_000, 'both exits')
            expect(exits).toEqual([0, 0])
            expect(study.relay.session(study.relaySessionId('leg-a'))!.status).toBe('closed')
            const terminal = study.bma.reports.filter((r) => r.terminal?.code === 'STUDY_COMPLETE')
            expect(terminal.map((r) => r.role).sort()).toEqual(['destination', 'source'])
        },
    )
})

describe('hub study: two legs, one destination enclave', () => {
    let study: Study

    afterEach(async () => {
        await study?.close()
    })

    const twoLegs = () =>
        startStudy({
            legs: [
                { legId: 'leg-a', sourceOrg: 'dp-a' },
                { legId: 'leg-b', sourceOrg: 'dp-b' },
            ],
        })

    it(
        'drives alternating rounds with the query to B derived from A, isolates the legs, and complete() fans out',
        { timeout: T },
        async () => {
            study = await twoLegs()
            await study.waitChannelsUp()
            const a = new SourceRc(study.sourceEndpoint('leg-a'), handlerFor('A'))
            const b = new SourceRc(study.sourceEndpoint('leg-b'), handlerFor('B'))
            const servingA = a.serve()
            const servingB = b.serve()
            servingA.catch(() => undefined)
            servingB.catch(() => undefined)
            const hub = await DestinationRc.connect(study.hubEndpoints())
            expect([...hub.peers.keys()].sort()).toEqual(['dp-a', 'dp-b'])
            expect(hub.peer('dp-a').legId).toBe('leg-a')
            expect(hub.peer('leg-b').peerOrgSlug).toBe('dp-b')

            const fromA = (await hub.request('dp-a', { op: 'ids', marker: 'MARKER-A' })).payload as { ids: string[] }
            const fromB = (await hub.request('dp-b', { op: 'count', ids: fromA.ids, marker: 'MARKER-B' })).payload as {
                marker: string
                n: number
            }
            expect(fromB).toMatchObject({ marker: 'B', n: 3 })
            await hub.request('dp-a', { op: 'count', ids: ['x'], marker: 'MARKER-A2' })

            // isolation: nothing sent on leg A reached source B's RC or tunnel, and vice versa
            expect(b.served.map((s) => JSON.stringify(s.payload)).join()).not.toContain('MARKER-A')
            expect(a.served.map((s) => JSON.stringify(s.payload)).join()).not.toContain('MARKER-B')
            expect(study.relaySessionId('leg-a')).not.toBe(study.relaySessionId('leg-b'))
            expect(study.leg('leg-a').source.tunnel.channel!.epochTag).not.toBe(
                study.leg('leg-b').source.tunnel.channel!.epochTag,
            )
            expect(study.leg('leg-a').destination.tunnel.identity.connectionId).not.toBe(
                study.leg('leg-b').destination.tunnel.identity.connectionId,
            )

            expect(await hub.complete()).toEqual({ 'dp-a': 'CLOSING', 'dp-b': 'CLOSING' })
            expect(await Promise.all([servingA, servingB])).toEqual(['STUDY_COMPLETE', 'STUDY_COMPLETE'])
            await until(
                () =>
                    ['leg-a', 'leg-b'].every((l) => study.relay.session(study.relaySessionId(l))?.status === 'closed')
                        ? true
                        : undefined,
                15_000,
                'both sessions purged',
            )
            await until(
                () =>
                    study.legs.every(
                        (l) =>
                            l.source.tunnel.lifecycle.state === 'CLOSED' &&
                            l.destination.tunnel.lifecycle.state === 'CLOSED',
                    )
                        ? true
                        : undefined,
                15_000,
                'all four tunnels CLOSED',
            )
        },
    )

    it(
        "a key blob signed by source B's org key fails verification at source A (the pin holds)",
        { timeout: T },
        async () => {
            study = await twoLegs()
            await study.waitChannelsUp()
            const sourceA = study.leg('leg-a').source.tunnel
            const rejected = new Promise<string>((resolve) => sourceA.bma!.once('peerKeyRejected', resolve))
            // a compromised directory appends, into leg A's hub slot, a blob signed with dp-b's key
            const impostor = createIdentity()
            study.bma.publishKey(
                {
                    studyId: study.studyId,
                    jobId: 'job-si-hub',
                    legId: 'leg-a',
                    ...impostor.toIdentityResponse(),
                    keySignature: signKeyBlob(study.orgKeys['dp-b']!.privateKey, {
                        studyId: study.studyId,
                        jobId: 'job-si-hub',
                        legId: 'leg-a',
                        connectionId: impostor.connectionId,
                        publicKey: impostor.publicKey,
                        popKey: impostor.popKey,
                    }).toString('base64url'),
                },
                study.destinationOrg,
            )
            sourceA.bma!.refetchPeerKey()
            expect(await rejected).toBe('bad_signature')
            expect(sourceA.lifecycle.state).toBe('CHANNEL_UP') // the running channel is untouched
            expect(sourceA.channel!.verifiedPeer?.connectionId).toBe(
                study.leg('leg-a').destination.tunnel.identity.connectionId,
            )
        },
    )

    it('restarting hub tunnel-A re-handshakes leg A only', { timeout: T }, async () => {
        study = await twoLegs()
        await study.waitChannelsUp()
        const epochB = study.leg('leg-b').destination.tunnel.channel!.epochTag
        const historyB = study.leg('leg-b').source.tunnel.lifecycle.history.length
        const next = await study.restart('leg-a', 'destination')
        expect(next.tunnel.lifecycle.state).toBe('CHANNEL_UP')
        expect(study.leg('leg-b').destination.tunnel.channel!.epochTag).toBe(epochB)
        expect(study.leg('leg-b').source.tunnel.lifecycle.history.length).toBe(historyB)
        expect(
            study
                .leg('leg-a')
                .source.tunnel.lifecycle.history.map((t) => t.to)
                .slice(-2),
        ).toEqual(['RELAY_ATTACHED', 'CHANNEL_UP'])
        expect(study.relay.session(study.relaySessionId('leg-a'))!.fingerprints.destination).toBe(
            next.tunnel.identity.fingerprint,
        )

        // both legs still serve
        const a = new SourceRc(study.sourceEndpoint('leg-a'), handlerFor('A'))
        const b = new SourceRc(study.sourceEndpoint('leg-b'), handlerFor('B'))
        void a.serve().catch(() => undefined)
        void b.serve().catch(() => undefined)
        const hub = await DestinationRc.connect(study.hubEndpoints())
        expect(((await hub.request('dp-a', { op: 'ids' })).payload as { marker: string }).marker).toBe('A')
        expect(((await hub.request('dp-b', { op: 'ids' })).payload as { marker: string }).marker).toBe('B')
        a.stop()
        b.stop()
        await hub.complete()
    })

    it(
        'a query-side cap breach on leg B terminates leg B alone with a typed error at the hub',
        { timeout: T },
        async () => {
            study = await startStudy({
                legs: [
                    { legId: 'leg-a', sourceOrg: 'dp-a' },
                    { legId: 'leg-b', sourceOrg: 'dp-b', caps: { maxQueryPlaintextBytesPerRound: 60 } },
                ],
            })
            await study.waitChannelsUp()
            const a = new SourceRc(study.sourceEndpoint('leg-a'), handlerFor('A'))
            const b = new SourceRc(study.sourceEndpoint('leg-b'), handlerFor('B'))
            const servingA = a.serve()
            const servingB = b.serve()
            servingA.catch(() => undefined)
            servingB.catch(() => undefined)
            const hub = await DestinationRc.connect(study.hubEndpoints())
            expect(((await hub.request('dp-b', { op: 'ids' })).payload as { marker: string }).marker).toBe('B') // small query: fine
            await expect(
                hub.request('dp-b', { op: 'count', ids: Array.from({ length: 20 }, (_, i) => `id-${i}`) }),
            ).rejects.toBeInstanceOf(TerminalError)
            await expect(servingB).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
            expect(study.leg('leg-b').destination.tunnel.lifecycle.state).toBe('LIMIT_EXCEEDED')
            expect(study.leg('leg-b').source.tunnel.lifecycle.state).toBe('LIMIT_EXCEEDED')
            // leg A is untouched and still answers
            expect(study.leg('leg-a').destination.tunnel.lifecycle.state).toBe('CHANNEL_UP')
            expect(((await hub.request('dp-a', { op: 'ids' })).payload as { marker: string }).marker).toBe('A')
            const limited = study.bma.reports.find((r) => r.legId === 'leg-b' && r.terminal?.code === 'LIMIT_EXCEEDED')
            expect(limited).toBeDefined()
            a.stop()
            await hub.complete().catch(() => undefined)
            await servingA.catch(() => undefined)
        },
    )
})
