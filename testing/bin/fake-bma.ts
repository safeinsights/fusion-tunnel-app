import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { FakeBma } from '@/testing/fake-bma'
import type { BmaKeypair } from '@/testing/relay-tokens'
import { env } from './env'

// Compose entrypoint: the in-repo fake BMA. Org keys are registered at runtime by the fake Setup
// App. With BMA_RELAY_PRIVATE_KEY_FILE the relay-token signing key is injected instead of generated,
// so tokens verify against the public key a real relay was deployed with. Every event is one JSON
// line so a run can be audited from the container log; nothing logged here can carry payload content.

const loadKey = (path: string): BmaKeypair => {
    const privateKey = createPrivateKey(readFileSync(path, 'utf8'))
    const publicKey = createPublicKey(privateKey)
    return { privateKey, publicKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string }
}

const line = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))

const main = async () => {
    const keyFile = process.env.BMA_RELAY_PRIVATE_KEY_FILE
    const bma = new FakeBma({
        ...(keyFile ? { key: loadKey(keyFile) } : {}),
        relayEndpoint: env('RELAY_WS_URL'),
        relayTokenTtlS: Number(env('RELAY_TOKEN_TTL_S', '900')),
        host: env('HOST', '127.0.0.1'),
    })
    bma.on('keyPublished', (row) =>
        line('bma.key_published', {
            orgSlug: row.orgSlug,
            studyId: row.studyId,
            legId: row.legId,
            generation: row.generation,
            connectionId: row.connectionId,
            fingerprint: row.fingerprint,
        }),
    )
    bma.on('peerKeyServed', (legId, forOrg, generation) => line('bma.peer_key_served', { legId, forOrg, generation }))
    bma.on('relaySessionIssued', (legId, role, caller) => line('bma.relay_session_issued', { legId, role, caller }))
    bma.on('credentialIssued', (legId, role) => line('bma.credential_issued', { legId, role }))
    bma.on('statusReceived', (r) =>
        line('bma.status_received', {
            legId: r.legId,
            orgSlug: r.orgSlug,
            role: r.role,
            state: r.state,
            relayAdmitted: r.relayAdmitted,
            reason: r.reason,
            roundsCompleted: r.roundsCompleted,
            messagesSent: r.messagesSent,
            messagesReceived: r.messagesReceived,
            ownGeneration: r.ownGeneration,
            peerGeneration: r.peerGeneration,
            terminal: r.terminal?.code,
        }),
    )
    bma.on('unauthorized', (path, reason) => line('bma.unauthorized', { path, reason }))
    const url = await bma.start(Number(env('PORT', '4500')))
    line('fake-bma.listening', {
        url,
        relayEndpoint: env('RELAY_WS_URL'),
        publicKeyPrefix: bma.key.publicPem.split('\n')[1]?.slice(0, 24),
    })
    const stop = () => void bma.stop().then(() => process.exit(0))
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
}

void main().catch((error) => {
    console.error(error)
    process.exit(1)
})
