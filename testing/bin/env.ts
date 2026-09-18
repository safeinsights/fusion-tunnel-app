// Small helpers shared by the compose entrypoints.
export const env = (name: string, fallback?: string): string => {
    const value = process.env[name]
    if (value === undefined || value === '') {
        if (fallback !== undefined) return fallback
        throw new Error(`missing env ${name}`)
    }
    return value
}

export const envJson = <T>(name: string, fallback?: T): T => {
    const raw = process.env[name]
    if (!raw) {
        if (fallback !== undefined) return fallback
        throw new Error(`missing env ${name}`)
    }
    return JSON.parse(raw) as T
}

export const waitForHttp = async (url: string, timeoutMs = 120_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
            if (res.ok) return
        } catch {
            // not up yet
        }
        if (Date.now() > deadline) throw new Error(`${url} not reachable within ${timeoutMs} ms`)
        await new Promise((r) => setTimeout(r, 500))
    }
}
