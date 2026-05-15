import { useEffect, useState } from 'react'
import type { MediaItem } from '../lib/types'

interface Props {
  item: MediaItem
  onClose: () => void
}

export function PreviewModal({ item, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null)

  // Create a fresh object URL for full-resolution playback. The thumbnail
  // cache holds compressed JPEG frames for videos, not the original media, so
  // we always need a new URL here.
  useEffect(() => {
    const u = URL.createObjectURL(item.file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [item])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock body scroll while the modal is open.
  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [])

  if (!url) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-2xl leading-none text-white hover:bg-white/20 transition-colors"
      >
        ×
      </button>

      <div
        className="max-h-[90vh] max-w-[95vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {item.kind === 'video' ? (
          <video
            src={url}
            controls
            autoPlay
            playsInline
            className="max-h-[90vh] max-w-[95vw] rounded-xl bg-black"
          />
        ) : (
          <img
            src={url}
            alt=""
            className="max-h-[90vh] max-w-[95vw] rounded-xl object-contain"
          />
        )}
      </div>
    </div>
  )
}
