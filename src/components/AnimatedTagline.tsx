import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Each word must sound natural in the sentence "Vlog editing made ___".
// Dropped words that are awkward as predicate adjectives after "made"
// (defended, sealed, guarded, fluid, basic, prompt, nimble, etc.).
const QUICK = [
  'quick', 'fast', 'swift', 'speedy', 'snappy', 'instant', 'rapid', 'zippy',
  'agile', 'efficient',
]

const SIMPLE = [
  'simple', 'effortless', 'painless', 'intuitive', 'smooth', 'seamless',
  'accessible', 'approachable', 'streamlined', 'automatic', 'foolproof',
  'elegant', 'frictionless', 'natural',
]

const SECURE = [
  'secure', 'safe', 'private', 'confidential', 'bulletproof', 'untouchable',
  'anonymous', 'discreet', 'yours', 'personal', 'airtight', 'ironclad',
]

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

const FADE_IN_MS = 280
const EASY_IN_MS = 700
const HOLD_MS = 500
const BLOW_MS = 1200

type Phase = 'in' | 'hold' | 'blow'

export function AnimatedTagline() {
  const sequenceRef = useRef<string[] | null>(null)
  if (sequenceRef.current === null) {
    sequenceRef.current = [pick(QUICK), pick(SIMPLE), pick(SECURE), 'Easy']
  }
  const sequence = sequenceRef.current
  const longestWord = sequence.reduce(
    (a, b) => (b.length > a.length ? b : a),
    '',
  )

  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>('in')
  const displaceRef = useRef<SVGFEDisplacementMapElement>(null)

  const isLast = index === 3

  // Sequential phase machine: each word goes in → hold → blow → next.
  // Easy stops at 'hold' so it stays displayed permanently.
  useEffect(() => {
    if (phase === 'in') {
      // Easy's fade-in is longer than the cycling words' — use a matching
      // timer so the phase doesn't advance mid-animation.
      const duration = isLast ? EASY_IN_MS : FADE_IN_MS
      const t = setTimeout(() => setPhase('hold'), duration)
      return () => clearTimeout(t)
    }
    if (phase === 'hold') {
      if (isLast) return
      const t = setTimeout(() => setPhase('blow'), HOLD_MS)
      return () => clearTimeout(t)
    }
    // 'blow' → advance to next word and start fresh fade-in.
    const t = setTimeout(() => {
      setIndex((i) => i + 1)
      setPhase('in')
    }, BLOW_MS)
    return () => clearTimeout(t)
  }, [phase, isLast])

  // Drive the SVG displacement scale during the blow phase. useLayoutEffect
  // resets scale=0 before paint so we don't briefly show prior distortion.
  useLayoutEffect(() => {
    if (phase !== 'blow' || !displaceRef.current) return
    const el = displaceRef.current
    el.setAttribute('scale', '0')
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / BLOW_MS)
      // Smoothstep matches the cubic-bezier on the CSS animation.
      const eased = t * t * (3 - 2 * t)
      el.setAttribute('scale', String(eased * 30))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, index])

  const word = sequence[index]
  const seed = (index + 1) * 13

  let animation: string
  if (phase === 'in') {
    animation = isLast
      ? `tagline-in ${EASY_IN_MS}ms cubic-bezier(.2,.6,.3,1) forwards`
      : `tagline-fade-in ${FADE_IN_MS}ms cubic-bezier(.4,0,.2,1) forwards`
  } else if (phase === 'blow') {
    animation = `tagline-blow-away ${BLOW_MS}ms cubic-bezier(.45,.05,.55,.95) forwards`
  } else {
    animation = 'none'
  }

  return (
    <p className="mt-3 text-lg font-sans text-black">
      <svg aria-hidden width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <filter
            id="tagline-dust"
            x="-10%"
            y="-100%"
            width="600%"
            height="300%"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="1.2 0.7"
              numOctaves={1}
              seed={seed}
              result="noise"
            />
            {/* Force G channel to a flat 0.5 — feDisplacementMap reads G for
                Y displacement, so (0.5 - 0.5) * scale = 0. Pixels shift only
                horizontally, never vertically. No radial spread. */}
            <feColorMatrix
              in="noise"
              type="matrix"
              values="1 0 0 0 0
                      0 0 0 0 0.5
                      0 0 1 0 0
                      0 0 0 1 0"
              result="noiseHoriz"
            />
            <feDisplacementMap
              ref={displaceRef}
              in="SourceGraphic"
              in2="noiseHoriz"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      Vlog editing made{' '}
      <span
        className="relative inline-block align-baseline"
        style={{ whiteSpace: 'nowrap' }}
      >
        {/* Invisible sizer — locks wrapper width to the longest word in this
            session so the centered tagline never re-flows horizontally. */}
        <span style={{ visibility: 'hidden' }} aria-hidden>
          {longestWord}
        </span>
        {/* Single active span. Key includes phase so React remounts (and
            restarts the animation) on every phase change. */}
        <span
          key={`${index}-${phase}`}
          className="inline-block"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            color: isLast ? '#10B981' : '#000',
            fontWeight: isLast ? 600 : 400,
            willChange: 'opacity, transform, filter',
            filter: phase === 'blow' ? 'url(#tagline-dust)' : 'none',
            animation,
          }}
        >
          {word}{isLast ? '.' : ''}
        </span>
      </span>
    </p>
  )
}
