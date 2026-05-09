import {
  IMAGE_DURATION_MAX_S,
  IMAGE_DURATION_MIN_S,
  type Orientation,
  type StitchOptions,
} from '../lib/types'

interface Props {
  value: StitchOptions
  onChange: (next: StitchOptions) => void
  // When true, omit the outer card chrome — caller is providing its own
  // container (e.g. the mobile accordion shares a card with the toggle).
  bare?: boolean
}

export function Options({ value, onChange, bare = false }: Props) {
  const setOrientation = (orientation: Orientation) =>
    onChange({ ...value, orientation })

  const setDuration = (raw: number) => {
    const clamped = Math.min(
      IMAGE_DURATION_MAX_S,
      Math.max(IMAGE_DURATION_MIN_S, Math.round(raw)),
    )
    onChange({ ...value, imageDurationSeconds: clamped })
  }

  const wrapperClass = bare
    ? 'px-6 pb-5'
    : 'rounded-2xl border border-neutral-200 bg-white px-6 py-5'

  return (
    <div className={wrapperClass}>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-neutral-700">
            Orientation
          </span>
          <div
            role="radiogroup"
            aria-label="Output orientation"
            className="inline-flex rounded-full bg-neutral-100 p-1"
          >
            <OrientationButton
              label="Landscape"
              selected={value.orientation === 'landscape'}
              onClick={() => setOrientation('landscape')}
            />
            <OrientationButton
              label="Portrait"
              selected={value.orientation === 'portrait'}
              onClick={() => setOrientation('portrait')}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label
            htmlFor="image-duration"
            className="text-sm font-medium text-neutral-700"
          >
            Photo duration
          </label>
          <input
            id="image-duration"
            type="range"
            min={IMAGE_DURATION_MIN_S}
            max={IMAGE_DURATION_MAX_S}
            step={1}
            value={value.imageDurationSeconds}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="accent-emerald-500"
          />
          <span className="w-10 text-sm tabular-nums text-neutral-600">
            {value.imageDurationSeconds}s
          </span>
        </div>
      </div>
    </div>
  )
}

interface OrientationButtonProps {
  label: string
  selected: boolean
  onClick: () => void
}

function OrientationButton({ label, selected, onClick }: OrientationButtonProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        selected
          ? 'bg-white text-emerald-600 shadow-sm'
          : 'text-neutral-500 hover:text-neutral-700'
      }`}
    >
      {label}
    </button>
  )
}
