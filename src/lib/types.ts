export type MediaKind = 'image' | 'video'

export interface MediaItem {
  file: File
  kind: MediaKind
  timestamp: number
}

export type AppPhase =
  | { name: 'idle' }
  | { name: 'converting'; total: number; current: number }
  | { name: 'sorting'; total: number }
  | { name: 'stitching'; total: number; current: number; ratio: number }
  | { name: 'done'; blob: Blob; url: string }
  | { name: 'error'; message: string; details?: string }
