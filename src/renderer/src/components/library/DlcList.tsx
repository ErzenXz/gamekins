import { CircleArrowDown, CircleCheck, Download, KeyRound, Pause, Play, Trash2, X } from 'lucide-react'
import type { Game } from '@shared/types'
import { bytes, img } from '../../lib/format'
import { confirmCancelJob, confirmUninstallDlc, installDlc, jobProgress, jobStatus } from '../../lib/gameActions'
import { act } from '../../store'
import { Img } from './Img'
import { useTileJob } from './libraryData'

/** Steam-style DLC table: art, title, state and install/uninstall controls. */
export function DlcList({ game, compact }: { game: Game; compact?: boolean }): React.JSX.Element {
  const baseJob = useTileJob(game.key)
  // DLC files live inside the game's folder: leave them alone while it runs or downloads.
  const baseBusy = !!game.running || !!baseJob
  const busyWhy = game.running ? 'Close the game first' : 'Wait for the game’s download to finish'
  if (!game.dlc.length) return <p className="muted small">This game has no DLC in your library.</p>

  const fallbackArt = game.images.wide ?? game.images.tall
  const sorted = [...game.dlc].sort(
    (a, b) => Number(b.installable) - Number(a.installable) || Number(!!b.install) - Number(!!a.install)
  )

  return (
    <div className={`dlc-list ${compact ? 'compact' : ''}`}>
      {sorted.map((d) => <DlcRow key={d.key} d={d} game={game} baseBusy={baseBusy} busyWhy={busyWhy} fallbackArt={fallbackArt} />)}
    </div>
  )
}

function DlcRow({ d, game, baseBusy, busyWhy, fallbackArt }: { d: Game['dlc'][number]; game: Game; baseBusy: boolean; busyWhy: string; fallbackArt?: string }): React.JSX.Element {
  const job = useTileJob(d.key)
  const pct = job ? Math.floor(jobProgress(job) * 100) : 0
  return (
  <div className={`dlc-row ${d.install ? 'installed' : ''} ${!d.installable ? 'owned' : ''}`}>
    <div className="dlc-art">
      <Img src={img(d.image ?? fallbackArt, 240)} title={d.title} />
    </div>
    <div className="dlc-body">
      <div className="dlc-title">{d.title}</div>
      <div className="dlc-sub">
        {job ? (
          <>
            <span className="dlc-job">{jobStatus(job)}</span>
            <div className="dlc-progress">
              <div style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : d.install ? (
          <>
            <CircleCheck size={13} className="ok" /> Installed
            {d.install.sizeBytes > 0 && <span className="dim"> · {bytes(d.install.sizeBytes)}</span>}
            {d.updateAvailable && (
              <span className="dlc-upd">
                <CircleArrowDown size={12} /> Update available
              </span>
            )}
          </>
        ) : d.installable ? (
          <span className="dim">Not installed</span>
        ) : (
          <span className="dim">Unlocked in game · nothing to download</span>
        )}
      </div>
    </div>
    <div className="dlc-actions">
      {job ? (
        <>
          {job.state === 'paused' || job.state === 'error' ? (
            <button className="lbtn small" onClick={() => act(() => window.lodestar.downloads.resume(job.id))}>
              <Play size={12} /> {job.state === 'error' ? 'Retry' : 'Resume'}
            </button>
          ) : (
            <button className="lbtn small" onClick={() => act(() => window.lodestar.downloads.pause(job.id))}>
              <Pause size={12} /> Pause
            </button>
          )}
          <button className="dlc-uninstall" title={`Cancel download of ${d.title}`} onClick={() => confirmCancelJob(job, d.title)}>
            <X size={14} />
          </button>
        </>
      ) : !d.installable ? (
        <span className="dlc-owned">
          <KeyRound size={12} /> Owned
        </span>
      ) : d.install ? (
        <>
          {d.updateAvailable && (
            <button
              className="lbtn primary small"
              disabled={baseBusy}
              title={baseBusy ? busyWhy : `Update ${d.title}`}
              onClick={() => act(() => window.lodestar.games.update(d.key))}
            >
              Update
            </button>
          )}
          <span className="dlc-installed">
            <CircleCheck size={13} /> Installed
          </span>
          <button
            className="dlc-uninstall"
            disabled={baseBusy}
            title={baseBusy ? busyWhy : `Uninstall ${d.title}`}
            onClick={() => confirmUninstallDlc(d, game)}
          >
            <Trash2 size={14} />
          </button>
        </>
      ) : (
        <button
          className="lbtn primary small"
          disabled={!game.install || baseBusy}
          title={!game.install ? 'Install the base game first' : baseBusy ? busyWhy : `Install ${d.title}`}
          onClick={() => void installDlc(d)}
        >
          <Download size={12} /> Install
        </button>
      )}
    </div>
  </div>
  )
}
