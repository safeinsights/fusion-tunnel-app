import type { z } from 'zod'
import { apiError } from '@/http/errors'

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response }

/** Parse and validate a JSON body; failures answer 400 with issue paths only (content-free). */
export const parseJsonBody = async <T>(req: Request, schema: z.ZodType<T>): Promise<Parsed<T>> => {
    let raw: unknown
    try {
        const text = await req.text()
        raw = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
        return { ok: false, response: apiError(400, 'VALIDATION', 'request body is not valid JSON') }
    }
    const result = schema.safeParse(raw)
    if (!result.success) {
        return {
            ok: false,
            response: apiError(400, 'VALIDATION', 'request body failed validation', {
                issues: result.error.issues.map((issue) => ({
                    path: issue.path.map((segment) => String(segment)).join('.'),
                    message: issue.message,
                })),
            }),
        }
    }
    return { ok: true, data: result.data }
}
