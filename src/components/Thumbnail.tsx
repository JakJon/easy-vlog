import { useEffect, useState } from 'react'
import type { MediaItem } from '../lib/types'

// Renders a thumbnail for a media item.
//
// Images: object URL → <img>. State-based URL creation (not useMemo) so it's
// created in the effect-commit phase, never during render — mobile browsers
// otherwise aggressively GC URLs created mid-render.
//
// Videos: canvas frame extraction. We load the video, seek to a small positive
// time, draw the frame to an offscreen canvas, export as a JPEG blob, and use
// THAT as the displayed <img>. The actual <video> element is destroyed as soon
// as the frame is captured, so we never hold more than one active video at a
// time across the entire app (mobile Chrome caps simultaneous <video> elements
// around 16, which silently breaks half the thumbnails in long lists).

export function Thumbnail({ item, className }: { item: MediaItem; className?: string }) {
  if (item.kind === 'image') {
    return <ImageThumbnail file={item.file} className={className} />
  }
  return <VideoThumbnail file={item.file} className={className} />
}

function ImageThumbnail({ file, className }: { file: File; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    setError(false)
    return () => URL.revokeObjectURL(u)
  }, [file])

  return (
    <div className={`relative overflow-hidden bg-neutral-200 ${className ?? ''}`}>
      {url && !error && (
        <img
          src={url}
          alt=""
          decoding="async"
          onError={() => setError(true)}
          className="h-full w-full object-cover"
        />
      )}
      {error && (
        <div className="flex h-full w-full items-center justify-center text-[10px] font-medium text-neutral-400">
          IMG
        </div>
      )}
    </div>
  )
}

// Shared sequential queue. Each video thumbnail extraction is appended to the
// chain so only one <video> element is alive at any moment.
let extractionQueue: Promise<unknown> = Promise.resolve()

function enqueueExtraction<T>(fn: () => Promise<T>): Promise<T> {
  const next = extractionQueue.then(fn, fn)
  // Swallow rejections on the queue tail so one failure doesn't poison the chain.
  extractionQueue = next.catch(() => {})
  return next
}

function extractVideoFrame(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'

    const objectUrl = URL.createObjectURL(file)
    video.src = objectUrl

    let settled = false
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Video thumbnail extraction timed out'))
    }, 8000)

    function cleanup() {
      video.removeAttribute('src')
      try {
        video.load()
      } catch {
        // ignore
      }
      URL.revokeObjectURL(objectUrl)
      window.clearTimeout(timeoutId)
    }

    video.onloadeddata = () => {
      try {
        // Seek slightly past start so we render a real frame, not a black one.
        const target = Math.min(0.3, (video.duration || 1) / 2)
        video.currentTime = target
      } catch (e) {
        if (settled) return
        settled = true
        cleanup()
        reject(e)
      }
    }

    video.onseeked = () => {
      if (settled) return
      try {
        const targetW = 320
        const w = video.videoWidth
        const h = video.videoHeight
        if (!w || !h) throw new Error('Video has no dimensions')
        const scale = targetW / w
        const canvas = document.createElement('canvas')
        canvas.width = targetW
        canvas.height = Math.max(1, Math.round(h * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('No 2D canvas context')
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(
          (blob) => {
            if (settled) return
            settled = true
            cleanup()
            if (!blob) {
              reject(new Error('Canvas toBlob returned null'))
              return
            }
            resolve(URL.createObjectURL(blob))
          },
          'image/jpeg',
          0.78,
        )
      } catch (e) {
        if (settled) return
        settled = true
        cleanup()
        reject(e)
      }
    }

    video.onerror = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Video failed to load'))
    }
  })
}

function VideoThumbnail({ file, className }: { file: File; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    let frameUrl: string | null = null
    enqueueExtraction(() => extractVideoFrame(file))
      .then((u) => {
        if (!active) {
          URL.revokeObjectURL(u)
          return
        }
        frameUrl = u
        setUrl(u)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
      if (frameUrl) URL.revokeObjectURL(frameUrl)
    }
  }, [file])

  return (
    <div className={`relative overflow-hidden bg-neutral-200 ${className ?? ''}`}>
      {url && (
        <img src={url} alt="" decoding="async" className="h-full w-full object-cover" />
      )}
      {!url && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] font-medium text-neutral-400">...</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-neutral-400">
          VID
        </div>
      )}
      <span
        aria-hidden
        className="absolute right-1 bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[10px] leading-none text-white"
      >
        ▶
      </span>
    </div>
  )
}
