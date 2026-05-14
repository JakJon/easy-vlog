import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'

// Use the multi-threaded core when SharedArrayBuffer is available
// (cross-origin isolated secure context — localhost or HTTPS with proper
// COOP/COEP headers). Falls back to the single-threaded core otherwise.
function pickCoreBase(): { base: string; mt: boolean } {
  const hasSAB =
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true
  return hasSAB
    ? { base: `${import.meta.env.BASE_URL}ffmpeg-mt`, mt: true }
    : { base: `${import.meta.env.BASE_URL}ffmpeg`, mt: false }
}

let instance: FFmpeg | null = null
let loadPromise: Promise<FFmpeg> | null = null

export async function getFFmpeg(): Promise<FFmpeg> {
  if (instance) return instance
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    const { base, mt } = pickCoreBase()
    const ff = new FFmpeg()
    const [coreURL, wasmURL, workerURL] = await Promise.all([
      toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      mt
        ? toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript')
        : Promise.resolve(undefined),
    ])
    await ff.load(mt ? { coreURL, wasmURL, workerURL } : { coreURL, wasmURL })
    instance = ff
    return ff
  })()

  return loadPromise
}
