interface Props {
  videoUrl: string
  onSave: () => void
  onReset: () => void
}

export function DoneScreen({ videoUrl, onSave, onReset }: Props) {
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

      <div className="mt-10 border-t border-neutral-100 pt-6">
        <p className="text-neutral-600 mb-3">Should we make another?</p>
        <button
          type="button"
          onClick={onReset}
          className="rounded-full border border-emerald-500 px-6 py-2 text-emerald-600 font-medium hover:bg-emerald-50 transition-colors"
        >
          Upload more
        </button>
      </div>
    </div>
  )
}
