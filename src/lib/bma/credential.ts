import jwt from 'jsonwebtoken'

// The tunnel only carries BMA-issued JWTs (relay token, delegated credential) and reads `exp`
// to schedule refreshes ahead of expiry; it never verifies them (v2 §4.1 implementation notes).

export const tokenExpiryMs = (token: string): number | undefined => {
    const decoded = jwt.decode(token)
    if (!decoded || typeof decoded !== 'object' || typeof decoded.exp !== 'number') return undefined
    return decoded.exp * 1000
}

/**
 * Milliseconds until a refresh should fire: `lead` before expiry, never less than `minDelay`
 * (so a token already inside its lead window is refreshed soon but not in a hot loop).
 */
export const refreshDelayMs = (token: string, nowMs: number, leadMs: number, minDelayMs = 1000): number | undefined => {
    const expiry = tokenExpiryMs(token)
    if (expiry === undefined) return undefined
    return Math.max(minDelayMs, expiry - leadMs - nowMs)
}
