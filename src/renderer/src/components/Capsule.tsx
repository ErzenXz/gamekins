import { memo, useEffect, useRef, useState } from 'react'
import type { DownloadJob, Game } from '@shared/types'
import { img } from '../lib/format'
import { isQuickKind, jobProgress, openMenuAt, runPrimary } from '../lib/gameActions'
import { useStore } from '../store'
import { DownloadGlyph, PlayGlyph } from './library/glyphs'
import { Img, TitleCard } from './library/Img'
import { jobSig, sameTile, useGame, usePrimary, useTileJob } from './library/libraryData'

interface CapsuleProps {
  game: Game
  job?: DownloadJob
  /** Kept for older call sites; the platform now comes from the store. */
  platform?: string
  /** Render width in px; picks a sensible image size. */
  width?: number
  /** Kept for older call sites (Steam capsules don't show a star). */
  showFavorite?: boolean
}

export function openContextMenu(e: React.MouseEvent, gameKey: string): void {
  e.preventDefault()
  e.stopPropagation()
  useStore.getState().setContextMenu({ x: e.clientX, y: e.clientY, gameKey })
}

/** Keyboard handling shared by rows and capsules: Enter/Space open, Shift+F10 / Menu key opens the menu. */
export function tileKeys(e: React.KeyboardEvent, gameKey: string, open: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    open()
  } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault()
    openMenuAt(e.currentTarget, gameKey)
  }
}

/** The program icon / initial used for non-Epic games without cover art. */
export function LocalTile({ game }: { game: Game }): React.JSX.Element {
  return (
    <div className="local-tile">
      {game.images.thumb ? <img src={game.images.thumb} alt="" draggable={false} /> : <span className="local-tile-letter">{game.title.slice(0, 1)}</span>}
      <span className="local-tile-name">{game.title}</span>
    </div>
  )
}

/** Portrait capsule used in the library grid and shelves (Steam's LibraryItemBox). */
export const Capsule = memo(
  function Capsule({ game: supplied, width = 154 }: CapsuleProps): React.JSX.Element {
    const game = useGame(supplied.key) ?? supplied
    const job = useTileJob(game.key)
    const wrap = useRef<HTMLDivElement>(null)
    const [glowReady, setGlowReady] = useState(false)
    useEffect(() => {
      const el = wrap.current
      if (!el || glowReady) return
      const observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) { setGlowReady(true); observer.disconnect() }
      })
      observer.observe(el)
      return () => observer.disconnect()
    }, [glowReady])
    const primary = usePrimary(game, job)
    const quick = isQuickKind(primary.kind)
    const pct = job ? jobProgress(job) * 100 : 0
    const open = (): void => useStore.getState().navigate({ view: 'library', gameKey: game.key })
    const w = width > 160 ? 450 : 300
    const art = img(game.images.tall, w, Math.round((w * 4) / 3))
    const glow = art ?? (game.images.thumb && game.images.thumb.startsWith('data:') ? game.images.thumb : undefined)

    return (
      <div className="cap-wrap" ref={wrap} style={{ width }} onMouseEnter={() => setGlowReady(true)} onFocus={() => setGlowReady(true)}>
        {glow && <div className="cap-glow" style={{ backgroundImage: glowReady ? `url("${glow}")` : undefined }} aria-hidden />}
        <div
          className={`cap ${game.install ? 'installed' : 'uninstalled'} ${game.running ? 'running' : ''} ${job ? 'busy' : ''}`}
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
          <div className="cap-art">
            {game.images.tall ? (
              <Img src={art} title={game.title} />
            ) : game.provider === 'local' ? (
              <LocalTile game={game} />
            ) : (
              <TitleCard title={game.title} className="img" />
            )}
          </div>
          <span className="cap-shine" aria-hidden />

          {game.running ? (
            <span className="cap-pill running">Running</span>
          ) : job?.state === 'paused' ? (
            <span className="cap-pill muted">Paused</span>
          ) : job?.state === 'queued' ? (
            <span className="cap-pill muted">Queued</span>
          ) : job?.state === 'error' ? (
            <span className="cap-pill error">Error</span>
          ) : null}

          {!game.running && game.install && game.updateAvailable && !job && game.provider !== 'local' && (
            <span className="cap-update" title="Update available" aria-label="Update available">
              <i />
            </span>
          )}

          {!game.install && !job && primary.kind === 'install' && (
            <span className="cap-uninstalled" aria-hidden>
              <DownloadGlyph />
            </span>
          )}

          {quick && (
            <button
              className={`cap-action ${primary.kind === 'play' ? 'play' : 'install'}`}
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
          )}

          {job && (
            <div className={`cap-bar ${job.state}`}>
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>
    )
  },
  (a, b) => sameTile(a.game, b.game) && jobSig(a.job) === jobSig(b.job) && a.width === b.width
)

/** Grey placeholder tile shown while the library loads. */
export function CapsuleSkeleton({ width = 154 }: { width?: number }): React.JSX.Element {
  return (
    <div className="cap-wrap" style={{ width }}>
      <div className="cap skeleton" />
    </div>
  )
}
