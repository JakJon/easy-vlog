import { useEffect, useState } from 'react'
import { subscribeDiagLog, type DiagLogEntry } from '../lib/diagLog'

export function AudioLogPanel() {
  const [entries, setEntries] = useState<DiagLogEntry[]>([])
  const [copied, setCopied] = useState(false)

  useEffect(() => subscribeDiagLog(setEntries), [])

  if (entries.length === 0) return null

  const fmt = (e: DiagLogEntry) => {
    const t = new Date(e.timestamp).toISOString().slice(11, 23) // HH:MM:SS.mmm
    const body = e.details ? `${e.message}\n    ${e.details.replace(/\n/g, '\n    ')}` : e.message
    return `[${t}] ${e.level.toUpperCase().padEnd(5)} ${body}`
  }
  const asText = entries.map(fmt).join('\n')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = asText
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } finally {
        document.body.removeChild(ta)
      }
    }
  }

  return (
    <details
      className="mt-4 rounded-2xl border border-neutral-200 bg-white px-4 py-3"
      open
    >
      <summary className="cursor-pointer text-sm font-medium text-neutral-600">
        Runtime log ({entries.length} {entries.length === 1 ? 'entry' : 'entries'})
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={copy}
          className="self-start rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy log'}
        </button>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-50 p-3 text-[11px] leading-tight text-neutral-700 select-all">
          {asText}
        </pre>
      </div>
    </details>
  )
}
