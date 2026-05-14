import exifr from 'exifr'
import type { MediaItem, MediaKind } from './types'
import type { PickerMetadata } from './googlePhotosPicker'

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

// Sanity-bounds a candidate timestamp (string | Date | number) to ms-since-epoch.
function coerceToValidMs(v: unknown): number | null {
  let t: number | null = null
  if (v instanceof Date && !Number.isNaN(v.getTime())) t = v.getTime()
  else if (typeof v === 'number' && Number.isFinite(v)) t = v
  else if (typeof v === 'string') {
    const parsed = Date.parse(v.trim())
    if (Number.isFinite(parsed)) t = parsed
  }
  if (t == null) return null
  if (t <= 0 || t > Date.now() + 86_400_000) return null
  return t
}

// Tries exifr first (handles Apple QuickTime keys + standard MP4 date atoms),
// then falls back to our hand-rolled mvhd/tkhd/mdhd/udta walker.
async function readVideoTimestamp(file: File): Promise<number | null> {
  try {
    const tags = (await exifr.parse(file)) as Record<string, unknown> | undefined
    if (tags) {
      // Priority order: Apple QuickTime (has timezone) > standard MP4 atoms.
      const candidates = [
        tags['com.apple.quicktime.creationdate'],
        tags.CreationDate,
        tags.CreateDate,
        tags.DateTimeOriginal,
        tags.MediaCreateDate,
        tags.TrackCreateDate,
        tags.ContentCreateDate,
        tags.ModifyDate,
      ]
      for (const c of candidates) {
        const t = coerceToValidMs(c)
        if (t != null) return t
      }
    }
  } catch {
    // Fall through to hand-rolled parser.
  }

  // Hand-rolled fallback: moov is usually at the start (faststart) but can be
  // at the end. Read up to 8 MB head; if that misses, also try the tail.
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

interface Box {
  dataOffset: number
  end: number
}

const SECONDS_BETWEEN_1904_AND_1970 = 2_082_844_800

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

  // Walks sibling boxes [start, end). Calls visit on each. If visit returns
  // non-null, walking stops and that value is returned.
  function walkBoxes<T>(
    start: number,
    end: number,
    visit: (type: string, box: Box) => T | null,
  ): T | null {
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
      const box: Box = { dataOffset: dataOff, end: off + realSize }
      const r = visit(type, box)
      if (r != null) return r
      if (realSize <= 0) break
      off += realSize
    }
    return null
  }

  function findBox(start: number, end: number, target: string): Box | null {
    return walkBoxes(start, end, (t, b) => (t === target ? b : null))
  }

  function findAllBoxes(start: number, end: number, target: string): Box[] {
    const out: Box[] = []
    walkBoxes<null>(start, end, (t, b) => {
      if (t === target) out.push(b)
      return null
    })
    return out
  }

  // Parses an ISO-8601-ish date string (e.g. "2024-03-15T14:12:33-0700",
  // "2024-03-15T14:12:33Z", "2024-03-15 14:12:33"). Returns ms or null.
  function parseDateString(s: string): number | null {
    const trimmed = s.trim()
    if (!trimmed) return null
    // Date.parse handles ISO 8601 and many common variants natively.
    let t = Date.parse(trimmed)
    if (Number.isFinite(t)) {
      if (t > 0 && t <= Date.now() + 86_400_000) return t
    }
    // Try replacing space with T (some encoders use a space separator).
    if (trimmed.includes(' ')) {
      t = Date.parse(trimmed.replace(' ', 'T'))
      if (Number.isFinite(t) && t > 0 && t <= Date.now() + 86_400_000) return t
    }
    return null
  }

  // Reads creation_time from a header box that follows the standard layout:
  // version(1) flags(3) creation(u32|u64) modification(...) ...
  function readHeaderCreationTime(box: Box): number | null {
    if (box.dataOffset + 4 > len) return null
    const version = dv.getUint8(box.dataOffset)
    let secs: number
    if (version === 1) {
      if (box.dataOffset + 12 > len) return null
      const hi = dv.getUint32(box.dataOffset + 4)
      const lo = dv.getUint32(box.dataOffset + 8)
      secs = hi * 0x1_0000_0000 + lo
    } else {
      if (box.dataOffset + 8 > len) return null
      secs = dv.getUint32(box.dataOffset + 4)
    }
    const ms = (secs - SECONDS_BETWEEN_1904_AND_1970) * 1000
    if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + 86_400_000) return null
    return ms
  }

  // Reads a 'meta' box's contents. ISO BMFF style prefixes with 4 bytes of
  // version+flags; QuickTime style does not. Detects by peeking the first uint32.
  function metaChildrenStart(box: Box): number {
    if (box.dataOffset + 4 <= len && dv.getUint32(box.dataOffset) === 0) {
      return box.dataOffset + 4
    }
    return box.dataOffset
  }

  // Apple QuickTime metadata uses keys/ilst pair. keys lists key names by
  // index (1-based); ilst entries have a 4-byte tag that is the matching index.
  // We want the entry whose key name is 'com.apple.quicktime.creationdate'.
  function tryAppleCreationDate(meta: Box): number | null {
    const start = metaChildrenStart(meta)
    const keys = findBox(start, meta.end, 'keys')
    const ilst = findBox(start, meta.end, 'ilst')
    if (!keys || !ilst) return null

    // keys box: version(1) flags(3) entry_count(4) then entries:
    //   size(4) namespace(4) name(size-8)
    if (keys.dataOffset + 8 > len) return null
    const entryCount = dv.getUint32(keys.dataOffset + 4)
    let cursor = keys.dataOffset + 8
    let targetIndex = -1
    for (let i = 0; i < entryCount && cursor + 8 <= keys.end && cursor + 8 <= len; i++) {
      const sz = dv.getUint32(cursor)
      if (sz < 8 || cursor + sz > keys.end) break
      // namespace at cursor+4 (4 bytes), name at cursor+8 to cursor+sz
      const nameBytes = new Uint8Array(buf, cursor + 8, sz - 8)
      const name = new TextDecoder('utf-8').decode(nameBytes)
      if (name === 'com.apple.quicktime.creationdate') {
        targetIndex = i + 1 // 1-based
        break
      }
      cursor += sz
    }
    if (targetIndex < 0) return null

    // ilst children are themselves boxes whose type IS the 4-byte index (as
    // big-endian uint32). Find the one matching our target index.
    return walkBoxes<number>(ilst.dataOffset, ilst.end, (_t, child) => {
      // The 'type' field at child start was read as 4 chars. We need the raw
      // uint32 at child.dataOffset - 4. Easier: re-read via the parent walker.
      // Workaround: inspect child header bytes directly.
      const hdrStart = child.dataOffset - 8 // start of size+type for this box
      if (hdrStart < 0 || hdrStart + 8 > len) return null
      const tagIndex = dv.getUint32(hdrStart + 4)
      if (tagIndex !== targetIndex) return null
      // Inside this entry there is a 'data' atom.
      const data = findBox(child.dataOffset, child.end, 'data')
      if (!data) return null
      // data atom: type_indicator(4) locale(4) then payload.
      if (data.dataOffset + 8 > len) return null
      const payloadStart = data.dataOffset + 8
      if (payloadStart >= data.end) return null
      const bytes = new Uint8Array(buf, payloadStart, Math.min(data.end, len) - payloadStart)
      const text = new TextDecoder('utf-8').decode(bytes)
      return parseDateString(text)
    })
  }

  // QuickTime '©day' atom contains a length-prefixed string (or sometimes raw).
  function tryUdtaDay(udta: Box): number | null {
    const dayType = String.fromCharCode(0xa9) + 'day'
    const dayBox = findBox(udta.dataOffset, udta.end, dayType)
    if (!dayBox) return null
    if (dayBox.dataOffset >= len) return null
    // Two layouts in the wild: (a) length(2) lang(2) string; (b) raw string.
    // Try (a) first; if the prefix length doesn't make sense, fall back to (b).
    let text: string | null = null
    if (dayBox.dataOffset + 4 <= Math.min(dayBox.end, len)) {
      const strLen = dv.getUint16(dayBox.dataOffset)
      const payloadStart = dayBox.dataOffset + 4
      if (strLen > 0 && payloadStart + strLen <= Math.min(dayBox.end, len)) {
        const bytes = new Uint8Array(buf, payloadStart, strLen)
        text = new TextDecoder('utf-8').decode(bytes)
      }
    }
    if (text == null) {
      const bytes = new Uint8Array(
        buf,
        dayBox.dataOffset,
        Math.min(dayBox.end, len) - dayBox.dataOffset,
      )
      text = new TextDecoder('utf-8').decode(bytes)
    }
    return parseDateString(text)
  }

  const moov = findBox(0, len, 'moov')
  if (!moov) return null

  // 1. Apple QuickTime creationdate (gold standard for iPhone-origin files):
  //    moov.meta with key 'com.apple.quicktime.creationdate'.
  const moovMeta = findBox(moov.dataOffset, moov.end, 'meta')
  if (moovMeta) {
    const ts = tryAppleCreationDate(moovMeta)
    if (ts != null) return ts
  }

  // 2. Older Apple variant: moov.udta.meta with the same key, plus QuickTime
  //    '©day' atom.
  const udta = findBox(moov.dataOffset, moov.end, 'udta')
  if (udta) {
    const udtaMeta = findBox(udta.dataOffset, udta.end, 'meta')
    if (udtaMeta) {
      const ts = tryAppleCreationDate(udtaMeta)
      if (ts != null) return ts
    }
    const dayTs = tryUdtaDay(udta)
    if (dayTs != null) return dayTs
  }

  // 3. Per-track tkhd creation_time. Often preserved when mvhd has been
  //    rewritten by a transcoder (Google Photos), because trak boxes weren't
  //    touched.
  const traks = findAllBoxes(moov.dataOffset, moov.end, 'trak')
  for (const trak of traks) {
    const tkhd = findBox(trak.dataOffset, trak.end, 'tkhd')
    if (tkhd) {
      const ts = readHeaderCreationTime(tkhd)
      if (ts != null) return ts
    }
  }

  // 4. Per-track mdhd creation_time. Same idea as tkhd but inside trak.mdia.
  for (const trak of traks) {
    const mdia = findBox(trak.dataOffset, trak.end, 'mdia')
    if (mdia) {
      const mdhd = findBox(mdia.dataOffset, mdia.end, 'mdhd')
      if (mdhd) {
        const ts = readHeaderCreationTime(mdhd)
        if (ts != null) return ts
      }
    }
  }

  // 5. Last resort: moov.mvhd creation_time. Frequently the FIRST atom a
  //    transcoder wipes, so it's the lowest-priority signal.
  const mvhd = findBox(moov.dataOffset, moov.end, 'mvhd')
  if (mvhd) {
    const ts = readHeaderCreationTime(mvhd)
    if (ts != null) return ts
  }

  return null
}

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// Matches locally-uploaded files to Picker-API metadata so we can apply
// Google's authoritative capture timestamps without downloading the bytes.
// Returns Map<File, timestampMs>. Each picker entry is used at most once.
//
// Pass 1: exact filename match (case-insensitive).
// Pass 2: filename without extension + same kind. Catches HEIC→JPG conversions
//         and similar where the local file picker normalized the extension.
//
// Files that don't match are simply absent from the map; callers should fall
// back to whatever timestamp source they were using before.
export function matchFilesToPickerMetadata(
  files: File[],
  metadata: PickerMetadata[],
): Map<File, number> {
  const result = new Map<File, number>()
  const used = new Set<number>()

  const kindOf = (file: File): MediaKind | null => {
    if (file.type.startsWith('image/')) return 'image'
    if (file.type.startsWith('video/')) return 'video'
    return null
  }

  // Pass 1: exact case-insensitive filename match.
  for (const file of files) {
    if (result.has(file)) continue
    const target = file.name.toLowerCase()
    for (let i = 0; i < metadata.length; i++) {
      if (used.has(i)) continue
      if (metadata[i].filename.toLowerCase() === target) {
        result.set(file, metadata[i].timestamp)
        used.add(i)
        break
      }
    }
  }

  // Pass 2: filename-without-extension + same kind.
  for (const file of files) {
    if (result.has(file)) continue
    const kind = kindOf(file)
    if (!kind) continue
    const baseLocal = file.name.toLowerCase().replace(/\.[^.]+$/, '')
    for (let i = 0; i < metadata.length; i++) {
      if (used.has(i)) continue
      if (metadata[i].kind !== kind) continue
      const baseMeta = metadata[i].filename.toLowerCase().replace(/\.[^.]+$/, '')
      if (baseMeta === baseLocal) {
        result.set(file, metadata[i].timestamp)
        used.add(i)
        break
      }
    }
  }

  return result
}

// Extracts a capture timestamp from common phone-naming patterns:
//   VID20260509100810.mp4       (Android, no separators)
//   VID_20240315_141233.mp4     (Samsung etc.)
//   PXL_20240315_141233.mp4     (Google Pixel)
//   IMG_20240315.jpg            (date only)
//   20240315_141233.mp4
//   IMG-20240315-WA0001.jpg     (WhatsApp)
// Returns null if no recognizable date is found. Treats times as UTC; only the
// sort order matters here, so a fixed convention is fine.
export function parseFilenameDate(name: string): number | null {
  const m = name.match(
    /(?<!\d)(19\d{2}|20\d{2})[-_]?(\d{2})[-_]?(\d{2})(?:[-_T]?(\d{2})[-:]?(\d{2})[-:]?(\d{2}))?(?!\d)/,
  )
  if (!m) return null
  const [, yyyy, mm, dd, hh = '00', min = '00', ss = '00'] = m
  const year = Number(yyyy)
  const month = Number(mm)
  const day = Number(dd)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const hour = Number(hh)
  const minute = Number(min)
  const sec = Number(ss)
  if (hour > 23 || minute > 59 || sec > 59) return null
  const ts = Date.UTC(year, month - 1, day, hour, minute, sec)
  if (!Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 86_400_000) return null
  return ts
}

export type TimestampSource = 'google-photos' | 'filename' | 'meta' | 'lastModified'

// Last numeric run in the filename, used as a tiebreaker for lastModified-source
// items where the OS-supplied modification time is just the download time. Phone
// cameras typically increment a counter (1000008325, _all_20063, IMG_4012, etc.)
// in capture order, so this orders weak-source items sensibly relative to each
// other even when the absolute timestamp is gone.
function extractFilenameSequence(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, '')
  const matches = base.match(/\d+/g)
  if (!matches || matches.length === 0) return null
  const last = matches[matches.length - 1]
  const n = Number(last)
  return Number.isFinite(n) ? n : null
}

export interface SortDiagnosticRow {
  order: number
  kind: MediaKind
  name: string
  source: TimestampSource
  iso: string
}

export interface BuildMediaItemsResult {
  items: MediaItem[]
  diagnostics: SortDiagnosticRow[]
}

export async function buildMediaItems(
  files: File[],
  // Authoritative timestamps from Google Photos Picker, keyed by File. Files
  // present in this map skip the metadata cascade entirely and are marked
  // source='google-photos'. Allows the "Fix dates from Google Photos" flow.
  knownTimestamps?: Map<File, number>,
): Promise<BuildMediaItemsResult> {
  type Annotated = { item: MediaItem; source: TimestampSource; seq: number | null }
  const annotated: Annotated[] = []
  for (const file of files) {
    const kind = classify(file)
    if (!kind) continue
    let source: TimestampSource
    let timestamp: number
    const known = knownTimestamps?.get(file)
    if (known != null) {
      timestamp = known
      source = 'google-photos'
    } else {
      // Filename-encoded dates beat metadata: Google Photos / cloud syncs often
      // rewrite mvhd to processing time, so the original capture date survives
      // only in the filename (e.g. VID20260509100810.mp4).
      const fromFilename = parseFilenameDate(file.name)
      if (fromFilename != null) {
        timestamp = fromFilename
        source = 'filename'
      } else {
        const fromMeta =
          kind === 'image'
            ? await readImageTimestamp(file)
            : await readVideoTimestamp(file)
        if (fromMeta != null) {
          timestamp = fromMeta
          source = 'meta'
        } else {
          timestamp = file.lastModified
          source = 'lastModified'
        }
      }
    }
    annotated.push({
      item: { file, kind, timestamp },
      source,
      seq: extractFilenameSequence(file.name),
    })
  }

  // Strong-source items (filename, meta) sort by their real timestamp.
  // Weak-source items (lastModified) lose absolute timing — their lastModified
  // is just the download/access moment — but the filename's trailing counter
  // usually preserves relative capture order. Sort weak items by that counter
  // and append them after the strong items.
  const strong = annotated.filter((a) => a.source !== 'lastModified')
  const weak = annotated.filter((a) => a.source === 'lastModified')
  strong.sort((a, b) => a.item.timestamp - b.item.timestamp)
  weak.sort((a, b) => {
    if (a.seq != null && b.seq != null) return a.seq - b.seq
    if (a.seq != null) return -1
    if (b.seq != null) return 1
    return a.item.timestamp - b.item.timestamp
  })
  const ordered = [...strong, ...weak]
  const items = ordered.map((a) => a.item)
  const diagnostics: SortDiagnosticRow[] = ordered.map((a, i) => ({
    order: i,
    kind: a.item.kind,
    name: a.item.file.name,
    source: a.source,
    iso: new Date(a.item.timestamp).toISOString(),
  }))
  console.table(diagnostics)
  return { items, diagnostics }
}
