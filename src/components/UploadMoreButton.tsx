import { useRef } from 'react'

interface Props {
  onFiles: (files: File[]) => void
  label?: string
  variant?: 'primary' | 'secondary' | 'subtle'
  className?: string
}

const VARIANT_CLASS: Record<NonNullable<Props['variant']>, string> = {
  primary:
    'rounded-full bg-emerald-500 px-7 py-3 text-base font-semibold text-white hover:bg-emerald-400 active:bg-emerald-600 transition-colors',
  secondary:
    'rounded-full border border-emerald-500 px-7 py-3 text-base font-semibold text-emerald-600 hover:bg-emerald-50 transition-colors',
  subtle:
    'rounded-full border border-neutral-300 px-7 py-3 text-base font-semibold text-neutral-600 hover:bg-neutral-50 transition-colors',
}

export function UploadMoreButton({
  onFiles,
  label = 'Upload more',
  variant = 'subtle',
  className,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={className ?? VARIANT_CLASS[variant]}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,video/*,.heic,.heif"
        className="hidden"
        onChange={(e) => {
          const list = e.target.files
          if (list && list.length > 0) onFiles(Array.from(list))
          // Reset so re-selecting the same files still fires onChange.
          e.target.value = ''
        }}
      />
    </>
  )
}
