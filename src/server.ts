import { ConfigError, loadConfig, PROVISION_TOKEN_ENV } from '@/config'
import { listen } from '@/http'
import { installExitPolicy } from '@/lib/exit'
import { log, errorFields } from '@/lib/logger'
import { createTunnel, type Tunnel } from '@/tunnel'

export const main = (): Tunnel => {
    const config = loadConfig()
    // Without a provisioning token anyone who can reach the port could provision the tunnel first
    // (attacker relay, BMA and pinned peer key); a production tunnel never runs that way.
    if (!config.provisionToken) throw new ConfigError(`${PROVISION_TOKEN_ENV} is required`)
    const tunnel = createTunnel(config)
    // Exit codes are the Setup App's contract: 0 on CLOSED, 1 on ERRORED, 2 on LIMIT_EXCEEDED.
    const policy = installExitPolicy(tunnel, { exit: (code) => process.exit(code), graceMs: config.tuning.exitGraceMs })
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void policy.shutdown(signal))
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
