export type MediaKind = 'image' | 'video'

export interface MediaItem {
  file: File
  kind: MediaKind
  timestamp: number
}

export type Orientation = 'landscape' | 'portrait'

export interface StitchOptions {
  orientation: Orientation
  imageDurationSeconds: number
}

export const DEFAULT_STITCH_OPTIONS: StitchOptions = {
  orientation: 'landscape',
  imageDurationSeconds: 3,
}

export const IMAGE_DURATION_MIN_S = 1
export const IMAGE_DURATION_MAX_S = 10

export type AppPhase =
  | { name: 'idle' }
  | { name: 'converting'; total: number; current: number }
  | { name: 'sorting'; total: number }
  | { name: 'review'; items: MediaItem[]; unreliableCount: number }
  | { name: 'ready'; items: MediaItem[] }
  | {
      name: 'reorder'
      items: MediaItem[]
      // Where the user came from. Determines Back / Save behavior.
      //   'review' → Save re-stitches, Back returns to review.
      //   'ready'  → Save returns to ready with new order, Back returns to ready.
      //   'done'   → Save returns to ready with new order, Back restores done snapshot.
      from: 'review' | 'ready' | 'done'
    }
  | { name: 'stitching'; total: number; current: number; ratio: number; options: StitchOptions }
  | { name: 'done'; blob: Blob; url: string }
  | { name: 'error'; message: string; details?: string }
