interface Props {
  label: string
  current: number
  total: number
  ratio: number
  // Optional read-only summary of the options driving this run — shown beneath
  // the progress bar during stitching so the user can see what they chose.
  optionsSummary?: string
}

export function Progress({ label, current, total, ratio, optionsSummary }: Props) {
  const overall = total === 0 ? 0 : Math.max(0, Math.min(1, ((current - 1) + ratio) / total))
  const pct = Math.round(overall * 100)

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-8 py-12 text-center">
      <h3 className="text-xl font-medium text-neutral-700">{label}</h3>
      <p className="mt-2 text-sm text-neutral-500">
        {Math.min(current, total)} / {total} items processed
      </p>

      <div className="mt-8 h-3 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-3 text-sm font-medium text-emerald-600">{pct}%</p>

      {optionsSummary && (
        <p className="mt-6 text-xs text-neutral-500">{optionsSummary}</p>
      )}
    </div>
  )
}
