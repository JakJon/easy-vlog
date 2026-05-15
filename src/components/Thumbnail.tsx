import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { MediaItem } from '../lib/types'

// Renders a thumbnail for a media item.
//
// Images: object URL → <img>. Created lazily once the element is in (or near)
// the viewport, then cached by File reference so view-toggles (list ↔ card)
// don't re-create URLs.
//
// Videos: canvas frame extraction. We try several seek positions (start, 10%,
// 25%, 50%) and pick the first non-dark frame — phone clips often have
// fade-ins or black slates in the first second, which the naive "seek to
// 0.3s" used to expose as solid black thumbnails. The actual <video> element
// is destroyed as soon as the frame is captured, and only one is alive at a
// time across the app.
//
// Both kinds:
//   - WeakMap caches keyed by File so URLs survive component remounts (view
//     toggle, drag-drop reorder churn) without re-doing the work.
//   - IntersectionObserver-based lazy loading so opening Manual Reorder with
//     30+ items doesn't try to decode 30+ images / extract 30+ video frames
//     all at once.
//
// Memory: blob URLs aren't explicitly revoked. Once the underlying File
// objects go out of scope (after a fresh upload), the WeakMap entries are
// GC'd; URLs become orphan handles and the browser cleans them up on page
// unload.

const imageObjectUrls = new WeakMap<File, string>()
const videoFrameUrls = new WeakMap<File, string>()

interface ThumbnailProps {
  item: MediaItem
  className?: string
  onClick?: () => void
}

export function Thumbnail({ item, className, onClick }: ThumbnailProps) {
  if (item.kind === 'image') {
    return <ImageThumbnail file={item.file} className={className} onClick={onClick} />
  }
  return <VideoThumbnail file={item.file} className={className} onClick={onClick} />
}

function useNearViewport(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled, ref])
  return visible
}

// stopPropagation so the click doesn't bubble up to whatever dnd-kit-listening
// parent the thumbnail might be inside of.
function makeClickHandler(onClick?: () => void) {
  if (!onClick) return undefined
  return (e: MouseEvent) => {
    e.stopPropagation()
    onClick()
  }
}

function ImageThumbnail({
  file,
  className,
  onClick,
}: {
  file: File
  className?: string
  onClick?: () => void
}) {
  const cached = imageObjectUrls.get(file)
  const [url, setUrl] = useState<string | null>(cached ?? null)
  const [error, setError] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const needsLazy = url == null && !error
  const nearViewport = useNearViewport(ref, needsLazy)

  useEffect(() => {
    if (url || error) return
    if (!nearViewport) return
    let u = imageObjectUrls.get(file)
    if (!u) {
      u = URL.createObjectURL(file)
      imageObjectUrls.set(file, u)
    }
    setUrl(u)
  }, [file, url, error, nearViewport])

  return (
    <div
      ref={ref}
      onClick={makeClickHandler(onClick)}
      className={`relative overflow-hidden bg-neutral-200 ${onClick ? 'cursor-zoom-in' : ''} ${className ?? ''}`}
    >
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
        <div className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-neutral-400">
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
  extractionQueue = next.catch(() => {})
  return next
}

// Async helper: wait for a one-shot video event.
function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: 'loadeddata' | 'seeked',
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`${eventName} timed out`))
    }, timeoutMs)
    function cleanup() {
      video.removeEventListener(eventName, onSuccess)
      video.removeEventListener('error', onError)
      window.clearTimeout(timer)
    }
    function onSuccess() {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    function onError() {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Video error'))
    }
    video.addEventListener(eventName, onSuccess, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}

function drawFrameToCanvas(video: HTMLVideoElement): HTMLCanvasElement | null {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return null
  const targetW = 320
  const scale = targetW / w
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas
}

// Samples a small center region and returns true if the average luminance is
// near-black. Used to skip "still loading" or "fade-in" frames.
function isFrameTooDark(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const sampleSize = Math.min(40, canvas.width, canvas.height)
  const sx = Math.floor((canvas.width - sampleSize) / 2)
  const sy = Math.floor((canvas.height - sampleSize) / 2)
  try {
    const data = ctx.getImageData(sx, sy, sampleSize, sampleSize).data
    let total = 0
    for (let i = 0; i < data.length; i += 4) {
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    const avg = total / (sampleSize * sampleSize)
    return avg < 12 // < ~5% brightness ≈ black
  } catch {
    return false
  }
}

function canvasToBlobUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(URL.createObjectURL(blob))
        else reject(new Error('Canvas toBlob returned null'))
      },
      'image/jpeg',
      0.78,
    )
  })
}

async function extractVideoFrame(file: File): Promise<string> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  const objectUrl = URL.createObjectURL(file)
  video.src = objectUrl

  let fallbackUrl: string | null = null

  try {
    await waitForVideoEvent(video, 'loadeddata', 8000)
    const duration = video.duration || 1
    // Try multiple seek positions. Sorted from cheapest (near start) to deeper
    // into the clip — phone fade-ins are usually under 1 second.
    const rawCandidates = [
      Math.min(0.3, duration / 2),
      Math.min(1.2, duration * 0.1),
      Math.min(3, duration * 0.25),
      Math.min(8, duration * 0.5),
    ]
    const seen = new Set<number>()
    const candidates = rawCandidates.filter((t) => {
      const k = Math.round(t * 100)
      if (seen.has(k) || t <= 0) return false
      seen.add(k)
      return true
    })

    for (const t of candidates) {
      try {
        video.currentTime = t
        await waitForVideoEvent(video, 'seeked', 3000)
      } catch {
        continue
      }
      const canvas = drawFrameToCanvas(video)
      if (!canvas) continue
      if (!isFrameTooDark(canvas)) {
        if (fallbackUrl) URL.revokeObjectURL(fallbackUrl)
        return await canvasToBlobUrl(canvas)
      }
      // Save this dark frame as a fallback in case every position is black.
      const darkUrl = await canvasToBlobUrl(canvas).catch(() => null)
      if (darkUrl) {
        if (fallbackUrl) URL.revokeObjectURL(fallbackUrl)
        fallbackUrl = darkUrl
      }
    }

    if (fallbackUrl) return fallbackUrl
    throw new Error('Failed to extract any video frame')
  } finally {
    video.removeAttribute('src')
    try {
      video.load()
    } catch {
      // ignore
    }
    URL.revokeObjectURL(objectUrl)
  }
}

function VideoThumbnail({
  file,
  className,
  onClick,
}: {
  file: File
  className?: string
  onClick?: () => void
}) {
  const cached = videoFrameUrls.get(file)
  const [url, setUrl] = useState<string | null>(cached ?? null)
  const [error, setError] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const needsLazy = url == null && !error
  const nearViewport = useNearViewport(ref, needsLazy)

  useEffect(() => {
    if (url || error) return
    if (!nearViewport) return
    const c = videoFrameUrls.get(file)
    if (c) {
      setUrl(c)
      return
    }
    let active = true
    enqueueExtraction(() => extractVideoFrame(file))
      .then((u) => {
        videoFrameUrls.set(file, u)
        if (active) setUrl(u)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [file, url, error, nearViewport])

  return (
    <div
      ref={ref}
      onClick={makeClickHandler(onClick)}
      className={`relative overflow-hidden bg-neutral-200 ${onClick ? 'cursor-pointer' : ''} ${className ?? ''}`}
    >
      {url && (
        <img
          src={url}
          alt=""
          decoding="async"
          className="h-full w-full object-cover"
        />
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
