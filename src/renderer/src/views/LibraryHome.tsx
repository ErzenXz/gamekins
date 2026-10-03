import { Star, X } from 'lucide-react'
import { useMemo } from 'react'
import type { Game } from '@shared/types'
import { Capsule, CapsuleSkeleton } from '../components/Capsule'
import {
  FILTER_LABELS,
  useCapsuleWidth,
  useCollections,
  useCollectionMembers,
  useFilteredGames,
  useLibraryGames
} from '../components/library/libraryData'
import { useStore } from '../store'
import { FreeGamesShelf } from './library/FreeGamesShelf'
import { GameGrid, GridTools } from './library/GameGrid'
import { RecentShelf } from './library/RecentShelf'
import { Shelf } from './library/Shelf'

export function openCollectionMenu(e: React.MouseEvent, name: string): void {
  e.preventDefault()
  e.stopPropagation()
  useStore.getState().setContextMenu({ x: e.clientX, y: e.clientY, gameKey: '', collection: name })
}

export function LibraryHome(): React.JSX.Element {
  const all = useLibraryGames()
  const games = useFilteredGames()
  const width = useCapsuleWidth()
  const collections = useCollections()
  const search = useStore((s) => s.search)
  const filter = useStore((s) => s.filter)
  const sort = useStore((s) => s.librarySort)
  const { setFilter, setSearch, setLibraryPage } = useStore.getState()

  const visible = useMemo(() => all.filter((g) => !g.prefs.hidden), [all])
  const favorites = useMemo(() => visible.filter((g) => g.prefs.favorite), [visible])
  const searching = search.trim().length > 0

  return (
    <div className="lh scroll">
      {!searching && (
        <>
          <FreeGamesShelf />
          <div className="lh-inner">
            <RecentShelf games={visible} width={width} />
            {favorites.length > 0 && (
              <CollectionShelf
                name="Favorites"
                icon={<Star size={15} className="shelf-icon fav" fill="currentColor" />}
                games={favorites}

                width={width}
              />
            )}
            {collections.map((c) => (
              <UserCollectionShelf key={c} name={c} width={width} />
            ))}
          </div>
        </>
      )}

      <section className="lh-inner lh-all">
        <div className="shelf-head">
          {searching ? (
            <h3 className="shelf-title">
              Search results <span className="shelf-count">({games.length})</span>
              <button className="lh-clear" onClick={() => setSearch('')} title="Clear search">
                <X size={14} />
              </button>
            </h3>
          ) : (
            <h3 className="shelf-title">
              {filter === 'all' ? 'All Games' : FILTER_LABELS[filter]}
              <span className="shelf-count">({games.length})</span>
            </h3>
          )}
          <span className="shelf-rule" />
          <GridTools />
        </div>

        {games.length === 0 ? (
          <div className="lh-none">
            {searching ? (
              <>
                <p>No games in your library match “{search.trim()}”.</p>
                <button className="lbtn" onClick={() => setSearch('')}>
                  Clear search
                </button>
              </>
            ) : (
              <>
                <p>Nothing here under “{FILTER_LABELS[filter]}”.</p>
                <button className="lbtn" onClick={() => setFilter('all')}>
                  Show all games
                </button>
              </>
            )}
          </div>
        ) : (
          <GameGrid games={games} width={width} sort={sort} />
        )}
      </section>
      {!searching && collections.length === 0 && favorites.length === 0 && all.length > 0 && (
        <p className="lh-hint">
          Tip: right-click a game and choose <b>Add to ▸ New collection…</b> to make your own shelves here.{' '}
          <button className="lh-link" onClick={() => setLibraryPage('collections')}>
            Collections
          </button>
        </p>
      )}
    </div>
  )
}

function CollectionShelf({
  name,
  icon,
  games,
  width
}: {
  name: string
  icon?: React.ReactNode
  games: Game[]
  width: number
}): React.JSX.Element | null {
  if (!games.length) return null
  const fav = name === 'Favorites'
  return (
    <Shelf
      className="coll-shelf"
      itemWidths={games.map(() => width)}
      itemHeight={width * 4 / 3}
      title={
        <>
          {icon}
          {name}
        </>
      }
      count={games.length}
      onTitleClick={fav ? undefined : () => useStore.getState().setLibraryPage(`collection:${name}`)}
      onTitleContextMenu={fav ? undefined : (e) => openCollectionMenu(e, name)}
    >
      {games.map((g) => (
        <Capsule key={g.key} game={g} width={width} />
      ))}
    </Shelf>
  )
}

function UserCollectionShelf({ name, width }: { name: string; width: number }): React.JSX.Element | null {
  const games = useCollectionMembers(name)
  return <CollectionShelf name={name} games={games} width={width} />
}

/** First-load placeholder: progress bar + skeleton capsules. */
export function LibraryLoading(): React.JSX.Element {
  const p = useStore((s) => s.libraryProgress)
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
  return (
    <div className="lh scroll lh-loading">
      <div className="load-card">
        <div className="load-title">Loading your library…</div>
        <div className="load-sub">
          {p.total
            ? `Fetching game details · ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`
            : 'Contacting Epic Games…'}
        </div>
        <div className={`load-bar ${p.total ? '' : 'indeterminate'}`}>
          <div style={p.total ? { width: `${pct}%` } : undefined} />
        </div>
      </div>
      <section className="lh-inner">
        <div className="game-grid" style={{ '--cap-w': '154px' } as React.CSSProperties}>
          {Array.from({ length: 18 }, (_, i) => (
            <CapsuleSkeleton key={i} />
          ))}
        </div>
      </section>
    </div>
  )
}
