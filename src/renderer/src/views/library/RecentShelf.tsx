import { memo, useMemo } from 'react'
import type { DownloadJob, Game } from '@shared/types'
import { Capsule, LocalTile, openContextMenu, tileKeys } from '../../components/Capsule'
import { DownloadGlyph, PlayGlyph } from '../../components/library/glyphs'
import { Img } from '../../components/library/Img'
import { jobSig, sameTile, usePrimary } from '../../components/library/libraryData'
import { hoursShort, img, lastPlayed, recentColumnLabel } from '../../lib/format'
import { isQuickKind, jobProgress, runPrimary } from '../../lib/gameActions'
import { useStore } from '../../store'
import { Shelf } from './Shelf'

/** Steam's "Recent Games": a big landscape card for the latest game, then portraits under time-bucket labels. */
export function RecentShelf({
  games,
  jobs,
  width
}: {
  games: Game[]
  jobs: Map<string, DownloadJob>
  width: number
}): React.JSX.Element | null {
  const recent = useMemo(
    () =>
      games
        .filter((g) => g.lastPlayed && !g.prefs.hidden)
        .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
        .slice(0, 14),
    [games]
  )
  if (!recent.length) return null

  let prev = ''
  return (
    <Shelf title="Recent Games" className="recent-shelf">
      {recent.map((g, i) => {
        const label = recentColumnLabel(g.lastPlayed!)
        const show = label !== prev
        prev = label
        return (
          <div key={g.key} className="recent-col">
            <div className="recent-label">{show ? label : ''}</div>
            {i === 0 ? (
              <FeaturedCard game={g} job={jobs.get(g.key)} width={width} />
            ) : (
              <Capsule game={g} job={jobs.get(g.key)} width={width} />
            )}
          </div>
        )
      })}
    </Shelf>
  )
}

const FeaturedCard = memo(
  function FeaturedCard({ game, job, width }: { game: Game; job?: DownloadJob; width: number }): React.JSX.Element {
    const primary = usePrimary(game, job)
    const quick = isQuickKind(primary.kind)
    const open = (): void => useStore.getState().navigate({ view: 'library', gameKey: game.key })
    const art = img(game.images.wide ?? game.images.tall, 960)
    const w = width * 2 + 16
    const h = Math.round((width * 4) / 3)
    const size = width < 132 ? 'small' : width < 187 ? 'medium' : 'large'

    return (
      <div className="cap-wrap featured-wrap" style={{ width: w }}>
        <div
          className={`featured ${size}`}
          style={{ height: h }}
          data-ctx-key={game.key}
          onClick={open}
          onDoubleClick={() => quick && void runPrimary(game, job, primary.kind)}
          onContextMenu={(e) => openContextMenu(e, game.key)}
          onKeyDown={(e) => tileKeys(e, game.key, open)}
          role="button"
          tabIndex={0}
          aria-label={game.title}
          title={game.title}
        >
          <div className="featured-art">
            {art ? <Img src={art} title={game.title} eager /> : <LocalTile game={game} />}
          </div>
          <div className="featured-foot">
            {art && <div className="featured-blur" style={{ backgroundImage: `url("${art}")` }} aria-hidden />}
            {quick ? (
              <button
                className={`featured-play ${primary.kind === 'play' ? 'play' : 'install'}`}
                title={`${primary.label} ${game.title}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  void runPrimary(game, job, primary.kind)
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {primary.kind === 'play' ? <PlayGlyph /> : <DownloadGlyph />}
              </button>
            ) : (
              <span className={`featured-state ${primary.kind}`}>{primary.kind === 'stop' ? 'Running' : primary.label}</span>
            )}
            <div className="featured-text">
              <span>
                Last played: <b>{lastPlayed(game.lastPlayed)}</b>
              </span>
              <span>
                Total: <b>{hoursShort(game.playtimeSeconds)}</b>
              </span>
            </div>
          </div>
          <span className="cap-shine" aria-hidden />
          {job && (
            <div className={`cap-bar ${job.state}`}>
              <div style={{ width: `${jobProgress(job) * 100}%` }} />
            </div>
          )}
        </div>
      </div>
    )
  },
  (a, b) => a.width === b.width && sameTile(a.game, b.game) && jobSig(a.job) === jobSig(b.job)
)
