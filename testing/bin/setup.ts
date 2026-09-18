import { FakeSetupApp } from '@/testing/fake-setup-app'
import { makeOrgKey } from '@/testing/fixtures'
import { env, envJson, waitForHttp } from './env'

// Compose entrypoint standing in for every enclave's Setup App at once: generates an org key per
// org, registers it with the fake BMA, provisions each tunnel over its enclave-local API, and
// reports launches so the run group pairs. In production each enclave runs its own Setup App and
// holds its own org key; one container plays them all here because compose is one host.

type Leg = {
    legId: string
    sourceOrg: string
    destinationOrg: string
    sourceTunnelUrl: string
    destinationTunnelUrl: string
    sourceToken: string
    destinationToken: string
    caps?: Record<string, number>
}

const main = async () => {
    const bmaUrl = env('BMA_URL')
    const studyId = env('STUDY_ID', 'study-compose')
    const legs = envJson<Leg[]>('SETUP_LEGS')
    await waitForHttp(`${bmaUrl}/api/health`)

    const orgs = new Set(legs.flatMap((l) => [l.sourceOrg, l.destinationOrg]))
    const keys = new Map<string, ReturnType<typeof makeOrgKey>>()
    const apps = new Map<string, FakeSetupApp>()
    for (const org of orgs) {
        const key = makeOrgKey()
        keys.set(org, key)
        const res = await fetch(`${bmaUrl}/api/orgs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slug: org, pem: key.pem }),
        })
        if (res.status !== 201) throw new Error(`register org ${org}: ${res.status}`)
        apps.set(org, new FakeSetupApp(org, key, bmaUrl))
    }

    for (const leg of legs) {
        await waitForHttp(`${leg.sourceTunnelUrl}/health`)
        await waitForHttp(`${leg.destinationTunnelUrl}/health`)
        const source = await apps.get(leg.sourceOrg)!.provision(leg.sourceTunnelUrl, {
            studyId,
            jobId: `job-${leg.sourceOrg}`,
            legId: leg.legId,
            role: 'source',
            peerOrgSlug: leg.destinationOrg,
            peerOrgPublicKeyPem: keys.get(leg.destinationOrg)!.pem,
            localApiToken: leg.sourceToken,
            caps: leg.caps,
        })
        const destination = await apps.get(leg.destinationOrg)!.provision(leg.destinationTunnelUrl, {
            studyId,
            jobId: `job-${leg.destinationOrg}`,
            legId: leg.legId,
            role: 'destination',
            peerOrgSlug: leg.sourceOrg,
            peerOrgPublicKeyPem: keys.get(leg.sourceOrg)!.pem,
            localApiToken: leg.destinationToken,
        })
        console.log(
            JSON.stringify({
                event: 'setup.provisioned',
                legId: leg.legId,
                source: source.configureStatus,
                destination: destination.configureStatus,
                generation: source.generation,
            }),
        )
        if (source.configureStatus !== 200 || destination.configureStatus !== 200)
            throw new Error(`configure failed on ${leg.legId}`)
    }
    console.log(JSON.stringify({ event: 'setup.done', legs: legs.length }))
}

void main().catch((error) => {
    console.error(error)
    process.exit(1)
})
