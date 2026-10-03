import type { DownloadJob, Game } from '@shared/types'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
export const byTitle = (a: Game, b: Game): number => collator.compare(a.title.replace(/^the\s+/i, ''), b.title.replace(/^the\s+/i, ''))

/** IPC snapshots contain fresh objects. Share unchanged branches, including nested DLC/install data. */
export function shareSnapshot<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next
  if (Array.isArray(previous) !== Array.isArray(next)) return next
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = Object.keys(after)
  let unchanged = keys.length === Object.keys(before).length
  const out = (Array.isArray(next) ? [] : {}) as Record<string, unknown>
  for (const key of keys) {
    out[key] = shareSnapshot(before[key], after[key])
    if (!Object.hasOwn(before, key) || out[key] !== before[key]) unchanged = false
  }
  return unchanged ? previous : out as T
}

export function shareEntities<T extends { key: string }>(previous: T[], next: T[]): T[] {
  const byKey = new Map(previous.map((item) => [item.key, item]))
  const out = next.map((item) => shareSnapshot(byKey.get(item.key), item)!)
  return out.length === previous.length && out.every((item, i) => item === previous[i]) ? previous : out
}

const libraries = new WeakMap<Game[], ReturnType<typeof buildLibrary>>()
function buildLibrary(games: Game[]) {
  const gamesByKey = new Map(games.map((g) => [g.key, g]))
  const sorted = games.filter((g) => !g.dlcOf).sort(byTitle)
  const collections = new Map<string, Game[]>()
  for (const g of sorted) for (const name of g.prefs.collections ?? []) {
    const key = name.toLowerCase()
    const list = collections.get(key) ?? []
    if (!collections.has(key)) collections.set(key, list)
    list.push(g)
  }
  const installationSignature = games.map((g) => `${g.key}:${g.install?.path ?? ''}:${g.install?.sizeBytes ?? ''}:` +
    g.dlc.map((d) => `${d.key}:${d.install?.path ?? ''}:${d.install?.sizeBytes ?? ''}`).join(';')).join('|')
  return { gamesByKey, sorted, sortedKeys: sorted.map((g) => g.key), collections, installationSignature,
    runningKeys: new Set(games.filter((g) => !!g.running).map((g) => g.key)) }
}
export function libraryIndex(games: Game[]): ReturnType<typeof buildLibrary> {
  let index = libraries.get(games)
  if (!index) { index = buildLibrary(games); libraries.set(games, index) }
  return index
}

const downloads = new WeakMap<DownloadJob[], Map<string, DownloadJob>>()
export function jobIndex(jobs: DownloadJob[]): Map<string, DownloadJob> {
  let index = downloads.get(jobs)
  if (!index) {
    index = new Map()
    for (const job of jobs) if (job.state !== 'done' && job.state !== 'cancelled' && !index.has(job.gameKey)) index.set(job.gameKey, job)
    downloads.set(jobs, index)
  }
  return index
}
