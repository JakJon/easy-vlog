import { useState } from 'react'
import { SmartSortView } from './SmartSortView'
import type { PickerMetadata } from '../lib/googlePhotosPicker'
import type { SortDiagnosticRow } from '../lib/metadata'

interface Props {
  totalCount: number
  unreliableCount: number
  diagnostics: SortDiagnosticRow[]
  lastMatchAttempt: {
    pickerMetadata: PickerMetadata[]
    matchedCount: number
  } | null
  onMatched: (metadata: PickerMetadata[]) => void
  onManualReorder: () => void
  onStitchAnyway: () => void
  onError: (message: string) => void
}

type View = 'options' | 'smart-sort'

export function ReviewScreen({
  totalCount,
  unreliableCount,
  lastMatchAttempt,
  onMatched,
  onManualReorder,
  onStitchAnyway,
  onError,
}: Props) {
  const [view, setView] = useState<View>('options')

  if (view === 'smart-sort') {
    return (
      <SmartSortView
        onBack={() => setView('options')}
        onMatched={onMatched}
        onError={onError}
        lastMatchAttempt={lastMatchAttempt}
      />
    )
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-6 py-8 sm:px-8 sm:py-10">
      <h3 className="text-2xl font-semibold text-neutral-900 text-center">
        Hmm...
      </h3>
      <p className="mt-3 text-sm text-neutral-600 text-center">
        Some of the items you uploaded don&apos;t have exact creation timestamps
        — <span className="font-semibold">{unreliableCount}</span> of{' '}
        {totalCount}, to be specific. Should we:
      </p>

      {lastMatchAttempt && (
        <MatchFeedback
          matchedCount={lastMatchAttempt.matchedCount}
          pickerMetadata={lastMatchAttempt.pickerMetadata}
        />
      )}

      <div className="mt-6 flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={() => setView('smart-sort')}
          className="rounded-full bg-emerald-500 px-7 py-3 text-base font-semibold text-white hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
        >
          Google Photos Smart Sort
        </button>
        <button
          type="button"
          onClick={onManualReorder}
          className="rounded-full border border-emerald-500 px-7 py-3 text-base font-semibold text-emerald-600 hover:bg-emerald-50 transition-colors"
        >
          Manually reorder
        </button>
        <button
          type="button"
          onClick={onStitchAnyway}
          className="rounded-full border border-neutral-300 px-7 py-3 text-base font-semibold text-neutral-600 hover:bg-neutral-50 transition-colors"
        >
          Continue anyway
        </button>
      </div>
    </div>
  )
}

function MatchFeedback({
  matchedCount,
  pickerMetadata,
}: {
  matchedCount: number
  pickerMetadata: PickerMetadata[]
}) {
  const total = pickerMetadata.length
  const isZero = matchedCount === 0
  return (
    <div
      className={`mt-5 rounded-xl border px-4 py-3 text-left text-sm ${
        isZero
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : 'border-emerald-200 bg-emerald-50 text-emerald-800'
      }`}
    >
      <p className="font-medium">
        {isZero
          ? `No matches. Google sent ${total} item${total === 1 ? '' : 's'}, but none lined up.`
          : `Matched ${matchedCount} of ${total} item${total === 1 ? '' : 's'}.`}
      </p>
      {isZero && (
        <p className="mt-2 text-xs">
          Try Smart Sort again and pick the same items, or use Manually reorder.
        </p>
      )}
    </div>
  )
}
