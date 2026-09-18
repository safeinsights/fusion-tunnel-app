import { createHash, timingSafeEqual } from 'node:crypto'

// Local-API bearer check (v2 §4.1: network reachability alone grants nothing). Both sides are
// hashed before comparison so the comparison is constant-time regardless of token lengths.

export const bearerFrom = (req: Request): string | undefined => {
    const header = req.headers.get('authorization')
    if (!header) return undefined
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
    return match?.[1]
}

export const tokensMatch = (presented: string, expected: string): boolean => {
    const a = createHash('sha256').update(presented, 'utf8').digest()
    const b = createHash('sha256').update(expected, 'utf8').digest()
    return timingSafeEqual(a, b)
}

export const isAuthorized = (req: Request, expectedToken: string): boolean => {
    const presented = bearerFrom(req)
    return presented !== undefined && tokensMatch(presented, expectedToken)
}
