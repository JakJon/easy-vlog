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
    setProgress({ phase: 'auth' })
    try {
      const metadata = await pickMetadataFromGooglePhotos((p) => setProgress(p))
      setProgress(null)
      onMetadata(metadata)
    } catch (err) {
      setProgress(null)
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

  const showPickerLink = progress?.phase === 'waiting' && progress.pickerUri

  return (
    <div className="flex flex-col items-center gap-3">
      {showPickerLink ? (
        <a
          href={progress.pickerUri}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-full border border-emerald-500 bg-emerald-500 px-6 py-3 text-sm font-medium text-white hover:bg-emerald-400 hover:border-emerald-400 transition-colors"
        >
          Open Google Photos picker
        </a>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-6 py-3 text-sm font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {buttonLabel}
        </button>
      )}
      {showPickerLink && (
        <p className="text-xs text-neutral-500 text-center max-w-xs">
          Pick the same items in Google Photos, then return here — we&apos;ll
          finish automatically.
        </p>
      )}
    </div>
  )
}
