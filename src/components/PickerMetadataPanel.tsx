import { useState } from 'react'
import type { PickerMetadata } from '../lib/googlePhotosPicker'

interface Props {
  items: PickerMetadata[]
  matchedCount?: number
}

export function PickerMetadataPanel({ items, matchedCount }: Props) {
  const [copied, setCopied] = useState(false)

  const asText = items
    .map(
      (m) =>
        `${m.kind.padEnd(5)}  ${new Date(m.timestamp).toISOString()}  ${m.filename}`,
    )
    .join('\n')

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

  const summary =
    matchedCount != null
      ? `Google Photos metadata (${items.length} item${items.length === 1 ? '' : 's'}, ${matchedCount} matched)`
      : `Google Photos metadata (${items.length} item${items.length === 1 ? '' : 's'})`

  return (
    <details className="mt-4 rounded-2xl border border-neutral-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-neutral-600">
        {summary}
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
{`kind   iso                       filename
${asText}`}
        </pre>
      </div>
    </details>
  )
}
