import { useState } from 'react'
import { SmartSortView } from './SmartSortView'
import type { PickerMetadata } from '../lib/googlePhotosPicker'

interface Props {
  lastMatchAttempt: {
    pickerMetadata: PickerMetadata[]
    matchedCount: number
  } | null
  onMatched: (metadata: PickerMetadata[]) => void
  onManualReorder: () => void
  onError: (message: string) => void
}

type View = 'options' | 'smart-sort'

export function ReorderOptionsScreen({
  lastMatchAttempt,
  onMatched,
  onManualReorder,
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
        Lets get this sorted out
      </h3>

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
      </div>
    </div>
  )
}
