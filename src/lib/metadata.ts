import exifr from 'exifr'
import type { MediaItem, MediaKind } from './types'

function classify(file: File): MediaKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return null
}

async function readImageTimestamp(file: File): Promise<number | null> {
  try {
    const exif = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate'])
    const date = exif?.DateTimeOriginal ?? exif?.CreateDate
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return date.getTime()
    }
  } catch {
    // Falls through to lastModified.
  }
  return null
}

// Parses MP4/MOV moov→mvhd creation_time without involving ffmpeg.
// Avoids writing the entire video into the wasm FS just to probe metadata.
async function readVideoTimestamp(file: File): Promise<number | null> {
  // moov is usually at the start (faststart) but can be at the end.
  // Read up to 8 MB head; if that misses, also try the tail.
  const HEAD = Math.min(file.size, 8 * 1024 * 1024)
  const headBuf = await file.slice(0, HEAD).arrayBuffer()
  let creation = parseMp4CreationTime(headBuf)
  if (creation === null && file.size > HEAD) {
    const tailStart = Math.max(HEAD, file.size - 8 * 1024 * 1024)
    const tailBuf = await file.slice(tailStart).arrayBuffer()
    creation = parseMp4CreationTime(tailBuf)
  }
  return creation
}

function parseMp4CreationTime(buf: ArrayBuffer): number | null {
  const dv = new DataView(buf)
  const len = buf.byteLength

  const readType = (off: number) =>
    String.fromCharCode(
      dv.getUint8(off),
      dv.getUint8(off + 1),
      dv.getUint8(off + 2),
      dv.getUint8(off + 3),
    )

  const findBox = (
    start: number,
    end: number,
    target: string,
  ): { dataOffset: number; end: number } | null => {
    let off = start
    while (off + 8 <= end) {
      const size = dv.getUint32(off)
      const type = readType(off + 4)
      let realSize: number
      let dataOff: number
      if (size === 1 && off + 16 <= end) {
        const hi = dv.getUint32(off + 8)
        const lo = dv.getUint32(off + 12)
        realSize = hi * 0x1_0000_0000 + lo
        dataOff = off + 16
      } else if (size === 0) {
        realSize = end - off
        dataOff = off + 8
      } else {
        realSize = size
        dataOff = off + 8
      }
      if (type === target) return { dataOffset: dataOff, end: off + realSize }
      if (realSize <= 0) break
      off += realSize
    }
    return null
  }

  const moov = findBox(0, len, 'moov')
  if (!moov) return null

  const mvhd = findBox(moov.dataOffset, Math.min(moov.end, len), 'mvhd')
  if (!mvhd) return null

  // mvhd: 1B version, 3B flags, then either:
  //   v0: u32 creation, u32 modification, u32 timescale, u32 duration
  //   v1: u64 creation, u64 modification, u32 timescale, u64 duration
  if (mvhd.dataOffset + 4 > len) return null
  const version = dv.getUint8(mvhd.dataOffset)
  let secondsSince1904: number
  if (version === 1) {
    if (mvhd.dataOffset + 12 > len) return null
    const hi = dv.getUint32(mvhd.dataOffset + 4)
    const lo = dv.getUint32(mvhd.dataOffset + 8)
    secondsSince1904 = hi * 0x1_0000_0000 + lo
  } else {
    if (mvhd.dataOffset + 8 > len) return null
    secondsSince1904 = dv.getUint32(mvhd.dataOffset + 4)
  }

  const SECONDS_BETWEEN_1904_AND_1970 = 2_082_844_800
  const ms = (secondsSince1904 - SECONDS_BETWEEN_1904_AND_1970) * 1000
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + 86_400_000) return null
  return ms
}

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export async function buildMediaItems(files: File[]): Promise<MediaItem[]> {
  const items: MediaItem[] = []
  for (const file of files) {
    const kind = classify(file)
    if (!kind) continue
    const fromMeta =
      kind === 'image'
        ? await readImageTimestamp(file)
        : await readVideoTimestamp(file)
    items.push({
      file,
      kind,
      timestamp: fromMeta ?? file.lastModified,
    })
  }
  items.sort((a, b) => a.timestamp - b.timestamp)
  return items
}
