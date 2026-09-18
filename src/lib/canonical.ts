// Deterministic JSON: object keys sorted recursively, arrays in order. Used wherever two JSON
// values must compare or hash equal regardless of construction order (idempotent configure).
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value))

const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const inner = (value as Record<string, unknown>)[key]
            if (inner !== undefined) out[key] = sortKeys(inner)
        }
        return out
    }
    return value
}
