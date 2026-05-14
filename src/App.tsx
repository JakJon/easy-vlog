import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from './components/Header'
import { UploadZone } from './components/UploadZone'
import { Options } from './components/Options'
import { DiagnosticsPanel } from './components/DiagnosticsPanel'
import { GooglePhotosButton } from './components/GooglePhotosButton'
import type { PickedMedia } from './lib/googlePhotosPicker'
import { Progress } from './components/Progress'
import { DoneScreen } from './components/DoneScreen'
import { buildMediaItems, type SortDiagnosticRow } from './lib/metadata'
import { convertHeicFiles, isHeic } from './lib/convertHeic'
import { stitchMedia, isWebCodecsSupported } from './lib/pipeline'
import { saveBlob } from './lib/download'
import { DEFAULT_STITCH_OPTIONS, type AppPhase, type StitchOptions } from './lib/types'

function App() {
  const [phase, setPhase] = useState<AppPhase>({ name: 'idle' })
  const [options, setOptions] = useState<StitchOptions>(DEFAULT_STITCH_OPTIONS)
  const [mobileOptionsOpen, setMobileOptionsOpen] = useState(false)
  const [diagnostics, setDiagnostics] = useState<SortDiagnosticRow[] | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  // Stitching is async; capture the latest options at the moment upload starts
  // so changes mid-flight don't retarget the in-progress encode.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const webCodecsSupported = isWebCodecsSupported()

  // Revoke any object URL when leaving the done state.
  useEffect(() => {
    return () => {
      if (phase.name === 'done') URL.revokeObjectURL(phase.url)
    }
  }, [phase])

  const handleFiles = useCallback(async (files: File[]) => {
    try {
      setDiagnostics(null)
      const heicCount = files.filter(isHeic).length
      if (heicCount > 0) {
        setPhase({ name: 'converting', total: heicCount, current: 0 })
      }
      const prepared = await convertHeicFiles(files, ({ current, total }) => {
        setPhase({ name: 'converting', total, current })
      })
      setPhase({ name: 'sorting', total: prepared.length })
      const { items, diagnostics: diag } = await buildMediaItems(prepared)
      setDiagnostics(diag)
      if (items.length === 0) {
        setPhase({
          name: 'error',
          message: 'No supported images or videos found in your selection.',
        })
        return
      }
      setPhase({
        name: 'stitching',
        total: items.length,
        current: 0,
        ratio: 0,
      })
      const blob = await stitchMedia(items, optionsRef.current, ({ current, total, ratio }) => {
        setPhase({ name: 'stitching', total, current, ratio })
      })
      const url = URL.createObjectURL(blob)
      setPhase({ name: 'done', blob, url })
    } catch (err) {
      console.error(err)
      const message =
        err instanceof Error ? err.message : 'Something went wrong.'
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
    }
  }, [])

  const handlePickerItems = useCallback(async (picked: PickedMedia[]) => {
    try {
      setDiagnostics(null)
      // HEIC handling — Google Photos almost always returns JPEG, but cover it
      // just in case a user has a "Save Originals" iCloud-pass-through workflow.
      const files = picked.map((p) => p.file)
      const heicCount = files.filter(isHeic).length
      if (heicCount > 0) {
        setPhase({ name: 'converting', total: heicCount, current: 0 })
      }
      const prepared = await convertHeicFiles(files, ({ current, total }) => {
        setPhase({ name: 'converting', total, current })
      })
      setPhase({ name: 'sorting', total: prepared.length })

      // Picker-sourced items already have authoritative timestamps from Google's
      // database. Build MediaItem[] directly and skip metadata extraction.
      const items = prepared
        .map((file, i) => ({
          file,
          kind: picked[i].kind,
          timestamp: picked[i].timestamp,
        }))
        .sort((a, b) => a.timestamp - b.timestamp)

      const diag: SortDiagnosticRow[] = items.map((it, i) => ({
        order: i,
        kind: it.kind,
        name: it.file.name,
        source: 'google-photos',
        iso: new Date(it.timestamp).toISOString(),
      }))
      setDiagnostics(diag)

      if (items.length === 0) {
        setPhase({
          name: 'error',
          message: 'No supported images or videos found in your selection.',
        })
        return
      }
      setPhase({
        name: 'stitching',
        total: items.length,
        current: 0,
        ratio: 0,
      })
      const blob = await stitchMedia(items, optionsRef.current, ({ current, total, ratio }) => {
        setPhase({ name: 'stitching', total, current, ratio })
      })
      const url = URL.createObjectURL(blob)
      setPhase({ name: 'done', blob, url })
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Something went wrong.'
      const details = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err)
      setPhase({ name: 'error', message, details })
    }
  }, [])

  const handlePickerError = useCallback((message: string) => {
    setPhase({ name: 'error', message })
  }, [])

  const reset = useCallback(() => setPhase({ name: 'idle' }), [])

  return (
    <div className="min-h-full w-full bg-neutral-50">
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <Header />

        {phase.name === 'idle' && webCodecsSupported && (
          <>
            <UploadZone onFiles={handleFiles} />
            <GooglePhotosButton onItems={handlePickerItems} onError={handlePickerError} />
            <div className="hidden sm:block mt-4">
              <Options value={options} onChange={setOptions} />
            </div>
            <div className="sm:hidden mt-4 rounded-2xl border border-neutral-200 bg-white">
              <button
                type="button"
                onClick={() => setMobileOptionsOpen((v) => !v)}
                aria-expanded={mobileOptionsOpen}
                aria-controls="mobile-options-panel"
                className="flex w-full items-center justify-between px-6 py-4 text-left"
              >
                <span className="text-sm font-medium text-neutral-700">
                  Options
                </span>
                <span
                  aria-hidden="true"
                  className={`text-neutral-400 transition-transform duration-200 ${
                    mobileOptionsOpen ? 'rotate-180' : ''
                  }`}
                >
                  ▾
                </span>
              </button>
              <div
                id="mobile-options-panel"
                className={`grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out ${
                  mobileOptionsOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                }`}
              >
                <div className="min-h-0 overflow-hidden">
                  <Options value={options} onChange={setOptions} bare />
                </div>
              </div>
            </div>
          </>
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
          <Progress
            label="Reading metadata and sorting..."
            current={1}
            total={phase.total}
            ratio={0.5}
          />
        )}

        {phase.name === 'stitching' && (
          <Progress
            label={
              phase.ratio >= 1
                ? 'Wrapping up...'
                : 'Stitching your video...'
            }
            current={phase.current}
            total={phase.total}
            ratio={phase.ratio}
          />
        )}

        {phase.name === 'done' && (
          <DoneScreen
            videoUrl={phase.url}
            onSave={() => saveBlob(phase.blob, 'easy-vlog.mp4')}
            onReset={reset}
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

        {showDiagnostics && diagnostics && diagnostics.length > 0 && (
          <DiagnosticsPanel rows={diagnostics} />
        )}
      </main>
      <footer className="pb-6 text-center text-xs text-neutral-400">
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          className="cursor-pointer hover:text-neutral-600 transition-colors"
          aria-label="Toggle sort diagnostics"
        >
          v1.2.0
        </button>
      </footer>
    </div>
  )
}

export default App
