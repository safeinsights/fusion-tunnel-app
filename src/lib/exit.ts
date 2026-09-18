import { close } from '@/http/server'
import { TERMINAL_STATES, type TunnelState } from '@/lib/lifecycle'
import { log } from '@/lib/logger'
import type { Tunnel } from '@/tunnel'

// Exit codes are a contract with the Setup App (plan Phase 8, §10): 0 on CLOSED, non-zero on the
// failure states. In the hub's multi-sidecar task the Setup App stops the whole task once every
// leg's tunnel has exited, and a non-zero exit on any leg marks the run failed — nothing restarts,
// because restarting from round 1 would re-consume the sources' caps.

export const EXIT_CODES = {
    CLOSED: 0,
    ERRORED: 1,
    LIMIT_EXCEEDED: 2,
} as const

export type TerminalState = keyof typeof EXIT_CODES

export const exitCodeFor = (state: TunnelState): number | undefined =>
    state in EXIT_CODES ? EXIT_CODES[state as TerminalState] : undefined

export type ExitPolicyOptions = {
    exit: (code: number) => void
    /** Keep the local API up this long after the terminal state so the RC can read the terminal body. */
    graceMs: number
    /** How long to wait for the terminal status report before giving up on it. */
    reportTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
}

export type ExitPolicy = {
    /** Graceful stop on SIGTERM/SIGINT: a shutdown status report, then exit 0. */
    shutdown(signal: string): Promise<void>
    uninstall(): void
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

export const installExitPolicy = (tunnel: Tunnel, options: ExitPolicyOptions): ExitPolicy => {
    const sleep = options.sleep ?? defaultSleep
    let exiting = false

    const finish = async (code: number, reason: string): Promise<void> => {
        if (exiting) return
        exiting = true
        log.info('tunnel.exiting', { code, reason, state: tunnel.lifecycle.state })
        // Let the terminal status report leave first (the BMA client sends it on the transition).
        const reported = tunnel.bma?.terminalReported()
        if (reported) await Promise.race([reported, sleep(options.reportTimeoutMs ?? 5_000)])
        await sleep(options.graceMs)
        tunnel.stop()
        await close(tunnel.server).catch(() => undefined)
        options.exit(code)
    }

    const off = tunnel.lifecycle.onTransition((transition) => {
        if (!TERMINAL_STATES.has(transition.to)) return
        void finish(exitCodeFor(transition.to) ?? EXIT_CODES.ERRORED, transition.reason)
    })

    return {
        async shutdown(signal) {
            if (exiting) return
            exiting = true
            log.info('tunnel.shutdown', { signal, state: tunnel.lifecycle.state })
            await tunnel.bma?.report('shutdown').catch(() => undefined)
            tunnel.stop()
            await close(tunnel.server).catch(() => undefined)
            options.exit(0)
        },
        uninstall: off,
    }
}
