import { Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DownloadJob, DownloadKind } from '@shared/types'
import { provider } from '../providers'
import { library } from './library'
import { settings } from './settings'
import { JsonStore } from './store'

const HISTORY = 60
const ACTIVE: DownloadJob['state'][] = ['preparing', 'verifying', 'downloading', 'finalizing']
const LIVE: DownloadJob['state'][] = [...ACTIVE, 'queued', 'paused']

/** Free space on the volume that holds `path` (walks up to the nearest existing folder). */
export async function freeBytes(path: string): Promise<number> {
  let p = path
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p)
  try {
    const s = await statfs(p)
    return s.bavail * s.bsize
  } catch {
    return 0
  }
}

/** Token-bucket bandwidth limiter shared by all chunk workers. Rate is read live from settings. */
class Throttle {
  private allowance = 0
  private last = Date.now()

  async take(bytes: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      const limit = settings().bandwidthLimitMBps * 1024 * 1024
      if (!limit) return
      const now = Date.now()
      // Allow up to one second of burst.
      this.allowance = Math.min(limit, this.allowance + ((now - this.last) / 1000) * limit)
      this.last = now
      if (this.allowance >= bytes || bytes > limit) {
        this.allowance -= bytes
        return
      }
      if (signal.aborted) return
      await new Promise((r) => setTimeout(r, Math.min(1000, ((bytes - this.allowance) / limit) * 1000)))
    }
  }
}

/**
 * Steam-style download queue: one active job at a time, the rest wait in line.
 * Unfinished jobs survive restarts and resume from the per-install resume log.
 */
class Downloads extends EventEmitter {
  private readonly store = new JsonStore<{ jobs: DownloadJob[] }>('downloads', { jobs: [] })
  private active: { job: DownloadJob; controller: AbortController } | null = null
  private readonly throttle = new Throttle()
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    for (const job of this.store.data.jobs) {
      // Anything that was mid-flight when we quit goes back in the queue.
      if (ACTIVE.includes(job.state)) job.state = 'queued'
      job.speedBps = 0
      job.diskBps = 0
      job.diskHistory ??= []
      job.speedHistory ??= []
    }
  }

  get jobs(): DownloadJob[] {
    return this.store.data.jobs
  }

  start(): void {
    library.on('running', (_key: string, isRunning: boolean) => {
      if (isRunning && !settings().downloadsDuringGameplay && this.active) {
        // Steam behaviour: get out of the way while you play.
        this.preempt(this.active.job)
      }
      this.pump()
    })
    this.pump()
  }

  /** Re-evaluate the queue (e.g. after a settings change). */
  kick(): void {
    this.pump()
  }

  private emitNow(): void {
    this.lastEmit = Date.now()
    this.store.save()
    this.emit('changed', this.jobs)
  }

  /** Progress fires constantly; the UI only needs ~4 updates a second. */
  private emitSoon(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, 250 - (Date.now() - this.lastEmit))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emitNow()
    }, wait)
  }

  find(gameKey: string): DownloadJob | undefined {
    return this.jobs.find((j) => j.gameKey === gameKey && LIVE.includes(j.state))
  }

  enqueue(gameKey: string, kind: DownloadKind, installPath: string): DownloadJob {
    const existing = this.find(gameKey)
    if (existing) return existing
    const game = library.get(gameKey)
    if (!game) throw new Error('Unknown game')
    // Replace any finished/failed entry for the same game so the list stays tidy.
    this.store.data.jobs = this.jobs.filter((j) => j.gameKey !== gameKey)
    const parent = game.dlcOf ? library.get(game.dlcOf) : undefined
    const job: DownloadJob = {
      id: randomUUID(),
      gameKey,
      title: parent ? `${parent.title}: ${game.title}` : game.title,
      image: game.images.wide ?? game.images.tall ?? parent?.images.wide,
      kind,
      state: 'queued',
      installPath,
      downloadedBytes: 0,
      totalDownloadBytes: 0,
      writtenBytes: 0,
      totalWriteBytes: 0,
      verifiedBytes: 0,
      totalVerifyBytes: 0,
      speedBps: 0,
      diskBps: 0,
      speedHistory: [],
      diskHistory: [],
      addedAt: Date.now()
    }
    this.jobs.push(job)
    this.emitNow()
    this.pump()
    return job
  }

  /** Stop the active job but leave it first in line. */
  private preempt(job: DownloadJob): void {
    if (this.active?.job !== job) return
    this.active.controller.abort()
    job.state = 'queued'
    job.speedBps = 0
    job.diskBps = 0
  }

  pause(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    if (this.active?.job.id === id) this.active.controller.abort()
    if (job.state !== 'done') job.state = 'paused'
    job.speedBps = 0
    job.diskBps = 0
    this.emitNow()
  }

  resume(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || !['paused', 'error', 'queued'].includes(job.state)) return
    const retry = job.state === 'error'
    job.state = 'queued'
    job.error = undefined
    if (!retry) {
      // "Start now" / resume bumps it to the front, like Steam. A retry just rejoins the queue.
      this.store.data.jobs = [job, ...this.jobs.filter((j) => j !== job)]
      if (this.active && this.active.job.id !== id) this.preempt(this.active.job)
    }
    this.emitNow()
    this.pump()
  }

  /** Reorder the queue (delta -1 = up, +1 = down). */
  move(id: string, delta: number): void {
    const list = this.jobs
    const i = list.findIndex((j) => j.id === id)
    if (i < 0) return
    const k = Math.max(0, Math.min(list.length - 1, i + delta))
    const [job] = list.splice(i, 1)
    list.splice(k, 0, job)
    this.emitNow()
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    if (this.active?.job.id === id) this.active.controller.abort()
    job.state = 'cancelled'
    this.store.data.jobs = this.jobs.filter((j) => j !== job)
    this.emitNow()
    // A cancelled fresh install shouldn't leave half a game behind (never touch DLC's parent folder).
    const game = library.providerGame(job.gameKey)
    await new Promise((r) => setTimeout(r, 500))
    if (job.kind === 'install' && !game?.dlcOf && !library.installInfo(job.gameKey)) {
      await rm(job.installPath, { recursive: true, force: true }).catch(() => undefined)
    } else if (game && job.kind !== 'install') {
      // Cancelled update/repair: the game keeps working on its current version; drop the leftovers.
      await provider(game.provider).discardPartial?.(job.installPath).catch(() => undefined)
    }
    this.pump()
  }

  clearFinished(): void {
    this.store.data.jobs = this.jobs.filter((j) => !['done', 'cancelled'].includes(j.state))
    this.emitNow()
  }

  private pump(): void {
    if (this.active) return
    const blocked = !settings().downloadsDuringGameplay && library.anyRunning()
    for (const j of this.jobs) j.waitingReason = blocked && j.state === 'queued' ? 'Paused while you play' : undefined
    if (blocked) {
      this.emitSoon()
      return
    }
    const job = this.jobs.find((j) => j.state === 'queued')
    if (!job) return
    void this.run(job)
  }

  private async run(job: DownloadJob): Promise<void> {
    const controller = new AbortController()
    this.active = { job, controller }
    console.info(`[downloads] start ${job.kind} ${job.title} -> ${job.installPath}`)
    const { signal } = controller
    job.state = 'preparing'
    job.error = undefined
    job.waitingReason = undefined
    job.speedBps = 0
    job.diskBps = 0
    this.emitNow()

    let lastDown = job.downloadedBytes
    let lastDisk = job.writtenBytes
    let lastAt = Date.now()
    const sampler = setInterval(() => {
      const now = Date.now()
      const dt = Math.max(1, now - lastAt) / 1000
      const net = Math.max(0, job.downloadedBytes - lastDown) / dt
      const disk = Math.max(0, job.writtenBytes - lastDisk) / dt
      lastDown = job.downloadedBytes
      lastDisk = job.writtenBytes
      lastAt = now
      const busy = job.state === 'downloading' || job.state === 'verifying'
      job.speedBps = busy ? net : 0
      job.diskBps = busy ? disk : 0
      if (busy) {
        job.speedHistory.push(job.speedBps)
        job.diskHistory.push(job.diskBps)
        if (job.speedHistory.length > HISTORY) job.speedHistory.shift()
        if (job.diskHistory.length > HISTORY) job.diskHistory.shift()
      }
      this.emitSoon()
    }, 1000)

    try {
      const game = library.providerGame(job.gameKey)
      if (!game) throw new Error('This game is no longer in your library')
      const p = provider(game.provider)
      const task = p.createInstallTask(game, {
        kind: job.kind,
        installPath: job.installPath,
        existing: library.installInfo(job.gameKey),
        throttle: (bytes) => this.throttle.take(bytes, signal)
      })

      const totals = await task.prepare(signal)
      Object.assign(job, {
        totalDownloadBytes: totals.totalDownloadBytes,
        totalWriteBytes: totals.totalWriteBytes,
        totalVerifyBytes: totals.totalVerifyBytes,
        verifiedBytes: 0
      })
      if (job.kind === 'install') {
        const free = await freeBytes(job.installPath)
        if (free && free < totals.totalWriteBytes - job.writtenBytes) {
          throw new Error('Not enough free disk space for this install')
        }
      }
      job.state = totals.totalVerifyBytes ? 'verifying' : 'downloading'
      console.info(
        `[downloads] planned ${job.title}: download ${totals.totalDownloadBytes} B, write ${totals.totalWriteBytes} B, verify ${totals.totalVerifyBytes} B`
      )
      this.emitNow()

      const info = await task.run(signal, (prog) => {
        if (prog.phase) job.state = prog.phase
        if (prog.downloadedBytes !== undefined) job.downloadedBytes = prog.downloadedBytes
        if (prog.writtenBytes !== undefined) job.writtenBytes = prog.writtenBytes
        if (prog.verifiedBytes !== undefined) job.verifiedBytes = prog.verifiedBytes
        if (prog.currentFile !== undefined) job.currentFile = prog.currentFile
        if (prog.totals) {
          if (prog.totals.totalDownloadBytes !== undefined) job.totalDownloadBytes = prog.totals.totalDownloadBytes
          if (prog.totals.totalWriteBytes !== undefined) job.totalWriteBytes = prog.totals.totalWriteBytes
        }
        this.emitSoon()
      })

      library.setInstalled(job.gameKey, info)
      console.info(`[downloads] done ${job.title} (${info.version})`)
      job.state = 'done'
      job.currentFile = undefined
      job.finishedAt = Date.now()
      notify(`${job.title} is ready to play`, `${kindLabel(job.kind)} complete`)
    } catch (err) {
      if (signal.aborted) console.info(`[downloads] stopped ${job.title} (${job.state})`)
      if (!signal.aborted) {
        job.state = 'error'
        job.error = (err as Error).message
        notify(`${job.title}: ${kindLabel(job.kind).toLowerCase()} failed`, job.error)
        console.error('[downloads]', err)
      }
      // Aborted: pause()/cancel()/preempt() already set the state.
    } finally {
      clearInterval(sampler)
      job.speedBps = 0
      job.diskBps = 0
      this.active = null
      this.emitNow()
      this.pump()
    }
  }

  /** Queue updates for installed games (and DLC) that have one, honouring global and per-game settings. */
  queueUpdates(): void {
    if (!settings().autoUpdate) return
    for (const g of library.listAll()) {
      if (!g.updateAvailable || !g.install) continue
      if (library.prefsFor(g.dlcOf ?? g.key).autoUpdate === false) continue
      // A failed update stays failed until the user retries; don't re-queue it every refresh.
      if (this.jobs.some((j) => j.gameKey === g.key && j.state === 'error')) continue
      if (this.find(g.key) || library.isRunning(g.dlcOf ?? g.key)) continue
      this.enqueue(g.key, 'update', g.install.path)
    }
  }

  /** Where a fresh install of `gameKey` goes. DLC goes into its game's folder. */
  installPathFor(gameKey: string, baseDir?: string): string {
    const game = library.providerGame(gameKey)
    if (!game) throw new Error('Unknown game')
    if (game.dlcOf) {
      const parent = library.installInfo(game.dlcOf)
      if (!parent) throw new Error('Install the base game first')
      return parent.path
    }
    return join(baseDir || settings().installDir, provider(game.provider).folderName(game))
  }

  flush(): void {
    this.store.flush()
  }
}

function kindLabel(kind: DownloadKind): string {
  return kind === 'install' ? 'Install' : kind === 'update' ? 'Update' : 'Repair'
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
}

export const downloads = new Downloads()
