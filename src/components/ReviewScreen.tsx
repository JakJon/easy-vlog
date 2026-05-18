import { useState } from 'react'
import { SmartSortView } from './SmartSortView'
import { Options } from './Options'
import { UploadMoreButton } from './UploadMoreButton'
import type { PickerMetadata } from '../lib/googlePhotosPicker'
import type { SortDiagnosticRow } from '../lib/metadata'
import type { StitchOptions } from '../lib/types'

interface Props {
  totalCount: number
  unreliableCount: number
  diagnostics: SortDiagnosticRow[]
  lastMatchAttempt: {
    pickerMetadata: PickerMetadata[]
    matchedCount: number
  } | null
  options: StitchOptions
  onOptionsChange: (next: StitchOptions) => void
  onMatched: (metadata: PickerMetadata[]) => void
  onManualReorder: () => void
  onStitchAnyway: () => void
  onUploadMore: (files: File[]) => void
  onError: (message: string) => void
}

type View = 'options' | 'smart-sort'

export function ReviewScreen({
  totalCount,
  unreliableCount,
  lastMatchAttempt,
  options,
  onOptionsChange,
  onMatched,
  onManualReorder,
  onStitchAnyway,
  onUploadMore,
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
    <div className="rounded-2xl border border-neutral-200 bg-white">
      <div className="px-6 py-8 sm:px-8 sm:py-10">
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

        <div className="mt-6 flex justify-center">
          <div className="flex w-fit flex-col gap-3">
            <button
              type="button"
              onClick={() => setView('smart-sort')}
              className="w-full rounded-full bg-emerald-500 px-7 py-3 text-base font-semibold text-white hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
            >
              Google Photos Smart Sort
            </button>
            <button
              type="button"
              onClick={onManualReorder}
              className="w-full rounded-full border border-emerald-500 px-7 py-3 text-base font-semibold text-emerald-600 hover:bg-emerald-50 transition-colors"
            >
              Manually reorder
            </button>
            <button
              type="button"
              onClick={onStitchAnyway}
              className="w-full rounded-full border border-neutral-300 px-7 py-3 text-base font-semibold text-neutral-600 hover:bg-neutral-50 transition-colors"
            >
              Continue anyway
            </button>
            <UploadMoreButton onFiles={onUploadMore} className="w-full" />
          </div>
        </div>
      </div>

      <div className="border-t border-neutral-100 px-2 pb-2 pt-3 sm:px-4 sm:pb-3">
        <Options value={options} onChange={onOptionsChange} bare />
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
