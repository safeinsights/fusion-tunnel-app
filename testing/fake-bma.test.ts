import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import jwt from 'jsonwebtoken'
import { FakeBma, ORG_JWT_AUDIENCE } from './fake-bma'
import { FakeSetupApp } from './fake-setup-app'
import { createIdentity } from '@/lib/identity'
import { signKeyBlob } from '@/schemas/bma'
import { makeOrgKey, type OrgKeypair } from '@/testing/fixtures'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json()

describe('FakeBma', () => {
    let bma: FakeBma
    let dpA: OrgKeypair
    let hub: OrgKeypair
    let setupA: FakeSetupApp
    let setupHub: FakeSetupApp

    beforeAll(async () => {
        dpA = makeOrgKey()
        hub = makeOrgKey()
        bma = new FakeBma({ relayEndpoint: 'ws://relay.test/ws', orgs: { 'dp-a': dpA.pem, 'si-hub': hub.pem } })
        await bma.start()
        setupA = new FakeSetupApp('dp-a', dpA, bma.url)
        setupHub = new FakeSetupApp('si-hub', hub, bma.url)
    })
    afterAll(() => bma.stop())

    const publish = async (setup: FakeSetupApp, legId = 'leg-a', jobId = 'job-x') => {
        const identity = createIdentity()
        const orgKey = setup === setupA ? dpA : hub
        const keySignature = signKeyBlob(orgKey.privateKey, {
            studyId: 'study-1',
            jobId,
            legId,
            connectionId: identity.connectionId,
            publicKey: identity.publicKey,
            popKey: identity.popKey,
        }).toString('base64url')
        const res = await fetch(`${bma.url}/tunnel/keys`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${setup.orgJwt()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ studyId: 'study-1', jobId, legId, ...identity.toIdentityResponse(), keySignature }),
        })
        return { identity, res }
    }

    it('requires an org-JWT from a registered org to publish and assigns generations per (study, leg, org)', async () => {
        const anonymous = await fetch(`${bma.url}/tunnel/keys`, { method: 'PUT', body: '{}' })
        expect(anonymous.status).toBe(401)
        const unknownOrg = new FakeSetupApp('dp-z', makeOrgKey(), bma.url)
        const unknown = await fetch(`${bma.url}/tunnel/keys`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${unknownOrg.orgJwt()}` },
            body: '{}',
        })
        expect(unknown.status).toBe(401)
        const forgedIss = jwt.sign({ iss: 'dp-a', aud: ORG_JWT_AUDIENCE }, makeOrgKey().privateKey, {
            algorithm: 'RS256',
            expiresIn: 60,
        })
        expect(
            (
                await fetch(`${bma.url}/tunnel/keys`, {
                    method: 'PUT',
                    headers: { authorization: `Bearer ${forgedIss}` },
                    body: '{}',
                })
            ).status,
        ).toBe(401)

        const first = await publish(setupA)
        expect(first.res.status).toBe(201)
        expect(await first.res.json()).toEqual({ generation: 1 })
        const second = await publish(setupA)
        expect(await second.res.json()).toEqual({ generation: 2 })
        const otherLeg = await publish(setupA, 'leg-b')
        expect(await otherLeg.res.json()).toEqual({ generation: 1 })
        const hubFirst = await publish(setupHub)
        expect(await hubFirst.res.json()).toEqual({ generation: 1 })
        expect(bma.latest('study-1', 'leg-a', 'dp-a')?.generation).toBe(2)
    })

    it('serves the peer key only to a leg-scoped delegated credential, 204 until published', async () => {
        const fresh = new FakeBma({ relayEndpoint: 'ws://relay.test/ws', orgs: { 'dp-a': dpA.pem, 'si-hub': hub.pem } })
        await fresh.start()
        try {
            const cred = fresh.mintCredential({
                studyId: 'study-1',
                jobId: 'job-hub',
                legId: 'leg-a',
                orgSlug: 'si-hub',
                role: 'destination',
            })
            const auth = { authorization: `Bearer ${cred.credential}` }
            expect((await fetch(`${fresh.url}/tunnel/peer-key?legId=leg-a`)).status).toBe(401)
            expect((await fetch(`${fresh.url}/tunnel/peer-key?legId=leg-b`, { headers: auth })).status).toBe(403)
            expect((await fetch(`${fresh.url}/tunnel/peer-key?legId=leg-a`, { headers: auth })).status).toBe(204)
            const identity = createIdentity()
            fresh.publishKey(
                {
                    studyId: 'study-1',
                    jobId: 'job-a',
                    legId: 'leg-a',
                    ...identity.toIdentityResponse(),
                    keySignature: 'AAAA',
                },
                'dp-a',
            )
            const served = await fetch(`${fresh.url}/tunnel/peer-key?legId=leg-a`, { headers: auth })
            expect(served.status).toBe(200)
            const body = await served.json()
            expect(body).toMatchObject({
                orgSlug: 'dp-a',
                generation: 1,
                connectionId: identity.connectionId,
                legId: 'leg-a',
            })
            expect(body).not.toHaveProperty('publishedAt')
            // an org-JWT is the wrong credential kind here
            expect(
                (
                    await fetch(`${fresh.url}/tunnel/peer-key?legId=leg-a`, {
                        headers: { authorization: `Bearer ${setupHub.orgJwt()}` },
                    })
                ).status,
            ).toBe(401)
            expect(fresh.advanceGeneration('study-1', 'leg-a', 'dp-a')).toBe(2)
            expect(fresh.advanceGeneration('study-1', 'leg-z', 'dp-a')).toBeUndefined()
        } finally {
            await fresh.stop()
        }
    })

    it('issues one relay session per leg with the same nonce to both sides, only after publication', async () => {
        const fresh = new FakeBma({
            relayEndpoint: 'ws://relay.test/ws',
            orgs: { 'dp-a': dpA.pem, 'si-hub': hub.pem },
            relayTokenTtlS: 300,
        })
        await fresh.start()
        try {
            const a = new FakeSetupApp('dp-a', dpA, fresh.url)
            const h = new FakeSetupApp('si-hub', hub, fresh.url)
            const params = 'legId=leg-a&studyId=study-1&jobId=job-a&role=source'
            expect(
                (
                    await fetch(`${fresh.url}/tunnel/relay-session?${params}`, {
                        headers: { authorization: `Bearer ${a.orgJwt()}` },
                    })
                ).status,
            ).toBe(409)
            const identity = createIdentity()
            fresh.publishKey(
                {
                    studyId: 'study-1',
                    jobId: 'job-a',
                    legId: 'leg-a',
                    ...identity.toIdentityResponse(),
                    keySignature: 'AAAA',
                },
                'dp-a',
            )
            const hubIdentity = createIdentity()
            fresh.publishKey(
                {
                    studyId: 'study-1',
                    jobId: 'job-h',
                    legId: 'leg-a',
                    ...hubIdentity.toIdentityResponse(),
                    keySignature: 'AAAA',
                },
                'si-hub',
            )
            const sourceRes = await fetch(`${fresh.url}/tunnel/relay-session?${params}`, {
                headers: { authorization: `Bearer ${a.orgJwt()}` },
            })
            expect(sourceRes.status).toBe(200)
            const source = await json(sourceRes)
            const destination = await json(
                await fetch(
                    `${fresh.url}/tunnel/relay-session?legId=leg-a&studyId=study-1&jobId=job-h&role=destination`,
                    {
                        headers: { authorization: `Bearer ${h.orgJwt()}` },
                    },
                ),
            )
            expect(source.relaySessionId).toBe(destination.relaySessionId)
            expect(source.sessionNonce).toBe(destination.sessionNonce)
            expect(source.peerOrgSlug).toBe('si-hub')
            expect(destination.peerOrgSlug).toBe('dp-a')
            expect(source.direction).toBe('dp-a->si-hub')
            expect(destination.direction).toBe('dp-a->si-hub')
            expect(source.credential).toBeDefined()
            const claims = jwt.decode(source.relayToken) as Record<string, unknown>
            expect(claims).toMatchObject({
                relaySessionId: source.relaySessionId,
                role: 'source',
                legId: 'leg-a',
                popKey: identity.popKey.toString('base64url'),
            })
            // the tunnel refreshes with its delegated credential and gets no new credential back
            const refreshed = await json(
                await fetch(`${fresh.url}/tunnel/relay-session?legId=leg-a`, {
                    headers: { authorization: `Bearer ${source.credential}` },
                }),
            )
            expect(refreshed.credential).toBeUndefined()
            expect(refreshed.relaySessionId).toBe(source.relaySessionId)
            const credential = await fetch(`${fresh.url}/tunnel/credential`, {
                method: 'POST',
                headers: { authorization: `Bearer ${source.credential}` },
            })
            expect(credential.status).toBe(200)
            expect((await json(credential)).credential).toBeDefined()
            expect((await fetch(`${fresh.url}/tunnel/relay-session?legId=leg-a`)).status).toBe(401)
            expect(
                (
                    await fetch(`${fresh.url}/tunnel/relay-session?legId=leg-b`, {
                        headers: { authorization: `Bearer ${source.credential}` },
                    })
                ).status,
            ).toBe(403)
            expect(
                (
                    await fetch(`${fresh.url}/tunnel/relay-session?legId=leg-a`, {
                        headers: { authorization: `Bearer ${a.orgJwt()}` },
                    })
                ).status,
            ).toBe(400)
        } finally {
            await fresh.stop()
        }
    })

    it('runs become visible only when every side of every leg is eligible and fail atomically on window expiry', async () => {
        const fresh = new FakeBma({
            relayEndpoint: 'ws://relay.test/ws',
            orgs: { 'dp-a': dpA.pem, 'si-hub': hub.pem, 'dp-b': makeOrgKey().pem },
        })
        await fresh.start()
        try {
            const legs = [
                {
                    legId: 'leg-a',
                    sourceOrgSlug: 'dp-a',
                    destinationOrgSlug: 'si-hub',
                    sourceJobId: 'job-a',
                    destinationJobId: 'job-hub',
                },
                {
                    legId: 'leg-b',
                    sourceOrgSlug: 'dp-b',
                    destinationOrgSlug: 'si-hub',
                    sourceJobId: 'job-b',
                    destinationJobId: 'job-hub',
                },
            ]
            fresh.registerRun('study-hub', legs, 30)
            const a = new FakeSetupApp('dp-a', dpA, fresh.url)
            expect(await a.visibleRuns()).toEqual({ runs: [] })
            fresh.setEligible('study-hub', 'leg-a', 'source')
            fresh.setEligible('study-hub', 'leg-a', 'destination')
            fresh.setEligible('study-hub', 'leg-b', 'source')
            expect(await a.visibleRuns()).toEqual({ runs: [] })
            const visible = new Promise<string>((resolve) => fresh.once('runVisible', resolve))
            fresh.setEligible('study-hub', 'leg-b', 'destination')
            expect(await visible).toBe('study-hub')
            const runs = (await a.visibleRuns()) as {
                runs: { studyId: string; legs: { legId: string; role: string; jobId: string }[] }[]
            }
            expect(runs.runs[0].legs).toEqual([
                expect.objectContaining({ legId: 'leg-a', role: 'source', jobId: 'job-a' }),
            ])
            const failed = new Promise<string>((resolve) => fresh.once('runFailed', (_s, reason) => resolve(reason)))
            expect(await a.reportLaunch('study-hub', 'leg-a', 'source')).toBe(200)
            expect(await failed).toBe('launch window expired')
            expect(fresh.runs.get('study-hub')!.status).toBe('failed')
            expect(await a.visibleRuns()).toEqual({ runs: [] })
            expect(await a.reportLaunch('nope', 'leg-a', 'source')).toBe(404)

            fresh.registerRun('study-2', [legs[0]], 5000)
            fresh.setEligible('study-2', 'leg-a', 'source')
            fresh.setEligible('study-2', 'leg-a', 'destination')
            const paired = new Promise<string>((resolve) => fresh.once('runPaired', resolve))
            await a.reportLaunch('study-2', 'leg-a', 'source')
            await new FakeSetupApp('si-hub', hub, fresh.url).reportLaunch('study-2', 'leg-a', 'destination')
            expect(await paired).toBe('study-2')
            fresh.completeRun('study-2')
            expect(fresh.runs.get('study-2')!.status).toBe('complete')
            fresh.failRun('study-2', 'too late')
            expect(fresh.runs.get('study-2')!.status).toBe('complete')
        } finally {
            await fresh.stop()
        }
    })

    it('injects failures and latency', async () => {
        bma.failNext('/api/health', 1)
        expect((await fetch(`${bma.url}/api/health`)).status).toBe(503)
        expect((await fetch(`${bma.url}/api/health`)).status).toBe(200)
        bma.setLatency(5)
        expect((await fetch(`${bma.url}/nope`)).status).toBe(404)
        bma.setLatency(0)
    })
})
