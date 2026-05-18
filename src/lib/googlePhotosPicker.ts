import { getAccessToken } from './googleAuth'

// Google Photos Picker API — metadata-only flow. We use the picker SOLELY to
// retrieve the user's authoritative capture timestamps from Google's database;
// the actual file bytes come from the user's local upload (much faster than
// re-downloading from the Photos CDN, and the CORS-blocked video endpoint is
// avoided entirely).
//
// Flow:
//   1. Create a session.
//   2. Open the returned pickerUri so the user can pick items in Google's UI.
//      The caller pre-opens a blank window on the click to dodge popup blockers.
//   3. Poll until mediaItemsSet.
//   4. List the picked media items.
//   5. Return their { filename, mimeType, kind, timestamp } — no downloads.
//
// Matching local files to this metadata happens in src/lib/metadata.ts.

const API_BASE = 'https://photospicker.googleapis.com/v1'

export interface PickerMetadata {
  filename: string
  mimeType: string
  kind: 'image' | 'video'
  timestamp: number // ms since epoch
}

export interface PickerProgress {
  phase: 'auth' | 'session' | 'waiting' | 'listing'
  pickerUri?: string
}

interface PickerSession {
  id: string
  pickerUri: string
  mediaItemsSet?: boolean
  pollingConfig?: {
    pollInterval?: string // e.g. "5s"
    timeoutIn?: string
  }
}

interface MediaFileMetadata {
  width?: number
  height?: number
  cameraMake?: string
  cameraModel?: string
  creationTime?: string // ISO 8601
  videoMetadata?: { fps?: number; processingStatus?: string }
  photoMetadata?: unknown
}

interface MediaFile {
  baseUrl: string
  mimeType: string
  filename?: string
  mediaFileMetadata?: MediaFileMetadata
}

interface PickedMediaItem {
  id: string
  createTime?: string
  type?: 'PHOTO' | 'VIDEO' | 'TYPE_UNSPECIFIED'
  mediaFile?: MediaFile
}

interface ListMediaItemsResponse {
  mediaItems?: PickedMediaItem[]
  nextPageToken?: string
}

async function apiFetch<T>(
  path: string,
  init: RequestInit & { token: string },
): Promise<T> {
  const { token, headers, ...rest } = init
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Picker API ${path} failed: ${res.status} ${res.statusText} ${body}`)
  }
  return (await res.json()) as T
}

function parsePollIntervalSeconds(raw: string | undefined): number {
  if (!raw) return 3
  const m = raw.match(/^(\d+(?:\.\d+)?)s$/)
  if (!m) return 3
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : 3
}

function classifyType(mimeType: string, type?: string): 'image' | 'video' | null {
  if (type === 'PHOTO' || mimeType.startsWith('image/')) return 'image'
  if (type === 'VIDEO' || mimeType.startsWith('video/')) return 'video'
  return null
}

function filenameFor(item: PickedMediaItem): string {
  if (item.mediaFile?.filename) return item.mediaFile.filename
  const ext = item.mediaFile?.mimeType?.split('/')[1] ?? 'bin'
  return `${item.id}.${ext}`
}

// Main entrypoint. Drives the picker flow and returns just the metadata —
// crucially, no MediaItem byte downloads happen here. The picker URL is
// surfaced via the `waiting` progress event; the caller renders it as an
// anchor link the user taps. We deliberately do NOT open the picker window
// from here: programmatic `window.open` / `location.href` is blocked on iOS
// Safari outside a user gesture, and on Android it bypasses the OS app-link
// intent system (so the picker opens in the browser instead of the native
// Google Photos app). A user-initiated anchor click respects both.
export async function pickMetadataFromGooglePhotos(
  onProgress: (p: PickerProgress) => void,
  signal?: AbortSignal,
): Promise<PickerMetadata[]> {
  onProgress({ phase: 'auth' })
  const token = await getAccessToken()

  onProgress({ phase: 'session' })
  const session = await apiFetch<PickerSession>('/sessions', {
    method: 'POST',
    body: '{}',
    token,
  })

  onProgress({ phase: 'waiting', pickerUri: session.pickerUri })

  const pollSeconds = parsePollIntervalSeconds(session.pollingConfig?.pollInterval)
  const startedAt = Date.now()
  const POLL_TIMEOUT_MS = 15 * 60 * 1000

  let finalSession: PickerSession = session
  while (true) {
    if (signal?.aborted) throw new Error('Picker cancelled')
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error('Picker timed out waiting for selection.')
    }
    await new Promise((r) => setTimeout(r, pollSeconds * 1000))
    const next = await apiFetch<PickerSession>(`/sessions/${session.id}`, { token })
    if (next.mediaItemsSet) {
      finalSession = next
      break
    }
  }

  onProgress({ phase: 'listing' })
  const items: PickedMediaItem[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ sessionId: finalSession.id, pageSize: '100' })
    if (pageToken) params.set('pageToken', pageToken)
    const page = await apiFetch<ListMediaItemsResponse>(`/mediaItems?${params}`, { token })
    if (page.mediaItems) items.push(...page.mediaItems)
    pageToken = page.nextPageToken
  } while (pageToken)

  if (items.length === 0) {
    throw new Error('No items were selected in the picker.')
  }

  const out: PickerMetadata[] = []
  for (const item of items) {
    const mime = item.mediaFile?.mimeType ?? ''
    const kind = classifyType(mime, item.type)
    if (!kind) continue
    const creation = item.mediaFile?.mediaFileMetadata?.creationTime ?? item.createTime
    const ts = creation ? Date.parse(creation) : NaN
    if (!Number.isFinite(ts)) continue
    out.push({
      filename: filenameFor(item),
      mimeType: mime,
      kind,
      timestamp: ts,
    })
  }
  return out
}
