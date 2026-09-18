// Waiter registry for the two long-poll routes. A route first checks whether a value is already
// available, then waits here; delivery resolves every waiter registered under the key. Both
// steps are synchronous relative to each other, so nothing can slip between check and wait.

type Waiter<T> = {
    resolve: (value: T | undefined) => void
    timer: NodeJS.Timeout
}

export class LongPoll<T> {
    private readonly waiters = new Map<string, Set<Waiter<T>>>()

    /** Hold until a value arrives for `key` or `holdMs` elapses (resolving undefined). */
    wait(key: string, holdMs: number): Promise<T | undefined> {
        return new Promise((resolve) => {
            const waiter: Waiter<T> = {
                resolve,
                timer: setTimeout(() => {
                    this.remove(key, waiter)
                    resolve(undefined)
                }, holdMs),
            }
            waiter.timer.unref()
            let set = this.waiters.get(key)
            if (!set) {
                set = new Set()
                this.waiters.set(key, set)
            }
            set.add(waiter)
        })
    }

    /** Wake every waiter on `key` with `value`; returns how many were woken. */
    resolve(key: string, value: T | undefined): number {
        const set = this.waiters.get(key)
        if (!set) return 0
        this.waiters.delete(key)
        for (const waiter of set) {
            clearTimeout(waiter.timer)
            waiter.resolve(value)
        }
        return set.size
    }

    /** Wake every waiter on every key — used when the session reaches a terminal state. */
    resolveAll(value: T | undefined): number {
        let woken = 0
        for (const key of [...this.waiters.keys()]) woken += this.resolve(key, value)
        return woken
    }

    pending(key?: string): number {
        if (key !== undefined) return this.waiters.get(key)?.size ?? 0
        let total = 0
        for (const set of this.waiters.values()) total += set.size
        return total
    }

    private remove(key: string, waiter: Waiter<T>): void {
        const set = this.waiters.get(key)
        if (!set) return
        set.delete(waiter)
        if (set.size === 0) this.waiters.delete(key)
    }
}
