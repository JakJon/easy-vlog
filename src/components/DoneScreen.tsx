import { useState } from 'react'
import { UploadMoreButton } from './UploadMoreButton'

interface Props {
  videoUrl: string
  onSave: () => void
  onReset: () => void
  onSort: () => void
  onUploadMore: (files: File[]) => void
}

export function DoneScreen({ videoUrl, onSave, onReset, onSort, onUploadMore }: Props) {
  const [editing, setEditing] = useState(false)

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-8 py-10 text-center">
      <h3 className="text-2xl font-semibold text-neutral-900">
        Your video is complete!
      </h3>

      <video
        src={videoUrl}
        controls
        className="mt-6 mx-auto max-h-[70vh] w-auto max-w-full rounded-xl bg-black"
      />

      <button
        type="button"
        onClick={onSave}
        className="mt-8 inline-flex items-center gap-2 rounded-full bg-emerald-500 px-10 py-4 text-lg font-semibold text-white shadow-[0_0_30px_rgba(16,185,129,0.55)] hover:bg-emerald-400 active:bg-emerald-600 focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300 transition-colors"
      >
        Save
      </button>

      <div className="mt-6 flex flex-col items-center gap-3">
        <p className="text-sm text-neutral-500">Not looking quite right?</p>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-full border border-emerald-500 px-6 py-2 text-sm font-semibold text-emerald-600 hover:bg-emerald-50 transition-colors"
          >
            Edit
          </button>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <UploadMoreButton
              onFiles={onUploadMore}
              label="Upload more videos?"
              variant="secondary"
            />
            <button
              type="button"
              onClick={onSort}
              className="rounded-full border border-emerald-500 px-7 py-3 text-base font-semibold text-emerald-600 hover:bg-emerald-50 transition-colors"
            >
              Sort videos?
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs text-neutral-500 underline hover:text-neutral-700"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="mt-10 border-t border-neutral-100 pt-6">
        <p className="text-neutral-600 mb-3">Should we make another?</p>
        <button
          type="button"
          onClick={onReset}
          className="rounded-full border border-emerald-500 px-6 py-2 text-emerald-600 font-medium hover:bg-emerald-50 transition-colors"
        >
          Start over
        </button>
      </div>
    </div>
  )
}
