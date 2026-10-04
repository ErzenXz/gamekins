import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { operations } from './operations'
import { pathKey } from '../providers/epic/fsBoundary'
import { existsSync } from 'node:fs'
import type { ArtworkKind, CollectionEdit, DlcInfo, Game, GameImages, GamePrefs, InstalledInfo, LibraryProgress } from '@shared/types'
import { providers, provider } from '../providers'
import type { ProviderGame } from '../providers/types'
import { listProcesses, trackedProcesses, terminateTracked, type Proc } from './processes'
import { JsonStore } from './store'

interface PlayRecord {
  seconds: number
  last?: number
}

interface Running {
  child: ChildProcess | null
  started: number
  checkpoint: number
  lastSeen: number
  dir: string
  executable: string
  local: boolean
  group: string
  grace: number
  processes: Proc[]
  spawnedPid?: number
}
const WATCH_EVERY_MS = 5000
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * The merged view of everything: owned games from every provider, what's on disk,
 * play time, per-game preferences and what's running.
 * Events: `changed` (game list), `progress` (first-load progress), `running` (a game started/stopped).
 */
class Library extends EventEmitter {
  private readonly cache = new JsonStore<{ games: Record<string, ProviderGame> }>('library-cache', { games: {} })
  private readonly installed = new JsonStore<{ games: Record<string, InstalledInfo> }>('installed', { games: {} })
  private readonly playtime = new JsonStore<{ games: Record<string, PlayRecord> }>('playtime', { games: {} })
  private readonly prefs = new JsonStore<{ games: Record<string, GamePrefs> }>('game-prefs', { games: {} })
  /** User-picked artwork URLs, overriding the store images. */
  private readonly artwork = new JsonStore<{ games: Record<string, GameImages> }>('artwork', { games: {} })
  private readonly running = new Map<string, Running>()
  /** Persisted identities reserve games still running after a launcher restart. */
  private readonly sessions = new JsonStore<{ games: Record<string, Omit<Running, 'child'>> }>('active-sessions', { games: {} })
  private revision = 0
  private composedRevision = -1
  private composed: Game[] = []
  private allComposed: Game[] = []
  private scanPromise: Promise<void> | null = null
  private readonly providerGenerations = new Map<string, number>()
  private refreshPromise: Promise<Game[]> | null = null
  private refreshSignature = ''

  constructor() {
    super()
    operations.groupFor = (key) => this.cache.data.games[key]?.dlcOf ?? this.sessions.data.games[key]?.group ?? key
    // Reserve persisted groups before any queue work is permitted.
    for (const [key, r] of Object.entries(this.sessions.data.games)) {
      this.running.set(key, { ...r, child: null, started: Date.now(), checkpoint: Date.now(), lastSeen: Date.now(), grace: 0 })
      operations.setRunning(key, true)
    }
  }

  async reconcileSessions(): Promise<void> {
    try { await this.scan() } finally { this.ensureWatcher() }
  }
  private watcher: NodeJS.Timeout | null = null
  private emitTimer: NodeJS.Timeout | null = null

  providerGame(key: string): ProviderGame | undefined {
    return this.cache.data.games[key]
  }

  installInfo(key: string): InstalledInfo | undefined {
    return this.installed.data.games[key]
  }

  /** Base games (what the UI lists). DLC appears inside its game's `dlc` array. */
  list(): Game[] {
    if (this.composedRevision === this.revision) return this.composed
    const dlcByParent = new Map<string, ProviderGame[]>()
    const out: ProviderGame[] = []
    for (const g of Object.values(this.cache.data.games)) {
      if (g.dlcOf) {
        const arr = dlcByParent.get(g.dlcOf) ?? []
        arr.push(g)
        dlcByParent.set(g.dlcOf, arr)
      } else out.push(g)
    }
    this.composed = out
      .map((g) => this.compose(g, dlcByParent.get(g.key) ?? []))
      .sort((a, b) => collator.compare(a.title, b.title))
    this.allComposed = Object.values(this.cache.data.games).map((g) => this.compose(g, []))
    this.composedRevision = this.revision
    return this.composed
  }

  /** Every record including DLC, for update checks. */
  listAll(): Game[] {
    this.list()
    return this.allComposed
  }

  get(key: string): Game | undefined {
    const g = this.cache.data.games[key]
    if (!g) return undefined
    const dlc = Object.values(this.cache.data.games).filter((d) => d.dlcOf === key)
    return this.compose(g, dlc)
  }

  private updateAvailable(g: ProviderGame, install?: InstalledInfo): boolean {
    return (
      !!install &&
      !!g.latestVersion &&
      install.platform === provider(g.provider).platform &&
      install.version !== g.latestVersion
    )
  }

  private compose(g: ProviderGame, dlc: ProviderGame[]): Game {
    const install = this.installed.data.games[g.key]
    const play = this.playtime.data.games[g.key]
    const art = this.artwork.data.games[g.key]
    return {
      ...g,
      images: art ? { ...g.images, ...art } : g.images,
      install,
      updateAvailable: this.updateAvailable(g, install),
      playtimeSeconds: play?.seconds ?? 0,
      lastPlayed: play?.last,
      running: this.running.has(g.key),
      prefs: this.prefs.data.games[g.key] ?? {},
      dlc: dlc
        .map((d): DlcInfo => {
          const di = this.installed.data.games[d.key]
          return {
            key: d.key,
            appName: d.appName,
            title: d.title,
            image: d.images.wide ?? d.images.thumb ?? d.images.tall,
            installable: !!d.latestVersion,
            install: di,
            updateAvailable: this.updateAvailable(d, di)
          }
        })
        .sort((a, b) => Number(b.installable) - Number(a.installable) || a.title.localeCompare(b.title))
    }
  }

  /** Coalesce bursts of changes into one UI update. */
  private changed(): void {
    this.revision++
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('changed', this.list())
    }, 30)
  }

  private progress(p: LibraryProgress): void {
    this.emit('progress', p)
  }

  /** Pull owned games from every signed-in provider and reconcile installs on disk. */
  refresh(): Promise<Game[]> {
    const signature = JSON.stringify(providers.map((p) => [p.id, p.accountGeneration?.(), this.providerGenerations.get(p.id)]))
    if (this.refreshPromise && signature === this.refreshSignature) return this.refreshPromise
    this.refreshSignature = signature
    const work = this.refreshImpl().finally(() => { if (this.refreshPromise === work) this.refreshPromise = null })
    this.refreshPromise = work
    return work
  }

  private async refreshImpl(): Promise<Game[]> {
    const t0 = Date.now()
    const errors: Error[] = []
    this.progress({ loading: true, done: 0, total: 0 })
    try {
      for (const p of providers) {
        if (!p.account() && !p.alwaysOn) continue
        const generation = this.providerGenerations.get(p.id) ?? 0
        const accountGeneration = p.accountGeneration?.()
        const current = (): boolean => (this.providerGenerations.get(p.id) ?? 0) === generation && p.accountGeneration?.() === accountGeneration
        try {
          p.seedLibrary?.(Object.values(this.cache.data.games).filter((g) => g.provider === p.id))
          const games = await p.fetchLibrary((done, total) => this.progress({ loading: true, done, total }))
          if (!current()) continue
          const nextCache = Object.fromEntries(
            Object.entries(this.cache.data.games).filter(([, g]) => g.provider !== p.id)
          )
          for (const g of games) nextCache[g.key] = g
          this.cache.set({ games: nextCache })
          if (p.partialRefreshError) errors.push(new Error(p.partialRefreshError))
        } catch (err) {
          errors.push(err as Error)
        }
        try {
          if (!current()) continue
          const external = await p.scanExternalInstalls()
          if (!current()) continue
          this.installed.update((d) => {
            for (const [appName, info] of external) {
              const key = `${p.id}:${appName}`
              if (operations.blocked(key)) continue
              const mine = d.games[key]
              // Adopt launcher installs we don't know about and keep adopted ones in sync. Once Lodestar has
              // installed/updated a game itself (source "lodestar") our record wins over the launcher's.
              if (!mine || mine.source === 'epic-launcher' || mine.source === 'local') {
                d.games[key] = { ...info, prereqsInstalled: mine?.prereqsInstalled }
              }
            }
          })
        } catch (err) {
          console.warn('[library] external install scan failed', err)
        }
      }
      // Keep unavailable drive records so reconnecting restores the installation.
      this.installed.update((d) => {
        for (const [key, info] of Object.entries(d.games)) {
          if (!operations.blocked(key)) info.unavailable = !existsSync(info.path)
        }
      })
    } finally {
      this.progress({ loading: false, done: 0, total: 0, error: errors[0]?.message })
    }
    this.changed()
    console.info(`[library] refreshed in ${Date.now() - t0} ms${errors.length ? ` (${errors.length} error)` : ''}`)
    if (errors.length) throw errors[0]
    return this.list()
  }

  /** Drop a provider's games after sign-out (installs stay on disk and come back on sign-in). */
  forgetProvider(id: string): void {
    this.providerGenerations.set(id, (this.providerGenerations.get(id) ?? 0) + 1)
    this.cache.set({
      games: Object.fromEntries(Object.entries(this.cache.data.games).filter(([, g]) => g.provider !== id))
    })
    this.changed()
  }

  setInstalled(key: string, info: InstalledInfo | null): void {
    this.installed.update((d) => {
      if (info) d.games[key] = info
      else {
        delete d.games[key]
        // Removing a game removes its DLC with it.
        for (const g of Object.values(this.cache.data.games)) if (g.dlcOf === key) delete d.games[g.key]
      }
    })
    this.changed()
  }

  /** After a folder move: repoint every install (game + its DLC) that lived in `from`. */
  relocate(from: string, to: string): void {
    this.installed.update((d) => {
      for (const info of Object.values(d.games)) if (pathKey(info.path) === pathKey(from)) { info.path = to; info.unavailable = false }
    })
    if (!this.installed.flush()) throw new Error('Could not persist the new install location; source preserved')
    this.changed()
  }

  async migrateArtwork(): Promise<void> {
    const { cacheArtwork } = await import('./artwork')
    for (const images of Object.values(this.artwork.data.games)) {
      for (const kind of ['tall', 'wide', 'logo', 'thumb'] as const) {
        const value = images[kind]
        if (!value?.startsWith('data:image/')) continue
        try {
          const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value)
          if (match) images[kind] = await cacheArtwork(Buffer.from(match[2], 'base64'))
        } catch (err) { console.warn('[artwork] cached image migration failed; preserving original', err) }
      }
    }
    this.artwork.save()
    this.changed()
  }

  setArtwork(key: string, kind: ArtworkKind, dataUrl: string | null): void {
    this.artwork.update((d) => {
      const cur = { ...(d.games[key] ?? {}) }
      if (dataUrl) cur[kind] = dataUrl
      else delete cur[kind]
      if (Object.keys(cur).length) d.games[key] = cur
      else delete d.games[key]
    })
    this.changed()
  }

  /** Drop a game from the library entirely (non-Epic games being removed). */
  removeGame(key: string): void {
    this.cache.update((d) => delete d.games[key])
    this.installed.update((d) => delete d.games[key])
    this.prefs.update((d) => delete d.games[key])
    this.artwork.update((d) => delete d.games[key])
    this.changed()
  }

  /** Pull just the always-on providers (cheap; used after adding a non-Epic game). */
  async refreshLocal(): Promise<void> {
    for (const p of providers) {
      if (!p.alwaysOn) continue
      const games = await p.fetchLibrary()
      const installs = await p.scanExternalInstalls()
      this.cache.update((d) => {
        for (const k of Object.keys(d.games)) if (d.games[k].provider === p.id) delete d.games[k]
        for (const g of games) d.games[g.key] = g
      })
      this.installed.update((d) => {
        for (const [app, info] of installs) d.games[`${p.id}:${app}`] = info
      })
    }
    this.changed()
  }

  setPrefs(key: string, patch: Partial<GamePrefs>): void {
    this.prefs.update((d) => {
      const next = { ...(d.games[key] ?? {}), ...patch }
      for (const k of Object.keys(next) as (keyof GamePrefs)[]) if (next[k] === undefined) delete next[k]
      d.games[key] = next
    })
    this.changed()
  }

  prefsFor(key: string): GamePrefs {
    return this.prefs.data.games[key] ?? {}
  }

  isRunning(key: string): boolean {
    return this.running.has(key)
  }

  anyRunning(): boolean {
    return this.running.size > 0
  }

  async launch(key: string): Promise<void> {
    if (this.running.has(key)) return
    const release = operations.acquire(key, 'launch')
    try {
      const game = this.cache.data.games[key]
      const install = this.installed.data.games[key]
      if (!game || !install) throw new Error('Game is not installed')
      if (install.unavailable || !existsSync(install.path) || !existsSync(join(install.path, install.executable))) {
        throw new Error('Drive not connected or executable missing')
      }
      const prefs = this.prefsFor(key)
      const child = await provider(game.provider).launch(game, install, { extraArgs: prefs.launchArgs, viaOfficialLauncher: prefs.launchViaOfficial })
      const now = Date.now()
      const entry: Running = {
        child, started: now, checkpoint: now, lastSeen: now, dir: install.path,
        executable: join(install.path, install.executable), local: game.provider === 'local',
        group: operations.groupFor(key), grace: child ? 20_000 : 90_000, processes: [], spawnedPid: child?.pid
      }
      this.running.set(key, entry)
      operations.setRunning(key, true)
      this.playtime.update((d) => { d.games[key] = { seconds: d.games[key]?.seconds ?? 0, last: now } })
      if (child) {
        child.once('error', (err) => { console.error('[launch]', err) })
        child.unref()
      }
      // Capture the spawned identity while the process is new. Scan failure retains the reservation.
      try {
        const procs = await listProcesses()
        if (child?.pid) entry.processes = procs.filter((p) => p.pid === child.pid)
        entry.processes = trackedProcesses(procs, entry.processes, entry.dir, entry.executable, entry.local)
      } catch (err) { console.warn('[launch] identity scan failed', err) }
      this.persistSessions()
      this.changed()
      this.emit('running', key, true)
      this.ensureWatcher()
    } finally { release() }
  }

  private ensureWatcher(): void {
    if (this.watcher || !this.running.size) return
    this.watcher = setTimeout(async () => {
      this.watcher = null
      try { await this.scan() }
      catch (err) { console.warn('[processes] scan failed; retaining running protection', err) }
      for (const [key, r] of this.running) if (Date.now() - r.checkpoint >= 60_000) this.checkpoint(key, Date.now())
      this.persistSessions()
      this.ensureWatcher()
    }, WATCH_EVERY_MS)
  }

  private scan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise
    const entries = [...this.running]
    this.scanPromise = (async () => {
      if (!entries.length) return
      const procs = await listProcesses()
      const now = Date.now()
      for (const [key, r] of entries) {
        if (this.running.get(key) !== r) continue
        r.processes = trackedProcesses(procs, r.processes, r.dir, r.executable, r.local)
        if (r.processes.length) r.lastSeen = now
        else if (now - r.started >= r.grace && now - r.lastSeen >= WATCH_EVERY_MS * 2) this.finish(key)
        if (this.running.get(key) === r && now - r.checkpoint >= 60_000) this.checkpoint(key, now)
      }
      this.persistSessions()
    })().finally(() => { this.scanPromise = null })
    return this.scanPromise
  }

  private persistSessions(): void {
    const games = Object.fromEntries([...this.running].map(([key, { child: _child, ...r }]) => [key, r]))
    this.sessions.set({ games })
  }

  private checkpoint(key: string, end: number): void {
    const r = this.running.get(key)
    if (!r) return
    this.playtime.update((d) => {
      const rec = d.games[key] ?? { seconds: 0 }
      rec.seconds += Math.max(0, (end - r.checkpoint) / 1000)
      rec.last = end
      d.games[key] = rec
    })
    r.checkpoint = Math.max(r.checkpoint, end)
    this.changed()
  }

  private finish(key: string): void {
    const r = this.running.get(key)
    if (!r) return
    this.checkpoint(key, Math.max(r.lastSeen, r.started))
    this.running.delete(key)
    operations.setRunning(key, false)
    this.persistSessions()
    this.changed()
    this.emit('running', key, false)
  }

  async stop(key: string): Promise<void> {
    const release = operations.acquire(key, 'stop', true)
    try {
      const r = this.running.get(key)
      if (!r) return
      // Await a pending watcher before taking the stop snapshot.
      await this.scanPromise
      const procs = await listProcesses()
      r.processes = trackedProcesses(procs, r.processes, r.dir, r.executable, r.local)
      if (!r.processes.length && Date.now() - r.started < r.grace) throw new Error('Game launch is still handing off; try Stop again shortly')
      await terminateTracked(r.processes)
      r.lastSeen = Date.now()
      this.finish(key)
    } finally { release() }
  }

  editCollections(edit: CollectionEdit): Game[] {
    // Validate all targets before the single mutation, against current main state.
    for (const key of edit.gameKeys) if (!this.providerGame(key)) throw new Error('Unknown game: ' + key)
    const same = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
    const keys = edit.operation === 'rename' || edit.operation === 'delete' ? Object.keys(this.cache.data.games) : edit.gameKeys
    const changed: string[] = []
    this.prefs.update((d) => {
      for (const key of new Set(keys)) {
        const before = d.games[key]?.collections ?? []
        const has = before.some((n) => same(n, edit.name))
        let next = before
        if (edit.operation === 'add' && !has) next = [...before, edit.name]
        if (edit.operation === 'remove' || edit.operation === 'delete') next = before.filter((n) => !same(n, edit.name))
        if (edit.operation === 'rename' && has) next = [...before.filter((n) => !same(n, edit.name) && !same(n, edit.replacement!)), edit.replacement!]
        if (JSON.stringify(next) !== JSON.stringify(before)) {
          d.games[key] = { ...d.games[key], collections: next }; changed.push(key)
        }
      }
    })
    this.changed()
    return changed.map((key) => this.get(key)!)
  }

  /** Recently played installed games, for the tray menu. */
  recent(limit = 5): Game[] {
    return this.list()
      .filter((g) => g.install && !g.install.unavailable && g.lastPlayed)
      .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
      .slice(0, limit)
  }

  flush(): void {
    for (const key of this.running.keys()) this.checkpoint(key, Date.now())
    this.persistSessions()
    this.sessions.flush()
    this.cache.flush()
    this.installed.flush()
    this.playtime.flush()
    this.prefs.flush()
    this.artwork.flush()
  }
}

export const library = new Library()
