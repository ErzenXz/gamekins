import { useMemo } from 'react'
import type { DownloadJob, Game } from '@shared/types'
import { Capsule } from '../../components/Capsule'
import { Dropdown } from '../../components/library/controls'
import {
  CAPSULE_SIZES,
  type CapsuleSize,
  groupGames,
  SORT_LABELS,
  sizeName,
  sortGames,
  useProgressiveCount
} from '../../components/library/libraryData'
import { recentColumnLabel } from '../../lib/format'
import { type LibrarySort, useStore } from '../../store'

/** Steam-sorted capsule grid with labelled subgroups, rendered progressively for big libraries. */
export function GameGrid({
  games,
  jobs,
  width,
  sort
}: {
  games: Game[]
  jobs: Map<string, DownloadJob>
  width: number
  sort: LibrarySort
}): React.JSX.Element {
  const allGroups = useMemo(() => groupGames(sortGames(games, sort), sort, recentColumnLabel), [games, sort])
  const shown = useProgressiveCount(games.length)
  const groups = useMemo(() => {
    let left = shown
    return allGroups
      .map((g) => {
        const out = { ...g, total: g.games.length, games: g.games.slice(0, Math.max(0, left)) }
        left -= g.games.length
        return out
      })
      .filter((g) => g.games.length)
  }, [allGroups, shown])

  return (
    <div className="grid-groups" style={{ '--cap-w': `${width}px` } as React.CSSProperties}>
      {groups.map((grp) => (
        <div key={grp.label || 'all'} className="grid-group">
          {grp.label && (
            <div className="grid-group-label">
              {grp.label} <span>({grp.total})</span>
            </div>
          )}
          <div className="game-grid">
            {grp.games.map((g) => (
              <Capsule key={g.key} game={g} job={jobs.get(g.key)} width={width} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const SIZE_LABEL: Record<CapsuleSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' }

/** SORT BY dropdown + Small/Medium/Large display size, as in Steam's grid header. */
export function GridTools(): React.JSX.Element {
  const sort = useStore((s) => s.librarySort)
  const size = sizeName(useStore((s) => s.gridSize))
  const { setLibrarySort, setGridSize } = useStore.getState()
  return (
    <div className="grid-tools">
      <div className="size-seg" role="radiogroup" aria-label="Display size">
        {(Object.keys(CAPSULE_SIZES) as CapsuleSize[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={size === k}
            className={`size-btn ${k} ${size === k ? 'on' : ''}`}
            title={`${SIZE_LABEL[k]} capsules`}
            onClick={() => setGridSize(CAPSULE_SIZES[k])}
          >
            <i />
          </button>
        ))}
      </div>
      <span className="sortby-label">Sort by</span>
      <Dropdown<LibrarySort>
        className="sortby"
        align="right"
        value={sort}
        onChange={setLibrarySort}
        options={(Object.keys(SORT_LABELS) as LibrarySort[]).map((s) => ({ value: s, label: SORT_LABELS[s] }))}
      />
    </div>
  )
}
