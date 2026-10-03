import { useLayoutEffect, useState, type RefObject } from 'react'

/** Coordinates in the content box; one update per animation frame during scroll/resize. */
export function useVirtualViewport(ref: RefObject<HTMLElement | null>): { top: number; bottom: number; width: number; capsuleWidth: number } {
  const [view, setView] = useState({ top: 0, bottom: 0, width: 0, capsuleWidth: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    const scroll = el?.closest<HTMLElement>('.scroll')
    if (!el || !scroll) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const rect = el.getBoundingClientRect()
      const parent = scroll.getBoundingClientRect()
      const top = parent.top - rect.top
      const next = { top, bottom: top + scroll.clientHeight, width: el.clientWidth, capsuleWidth: parseFloat(getComputedStyle(el).getPropertyValue('--cap-w')) || 0 }
      setView((v) => v.top === next.top && v.bottom === next.bottom && v.width === next.width && v.capsuleWidth === next.capsuleWidth ? v : next)
    }
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    observer.observe(scroll)
    // Resize does not report changes to this element's position caused by preceding shelves.
    const intersection = new IntersectionObserver(schedule, { root: scroll })
    intersection.observe(el)
    scroll.addEventListener('scroll', schedule, { passive: true })
    measure()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      scroll.removeEventListener('scroll', schedule)
    }
  }, [ref])
  return view
}

export function visibleRows(top: number, bottom: number, count: number, stride: number, overscan = 2): [number, number] {
  if (bottom < 0 || top > count * stride) return [0, 0]
  return [Math.max(0, Math.floor(top / stride) - overscan), Math.min(count, Math.ceil(bottom / stride) + overscan)]
}

/** Binary search lets large shelves render their window without scanning every child on scroll. */
export function visibleItems(offsets: number[], widths: number[], left: number, viewport: number): number[] {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (offsets[mid] + widths[mid] < left - 32) low = mid + 1
    else high = mid
  }
  const out: number[] = []
  for (let i = low; i < offsets.length && offsets[i] <= left + viewport + 32; i++) out.push(i)
  return out
}
