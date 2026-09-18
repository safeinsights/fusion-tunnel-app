import { FakeRelay } from '@/testing/fake-relay'
import { env, waitForHttp } from './env'

// Compose entrypoint: the in-repo fake relay, verifying tokens with the fake BMA's public key.
const main = async () => {
    const bmaUrl = env('BMA_URL')
    await waitForHttp(`${bmaUrl}/api/health`)
    const { pem } = (await (await fetch(`${bmaUrl}/api/public-key`)).json()) as { pem: string }
    const relay = new FakeRelay({
        bmaPublicKeyPem: pem,
        heartbeatIntervalMs: Number(env('HEARTBEAT_INTERVAL_MS', '30000')),
    })
    const { port } = await relay.start(Number(env('PORT', '4400')))
    console.log(JSON.stringify({ event: 'fake-relay.listening', port }))
    const stop = () => void relay.stop().then(() => process.exit(0))
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
}

void main().catch((error) => {
    console.error(error)
    process.exit(1)
})
