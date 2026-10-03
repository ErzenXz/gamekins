const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function bytes(n: number, digits = 1): string {
  if (!n || n < 0) return '0 B'
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${UNITS[i]}`
}

export const speed = (bps: number): string => `${bytes(bps)}/s`

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function playtime(seconds: number): string {
  if (seconds < 60) return seconds ? 'Under a minute' : 'Never played'
  if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute')
  const h = seconds / 3600
  if (h < 10) {
    const v = Number(h.toFixed(1))
    return `${v} ${v === 1 ? 'hour' : 'hours'}`
  }
  return plural(Math.round(h), 'hour')
}

export function lastPlayed(ts?: number): string {
  if (!ts) return 'Never'
  const d = new Date(ts)
  const today = new Date()
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  })
}

export function eta(remainingBytes: number, bps: number): string {
  if (!bps || remainingBytes <= 0) return ''
  const s = Math.round(remainingBytes / bps)
  if (s < 60) return `${s}s left`
  // Round to whole minutes first so 7170 s reads "2h 0m", never "1h 60m".
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m left`
  return `${Math.floor(m / 60)}h ${m % 60}m left`
}

/** Ask Epic's image CDN for a resized copy so the grid doesn't pull 4K box art. */
export function img(url: string | undefined, w: number, h?: number): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    if (!/epicgames\.com$/.test(u.hostname)) return url
    u.searchParams.set('resize', '1')
    u.searchParams.set('w', String(w))
    if (h) u.searchParams.set('h', String(h))
    u.searchParams.set('quality', 'medium')
    return u.toString()
  } catch {
    return url
  }
}

/** "Oct 7" / "Oct 7, 2027" for ISO dates or timestamps. */
export function shortDate(d: string | number | undefined): string {
  if (d === undefined || d === '') return ''
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  })
}

/** Steam-style hours: "12.4 hrs", "35 min", "—". */
export function hoursShort(seconds: number): string {
  if (!seconds) return '—'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`
  const h = seconds / 3600
  return `${h < 100 ? h.toFixed(1) : Math.round(h).toLocaleString()} hrs`
}

/** Bucket a last-played timestamp like Steam's recent shelf ("Today", "This week", "October"). */
export function recentBucket(ts: number): string {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'This week'
  if (days < 14) return 'Last week'
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, {
    month: 'long',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  })
}

/** Steam-style "Recent games" bucket label ("Today", "Yesterday", "This week", "1 week ago", "March"). */
export function recentColumnLabel(ts: number): string {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'This week'
  if (days < 14) return '1 week ago'
  if (days < 21) return '2 weeks ago'
  if (days < 28) return '3 weeks ago'
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, {
    month: 'long',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  })
}

/** "Oct 3 at 4:12 PM" for activity rows. */
export function dateTime(ts: number): string {
  const d = new Date(ts)
  return `${shortDate(ts)} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

/** Last path segment ("C:\\Games\\Foo\\foo.exe" → "foo.exe"). */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}
