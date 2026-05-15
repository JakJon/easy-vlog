import { useMemo, useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { MediaItem } from '../lib/types'
import { Thumbnail } from './Thumbnail'

type View = 'list' | 'card'

interface OrderedItem {
  id: string
  item: MediaItem
}

interface Props {
  items: MediaItem[]
  onDone: (orderedItems: MediaItem[]) => void
  onCancel: () => void
}

export function ManualReorder({ items, onDone, onCancel }: Props) {
  const [view, setView] = useState<View>('list')
  // Stable IDs for the duration of the reorder session. dnd-kit needs ids
  // that survive reordering, so we attach a UUID once and key everything by it.
  const [order, setOrder] = useState<OrderedItem[]>(() =>
    items.map((item, i) => ({
      id: `${i}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`,
      item,
    })),
  )

  // PointerSensor with a small distance threshold lets taps still register as
  // taps, not drags. TouchSensor with a delay gives mobile users a clear
  // "press-and-hold to drag" affordance.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setOrder((prev) => {
      const oldIndex = prev.findIndex((o) => o.id === active.id)
      const newIndex = prev.findIndex((o) => o.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  const sortedIds = useMemo(() => order.map((o) => o.id), [order])

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-6 py-8">
      <button
        type="button"
        onClick={onCancel}
        className="-ml-1 inline-flex items-center gap-1 text-sm font-medium text-neutral-500 hover:text-neutral-700"
        aria-label="Back"
      >
        <span aria-hidden>←</span> Back
      </button>
      <div className="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
        <h3 className="text-xl font-semibold text-neutral-900">Reorder your items</h3>
        <ViewToggle value={view} onChange={setView} />
      </div>
      <p className="mt-2 text-sm text-neutral-600 text-center sm:text-left">
        {view === 'list'
          ? 'Press and hold a row, then drag to reorder.'
          : 'Press and hold a card, then drag to reorder.'}
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sortedIds}
          strategy={view === 'list' ? verticalListSortingStrategy : rectSortingStrategy}
        >
          {view === 'list' ? (
            <ul className="mt-5 flex flex-col gap-2">
              {order.map((o, i) => (
                <SortableListRow key={o.id} id={o.id} position={i + 1} item={o.item} />
              ))}
            </ul>
          ) : (
            <div className="mt-5 grid grid-cols-3 gap-3">
              {order.map((o, i) => (
                <SortableCard key={o.id} id={o.id} position={i + 1} item={o.item} />
              ))}
            </div>
          )}
        </SortableContext>
      </DndContext>

      <div className="mt-7 flex justify-center">
        <button
          type="button"
          onClick={() => onDone(order.map((o) => o.item))}
          className="rounded-full bg-emerald-500 px-8 py-3 text-base font-semibold text-white hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
        >
          Continue with this order
        </button>
      </div>
    </div>
  )
}

function ViewToggle({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="View"
      className="inline-flex rounded-full bg-neutral-100 p-1"
    >
      <ViewButton label="List" selected={value === 'list'} onClick={() => onChange('list')} />
      <ViewButton label="Cards" selected={value === 'card'} onClick={() => onChange('card')} />
    </div>
  )
}

function ViewButton({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        selected ? 'bg-white text-emerald-600 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'
      }`}
    >
      {label}
    </button>
  )
}

function SortableListRow({
  id,
  position,
  item,
}: {
  id: string
  position: number
  item: MediaItem
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`flex items-center gap-3 rounded-xl border bg-white px-3 py-2 touch-none select-none ${
        isDragging
          ? 'border-emerald-400 shadow-lg ring-2 ring-emerald-200'
          : 'border-neutral-200'
      }`}
    >
      <span className="w-6 text-right text-xs font-medium tabular-nums text-neutral-400">
        {position}
      </span>
      <Thumbnail item={item} className="h-12 w-12 flex-none rounded-md overflow-hidden" />
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-700">
        {item.file.name}
      </span>
      <span aria-hidden className="text-neutral-300 text-lg leading-none">⋮⋮</span>
    </li>
  )
}

function SortableCard({
  id,
  position,
  item,
}: {
  id: string
  position: number
  item: MediaItem
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`relative overflow-hidden rounded-xl border bg-white touch-none select-none ${
        isDragging
          ? 'border-emerald-400 shadow-lg ring-2 ring-emerald-200'
          : 'border-neutral-200'
      }`}
    >
      <Thumbnail item={item} className="aspect-square w-full" />
      <span className="absolute left-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white">
        {position}
      </span>
    </div>
  )
}
