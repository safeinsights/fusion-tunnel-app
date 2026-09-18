import { FakeBma } from '@/testing/fake-bma'
import { env } from './env'

// Compose entrypoint: the in-repo fake BMA. Org keys are registered at runtime by the fake Setup App.
const main = async () => {
    const bma = new FakeBma({
        relayEndpoint: env('RELAY_WS_URL'),
        relayTokenTtlS: Number(env('RELAY_TOKEN_TTL_S', '900')),
    })
    const url = await bma.start(Number(env('PORT', '4500')))
    console.log(JSON.stringify({ event: 'fake-bma.listening', url }))
    const stop = () => void bma.stop().then(() => process.exit(0))
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
}

void main().catch((error) => {
    console.error(error)
    process.exit(1)
})
