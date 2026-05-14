import { useState } from 'react'
import {
  pickMetadataFromGooglePhotos,
  type PickerMetadata,
  type PickerProgress,
} from '../lib/googlePhotosPicker'

interface Props {
  onMetadata: (metadata: PickerMetadata[]) => void
  onError: (message: string) => void
  label?: string
}

export function GooglePhotosButton({ onMetadata, onError, label }: Props) {
  const [progress, setProgress] = useState<PickerProgress | null>(null)
  const busy = progress != null

  const handleClick = async () => {
    // Pre-open a blank window in the user gesture to dodge popup blockers.
    const pickerWindow = window.open('about:blank', '_blank')
    setProgress({ phase: 'auth' })
    try {
      const metadata = await pickMetadataFromGooglePhotos(
        (p) => setProgress(p),
        undefined,
        pickerWindow,
      )
      setProgress(null)
      onMetadata(metadata)
    } catch (err) {
      setProgress(null)
      try {
        pickerWindow?.close()
      } catch {
        // ignore
      }
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  const buttonLabel = (() => {
    if (!progress) return label ?? 'Fix dates from Google Photos'
    switch (progress.phase) {
      case 'auth':
        return 'Signing in...'
      case 'session':
        return 'Opening picker...'
      case 'waiting':
        return 'Waiting for selection...'
      case 'listing':
        return 'Reading dates...'
    }
  })()

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-6 py-3 text-sm font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {buttonLabel}
      </button>
      {progress?.phase === 'waiting' && progress.pickerUri && (
        <a
          href={progress.pickerUri}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-emerald-600 underline"
        >
          Picker didn't open? Tap here.
        </a>
      )}
    </div>
  )
}
