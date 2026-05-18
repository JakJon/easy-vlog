import { useRef, useState, type ReactNode } from 'react'

interface Props {
  onFiles: (files: File[]) => void
  // Optional content rendered below the drop-target inside the same card —
  // used to inline the Options widget under the Upload button.
  footer?: ReactNode
}

export function UploadZone({ onFiles, footer }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return
    onFiles(Array.from(list))
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        handleFiles(e.dataTransfer.files)
      }}
      className={`rounded-2xl border bg-white transition-colors ${
        dragOver ? 'border-emerald-500 bg-emerald-50/40' : 'border-neutral-200'
      }`}
    >
      <div className="px-8 py-12 sm:py-16 text-center">
        <h3 className="text-xl font-medium text-neutral-700 mb-8">
          Lets get started.
        </h3>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-10 py-4 text-lg font-semibold text-white animate-emerald-pulse hover:bg-emerald-400 active:bg-emerald-600 focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300 transition-colors"
        >
          Upload
        </button>

        <p className="mt-6 text-sm text-neutral-400">
          or drag &amp; drop here · JPG, PNG, HEIC, MP4, MOV
        </p>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,video/*,.heic,.heif"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {footer && (
        <div className="border-t border-neutral-100 px-2 pb-2 pt-3 sm:px-4 sm:pb-3">
          {footer}
        </div>
      )}
    </div>
  )
}
