// Event-level, content-free structured logging (v2 §12). Field values are restricted to
// scalars so a payload object can never be logged by accident; anything that needs to be
// traced across the three parties' logs goes in as a `messageId` / `correlationId` string.
export type LogScalar = string | number | boolean | null
export type LogFields = Record<string, LogScalar | undefined>
export type LogLevel = 'info' | 'warn' | 'error'

export type LogSink = (line: string, level: LogLevel) => void

const defaultSink: LogSink = (line, level) => {
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
}

let sink: LogSink = defaultSink

export const setLogSink = (next: LogSink | null): void => {
    sink = next ?? defaultSink
}

const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const record: Record<string, LogScalar> = { ts: new Date().toISOString(), level, event }
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue
        record[key] = value
    }
    sink(JSON.stringify(record), level)
}

export const log = {
    info: (event: string, fields?: LogFields) => write('info', event, fields),
    warn: (event: string, fields?: LogFields) => write('warn', event, fields),
    error: (event: string, fields?: LogFields) => write('error', event, fields),
}

// Errors are logged by name and message only; stacks may embed request data.
export const errorFields = (error: unknown): LogFields => {
    if (error instanceof Error) return { errorName: error.name, errorMessage: error.message }
    return { errorMessage: String(error) }
}
