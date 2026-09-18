import { EventEmitter } from 'node:events'

// The tunnel state machine (plan Phase 2). Every route and background loop keys off this.
export const STATES = [
    'AWAITING_CONFIG',
    'CONFIGURED',
    'PEER_KEY_VERIFIED',
    'RELAY_ATTACHED',
    'CHANNEL_UP',
    'CLOSING',
    'CLOSED',
    'ERRORED',
    'LIMIT_EXCEEDED',
] as const

export type TunnelState = (typeof STATES)[number]
export type TerminalCode = 'STUDY_COMPLETE' | 'SESSION_ERRORED' | 'LIMIT_EXCEEDED'

export const TERMINAL_STATES: ReadonlySet<TunnelState> = new Set<TunnelState>(['CLOSED', 'ERRORED', 'LIMIT_EXCEEDED'])

// CHANNEL_UP -> RELAY_ATTACHED is the re-handshake path: the peer rejoined with a new identity
// (or our own socket came back to a peer that did), so the channel is down while the relay
// attachment stands; the peer key is re-fetched and Noise_IK re-run from there.
const TRANSITIONS: Readonly<Record<TunnelState, readonly TunnelState[]>> = {
    AWAITING_CONFIG: ['CONFIGURED', 'ERRORED'],
    CONFIGURED: ['PEER_KEY_VERIFIED', 'ERRORED', 'LIMIT_EXCEEDED'],
    PEER_KEY_VERIFIED: ['RELAY_ATTACHED', 'ERRORED', 'LIMIT_EXCEEDED'],
    RELAY_ATTACHED: ['CHANNEL_UP', 'ERRORED', 'LIMIT_EXCEEDED'],
    CHANNEL_UP: ['RELAY_ATTACHED', 'CLOSING', 'ERRORED', 'LIMIT_EXCEEDED'],
    CLOSING: ['CLOSED', 'ERRORED'],
    CLOSED: [],
    ERRORED: [],
    LIMIT_EXCEEDED: [],
}

export type Transition = { from: TunnelState; to: TunnelState; reason: string; at: Date }

export class IllegalTransitionError extends Error {
    constructor(
        readonly from: TunnelState,
        readonly to: TunnelState,
    ) {
        super(`illegal lifecycle transition ${from} -> ${to}`)
        this.name = 'IllegalTransitionError'
    }
}

export class LifecycleTimeoutError extends Error {
    constructor(state: TunnelState, timeoutMs: number) {
        super(`timed out after ${timeoutMs} ms waiting for lifecycle state ${state}`)
        this.name = 'LifecycleTimeoutError'
    }
}

export class Lifecycle {
    private current: TunnelState = 'AWAITING_CONFIG'
    private readonly emitter = new EventEmitter()
    private readonly transitions: Transition[] = []

    constructor(private readonly now: () => Date = () => new Date()) {
        this.emitter.setMaxListeners(0)
    }

    get state(): TunnelState {
        return this.current
    }

    get history(): readonly Transition[] {
        return this.transitions
    }

    is(...states: TunnelState[]): boolean {
        return states.includes(this.current)
    }

    isTerminal(): boolean {
        return TERMINAL_STATES.has(this.current)
    }

    canTransition(to: TunnelState): boolean {
        return TRANSITIONS[this.current].includes(to)
    }

    transition(to: TunnelState, reason: string): Transition {
        if (!this.canTransition(to)) throw new IllegalTransitionError(this.current, to)
        const transition: Transition = { from: this.current, to, reason, at: this.now() }
        this.current = to
        this.transitions.push(transition)
        this.emitter.emit('transition', transition)
        return transition
    }

    /** Enter a terminal failure state from any non-terminal state; a no-op once terminal. */
    fail(to: 'ERRORED' | 'LIMIT_EXCEEDED', reason: string): Transition | undefined {
        if (this.isTerminal()) return undefined
        if (!this.canTransition(to)) return undefined
        return this.transition(to, reason)
    }

    /** The typed code the local API surfaces once the session is ending or ended. */
    terminalCode(): TerminalCode | undefined {
        switch (this.current) {
            case 'CLOSING':
            case 'CLOSED':
                return 'STUDY_COMPLETE'
            case 'ERRORED':
                return 'SESSION_ERRORED'
            case 'LIMIT_EXCEEDED':
                return 'LIMIT_EXCEEDED'
            default:
                return undefined
        }
    }

    onTransition(listener: (transition: Transition) => void): () => void {
        this.emitter.on('transition', listener)
        return () => {
            this.emitter.off('transition', listener)
        }
    }

    /**
     * Resolves with the state reached: the awaited one, or a terminal state that pre-empted it.
     * Rejects with LifecycleTimeoutError if neither arrives in time.
     */
    waitFor(state: TunnelState, opts: { timeoutMs?: number } = {}): Promise<TunnelState> {
        if (this.current === state || this.isTerminal()) return Promise.resolve(this.current)
        return new Promise((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined
            const off = this.onTransition((transition) => {
                if (transition.to !== state && !TERMINAL_STATES.has(transition.to)) return
                off()
                if (timer) clearTimeout(timer)
                resolve(transition.to)
            })
            if (opts.timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    off()
                    reject(new LifecycleTimeoutError(state, opts.timeoutMs!))
                }, opts.timeoutMs)
                timer.unref()
            }
        })
    }
}
