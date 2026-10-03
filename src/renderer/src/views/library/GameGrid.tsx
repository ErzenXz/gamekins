import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Game } from '@shared/types'
import { Capsule } from '../../components/Capsule'
import { Dropdown } from '../../components/library/controls'
import {
  CAPSULE_SIZES,
  type CapsuleSize,
  groupGames,
  SORT_LABELS,
  sizeName,
  sortGames
} from '../../components/library/libraryData'
import { useVirtualViewport, visibleRows } from '../../components/library/virtualWindow'
import { recentColumnLabel } from '../../lib/format'
import { type LibrarySort, useStore } from '../../store'

/** Virtualize complete rows so auto-fill columns, gaps and sort headings keep their geometry. */
export function GameGrid({ games, width, sort }: { games: Game[]; width: number; sort: LibrarySort }): React.JSX.Element {
  const groups = useMemo(() => groupGames(sortGames(games, sort), sort, recentColumnLabel), [games, sort])
  const [focusRequest, setFocusRequest] = useState<{ key: string } | null>(null)
  return (
    <div className="grid-groups" style={{ '--cap-w': width + 'px' } as React.CSSProperties} onKeyDownCapture={(e) => {
      if (e.key !== 'Tab') return
      const key = (e.target as HTMLElement).closest<HTMLElement>('.cap')?.dataset.ctxKey
      const group = groups.find((g) => g.games.some((game) => game.key === key))
      if (!group || key !== (e.shiftKey ? group.games[0]?.key : group.games.at(-1)?.key)) return
      const order = groups.flatMap((g) => g.games)
      const next = order[order.findIndex((g) => g.key === key) + (e.shiftKey ? -1 : 1)]
      if (next) { e.preventDefault(); e.stopPropagation(); setFocusRequest({ key: next.key }) }
    }}>
      {groups.map((grp) => (
        <div key={grp.label || 'all'} className="grid-group">
          {grp.label && <div className="grid-group-label">{grp.label} <span>({grp.games.length})</span></div>}
          <GridRows games={grp.games} width={width} focusRequest={focusRequest} />
        </div>
      ))}
    </div>
  )
}

function GridRows({ games, width, focusRequest }: { games: Game[]; width: number; focusRequest: { key: string } | null }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const view = useVirtualViewport(ref)
  const columns = Math.max(1, Math.floor((view.width + 14) / ((view.capsuleWidth || width) + 14)))
  const height = width * 4 / 3
  const stride = height + 18
  const rows = Math.ceil(games.length / columns)
  const [start, end] = visibleRows(view.top - 8, view.bottom - 8, rows, stride)
  const [focused, setFocused] = useState<string | null>(null)
  const pending = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (focusRequest && games.some((g) => g.key === focusRequest.key)) { pending.current = focusRequest.key; setFocused(focusRequest.key) }
    // A library update must not replay an already handled keyboard request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest])
  const focusIndex = games.findIndex((g) => g.key === focused)
  const focusRow = focusIndex < 0 ? -1 : Math.floor(focusIndex / columns)
  const mountedRows = new Set(Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i))
  // Retain only the focused row outside the viewport; ordinary scrolling never loses focus.
  if (focusRow >= 0) mountedRows.add(focusRow)
  useLayoutEffect(() => {
    if (!pending.current) return
    const target = Array.from(ref.current?.querySelectorAll<HTMLElement>('.cap') ?? []).find((el) => el.dataset.ctxKey === pending.current)
    if (target) {
      target.focus({ preventScroll: true })
      const scroll = ref.current?.closest<HTMLElement>('.scroll')
      if (scroll) {
        const y = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top
        if (y < 0) scroll.scrollTop += y
        else if (y + height > scroll.clientHeight) scroll.scrollTop += y + height - scroll.clientHeight
      }
      pending.current = null
    }
  })
  const onKey = (e: React.KeyboardEvent): void => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.cap')
    const index = games.findIndex((g) => g.key === tile?.dataset.ctxKey)
    if (index < 0) return
    let next = index
    if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) next++
    else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) next--
    else if (e.key === 'ArrowDown') next += columns
    else if (e.key === 'ArrowUp') next -= columns
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = games.length - 1
    else return
    if (next < 0 || next >= games.length) return
    e.preventDefault()
    const key = games[next].key
    pending.current = key
    setFocused(key)
    const el = ref.current
    const scroll = el?.closest<HTMLElement>('.scroll')
    if (el && scroll) {
      const y = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 8 + Math.floor(next / columns) * stride
      if (y < 0) scroll.scrollTop += y
      else if (y + height > scroll.clientHeight) scroll.scrollTop += y + height - scroll.clientHeight
    }
  }
  return (
    <div ref={ref} className="game-grid" style={{ gridTemplateRows: 'repeat(' + rows + ', ' + height + 'px)' }}
      onKeyDown={onKey}
      onFocus={(e) => setFocused((e.target as HTMLElement).closest<HTMLElement>('.cap')?.dataset.ctxKey ?? null)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(null) }}>
      {[...mountedRows].sort((a, b) => a - b).flatMap((row) => games.slice(row * columns, (row + 1) * columns).map((g, col) => (
        <div key={g.key} className="virtual-grid-cell" style={{ gridRow: row + 1, gridColumn: col + 1 }}>
          <Capsule game={g} width={width} />
        </div>
      )))}
    </div>
  )
}

const SIZE_LABEL: Record<CapsuleSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' }

/** SORT BY dropdown + Small/Medium/Large display size, as in Steam's grid header. */
export function GridTools(): React.JSX.Element {
  const sort = useStore((s) => s.librarySort)
  const size = sizeName(useStore((s) => s.gridSize))
  const { setLibrarySort, setGridSize } = useStore.getState()
  return (
    <div className="grid-tools">
      <div className="size-seg" role="radiogroup" aria-label="Display size">
        {(Object.keys(CAPSULE_SIZES) as CapsuleSize[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={size === k}
            className={`size-btn ${k} ${size === k ? 'on' : ''}`}
            title={`${SIZE_LABEL[k]} capsules`}
            onClick={() => setGridSize(CAPSULE_SIZES[k])}
          >
            <i />
          </button>
        ))}
      </div>
      <span className="sortby-label">Sort by</span>
      <Dropdown<LibrarySort>
        className="sortby"
        align="right"
        value={sort}
        onChange={setLibrarySort}
        options={(Object.keys(SORT_LABELS) as LibrarySort[]).map((s) => ({ value: s, label: SORT_LABELS[s] }))}
      />
    </div>
  )
}
