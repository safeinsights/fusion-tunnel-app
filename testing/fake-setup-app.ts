import jwt from 'jsonwebtoken'
import {
    CapsConsumedSchema,
    IdentityResponseSchema,
    type Caps,
    type CapsConsumed,
    type ConfigurationBundle,
    type Guards,
    type Operation,
    type Role,
} from '@/schemas/provisioning'
import { PublishKeyResponseSchema, RelaySessionResponseSchema, signKeyBlob } from '@/schemas/bma'
import { ORG_JWT_AUDIENCE } from '@/testing/fake-bma'
import type { OrgKeypair } from '@/testing/fixtures'

// The harness's Setup App: holder of the org private key, it performs every org-authenticated
// provisioning step on a tunnel's behalf (v2 §4.4, sequence phase 2): read the fresh public keys,
// sign and publish the key blob, obtain the relay session + delegated credential, and deliver the
// configuration bundle with the pinned peer-org key from the "approved study configuration".

export type ProvisionRequest = {
    studyId: string
    jobId: string
    legId: string
    role: Role
    peerOrgSlug: string
    /** Pinned from the approved study configuration — never fetched from the BMA. */
    peerOrgPublicKeyPem: string
    localApiToken: string
    caps?: Caps
    guards?: Guards
    operations?: Operation[]
    /** 'bma' re-seeds from the BMA's last status report (re-provision); an object seeds explicitly. */
    capsConsumed?: CapsConsumed | 'bma'
}

export type ProvisionResult = { bundle: ConfigurationBundle; generation: number; configureStatus: number }

export class FakeSetupApp {
    constructor(
        readonly orgSlug: string,
        private readonly orgKey: OrgKeypair,
        private readonly bmaUrl: string,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    orgJwt(): string {
        return jwt.sign({ iss: this.orgSlug, aud: ORG_JWT_AUDIENCE }, this.orgKey.privateKey, {
            algorithm: 'RS256',
            expiresIn: 60,
        })
    }

    async provision(tunnelUrl: string, request: ProvisionRequest): Promise<ProvisionResult> {
        // 1. the tunnel's freshly generated public keys
        const identityRes = await this.fetchImpl(`${tunnelUrl}/local/identity`)
        if (identityRes.status !== 200) throw new Error(`identity: ${identityRes.status}`)
        const identity = IdentityResponseSchema.parse(await identityRes.json())
        const publicKey = Buffer.from(identity.publicKey, 'base64url')
        const popKey = Buffer.from(identity.popKey, 'base64url')

        // 2. sign with the org key (domain-separated) and publish; the directory assigns the generation
        const keySignature = signKeyBlob(this.orgKey.privateKey, {
            studyId: request.studyId,
            jobId: request.jobId,
            legId: request.legId,
            connectionId: identity.connectionId,
            publicKey,
            popKey,
        }).toString('base64url')
        const published = await this.bma('PUT', '/tunnel/keys', {
            studyId: request.studyId,
            jobId: request.jobId,
            legId: request.legId,
            ...identity,
            keySignature,
        })
        if (published.status !== 201) throw new Error(`publish key: ${published.status} ${await published.text()}`)
        const { generation } = PublishKeyResponseSchema.parse(await published.json())

        // 3. relay session, token, nonce and the delegated credential
        const params = new URLSearchParams({
            legId: request.legId,
            studyId: request.studyId,
            jobId: request.jobId,
            role: request.role,
            peerOrgSlug: request.peerOrgSlug,
        })
        const sessionRes = await this.bma('GET', `/tunnel/relay-session?${params}`)
        if (sessionRes.status !== 200) throw new Error(`relay-session: ${sessionRes.status} ${await sessionRes.text()}`)
        const session = RelaySessionResponseSchema.parse(await sessionRes.json())
        if (!session.credential) throw new Error('relay-session did not include the delegated credential')

        // 4. cumulative counters from the BMA's last status report on a re-provision
        let capsConsumed = request.capsConsumed === 'bma' ? undefined : request.capsConsumed
        if (request.capsConsumed === 'bma') {
            const consumedRes = await this.bma(
                'GET',
                `/tunnel/consumed?studyId=${request.studyId}&legId=${request.legId}`,
            )
            if (consumedRes.status === 200) capsConsumed = CapsConsumedSchema.parse(await consumedRes.json())
        }

        // 5. the bundle, with the pinned peer-org key from the approved study configuration
        const bundle: ConfigurationBundle = {
            studyId: request.studyId,
            jobId: request.jobId,
            legId: request.legId,
            role: request.role,
            direction: session.direction,
            orgSlug: this.orgSlug,
            peerOrgSlug: request.peerOrgSlug,
            keyGeneration: generation,
            relay: { endpoint: session.relayEndpoint, sessionId: session.relaySessionId, token: session.relayToken },
            bma: { endpoint: this.bmaUrl, credential: session.credential },
            sessionNonce: session.sessionNonce,
            peerOrgPublicKey: request.peerOrgPublicKeyPem,
            localApiToken: request.localApiToken,
            caps: request.caps ?? {},
            ...(capsConsumed ? { capsConsumed } : {}),
            ...(request.guards ? { guards: request.guards } : {}),
            ...(request.operations ? { operations: request.operations } : {}),
        }
        const configured = await this.fetchImpl(`${tunnelUrl}/local/configure`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(bundle),
        })
        return { bundle, generation, configureStatus: configured.status }
    }

    async reportLaunch(studyId: string, legId: string, role: Role): Promise<number> {
        const res = await this.bma('POST', '/tunnel/runs/launched', { studyId, legId, role })
        return res.status
    }

    async visibleRuns(): Promise<unknown> {
        const res = await this.bma('GET', '/tunnel/runs')
        return res.json()
    }

    private bma(method: string, path: string, body?: unknown): Promise<Response> {
        return this.fetchImpl(`${this.bmaUrl}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${this.orgJwt()}`,
                accept: 'application/json',
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        })
    }
}
