import { useId, useLayoutEffect, useRef, useState } from 'react'
import { rateShort } from './shell/format'

const N = 60
const GRID = [1 / 3, 2 / 3, 1]

/**
 * Steam's downloads graph: one column per network sample and a disk-usage line (with a soft
 * area fill) in the lower 60%, faint gridlines, faded in from the left. Hover shows the values.
 * Plain SVG; all colours come from CSS (`.dl-*` in downloads.css, driven by --dl-net/--dl-disk).
 */
export function SpeedGraph({
  network,
  disk,
  height = 200
}: {
  network: number[]
  disk: number[]
  height?: number
}): React.JSX.Element {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const areaId = `dl-area-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pad = (arr: number[]): number[] => [...Array(Math.max(0, N - arr.length)).fill(0), ...arr.slice(-N)]
  const net = pad(network)
  const dsk = pad(disk)
  const netMax = Math.max(512 * 1024, ...net) * 1.12
  const diskMax = Math.max(512 * 1024, ...dsk) * 1.08

  const step = width / N
  const barW = Math.max(1, Math.min(step - 1, step * 0.62))
  const barR = Math.min(2, barW / 2)
  const top = height < 180 ? 50 : 56 // room for the legend/stats row above the bars
  const plotH = height - top
  const diskTop = height - plotH * 0.6
  const diskY = (v: number): number => height - 2 - (v / diskMax) * (height - 2 - diskTop)
  const known = (i: number): boolean => i >= N - Math.min(N, Math.max(network.length, disk.length))
  const pts: string[] = []
  let firstX = 0
  let lastX = 0
  dsk.forEach((v, i) => {
    if (!known(i)) return
    const x = i * step + step / 2
    if (!pts.length) firstX = x
    lastX = x
    pts.push(`${x.toFixed(1)},${diskY(v).toFixed(1)}`)
  })
  const linePts = pts.join(' ')
  const areaPts = pts.length > 1 ? `${firstX.toFixed(1)},${height} ${linePts} ${lastX.toFixed(1)},${height}` : ''

  const onMove = (e: React.MouseEvent): void => {
    const r = wrap.current?.getBoundingClientRect()
    if (!r || !step) return
    const i = Math.max(0, Math.min(N - 1, Math.floor((e.clientX - r.left) / step)))
    setHover(known(i) ? i : null)
  }

  return (
    <div ref={wrap} className="dl-graph" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="dl-graph-svg" aria-hidden>
          <defs>
            <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="dl-area-top" />
              <stop offset="1" className="dl-area-bottom" />
            </linearGradient>
          </defs>
          {GRID.map((f) => {
            const y = Math.round(height - plotH * f) + 0.5
            return <line key={f} x1={0} x2={width} y1={y} y2={y} className="dl-grid" />
          })}
          {net.map((v, i) => {
            if (!known(i) || v <= 0) return null
            const h = Math.max(1, (v / netMax) * plotH)
            // Extra `barR` below the baseline is clipped by the SVG, so only the top corners round.
            return (
              <rect
                key={i}
                x={i * step + (step - barW) / 2}
                y={height - h}
                width={barW}
                height={h + barR}
                rx={barR}
                className={`dl-bar ${hover === i ? 'hot' : ''}`}
              />
            )
          })}
          {areaPts && <polygon points={areaPts} fill={`url(#${areaId})`} />}
          {linePts && <polyline points={linePts} className="dl-line" />}
          {hover !== null && (
            <>
              <line x1={hover * step + step / 2} x2={hover * step + step / 2} y1={top} y2={height} className="dl-guide" />
              <circle cx={hover * step + step / 2} cy={diskY(dsk[hover])} r="4" className="dl-dot" />
            </>
          )}
        </svg>
      )}
      {hover !== null && (
        <div
          className="dl-tip"
          style={{ left: Math.min(width - 150, Math.max(0, hover * step + step / 2 - 75)) }}
        >
          <div>
            <i className="sw net" /> Network <b>{rateShort(net[hover])}</b>
          </div>
          <div>
            <i className="sw disk" /> Disk usage <b>{rateShort(dsk[hover])}</b>
          </div>
        </div>
      )}
    </div>
  )
}
