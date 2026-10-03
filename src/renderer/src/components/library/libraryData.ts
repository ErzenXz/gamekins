import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DownloadJob, Game } from '@shared/types'
import { collectionNames, jobProgress, type Primary, primaryAction } from '../../lib/gameActions'
import { type LibraryFilter, type LibrarySort, useStore } from '../../store'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
/** Steam ignores a leading "The" when sorting titles. */
const sortKey = (t: string): string => t.replace(/^the\s+/i, '')
export const byTitle = (a: Game, b: Game): number => collator.compare(sortKey(a.title), sortKey(b.title))

/** Library games (DLC records are shown under their base game, never on their own), A→Z. */
export function useLibraryGames(): Game[] {
  const games = useStore((s) => s.games)
  return useMemo(() => games.filter((g) => !g.dlcOf).sort(byTitle), [games])
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
  return useMemo(() => {
    const q = search.trim().toLowerCase()
    return all.filter((g) => matchesFilter(g, filter) && (!q || g.title.toLowerCase().includes(q)))
  }, [all, search, filter])
}

export type FilterCounts = Record<LibraryFilter, number>

export function useFilterCounts(): FilterCounts {
  const all = useLibraryGames()
  return useMemo(() => {
    const c: FilterCounts = { all: 0, installed: 0, updates: 0, favorites: 0, hidden: 0 }
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
    return c
  }, [all])
}

export const FILTER_LABELS: Record<LibraryFilter, string> = {
  all: 'All games',
  installed: 'Ready to play',
  updates: 'Updates available',
  favorites: 'Favorites',
  hidden: 'Hidden'
}

const live = (j: DownloadJob): boolean => j.state !== 'done' && j.state !== 'cancelled'

/** Cheap fingerprint of the parts of a job that change what a tile shows. */
export function jobSig(j: DownloadJob | undefined): string {
  return j ? `${j.id}:${j.state}:${Math.floor(jobProgress(j) * 100)}` : ''
}

let sigFor: DownloadJob[] | null = null
let sigVal = ''
/** Fingerprint of every live job (memoised per jobs array). */
function liveJobsSig(jobs: DownloadJob[]): string {
  if (jobs !== sigFor) {
    sigFor = jobs
    sigVal = jobs
      .filter(live)
      .map((j) => `${j.gameKey}=${jobSig(j)}`)
      .join('|')
  }
  return sigVal
}

/**
 * Live (not finished) download jobs keyed by game key. The map only changes when a job's state
 * or whole-percent progress changes, so download ticks (4/s) don't re-render the whole library.
 * Use `useLiveJob` where byte counts / speeds must be exact.
 */
export function useJobMap(): Map<string, DownloadJob> {
  const sig = useStore((s) => liveJobsSig(s.jobs))
  return useMemo(() => {
    const m = new Map<string, DownloadJob>()
    for (const j of useStore.getState().jobs) if (live(j) && !m.has(j.gameKey)) m.set(j.gameKey, j)
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}

/** The exact live job for one game (re-renders on every tick; keep it in small components). */
export function useLiveJob(key: string): DownloadJob | undefined {
  return useStore((s) => s.jobs.find((j) => j.gameKey === key && live(j)))
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

export function sortGames(list: Game[], sort: LibrarySort): Game[] {
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
export function useCollections(): string[] {
  const games = useStore((s) => s.games)
  const empty = useStore((s) => s.emptyCollections)
  return useMemo(() => collectionNames(games, empty), [games, empty])
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

/**
 * Render big lists in chunks: the first screenful immediately, the rest over the
 * next few frames, so opening the library with hundreds of games stays snappy.
 */
export function useProgressiveCount(total: number, first = 72, step = 160): number {
  const [count, setCount] = useState(first)
  useEffect(() => {
    if (count >= total) return
    const t = setTimeout(() => startTransition(() => setCount((c) => c + step)), 16)
    return () => clearTimeout(t)
  }, [count, total, step])
  return count
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
