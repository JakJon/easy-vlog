import { useCallback, useRef, useState } from 'react'
import { Header } from './components/Header'
import { UploadZone } from './components/UploadZone'
import { Options } from './components/Options'
import { DiagnosticsPanel } from './components/DiagnosticsPanel'
import { PickerMetadataPanel } from './components/PickerMetadataPanel'
import { AudioLogPanel } from './components/AudioLogPanel'
import { ReviewScreen } from './components/ReviewScreen'
import { ReadyScreen } from './components/ReadyScreen'
import { ManualReorder } from './components/ManualReorder'
import { precachePreviews } from './components/Thumbnail'
import { Progress } from './components/Progress'
import { DoneScreen } from './components/DoneScreen'
import {
  buildMediaItems,
  matchFilesToPickerMetadata,
  type SortDiagnosticRow,
} from './lib/metadata'
import type { PickerMetadata } from './lib/googlePhotosPicker'
import { convertHeicFiles, isHeic } from './lib/convertHeic'
import { stitchMedia, isWebCodecsSupported } from './lib/pipeline'
import { saveBlob } from './lib/download'
import {
  DEFAULT_STITCH_OPTIONS,
  type AppPhase,
  type MediaItem,
  type StitchOptions,
} from './lib/types'

function summarizeOptions(o: StitchOptions): string {
  const orient = o.orientation === 'portrait' ? 'Portrait' : 'Landscape'
  return `${orient} · ${o.imageDurationSeconds}s per photo`
}

function App() {
  const [phase, setPhase] = useState<AppPhase>({ name: 'idle' })
  const [options, setOptions] = useState<StitchOptions>(DEFAULT_STITCH_OPTIONS)
  const [diagnostics, setDiagnostics] = useState<SortDiagnosticRow[] | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [lastMatchAttempt, setLastMatchAttempt] = useState<{
    pickerMetadata: PickerMetadata[]
    matchedCount: number
  } | null>(null)
  // Latest items used in the most recent stitch — needed when the user clicks
  // Edit > Sort on the done screen and we need the items list back.
  const lastItemsRef = useRef<MediaItem[] | null>(null)
  // Snapshot of the done state taken just before entering reorder from done.
  // Lets the Back arrow restore the previous video without re-stitching.
  const savedDoneRef = useRef<{ blob: Blob; url: string } | null>(null)
  const webCodecsSupported = isWebCodecsSupported()

  const runStitch = useCallback(
    async (items: MediaItem[], opts: StitchOptions) => {
      lastItemsRef.current = items
      setPhase({
        name: 'stitching',
        total: items.length,
        current: 0,
        ratio: 0,
        options: opts,
      })
      // Pre-extract thumbnails BEFORE the stitch reads (and on Android Chrome,
      // detaches) the underlying Files. Without this, Manual Reorder opened
      // after stitch shows IMG/VID placeholders.
      await precachePreviews(items.map((it) => ({ file: it.file, kind: it.kind })))
      const blob = await stitchMedia(items, opts, ({ current, total, ratio }) => {
        setPhase({ name: 'stitching', total, current, ratio, options: opts })
      })
      const url = URL.createObjectURL(blob)
      // We re-stitched, so the old saved-done snapshot is now obsolete.
      savedDoneRef.current = null
      setPhase({ name: 'done', blob, url })
    },
    [],
  )

  const reportError = useCallback((err: unknown) => {
    console.error(err)
    const message = err instanceof Error ? err.message : 'Something went wrong.'
    let details: string
    if (err instanceof Error) {
      details = err.stack ?? `${err.name}: ${err.message}`
    } else {
      try {
        details = JSON.stringify(err, null, 2)
      } catch {
        details = String(err)
      }
    }
    setPhase({ name: 'error', message, details })
  }, [])

  // Handle both initial upload (phase === 'idle') and "Upload more" from
  // ready/review/done. Existing items are appended to, never replaced — that
  // matches what the user asked for and the natural meaning of "more".
  const handleFiles = useCallback(
    async (newFiles: File[]) => {
      try {
        // Pull existing items + diagnostics from whatever phase we're in.
        let currentItems: MediaItem[] = []
        let currentDiag: SortDiagnosticRow[] = []
        if (phase.name === 'ready' || phase.name === 'review') {
          currentItems = phase.items
          currentDiag = diagnostics ?? []
        } else if (phase.name === 'done') {
          currentItems = lastItemsRef.current ?? []
          currentDiag = diagnostics ?? []
        }

        if (currentItems.length === 0) {
          setLastMatchAttempt(null)
        }

        const heicCount = newFiles.filter(isHeic).length
        if (heicCount > 0) {
          setPhase({ name: 'converting', total: heicCount, current: 0 })
        }
        const prepared = await convertHeicFiles(newFiles, ({ current, total }) => {
          setPhase({ name: 'converting', total, current })
        })
        setPhase({ name: 'sorting', total: prepared.length })
        const { items: newItems, diagnostics: newDiag } =
          await buildMediaItems(prepared)

        const combined = [...currentItems, ...newItems]
        if (combined.length === 0) {
          setPhase({
            name: 'error',
            message: 'No supported images or videos found in your selection.',
          })
          return
        }

        // Re-index diagnostics so order matches the combined items list.
        const combinedDiag: SortDiagnosticRow[] = [
          ...currentDiag.map((d, i) => ({ ...d, order: i })),
          ...newDiag.map((d, i) => ({
            ...d,
            order: currentItems.length + i,
          })),
        ]
        setDiagnostics(combinedDiag)

        // Fire-and-forget thumbnail precache for Manual Reorder.
        void precachePreviews(
          combined.map((it) => ({ file: it.file, kind: it.kind })),
        )
        // The set of items just changed — any saved Done snapshot is stale.
        savedDoneRef.current = null

        const unreliableCount = combinedDiag.filter(
          (d) => d.source === 'lastModified',
        ).length
        if (unreliableCount > 0) {
          setPhase({ name: 'review', items: combined, unreliableCount })
        } else {
          setPhase({ name: 'ready', items: combined })
        }
      } catch (err) {
        reportError(err)
      }
    },
    [phase, diagnostics, reportError],
  )

  const handleMatched = useCallback(
    async (metadata: PickerMetadata[]) => {
      if (phase.name !== 'review') return
      try {
        const allFiles = phase.items.map((it) => it.file)
        // Only match unreliable items — don't clobber correct EXIF photos.
        const filesToMatch: File[] = []
        for (let i = 0; i < phase.items.length; i++) {
          if (diagnostics?.[i]?.source === 'lastModified') {
            filesToMatch.push(phase.items[i].file)
          }
        }
        const known = matchFilesToPickerMetadata(filesToMatch, metadata)
        setLastMatchAttempt({
          pickerMetadata: metadata,
          matchedCount: known.size,
        })
        const { items, diagnostics: diag } = await buildMediaItems(allFiles, known)
        setDiagnostics(diag)

        const stillUnreliable = diag.filter(
          (d) => d.source === 'lastModified',
        ).length
        if (stillUnreliable > 0) {
          setPhase({ name: 'review', items, unreliableCount: stillUnreliable })
          return
        }
        // All resolved — proceed to Ready (user explicitly clicks Start to stitch).
        setPhase({ name: 'ready', items })
      } catch (err) {
        reportError(err)
      }
    },
    [phase, diagnostics, reportError],
  )

  // From the Hmm pane: skip sorting and stitch as-is. This is the explicit
  // escape hatch — we don't route through Ready because the user just clicked
  // "Continue anyway" to bypass it.
  const handleStitchAnyway = useCallback(async () => {
    if (phase.name !== 'review') return
    try {
      await runStitch(phase.items, options)
    } catch (err) {
      reportError(err)
    }
  }, [phase, options, runStitch, reportError])

  const handleStartFromReady = useCallback(async () => {
    if (phase.name !== 'ready') return
    try {
      await runStitch(phase.items, options)
    } catch (err) {
      reportError(err)
    }
  }, [phase, options, runStitch, reportError])

  // Enter manual reorder from various sources.
  const handleManualReorder = useCallback(() => {
    if (phase.name !== 'review') return
    setPhase({ name: 'reorder', items: phase.items, from: 'review' })
  }, [phase])

  const handleSortFromReady = useCallback(() => {
    if (phase.name !== 'ready') return
    setPhase({ name: 'reorder', items: phase.items, from: 'ready' })
  }, [phase])

  // Edit > Sort on the Done screen — snapshot done state so the Back arrow
  // can restore the existing video, then enter manual reorder.
  const handleSortFromDone = useCallback(() => {
    if (phase.name !== 'done') return
    const items = lastItemsRef.current
    if (!items) return
    savedDoneRef.current = { blob: phase.blob, url: phase.url }
    setPhase({ name: 'reorder', items, from: 'done' })
  }, [phase])

  const handleManualOrderDone = useCallback(
    async (reordered: MediaItem[]) => {
      if (phase.name !== 'reorder') return
      // Synthesize monotonically-increasing timestamps to match the user's
      // chosen order — the stitch pipeline iterates items[] directly, so the
      // exact values only need to preserve order.
      const base = Date.now()
      const ordered = reordered.map((item, i) => ({
        ...item,
        timestamp: base + i,
      }))
      const diag: SortDiagnosticRow[] = ordered.map((it, i) => ({
        order: i,
        kind: it.kind,
        name: it.file.name,
        source: 'google-photos',
        iso: new Date(it.timestamp).toISOString(),
        sizeBytes: it.file.size,
      }))
      setDiagnostics(diag)

      if (phase.from === 'review') {
        // Came from Hmm — user already declined extra steps, so re-stitch.
        try {
          await runStitch(ordered, options)
        } catch (err) {
          reportError(err)
        }
        return
      }
      // 'ready' or 'done' (Edit menu) → return to Ready with the new order.
      // The snapshotted Done becomes stale once we've changed the order.
      savedDoneRef.current = null
      setPhase({ name: 'ready', items: ordered })
    },
    [phase, options, runStitch, reportError],
  )

  const handleManualReorderCancel = useCallback(() => {
    if (phase.name !== 'reorder') return
    switch (phase.from) {
      case 'review': {
        const unreliable = diagnostics
          ? diagnostics.filter((d) => d.source === 'lastModified').length
          : phase.items.length
        setPhase({
          name: 'review',
          items: phase.items,
          unreliableCount: unreliable,
        })
        return
      }
      case 'ready': {
        setPhase({ name: 'ready', items: phase.items })
        return
      }
      case 'done': {
        if (savedDoneRef.current) {
          setPhase({
            name: 'done',
            blob: savedDoneRef.current.blob,
            url: savedDoneRef.current.url,
          })
          savedDoneRef.current = null
          return
        }
        setPhase({ name: 'idle' })
        return
      }
    }
  }, [phase, diagnostics])

  const reset = useCallback(() => {
    setPhase({ name: 'idle' })
    setDiagnostics(null)
    setLastMatchAttempt(null)
    lastItemsRef.current = null
    savedDoneRef.current = null
  }, [])

  return (
    <div className="min-h-full w-full bg-neutral-50">
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <Header />

        {phase.name === 'idle' && webCodecsSupported && (
          <UploadZone
            onFiles={handleFiles}
            footer={<Options value={options} onChange={setOptions} bare />}
          />
        )}

        {phase.name === 'idle' && !webCodecsSupported && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-8 py-10 text-center">
            <h3 className="text-lg font-semibold text-amber-800">
              Browser not supported
            </h3>
            <p className="mt-3 text-amber-700">
              Easy Vlog stitches your video entirely in the browser using
              WebCodecs, which this browser doesn&apos;t expose.
            </p>
            <p className="mt-2 text-amber-700">
              Open this page on a desktop in the latest Chrome or Edge to get
              started. Mobile Safari and some Android browsers don&apos;t yet
              support the API.
            </p>
          </div>
        )}

        {phase.name === 'converting' && (
          <Progress
            label="Converting HEIC photos..."
            current={phase.current}
            total={phase.total}
            ratio={1}
          />
        )}

        {phase.name === 'sorting' && (
          <div className="rounded-2xl border border-neutral-200 bg-white px-8 py-12 text-center">
            <h3 className="text-xl font-medium text-neutral-700">
              Getting your {phase.total} {phase.total === 1 ? 'item' : 'items'}{' '}
              ready.
            </h3>
          </div>
        )}

        {phase.name === 'review' && diagnostics && (
          <ReviewScreen
            totalCount={phase.items.length}
            unreliableCount={phase.unreliableCount}
            diagnostics={diagnostics}
            lastMatchAttempt={lastMatchAttempt}
            options={options}
            onOptionsChange={setOptions}
            onMatched={handleMatched}
            onManualReorder={handleManualReorder}
            onStitchAnyway={handleStitchAnyway}
            onUploadMore={handleFiles}
            onError={(message) => setPhase({ name: 'error', message })}
          />
        )}

        {phase.name === 'ready' && (
          <ReadyScreen
            itemCount={phase.items.length}
            options={options}
            onOptionsChange={setOptions}
            onStart={handleStartFromReady}
            onSort={handleSortFromReady}
            onUploadMore={handleFiles}
          />
        )}

        {phase.name === 'reorder' && (() => {
          // diagnostics[i] corresponds to phase.items[i] — build a Set of File
          // references whose timestamp came from file.lastModified so the
          // reorder UI can flag them in amber.
          const unreliableFiles = new Set<File>()
          if (diagnostics) {
            for (let i = 0; i < phase.items.length && i < diagnostics.length; i++) {
              if (diagnostics[i].source === 'lastModified') {
                unreliableFiles.add(phase.items[i].file)
              }
            }
          }
          return (
            <ManualReorder
              items={phase.items}
              onDone={handleManualOrderDone}
              onCancel={handleManualReorderCancel}
              isUnreliable={(item) => unreliableFiles.has(item.file)}
            />
          )
        })()}

        {phase.name === 'stitching' && (
          <Progress
            label={
              phase.current >= phase.total || phase.ratio >= 1
                ? 'Wrapping up...'
                : 'Stitching your video...'
            }
            current={phase.current}
            total={phase.total}
            ratio={phase.ratio}
            optionsSummary={summarizeOptions(phase.options)}
          />
        )}

        {phase.name === 'done' && (
          <DoneScreen
            videoUrl={phase.url}
            onSave={() => saveBlob(phase.blob, 'easy-vlog.mp4')}
            onReset={reset}
            onSort={handleSortFromDone}
            onUploadMore={handleFiles}
          />
        )}

        {phase.name === 'error' && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-8 py-10 text-center">
            <h3 className="text-lg font-semibold text-red-700">
              Something went wrong
            </h3>
            <p className="mt-2 text-red-600">{phase.message}</p>
            {phase.details && (
              <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-red-100 p-3 text-left text-xs text-red-900 select-all">
                {phase.details}
              </pre>
            )}
            <button
              type="button"
              onClick={reset}
              className="mt-6 rounded-full bg-emerald-500 px-6 py-2 text-white font-medium hover:bg-emerald-400 transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* Runtime log is always rendered (it self-hides when empty) so iOS
            users see audio-decode diagnostics without needing the version-
            click toggle that desktop debugging uses. */}
        <AudioLogPanel />

        {showDiagnostics && (
          <>
            {diagnostics && diagnostics.length > 0 && (
              <DiagnosticsPanel rows={diagnostics} />
            )}
            {lastMatchAttempt && lastMatchAttempt.pickerMetadata.length > 0 && (
              <PickerMetadataPanel
                items={lastMatchAttempt.pickerMetadata}
                matchedCount={lastMatchAttempt.matchedCount}
              />
            )}
          </>
        )}
      </main>
      <footer className="pb-6 text-center text-xs text-neutral-400">
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          className="cursor-pointer hover:text-neutral-600 transition-colors"
          aria-label="Toggle sort diagnostics"
        >
          v1.6.6
        </button>
      </footer>
    </div>
  )
}

export default App
