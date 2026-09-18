import { createApp, type App } from '@/app'
import { loadConfig } from '@/config'
import { log } from '@/lib/logger'

export const main = (): App => {
    const config = loadConfig()
    const app = createApp(config)
    app.server.listen(config.port, () => {
        const address = app.server.address()
        const port = typeof address === 'object' && address ? address.port : config.port
        log.info('tunnel.listening', { port })
    })
    return app
}

// Tests import createApp directly; only a real process boots here.
export const app: App | undefined = process.env.NODE_ENV !== 'test' ? main() : undefined
