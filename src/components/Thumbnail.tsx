import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { MediaItem, MediaKind } from '../lib/types'

// Pre-extracted, in-memory thumbnail/preview cache.
//
// Why: on Android Chrome with File objects sourced from content URIs (Photo
// Picker, gallery share), once any operation reads the underlying blob — via
// createImageBitmap, file.arrayBuffer, video.src=..., etc. — subsequent reads
// can fail because the content-URI grant is effectively one-shot. The stitch
// pipeline reads every File during encoding, so by the time the user opens
// Manual Reorder POST-stitch, fresh blob URLs derived from the original Files
// don't actually load.
//
// Workaround: read each File once, up front, and store a compact in-memory
// JPEG blob URL. Manual Reorder thumbnails and image PreviewModal both pull
// from this cache. The in-memory blob URLs are immune to whatever happens to
// the original File afterwards.
//
// Sizes:
//   - Image preview: ~1280px wide JPEG, q=0.85 (≈ 150 KB each, < 5 MB for 30)
//   - Video frame:   ~320px wide JPEG, q=0.78 (≈ 30 KB each)
//
// Memory: blob URLs aren't explicitly revoked. WeakMap GC's the entry once
// the underlying File goes out of scope (i.e. after a fresh upload).

const previewCache = new WeakMap<File, string>()
const inProgress = new Map<File, Promise<string>>()
// Video frame extraction runs serially because mobile Chrome caps simultaneous
// active <video> elements around 16; serialising avoids the cap entirely.
let videoQueue: Promise<unknown> = Promise.resolve()

export function getPreviewUrl(file: File): string | undefined {
  return previewCache.get(file)
}

interface PrecacheItem {
  file: File
  kind: MediaKind
}

// Fire-and-forget or awaitable. Resolves when every input has either been
// successfully extracted or has errored out. Failures are swallowed per-item
// so one bad file doesn't block the rest.
export function precachePreviews(items: PrecacheItem[]): Promise<void> {
  return Promise.all(
    items.map((item) =>
      extractPreviewWithCache(item.file, item.kind).catch(() => undefined),
    ),
  ).then(() => undefined)
}

function extractPreviewWithCache(file: File, kind: MediaKind): Promise<string> {
  const cached = previewCache.get(file)
  if (cached) return Promise.resolve(cached)
  const existing = inProgress.get(file)
  if (existing) return existing
  const promise = (async () => {
    let url: string
    if (kind === 'image') {
      url = await extractImagePreview(file)
    } else {
      url = await runOnVideoQueue(() => extractVideoFrame(file))
    }
    previewCache.set(file, url)
    inProgress.delete(file)
    return url
  })()
  inProgress.set(file, promise)
  return promise
}

function runOnVideoQueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = videoQueue.then(fn, fn)
  videoQueue = next.catch(() => undefined)
  return next
}

async function extractImagePreview(file: File): Promise<string> {
  // Copy bytes into an in-memory Blob before createImageBitmap. Without the
  // copy, content-URI-backed Files end up unreadable after this call.
  const bytes = await file.arrayBuffer()
  const blob = new Blob([bytes], { type: file.type || 'image/jpeg' })
  const bitmap = await createImageBitmap(blob)
  try {
    const targetW = 1280
    const scale = Math.min(1, targetW / bitmap.width)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No 2D canvas context')
    ctx.drawImage(bitmap, 0, 0, w, h)
    return await new Promise<string>((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (b) resolve(URL.createObjectURL(b))
          else reject(new Error('Canvas toBlob returned null'))
        },
        'image/jpeg',
        0.85,
      )
    })
  } finally {
    bitmap.close()
  }
}

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
    return avg < 12
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

// ─── Components ────────────────────────────────────────────────────────────

interface ThumbnailProps {
  item: MediaItem
  className?: string
  onClick?: () => void
}

export function Thumbnail({ item, className, onClick }: ThumbnailProps) {
  const cached = previewCache.get(item.file)
  const [url, setUrl] = useState<string | null>(cached ?? null)
  const [error, setError] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const needsLazy = url == null && !error
  const nearViewport = useNearViewport(ref, needsLazy)

  useEffect(() => {
    if (url || error) return
    if (!nearViewport) return
    let active = true
    extractPreviewWithCache(item.file, item.kind)
      .then((u) => {
        if (active) setUrl(u)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [item.file, item.kind, url, error, nearViewport])

  return (
    <div
      ref={ref}
      onClick={makeClickHandler(onClick)}
      className={`relative overflow-hidden bg-neutral-200 ${onClick ? 'cursor-pointer' : ''} ${className ?? ''}`}
    >
      {url && !error && (
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
          {item.kind === 'video' ? 'VID' : 'IMG'}
        </div>
      )}
      {item.kind === 'video' && (
        <span
          aria-hidden
          className="absolute right-1 bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[10px] leading-none text-white"
        >
          ▶
        </span>
      )}
    </div>
  )
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

function makeClickHandler(onClick?: () => void) {
  if (!onClick) return undefined
  return (e: MouseEvent) => {
    e.stopPropagation()
    onClick()
  }
}
