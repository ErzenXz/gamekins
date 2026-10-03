import '../../styles/collections.css'
import { ChevronLeft, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import type { Game } from '@shared/types'
import { LocalTile } from '../../components/Capsule'
import { Img, TitleCard } from '../../components/library/Img'
import { useCapsuleWidth, useCollections, useLibraryGames } from '../../components/library/libraryData'
import { img } from '../../lib/format'
import { confirmDeleteCollection, inCollection } from '../../lib/gameActions'
import { useStore } from '../../store'
import { openCollectionMenu } from '../LibraryHome'
import { GameGrid, GridTools } from './GameGrid'

const FAVORITES = 'Favorites'

function useCollectionGames(name: string): Game[] {
  const all = useLibraryGames()
  return useMemo(
    () => all.filter((g) => !g.prefs.hidden && (name === FAVORITES ? g.prefs.favorite : inCollection(g, name))),
    [all, name]
  )
}

/** Steam's Collections view: one tile per collection, plus "Create new collection". */
export function CollectionsPage(): React.JSX.Element {
  const all = useLibraryGames()
  const names = useCollections()
  const visible = useMemo(() => all.filter((g) => !g.prefs.hidden), [all])
  const favs = visible.filter((g) => g.prefs.favorite)
  const { setLibraryPage, setCollectionPrompt } = useStore.getState()

  return (
    <div className="lh scroll coll-page">
      <div className="lh-inner">
        <div className="shelf-head">
          <h3 className="shelf-title">
            Collections <span className="shelf-count">({names.length + (favs.length ? 1 : 0)})</span>
          </h3>
          <span className="shelf-rule" />
          <button className="lbtn" onClick={() => setCollectionPrompt({ mode: 'create' })}>
            <Plus size={14} /> Create new collection…
          </button>
        </div>
        <div className="coll-grid">
          {favs.length > 0 && (
            <CollectionTile name={FAVORITES} games={favs} onOpen={() => setLibraryPage(`collection:${FAVORITES}`)} />
          )}
          {names.map((n) => (
            <CollectionTile
              key={n}
              name={n}
              games={visible.filter((g) => inCollection(g, n))}
              onOpen={() => setLibraryPage(`collection:${n}`)}
              onMenu={(e) => openCollectionMenu(e, n)}
            />
          ))}
          <button className="coll-tile new" onClick={() => setCollectionPrompt({ mode: 'create' })}>
            <div className="coll-art">
              <Plus size={40} strokeWidth={1.4} />
            </div>
            <div className="coll-name">Create new collection</div>
          </button>
        </div>
        {names.length === 0 && (
          <p className="lh-hint">
            Collections group your games into shelves on Home and sections in the game list. You can also right-click any
            game and choose <b>Add to ▸ New collection…</b>
          </p>
        )}
      </div>
    </div>
  )
}

function CollectionTile({
  name,
  games,
  onOpen,
  onMenu
}: {
  name: string
  games: Game[]
  onOpen: () => void
  onMenu?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const stack = games.slice(0, 3)
  return (
    <button className="coll-tile" onClick={onOpen} onContextMenu={onMenu} title={name}>
      <div className="coll-art">
        {stack.length === 0 ? (
          <span className="coll-empty">Empty</span>
        ) : (
          stack.map((g, i) => (
            <div key={g.key} className={`coll-cap c${i}`}>
              {g.images.tall ? (
                <Img src={img(g.images.tall, 300, 400)} title={g.title} />
              ) : g.provider === 'local' ? (
                <LocalTile game={g} />
              ) : (
                <TitleCard title={g.title} className="img" />
              )}
            </div>
          ))
        )}
      </div>
      <div className="coll-name">
        {name === FAVORITES && <Star size={13} fill="currentColor" className="fav" />} {name}
        <span>({games.length})</span>
      </div>
    </button>
  )
}

/** One collection's games, with rename / delete. */
export function CollectionDetail({ name }: { name: string }): React.JSX.Element {
  const games = useCollectionGames(name)
  const width = useCapsuleWidth()
  const sort = useStore((s) => s.librarySort)
  const names = useCollections()
  const { setLibraryPage, setCollectionPrompt } = useStore.getState()
  const fav = name === FAVORITES
  const exists = fav || names.some((n) => n.toLowerCase() === name.toLowerCase())

  return (
    <div className="lh scroll coll-page">
      <div className="lh-inner">
        <button className="coll-back" onClick={() => setLibraryPage('collections')}>
          <ChevronLeft size={15} /> Collections
        </button>
        <div className="shelf-head">
          <h3 className="shelf-title" onContextMenu={fav ? undefined : (e) => openCollectionMenu(e, name)}>
            {fav && <Star size={15} className="shelf-icon fav" fill="currentColor" />}
            {name} <span className="shelf-count">({games.length})</span>
          </h3>
          {!fav && exists && (
            <span className="coll-actions">
              <button className="coll-icon" title="Rename collection" onClick={() => setCollectionPrompt({ mode: 'rename', name })}>
                <Pencil size={14} />
              </button>
              <button className="coll-icon" title="Delete collection" onClick={() => confirmDeleteCollection(name)}>
                <Trash2 size={14} />
              </button>
            </span>
          )}
          <span className="shelf-rule" />
          <GridTools />
        </div>
        {!exists ? (
          <div className="lh-none">
            <p>This collection no longer exists.</p>
            <button className="lbtn" onClick={() => setLibraryPage('collections')}>
              Show all collections
            </button>
          </div>
        ) : games.length === 0 ? (
          <div className="lh-none">
            <p>
              {fav
                ? 'No favorites yet. Right-click a game and choose Add to Favorites.'
                : `${name} is empty. Right-click any game and choose Add to ▸ ${name}.`}
            </p>
          </div>
        ) : (
          <GameGrid games={games} width={width} sort={sort} />
        )}
      </div>
    </div>
  )
}
