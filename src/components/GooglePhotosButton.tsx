import { useState } from 'react'
import { pickFromGooglePhotos, type PickedMedia, type PickerProgress } from '../lib/googlePhotosPicker'

interface Props {
  onItems: (items: PickedMedia[]) => void
  onError: (message: string) => void
}

export function GooglePhotosButton({ onItems, onError }: Props) {
  const [progress, setProgress] = useState<PickerProgress | null>(null)

  const busy = progress != null

  const handleClick = async () => {
    setProgress({ phase: 'auth' })
    try {
      const items = await pickFromGooglePhotos((p) => setProgress(p))
      setProgress(null)
      onItems(items)
    } catch (err) {
      setProgress(null)
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  const label = (() => {
    if (!progress) return 'Pick from Google Photos'
    switch (progress.phase) {
      case 'auth':
        return 'Signing in...'
      case 'session':
        return 'Opening picker...'
      case 'waiting':
        return 'Waiting for selection...'
      case 'downloading':
        return progress.total
          ? `Downloading ${progress.current ?? 0} / ${progress.total}...`
          : 'Downloading...'
    }
  })()

  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-6 py-3 text-sm font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {label}
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
