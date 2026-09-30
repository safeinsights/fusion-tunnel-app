import { DestinationRc, SourceRc, type TunnelEndpoint } from '@/testing/rc-client'
import { env, envJson } from './env'

// Compose entrypoint for a scripted research container, honoring the env contract the Setup App
// launchers use (SDK ask S1): FUSION_ROLE, and either FUSION_TUNNEL_ENDPOINT + FUSION_TUNNEL_TOKEN
// (one leg) or the FUSION_TUNNEL_ENDPOINTS + FUSION_TUNNEL_TOKENS JSON maps keyed by leg label.

const endpoints = (): Record<string, TunnelEndpoint> => {
    const single = process.env.FUSION_TUNNEL_ENDPOINT
    if (single) return { default: { url: single, token: env('FUSION_TUNNEL_TOKEN') } }
    const urls = envJson<Record<string, string>>('FUSION_TUNNEL_ENDPOINTS')
    const tokens = envJson<Record<string, string>>('FUSION_TUNNEL_TOKENS')
    return Object.fromEntries(Object.entries(urls).map(([label, url]) => [label, { url, token: tokens[label] }]))
}

const main = async () => {
    const role = env('FUSION_ROLE')
    const readinessTimeoutMs = Number(env('RC_READINESS_TIMEOUT_MS', '180000'))
    if (role === 'source') {
        const [endpoint] = Object.values(endpoints())
        const marker = env('RC_MARKER', 'source')
        const rc = new SourceRc(
            endpoint,
            (payload) => {
                const q = payload as { op?: string; ids?: string[] }
                if (q.op === 'ids') return { marker, ids: ['1', '2', '3'].map((i) => `${marker}-${i}`) }
                return { marker, n: q.ids?.length ?? 0 }
            },
            { readinessTimeoutMs },
        )
        const outcome = await rc.serve()
        console.log(JSON.stringify({ event: 'rc.source.done', outcome, served: rc.served.length }))
        return
    }
    const rounds = Number(env('RC_ROUNDS', '4'))
    const hub = await DestinationRc.connect(endpoints(), { readinessTimeoutMs })
    const peers = [...hub.peers.keys()]
    let ids: string[] = []
    for (let round = 0; round < rounds; round++) {
        const peer = peers[round % peers.length]
        const answer = await hub.request(peer, round === 0 ? { op: 'ids' } : { op: 'count', ids })
        const body = answer.payload as { ids?: string[]; n?: number }
        if (body.ids) ids = body.ids
        console.log(JSON.stringify({ event: 'rc.round', round, peer, budget: answer.budget ?? null }))
    }
    const completed = await hub.complete()
    console.log(JSON.stringify({ event: 'rc.destination.done', completed }))
}

void main().catch((error) => {
    console.error(error)
    process.exit(1)
})
