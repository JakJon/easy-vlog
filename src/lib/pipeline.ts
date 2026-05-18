import { createFile, DataStream, Endianness, type MP4BoxBuffer, type Sample } from 'mp4box'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import type { MediaItem, StitchOptions } from './types'

const LANDSCAPE_W = 1920
const LANDSCAPE_H = 1080
const PORTRAIT_W = 1080
const PORTRAIT_H = 1920
const TARGET_FPS = 30
const FRAME_DURATION_US = Math.round(1_000_000 / TARGET_FPS)
const TARGET_VIDEO_CODEC = 'avc1.640028' // H.264 High @ Level 4
const TARGET_VIDEO_BITRATE = 5_000_000
const TARGET_SAMPLE_RATE = 48_000
const TARGET_AUDIO_CHANNELS = 2
const TARGET_AUDIO_BITRATE = 128_000
const TARGET_AUDIO_CODEC = 'mp4a.40.2' // AAC LC
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
  options: StitchOptions,
  onProgress: (p: StitchProgress) => void,
): Promise<Blob> {
  if (items.length === 0) throw new Error('No media items to stitch.')
  assertWebCodecsAvailable()

  const targetW = options.orientation === 'portrait' ? PORTRAIT_W : LANDSCAPE_W
  const targetH = options.orientation === 'portrait' ? PORTRAIT_H : LANDSCAPE_H
  const imageDurationSeconds = Math.max(0.1, options.imageDurationSeconds)
  const imageVideoFrames = Math.max(1, Math.round(TARGET_FPS * imageDurationSeconds))

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    video: {
      codec: 'avc',
      width: targetW,
      height: targetH,
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

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta)
    },
    error: propagate,
  })
  videoEncoder.configure({
    codec: TARGET_VIDEO_CODEC,
    width: targetW,
    height: targetH,
    bitrate: TARGET_VIDEO_BITRATE,
    framerate: TARGET_FPS,
    // 'no-preference' lets the browser pick. On Windows the H.264 hardware
    // encoder occasionally returns OperationError under burst loads, which
    // cascades and tears down the HEVC decoder too. Software fallback is
    // more reliable.
    hardwareAcceleration: 'no-preference',
    avc: { format: 'avc' },
  })

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
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

  const canvas = new OffscreenCanvas(targetW, targetH)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Failed to acquire 2D canvas context')

  // Determine total expected duration so we can drive a meaningful progress bar.
  const itemDurations: number[] = []
  for (const item of items) {
    if (item.kind === 'image') {
      itemDurations.push(imageDurationSeconds)
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
  const total = items.length
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
          imageDurationSeconds,
          imageVideoFrames,
          tickUs: () => {
            processedUs += FRAME_DURATION_US
            reportProgress(i + 1)
          },
          errBox,
        })
        outputVideoUs += imageVideoFrames * FRAME_DURATION_US
        outputAudioSamples += Math.round(TARGET_SAMPLE_RATE * imageDurationSeconds)
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
  imageDurationSeconds: number
  imageVideoFrames: number
  tickUs: () => void
  errBox: AsyncErrorBox
}

async function processImage(opts: ImageOpts): Promise<void> {
  const {
    file,
    ctx,
    canvas,
    videoEncoder,
    audioEncoder,
    videoStartUs,
    audioStartSamples,
    imageDurationSeconds,
    imageVideoFrames,
    tickUs,
    errBox,
  } = opts
  // Copy bytes into an in-memory Blob before passing to createImageBitmap.
  // On Android Chrome (notably with File objects sourced from the system
  // Photo Picker / content URIs), createImageBitmap(File) can leave the
  // underlying blob unusable for subsequent reads — even after the bitmap is
  // closed. That breaks later <img src=blob:...> thumbnails and the preview
  // modal. Using an in-memory Blob copy sidesteps the detach.
  const bytes = await file.arrayBuffer()
  const blob = new Blob([bytes], { type: file.type || 'image/jpeg' })
  const bitmap = await createImageBitmap(blob)
  try {
    drawContain(ctx, bitmap, canvas.width, canvas.height, 0)
  } finally {
    bitmap.close()
  }

  for (let f = 0; f < imageVideoFrames; f++) {
    if (errBox.err) throw errBox.err
    await waitForVideoQueue(videoEncoder)
    const ts = videoStartUs + f * FRAME_DURATION_US
    const frame = new VideoFrame(canvas, { timestamp: ts, duration: FRAME_DURATION_US })
    videoEncoder.encode(frame, { keyFrame: f === 0 })
    frame.close()
    tickUs()
  }

  // Silence at TARGET_SAMPLE_RATE × TARGET_AUDIO_CHANNELS for the configured per-image duration.
  const totalSamples = Math.round(TARGET_SAMPLE_RATE * imageDurationSeconds)
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

  // Compute the per-clip target length up-front so video and audio cover the
  // EXACT same wall-clock duration. Without this, video emits one frame per
  // decoded source frame (so duration scales with source fps) while audio
  // tracks the source's real duration — and they drift across clips.
  let durationS = await readVideoDurationSeconds(opts.file).catch(() => 0)
  if (!Number.isFinite(durationS) || durationS <= 0) durationS = 5
  const targetFrames = Math.max(1, Math.round(durationS * TARGET_FPS))
  // 48000 / 30 = 1600 exactly, so this is always an integer.
  const targetAudioSamples = (targetFrames * TARGET_SAMPLE_RATE) / TARGET_FPS

  await Promise.all([
    processVideoFrames(opts, fileBytes, targetFrames),
    processVideoAudio(opts, fileBytes, targetAudioSamples),
  ])
  return {
    videoTsUs: opts.videoStartUs + targetFrames * FRAME_DURATION_US,
    audioSamples: opts.audioStartSamples + targetAudioSamples,
  }
}

async function processVideoFrames(
  opts: VideoOpts,
  fileBytes: ArrayBuffer,
  targetFrames: number,
): Promise<void> {
  const { ctx, canvas, videoEncoder, videoStartUs, tickUs, propagate, errBox } = opts

  return new Promise<void>((resolve, reject) => {
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
    // Rate conversion: each decoded source frame is mapped to the closest
    // 30 fps slot. lastEmittedSlot is the highest slot index already encoded;
    // sourceStartUs is the presentation timestamp of the first decoded frame
    // (some files start at non-zero cts, e.g. iPhone HEVC).
    let sourceStartUs: number | null = null
    let lastEmittedSlot = -1
    let canvasHasContent = false

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

            decoderRef.current = new VideoDecoder({
              output: (frame) => {
                framesDecoded++
                if (errBox.err) {
                  frame.close()
                  return
                }
                // Chain the encode step onto drawTail so we can apply
                // encoder-queue backpressure asynchronously and serialize
                // canvas writes with VideoFrame snapshots.
                drawTail = drawTail.then(async () => {
                  try {
                    if (errBox.err) {
                      frame.close()
                      return
                    }
                    if (sourceStartUs === null) sourceStartUs = frame.timestamp
                    const elapsedUs = frame.timestamp - sourceStartUs
                    // Map this source frame to its nearest 30 fps slot, but
                    // never emit beyond targetFrames-1 (would desync against
                    // audio).
                    const targetSlot = Math.min(
                      targetFrames - 1,
                      Math.max(0, Math.round(elapsedUs / FRAME_DURATION_US)),
                    )
                    if (targetSlot <= lastEmittedSlot) {
                      // Source has more frames than the 30 fps grid needs
                      // (e.g. 60 fps source). Drop this frame.
                      frame.close()
                      return
                    }
                    drawContain(ctx, frame, canvas.width, canvas.height, rotation)
                    frame.close()
                    canvasHasContent = true
                    // Emit one output frame for every slot from lastEmittedSlot+1
                    // through targetSlot inclusive, all sourced from the canvas
                    // we just drew. For low-fps sources this duplicates the new
                    // frame across slots that have no matching source frame.
                    for (let slot = lastEmittedSlot + 1; slot <= targetSlot; slot++) {
                      if (errBox.err) return
                      await waitForVideoQueue(videoEncoder)
                      if (errBox.err) return
                      const ts = videoStartUs + slot * FRAME_DURATION_US
                      const out = new VideoFrame(canvas, {
                        timestamp: ts,
                        duration: FRAME_DURATION_US,
                      })
                      videoEncoder.encode(out, { keyFrame: slot === 0 })
                      out.close()
                      framesEmitted++
                      tickUs(FRAME_DURATION_US)
                    }
                    lastEmittedSlot = targetSlot
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

    mp4.onSamples = (id, _user, samples: Sample[]) => {
      try {
        if (id !== videoTrackId) return
        for (const s of samples) {
          if (!s.data) continue
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

        if (hasVideoTrack && framesEmitted === 0) {
          throw new Error(
            'Video track decoded 0 frames. The browser configured a decoder ' +
              'but produced no output — the file may use an unsupported HEVC ' +
              'profile/tier or a corrupt bitstream.',
          )
        }

        // Pad to targetFrames if the source ran short of the wall-clock
        // duration we promised the audio side. If we have a video track but
        // no canvas content (no track is the only realistic way framesEmitted
        // == 0, and that's already thrown above), fill black.
        if (lastEmittedSlot < targetFrames - 1) {
          if (!canvasHasContent) {
            ctx.fillStyle = 'black'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
          }
          for (let slot = lastEmittedSlot + 1; slot < targetFrames; slot++) {
            if (errBox.err) throw errBox.err
            await waitForVideoQueue(videoEncoder)
            const ts = videoStartUs + slot * FRAME_DURATION_US
            const out = new VideoFrame(canvas, {
              timestamp: ts,
              duration: FRAME_DURATION_US,
            })
            videoEncoder.encode(out, { keyFrame: slot === 0 })
            out.close()
            framesEmitted++
            tickUs(FRAME_DURATION_US)
          }
          lastEmittedSlot = targetFrames - 1
        }

        resolve()
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
  targetAudioSamples: number,
): Promise<void> {
  const { audioEncoder, audioStartSamples, errBox } = opts

  // Extract the AAC track via mp4box + WebCodecs AudioDecoder and resample.
  // We don't use AudioContext.decodeAudioData here because it silently fails
  // on a lot of iPhone MP4s (HE-AAC, mixed video/audio containers with edit
  // lists) — the catch used to swallow the error and emit silence for the
  // whole clip.
  let decoded: AudioBuffer | null = null
  try {
    decoded = await decodeMp4AudioTrack(
      fileBytes,
      TARGET_SAMPLE_RATE,
      TARGET_AUDIO_CHANNELS,
    )
  } catch (e) {
    console.warn('[webcodecs] audio decode failed, using silence', e)
  }

  if (!decoded) {
    // No audio (or decode failed) — fill the entire target with silence.
    await emitSilence(audioEncoder, audioStartSamples, targetAudioSamples)
    return
  }

  // Trim to target if source is longer; pad with silence at the end if shorter.
  // This keeps each clip's audio duration locked to its video duration.
  const samplesToEmit = Math.min(decoded.length, targetAudioSamples)
  const channelData: Float32Array[] = []
  for (let ch = 0; ch < TARGET_AUDIO_CHANNELS; ch++) {
    const srcCh = ch < decoded.numberOfChannels ? ch : 0
    channelData.push(decoded.getChannelData(srcCh))
  }

  let offset = 0
  while (offset < samplesToEmit) {
    if (errBox.err) throw errBox.err
    const samples = Math.min(AUDIO_CHUNK_SAMPLES, samplesToEmit - offset)
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

  if (offset < targetAudioSamples) {
    await emitSilence(audioEncoder, audioStartSamples + offset, targetAudioSamples - offset)
  }
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

async function decodeMp4AudioTrack(
  fileBytes: ArrayBuffer,
  targetRate: number,
  targetChannels: number,
): Promise<AudioBuffer | null> {
  const extracted = await extractMp4AudioSamples(fileBytes)
  if (!extracted) return null
  const { channels, sampleRate, numberOfChannels } = extracted
  const frameCount = channels[0]?.length ?? 0
  if (frameCount === 0) return null

  // Build an AudioBuffer at the source rate. We need an OfflineAudioContext
  // either way (to allocate the buffer when rates match, or to resample when
  // they don't).
  const sourceCtx = new OfflineAudioContext({
    numberOfChannels,
    length: frameCount,
    sampleRate,
  })
  const sourceBuffer = sourceCtx.createBuffer(numberOfChannels, frameCount, sampleRate)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    sourceBuffer.getChannelData(ch).set(channels[ch])
  }
  if (sampleRate === targetRate && numberOfChannels === targetChannels) {
    return sourceBuffer
  }

  const offline = new OfflineAudioContext({
    numberOfChannels: targetChannels,
    length: Math.max(1, Math.ceil((frameCount / sampleRate) * targetRate)),
    sampleRate: targetRate,
  })
  const src = offline.createBufferSource()
  src.buffer = sourceBuffer
  src.connect(offline.destination)
  src.start()
  return await offline.startRendering()
}

interface ExtractedAudio {
  channels: Float32Array[]
  sampleRate: number
  numberOfChannels: number
}

async function extractMp4AudioSamples(
  fileBytes: ArrayBuffer,
): Promise<ExtractedAudio | null> {
  return new Promise<ExtractedAudio | null>((resolve, reject) => {
    const mp4 = createFile()
    const decoderRef: { current: AudioDecoder | null } = { current: null }
    const decodedChunks: AudioData[] = []
    const pendingSamples: Sample[] = []
    let audioTrackId: number | null = null
    let hasAudioTrack = false
    let configured = false
    let sourceRate = 0
    let sourceChannels = 0
    let decodeError: Error | null = null

    let decoderReadyResolve!: () => void
    let decoderReadyReject!: (e: Error) => void
    const decoderReady = new Promise<void>((res, rej) => {
      decoderReadyResolve = res
      decoderReadyReject = rej
    })

    mp4.onError = (msg: string) => reject(new Error('mp4box audio: ' + msg))

    const decodeSample = (s: Sample) => {
      if (!s.data || !decoderRef.current) return
      // AAC has no inter-frame prediction — every access unit is a sync sample.
      decoderRef.current.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.max(0, (s.cts * 1_000_000) / s.timescale),
          duration: (s.duration * 1_000_000) / s.timescale,
          data: s.data,
        }),
      )
    }

    mp4.onReady = (info) => {
      try {
        const audioTrack = info.tracks.find((t) => t.type === 'audio')
        if (!audioTrack) {
          decoderReadyResolve()
          return
        }
        hasAudioTrack = true
        audioTrackId = audioTrack.id
        const audioInfo = audioTrack.audio as {
          sample_rate: number
          channel_count: number
        }
        sourceRate = audioInfo.sample_rate
        sourceChannels = audioInfo.channel_count

        const trak = mp4.getTrackById(audioTrack.id) as unknown as TrakWithStsd
        const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0]
        const description = entry?.esds
          ? extractAudioSpecificConfig(entry.esds, fileBytes)
          : undefined

        // Same pattern as the video path: enable extraction synchronously so
        // mp4box starts emitting samples in this appendBuffer call, then
        // configure the decoder asynchronously and drain buffered samples.
        mp4.setExtractionOptions(audioTrack.id, null, { nbSamples: 128 })
        mp4.start()

        void (async () => {
          try {
            const baseCfg: AudioDecoderConfig = {
              codec: audioTrack.codec,
              sampleRate: sourceRate,
              numberOfChannels: sourceChannels,
            }
            const cfg = description ? { ...baseCfg, description } : baseCfg
            const r = await AudioDecoder.isConfigSupported(cfg)
            if (!r.supported || !r.config) {
              throw new Error(
                `AudioDecoder rejected ${audioTrack.codec} @ ${sourceRate}Hz × ${sourceChannels}ch`,
              )
            }
            decoderRef.current = new AudioDecoder({
              output: (data) => {
                decodedChunks.push(data)
              },
              error: (e) => {
                decodeError = e instanceof Error ? e : new Error(String(e))
                console.error('[webcodecs] AudioDecoder error', e)
              },
            })
            decoderRef.current.configure(r.config)
            configured = true
            for (const s of pendingSamples) decodeSample(s)
            pendingSamples.length = 0
            decoderReadyResolve()
          } catch (e) {
            decoderReadyReject(e instanceof Error ? e : new Error(String(e)))
          }
        })()
      } catch (e) {
        decoderReadyReject(e instanceof Error ? e : new Error(String(e)))
      }
    }

    mp4.onSamples = (id, _user, samples: Sample[]) => {
      try {
        if (id !== audioTrackId) return
        for (const s of samples) {
          if (!s.data) continue
          if (configured && decoderRef.current) decodeSample(s)
          else pendingSamples.push(s)
        }
      } catch (e) {
        decoderReadyReject(e instanceof Error ? e : new Error(String(e)))
      }
    }

    void (async () => {
      try {
        const buf = fileBytes.slice(0) as MP4BoxBuffer
        ;(buf as MP4BoxBuffer).fileStart = 0
        mp4.appendBuffer(buf)
        await decoderReady
        if (!hasAudioTrack) {
          resolve(null)
          return
        }
        mp4.flush()
        const dec = decoderRef.current
        if (dec) {
          await dec.flush()
          dec.close()
        }
        if (decodeError) throw decodeError

        const totalFrames = decodedChunks.reduce(
          (sum, c) => sum + c.numberOfFrames,
          0,
        )
        if (totalFrames === 0) {
          for (const c of decodedChunks) c.close()
          resolve(null)
          return
        }
        const channels: Float32Array[] = []
        for (let ch = 0; ch < sourceChannels; ch++) {
          channels.push(new Float32Array(totalFrames))
        }
        let offset = 0
        for (const chunk of decodedChunks) {
          for (let ch = 0; ch < sourceChannels; ch++) {
            const tmp = new Float32Array(chunk.numberOfFrames)
            chunk.copyTo(tmp, { planeIndex: ch, format: 'f32-planar' })
            channels[ch].set(tmp, offset)
          }
          offset += chunk.numberOfFrames
          chunk.close()
        }
        resolve({ channels, sampleRate: sourceRate, numberOfChannels: sourceChannels })
      } catch (e) {
        for (const c of decodedChunks) c.close()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  })
}

function extractAudioSpecificConfig(
  esdsBox: PositionedBox,
  fileBytes: ArrayBuffer,
): Uint8Array | undefined {
  // esds payload is a chain of MPEG-4 descriptors:
  //   ES_DescrTag(0x03) → DecoderConfigDescrTag(0x04) → DecSpecificInfoTag(0x05)
  // The DecSpecificInfo bytes are the AudioSpecificConfig the AudioDecoder needs.
  // mp4box's hdr_size for FullBoxes includes the 4-byte version+flags, but we
  // try both offsets in case behavior differs across mp4box versions.
  if (
    typeof esdsBox.start !== 'number' ||
    typeof esdsBox.size !== 'number' ||
    typeof esdsBox.hdr_size !== 'number'
  ) return undefined
  const end = esdsBox.start + esdsBox.size
  if (end > fileBytes.byteLength) return undefined
  for (const start of [esdsBox.start + esdsBox.hdr_size, esdsBox.start + esdsBox.hdr_size + 4]) {
    if (start >= end) continue
    const dsi = parseEsdsDescriptors(new Uint8Array(fileBytes, start, end - start))
    if (dsi) return dsi
  }
  return undefined
}

function parseEsdsDescriptors(b: Uint8Array): Uint8Array | undefined {
  let i = 0
  const readVarSize = (): { size: number; consumed: number } => {
    let size = 0
    let consumed = 0
    while (consumed < 4 && i + consumed < b.length) {
      const byte = b[i + consumed]
      size = (size << 7) | (byte & 0x7f)
      consumed++
      if (!(byte & 0x80)) break
    }
    return { size, consumed }
  }
  if (b[i++] !== 0x03) return undefined
  i += readVarSize().consumed
  i += 2 // ES_ID
  if (i >= b.length) return undefined
  const esFlags = b[i++]
  if (esFlags & 0x80) i += 2
  if (esFlags & 0x40) {
    if (i >= b.length) return undefined
    const urlLen = b[i++]
    i += urlLen
  }
  if (esFlags & 0x20) i += 2
  if (i >= b.length || b[i++] !== 0x04) return undefined
  i += readVarSize().consumed
  i += 13 // objectTypeIndication + streamType flags + bufferSizeDB + maxBitrate + avgBitrate
  if (i >= b.length || b[i++] !== 0x05) return undefined
  const dsi = readVarSize()
  i += dsi.consumed
  if (dsi.size === 0 || i + dsi.size > b.length) return undefined
  return b.slice(i, i + dsi.size)
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
            esds?: PositionedBox
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
          return r.config
        }
      } catch {
        // Try the next candidate.
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

// WebCodecs feature detection. Mobile Safari and some older Android browsers
// don't ship VideoEncoder; the rest of the pipeline crashes with an opaque
// ReferenceError if we don't gate.
export function isWebCodecsSupported(): boolean {
  const g = globalThis as Record<string, unknown>
  return (
    typeof g.VideoEncoder !== 'undefined' &&
    typeof g.VideoDecoder !== 'undefined' &&
    typeof g.AudioEncoder !== 'undefined' &&
    typeof g.AudioDecoder !== 'undefined'
  )
}

function assertWebCodecsAvailable(): void {
  if (isWebCodecsSupported()) return
  throw new Error(
    "Your browser doesn't support WebCodecs, which Easy Vlog needs to " +
      'stitch video. Try the latest desktop Chrome or Edge — mobile Safari ' +
      "and some Android browsers don't yet expose this API.",
  )
}

// Re-export so callers that previously imported from this module still work.
export { safeName } from './metadata'
