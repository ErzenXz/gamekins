import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Children, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualViewport, visibleItems } from '../../components/library/virtualWindow'

/** Horizontally paged Steam shelf: thin uppercase title, a rule, and pager arrows on the right. */
export function Shelf({
  title,
  count,
  extra,
  children,
  itemWidths,
  itemHeight,
  className = '',
  onTitleClick,
  onTitleContextMenu
}: {
  title: ReactNode
  count?: number
  extra?: ReactNode
  children: ReactNode
  itemWidths?: number[]
  itemHeight?: number
  className?: string
  onTitleClick?: () => void
  onTitleContextMenu?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const viewport = useVirtualViewport(track)
  const [left, setLeft] = useState(0)
  const [focused, setFocused] = useState<number | null>(null)
  const [wanted, setWanted] = useState<number | null>(null)
  const [measuredHeight, setMeasuredHeight] = useState(0)
  const windowRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => Children.toArray(children), [children])
  const offsets = useMemo(() => {
    let x = 0
    return (itemWidths ?? []).map((width) => { const start = x; x += width + 16; return start })
  }, [itemWidths])
  const totalWidth = itemWidths?.length ? offsets.at(-1)! + itemWidths.at(-1)! : 0
  const height = itemHeight ?? measuredHeight
  const intersecting = viewport.bottom >= -100 && viewport.top <= height + 132
  const indices = new Set(itemWidths && intersecting ? visibleItems(offsets, itemWidths, left, viewport.width) : [])
  if (focused !== null) indices.add(focused)
  // Measure one natural-height item before pruning an offscreen event shelf.
  if (itemWidths?.length && itemHeight === undefined && !measuredHeight) indices.add(0)
  useLayoutEffect(() => {
    if (itemHeight !== undefined || !itemWidths) return
    const el = windowRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const next = Math.max(0, ...entries.map((entry) => entry.target.getBoundingClientRect().height))
      if (next) setMeasuredHeight(next)
    })
    for (const child of el.children) observer.observe(child)
    return () => observer.disconnect()
  })
  useEffect(() => {
    if (wanted === null) return
    windowRef.current?.querySelector<HTMLElement>(`[data-shelf-index="${wanted}"] :is([tabindex="0"], button)` )?.focus({ preventScroll: true })
    setWanted(null)
  }, [wanted])
  const [edges, setEdges] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const el = track.current
    if (!el) return
    setLeft(el.scrollLeft)
    const left = el.scrollLeft > 4
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }, [])

  // Observe the track and its content once; a MutationObserver catches added/removed tiles.
  useEffect(() => {
    const el = track.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    const watch = (): void => {
      ro.disconnect()
      ro.observe(el)
      for (const c of el.children) ro.observe(c)
    }
    watch()
    const mo = new MutationObserver(() => {
      watch()
      measure()
    })
    mo.observe(el, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [measure])

  const page = (dir: 1 | -1): void => {
    const el = track.current
    if (el) el.scrollBy({ left: dir * Math.max(200, el.clientWidth - 80), behavior: 'smooth' })
  }

  const TitleTag = onTitleClick ? 'button' : 'h3'
  return (
    <section className={`shelf ${className}`}>
      <div className="shelf-head">
        <TitleTag
          className={`shelf-title ${onTitleClick ? 'link' : ''}`}
          onClick={onTitleClick}
          onContextMenu={onTitleContextMenu}
        >
          {title}
          {count !== undefined && <span className="shelf-count">({count})</span>}
        </TitleTag>
        <span className="shelf-rule" />
        {extra}
        {(edges.left || edges.right) && (
          <span className="shelf-pager">
            <button disabled={!edges.left} onClick={() => page(-1)} aria-label="Previous">
              <ChevronLeft size={20} />
            </button>
            <button disabled={!edges.right} onClick={() => page(1)} aria-label="Next">
              <ChevronRight size={20} />
            </button>
          </span>
        )}
      </div>
      <div className="shelf-track" ref={track} onScroll={measure}>
        {itemWidths ? (
          <div className="shelf-window" ref={windowRef} style={{ width: totalWidth, height }}
            onFocus={(e) => setFocused(Number((e.target as HTMLElement).closest<HTMLElement>('[data-shelf-index]')?.dataset.shelfIndex))}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(null) }}
            onKeyDown={(e) => {
              if (focused === null) return
              const dir = e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey) ? 1 : e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 0
              const next = focused + dir
              if (!dir || next < 0 || next >= items.length) return
              e.preventDefault()
              setFocused(next)
              setWanted(next)
              const el = track.current
              if (el && offsets[next] < el.scrollLeft) el.scrollLeft = offsets[next]
              else if (el && offsets[next] + itemWidths[next] > el.scrollLeft + el.clientWidth - 20) el.scrollLeft = offsets[next] + itemWidths[next] - el.clientWidth + 20
            }}>
            {[...indices].sort((a, b) => a - b).map((i) => (
              <div key={(items[i] as { key?: string }).key ?? i} className="shelf-item" data-shelf-index={i} style={{ left: offsets[i], width: itemWidths[i] }}>{items[i]}</div>
            ))}
          </div>
        ) : children}
      </div>
    </section>
  )
}
