interface Props {
  label: string
  current: number
  total: number
  ratio: number
}

export function Progress({ label, current, total, ratio }: Props) {
  const overall = total === 0 ? 0 : Math.min(1, ((current - 1) + ratio) / total)
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
    </div>
  )
}
