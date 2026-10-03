/** Shell-only formatting helpers (lib/format.ts is shared and read-only for the shell). */

export function timeAgo(ts?: number, now = Date.now()): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'Just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const NICE: [number, number][] = [
  [1, 4],
  [1.5, 3],
  [2, 4],
  [2.5, 5],
  [3, 3],
  [4, 4],
  [5, 5],
  [6, 3],
  [8, 4],
  [10, 5]
]

/** Rounds a value up to a "nice" axis maximum and says how many round gridline steps it splits into. */
export function niceAxis(v: number): { max: number; divisions: number } {
  if (v <= 0) return { max: 1, divisions: 4 }
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const [m, divisions] = NICE.find(([m]) => v / exp <= m + 1e-9) ?? NICE[NICE.length - 1]
  return { max: m * exp, divisions }
}

/** Compact rate label for graph axes: "40 MB/s", "512 KB/s". */
export function rateShort(bps: number): string {
  const MB = 1024 * 1024
  if (bps >= MB) {
    const v = bps / MB
    return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} MB/s`
  }
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`
  return `${Math.round(bps)} B/s`
}

/** Seconds → "1h 05m", "12m", "45s". */
export function duration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

export const isMac = (): boolean => document.documentElement.dataset.platform === 'darwin'
export const modKey = (): string => (isMac() ? '⌘' : 'Ctrl')
