import { GooglePhotosButton } from './GooglePhotosButton'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { PickerMetadataPanel } from './PickerMetadataPanel'
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
  onStitchAnyway: () => void
  onError: (message: string) => void
}

export function ReviewScreen({
  totalCount,
  unreliableCount,
  diagnostics,
  lastMatchAttempt,
  onMatched,
  onStitchAnyway,
  onError,
}: Props) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-8 py-10 text-center">
      <h3 className="text-xl font-semibold text-neutral-900">
        {unreliableCount === 1 ? '1 item needs a date' : `${unreliableCount} items need dates`}
      </h3>
      <p className="mt-2 text-sm text-neutral-600">
        {unreliableCount} of {totalCount} files don&apos;t have reliable capture
        timestamps. Pulling them from Google Photos will give you the correct
        chronological order.
      </p>

      {lastMatchAttempt && (
        <MatchFeedback
          matchedCount={lastMatchAttempt.matchedCount}
          pickerMetadata={lastMatchAttempt.pickerMetadata}
        />
      )}

      <div className="mt-6 flex flex-col items-center gap-3">
        <GooglePhotosButton onMetadata={onMatched} onError={onError} />
        <button
          type="button"
          onClick={onStitchAnyway}
          className="text-sm font-medium text-neutral-500 hover:text-neutral-700 underline"
        >
          Stitch anyway with the current order
        </button>
      </div>

      <div className="mt-6 text-left">
        <DiagnosticsPanel rows={diagnostics} />
        {lastMatchAttempt && lastMatchAttempt.pickerMetadata.length > 0 && (
          <PickerMetadataPanel
            items={lastMatchAttempt.pickerMetadata}
            matchedCount={lastMatchAttempt.matchedCount}
          />
        )}
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
          ? `No matches. Google sent ${total} item${total === 1 ? '' : 's'}, but none of the filenames lined up with the files you uploaded.`
          : `Matched ${matchedCount} of ${total} item${total === 1 ? '' : 's'} from Google Photos.`}
      </p>
      {isZero && (
        <p className="mt-2 text-xs">
          See the &quot;Google Photos metadata&quot; panel below to compare what
          Google sent against your local filenames.
        </p>
      )}
    </div>
  )
}
