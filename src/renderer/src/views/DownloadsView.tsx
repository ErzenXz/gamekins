import '../styles/downloads.css'
import { ChevronDown, ChevronUp, GripVertical, Pause, Play, RotateCw, Settings as Gear, X } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import type { DownloadJob } from '@shared/types'
import { Mascot } from '../components/Mascot'
import { SpeedGraph } from '../components/SpeedGraph'
import { duration } from '../components/shell/format'
import { bytes, img, speed } from '../lib/format'
import { jobProgress } from '../lib/gameActions'
import { act, useStore } from '../store'

const RUNNING: DownloadJob['state'][] = ['preparing', 'verifying', 'downloading', 'finalizing']
const KIND = { install: 'Game content', update: 'Update', repair: 'Verify & repair' } as const
const v = (): typeof window.gamekins.downloads => window.gamekins.downloads

/** Open the game page for a job (DLC jobs open their base game). */
function openJob(j: DownloadJob): void {
  const s = useStore.getState()
  const parent = s.games.find((g) => g.dlc.some((d) => d.key === j.gameKey))
  s.navigate({ view: 'library', gameKey: parent?.key ?? j.gameKey })
}

/** Cancel / remove, asking first when it would throw away downloaded data. */
function removeJob(j: DownloadJob): void {
  const fresh = j.kind === 'install'
  const got = Math.max(j.downloadedBytes, j.writtenBytes)
  const run = (): Promise<void> => act(() => v().cancel(j.id))
  if (fresh && got > 0) {
    useStore.getState().setConfirm({
      title: `Cancel installing ${j.title}?`,
      message: `${bytes(got)} has already been downloaded to\n${j.installPath}\n\nRemoving it from the queue deletes the partial install. You can install the game again later.`,
      confirmLabel: 'Remove and delete files',
      danger: true,
      onConfirm: run
    })
  } else if (!fresh && got > 0) {
    useStore.getState().setConfirm({
      title: `Cancel this ${j.kind === 'update' ? 'update' : 'repair'}?`,
      message: `${j.title} keeps working on its current version. The ${bytes(got)} downloaded so far will be discarded.`,
      confirmLabel: 'Remove from queue',
      onConfirm: run
    })
  } else void run()
}

function etaText(j: DownloadJob): string {
  if (j.state !== 'downloading' || j.speedBps <= 0) return ''
  const left = (j.totalDownloadBytes - j.downloadedBytes) / j.speedBps
  if (!isFinite(left) || left <= 0) return ''
  if (left < 60) return 'Less than a minute remaining'
  const m = Math.round(left / 60)
  if (m < 60) return `Estimated ${m} min remaining`
  return `Estimated ${duration(left)} remaining`
}

function stateLabel(j: DownloadJob): string {
  switch (j.state) {
    case 'preparing':
      return 'Preparing'
    case 'verifying':
      return 'Verifying'
    case 'finalizing':
      return 'Finishing'
    case 'downloading':
      return j.kind === 'update' ? 'Updating' : 'Downloading'
    case 'paused':
      return 'Paused'
    case 'queued':
      return 'Queued'
    case 'error':
      return 'Error'
    default:
      return j.state
  }
}

function finishedAt(ts?: number): string {
  if (!ts) return 'Completed'
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  return `Completed: ${today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/** True while the window is short (Steam shrinks the graph so the queue stays visible). */
function useShortWindow(): boolean {
  const q = '(max-height: 720px)'
  const [short, setShort] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = (): void => setShort(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return short
}

export function DownloadsView(): React.JSX.Element {
  const graphH = useShortWindow() ? 140 : 200
  const jobs = useStore((s) => s.jobs)
  const limit = useStore((s) => s.settings?.bandwidthLimitMBps ?? 0)
  const autoUpdate = useStore((s) => s.settings?.autoUpdate ?? false)
  const allowWhilePlaying = useStore((s) => s.settings?.downloadsDuringGameplay ?? true)
  const navigate = useStore((s) => s.navigate)
  const [peak, setPeak] = useState({ id: '', net: 0 })

  const active = jobs.find((j) => RUNNING.includes(j.state))
  const upNext = upNextOf(jobs)
  const unscheduled = jobs.filter((j) => j.state === 'paused')
  const done = jobs.filter((j) => j.state === 'done').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  const waiting = !active ? upNext.find((j) => j.waitingReason) : undefined
  const pending = upNext.filter((j) => j.state === 'queued').length + unscheduled.length

  const heroKey = active?.gameKey ?? waiting?.gameKey
  const logo = useStore((s) => (heroKey ? s.games.find((g) => g.key === heroKey)?.images.logo : undefined))
  const hero = active ?? waiting

  // Peak over the whole run of the active job, not just the visible window.
  useEffect(() => {
    if (!active) return
    setPeak((p) => {
      const base = p.id === active.id ? p.net : 0
      const net = Math.max(base, active.speedBps, ...active.speedHistory)
      return net === p.net && p.id === active.id ? p : { id: active.id, net }
    })
  }, [active])

  const toSettings = (): void => navigate({ view: 'settings', section: 'downloads' })
  const nothing = !active && !upNext.length && !unscheduled.length && !done.length

  return (
    <div className="dls">
      <header className="dls-top" style={{ height: graphH }}>
        <div className={`dls-hero ${hero ? '' : 'empty'}`}>
          {hero?.image && <img className="dls-hero-img" src={img(hero.image, 900)} alt="" />}
          <div className="dls-hero-wash" />
          {hero &&
            (logo ? (
              <img className="dls-hero-logo" src={img(logo, 600)} alt={hero.title} />
            ) : (
              <div className="dls-hero-name">{hero.title}</div>
            ))}
        </div>
        <SpeedGraph network={active?.speedHistory ?? []} disk={active?.diskHistory ?? []} height={graphH} />
        <div className="dls-meters">
          <div className="dls-legend">
            <span>
              <i className="lg-net" /> Network
            </span>
            <span>
              <i className="lg-disk" /> Disk usage
            </span>
          </div>
          <div className="dls-stats tabular">
            <Stat label="Current" value={speed(active?.speedBps ?? 0)} />
            <Stat label="Peak" value={speed(active ? peak.net : 0)} />
            <Stat label="Total" value={bytes(active?.downloadedBytes ?? 0)} />
            <Stat label="Disk usage" value={speed(active?.diskBps ?? 0)} />
          </div>
        </div>
        <button className="dls-gear" onClick={toSettings} title="Download settings">
          <Gear size={16} />
        </button>
      </header>

      {active && <ActiveItem job={active} limit={limit} autoUpdate={autoUpdate} onSettings={toSettings} />}

      <div className="dls-lists scroll">
        {waiting && (
          <div className="dls-banner" role="status">
            <Pause size={16} fill="currentColor" />
            <span className="dls-banner-text">
              <b>Downloads paused while you play.</b> {waiting.waitingReason && waiting.waitingReason !== 'Paused while you play' ? waiting.waitingReason : 'They resume when your game closes.'}
            </span>
            {!allowWhilePlaying && (
              <button
                className="btn btn-blue small"
                onClick={() => act(() => useStore.getState().saveSettings({ downloadsDuringGameplay: true }), 'Downloads will continue while you play')}
              >
                Allow downloads while playing
              </button>
            )}
          </div>
        )}

        {!active && !waiting && pending > 0 && (
          <div className="dls-paused">
            <span>
              Downloads are paused · {pending} item{pending === 1 ? '' : 's'} waiting
            </span>
            <button
              className="btn btn-blue small"
              onClick={() => {
                const first = upNext.find((j) => j.state === 'queued') ?? unscheduled[0]
                if (first) void act(() => v().resume(first.id))
              }}
            >
              <Play size={12} fill="currentColor" /> Resume downloads
            </button>
          </div>
        )}

        {nothing && (
          <div className="dls-empty">
            <Mascot pose="sleep" size={112} />
            <div className="dls-empty-title">There are no downloads in the queue</div>
            <div className="dls-empty-sub">Install or update a game and it will show up here.</div>
            <button className="btn btn-ghost" onClick={() => navigate({ view: 'library' })}>
              Go to library
            </button>
          </div>
        )}

        {upNext.length > 0 && (
          <Section
            title="Up Next"
            count={upNext.length}
            note={autoUpdate ? 'Auto-updates enabled' : undefined}
            onNote={toSettings}
            action={
              upNext.some((j) => j.state === 'queued') || active
                ? {
                    label: 'Pause all',
                    run: async () => {
                      for (const j of [...(active ? [active] : []), ...upNext.filter((j) => j.state === 'queued')]) await v().pause(j.id)
                    }
                  }
                : undefined
            }
          >
            <UpNextList jobs={upNext} />
          </Section>
        )}

        {unscheduled.length > 0 && (
          <Section
            title="Unscheduled"
            count={unscheduled.length}
            action={
              !active
                ? {
                    label: 'Resume all',
                    // Resume bumps an item to the front, so go last-to-first to keep the order.
                    run: async () => {
                      for (const j of [...unscheduled].reverse()) await v().resume(j.id)
                    }
                  }
                : undefined
            }
          >
            {unscheduled.map((j) => (
              <QueueRow key={j.id} job={j} section="unscheduled" />
            ))}
          </Section>
        )}

        {done.length > 0 && (
          <Section title="Completed" count={done.length} action={{ label: 'Clear all', run: () => v().clearFinished() }}>
            {done.map((j) => (
              <QueueRow key={j.id} job={j} section="completed" />
            ))}
          </Section>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="dls-stat">
      <span className="dls-stat-value">{value}</span>
      <span className="dls-stat-label">{label}</span>
    </div>
  )
}

function Section({
  title,
  count,
  note,
  onNote,
  action,
  children
}: {
  title: string
  count: number
  note?: string
  onNote?: () => void
  action?: { label: string; run: () => Promise<unknown> }
  children: React.ReactNode
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <section className="dls-section">
      <div className="dls-section-head">
        <h3 className="dls-section-title">
          {title} <span>({count})</span>
        </h3>
        <div className="dls-rule" />
        {note && (
          <button className="dls-note" onClick={onNote}>
            {note}
          </button>
        )}
        {action && (
          <button
            className="dls-section-btn"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void act(action.run).finally(() => setBusy(false))
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      <div className="dls-list">{children}</div>
    </section>
  )
}

function Art({ job, big }: { job: DownloadJob; big?: boolean }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  return (
    <button className={`dls-art ${big ? 'big' : ''}`} onClick={() => openJob(job)} title={`Open ${job.title}`} tabIndex={-1}>
      {job.image && !failed ? (
        <img src={img(job.image, big ? 480 : 340)} alt="" onError={() => setFailed(true)} draggable={false} />
      ) : (
        <span className="dls-art-fallback">{job.title}</span>
      )}
    </button>
  )
}

function ActiveItem({
  job,
  limit,
  autoUpdate,
  onSettings
}: {
  job: DownloadJob
  limit: number
  autoUpdate: boolean
  onSettings: () => void
}): React.JSX.Element {
  const p = jobProgress(job)
  const verifying = job.state === 'verifying'
  const indeterminate = job.state === 'preparing' || (job.state === 'finalizing' && p >= 1)
  const net = job.totalDownloadBytes ? Math.min(1, job.downloadedBytes / job.totalDownloadBytes) : 0
  const eta = etaText(job)

  return (
    <section className="dls-active">
      <Art job={job} big />
      <div className="dls-active-body">
        <div className="dls-active-top">
          <button className="dls-active-title" onClick={() => openJob(job)}>
            {job.title}
          </button>
          <span className="dls-tag">
            {KIND[job.kind]}
          </span>
        </div>
        <div className="dls-active-status">
          <span className="dls-state">{stateLabel(job)}</span>
          {eta && <span className="dls-eta">{eta}</span>}
        </div>
        <div className={`dls-bar ${indeterminate ? 'indeterminate' : ''}`}>
          {!verifying && !indeterminate && <div className="net" style={{ width: `${net * 100}%` }} />}
          <div className={verifying ? 'verify' : 'disk'} style={{ width: indeterminate ? undefined : `${p * 100}%` }} />
        </div>
        <div className="dls-active-nums tabular">
          {verifying ? (
            <span>
              <b>{bytes(job.verifiedBytes)}</b> / {bytes(job.totalVerifyBytes)} verified
            </span>
          ) : (
            <span>
              <b>{bytes(job.downloadedBytes)}</b> / {bytes(job.totalDownloadBytes)} downloaded
              <span className="dls-dot">·</span>
              <b>{bytes(job.writtenBytes)}</b> / {bytes(job.totalWriteBytes)} on disk
            </span>
          )}
          {!indeterminate && <span className="dls-pct">{Math.floor(p * 100)}%</span>}
        </div>
        <div className="dls-active-foot">
          <button className="dls-throttle" onClick={onSettings} title="Change in Settings › Downloads">
            Downloads limited to: <b>{limit > 0 ? `${limit} MB/s` : 'No limit'}</b>
          </button>
          <button className="dls-throttle" onClick={onSettings}>
            {autoUpdate ? 'Auto-updates enabled' : 'Auto-updates off'}
          </button>
          {job.currentFile && (
            <span className="dls-file mono" title={job.currentFile}>
              <bdi dir="ltr">{job.currentFile}</bdi>
            </span>
          )}
        </div>
      </div>
      <div className="dls-active-actions">
        <button className="dls-pause" onClick={() => act(() => v().pause(job.id))}>
          <Pause size={16} fill="currentColor" /> Pause
        </button>
        <button className="dls-x" title="Remove from queue" onClick={() => removeJob(job)}>
          <X size={16} />
        </button>
      </div>
    </section>
  )
}

/** The Up Next list as shown: queued + failed items, minus the active one. */
function upNextOf(jobs: DownloadJob[]): DownloadJob[] {
  const active = jobs.find((j) => RUNNING.includes(j.state))
  return jobs.filter((j) => j !== active && (j.state === 'queued' || j.state === 'error'))
}

let moving = false
/**
 * Put `id` just before/after `target`. Main reorders the *full* job list (active, paused and
 * finished items included), so the delta is computed against the latest full list at click
 * time; one click is always one visible step.
 */
function moveNextTo(id: string, target: string, after: boolean): void {
  if (id === target || moving) return
  const ids = useStore.getState().jobs.map((j) => j.id)
  const i = ids.indexOf(id)
  const t = ids.indexOf(target)
  if (i < 0 || t < 0) return
  const delta = i < t ? t - i - (after ? 0 : 1) : t - i + (after ? 1 : 0)
  if (!delta) return
  moving = true
  void act(() => v().move(id, delta)).finally(() => (moving = false))
}

function moveStep(id: string, dir: -1 | 1): void {
  const list = upNextOf(useStore.getState().jobs)
  const i = list.findIndex((j) => j.id === id)
  const target = list[i + dir]
  if (i >= 0 && target) moveNextTo(id, target.id, dir > 0)
}

/** Up Next rows: reorder with the arrows or by dragging. */
function UpNextList({ jobs }: { jobs: DownloadJob[] }): React.JSX.Element {
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null)

  return (
    <>
      {jobs.map((j, idx) => (
        <div
          key={j.id}
          className={`dls-drop ${drag?.over === j.id && drag.id !== j.id ? (drag.after ? 'drop-after' : 'drop-before') : ''} ${drag?.id === j.id ? 'dragging' : ''}`}
          draggable={jobs.length > 1}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', j.id)
            setDrag({ id: j.id })
          }}
          onDragOver={(e) => {
            if (!drag) return
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            const after = e.clientY > r.top + r.height / 2
            if (drag.over !== j.id || drag.after !== after) setDrag({ ...drag, over: j.id, after })
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (drag) moveNextTo(drag.id, j.id, !!drag.after)
            setDrag(null)
          }}
          onDragEnd={() => setDrag(null)}
        >
          <QueueRow job={j} section="next" canUp={idx > 0} canDown={idx < jobs.length - 1} draggable={jobs.length > 1} />
        </div>
      ))}
    </>
  )
}

type RowProps = {
  job: DownloadJob
  section: 'next' | 'unscheduled' | 'completed'
  canUp?: boolean
  canDown?: boolean
  draggable?: boolean
}

const QueueRow = memo(
  function QueueRow({ job, section, canUp, canDown, draggable }: RowProps): React.JSX.Element {
    const p = jobProgress(job)
    const isError = job.state === 'error'
    const started = job.downloadedBytes > 0 || job.writtenBytes > 0
    const game = useStore((s) => (section === 'completed' ? s.games.find((g) => g.key === job.gameKey) : undefined))
    const playable = !!game?.install && !game.running
    const busy = useRef(false)
    const run = (fn: () => Promise<unknown>) => () => {
      if (busy.current) return
      busy.current = true
      void act(fn).finally(() => (busy.current = false))
    }

    return (
      <div className={`dls-row ${job.state} ${section}`}>
        {draggable && (
          <span className="dls-grip" title="Drag to reorder">
            <GripVertical size={18} />
          </span>
        )}
        <Art job={job} />
        <div className="dls-row-body">
          <button className="dls-row-title" onClick={() => openJob(job)}>
            {job.title}
            {job.kind !== 'install' && <span className="dls-row-kind"> {KIND[job.kind]}</span>}
          </button>
          <div className="dls-row-meta tabular">
            {section === 'completed' ? (
              <span>{bytes(job.totalWriteBytes || job.totalDownloadBytes)}</span>
            ) : isError ? (
              <span className="err" title={job.error}>
                {job.error ?? 'The download failed.'}
              </span>
            ) : job.totalDownloadBytes > 0 ? (
              <span>
                {started ? (
                  <>
                    <b>{bytes(job.downloadedBytes)}</b> / {bytes(job.totalDownloadBytes)}
                  </>
                ) : (
                  bytes(job.totalDownloadBytes)
                )}
              </span>
            ) : null}
            {job.waitingReason && <span className="dls-row-wait">{job.waitingReason}</span>}
          </div>
        </div>
        <div className="dls-row-right">
          <div className={`dls-row-status ${isError ? 'err' : ''}`}>
            {section === 'completed' ? finishedAt(job.finishedAt) : stateLabel(job)}
          </div>
          {section !== 'completed' && started && !isError && (
            <div className="dls-thin">
              <div style={{ width: `${p * 100}%` }} />
            </div>
          )}
        </div>
        <div className="dls-row-actions">
          {section === 'next' && (canUp || canDown) && (
            <span className="dls-order">
              <button className="dls-mini" disabled={!canUp} title="Move up" onClick={() => moveStep(job.id, -1)}>
                <ChevronUp size={14} />
              </button>
              <button className="dls-mini" disabled={!canDown} title="Move down" onClick={() => moveStep(job.id, 1)}>
                <ChevronDown size={14} />
              </button>
            </span>
          )}
          {section === 'completed' ? (
            game?.running ? (
              <span className="dls-running">Running</span>
            ) : playable ? (
              <button className="dls-btn play" title="Play" onClick={run(() => window.gamekins.games.launch(game.key))}>
                <Play size={18} fill="currentColor" />
              </button>
            ) : null
          ) : isError ? (
            <button className="dls-btn" title="Retry" onClick={run(() => v().resume(job.id))}>
              <RotateCw size={18} />
            </button>
          ) : (
            <>
              <button
                className="dls-btn"
                title={section === 'unscheduled' ? 'Resume (download now)' : 'Download now'}
                onClick={run(() => v().resume(job.id))}
              >
                <Play size={18} fill="currentColor" />
              </button>
              {section === 'next' && (
                <button className="dls-btn" title="Pause" onClick={run(() => v().pause(job.id))}>
                  <Pause size={18} fill="currentColor" />
                </button>
              )}
            </>
          )}
          {section !== 'completed' && (
            <button className="dls-x" title="Remove from queue" onClick={() => removeJob(job)}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    )
  },
  (a, b) =>
    a.section === b.section &&
    a.draggable === b.draggable &&
    a.canUp === b.canUp &&
    a.canDown === b.canDown &&
    a.job.id === b.job.id &&
    a.job.state === b.job.state &&
    a.job.downloadedBytes === b.job.downloadedBytes &&
    a.job.writtenBytes === b.job.writtenBytes &&
    a.job.totalDownloadBytes === b.job.totalDownloadBytes &&
    a.job.error === b.job.error &&
    a.job.waitingReason === b.job.waitingReason &&
    a.job.title === b.job.title &&
    a.job.image === b.job.image &&
    a.job.finishedAt === b.job.finishedAt
)
