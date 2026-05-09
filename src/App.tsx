import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from './components/Header'
import { UploadZone } from './components/UploadZone'
import { Options } from './components/Options'
import { Progress } from './components/Progress'
import { DoneScreen } from './components/DoneScreen'
import { buildMediaItems } from './lib/metadata'
import { convertHeicFiles, isHeic } from './lib/convertHeic'
import { stitchMedia, isWebCodecsSupported } from './lib/pipeline'
import { saveBlob } from './lib/download'
import { checkWebCodecsCapability, summarize } from './lib/webcodecsCapability'
import { DEFAULT_STITCH_OPTIONS, type AppPhase, type StitchOptions } from './lib/types'

function App() {
  const [phase, setPhase] = useState<AppPhase>({ name: 'idle' })
  const [options, setOptions] = useState<StitchOptions>(DEFAULT_STITCH_OPTIONS)
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

  // One-shot WebCodecs capability probe on mount; logs to console.
  useEffect(() => {
    checkWebCodecsCapability().then((cap) => {
      console.log('[webcodecs] capability:\n' + summarize(cap))
      console.log('[webcodecs] raw:', cap)
    })
  }, [])

  const handleFiles = useCallback(async (files: File[]) => {
    try {
      const heicCount = files.filter(isHeic).length
      if (heicCount > 0) {
        setPhase({ name: 'converting', total: heicCount, current: 0 })
      }
      const prepared = await convertHeicFiles(files, ({ current, total }) => {
        setPhase({ name: 'converting', total, current })
      })
      setPhase({ name: 'sorting', total: prepared.length })
      const items = await buildMediaItems(prepared)
      if (items.length === 0) {
        setPhase({
          name: 'error',
          message: 'No supported images or videos found in your selection.',
        })
        return
      }
      setPhase({
        name: 'stitching',
        total: items.length + 1,
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

  const reset = useCallback(() => setPhase({ name: 'idle' }), [])

  return (
    <div className="min-h-full w-full bg-neutral-50">
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <Header />

        {phase.name === 'idle' && webCodecsSupported && (
          <>
            <Options value={options} onChange={setOptions} />
            <UploadZone onFiles={handleFiles} />
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
      </main>
      <footer className="pb-6 text-center text-xs text-neutral-400">
        v1.1
      </footer>
    </div>
  )
}

export default App
