import { useState } from 'react'
import type { SortDiagnosticRow } from '../lib/metadata'

interface Props {
  rows: SortDiagnosticRow[]
}

export function DiagnosticsPanel({ rows }: Props) {
  const [copied, setCopied] = useState(false)

  const asText = rows
    .map((r) => {
      const sizeMB = (r.sizeBytes / (1024 * 1024)).toFixed(1).padStart(6) + ' MB'
      return `${String(r.order).padStart(2, '0')}  ${r.kind.padEnd(5)}  ${r.source.padEnd(16)}  ${sizeMB}  ${r.iso}  ${r.name}`
    })
    .join('\n')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Older mobile browsers: fall back to a hidden textarea + execCommand.
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
    <details className="mt-8 rounded-2xl border border-neutral-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-neutral-600">
        Sort diagnostics ({rows.length} files)
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={copy}
          className="self-start rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy table'}
        </button>
        <pre className="overflow-x-auto whitespace-pre rounded-lg bg-neutral-50 p-3 text-[11px] leading-tight text-neutral-700 select-all">
{`order  kind   source            size       iso                       name
${asText}`}
        </pre>
      </div>
    </details>
  )
}
