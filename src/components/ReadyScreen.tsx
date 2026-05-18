import { Options } from './Options'
import { UploadMoreButton } from './UploadMoreButton'
import type { StitchOptions } from '../lib/types'

interface Props {
  itemCount: number
  options: StitchOptions
  onOptionsChange: (next: StitchOptions) => void
  onStart: () => void
  onSort: () => void
  onUploadMore: (files: File[]) => void
}

export function ReadyScreen({
  itemCount,
  options,
  onOptionsChange,
  onStart,
  onSort,
  onUploadMore,
}: Props) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white">
      <div className="px-6 py-8 sm:px-8 sm:py-10">
        <h3 className="text-2xl font-semibold text-neutral-900 text-center">
          Ready?
        </h3>
        <p className="mt-3 text-sm text-neutral-600 text-center">
          You have <span className="font-semibold">{itemCount}</span>{' '}
          item{itemCount === 1 ? '' : 's'} ready to be stitched together. Or you
          can sort them yourself first.
        </p>

        <div className="mt-6 flex justify-center">
          <div className="flex w-fit flex-col gap-3">
            <button
              type="button"
              onClick={onStart}
              className="w-full rounded-full bg-emerald-500 px-10 py-4 text-lg font-semibold text-white shadow-[0_0_30px_rgba(16,185,129,0.45)] hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
            >
              Start
            </button>
            <button
              type="button"
              onClick={onSort}
              className="w-full rounded-full border border-emerald-500 px-7 py-3 text-base font-semibold text-emerald-600 hover:bg-emerald-50 transition-colors"
            >
              Sort
            </button>
            <UploadMoreButton onFiles={onUploadMore} className="w-full" />
          </div>
        </div>
      </div>

      <div className="border-t border-neutral-100 px-2 pb-2 pt-3 sm:px-4 sm:pb-3">
        <Options value={options} onChange={onOptionsChange} bare />
      </div>
    </div>
  )
}
