import heic2any from 'heic2any'
import exifr from 'exifr'

export function isHeic(file: File): boolean {
  const type = file.type.toLowerCase()
  if (type === 'image/heic' || type === 'image/heif') return true
  // If the browser gave us a non-HEIC MIME, trust it. Google Photos
  // sometimes exports JPEG bytes with the original .heic filename.
  if (type) return false
  // MIME is empty (Windows Chrome does this for real HEICs); fall back
  // to the file extension.
  const name = file.name.toLowerCase()
  return name.endsWith('.heic') || name.endsWith('.heif')
}

export interface ConvertProgress {
  current: number
  total: number
}

export async function convertHeicFiles(
  files: File[],
  onProgress?: (p: ConvertProgress) => void,
): Promise<File[]> {
  const total = files.filter(isHeic).length
  if (total === 0) return files

  const out: File[] = []
  let done = 0
  for (const file of files) {
    if (!isHeic(file)) {
      out.push(file)
      continue
    }

    // Read EXIF capture time before converting (heic2any drops metadata).
    let captureTime: number | undefined
    try {
      const exif = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate'])
      const date = exif?.DateTimeOriginal ?? exif?.CreateDate
      if (date instanceof Date && !Number.isNaN(date.getTime())) {
        captureTime = date.getTime()
      }
    } catch {
      // Falls through to lastModified.
    }

    let converted: File
    try {
      const result = await heic2any({
        blob: file,
        toType: 'image/jpeg',
        quality: 0.9,
      })
      const blob = Array.isArray(result) ? result[0] : result
      const newName = file.name.replace(/\.(heic|heif)$/i, '.jpg')
      converted = new File([blob], newName, {
        type: 'image/jpeg',
        lastModified: captureTime ?? file.lastModified,
      })
    } catch (err) {
      // heic2any throws code 1 when bytes are already browser-readable
      // (e.g. Google Photos exporting JPEG with a .heic filename).
      const code = (err as { code?: number } | null)?.code
      if (code !== 1) throw err
      // Sniff the real MIME so downstream classify() doesn't skip it
      // (Windows Chrome leaves type empty on .heic-named JPEGs).
      const sniffed = await sniffImageMime(file)
      const ext = sniffed ? mimeToExt(sniffed) : 'jpg'
      const newName = file.name.replace(/\.(heic|heif)$/i, `.${ext}`)
      converted = new File([file], newName, {
        type: sniffed ?? 'image/jpeg',
        lastModified: captureTime ?? file.lastModified,
      })
    }
    out.push(converted)
    done += 1
    onProgress?.({ current: done, total })
  }
  return out
}

async function sniffImageMime(file: File): Promise<string | null> {
  const buf = await file.slice(0, 16).arrayBuffer()
  const b = new Uint8Array(buf)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp'
  return null
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'jpg'
  }
}
