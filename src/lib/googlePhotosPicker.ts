import { getAccessToken } from './googleAuth'

// Google Photos Picker API client. Flow:
//   1. Create a session.
//   2. Open the returned pickerUri in a popup so the user can pick items in
//      Google's hosted UI.
//   3. Poll the session endpoint until mediaItemsSet === true.
//   4. List the picked media items.
//   5. Download each item's bytes via baseUrl + "=d" with the same OAuth token.
//
// The mediaItem response includes mediaFile.mediaFileMetadata.creationTime,
// which is the original capture time straight from Google's database — the
// whole reason we built this integration.

const API_BASE = 'https://photospicker.googleapis.com/v1'

export interface PickedMedia {
  file: File
  kind: 'image' | 'video'
  timestamp: number // ms since epoch
}

export interface PickerProgress {
  phase: 'auth' | 'session' | 'waiting' | 'downloading'
  current?: number
  total?: number
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

// Videos go through our Netlify Edge Function because Google's Picker API
// 302-redirects them to video-downloads.googleusercontent.com, which doesn't
// send Access-Control-Allow-Origin and so blocks browser fetches. Photos are
// served directly with proper CORS so we hit lh3.googleusercontent.com.
const PROXY_PATH = '/api/photos-proxy'

async function downloadMediaItem(item: PickedMediaItem, token: string): Promise<File> {
  if (!item.mediaFile?.baseUrl) throw new Error('mediaItem missing baseUrl')
  // Per Picker API docs: photos use "=d" for original quality, videos use "=dv".
  const isVideo =
    item.type === 'VIDEO' || (item.mediaFile.mimeType?.startsWith('video/') ?? false)
  const suffix = isVideo ? '=dv' : '=d'
  const directUrl = `${item.mediaFile.baseUrl}${suffix}`
  const fetchUrl = isVideo
    ? `${PROXY_PATH}?url=${encodeURIComponent(directUrl)}`
    : directUrl
  const res = await fetch(fetchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`Failed to download ${item.id}: ${res.status} ${res.statusText}`)
  }
  const blob = await res.blob()
  return new File([blob], filenameFor(item), {
    type: item.mediaFile.mimeType ?? blob.type,
    lastModified: Date.now(),
  })
}

// Main entrypoint. Drives the whole flow. `onProgress` reports phase changes
// so the UI can show "Open the picker in Google Photos", "Downloading 3/5", etc.
// `signal` lets the caller cancel (e.g. user closes a dialog).
export async function pickFromGooglePhotos(
  onProgress: (p: PickerProgress) => void,
  signal?: AbortSignal,
): Promise<PickedMedia[]> {
  onProgress({ phase: 'auth' })
  const token = await getAccessToken()

  onProgress({ phase: 'session' })
  const session = await apiFetch<PickerSession>('/sessions', {
    method: 'POST',
    body: '{}',
    token,
  })

  // Open Google's hosted picker. New tab is more reliable than a popup on
  // mobile (popup blockers, iOS Safari, etc.).
  const opened = window.open(session.pickerUri, '_blank', 'noopener,noreferrer')
  onProgress({ phase: 'waiting', pickerUri: session.pickerUri })

  // Poll the session. Google recommends sticking to the server-provided
  // interval to avoid rate limits.
  const pollSeconds = parsePollIntervalSeconds(session.pollingConfig?.pollInterval)
  const startedAt = Date.now()
  const POLL_TIMEOUT_MS = 15 * 60 * 1000 // give the user 15 minutes to pick

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

  // Try to close the picker window if it's still ours to close.
  try {
    opened?.close()
  } catch {
    // ignore
  }

  // List items (paginated). Usually fits in one page for typical selections.
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

  // Download in parallel but with a concurrency cap to avoid hammering the API.
  const CONCURRENCY = 4
  const results: PickedMedia[] = new Array(items.length)
  let downloaded = 0
  onProgress({ phase: 'downloading', current: 0, total: items.length })

  let nextIndex = 0
  async function worker() {
    while (true) {
      if (signal?.aborted) throw new Error('Picker cancelled')
      const i = nextIndex++
      if (i >= items.length) return
      const item = items[i]
      const kind = classifyType(item.mediaFile?.mimeType ?? '', item.type)
      if (!kind) continue
      const file = await downloadMediaItem(item, token)
      const creation = item.mediaFile?.mediaFileMetadata?.creationTime ?? item.createTime
      const ts = creation ? Date.parse(creation) : Date.now()
      results[i] = {
        file,
        kind,
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
      }
      downloaded++
      onProgress({ phase: 'downloading', current: downloaded, total: items.length })
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker)
  await Promise.all(workers)
  // Filter out any entries left undefined (unrecognized type).
  return results.filter(Boolean)
}
