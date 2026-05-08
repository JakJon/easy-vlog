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
    console.log(
      `[ffmpeg] crossOriginIsolated=${typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated}, ` +
        `SAB=${typeof SharedArrayBuffer !== 'undefined'}, loading ${mt ? 'multi-threaded' : 'single-threaded'} core from ${base}`
    )
    const ff = new FFmpeg()
    ff.on('log', ({ message }) => {
      console.log('[ffmpeg-core]', message)
    })
    const t0 = performance.now()
    const [coreURL, wasmURL, workerURL] = await Promise.all([
      toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      mt
        ? toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript')
        : Promise.resolve(undefined),
    ])
    console.log(`[ffmpeg] blob URLs ready in ${Math.round(performance.now() - t0)}ms; calling ff.load()`)
    await ff.load(mt ? { coreURL, wasmURL, workerURL } : { coreURL, wasmURL })
    console.log(`[ffmpeg] core loaded in ${Math.round(performance.now() - t0)}ms`)
    instance = ff
    return ff
  })()

  return loadPromise
}
