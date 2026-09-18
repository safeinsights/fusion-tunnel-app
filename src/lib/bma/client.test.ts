import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { FakeBma } from '@/testing/fake-bma'
import { FakeRelay } from '@/testing/fake-relay'
import { FakeSetupApp } from '@/testing/fake-setup-app'
import { api, makeOrgKey, startTunnel, type OrgKeypair, type RunningTunnel } from '@/testing/fixtures'
import { until } from '@/testing/pair-harness'
import { testBmaKey } from '@/testing/relay-tokens'
import { StatusReportSchema, type StatusReport } from '@/schemas/bma'

// BMA-driven bring-up: the harness Setup Apps provision two tunnels through the fake BMA, the
// tunnels' own BMA clients fetch and verify each other's keys, attach, handshake and report.

const TOKEN = 'local-api-token-for-tests-0123456789'

describe('BmaClient end to end', () => {
    let bma: FakeBma
    let relay: FakeRelay
    let dpA: OrgKeypair
    let hub: OrgKeypair
    let setupA: FakeSetupApp
    let setupHub: FakeSetupApp
    const running: RunningTunnel[] = []

    beforeEach(async () => {
        dpA = makeOrgKey()
        hub = makeOrgKey()
        relay = new FakeRelay({ bmaPublicKeyPem: testBmaKey().publicPem, heartbeatIntervalMs: 5_000 })
        await relay.start()
        bma = new FakeBma({
            relayEndpoint: relay.wsUrl,
            orgs: { 'dp-a': dpA.pem, 'si-hub': hub.pem },
            relayTokenTtlS: 900,
        })
        await bma.start()
        setupA = new FakeSetupApp('dp-a', dpA, bma.url)
        setupHub = new FakeSetupApp('si-hub', hub, bma.url)
    })

    afterEach(async () => {
        for (const r of running) {
            r.tunnel.stop()
            await r.close()
        }
        running.length = 0
        await bma.stop()
        await relay.stop()
    })

    const tunnelWithBma = async (env: Record<string, string> = {}) => {
        const r = await startTunnel({
            env: {
                FUSION_PEERKEY_POLL_MS: '50',
                FUSION_STATUS_INTERVAL_MS: '200',
                FUSION_HANDSHAKE_RETRY_MS: '50',
                ...env,
            },
            deps: { bma: {} },
        })
        running.push(r)
        return r
    }

    const provisionPair = async (
        options: { caps?: Record<string, number>; studyId?: string; sourceCaps?: 'bma' } = {},
    ) => {
        const studyId = options.studyId ?? `study-${uuidv4()}`
        const source = await tunnelWithBma()
        const destination = await tunnelWithBma()
        const src = await setupA.provision(source.baseUrl, {
            studyId,
            jobId: 'job-a',
            legId: 'leg-a',
            role: 'source',
            peerOrgSlug: 'si-hub',
            peerOrgPublicKeyPem: hub.pem,
            localApiToken: TOKEN,
            caps: options.caps,
            capsConsumed: options.sourceCaps,
        })
        expect(src.configureStatus).toBe(200)
        const dst = await setupHub.provision(destination.baseUrl, {
            studyId,
            jobId: 'job-hub',
            legId: 'leg-a',
            role: 'destination',
            peerOrgSlug: 'dp-a',
            peerOrgPublicKeyPem: dpA.pem,
            localApiToken: TOKEN,
        })
        expect(dst.configureStatus).toBe(200)
        return { studyId, source, destination, src, dst }
    }

    it(
        'provisions, polls 204 until the peer publishes, verifies, attaches, handshakes and runs a round',
        { timeout: 20_000 },
        async () => {
            const source = await tunnelWithBma()
            const studyId = `study-${uuidv4()}`
            const served: number[] = []
            bma.on('peerKeyServed', (_l, _o, g) => served.push(g))
            const src = await setupA.provision(source.baseUrl, {
                studyId,
                jobId: 'job-a',
                legId: 'leg-a',
                role: 'source',
                peerOrgSlug: 'si-hub',
                peerOrgPublicKeyPem: hub.pem,
                localApiToken: TOKEN,
            })
            expect(src.bundle.keyGeneration).toBe(1)
            expect(src.bundle.direction).toBe('dp-a->si-hub')
            // the source polls and sees 204 while the destination has not published
            await new Promise((r) => setTimeout(r, 150))
            expect(source.tunnel.lifecycle.state).toBe('CONFIGURED')
            expect(served).toEqual([])

            const destination = await tunnelWithBma()
            await setupHub.provision(destination.baseUrl, {
                studyId,
                jobId: 'job-hub',
                legId: 'leg-a',
                role: 'destination',
                peerOrgSlug: 'dp-a',
                peerOrgPublicKeyPem: dpA.pem,
                localApiToken: TOKEN,
            })
            await Promise.all([
                source.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs: 10_000 }),
                destination.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs: 10_000 }),
            ])
            expect(source.tunnel.lifecycle.history.map((t) => t.to)).toEqual([
                'CONFIGURED',
                'PEER_KEY_VERIFIED',
                'RELAY_ATTACHED',
                'CHANNEL_UP',
            ])
            expect(source.tunnel.bma!.peerKeyStatus).toEqual({ rejected: false, lastSeenGeneration: 1 })
            expect(source.tunnel.channel!.verifiedPeer?.connectionId).toBe(destination.tunnel.identity.connectionId)
            expect(destination.tunnel.channel!.verifiedPeer?.connectionId).toBe(source.tunnel.identity.connectionId)

            const dst = api(destination.baseUrl, TOKEN)
            const srcApi = api(source.baseUrl, TOKEN)
            const { correlationId } = (await dst.post('/v1/request', { payload: { hello: 'world' } })).body
            const query = await until(async () => {
                const res = await srcApi.get('/v1/messages/next')
                return res.status === 200 ? res.body : undefined
            })
            expect(query.payload).toEqual({ hello: 'world' })
            await srcApi.post(`/v1/messages/${query.messageId}/ack`)
            await srcApi.post('/v1/messages', { inReplyTo: correlationId, payload: { ok: true } })
            const response = await until(async () => {
                const res = await dst.get(`/v1/responses/${correlationId}`)
                return res.status === 200 ? res.body : undefined
            })
            expect(response.payload).toEqual({ ok: true })
            await dst.post(`/v1/messages/${response.messageId}/ack`)

            // status reports: periodic, content-free, carrying legId and the source's cap counters
            const report = await until(
                () => bma.reports.find((r) => r.role === 'source' && r.roundsCompleted >= 1 && r.reason === 'interval'),
                5000,
                'interval report',
            )
            expect(StatusReportSchema.safeParse(report).success).toBe(true)
            expect(report).toMatchObject({
                studyId,
                legId: 'leg-a',
                state: 'CHANNEL_UP',
                relayAdmitted: true,
                ownGeneration: 1,
                peerGeneration: 1,
                peerKeyRejected: false,
            })
            expect(report.caps?.consumed).toEqual({ rounds: 1, responsePlaintextBytes: 11, queryPlaintextBytes: 17 })
            expect(report.epochTag).toBe(source.tunnel.channel!.epochTag)
            expect(JSON.stringify(bma.reports)).not.toContain('world')
            expect(JSON.stringify(bma.reports)).not.toContain(TOKEN)
            expect(bma.reports.some((r) => r.reason === 'transition' && r.state === 'CHANNEL_UP')).toBe(true)
        },
    )

    it(
        'rejects a peer blob that fails the pin, stays polling loudly, and accepts a valid later one',
        { timeout: 20_000 },
        async () => {
            const source = await tunnelWithBma()
            const studyId = `study-${uuidv4()}`
            await setupA.provision(source.baseUrl, {
                studyId,
                jobId: 'job-a',
                legId: 'leg-a',
                role: 'source',
                peerOrgSlug: 'si-hub',
                peerOrgPublicKeyPem: hub.pem,
                localApiToken: TOKEN,
            })
            // an impostor with the hub's slug but a different signing key publishes first
            const impostor = new FakeSetupApp('si-hub', makeOrgKey(), bma.url)
            bma.registerOrg('si-hub', hub.pem) // the registry still trusts the real hub key…
            const destination = await tunnelWithBma()
            // …so the impostor can only get in by having its rows appended directly (a compromised directory)
            const impostorIdentity = destination.tunnel.identity
            const { signKeyBlob } = await import('@/schemas/bma')
            const fakeOrg = makeOrgKey()
            bma.publishKey(
                {
                    studyId,
                    jobId: 'job-hub',
                    legId: 'leg-a',
                    ...impostorIdentity.toIdentityResponse(),
                    keySignature: signKeyBlob(fakeOrg.privateKey, {
                        studyId,
                        jobId: 'job-hub',
                        legId: 'leg-a',
                        connectionId: impostorIdentity.connectionId,
                        publicKey: impostorIdentity.publicKey,
                        popKey: impostorIdentity.popKey,
                    }).toString('base64url'),
                },
                'si-hub',
            )
            void impostor
            const rejected = new Promise<string>((resolve) => source.tunnel.bma!.on('peerKeyRejected', resolve))
            expect(await rejected).toBe('bad_signature')
            await new Promise((r) => setTimeout(r, 120))
            expect(source.tunnel.lifecycle.state).toBe('CONFIGURED')
            expect(source.tunnel.bma!.peerKeyStatus.rejected).toBe(true)
            const report = source.tunnel.bma!.buildReport('interval')
            expect(report.peerKeyRejected).toBe(true)

            // the real hub Setup App provisions its tunnel (generation 2 for si-hub on this leg)
            const dst = await setupHub.provision(destination.baseUrl, {
                studyId,
                jobId: 'job-hub',
                legId: 'leg-a',
                role: 'destination',
                peerOrgSlug: 'dp-a',
                peerOrgPublicKeyPem: dpA.pem,
                localApiToken: TOKEN,
            })
            expect(dst.generation).toBe(2)
            await source.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs: 10_000 })
            expect(source.tunnel.bma!.peerKeyStatus).toEqual({ rejected: false, lastSeenGeneration: 2 })
        },
    )

    it(
        'after a peer restart it re-fetches, accepts only a higher generation, and re-handshakes; re-provision re-seeds caps',
        { timeout: 30_000 },
        async () => {
            const { studyId, source, destination } = await provisionPair({ caps: { maxRounds: 10 } })
            await Promise.all([
                source.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs: 10_000 }),
                destination.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs: 10_000 }),
            ])
            const dst = api(destination.baseUrl, TOKEN)
            const srcApi = api(source.baseUrl, TOKEN)
            const { correlationId } = (await dst.post('/v1/request', { payload: { n: 1 } })).body
            const query = await until(async () => {
                const res = await srcApi.get('/v1/messages/next')
                return res.status === 200 ? res.body : undefined
            })
            await srcApi.post(`/v1/messages/${query.messageId}/ack`)
            await srcApi.post('/v1/messages', { inReplyTo: correlationId, payload: { ok: 1 } })
            const response = await until(async () => {
                const res = await dst.get(`/v1/responses/${correlationId}`)
                return res.status === 200 ? res.body : undefined
            })
            await dst.post(`/v1/messages/${response.messageId}/ack`)
            await until(
                () => (bma.consumedFor(studyId, 'leg-a')?.rounds === 1 ? true : undefined),
                5000,
                'round reported',
            )

            // the source restarts: a fresh process, re-provisioned by its Setup App with capsConsumed from the BMA
            source.tunnel.stop()
            await source.close()
            const rejoined = new Promise<void>((resolve) =>
                destination.tunnel.channel!.once('peerRejoined', () => resolve()),
            )
            const source2 = await tunnelWithBma()
            const reprovisioned = await setupA.provision(source2.baseUrl, {
                studyId,
                jobId: 'job-a',
                legId: 'leg-a',
                role: 'source',
                peerOrgSlug: 'si-hub',
                peerOrgPublicKeyPem: hub.pem,
                localApiToken: TOKEN,
                caps: { maxRounds: 10 },
                capsConsumed: 'bma',
            })
            expect(reprovisioned.bundle.keyGeneration).toBe(2)
            expect(reprovisioned.bundle.capsConsumed).toEqual({
                rounds: 1,
                responsePlaintextBytes: 8,
                queryPlaintextBytes: 7,
            })
            expect(reprovisioned.bundle.relay.sessionId).toBe(destination.tunnel.bundle!.relay.sessionId)
            await rejoined
            await Promise.all([
                source2.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs: 10_000 }),
                until(
                    () =>
                        destination.tunnel.lifecycle.state === 'CHANNEL_UP' &&
                        destination.tunnel.channel!.verifiedPeer?.generation === 2
                            ? true
                            : undefined,
                    10_000,
                    'destination re-handshake',
                ),
            ])
            expect(destination.tunnel.bma!.peerKeyStatus.lastSeenGeneration).toBe(2)
            expect(source2.tunnel.caps!.consumed().rounds).toBe(1)

            // a second round works on the new epoch and the budget continues from the re-seeded counters
            const src2 = api(source2.baseUrl, TOKEN)
            const second = (await dst.post('/v1/request', { payload: { n: 2 } })).body
            const q2 = await until(async () => {
                const res = await src2.get('/v1/messages/next')
                return res.status === 200 ? res.body : undefined
            }, 10_000)
            await src2.post(`/v1/messages/${q2.messageId}/ack`)
            await src2.post('/v1/messages', { inReplyTo: second.correlationId, payload: { ok: 2 } })
            const r2 = await until(async () => {
                const res = await dst.get(`/v1/responses/${second.correlationId}`)
                return res.status === 200 ? res.body : undefined
            }, 10_000)
            expect(r2.budget).toMatchObject({ roundsUsed: 2, roundsMax: 10 })
        },
    )

    it(
        'pre-fetches a replacement relay token before expiry and refreshes its credential',
        { timeout: 20_000 },
        async () => {
            await bma.stop()
            bma = new FakeBma({
                relayEndpoint: relay.wsUrl,
                orgs: { 'dp-a': dpA.pem, 'si-hub': hub.pem },
                relayTokenTtlS: 3,
                credentialTtlS: 3,
            })
            await bma.start()
            setupA = new FakeSetupApp('dp-a', dpA, bma.url)
            const source = await tunnelWithBma({ FUSION_TOKEN_REFRESH_LEAD_MS: '1500' })
            const issued: string[] = []
            bma.on('relaySessionIssued', (_l, _r, caller) => issued.push(caller))
            const credentials: string[] = []
            bma.on('credentialIssued', () => credentials.push('c'))
            const provisioned = await setupA.provision(source.baseUrl, {
                studyId: `study-${uuidv4()}`,
                jobId: 'job-a',
                legId: 'leg-a',
                role: 'source',
                peerOrgSlug: 'si-hub',
                peerOrgPublicKeyPem: hub.pem,
                localApiToken: TOKEN,
            })
            const initialToken = provisioned.bundle.relay.token
            const initialCredential = provisioned.bundle.bma.credential
            await until(() => (issued.includes('tunnel') ? true : undefined), 6000, 'relay token pre-fetch')
            await until(
                () => (source.tunnel.bma!.currentRelayToken() !== initialToken ? true : undefined),
                6000,
                'token swapped',
            )
            await until(
                () => (source.tunnel.bma!.currentCredential() !== initialCredential ? true : undefined),
                6000,
                'credential swapped',
            )
            expect(credentials.length).toBeGreaterThanOrEqual(2) // provisioning + refresh
        },
    )

    it('reports a terminal status with the code and reason when the session ends', { timeout: 20_000 }, async () => {
        const { source } = await provisionPair()
        const terminal = new Promise<StatusReport>((resolve) =>
            bma.on('statusReceived', (r) => r.terminal && resolve(r)),
        )
        source.tunnel.lifecycle.fail('ERRORED', 'test-induced failure')
        const report = await terminal
        expect(report.terminal).toEqual({ code: 'SESSION_ERRORED', reason: 'test-induced failure' })
        expect(report.state).toBe('ERRORED')
        expect(report.reason).toBe('terminal')
    })

    it('keeps polling through BMA failures', { timeout: 20_000 }, async () => {
        const source = await tunnelWithBma()
        const failures: string[] = []
        const studyId = `study-${uuidv4()}`
        await setupA.provision(source.baseUrl, {
            studyId,
            jobId: 'job-a',
            legId: 'leg-a',
            role: 'source',
            peerOrgSlug: 'si-hub',
            peerOrgPublicKeyPem: hub.pem,
            localApiToken: TOKEN,
        })
        source.tunnel.bma!.on('requestFailed', (op) => failures.push(op))
        bma.failNext('/tunnel/peer-key', 2)
        await until(() => (failures.length >= 1 ? true : undefined), 5000, 'a failed poll')
        expect(source.tunnel.lifecycle.state).toBe('CONFIGURED')
        const destination = await tunnelWithBma()
        await setupHub.provision(destination.baseUrl, {
            studyId,
            jobId: 'job-hub',
            legId: 'leg-a',
            role: 'destination',
            peerOrgSlug: 'dp-a',
            peerOrgPublicKeyPem: dpA.pem,
            localApiToken: TOKEN,
        })
        await source.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs: 10_000 })
    })
})
