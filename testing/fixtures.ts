import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { loadConfig } from '@/config'
import { close, listen } from '@/http/server'
import type { ExchangeTransport, OutboundMessage } from '@/lib/exchange'
import type { ConfigurationBundle } from '@/schemas/provisioning'
import { createTunnel, type Tunnel, type TunnelDeps } from '@/tunnel'

export type OrgKeypair = { publicKey: KeyObject; privateKey: KeyObject; pem: string }

export const makeOrgKey = (): OrgKeypair => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    return { ...pair, pem: pair.publicKey.export({ type: 'spki', format: 'pem' }) as string }
}

let sharedOrgKey: OrgKeypair | undefined
/** One RSA org key per test process; generation is slow enough to share. */
export const testOrgKey = (): OrgKeypair => (sharedOrgKey ??= makeOrgKey())

export const LOCAL_API_TOKEN = 'test-local-api-token-0123456789abcdef'

export const makeBundle = (overrides: Partial<ConfigurationBundle> = {}): ConfigurationBundle => ({
    studyId: 'study-1',
    jobId: 'job-1',
    legId: 'leg-a',
    role: 'destination',
    direction: 'dp-a->si-hub',
    orgSlug: 'si-hub',
    peerOrgSlug: 'dp-a',
    keyGeneration: 1,
    relay: { endpoint: 'wss://relay.test/ws', sessionId: 'relay-session-1', token: 'relay-token' },
    bma: { endpoint: 'https://bma.test', credential: 'delegated-credential' },
    sessionNonce: randomBytes(32).toString('base64url'),
    peerOrgPublicKey: testOrgKey().pem,
    localApiToken: LOCAL_API_TOKEN,
    caps: {},
    ...overrides,
})

export class RecordingTransport implements ExchangeTransport {
    readonly sent: OutboundMessage[] = []
    readonly acks: string[] = []
    send(message: OutboundMessage): void {
        this.sent.push(message)
    }
    ack(messageId: string): void {
        this.acks.push(messageId)
    }
}

export type RunningTunnel = { tunnel: Tunnel; baseUrl: string; close: () => Promise<void> }

export const startTunnel = async (
    options: { env?: Record<string, string>; deps?: TunnelDeps } = {},
): Promise<RunningTunnel> => {
    const config = loadConfig({ PORT: '0', FUSION_LONGPOLL_MS: '150', ...options.env })
    // Harness tunnels play the directory themselves unless a test wires a BMA explicitly.
    const tunnel = createTunnel(config, { bma: null, ...options.deps })
    const port = await listen(tunnel.server, 0)
    return { tunnel, baseUrl: `http://127.0.0.1:${port}`, close: () => close(tunnel.server) }
}

/** Walk a configured tunnel through the network phases the test does not exercise. */
export const driveToChannelUp = (tunnel: Tunnel): void => {
    for (const state of ['PEER_KEY_VERIFIED', 'RELAY_ATTACHED', 'CHANNEL_UP'] as const) {
        tunnel.lifecycle.transition(state, 'test harness')
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiResult = { status: number; body: any; headers: Headers }

export const api = (baseUrl: string, token?: string) => {
    const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
    const call = async (method: string, path: string, body?: unknown, rawBody?: string): Promise<ApiResult> => {
        const hasBody = body !== undefined || rawBody !== undefined
        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { ...auth, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
            body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
        })
        const text = await res.text()
        return { status: res.status, body: text.length ? JSON.parse(text) : undefined, headers: res.headers }
    }
    return {
        get: (path: string) => call('GET', path),
        post: (path: string, body?: unknown) => call('POST', path, body),
        postRaw: (path: string, raw: string) => call('POST', path, undefined, raw),
    }
}

export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
