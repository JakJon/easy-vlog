import { GooglePhotosButton } from './GooglePhotosButton'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import type { PickerMetadata } from '../lib/googlePhotosPicker'
import type { SortDiagnosticRow } from '../lib/metadata'

interface Props {
  totalCount: number
  unreliableCount: number
  diagnostics: SortDiagnosticRow[]
  onMatched: (metadata: PickerMetadata[]) => void
  onStitchAnyway: () => void
  onError: (message: string) => void
}

export function ReviewScreen({
  totalCount,
  unreliableCount,
  diagnostics,
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
      </div>
    </div>
  )
}
