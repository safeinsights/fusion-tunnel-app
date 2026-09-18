import { loadConfig } from '@/config'
import { listen } from '@/http/server'
import { log, errorFields } from '@/lib/logger'
import { createTunnel, type Tunnel } from '@/tunnel'

export const main = (): Tunnel => {
    const config = loadConfig()
    const tunnel = createTunnel(config)
    listen(tunnel.server, config.port)
        .then((port) => log.info('tunnel.listening', { port }))
        .catch((error) => {
            log.error('tunnel.listen_failed', errorFields(error))
            process.exit(1)
        })
    return tunnel
}

// Tests build tunnels through createTunnel; only a real process boots here.
export const tunnel: Tunnel | undefined = process.env.NODE_ENV !== 'test' ? main() : undefined
