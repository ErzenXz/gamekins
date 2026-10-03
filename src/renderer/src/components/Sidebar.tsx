import { CircleArrowDown, EyeOff, ListFilter, MonitorX, Play, RefreshCw, Search, Star, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DownloadJob, Game } from '@shared/types'
import { img, recentColumnLabel } from '../lib/format'
import { availableHere, inCollection, isQuickKind, jobPhrase, jobProgress, primaryAction, runPrimary } from '../lib/gameActions'
import { type LibraryFilter, useStore } from '../store'
import { openContextMenu, tileKeys } from './Capsule'
import { Dropdown } from './library/controls'
import { ClockGlyph, CollapseGlyph, GridGlyph, HouseArt, ProgressRing, ReadyGlyph } from './library/glyphs'
import {
  FILTER_LABELS,
  jobSig,
  sameTile,
  useCollections,
  useFilterCounts,
  useFilteredGames,
  useLibraryGames,
  usePlatform,
  useGame,
  useTileJob
} from './library/libraryData'

// Kept for older imports.
export { useFilteredGames }

interface Section {
  id: string
  label: string
  games: Game[]
  /** User collection name (enables the rename / delete menu). */
  collection?: string
}

type Row =
  | { t: 'h'; id: string; label: string; count: number; collection?: string; top: number }
  | { t: 'g'; id: string; game: Game; top: number }

const ROW_H = 24
const HEAD_H = 30
const OVERSCAN = 12

const COLLAPSE_KEY = 'lodestar.sidebar.collapsed'
function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

const FILTER_ICONS: Record<LibraryFilter, React.JSX.Element> = {
  all: <ListFilter size={14} />,
  installed: <Play size={13} />,
  updates: <CircleArrowDown size={14} />,
  favorites: <Star size={14} />,
  hidden: <EyeOff size={14} />
}

export function Sidebar(): React.JSX.Element {
  const gameKey = useStore((s) => (s.route.view === 'library' ? s.route.gameKey : undefined))
  const page = useStore((s) => s.libraryPage)
  const search = useStore((s) => s.search)
  const filter = useStore((s) => s.filter)
  const recentMode = useStore((s) => s.sideRecent)
  const refreshing = useStore((s) => s.refreshing)
  const progress = useStore((s) => s.libraryProgress)
  const { navigate, setSearch, setFilter, refresh, setLibraryPage, setSideRecent } = useStore.getState()

  const all = useLibraryGames()
  const games = useFilteredGames()
  const counts = useFilterCounts()
  const collections = useCollections()
  const platform = usePlatform()
  const mac = platform === 'darwin'
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', at: 0 })
  const [view, setView] = useState({ top: 0, height: 600 })

  const loadingFirst = all.length === 0 && (progress.loading || refreshing)
  const homeActive = !gameKey && page === 'home'

  const sections = useMemo<Section[]>(() => {
    if (filter === 'hidden') return [{ id: 'hidden', label: 'Hidden', games }]
    if (recentMode) {
      const out: Section[] = []
      const sorted = [...games].sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
      for (const g of sorted) {
        const label = g.lastPlayed ? recentColumnLabel(g.lastPlayed) : 'Never played'
        const last = out.at(-1)
        if (last?.label === label) last.games.push(g)
        else out.push({ id: `recent:${label}`, label, games: [g] })
      }
      return out
    }
    const out: Section[] = []
    const fav = games.filter((g) => g.prefs.favorite)
    if (fav.length) out.push({ id: 'favorites', label: 'Favorites', games: fav })
    for (const c of collections) {
      const list = games.filter((g) => inCollection(g, c))
      if (list.length) out.push({ id: `c:${c}`, label: c, games: list, collection: c })
    }
    const running = games.filter((g) => g.running)
    if (running.length) out.push({ id: 'running', label: 'Running', games: running })
    if (filter !== 'updates') {
      const upd = games.filter((g) => g.install && g.updateAvailable && g.provider !== 'local')
      if (upd.length) out.push({ id: 'updates', label: 'Updates', games: upd })
    }
    if (collections.length || fav.length) {
      const rest = games.filter((g) => !g.prefs.favorite && !(g.prefs.collections ?? []).length)
      if (rest.length) out.push({ id: 'all', label: 'Uncategorized', games: rest })
    } else {
      out.push({ id: 'all', label: filter === 'all' ? 'All games' : FILTER_LABELS[filter], games })
    }
    return out
  }, [games, filter, recentMode, collections])

  const { rows, total } = useMemo(() => {
    const rows: Row[] = []
    let top = 0
    for (const s of sections) {
      rows.push({ t: 'h', id: s.id, label: s.label, count: s.games.length, collection: s.collection, top })
      top += HEAD_H
      if (collapsed[s.id]) continue
      for (const g of s.games) {
        rows.push({ t: 'g', id: `${s.id}/${g.key}`, game: g, top })
        top += ROW_H
      }
    }
    return { rows, total: top + 8 }
  }, [sections, collapsed])

  /** Keys in on-screen order (first occurrence), for keyboard navigation. */
  const order = useMemo(() => {
    const seen = new Set<string>()
    const keys: string[] = []
    for (const r of rows) {
      if (r.t !== 'g' || seen.has(r.game.key)) continue
      seen.add(r.game.key)
      keys.push(r.game.key)
    }
    return keys
  }, [rows])

  // Track the viewport for virtualization.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight })))
    ro.observe(el)
    setView({ top: el.scrollTop, height: el.clientHeight })
    return () => ro.disconnect()
  }, [loadingFirst])

  const onScroll = (): void => {
    const el = listRef.current
    if (el) setView((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }))
  }

  const scrollToKey = useCallback(
    (key: string) => {
      const el = listRef.current
      const row = rows.find((r) => r.t === 'g' && r.game.key === key)
      if (!el || !row) return
      if (row.top < el.scrollTop + HEAD_H) el.scrollTop = Math.max(0, row.top - HEAD_H)
      else if (row.top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = row.top + ROW_H - el.clientHeight
    },
    [rows]
  )

  const select = useCallback(
    (key: string | undefined) => {
      if (!key) return
      navigate({ view: 'library', gameKey: key })
      scrollToKey(key)
    },
    [navigate, scrollToKey]
  )

  // Bring the open game into view when it changes from elsewhere (Home, search, links).
  useEffect(() => {
    if (gameKey) scrollToKey(gameKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameKey])

  const toggle = (id: string): void => {
    const next = { ...collapsed, [id]: !collapsed[id] }
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  // Ctrl/Cmd+F focuses the search box, like Steam (not while a dialog is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (document.querySelector('.modal-backdrop')) return
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return
    const i = gameKey ? order.indexOf(gameKey) : -1
    const go = (k: number): void => {
      e.preventDefault()
      select(order[Math.max(0, Math.min(order.length - 1, k))])
    }
    const page = Math.max(1, Math.floor(view.height / ROW_H) - 2)
    switch (e.key) {
      case 'ArrowDown':
        return go(i + 1)
      case 'ArrowUp':
        return go(i < 0 ? 0 : i - 1)
      case 'Home':
        return go(0)
      case 'End':
        return go(order.length - 1)
      case 'PageDown':
        return go(i + page)
      case 'PageUp':
        return go(i - page)
      case 'Enter': {
        const g = all.find((x) => x.key === gameKey)
        if (!g) return
        e.preventDefault()
        playOrInstall(g)
        return
      }
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return
        const el = gameKey && listRef.current?.querySelector(`[data-key="${CSS.escape(gameKey)}"]`)
        if (el && gameKey) {
          e.preventDefault()
          const r = el.getBoundingClientRect()
          useStore.getState().setContextMenu({ x: r.left + 24, y: r.bottom, gameKey })
        }
        return
      }
    }
    // Type-ahead: jump to the first title starting with what was typed.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = typeahead.current
      const now = Date.now()
      t.text = (now - t.at > 700 ? '' : t.text) + e.key.toLowerCase()
      t.at = now
      const byKey = new Map(all.map((g) => [g.key, g]))
      const hit = order.find((k) => byKey.get(k)?.title.toLowerCase().startsWith(t.text))
      if (hit) select(hit)
    }
  }

  const filterOptions = (Object.keys(FILTER_LABELS) as LibraryFilter[])
    .filter((f) => f !== 'hidden' || counts.hidden > 0 || filter === 'hidden')
    .map((f) => ({ value: f, label: FILTER_LABELS[f], hint: counts[f], icon: FILTER_ICONS[f] }))

  // Visible slice of rows.
  let first = 0
  let lo = 0
  let hi = rows.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].top < view.top) {
      first = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const start = Math.max(0, first - OVERSCAN)
  const endTop = view.top + view.height
  let end = first
  while (end < rows.length && rows[end].top < endTop) end++
  const slice = rows.slice(start, Math.min(rows.length, end + OVERSCAN))

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="side-home-row">
          <button
            className={`side-home ${homeActive ? 'active' : ''}`}
            onClick={() => {
              setLibraryPage('home')
              navigate({ view: 'library' })
            }}
          >
            <HouseArt />
            <span>Home</span>
          </button>
          <button
            className={`side-colls ${!gameKey && page !== 'home' ? 'active' : ''}`}
            title="Collections"
            onClick={() => {
              setLibraryPage('collections')
              navigate({ view: 'library' })
            }}
          >
            <GridGlyph />
          </button>
        </div>
      </div>

      <div className="side-filters">
        <Dropdown
          className="side-type"
          value={filter}
          options={filterOptions}
          onChange={setFilter}
          title="Show"
          label={<span className="side-type-label">{filter === 'all' ? 'Games' : FILTER_LABELS[filter]}</span>}
        />
        <button
          className={`side-toggle ${recentMode ? 'on' : ''}`}
          title={recentMode ? 'Sorted by recent activity' : 'Sort by recent activity'}
          aria-pressed={recentMode}
          onClick={() => setSideRecent(!recentMode)}
        >
          <ClockGlyph />
        </button>
        <button
          className={`side-toggle ${filter === 'installed' ? 'on' : ''}`}
          title="Ready to play (installed games only)"
          aria-pressed={filter === 'installed'}
          onClick={() => setFilter(filter === 'installed' ? 'all' : 'installed')}
        >
          <ReadyGlyph />
        </button>
      </div>

      <div className="side-search-row">
        <div className={`side-search ${search ? 'has-text' : ''}`}>
          <Search size={15} className="side-search-ico" />
          <input
            ref={searchRef}
            placeholder="Search"
            aria-label="Search your library"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (search) {
                  e.stopPropagation()
                  setSearch('')
                } else searchRef.current?.blur()
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault()
                if (order[0]) {
                  select(order[0])
                  listRef.current?.focus()
                }
              }
            }}
          />
          {search ? (
            <button className="side-search-clear" title="Clear search" onClick={() => setSearch('')}>
              <X size={14} />
            </button>
          ) : (
            <kbd className="side-kbd">{mac ? '⌘F' : 'Ctrl F'}</kbd>
          )}
        </div>
        <button className="side-refresh" title="Refresh library" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
        </button>
      </div>

      {progress.loading && progress.total > 0 && (
        <div className="side-loading" title={`Loading library ${progress.done}/${progress.total}`}>
          <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
      )}

      <div className="side-list" ref={listRef} tabIndex={0} onKeyDown={onListKey} onScroll={onScroll} aria-label="Games">
        {loadingFirst ? (
          <SideSkeleton />
        ) : (
          <div className="side-space" style={{ height: total }}>
            {slice.map((r) =>
              r.t === 'h' ? (
                <button
                  key={r.id}
                  className={`side-group ${collapsed[r.id] ? 'collapsed' : ''}`}
                  style={{ top: r.top }}
                  onClick={() => toggle(r.id)}
                  onContextMenu={(e) => {
                    if (!r.collection) return
                    e.preventDefault()
                    useStore.getState().setContextMenu({ x: e.clientX, y: e.clientY, gameKey: '', collection: r.collection })
                  }}
                  tabIndex={-1}
                  title={collapsed[r.id] ? 'Expand' : 'Collapse'}
                >
                  <CollapseGlyph open={!collapsed[r.id]} />
                  <span className="side-group-name">{r.label}</span>
                  <span className="side-group-count">({r.count})</span>
                </button>
              ) : (
                <SideRow
                  key={r.id}
                  game={r.game}
                  selected={gameKey === r.game.key}
                  top={r.top}
                  platform={platform}
                />
              )
            )}
          </div>
        )}
        {!loadingFirst && games.length === 0 && (
          <div className="side-empty">
            {search ? (
              <>
                No games match “{search}”.
                <button onClick={() => setSearch('')}>Clear search</button>
              </>
            ) : filter !== 'all' ? (
              <>
                Nothing in {FILTER_LABELS[filter]}.<button onClick={() => setFilter('all')}>Show all games</button>
              </>
            ) : (
              <>
                Your library is empty.
                <button onClick={() => useStore.getState().setAddGameOpen(true)}>Add a non-Epic game…</button>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

/** Double-click / Enter: Steam's primary action (Play, Install or Update). */
function playOrInstall(g: Game): void {
  const s = useStore.getState()
  const job = s.jobs.find((j) => j.gameKey === g.key && j.state !== 'done' && j.state !== 'cancelled')
  const p = primaryAction(g, job, s.info?.platform ?? 'win32', { launching: s.launching[g.key], moving: s.moving[g.key] })
  if (isQuickKind(p.kind)) void runPrimary(g, job, p.kind)
}

const SideRow = memo(
  function SideRow({
    game: supplied,
    selected,
    top,
    platform
  }: {
    game: Game
    job?: DownloadJob
    selected: boolean
    top: number
    platform: string
  }): React.JSX.Element {
    const game = useGame(supplied.key) ?? supplied
    const job = useTileJob(game.key)
    const launching = useStore((s) => !!s.launching[game.key])
    const open = (): void => useStore.getState().navigate({ view: 'library', gameKey: game.key })
    const local = game.provider === 'local'
    const updating = !!job || (!!game.install && game.updateAvailable && !local)
    const unavailable = !game.install && !availableHere(game, platform)

    let suffix: React.ReactNode = null
    if (game.running) suffix = <span className="sfx run">Running</span>
    else if (launching) suffix = <span className="sfx run">Launching</span>
    else if (job) {
      const pct = Math.floor(jobProgress(job) * 100)
      const active = job.state === 'downloading' || job.state === 'verifying'
      suffix = (
        <span className={`sfx ${job.state === 'error' ? 'err' : 'dl'}`}>
          {jobPhrase(job)}
          {active ? ` ${pct}%` : ''}
        </span>
      )
    } else if (updating) suffix = <span className="sfx dl">Update Required</span>

    const state = game.running ? 'running' : updating ? 'updating' : game.install ? 'installed' : 'uninstalled'
    const thumb = game.images.thumb ?? game.images.tall
    const ring = job && job.state !== 'error'

    return (
      <div
        data-key={game.key}
        data-ctx-key={game.key}
        className={`side-game ${state} ${selected ? 'selected' : ''}`}
        style={{ top }}
        onClick={open}
        onDoubleClick={() => playOrInstall(game)}
        onContextMenu={(e) => openContextMenu(e, game.key)}
        onKeyDown={(e) => tileKeys(e, game.key, open)}
        title={game.title}
        role="option"
        aria-selected={selected}
      >
        <span className={`side-icon ${ring ? 'ringed' : ''}`}>
          {thumb ? (
            <img src={thumb.startsWith('data:') ? thumb : img(thumb, 64)} alt="" loading="lazy" decoding="async" draggable={false} />
          ) : (
            <span className="side-icon-letter">{game.title.slice(0, 1)}</span>
          )}
          {ring && <ProgressRing pct={jobProgress(job)} paused={job.state === 'paused' || job.state === 'queued'} />}
        </span>
        <span className="side-name">
          <span className="side-title">{game.title}</span>
          {suffix && (
            <>
              <span className="sfx-dash"> - </span>
              {suffix}
            </>
          )}
        </span>
        {unavailable && (
          <MonitorX size={13} className="side-badge" aria-label={`Not available on ${platform === 'darwin' ? 'macOS' : 'Windows'}`} />
        )}
      </div>
    )
  },
  (a, b) =>
    a.selected === b.selected &&
    a.top === b.top &&
    a.platform === b.platform &&
    sameTile(a.game, b.game) &&
    jobSig(a.job) === jobSig(b.job)
)

function SideSkeleton(): React.JSX.Element {
  return (
    <div className="side-skeleton">
      {Array.from({ length: 14 }, (_, i) => (
        <div key={i} className="side-skel-row">
          <span />
          <span style={{ width: `${40 + ((i * 37) % 45)}%` }} />
        </div>
      ))}
    </div>
  )
}
