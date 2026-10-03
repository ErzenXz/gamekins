import { useDeferredValue, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DownloadJob, Game } from '@shared/types'
import { collectionNames, jobProgress, type Primary, primaryAction } from '../../lib/gameActions'
import { byTitle, jobIndex, libraryIndex } from '../../lib/entityIndex'
import { type LibraryFilter, type LibrarySort, useStore } from '../../store'

export { byTitle } from '../../lib/entityIndex'

export function useLibraryGames(): Game[] {
  return useStore((s) => libraryIndex(s.games).sorted)
}

export function useGame(key: string): Game | undefined {
  return useStore((s) => libraryIndex(s.games).gamesByKey.get(key))
}

export function useCollectionMembers(name: string): Game[] {
  const all = useStore((s) => libraryIndex(s.games).collections.get(name.toLowerCase()) ?? EMPTY_GAMES)
  return useMemo(() => all.filter((g) => !g.prefs.hidden), [all])
}
const EMPTY_GAMES: Game[] = []
const filteredCache = new WeakMap<Game[], Map<string, Game[]>>()
function filteredGames(all: Game[], search: string, filter: LibraryFilter): Game[] {
  const q = search.trim().toLowerCase()
  let cache = filteredCache.get(all)
  if (!cache) { cache = new Map(); filteredCache.set(all, cache) }
  const key = JSON.stringify([q, filter])
  let games = cache.get(key)
  if (!games) {
    games = all.filter((g) => matchesFilter(g, filter) && (!q || g.title.toLowerCase().includes(q)))
    if (cache.size >= 8) cache.delete(cache.keys().next().value!)
    cache.set(key, games)
  }
  return games
}

export function matchesFilter(g: Game, filter: LibraryFilter): boolean {
  if (filter === 'hidden') return !!g.prefs.hidden
  if (g.prefs.hidden) return false
  if (filter === 'installed') return !!g.install
  if (filter === 'updates') return !!g.install && g.updateAvailable && g.provider !== 'local'
  if (filter === 'favorites') return !!g.prefs.favorite
  return true
}

/** Games matching the current filter + search, A→Z. Hidden games only appear under the Hidden filter. */
export function useFilteredGames(): Game[] {
  const all = useLibraryGames()
  const { search: liveSearch, filter } = useStore(useShallow((s) => ({ search: s.search, filter: s.filter })))
  // Typing stays responsive; the (possibly 1000-row) filter runs at lower priority.
  const search = useDeferredValue(liveSearch)
  return filteredGames(all, search, filter)
}

export type FilterCounts = Record<LibraryFilter, number>
const countsCache = new WeakMap<Game[], FilterCounts>()

export function useFilterCounts(): FilterCounts {
  const all = useLibraryGames()
  let c = countsCache.get(all)
  if (!c) {
    c = { all: 0, installed: 0, updates: 0, favorites: 0, hidden: 0 }
    for (const g of all) {
      if (g.prefs.hidden) {
        c.hidden++
        continue
      }
      c.all++
      if (g.install) c.installed++
      if (matchesFilter(g, 'updates')) c.updates++
      if (g.prefs.favorite) c.favorites++
    }
    countsCache.set(all, c)
  }
  return c
}

export const FILTER_LABELS: Record<LibraryFilter, string> = {
  all: 'All games',
  installed: 'Ready to play',
  updates: 'Updates available',
  favorites: 'Favorites',
  hidden: 'Hidden'
}


/** Cheap fingerprint of the parts of a job that change what a tile shows. */
export function jobSig(j: DownloadJob | undefined): string {
  return j ? `${j.id}:${j.state}:${Math.floor(jobProgress(j) * 100)}` : ''
}

/** Only a tile's state / whole-percent changes trigger its subscription. */
const tileJobCache = new WeakMap<DownloadJob[], Map<string, DownloadJob>>()
let previousTileJobs = new Map<string, DownloadJob>()
export function tileJobIndex(jobs: DownloadJob[]): Map<string, DownloadJob> {
  let index = tileJobCache.get(jobs)
  if (!index) {
    index = new Map()
    for (const [key, job] of jobIndex(jobs)) {
      const previous = previousTileJobs.get(key)
      index.set(key, jobSig(previous) === jobSig(job) ? previous! : job)
    }
    tileJobCache.set(jobs, index)
    previousTileJobs = index
  }
  return index
}

export function useTileJob(key: string): DownloadJob | undefined {
  return useStore((s) => tileJobIndex(s.jobs).get(key))
}

export function useLiveJob(key: string): DownloadJob | undefined {
  return useStore((s) => jobIndex(s.jobs).get(key))
}

/** Cheap equality for the parts of a game a tile / row renders (IPC sends fresh objects every update). */
export function sameTile(a: Game, b: Game): boolean {
  return (
    a === b ||
    (a.key === b.key &&
      a.title === b.title &&
      a.provider === b.provider &&
      a.images.tall === b.images.tall &&
      a.images.thumb === b.images.thumb &&
      a.images.wide === b.images.wide &&
      !!a.install === !!b.install &&
      a.updateAvailable === b.updateAvailable &&
      !!a.running === !!b.running &&
      !!a.prefs.favorite === !!b.prefs.favorite &&
      !!a.prefs.hidden === !!b.prefs.hidden &&
      (a.prefs.collections ?? []).join() === (b.prefs.collections ?? []).join() &&
      a.platforms.join() === b.platforms.join() &&
      a.thirdPartyManagedApp === b.thirdPartyManagedApp &&
      a.lastPlayed === b.lastPlayed &&
      a.playtimeSeconds === b.playtimeSeconds)
  )
}

const sortCache = new WeakMap<Game[], Map<LibrarySort, Game[]>>()
export function sortGames(list: Game[], sort: LibrarySort): Game[] {
  let cache = sortCache.get(list)
  if (!cache) { cache = new Map(); sortCache.set(list, cache) }
  const cached = cache.get(sort)
  if (cached) return cached
  const out = sortUncached(list, sort)
  cache.set(sort, out)
  return out
}

function sortUncached(list: Game[], sort: LibrarySort): Game[] {
  const out = [...list]
  switch (sort) {
    case 'recent':
      return out.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || byTitle(a, b))
    case 'playtime':
      return out.sort((a, b) => b.playtimeSeconds - a.playtimeSeconds || byTitle(a, b))
    case 'size':
      return out.sort((a, b) => (b.install?.sizeBytes ?? -1) - (a.install?.sizeBytes ?? -1) || byTitle(a, b))
    case 'installed':
      return out.sort((a, b) => Number(!!b.install) - Number(!!a.install) || byTitle(a, b))
    default:
      return out.sort(byTitle)
  }
}

export const SORT_LABELS: Record<LibrarySort, string> = {
  alpha: 'Alphabetical',
  playtime: 'Hours Played',
  recent: 'Last Played',
  size: 'Size on Disk',
  installed: 'Installed State'
}

/** Platform string (`win32`/`darwin`) of this machine. */
export function usePlatform(): string {
  return useStore((s) => s.info?.platform ?? 'win32')
}

/** Primary action for a game, aware of in-flight launches and moves. */
export function usePrimary(game: Game, job: DownloadJob | undefined): Primary {
  const platform = usePlatform()
  const launching = useStore((s) => !!s.launching[game.key])
  const moving = useStore((s) => !!s.moving[game.key])
  return primaryAction(game, job, platform, { launching, moving })
}

/** All user collections (A→Z). */
const collectionCache = new WeakMap<Game[], WeakMap<string[], string[]>>()
export function useCollections(): string[] {
  const games = useStore((s) => s.games)
  const empty = useStore((s) => s.emptyCollections)
  let cache = collectionCache.get(games)
  if (!cache) { cache = new WeakMap(); collectionCache.set(games, cache) }
  let names = cache.get(empty)
  if (!names) { names = collectionNames(games, empty); cache.set(empty, names) }
  return names
}

/** Steam's library display sizes (portrait capsule width). */
export const CAPSULE_SIZES = { small: 110, medium: 154, large: 220 } as const
export type CapsuleSize = keyof typeof CAPSULE_SIZES

export function sizeName(px: number): CapsuleSize {
  if (px < 132) return 'small'
  if (px < 187) return 'medium'
  return 'large'
}

/** Snap whatever is stored (older builds had a free slider) to a Steam size. */
export function useCapsuleWidth(): number {
  return CAPSULE_SIZES[sizeName(useStore((s) => s.gridSize))]
}

/** Steam splits some sorts into labelled groups ("Over 10 Hours", "Not Installed", "March"…). */
export function groupGames(list: Game[], sort: LibrarySort, bucket: (ts: number) => string): { label: string; games: Game[] }[] {
  const out: { label: string; games: Game[] }[] = []
  const push = (label: string, g: Game): void => {
    const last = out.at(-1)
    if (last?.label === label) last.games.push(g)
    else out.push({ label, games: [g] })
  }
  if (sort === 'installed') {
    for (const g of list) push(g.install ? 'Installed' : 'Not Installed', g)
    return out
  }
  if (sort === 'recent') {
    for (const g of list) push(g.lastPlayed ? bucket(g.lastPlayed) : 'Never Played', g)
    return out
  }
  if (sort === 'playtime') {
    for (const g of list) {
      const h = g.playtimeSeconds / 3600
      push(h >= 100 ? 'Over 100 Hours' : h >= 10 ? 'Over 10 Hours' : h >= 1 ? 'Over 1 Hour' : g.playtimeSeconds ? 'Under 1 Hour' : 'Unplayed', g)
    }
    return out
  }
  if (sort === 'size') {
    for (const g of list) push(g.install ? 'Installed' : 'Not Installed', g)
    return out
  }
  return list.length ? [{ label: '', games: list }] : []
}
