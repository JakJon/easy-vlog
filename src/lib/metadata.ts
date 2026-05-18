import exifr from 'exifr'
import type { MediaItem, MediaKind } from './types'
import type { PickerMetadata } from './googlePhotosPicker'

function classify(file: File): MediaKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return null
}

// Fine-grained metadata sub-source labels. Lets the diagnostics panel show
// exactly which atom/EXIF tag fired (or didn't), so future "no metadata" reports
// are debuggable from the panel alone instead of needing another investigation.
export type VideoMetaSource =
  | 'meta-apple-key' // moov.meta or moov.udta.meta key 'com.apple.quicktime.creationdate'
  | 'meta-udta-day' // moov.udta.©day
  | 'meta-tkhd' // per-track tkhd creation_time
  | 'meta-mdhd' // per-track mdhd creation_time
  | 'meta-mvhd' // moov.mvhd creation_time

export type TimestampSource =
  | 'google-photos'
  | 'filename'
  | VideoMetaSource
  | 'meta-exif'
  | 'lastModified'

interface MetaResult {
  ts: number
  src: TimestampSource
}

async function readImageTimestamp(file: File): Promise<MetaResult | null> {
  try {
    const exif = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate'])
    const date = exif?.DateTimeOriginal ?? exif?.CreateDate
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return { ts: date.getTime(), src: 'meta-exif' }
    }
  } catch {
    // Falls through to lastModified.
  }
  return null
}

// exifr is image-only (jpg/tif/png/heic/avif/iiq per upstream docs) — calling
// it on a video silently returns undefined. So for video we go straight to a
// proper MP4/QuickTime box parse.
//
// Two-step strategy:
//   1. findMoovBox: walk only the top-level box HEADERS (8-16 bytes each) via
//      lazy Blob slicing to locate moov. Works for any file size and either
//      moov layout — faststart (moov first) OR encoder-default (moov last,
//      which is what iPhone .mov and most Android originals produce).
//   2. parseMoovCreationTime: read only the moov box bytes, then cascade
//      through Apple QuickTime keys → udta.©day → tkhd → mdhd → mvhd.
//
// Previous version read first 8MB + last 8MB and tried to find moov in both.
// The tail read was broken — it sliced mid-mdat (not on a box boundary), so
// the box walker interpreted random bytes as box headers and never found moov.
// That caused every iPhone .mov and every non-faststart MP4 to silently fall
// through to lastModified.
async function readVideoTimestamp(file: File): Promise<MetaResult | null> {
  const moov = await findMoovBox(file)
  if (!moov) return null
  const moovBuf = await file.slice(moov.offset, moov.offset + moov.size).arrayBuffer()
  return parseMoovCreationTime(moovBuf)
}

// Locates the top-level 'moov' box without loading the whole file. Walks box
// headers via lazy Blob slicing — total bytes read is O(num_top_level_boxes)
// which is typically <10 (ftyp, free?, mdat, moov). Returns null if the file
// isn't a parseable ISO BMFF / QuickTime container.
async function findMoovBox(
  file: File,
): Promise<{ offset: number; size: number } | null> {
  let offset = 0
  let count = 0
  // Sanity bound. Real files have a handful of top-level boxes; a runaway loop
  // here would point at file corruption, not legitimate structure.
  const MAX_TOP_LEVEL_BOXES = 100
  while (offset + 8 <= file.size && count++ < MAX_TOP_LEVEL_BOXES) {
    const headerLen = Math.min(16, file.size - offset)
    const buf = await file.slice(offset, offset + headerLen).arrayBuffer()
    if (buf.byteLength < 8) return null
    const dv = new DataView(buf)
    const size32 = dv.getUint32(0)
    const type = String.fromCharCode(
      dv.getUint8(4),
      dv.getUint8(5),
      dv.getUint8(6),
      dv.getUint8(7),
    )
    let totalSize: number
    if (size32 === 1) {
      // 64-bit extended size in the next 8 bytes. Needed for boxes >4GB
      // (typically mdat in very long 4K recordings).
      if (buf.byteLength < 16) return null
      const hi = dv.getUint32(8)
      const lo = dv.getUint32(12)
      totalSize = hi * 0x1_0000_0000 + lo
    } else if (size32 === 0) {
      // size=0 means "this box extends to end of file" — only valid as the
      // final top-level box. Either it's moov-at-end (we'll catch it below)
      // or it's mdat-at-end which we don't care about.
      totalSize = file.size - offset
    } else {
      totalSize = size32
    }
    if (totalSize < 8 || offset + totalSize > file.size) return null
    if (type === 'moov') return { offset, size: totalSize }
    offset += totalSize
  }
  return null
}

interface Box {
  dataOffset: number
  end: number
}

const SECONDS_BETWEEN_1904_AND_1970 = 2_082_844_800
// Reject timestamps that fall outside the era of digital cameras. Catches
// both the "creation_time field is zero" Android encoder bug (which decodes
// to 1904-01-01) and any field that defaulted to Unix epoch.
const MIN_VALID_MS = Date.UTC(2000, 0, 1)

// Parses an ISO-8601-ish date string (e.g. "2024-03-15T14:12:33-0700",
// "2024-03-15T14:12:33Z", "2024-03-15 14:12:33"). Returns ms or null.
function parseDateString(s: string): number | null {
  const trimmed = s.trim()
  if (!trimmed) return null
  let t = Date.parse(trimmed)
  if (Number.isFinite(t) && t >= MIN_VALID_MS && t <= Date.now() + 86_400_000) return t
  if (trimmed.includes(' ')) {
    t = Date.parse(trimmed.replace(' ', 'T'))
    if (Number.isFinite(t) && t >= MIN_VALID_MS && t <= Date.now() + 86_400_000) return t
  }
  return null
}

// Operates on a buffer containing exactly the moov box (header + body).
// Cascades through the metadata atoms in reliability order and returns the
// first valid timestamp + which atom produced it.
function parseMoovCreationTime(buf: ArrayBuffer): MetaResult | null {
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
    // Reject zero (the "encoder didn't have a clock" bug). Without this check
    // we'd return 1904-01-01 which the MIN_VALID_MS guard below also catches,
    // but rejecting zero explicitly is clearer.
    if (secs === 0) return null
    const ms = (secs - SECONDS_BETWEEN_1904_AND_1970) * 1000
    if (!Number.isFinite(ms) || ms < MIN_VALID_MS || ms > Date.now() + 86_400_000) {
      return null
    }
    return ms
  }

  // ISO BMFF 'meta' prefixes its children with 4 bytes of version+flags;
  // QuickTime 'meta' does not. Detect by peeking the first uint32.
  function metaChildrenStart(box: Box): number {
    if (box.dataOffset + 4 <= len && dv.getUint32(box.dataOffset) === 0) {
      return box.dataOffset + 4
    }
    return box.dataOffset
  }

  // Apple QuickTime metadata uses a keys/ilst pair. keys lists key names by
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
      const nameBytes = new Uint8Array(buf, cursor + 8, sz - 8)
      const name = new TextDecoder('utf-8').decode(nameBytes)
      if (name === 'com.apple.quicktime.creationdate') {
        targetIndex = i + 1 // 1-based
        break
      }
      cursor += sz
    }
    if (targetIndex < 0) return null

    return walkBoxes<number>(ilst.dataOffset, ilst.end, (_t, child) => {
      const hdrStart = child.dataOffset - 8
      if (hdrStart < 0 || hdrStart + 8 > len) return null
      const tagIndex = dv.getUint32(hdrStart + 4)
      if (tagIndex !== targetIndex) return null
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

  // 1. Apple QuickTime creationdate (gold standard for iPhone-origin files).
  const moovMeta = findBox(moov.dataOffset, moov.end, 'meta')
  if (moovMeta) {
    const ts = tryAppleCreationDate(moovMeta)
    if (ts != null) return { ts, src: 'meta-apple-key' }
  }

  // 2. Older Apple layout: moov.udta.meta with same key, plus '©day'.
  const udta = findBox(moov.dataOffset, moov.end, 'udta')
  if (udta) {
    const udtaMeta = findBox(udta.dataOffset, udta.end, 'meta')
    if (udtaMeta) {
      const ts = tryAppleCreationDate(udtaMeta)
      if (ts != null) return { ts, src: 'meta-apple-key' }
    }
    const dayTs = tryUdtaDay(udta)
    if (dayTs != null) return { ts: dayTs, src: 'meta-udta-day' }
  }

  // 3. Per-track tkhd. Often preserved when mvhd has been rewritten by a
  //    transcoder (Google Photos), because trak boxes weren't touched.
  const traks = findAllBoxes(moov.dataOffset, moov.end, 'trak')
  for (const trak of traks) {
    const tkhd = findBox(trak.dataOffset, trak.end, 'tkhd')
    if (tkhd) {
      const ts = readHeaderCreationTime(tkhd)
      if (ts != null) return { ts, src: 'meta-tkhd' }
    }
  }

  // 4. Per-track mdhd. Same idea as tkhd but inside trak.mdia.
  for (const trak of traks) {
    const mdia = findBox(trak.dataOffset, trak.end, 'mdia')
    if (mdia) {
      const mdhd = findBox(mdia.dataOffset, mdia.end, 'mdhd')
      if (mdhd) {
        const ts = readHeaderCreationTime(mdhd)
        if (ts != null) return { ts, src: 'meta-mdhd' }
      }
    }
  }

  // 5. Last resort: moov.mvhd. Frequently the FIRST atom a transcoder wipes,
  //    so it's the lowest-priority signal.
  const mvhd = findBox(moov.dataOffset, moov.end, 'mvhd')
  if (mvhd) {
    const ts = readHeaderCreationTime(mvhd)
    if (ts != null) return { ts, src: 'meta-mvhd' }
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
// Pass 3: paired-by-sort fallback, per-kind. When local filenames have been
//         rewritten by Android's MediaStore (OnePlus, Samsung, etc. all do
//         this — files arrive as 1000008XXX.mp4 even when Google Photos
//         still has the original camera filename), Pass 1/2 produce zero
//         matches. If the count of remaining-unmatched locals of a kind
//         equals the count of remaining-unmatched picker items of the same
//         kind, AND every unmatched local has a parseable trailing numeric
//         counter, we sort local by counter and picker by timestamp and pair
//         them index-by-index. Phone cameras increment counters in capture
//         order, so this recovers the right ordering when filenames don't
//         agree at all.
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

  // Pass 3: paired-by-sort fallback. See header comment for the heuristic.
  const kinds: MediaKind[] = ['image', 'video']
  for (const kind of kinds) {
    const localCandidates: Array<{ file: File; seq: number }> = []
    let canPair = true
    for (const file of files) {
      if (result.has(file)) continue
      if (kindOf(file) !== kind) continue
      const seq = extractFilenameSequence(file.name)
      if (seq == null) {
        // One unsorted local file would break the pairing. Skip this kind.
        canPair = false
        break
      }
      localCandidates.push({ file, seq })
    }
    if (!canPair || localCandidates.length === 0) continue

    const pickerCandidates: Array<{ m: PickerMetadata; i: number }> = []
    for (let i = 0; i < metadata.length; i++) {
      if (used.has(i)) continue
      if (metadata[i].kind !== kind) continue
      pickerCandidates.push({ m: metadata[i], i })
    }
    if (localCandidates.length !== pickerCandidates.length) continue

    localCandidates.sort((a, b) => a.seq - b.seq)
    pickerCandidates.sort((a, b) => a.m.timestamp - b.m.timestamp)
    for (let j = 0; j < localCandidates.length; j++) {
      result.set(localCandidates[j].file, pickerCandidates[j].m.timestamp)
      used.add(pickerCandidates[j].i)
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
  sizeBytes: number
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
  // Per-file probe data — printed once at the end so we can diagnose "no
  // metadata" complaints from a single console copy/paste.
  const probe: Array<{
    name: string
    kind: MediaKind
    sizeMB: string
    filenameDate: string | null
    metaSource: TimestampSource | 'none'
    metaIso: string | null
    final: TimestampSource
  }> = []
  for (const file of files) {
    const kind = classify(file)
    if (!kind) continue
    let source: TimestampSource
    let timestamp: number
    let probeFilenameDate: number | null = null
    let probeMeta: MetaResult | null = null
    const known = knownTimestamps?.get(file)
    if (known != null) {
      timestamp = known
      source = 'google-photos'
    } else {
      // Filename-encoded dates beat metadata: Google Photos / cloud syncs often
      // rewrite mvhd to processing time, so the original capture date survives
      // only in the filename (e.g. VID20260509100810.mp4).
      probeFilenameDate = parseFilenameDate(file.name)
      if (probeFilenameDate != null) {
        timestamp = probeFilenameDate
        source = 'filename'
      } else {
        probeMeta = kind === 'image' ? await readImageTimestamp(file) : await readVideoTimestamp(file)
        if (probeMeta != null) {
          timestamp = probeMeta.ts
          source = probeMeta.src
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
    probe.push({
      name: file.name,
      kind,
      sizeMB: (file.size / (1024 * 1024)).toFixed(2),
      filenameDate: probeFilenameDate != null ? new Date(probeFilenameDate).toISOString() : null,
      metaSource: probeMeta ? probeMeta.src : 'none',
      metaIso: probeMeta ? new Date(probeMeta.ts).toISOString() : null,
      final: source,
    })
  }

  // Strong-source items (anything but lastModified) sort by their real
  // timestamp. Weak-source items (lastModified) lose absolute timing — their
  // lastModified is just the download/access moment — but the filename's
  // trailing counter usually preserves relative capture order. Sort weak
  // items by that counter and append them after the strong items.
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
    sizeBytes: a.item.file.size,
  }))
  console.groupCollapsed(`[metadata] probed ${probe.length} files`)
  console.table(probe)
  console.table(diagnostics)
  console.groupEnd()
  return { items, diagnostics }
}
