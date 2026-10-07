import { createPrivateKey, createPublicKey } from 'node:crypto'
import type { Caps, Guards, Operation, Role } from '@/schemas/provisioning'
import { FakeSetupApp } from '@/testing/fake-setup-app'
import type { OrgKeypair } from '@/testing/fixtures'
import { NotReadyError, TerminalError, waitForChannelUp } from '@/testing/rc-client'
import { env, envJson, waitForHttp } from './env'

// One enclave's Setup App stand-in: provisions ONE tunnel for ONE org, leg and role, the way a
// real Setup App would from inside its own enclave. Unlike setup.ts (compose, every org at once) it
// holds only its own org's private key and receives the peer org's public key as the pinned value
// from the "approved study configuration". Intended to run as a one-off task next to the tunnel it
// provisions; the org key and tokens arrive as secrets in the environment.
//
// Exit codes: 0 provisioned (and, with WAIT_FOR_CHANNEL_UP_MS, the leg reached CHANNEL_UP);
// 3 the tunnel already holds a different bundle (409: it needs a fresh task); 1 anything else.

const line = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))

const flag = (name: string, fallback: boolean): boolean => {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return fallback
    if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`)
    return raw === 'true'
}

const loadOrgKey = (pem: string): OrgKeypair => {
    const privateKey = createPrivateKey(pem)
    const publicKey = createPublicKey(privateKey)
    return { privateKey, publicKey, pem: publicKey.export({ type: 'spki', format: 'pem' }) as string }
}

const main = async (): Promise<number> => {
    const bmaUrl = env('BMA_URL')
    const label = env('TUNNEL_LABEL', 'default')
    const tunnelUrl = process.env.TUNNEL_URL || envJson<Record<string, string>>('TUNNEL_URLS')[label]
    if (!tunnelUrl) throw new Error(`TUNNEL_URLS has no entry for label ${label}`)
    const orgSlug = env('ORG_SLUG')
    const orgKey = loadOrgKey(env('ORG_PRIVATE_KEY_PEM'))
    const peerOrgSlug = env('PEER_ORG_SLUG')
    const peerOrgPublicKeyPem = env('PEER_ORG_PUBLIC_KEY_PEM')
    createPublicKey(peerOrgPublicKeyPem) // a malformed pin fails here, not in the tunnel's 400
    const role = env('ROLE')
    if (role !== 'source' && role !== 'destination') throw new Error('ROLE must be source or destination')
    const request = {
        studyId: env('STUDY_ID'),
        jobId: env('JOB_ID'),
        legId: env('LEG_ID'),
        role: role as Role,
        peerOrgSlug,
        peerOrgPublicKeyPem,
        localApiToken: env('LOCAL_API_TOKEN'),
        provisionToken: env('FUSION_PROVISION_TOKEN'),
        caps: envJson<Caps>('CAPS_JSON', {}),
        guards: process.env.GUARDS_JSON ? envJson<Guards>('GUARDS_JSON') : undefined,
        operations: process.env.OPERATIONS_JSON ? envJson<Operation[]>('OPERATIONS_JSON') : undefined,
    }
    const waitForChannelUpMs = Number(env('WAIT_FOR_CHANNEL_UP_MS', '0'))

    await waitForHttp(`${bmaUrl}/api/health`)
    await waitForHttp(`${tunnelUrl}/health`)
    line('setup.ready', { orgSlug, peerOrgSlug, legId: request.legId, role, tunnel: tunnelUrl })

    if (flag('REGISTER_ORG', true)) {
        // Harness-only route of the fake BMA; a real BMA holds the org key from onboarding
        const res = await fetch(`${bmaUrl}/api/orgs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slug: orgSlug, pem: orgKey.pem }),
        })
        if (res.status !== 201) throw new Error(`register org ${orgSlug}: ${res.status} ${await res.text()}`)
        line('setup.org_registered', { orgSlug })
    }

    const app = new FakeSetupApp(orgSlug, orgKey, bmaUrl)
    const { bundle, generation, configureStatus } = await app.provision(tunnelUrl, request)
    line('setup.key_published', { legId: bundle.legId, generation })
    line('setup.relay_session', { relaySessionId: bundle.relay.sessionId, direction: bundle.direction })
    line('setup.configured', { status: configureStatus })
    if (configureStatus === 409) {
        line('setup.tunnel_already_configured', { hint: 'the tunnel holds another study; start a fresh task' })
        return 3
    }
    if (configureStatus !== 200) return 1

    if (flag('CHECK_LOCKED', true)) {
        const res = await fetch(`${tunnelUrl}/v1/info`, {
            headers: { authorization: 'Bearer not-the-local-api-token-0123456789' },
            signal: AbortSignal.timeout(5_000),
        })
        line('setup.local_api_locked', { status: res.status })
        if (res.status !== 401) return 1
    }

    if (waitForChannelUpMs > 0) {
        try {
            const info = await waitForChannelUp(
                { url: tunnelUrl, token: request.localApiToken },
                { readinessTimeoutMs: waitForChannelUpMs },
            )
            line('setup.channel_up', { legId: info.legId, peerOrgSlug: info.peerOrgSlug, state: info.state })
        } catch (error) {
            if (error instanceof TerminalError || error instanceof NotReadyError) {
                line('setup.channel_not_up', { error: error.message })
                return 1
            }
            throw error
        }
    }
    return 0
}

void main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })
