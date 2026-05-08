export interface CodecCheck {
  codec: string
  supported: boolean
  hardwareAcceleration?: string
  error?: string
}

export interface WebCodecsCapability {
  hasVideoDecoder: boolean
  hasVideoEncoder: boolean
  hasAudioDecoder: boolean
  hasAudioEncoder: boolean
  hevcDecode: CodecCheck[]
  h264Decode: CodecCheck[]
  h264Encode: CodecCheck[]
}

// Common HEVC codec strings phones produce. Profile.Compat.Tier+Level.Constraints.
// hvc1.1.6.L120.B0 = Main profile, level 4 (1080p30) — typical Android.
// hvc1.1.6.L150.B0 = Main profile, level 5 (4K).
// hvc1.2.4.L120.B0 = Main 10 (10-bit) profile, level 4.
const HEVC_CANDIDATES = [
  'hvc1.1.6.L120.B0',
  'hvc1.1.6.L150.B0',
  'hvc1.2.4.L120.B0',
  'hev1.1.6.L120.B0',
]

const H264_DECODE_CANDIDATES = [
  'avc1.42E01F', // Baseline level 3.1
  'avc1.640028', // High level 4
]

const H264_ENCODE_CANDIDATES = [
  'avc1.42E01F',
  'avc1.640028',
]

async function probeDecode(codec: string): Promise<CodecCheck> {
  try {
    const cfg = { codec }
    const result = await VideoDecoder.isConfigSupported(cfg)
    return {
      codec,
      supported: !!result.supported,
      hardwareAcceleration: result.config?.hardwareAcceleration,
    }
  } catch (err) {
    return {
      codec,
      supported: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function probeEncode(codec: string): Promise<CodecCheck> {
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec,
      width: 1920,
      height: 1080,
      bitrate: 5_000_000,
      framerate: 24,
    })
    return {
      codec,
      supported: !!result.supported,
      hardwareAcceleration: result.config?.hardwareAcceleration,
    }
  } catch (err) {
    return {
      codec,
      supported: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function checkWebCodecsCapability(): Promise<WebCodecsCapability> {
  const g = globalThis as Record<string, unknown>
  const cap: WebCodecsCapability = {
    hasVideoDecoder: typeof VideoDecoder !== 'undefined',
    hasVideoEncoder: typeof VideoEncoder !== 'undefined',
    hasAudioDecoder: typeof g.AudioDecoder !== 'undefined',
    hasAudioEncoder: typeof g.AudioEncoder !== 'undefined',
    hevcDecode: [],
    h264Decode: [],
    h264Encode: [],
  }

  if (cap.hasVideoDecoder) {
    cap.hevcDecode = await Promise.all(HEVC_CANDIDATES.map(probeDecode))
    cap.h264Decode = await Promise.all(H264_DECODE_CANDIDATES.map(probeDecode))
  }
  if (cap.hasVideoEncoder) {
    cap.h264Encode = await Promise.all(H264_ENCODE_CANDIDATES.map(probeEncode))
  }

  return cap
}

export function summarize(cap: WebCodecsCapability): string {
  const lines: string[] = []
  lines.push(
    `VideoDecoder=${cap.hasVideoDecoder} VideoEncoder=${cap.hasVideoEncoder} ` +
      `AudioDecoder=${cap.hasAudioDecoder} AudioEncoder=${cap.hasAudioEncoder}`
  )
  const fmt = (label: string, checks: CodecCheck[]) => {
    if (checks.length === 0) {
      lines.push(`${label}: (skipped — API missing)`)
      return
    }
    for (const c of checks) {
      const accel = c.hardwareAcceleration ? ` [${c.hardwareAcceleration}]` : ''
      const err = c.error ? ` error=${c.error}` : ''
      lines.push(`${label} ${c.codec}: ${c.supported ? 'YES' : 'no'}${accel}${err}`)
    }
  }
  fmt('HEVC decode', cap.hevcDecode)
  fmt('H.264 decode', cap.h264Decode)
  fmt('H.264 encode', cap.h264Encode)
  return lines.join('\n')
}
