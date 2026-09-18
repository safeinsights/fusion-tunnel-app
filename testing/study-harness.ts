import { v4 as uuidv4 } from 'uuid'
import type { Caps, Role } from '@/schemas/provisioning'
import { FakeBma, type FakeBmaOptions } from '@/testing/fake-bma'
import { FakeRelay, type FakeRelayOptions } from '@/testing/fake-relay'
import { FakeSetupApp } from '@/testing/fake-setup-app'
import { makeOrgKey, startTunnel, type OrgKeypair, type RunningTunnel } from '@/testing/fixtures'
import type { TunnelEndpoint } from '@/testing/rc-client'
import { testBmaKey } from '@/testing/relay-tokens'

// BMA-driven study harness (plan Phase 9): fake relay + fake BMA + one fake Setup App per org, and
// one tunnel per (leg, role) provisioned exactly as production would be — key publication, relay
// session, delegated credential, pinned peer-org key. One leg is the two-party study; several legs
// sharing the destination org are the hub (one destination tunnel per leg, plan §10).

export type LegSpec = {
    legId: string
    sourceOrg: string
    caps?: Caps
    /** Tunnel env overrides for this leg's source / destination. */
    sourceEnv?: Record<string, string>
    destinationEnv?: Record<string, string>
}

export type StudyOptions = {
    studyId?: string
    destinationOrg?: string
    legs: LegSpec[]
    env?: Record<string, string>
    relayOptions?: Partial<FakeRelayOptions>
    bmaOptions?: Partial<FakeBmaOptions>
    launchWindowMs?: number
    /** Skip run-group registration/launch reporting (tests that exercise the group themselves). */
    skipRunGroup?: boolean
}

export type StudyTunnel = RunningTunnel & { role: Role; legId: string; org: string; token: string; jobId: string }

export type StudyLeg = {
    legId: string
    sourceOrg: string
    source: StudyTunnel
    destination: StudyTunnel
}

export type Study = {
    studyId: string
    destinationOrg: string
    relay: FakeRelay
    bma: FakeBma
    orgKeys: Record<string, OrgKeypair>
    setupApps: Record<string, FakeSetupApp>
    legs: StudyLeg[]
    leg(legId: string): StudyLeg
    /** The hub RC's FUSION_TUNNEL_ENDPOINTS map, keyed by legId. */
    hubEndpoints(): Record<string, TunnelEndpoint>
    sourceEndpoint(legId: string): TunnelEndpoint
    relaySessionId(legId: string): string
    waitChannelsUp(timeoutMs?: number): Promise<void>
    /** Stop one tunnel and bring up a re-provisioned replacement (new identity, capsConsumed from the BMA). */
    restart(legId: string, role: Role): Promise<StudyTunnel>
    close(): Promise<void>
}

const TUNNEL_ENV = {
    FUSION_PEERKEY_POLL_MS: '50',
    FUSION_STATUS_INTERVAL_MS: '500',
    FUSION_HANDSHAKE_RETRY_MS: '50',
    FUSION_LONGPOLL_MS: '150',
}

export const startStudy = async (options: StudyOptions): Promise<Study> => {
    const studyId = options.studyId ?? `study-${uuidv4()}`
    const destinationOrg = options.destinationOrg ?? 'si-hub'
    const orgs = [destinationOrg, ...options.legs.map((l) => l.sourceOrg)]
    const orgKeys: Record<string, OrgKeypair> = Object.fromEntries(orgs.map((org) => [org, makeOrgKey()]))

    const relay = new FakeRelay({
        bmaPublicKeyPem: testBmaKey().publicPem,
        heartbeatIntervalMs: 5_000,
        ...options.relayOptions,
    })
    await relay.start()
    const bma = new FakeBma({
        relayEndpoint: relay.wsUrl,
        orgs: Object.fromEntries(orgs.map((org) => [org, orgKeys[org].pem])),
        ...options.bmaOptions,
    })
    await bma.start()
    const setupApps: Record<string, FakeSetupApp> = Object.fromEntries(
        orgs.map((org) => [org, new FakeSetupApp(org, orgKeys[org], bma.url)]),
    )

    if (!options.skipRunGroup) {
        bma.registerRun(
            studyId,
            options.legs.map((leg) => ({
                legId: leg.legId,
                sourceOrgSlug: leg.sourceOrg,
                destinationOrgSlug: destinationOrg,
                sourceJobId: `job-${leg.sourceOrg}`,
                destinationJobId: `job-${destinationOrg}`,
            })),
            options.launchWindowMs,
        )
        for (const leg of options.legs) {
            bma.setEligible(studyId, leg.legId, 'source')
            bma.setEligible(studyId, leg.legId, 'destination')
        }
    }

    const provision = async (leg: LegSpec, role: Role, capsFromBma = false): Promise<StudyTunnel> => {
        const org = role === 'source' ? leg.sourceOrg : destinationOrg
        const peerOrg = role === 'source' ? destinationOrg : leg.sourceOrg
        const running = await startTunnel({
            env: { ...TUNNEL_ENV, ...options.env, ...(role === 'source' ? leg.sourceEnv : leg.destinationEnv) },
            deps: { bma: {} },
        })
        const token = `token-${leg.legId}-${role}-${uuidv4()}`
        const jobId = `job-${org}`
        const result = await setupApps[org].provision(running.baseUrl, {
            studyId,
            jobId,
            legId: leg.legId,
            role,
            peerOrgSlug: peerOrg,
            peerOrgPublicKeyPem: orgKeys[peerOrg].pem,
            localApiToken: token,
            caps: role === 'source' ? leg.caps : undefined,
            capsConsumed: role === 'source' && capsFromBma ? 'bma' : undefined,
        })
        if (result.configureStatus !== 200) throw new Error(`configure returned ${result.configureStatus}`)
        if (!options.skipRunGroup) await setupApps[org].reportLaunch(studyId, leg.legId, role)
        return { ...running, role, legId: leg.legId, org, token, jobId }
    }

    const legs: StudyLeg[] = []
    for (const spec of options.legs) {
        const source = await provision(spec, 'source')
        const destination = await provision(spec, 'destination')
        legs.push({ legId: spec.legId, sourceOrg: spec.sourceOrg, source, destination })
    }

    const study: Study = {
        studyId,
        destinationOrg,
        relay,
        bma,
        orgKeys,
        setupApps,
        legs,
        leg: (legId) => {
            const found = legs.find((l) => l.legId === legId)
            if (!found) throw new Error(`unknown leg ${legId}`)
            return found
        },
        hubEndpoints: () =>
            Object.fromEntries(legs.map((l) => [l.legId, { url: l.destination.baseUrl, token: l.destination.token }])),
        sourceEndpoint: (legId) => {
            const l = study.leg(legId)
            return { url: l.source.baseUrl, token: l.source.token }
        },
        relaySessionId: (legId) => bma.sessionFor(studyId, legId).relaySessionId,
        waitChannelsUp: async (timeoutMs = 15_000) => {
            await Promise.all(
                legs.flatMap((l) => [
                    l.source.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs }),
                    l.destination.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs }),
                ]),
            )
            for (const l of legs) {
                for (const side of [l.source, l.destination]) {
                    if (side.tunnel.lifecycle.state !== 'CHANNEL_UP') {
                        throw new Error(`${l.legId} ${side.role} ended in ${side.tunnel.lifecycle.state}`)
                    }
                }
            }
        },
        restart: async (legId, role) => {
            const l = study.leg(legId)
            const spec = options.legs.find((s) => s.legId === legId)!
            const old = role === 'source' ? l.source : l.destination
            const survivor = role === 'source' ? l.destination : l.source
            old.tunnel.stop()
            await old.close()
            const next = await provision(spec, role, role === 'source')
            if (role === 'source') l.source = next
            else l.destination = next
            await next.tunnel.lifecycle.waitFor('CHANNEL_UP', { timeoutMs: 15_000 })
            const deadline = Date.now() + 15_000
            while (
                survivor.tunnel.lifecycle.state !== 'CHANNEL_UP' ||
                survivor.tunnel.channel?.verifiedPeer?.connectionId !== next.tunnel.identity.connectionId
            ) {
                if (Date.now() > deadline) throw new Error('survivor did not re-handshake in time')
                await new Promise((r) => setTimeout(r, 20))
            }
            return next
        },
        close: async () => {
            for (const l of legs) {
                for (const side of [l.source, l.destination]) {
                    side.tunnel.stop()
                    await side.close()
                }
            }
            await bma.stop()
            await relay.stop()
        },
    }
    return study
}
