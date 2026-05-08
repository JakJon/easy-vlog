import { fetchFile } from '@ffmpeg/util'
import { getFFmpeg } from './ffmpeg'
import { safeName } from './metadata'
import type { MediaItem } from './types'

const TARGET_W = 1920
const TARGET_H = 1080
const TARGET_FPS = 24
const TARGET_CRF = 28
const IMAGE_DURATION_SECONDS = 3

const VIDEO_SCALE_PAD = `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${TARGET_FPS}`

export interface StitchProgress {
  current: number
  total: number
  ratio: number
}

interface PreparedInput {
  kind: 'image' | 'video'
  name: string
  durationSeconds: number
}

export async function stitchMedia(
  items: MediaItem[],
  onProgress: (p: StitchProgress) => void
): Promise<Blob> {
  if (items.length === 0) {
    throw new Error('No media items to stitch.')
  }
  const ff = await getFFmpeg()

  const total = items.length + 1
  let current = 0

  const reportRatio = (ratio: number) =>
    onProgress({ current, total, ratio: Math.max(0, Math.min(1, ratio)) })

  // Compute progress against our own known total duration. ffmpeg.wasm's
  // built-in `progress` field is unreliable with `-loop 1 -t N` inputs and
  // concat filters (it hits 1.0 after the first input).
  let totalDurationUs = 1
  let lastReportedRatio = 0
  const onFFProgress = ({ time }: { time: number }) => {
    const ratio = time / totalDurationUs
    if (ratio > lastReportedRatio) {
      lastReportedRatio = ratio
      reportRatio(ratio)
    }
  }
  ff.on('progress', onFFProgress)

  const writtenInputs: string[] = []
  const prepared: PreparedInput[] = []
  const finalName = 'easy-vlog.mp4'

  try {
    // Pre-scale images via Canvas (skips ffmpeg's scaler entirely for stills)
    // and write everything to ffmpeg's virtual FS.
    for (let i = 0; i < items.length; i++) {
      current = i + 1
      reportRatio(0)

      const item = items[i]
      if (item.kind === 'image') {
        const jpegBytes = await prescaleImageToJpeg(item.file, TARGET_W, TARGET_H)
        const name = `in_${i}.jpg`
        await ff.writeFile(name, jpegBytes)
        writtenInputs.push(name)
        prepared.push({
          kind: 'image',
          name,
          durationSeconds: IMAGE_DURATION_SECONDS,
        })
      } else {
        const ext = guessVideoExt(item.file)
        const name = `in_${i}.${ext}`
        await ff.writeFile(name, await fetchFile(item.file))
        writtenInputs.push(name)
        const durationSeconds = await readVideoDurationSeconds(item.file)
        prepared.push({ kind: 'video', name, durationSeconds })
      }
      reportRatio(1)
    }

    totalDurationUs = Math.max(
      1,
      Math.round(
        prepared.reduce((sum, p) => sum + p.durationSeconds, 0) * 1_000_000
      )
    )

    current = total
    reportRatio(0)

    const hasAnyVideo = prepared.some((p) => p.kind === 'video')
    const includeAudio = hasAnyVideo

    const args: string[] = []
    for (const p of prepared) {
      if (p.kind === 'image') {
        args.push('-loop', '1', '-t', String(IMAGE_DURATION_SECONDS), '-i', p.name)
      } else {
        args.push('-i', p.name)
      }
    }

    const filterParts: string[] = []
    const concatLabels: string[] = []

    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i]
      if (p.kind === 'image') {
        // Already 1920x1080 from canvas; just normalize timing/format.
        filterParts.push(
          `[${i}:v]fps=${TARGET_FPS},setsar=1,format=yuv420p[v${i}]`
        )
        if (includeAudio) {
          filterParts.push(
            `anullsrc=channel_layout=stereo:sample_rate=44100:d=${IMAGE_DURATION_SECONDS}[a${i}]`
          )
        }
      } else {
        filterParts.push(`[${i}:v]${VIDEO_SCALE_PAD},format=yuv420p[v${i}]`)
        if (includeAudio) {
          filterParts.push(
            `[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`
          )
        }
      }
      concatLabels.push(`[v${i}]`)
      if (includeAudio) concatLabels.push(`[a${i}]`)
    }

    if (includeAudio) {
      filterParts.push(
        `${concatLabels.join('')}concat=n=${prepared.length}:v=1:a=1[outv][outa]`
      )
    } else {
      filterParts.push(
        `${concatLabels.join('')}concat=n=${prepared.length}:v=1:a=0[outv]`
      )
    }

    args.push('-filter_complex', filterParts.join(';'))
    args.push('-map', '[outv]')
    if (includeAudio) args.push('-map', '[outa]')

    args.push('-c:v', 'libx264', '-preset', 'ultrafast')
    // stillimage tune is only appropriate when there's no real motion content.
    if (!hasAnyVideo) args.push('-tune', 'stillimage')
    args.push('-crf', String(TARGET_CRF))
    args.push('-pix_fmt', 'yuv420p', '-r', String(TARGET_FPS))
    if (includeAudio) args.push('-c:a', 'aac', '-b:a', '128k')
    args.push('-movflags', '+faststart')
    args.push('-y', finalName)

    await ff.exec(args)
    reportRatio(1)

    const data = await ff.readFile(finalName)
    const bytes =
      data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    const blob = new Blob([bytes], { type: 'video/mp4' })

    // Cleanup virtual FS so re-runs start clean.
    for (const name of [...writtenInputs, finalName]) {
      try {
        await ff.deleteFile(name)
      } catch {
        /* ignore */
      }
    }

    return blob
  } finally {
    ff.off('progress', onFFProgress)
  }
}

async function prescaleImageToJpeg(
  file: File,
  targetW: number,
  targetH: number
): Promise<Uint8Array> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D canvas context.')

    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, targetW, targetH)

    // Contain (letterbox/pillarbox), preserving aspect ratio.
    const scale = Math.min(
      targetW / img.naturalWidth,
      targetH / img.naturalHeight
    )
    const w = img.naturalWidth * scale
    const h = img.naturalHeight * scale
    const x = (targetW - w) / 2
    const y = (targetH - h) / 2
    ctx.drawImage(img, x, y, w, h)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9)
    )
    if (!blob) throw new Error('Canvas toBlob returned null.')
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
    img.src = src
  })
}

async function readVideoDurationSeconds(file: File): Promise<number> {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<number>((resolve, reject) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      video.onloadedmetadata = () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          resolve(video.duration)
        } else {
          // Unknown duration (some MOV variants). Fall back to a rough guess.
          resolve(5)
        }
      }
      video.onerror = () => reject(new Error(`Failed to read video metadata: ${file.name}`))
      video.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function guessVideoExt(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase()
  if (fromName && /^(mp4|mov|m4v|webm|mkv|avi)$/.test(fromName)) return fromName
  return 'mp4'
}

// Exposed so callers can avoid name collisions when reusing the FS.
export { safeName }
