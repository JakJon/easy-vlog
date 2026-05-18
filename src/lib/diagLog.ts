// In-memory diagnostic log surfaced through the in-app DiagnosticsPanel area.
// Used for runtime warnings (esp. WebCodecs / audio decode failures) that need
// to be visible on iOS Safari, where the user can't open a dev console.

export type DiagLogLevel = 'info' | 'warn' | 'error'

export interface DiagLogEntry {
  timestamp: number
  level: DiagLogLevel
  message: string
  details?: string
}

const entries: DiagLogEntry[] = []
const subscribers = new Set<(snapshot: DiagLogEntry[]) => void>()

function detailsOf(detail: unknown): string | undefined {
  if (detail === undefined) return undefined
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export function diagLog(
  level: DiagLogLevel,
  message: string,
  detail?: unknown,
): void {
  const entry: DiagLogEntry = {
    timestamp: Date.now(),
    level,
    message,
    details: detailsOf(detail),
  }
  entries.push(entry)
  // Mirror to console for desktop debugging.
  const consoleArgs = detail === undefined ? [message] : [message, detail]
  if (level === 'error') console.error(...consoleArgs)
  else if (level === 'warn') console.warn(...consoleArgs)
  else console.log(...consoleArgs)
  const snapshot = entries.slice()
  for (const s of subscribers) s(snapshot)
}

export function subscribeDiagLog(
  fn: (snapshot: DiagLogEntry[]) => void,
): () => void {
  subscribers.add(fn)
  fn(entries.slice())
  return () => {
    subscribers.delete(fn)
  }
}

export function clearDiagLog(): void {
  entries.length = 0
  const empty: DiagLogEntry[] = []
  for (const s of subscribers) s(empty)
}
