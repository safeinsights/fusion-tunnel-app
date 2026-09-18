import { json } from '@/http/json'
import type { ApiError, ApiErrorCode, TerminalBody } from '@/schemas/local-api'
import type { TerminalCode } from '@/lib/lifecycle'

export const apiError = (
    status: number,
    code: ApiErrorCode,
    message: string,
    extra: Partial<Omit<ApiError['error'], 'code' | 'message'>> = {},
    headers: Record<string, string> = {},
): Response => {
    const body: ApiError = { error: { code, message, ...extra } }
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    })
}

export const notReady = (message: string): Response => apiError(503, 'NOT_READY', message, {}, { 'retry-after': '2' })

export const terminalBody = (code: TerminalCode, message?: string): TerminalBody => ({
    terminal: true,
    code,
    ...(message ? { message } : {}),
})

export const terminal = (code: TerminalCode, status: 200 | 410, message?: string): Response =>
    json(terminalBody(code, message), status)

export const noContent = (): Response => new Response(null, { status: 204 })
