import { Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DownloadJob, DownloadKind, ProviderId } from '@shared/types'
import { provider } from '../providers'
import { discardPartial } from '../providers/epic/installer'
import { FsBoundary, pathKey } from '../providers/epic/fsBoundary'
import { library } from './library'
import { settings } from './settings'
import { JsonStore } from './store'
import { operations } from './operations'

const HISTORY = 60
const ACTIVE: DownloadJob['state'][] = ['preparing', 'verifying', 'downloading', 'finalizing']
const LIVE: DownloadJob['state'][] = [...ACTIVE, 'queued', 'paused']

interface QueueJob extends DownloadJob {
  providerId?: ProviderId
  appName?: string
  parentKey?: string
  createdFolder?: boolean
}

interface ActiveRun {
  job: QueueJob
  controller: AbortController
  generation: number
  stopReason?: 'paused' | 'queued' | 'cancelled'
  release: () => void
  promise: Promise<void>
}

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
    let remaining = bytes
    while (remaining > 0) {
      signal.throwIfAborted()
      const limit = settings().bandwidthLimitMBps * 1024 * 1024
      if (!Number.isFinite(limit) || limit <= 0) return
      const now = Date.now()
      // Allow up to one second of burst.
      this.allowance = Math.min(limit, this.allowance + ((now - this.last) / 1000) * limit)
      this.last = now
      const used = Math.min(remaining, Math.max(0, this.allowance))
      remaining -= used
      this.allowance -= used
      if (remaining === 0) return
      await new Promise<void>((resolve, reject) => {
        const stop = (): void => {
          clearTimeout(timer)
          reject(signal.reason)
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', stop)
          resolve()
        }, Math.max(1, Math.min(1000, (remaining / limit) * 1000)))
        signal.addEventListener('abort', stop, { once: true })
      })
    }
  }
}

/**
 * Steam-style download queue: one active job at a time, the rest wait in line.
 * Unfinished jobs survive restarts and resume from the per-install resume log.
 */
class Downloads extends EventEmitter {
  private readonly store = new JsonStore<{ jobs: QueueJob[] }>('downloads', { jobs: [] })
  private active: ActiveRun | null = null
  private started = false
  private generation = 0
  private readonly cancellationLeases = new Map<string, () => void>()
  private readonly stoppingPaths = new Set<string>()
  private lastCheckpoint = 0
  private readonly throttle = new Throttle()
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    operations.onAvailable(() => this.pump())
    for (const job of this.store.data.jobs) {
      // Anything that was mid-flight when we quit goes back in the queue.
      if (ACTIVE.includes(job.state)) job.state = 'queued'
      job.speedBps = 0
      job.diskBps = 0
      job.diskHistory ??= []
      job.speedHistory ??= []
      job.speedHistory = job.speedHistory.slice(-HISTORY)
      job.diskHistory = job.diskHistory.slice(-HISTORY)
      if (['done', 'cancelled', 'error'].includes(job.state)) {
        job.speedHistory = []
        job.diskHistory = []
      }
    }
  }

  get jobs(): QueueJob[] {
    return this.store.data.jobs
  }

  start(): void {
    if (this.started) return
    this.started = true
    library.on('changed', () => this.pump())
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

  private emitNow(checkpoint = true): void {
    this.lastEmit = Date.now()
    if (checkpoint || this.lastEmit - this.lastCheckpoint >= 5000) {
      this.lastCheckpoint = this.lastEmit
      try {
        this.store.flush()
      } catch (err) {
        // A failed checkpoint must not leave an active run without its cleanup barrier.
        console.error('[downloads] queue checkpoint failed', err)
      }
    }
    this.emit('changed', this.jobs)
  }

  /** Progress fires constantly; the UI only needs ~4 updates a second. */
  private emitSoon(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, 250 - (Date.now() - this.lastEmit))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emitNow(false)
    }, wait)
  }

  find(gameKey: string): DownloadJob | undefined {
    return this.jobs.find((j) => j.gameKey === gameKey && LIVE.includes(j.state))
  }

  enqueue(gameKey: string, kind: DownloadKind, installPath: string): DownloadJob {
    const release = operations.acquire(gameKey, kind)
    try {
      const existing = this.find(gameKey)
      if (existing) return existing
      const game = library.get(gameKey)
      if (!game) throw new Error('Unknown game')
      const install = library.installInfo(game.dlcOf ?? gameKey)
      if (install && (install.unavailable || !existsSync(install.path))) throw new Error('Drive not connected')
      // Replace any finished/failed entry for the same game so the list stays tidy.
      this.store.data.jobs = this.jobs.filter((j) => j.gameKey !== gameKey)
      const parent = game.dlcOf ? library.get(game.dlcOf) : undefined
      const job: QueueJob = {
        providerId: game.provider,
        appName: game.appName,
        parentKey: game.dlcOf,
        createdFolder: false,
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
    } finally { release() }
  }

  /** Stop the active job but leave it first in line. */
  private preempt(job: DownloadJob): void {
    if (this.active?.job !== job) return
    this.active.stopReason = 'queued'
    this.active.controller.abort()
    job.state = 'queued'
    job.speedBps = 0
    job.diskBps = 0
    this.emitNow()
  }

  async pause(id: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || ['done', 'cancelled'].includes(job.state)) return
    const active = this.active?.job === job ? this.active : null
    if (active) {
      active.stopReason = 'paused'
      active.controller.abort()
    }
    job.state = 'paused'
    job.speedBps = 0
    job.diskBps = 0
    this.emitNow()
    await active?.promise
  }

  resume(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || !['paused', 'error', 'queued'].includes(job.state)) return
    // A resume during pause drainage keeps the existing reservation until its barrier completes.
    const release = this.active?.job === job && this.active.controller.signal.aborted
      ? () => undefined : operations.acquire(job.parentKey ?? job.gameKey, 'resume download')
    try {
      const retry = job.state === 'error'
      job.state = 'queued'
      if (this.active?.job === job && this.active.controller.signal.aborted) this.active.stopReason = 'queued'
      job.error = undefined
      if (!retry) {
        // "Start now" / resume bumps it to the front, like Steam. A retry just rejoins the queue.
        this.store.data.jobs = [job, ...this.jobs.filter((j) => j !== job)]
        if (this.active && this.active.job.id !== id) this.preempt(this.active.job)
      }
      this.emitNow()
      this.pump()
    } finally { release() }
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
    if (!job || job.state === 'done' || this.stoppingPaths.has(pathKey(job.installPath))) return
    const path = pathKey(job.installPath)
    const active = this.active?.job === job ? this.active : null
    const release = active?.release ?? operations.acquire(job.parentKey ?? job.gameKey, 'cancel download')
    this.cancellationLeases.set(job.id, release)
    this.stoppingPaths.add(path)
    if (active) {
      active.stopReason = 'cancelled'
      active.controller.abort()
    }
    job.state = 'cancelled'
    this.emitNow()
    try {
      await active?.promise
      const game = library.providerGame(job.gameKey)
      if (game && !game.dlcOf && !job.parentKey && job.kind === 'install' && job.createdFolder &&
          !library.installInfo(job.gameKey) && game.provider === job.providerId && game.appName === job.appName) {
        const boundary = await FsBoundary.create(job.installPath)
        const owner = join(job.installPath, '.lodestar', 'owner')
        await boundary.check(owner)
        const markerMatches = (await readFile(owner, 'utf8')) === job.id
        const current = library.providerGame(job.gameKey)
        if (markerMatches && current && !current.dlcOf && current.provider === job.providerId &&
            current.appName === job.appName && !library.installInfo(job.gameKey)) {
          await rm(job.installPath, { recursive: true, force: true })
        }
      } else if (job.providerId === 'epic' && job.appName) {
        await discardPartial(job.installPath, job.appName, job.id)
      }
    } catch (err) {
      console.warn('[downloads] partial cleanup failed', err)
    } finally {
      this.store.data.jobs = this.jobs.filter((j) => j !== job)
      this.stoppingPaths.delete(path)
      this.cancellationLeases.delete(job.id)
      release()
      this.emitNow()
      this.pump()
    }
  }

  clearFinished(): void {
    this.store.data.jobs = this.jobs.filter((j) => !['done', 'cancelled'].includes(j.state))
    this.emitNow()
  }

  private pump(): void {
    if (!this.started || this.active) return
    const blocked = !settings().downloadsDuringGameplay && library.anyRunning()
    const unavailable = (j: QueueJob): boolean => {
      const info = library.installInfo(j.parentKey ?? j.gameKey)
      return !!info && (info.unavailable === true || !existsSync(info.path))
    }
    let waitingChanged = false
    for (const j of this.jobs) {
      const reason = j.state !== 'queued' ? undefined : unavailable(j) ? 'Drive not connected' : blocked ? 'Paused while you play' : operations.blocked(j.parentKey ?? j.gameKey) ? 'Waiting for this game to close or finish its operation' : undefined
      if (reason !== j.waitingReason) waitingChanged = true
      j.waitingReason = reason
    }
    if (waitingChanged) this.emitSoon()
    if (blocked) {
      this.emitSoon()
      return
    }
    const job = this.jobs.find((j) => j.state === 'queued' && !this.stoppingPaths.has(pathKey(j.installPath)) && !operations.blocked(j.parentKey ?? j.gameKey) && !unavailable(j))
    if (!job) return
    const active: ActiveRun = {
      job, controller: new AbortController(), generation: ++this.generation, promise: Promise.resolve(),
      release: operations.acquire(job.parentKey ?? job.gameKey, job.kind)
    }
    this.active = active
    active.promise = Promise.resolve().then(() => this.run(active))
  }

  private async run(active: ActiveRun): Promise<void> {
    const { job, controller } = active
    if (controller.signal.aborted) {
      if (this.active === active) this.active = null
      if (!this.cancellationLeases.has(job.id)) active.release()
      this.pump()
      return
    }
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
      if (signal.aborted || this.active?.generation !== active.generation) return
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
      if ((job.providerId && game.provider !== job.providerId) || (job.appName && game.appName !== job.appName)) {
        throw new Error('Queued game identity changed')
      }
      job.providerId ??= game.provider
      job.appName ??= game.appName
      job.parentKey ??= game.dlcOf
      if (job.kind === 'install' && !job.parentKey && !game.dlcOf && !library.installInfo(job.gameKey)) {
        await this.claimFolder(job, signal)
      }
      signal.throwIfAborted()
      const p = provider(game.provider)
      const task = p.createInstallTask(game, {
        jobId: job.id,
        createdFolder: job.createdFolder,
        kind: job.kind,
        installPath: job.installPath,
        existing: library.installInfo(job.gameKey),
        onCommitted: (info) => library.setInstalled(job.gameKey, info),
        throttleWithSignal: (bytes, workerSignal) => this.throttle.take(bytes, AbortSignal.any([signal, workerSignal])),
        throttle: (bytes) => this.throttle.take(bytes, signal)
      })

      const totals = await task.prepare(signal)
      signal.throwIfAborted()
      Object.assign(job, {
        totalDownloadBytes: totals.totalDownloadBytes,
        totalWriteBytes: totals.totalWriteBytes,
        totalVerifyBytes: totals.totalVerifyBytes,
        verifiedBytes: 0
      })
      if (totals.requiredDiskBytes !== undefined || job.kind === 'install') {
        const free = await freeBytes(job.installPath)
        if (free && free < (totals.requiredDiskBytes ?? Math.max(0, totals.totalWriteBytes - job.writtenBytes))) {
          throw new Error('Not enough free disk space for this operation')
        }
      }
      signal.throwIfAborted()
      job.state = totals.totalVerifyBytes ? 'verifying' : 'downloading'
      console.info(
        `[downloads] planned ${job.title}: download ${totals.totalDownloadBytes} B, write ${totals.totalWriteBytes} B, verify ${totals.totalVerifyBytes} B`
      )
      this.emitNow()

      const info = await task.run(signal, (prog) => {
        if (signal.aborted || this.active?.generation !== active.generation) return
        const transition = prog.phase !== undefined && prog.phase !== job.state
        if (prog.phase) job.state = prog.phase
        if (prog.downloadedBytes !== undefined) job.downloadedBytes = prog.downloadedBytes
        if (prog.writtenBytes !== undefined) job.writtenBytes = prog.writtenBytes
        if (prog.verifiedBytes !== undefined) job.verifiedBytes = prog.verifiedBytes
        if (prog.currentFile !== undefined) job.currentFile = prog.currentFile
        if (prog.totals) {
          if (prog.totals.totalDownloadBytes !== undefined) job.totalDownloadBytes = prog.totals.totalDownloadBytes
          if (prog.totals.totalWriteBytes !== undefined) job.totalWriteBytes = prog.totals.totalWriteBytes
        }
        if (transition) this.emitNow()
        else this.emitSoon()
      })

      signal.throwIfAborted()
      library.setInstalled(job.gameKey, info)
      console.info(`[downloads] done ${job.title} (${info.version})`)
      job.state = 'done'
      job.currentFile = undefined
      job.finishedAt = Date.now()
      if (info.prereqsInstalled === false) {
        job.error = 'Prerequisite installation failed or timed out. Run Verify & repair to retry.'
        notify(`${job.title}: prerequisites required`, job.error)
      } else notify(`${job.title} is ready to play`, `${kindLabel(job.kind)} complete`)
    } catch (err) {
      if (signal.aborted) console.info(`[downloads] stopped ${job.title} (${job.state})`)
      if (!signal.aborted) {
        job.state = 'error'
        job.error = (err as Error).message
        notify(`${job.title}: ${kindLabel(job.kind).toLowerCase()} failed`, job.error)
        console.error('[downloads]', err)
      }
      if (signal.aborted) job.state = active.stopReason ?? 'paused'
    } finally {
      clearInterval(sampler)
      job.speedBps = 0
      job.diskBps = 0
      if (['done', 'cancelled', 'error'].includes(job.state)) {
        job.speedHistory = []
        job.diskHistory = []
      }
      if (this.active === active) this.active = null
      if (!this.cancellationLeases.has(job.id)) active.release()
      this.emitNow()
      this.pump()
    }
  }

  private async claimFolder(job: QueueJob, signal: AbortSignal): Promise<void> {
    await mkdir(dirname(job.installPath), { recursive: true })
    signal.throwIfAborted()
    try {
      await mkdir(job.installPath)
      job.createdFolder = true
      this.emitNow()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (!(await lstat(job.installPath)).isDirectory()) throw new Error('Install folder is not a directory')
    }
    const boundary = await FsBoundary.create(job.installPath)
    const owner = join(job.installPath, '.lodestar', 'owner')
    await boundary.check(owner)
    const previous = await readFile(owner, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
      return null
    })
    if (previous !== null && previous !== job.id) throw new Error('Install folder belongs to another job')
    if (previous === null) {
      if ((await readdir(job.installPath)).length) {
        throw new Error('Install folder is not empty; use the import flow for existing games')
      }
      await mkdir(dirname(owner))
      await boundary.check(owner)
      await writeFile(owner, job.id, { flag: 'wx' })
    }
    signal.throwIfAborted()
  }

  /** Queue updates for installed games (and DLC) that have one, honouring global and per-game settings. */
  queueUpdates(): void {
    if (!settings().autoUpdate) return
    for (const g of library.listAll()) {
      if (g.thirdPartyManagedApp || !g.updateAvailable || !g.install || g.install.unavailable) continue
      if (library.prefsFor(g.dlcOf ?? g.key).autoUpdate === false) continue
      // A failed update stays failed until the user retries; don't re-queue it every refresh.
      if (this.jobs.some((j) => j.gameKey === g.key && j.state === 'error')) continue
      if (this.find(g.key) || operations.blocked(g.dlcOf ?? g.key)) continue
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
      if (parent.unavailable || !existsSync(parent.path)) throw new Error('Drive not connected')
      return parent.path
    }
    return join(baseDir || settings().installDir, provider(game.provider).folderName(game))
  }

  flush(): void {
    this.lastCheckpoint = Date.now()
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
