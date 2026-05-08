import { createFile, DataStream, Endianness, type MP4BoxBuffer, type Sample } from 'mp4box'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import type { MediaItem } from './types'

const TARGET_W = 1920
const TARGET_H = 1080
const TARGET_FPS = 30
const FRAME_DURATION_US = Math.round(1_000_000 / TARGET_FPS)
const TARGET_VIDEO_CODEC = 'avc1.640028' // H.264 High @ Level 4
const TARGET_VIDEO_BITRATE = 5_000_000
const TARGET_SAMPLE_RATE = 48_000
const TARGET_AUDIO_CHANNELS = 2
const TARGET_AUDIO_BITRATE = 128_000
const TARGET_AUDIO_CODEC = 'mp4a.40.2' // AAC LC
const IMAGE_DURATION_SECONDS = 3
const IMAGE_VIDEO_FRAMES = TARGET_FPS * IMAGE_DURATION_SECONDS
const AUDIO_CHUNK_SAMPLES = 1024 // matches AAC LC frame size

export interface StitchProgress {
  current: number
  total: number
  ratio: number
}

interface AsyncErrorBox {
  err: Error | null
}

export async function stitchMedia(
  items: MediaItem[],
  onProgress: (p: StitchProgress) => void,
): Promise<Blob> {
  if (items.length === 0) throw new Error('No media items to stitch.')

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    video: {
      codec: 'avc',
      width: TARGET_W,
      height: TARGET_H,
      frameRate: TARGET_FPS,
    },
    audio: {
      codec: 'aac',
      sampleRate: TARGET_SAMPLE_RATE,
      numberOfChannels: TARGET_AUDIO_CHANNELS,
    },
  })

  const errBox: AsyncErrorBox = { err: null }
  const propagate = (e: unknown) => {
    if (!errBox.err) errBox.err = e instanceof Error ? e : new Error(String(e))
    console.error('[webcodecs]', e)
  }

  let videoEncodedChunks = 0
  let videoMetaWithDecoderConfig = 0
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      videoEncodedChunks++
      if (meta?.decoderConfig) videoMetaWithDecoderConfig++
      if (videoEncodedChunks === 1) {
        console.log('[webcodecs] first encoded video chunk', {
          type: chunk.type,
          byteLength: chunk.byteLength,
          hasDecoderConfig: !!meta?.decoderConfig,
          codec: meta?.decoderConfig?.codec,
          colorSpace: meta?.decoderConfig?.colorSpace,
        })
      }
      muxer.addVideoChunk(chunk, meta)
    },
    error: propagate,
  })
  videoEncoder.configure({
    codec: TARGET_VIDEO_CODEC,
    width: TARGET_W,
    height: TARGET_H,
    bitrate: TARGET_VIDEO_BITRATE,
    framerate: TARGET_FPS,
    // 'no-preference' lets the browser pick. On Windows the H.264 hardware
    // encoder occasionally returns OperationError under burst loads, which
    // cascades and tears down the HEVC decoder too. Software fallback is
    // more reliable.
    hardwareAcceleration: 'no-preference',
    avc: { format: 'avc' },
  })

  let audioEncodedChunks = 0
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      audioEncodedChunks++
      muxer.addAudioChunk(chunk, meta)
    },
    error: propagate,
  })
  audioEncoder.configure({
    codec: TARGET_AUDIO_CODEC,
    sampleRate: TARGET_SAMPLE_RATE,
    numberOfChannels: TARGET_AUDIO_CHANNELS,
    bitrate: TARGET_AUDIO_BITRATE,
  })

  const canvas = new OffscreenCanvas(TARGET_W, TARGET_H)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Failed to acquire 2D canvas context')

  // Determine total expected duration so we can drive a meaningful progress bar.
  const itemDurations: number[] = []
  for (const item of items) {
    if (item.kind === 'image') {
      itemDurations.push(IMAGE_DURATION_SECONDS)
    } else {
      try {
        itemDurations.push(await readVideoDurationSeconds(item.file))
      } catch {
        itemDurations.push(5)
      }
    }
  }
  const totalUs = Math.max(1, Math.round(itemDurations.reduce((a, b) => a + b, 0) * 1_000_000))
  let processedUs = 0
  const total = items.length + 1
  let lastReported = -1
  const reportProgress = (current: number) => {
    const ratio = Math.min(1, processedUs / totalUs)
    if (Math.abs(ratio - lastReported) >= 0.005 || current === total) {
      lastReported = ratio
      onProgress({ current, total, ratio })
    }
  }

  let outputVideoUs = 0
  let outputAudioSamples = 0

  try {
    for (let i = 0; i < items.length; i++) {
      if (errBox.err) throw errBox.err
      const item = items[i]
      reportProgress(i + 1)
      if (item.kind === 'image') {
        await processImage({
          file: item.file,
          ctx,
          canvas,
          videoEncoder,
          audioEncoder,
          videoStartUs: outputVideoUs,
          audioStartSamples: outputAudioSamples,
          tickUs: () => {
            processedUs += FRAME_DURATION_US
            reportProgress(i + 1)
          },
          errBox,
        })
        outputVideoUs += IMAGE_VIDEO_FRAMES * FRAME_DURATION_US
        outputAudioSamples += TARGET_SAMPLE_RATE * IMAGE_DURATION_SECONDS
      } else {
        const result = await processVideo({
          file: item.file,
          ctx,
          canvas,
          videoEncoder,
          audioEncoder,
          videoStartUs: outputVideoUs,
          audioStartSamples: outputAudioSamples,
          tickUs: (delta: number) => {
            processedUs += delta
            reportProgress(i + 1)
          },
          propagate,
          errBox,
        })
        outputVideoUs = result.videoTsUs
        outputAudioSamples = result.audioSamples
      }
    }

    if (errBox.err) throw errBox.err
    await videoEncoder.flush()
    await audioEncoder.flush()
    if (errBox.err) throw errBox.err
    console.log('[webcodecs] totals', {
      videoEncodedChunks,
      videoMetaWithDecoderConfig,
      audioEncodedChunks,
    })
  } finally {
    try { videoEncoder.close() } catch { /* ignore */ }
    try { audioEncoder.close() } catch { /* ignore */ }
  }

  muxer.finalize()
  processedUs = totalUs
  reportProgress(total)

  const buffer = (muxer.target as ArrayBufferTarget).buffer
  return new Blob([buffer], { type: 'video/mp4' })
}

// --------- Image segment ---------

interface ImageOpts {
  file: File
  ctx: OffscreenCanvasRenderingContext2D
  canvas: OffscreenCanvas
  videoEncoder: VideoEncoder
  audioEncoder: AudioEncoder
  videoStartUs: number
  audioStartSamples: number
  tickUs: () => void
  errBox: AsyncErrorBox
}

async function processImage(opts: ImageOpts): Promise<void> {
  const { file, ctx, canvas, videoEncoder, audioEncoder, videoStartUs, audioStartSamples, tickUs, errBox } = opts
  const bitmap = await createImageBitmap(file)
  try {
    drawContain(ctx, bitmap, canvas.width, canvas.height, 0)
  } finally {
    bitmap.close()
  }

  for (let f = 0; f < IMAGE_VIDEO_FRAMES; f++) {
    if (errBox.err) throw errBox.err
    await waitForVideoQueue(videoEncoder)
    const ts = videoStartUs + f * FRAME_DURATION_US
    const frame = new VideoFrame(canvas, { timestamp: ts, duration: FRAME_DURATION_US })
    videoEncoder.encode(frame, { keyFrame: f === 0 })
    frame.close()
    tickUs()
  }

  // Silence at TARGET_SAMPLE_RATE × TARGET_AUDIO_CHANNELS for IMAGE_DURATION_SECONDS.
  const totalSamples = TARGET_SAMPLE_RATE * IMAGE_DURATION_SECONDS
  let offset = 0
  while (offset < totalSamples) {
    if (errBox.err) throw errBox.err
    const samples = Math.min(AUDIO_CHUNK_SAMPLES, totalSamples - offset)
    const data = new Float32Array(samples * TARGET_AUDIO_CHANNELS) // zero-filled
    const ts = Math.round(((audioStartSamples + offset) / TARGET_SAMPLE_RATE) * 1_000_000)
    await waitForAudioQueue(audioEncoder)
    const audioData = new AudioData({
      format: 'f32',
      sampleRate: TARGET_SAMPLE_RATE,
      numberOfChannels: TARGET_AUDIO_CHANNELS,
      numberOfFrames: samples,
      timestamp: ts,
      data,
    })
    audioEncoder.encode(audioData)
    audioData.close()
    offset += samples
  }
}

// --------- Video segment ---------

interface VideoOpts {
  file: File
  ctx: OffscreenCanvasRenderingContext2D
  canvas: OffscreenCanvas
  videoEncoder: VideoEncoder
  audioEncoder: AudioEncoder
  videoStartUs: number
  audioStartSamples: number
  tickUs: (deltaUs: number) => void
  propagate: (e: unknown) => void
  errBox: AsyncErrorBox
}

async function processVideo(
  opts: VideoOpts,
): Promise<{ videoTsUs: number; audioSamples: number }> {
  // Read file once so we can use the raw bytes for codec description AND
  // for audio decoding without re-reading.
  const fileBytes = await opts.file.arrayBuffer()
  const [videoResult, audioResult] = await Promise.all([
    processVideoFrames(opts, fileBytes),
    processVideoAudio(opts, fileBytes),
  ])
  return { videoTsUs: videoResult, audioSamples: audioResult }
}

async function processVideoFrames(
  opts: VideoOpts,
  fileBytes: ArrayBuffer,
): Promise<number> {
  const { ctx, canvas, videoEncoder, videoStartUs, tickUs, propagate, errBox } = opts

  return new Promise<number>((resolve, reject) => {
    let framesEmitted = 0
    let framesDecoded = 0
    let chunksDecoded = 0
    let rotation = 0
    const decoderRef: { current: VideoDecoder | null } = { current: null }
    let videoTrackId: number | null = null
    let configured = false
    // mp4box.js calls onReady → processSamples synchronously inside appendBuffer,
    // so we must call setExtractionOptions+start() synchronously from onReady or
    // samples will never be emitted. The decoder config probe is async, though,
    // so we buffer samples until the decoder is ready.
    const pendingSamples: Sample[] = []
    let decoderReadyResolve!: () => void
    let decoderReadyReject!: (e: Error) => void
    const decoderReady = new Promise<void>((res, rej) => {
      decoderReadyResolve = res
      decoderReadyReject = rej
    })
    let hasVideoTrack = false
    // The decoder's `output` callback is synchronous, so we can't `await`
    // encoder backpressure inline. Chain the per-frame draw+encode work onto
    // an async tail so each step waits for the previous to finish; this
    // serializes work and lets us await waitForVideoQueue between frames
    // without blocking the decoder thread.
    let drawTail: Promise<void> = Promise.resolve()

    const mp4 = createFile()

    mp4.onError = (msg: string) => reject(new Error('mp4box: ' + msg))

    const decodeSample = (s: Sample) => {
      if (!s.data || !decoderRef.current) return
      decoderRef.current.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.max(0, (s.cts * 1_000_000) / s.timescale),
          duration: (s.duration * 1_000_000) / s.timescale,
          data: s.data,
        }),
      )
      chunksDecoded++
    }

    mp4.onReady = (info) => {
      try {
        const videoTrack = info.tracks.find((t) => t.type === 'video')
        if (!videoTrack) {
          decoderReadyResolve()
          return
        }
        hasVideoTrack = true
        videoTrackId = videoTrack.id
        rotation = computeRotation(videoTrack.matrix as number[] | undefined)

        const trak = mp4.getTrackById(videoTrack.id) as unknown as TrakWithStsd
        const description = extractVideoDescription(trak, videoTrack.codec, fileBytes)
        const codedWidth = (videoTrack.video as { width: number }).width
        const codedHeight = (videoTrack.video as { height: number }).height
        const rawMp4Codec = videoTrack.codec
        const mp4Codec = fixCodecStringCase(rawMp4Codec)
        const normalizedCodec = normalizeCodecString(rawMp4Codec)

        console.log(
          '[webcodecs] mp4 codec=',
          rawMp4Codec,
          '→ case-fixed:',
          mp4Codec,
          '→ normalized (Main tier):',
          normalizedCodec,
        )
        if (description) {
          console.log('[webcodecs] description (first 32 bytes):', hexBytes(description, 32))
          console.log('[webcodecs] description.length=', description.byteLength)
        }
        console.log('[webcodecs] codedW/H rotation:', codedWidth, codedHeight, rotation)

        // Synchronously enable sample extraction so mp4box emits samples
        // during this same appendBuffer call. We'll buffer them in onSamples
        // until the decoder is configured.
        mp4.setExtractionOptions(videoTrack.id, null, { nbSamples: 64 })
        mp4.start()

        // Asynchronously probe + configure the decoder, then drain pending samples.
        void (async () => {
          try {
            const chosen = await findWorkingDecoderConfig(
              mp4Codec,
              normalizedCodec,
              codedWidth,
              codedHeight,
              description,
            )
            if (!chosen) {
              throw new Error(
                `No VideoDecoder configuration accepted for ${mp4Codec}. ` +
                  `Browser cannot decode this stream.`,
              )
            }
            console.log('[webcodecs] using decoder config', {
              codec: chosen.codec,
              hardwareAcceleration: chosen.hardwareAcceleration,
              withDescription: !!chosen.description,
            })

            decoderRef.current = new VideoDecoder({
              output: (frame) => {
                framesDecoded++
                if (errBox.err) {
                  frame.close()
                  return
                }
                // Chain the encode step onto drawTail so we can apply
                // encoder-queue backpressure asynchronously.
                drawTail = drawTail.then(async () => {
                  try {
                    if (errBox.err) {
                      frame.close()
                      return
                    }
                    drawContain(ctx, frame, canvas.width, canvas.height, rotation)
                    frame.close()
                    await waitForVideoQueue(videoEncoder)
                    if (errBox.err) return
                    const ts = videoStartUs + framesEmitted * FRAME_DURATION_US
                    const out = new VideoFrame(canvas, {
                      timestamp: ts,
                      duration: FRAME_DURATION_US,
                    })
                    videoEncoder.encode(out, { keyFrame: framesEmitted === 0 })
                    out.close()
                    framesEmitted++
                    tickUs(FRAME_DURATION_US)
                  } catch (e) {
                    propagate(e)
                  }
                })
              },
              error: (e) => {
                console.error('[webcodecs] VideoDecoder error', e)
                propagate(e)
              },
            })
            decoderRef.current.configure(chosen)
            configured = true

            // Drain the samples mp4box already emitted while we were probing.
            for (const s of pendingSamples) decodeSample(s)
            pendingSamples.length = 0
            decoderReadyResolve()
          } catch (e) {
            console.error('[webcodecs] decoder setup failed', e)
            decoderReadyReject(e instanceof Error ? e : new Error(String(e)))
          }
        })()
      } catch (e) {
        console.error('[webcodecs] onReady failed', e)
        decoderReadyReject(e instanceof Error ? e : new Error(String(e)))
      }
    }

    let firstChunkLogged = false
    mp4.onSamples = (id, _user, samples: Sample[]) => {
      try {
        if (id !== videoTrackId) return
        for (const s of samples) {
          if (!s.data) continue
          if (!firstChunkLogged) {
            firstChunkLogged = true
            console.log('[webcodecs] first chunk', {
              isKey: s.is_sync,
              size: s.data.byteLength,
              cts: s.cts,
              timescale: s.timescale,
              first16: hexBytes(s.data, 16),
            })
          }
          if (configured && decoderRef.current) {
            decodeSample(s)
          } else {
            pendingSamples.push(s)
          }
        }
      } catch (e) {
        console.error('[webcodecs] onSamples decode failed', e)
        propagate(e)
      }
    }

    void (async () => {
      try {
        const mp4buf = fileBytes.slice(0) as MP4BoxBuffer
        ;(mp4buf as MP4BoxBuffer).fileStart = 0
        mp4.appendBuffer(mp4buf)
        // Wait for the decoder probe (started inside onReady) to finish.
        await decoderReady
        // Flush any remaining samples mp4box has buffered. Decoder is now ready,
        // so onSamples will decode them directly.
        mp4.flush()
        const dec: VideoDecoder | null = decoderRef.current
        if (dec) {
          await dec.flush()
          dec.close()
        }
        // Wait for the serialized draw+encode tail to finish before resolving;
        // dec.flush() only guarantees decoder output callbacks have fired, not
        // that the chained encode work has completed.
        await drawTail
        console.log('[webcodecs] processVideoFrames done', {
          chunksDecoded,
          framesDecoded,
          framesEmitted,
          configured,
          hasVideoTrack,
        })
        if (hasVideoTrack && framesEmitted === 0) {
          throw new Error(
            'Video track decoded 0 frames. The browser configured a decoder ' +
              'but produced no output — the file may use an unsupported HEVC ' +
              'profile/tier or a corrupt bitstream.',
          )
        }
        resolve(videoStartUs + framesEmitted * FRAME_DURATION_US)
      } catch (e) {
        console.error('[webcodecs] decode pipeline failed', e)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  })
}

async function processVideoAudio(
  opts: VideoOpts,
  fileBytes: ArrayBuffer,
): Promise<number> {
  const { file, audioEncoder, audioStartSamples, errBox } = opts

  // Decode the entire audio track from the input file via Web Audio.
  // This handles AAC/MP4 natively and resamples to TARGET_SAMPLE_RATE.
  let decoded: AudioBuffer
  try {
    decoded = await decodeAndResampleAudio(
      fileBytes,
      TARGET_SAMPLE_RATE,
      TARGET_AUDIO_CHANNELS,
    )
  } catch (e) {
    console.warn('[webcodecs] audio decode failed, substituting silence', e)
    // No audio or decode failed — emit silence covering the video duration.
    const seconds = await readVideoDurationSeconds(file).catch(() => 0)
    return emitSilence(opts.audioEncoder, audioStartSamples, Math.round(seconds * TARGET_SAMPLE_RATE))
  }

  const totalSamples = decoded.length
  const channelData: Float32Array[] = []
  for (let ch = 0; ch < TARGET_AUDIO_CHANNELS; ch++) {
    const srcCh = ch < decoded.numberOfChannels ? ch : 0
    channelData.push(decoded.getChannelData(srcCh))
  }

  let offset = 0
  while (offset < totalSamples) {
    if (errBox.err) throw errBox.err
    const samples = Math.min(AUDIO_CHUNK_SAMPLES, totalSamples - offset)
    const interleaved = new Float32Array(samples * TARGET_AUDIO_CHANNELS)
    for (let i = 0; i < samples; i++) {
      for (let ch = 0; ch < TARGET_AUDIO_CHANNELS; ch++) {
        interleaved[i * TARGET_AUDIO_CHANNELS + ch] = channelData[ch][offset + i]
      }
    }
    const ts = Math.round(((audioStartSamples + offset) / TARGET_SAMPLE_RATE) * 1_000_000)
    await waitForAudioQueue(audioEncoder)
    const audioData = new AudioData({
      format: 'f32',
      sampleRate: TARGET_SAMPLE_RATE,
      numberOfChannels: TARGET_AUDIO_CHANNELS,
      numberOfFrames: samples,
      timestamp: ts,
      data: interleaved,
    })
    audioEncoder.encode(audioData)
    audioData.close()
    offset += samples
  }
  return audioStartSamples + totalSamples
}

async function emitSilence(
  audioEncoder: AudioEncoder,
  audioStartSamples: number,
  totalSamples: number,
): Promise<number> {
  let offset = 0
  while (offset < totalSamples) {
    const samples = Math.min(AUDIO_CHUNK_SAMPLES, totalSamples - offset)
    const data = new Float32Array(samples * TARGET_AUDIO_CHANNELS)
    const ts = Math.round(((audioStartSamples + offset) / TARGET_SAMPLE_RATE) * 1_000_000)
    await waitForAudioQueue(audioEncoder)
    const audioData = new AudioData({
      format: 'f32',
      sampleRate: TARGET_SAMPLE_RATE,
      numberOfChannels: TARGET_AUDIO_CHANNELS,
      numberOfFrames: samples,
      timestamp: ts,
      data,
    })
    audioEncoder.encode(audioData)
    audioData.close()
    offset += samples
  }
  return audioStartSamples + totalSamples
}

// --------- Helpers ---------

async function readVideoDurationSeconds(file: File): Promise<number> {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<number>((resolve, reject) => {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.muted = true
      v.onloadedmetadata = () => {
        if (Number.isFinite(v.duration) && v.duration > 0) resolve(v.duration)
        else resolve(5)
      }
      v.onerror = () => reject(new Error('Video metadata read failed'))
      v.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function decodeAndResampleAudio(
  fileBytes: ArrayBuffer,
  targetRate: number,
  targetChannels: number,
): Promise<AudioBuffer> {
  // Use a temporary AudioContext to decode at native rate, then render
  // through OfflineAudioContext at targetRate to resample.
  const tmpCtx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await tmpCtx.decodeAudioData(fileBytes.slice(0))
  } finally {
    tmpCtx.close()
  }
  if (
    decoded.sampleRate === targetRate &&
    decoded.numberOfChannels === targetChannels
  ) {
    return decoded
  }
  const offline = new OfflineAudioContext({
    numberOfChannels: targetChannels,
    length: Math.ceil((decoded.length / decoded.sampleRate) * targetRate),
    sampleRate: targetRate,
  })
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  return await offline.startRendering()
}

function drawContain(
  ctx: OffscreenCanvasRenderingContext2D,
  source: ImageBitmap | VideoFrame,
  targetW: number,
  targetH: number,
  rotation: number,
): void {
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, targetW, targetH)

  const srcW = 'displayWidth' in source ? source.displayWidth : source.width
  const srcH = 'displayHeight' in source ? source.displayHeight : source.height

  const isQuarterTurn = rotation === 90 || rotation === 270 || rotation === -90 || rotation === -270
  const effW = isQuarterTurn ? srcH : srcW
  const effH = isQuarterTurn ? srcW : srcH

  const scale = Math.min(targetW / effW, targetH / effH)
  const drawW = srcW * scale
  const drawH = srcH * scale

  ctx.save()
  ctx.translate(targetW / 2, targetH / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.drawImage(source as unknown as CanvasImageSource, -drawW / 2, -drawH / 2, drawW, drawH)
  ctx.restore()
}

function computeRotation(matrix: number[] | undefined): number {
  if (!matrix || matrix.length < 9) return 0
  // MP4 transformation matrix: 16.16 fixed point for 0..7, 2.30 for 8.
  // We only need the rotation from the upper-left 2x2.
  const a = matrix[0] / 65536
  const b = matrix[1] / 65536
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI)
  // Normalize to {0, 90, 180, 270}
  const norm = ((deg % 360) + 360) % 360
  if (norm === 0 || norm === 90 || norm === 180 || norm === 270) return norm
  // Snap to nearest 90.
  return Math.round(norm / 90) * 90
}

interface PositionedBox {
  start: number
  size: number
  hdr_size: number
  write?: (s: DataStream) => void
}

interface TrakWithStsd {
  mdia?: {
    minf?: {
      stbl?: {
        stsd?: {
          entries?: Array<{
            avcC?: PositionedBox
            hvcC?: PositionedBox
            vpcC?: PositionedBox
            av1C?: PositionedBox
          }>
        }
      }
    }
  }
}

function extractVideoDescription(
  trak: TrakWithStsd,
  codec: string,
  fileBytes: ArrayBuffer,
): Uint8Array | undefined {
  const entries = trak.mdia?.minf?.stbl?.stsd?.entries
  if (!entries || entries.length === 0) return undefined
  const entry = entries[0]
  let box: PositionedBox | undefined
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) {
    box = entry.avcC
  } else if (codec.startsWith('hvc1') || codec.startsWith('hev1')) {
    box = entry.hvcC
  } else if (codec.startsWith('vp')) {
    box = entry.vpcC
  } else if (codec.startsWith('av01')) {
    box = entry.av1C
  }
  if (!box) return undefined

  // Prefer pulling the raw bytes from the original file at the box's offset.
  // This avoids any subtle differences between mp4box's re-serializer and
  // what the original encoder wrote.
  if (
    typeof box.start === 'number' &&
    typeof box.size === 'number' &&
    typeof box.hdr_size === 'number' &&
    box.size > box.hdr_size &&
    box.start + box.size <= fileBytes.byteLength
  ) {
    return new Uint8Array(
      fileBytes,
      box.start + box.hdr_size,
      box.size - box.hdr_size,
    )
  }

  // Fallback: re-serialize via box.write() and slice off the 8-byte header.
  if (typeof box.write !== 'function') return undefined
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN)
  box.write(stream)
  return new Uint8Array(stream.buffer, 8)
}

async function findWorkingDecoderConfig(
  mp4Codec: string,
  normalizedCodec: string,
  codedWidth: number,
  codedHeight: number,
  description: Uint8Array | undefined,
): Promise<VideoDecoderConfig | null> {
  const accelModes: HardwareAcceleration[] = [
    'no-preference',
    'prefer-software',
    'prefer-hardware',
  ]

  // Build a list of (codec, description) candidates that are internally
  // consistent — the codec string describes the same profile/tier as the
  // description bytes. Inconsistent pairs are dangerous: isConfigSupported
  // sometimes returns true for them, but actual decoding throws EncodingError
  // when the bitstream's parameter sets contradict the codec string.
  type Candidate = { codec: string; description?: Uint8Array; label: string }
  const candidates: Candidate[] = []

  // 1. Original codec + original description — derived from the same hvcC
  //    bytes, so they always agree. Best first choice.
  candidates.push({ codec: mp4Codec, description, label: 'orig codec + orig desc' })

  // 2. Normalized (Main-tier) codec + Main-tier-forced description, if the
  //    original was High tier. Both pieces agree at Main tier; some hardware
  //    decoders only advertise Main-tier support but can still play streams
  //    whose only High-tier feature is the flag itself.
  const isHevc = mp4Codec.startsWith('hvc1') || mp4Codec.startsWith('hev1')
  if (
    isHevc &&
    normalizedCodec !== mp4Codec &&
    description &&
    description.length > 1 &&
    (description[1] & 0x20) !== 0
  ) {
    candidates.push({
      codec: normalizedCodec,
      description: forceMainTierDescription(description),
      label: 'normalized codec + forced-Main desc',
    })
  }

  // 3. Original codec without description — last-ditch attempt; some browsers
  //    can find SPS/PPS in-band.
  candidates.push({ codec: mp4Codec, description: undefined, label: 'orig codec, no desc' })

  // 4. Normalized codec without description.
  if (normalizedCodec !== mp4Codec) {
    candidates.push({
      codec: normalizedCodec,
      description: undefined,
      label: 'normalized codec, no desc',
    })
  }

  for (const cand of candidates) {
    for (const accel of accelModes) {
      const cfg: VideoDecoderConfig = {
        codec: cand.codec,
        codedWidth,
        codedHeight,
        description: cand.description,
        hardwareAcceleration: accel,
      }
      try {
        const r = await VideoDecoder.isConfigSupported(cfg)
        if (r.supported && r.config) {
          console.log('[webcodecs] config accepted:', cand.label, accel)
          return r.config
        }
        console.log('[webcodecs] not supported:', cand.label, accel)
      } catch (e) {
        console.warn('[webcodecs] isConfigSupported threw:', cand.label, accel, e)
      }
    }
  }
  return null
}

function forceMainTierDescription(desc: Uint8Array): Uint8Array {
  const copy = new Uint8Array(desc.length)
  copy.set(desc)
  // hvcC byte 1: bits = profile_space(2) | tier_flag(1) | profile_idc(5)
  copy[1] = copy[1] & 0xdf
  return copy
}

function hexBytes(buf: ArrayBufferView, max: number): string {
  const view = new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, max))
  return Array.from(view, (b) => b.toString(16).padStart(2, '0')).join(' ')
}

// mp4box emits strings like 'hvc1.1.6.H120.b0' with lowercase constraint flag
// bytes; WebCodecs wants them uppercase. Just fix the case — preserve the
// tier (H/L) since it must match the description bytes the decoder is fed.
function fixCodecStringCase(codec: string): string {
  if (!codec.startsWith('hvc1') && !codec.startsWith('hev1')) return codec
  return codec.replace(
    /(\.[LH]\d+)((?:\.[0-9a-fA-F]+)+)/,
    (_m, prefix: string, tail: string) => prefix + tail.toUpperCase(),
  )
}

// Produces a Main-tier (L) variant of an HEVC codec string. Used together
// with forceMainTierDescription as a fallback when the original High-tier
// configuration is rejected.
function normalizeCodecString(codec: string): string {
  if (!codec.startsWith('hvc1') && !codec.startsWith('hev1')) return codec
  return fixCodecStringCase(codec.replace(/\.H(\d+)/, '.L$1'))
}

async function waitForVideoQueue(encoder: VideoEncoder): Promise<void> {
  while (encoder.encodeQueueSize > 4) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

async function waitForAudioQueue(encoder: AudioEncoder): Promise<void> {
  while (encoder.encodeQueueSize > 8) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

// Re-export so callers that previously imported from this module still work.
export { safeName } from './metadata'
