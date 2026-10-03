import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/** Horizontally paged Steam shelf: thin uppercase title, a rule, and pager arrows on the right. */
export function Shelf({
  title,
  count,
  extra,
  children,
  className = '',
  onTitleClick,
  onTitleContextMenu
}: {
  title: ReactNode
  count?: number
  extra?: ReactNode
  children: ReactNode
  className?: string
  onTitleClick?: () => void
  onTitleContextMenu?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const el = track.current
    if (!el) return
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
        {children}
      </div>
    </section>
  )
}
