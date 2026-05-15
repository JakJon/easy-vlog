import { GooglePhotosButton } from './GooglePhotosButton'
import type { PickerMetadata } from '../lib/googlePhotosPicker'

interface Props {
  onBack: () => void
  onMatched: (metadata: PickerMetadata[]) => void
  onError: (message: string) => void
  lastMatchAttempt: {
    pickerMetadata: PickerMetadata[]
    matchedCount: number
  } | null
}

export function SmartSortView({ onBack, onMatched, onError, lastMatchAttempt }: Props) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-6 py-8 sm:px-8 sm:py-10">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex items-center gap-1 text-sm font-medium text-neutral-500 hover:text-neutral-700"
        aria-label="Back"
      >
        <span aria-hidden>←</span> Back
      </button>
      <h3 className="mt-4 text-2xl font-semibold text-neutral-900 text-center">
        Google Photos Smart Sort
      </h3>
      <p className="mt-3 text-sm text-neutral-600 text-center">
        Sign in and pick the same items you uploaded. We&apos;ll use Google&apos;s
        dates to fix the order. Nothing re-downloads.
      </p>

      {lastMatchAttempt && (
        <MatchFeedback
          matchedCount={lastMatchAttempt.matchedCount}
          pickerMetadata={lastMatchAttempt.pickerMetadata}
        />
      )}

      <div className="mt-6 flex justify-center">
        <GooglePhotosButton
          onMetadata={onMatched}
          onError={onError}
          label="Google Photos Smart Sort"
        />
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
          ? `No matches. Google sent ${total} item${total === 1 ? '' : 's'}, but none lined up with your uploads.`
          : `Matched ${matchedCount} of ${total} item${total === 1 ? '' : 's'}.`}
      </p>
      {isZero && (
        <p className="mt-2 text-xs">
          Try again and pick exactly the items you uploaded — or use Manually reorder.
        </p>
      )}
    </div>
  )
}
