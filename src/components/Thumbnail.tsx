import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '../lib/types'

// Renders a thumbnail for a media item.
//
// Images: object URL → <img>. Created lazily once the element is in (or near)
// the viewport, then cached by File reference so view-toggles (list ↔ card)
// don't re-create URLs.
//
// Videos: canvas frame extraction. Each video gets seeked to t=0.3, drawn to
// an offscreen canvas, exported as a JPEG blob — the resulting blob URL is
// the displayed <img>. The actual <video> element is destroyed as soon as the
// frame is captured, and only one <video> is alive at a time across the whole
// app (mobile Chrome caps simultaneous <video> elements around 16).
//
// Both kinds use:
//   - WeakMap caches keyed by File so URLs survive component remounts (view
//     toggle, drag-drop reorder churn) without re-doing the work.
//   - IntersectionObserver-based lazy loading so opening Manual Reorder with
//     30+ items doesn't try to decode 30+ images / extract 30+ video frames
//     all at once.
//
// Memory: blob URLs aren't explicitly revoked. Once the underlying File
// objects go out of scope (after the user does a fresh upload), the WeakMap
// entries are GC'd; the URLs become orphan handles and the browser cleans
// them up on page unload. For typical session sizes (tens of items, small
// JPEG thumbnails) this is fine.

const imageObjectUrls = new WeakMap<File, string>()
const videoFrameUrls = new WeakMap<File, string>()

export function Thumbnail({ item, className }: { item: MediaItem; className?: string }) {
  if (item.kind === 'image') {
    return <ImageThumbnail file={item.file} className={className} />
  }
  return <VideoThumbnail file={item.file} className={className} />
}

function useNearViewport(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // Old browser fallback: skip lazy gate.
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

function ImageThumbnail({ file, className }: { file: File; className?: string }) {
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
      className={`relative overflow-hidden bg-neutral-200 ${className ?? ''}`}
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
  const cached = videoFrameUrls.get(file)
  const [url, setUrl] = useState<string | null>(cached ?? null)
  const [error, setError] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const needsLazy = url == null && !error
  const nearViewport = useNearViewport(ref, needsLazy)

  useEffect(() => {
    if (url || error) return
    if (!nearViewport) return
    // Double-check the cache in case another component populated it while we
    // were waiting in the viewport queue.
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
      className={`relative overflow-hidden bg-neutral-200 ${className ?? ''}`}
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
