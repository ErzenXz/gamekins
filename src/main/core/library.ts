import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ArtworkKind, DlcInfo, Game, GameImages, GamePrefs, InstalledInfo, LibraryProgress } from '@shared/types'
import { providers, provider } from '../providers'
import type { ProviderGame } from '../providers/types'
import { killAll, listProcesses, under } from './processes'
import { JsonStore } from './store'

interface PlayRecord {
  seconds: number
  last?: number
}

interface Running {
  child: ChildProcess | null
  childAlive: boolean
  started: number
  lastSeen: number
  dir: string
  /** How long a game may show no processes before we call it closed (launchers are slow to hand off). */
  grace: number
}

const WATCH_EVERY_MS = 4000

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
  /** User-picked artwork (data: URLs), overriding the store's images. */
  private readonly artwork = new JsonStore<{ games: Record<string, GameImages> }>('artwork', { games: {} })
  private readonly running = new Map<string, Running>()
  /** Launches in progress (auth/token calls can take a moment); blocks double-clicks. */
  private readonly launching = new Set<string>()
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
    const dlcByParent = new Map<string, ProviderGame[]>()
    const out: ProviderGame[] = []
    for (const g of Object.values(this.cache.data.games)) {
      if (g.dlcOf) {
        const arr = dlcByParent.get(g.dlcOf) ?? []
        arr.push(g)
        dlcByParent.set(g.dlcOf, arr)
      } else out.push(g)
    }
    return out
      .map((g) => this.compose(g, dlcByParent.get(g.key) ?? []))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }))
  }

  /** Every record including DLC, for update checks. */
  listAll(): Game[] {
    return Object.values(this.cache.data.games).map((g) => this.compose(g, []))
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
  async refresh(): Promise<Game[]> {
    const errors: Error[] = []
    this.progress({ loading: true, done: 0, total: 0 })
    try {
      for (const p of providers) {
        if (!p.account() && !p.alwaysOn) continue
        try {
          const games = await p.fetchLibrary((done, total) => this.progress({ loading: true, done, total }))
          const nextCache = Object.fromEntries(
            Object.entries(this.cache.data.games).filter(([, g]) => g.provider !== p.id)
          )
          for (const g of games) nextCache[g.key] = g
          this.cache.set({ games: nextCache })
        } catch (err) {
          errors.push(err as Error)
        }
        try {
          const external = await p.scanExternalInstalls()
          this.installed.update((d) => {
            for (const [appName, info] of external) {
              const key = `${p.id}:${appName}`
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
      // Forget installs whose folder vanished (deleted by hand, drive unplugged...).
      this.installed.update((d) => {
        for (const [key, info] of Object.entries(d.games)) if (!existsSync(info.path)) delete d.games[key]
      })
    } finally {
      this.progress({ loading: false, done: 0, total: 0, error: errors[0]?.message })
    }
    this.changed()
    if (errors.length) throw errors[0]
    return this.list()
  }

  /** Drop a provider's games after sign-out (installs stay on disk and come back on sign-in). */
  forgetProvider(id: string): void {
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
      for (const info of Object.values(d.games)) if (info.path === from) info.path = to
    })
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
    const game = this.cache.data.games[key]
    const install = this.installed.data.games[key]
    if (!game || !install) throw new Error('Game is not installed')
    if (this.running.has(key) || this.launching.has(key)) return
    this.launching.add(key)
    const prefs = this.prefsFor(key)
    let child: ChildProcess | null
    try {
      child = await provider(game.provider).launch(game, install, {
        extraArgs: prefs.launchArgs,
        viaOfficialLauncher: prefs.launchViaOfficial
      })
    } finally {
      this.launching.delete(key)
    }
    const now = Date.now()
    const entry: Running = {
      child,
      childAlive: !!child,
      started: now,
      lastSeen: now,
      dir: install.path,
      grace: child ? 20_000 : 90_000
    }
    this.running.set(key, entry)
    this.playtime.update((d) => {
      d.games[key] = { seconds: d.games[key]?.seconds ?? 0, last: now }
    })
    if (child) {
      child.once('exit', () => {
        entry.childAlive = false
        entry.lastSeen = Date.now()
      })
      child.once('error', (err) => {
        console.error('[launch]', err)
        entry.childAlive = false
        this.finish(key)
      })
      child.unref()
    }
    this.changed()
    this.emit('running', key, true)
    this.ensureWatcher()
  }

  /**
   * Games often start through a bootstrapper that exits right away, so "running"
   * means "any process from the game's folder is alive", checked every few seconds.
   */
  private ensureWatcher(): void {
    if (this.watcher) return
    this.watcher = setInterval(async () => {
      if (!this.running.size) {
        clearInterval(this.watcher!)
        this.watcher = null
        return
      }
      const procs = await listProcesses().catch(() => [])
      const now = Date.now()
      for (const [key, r] of [...this.running]) {
        const alive = r.childAlive || under(procs, r.dir).length > 0
        if (alive) r.lastSeen = now
        else if (now - r.started > r.grace && now - r.lastSeen > WATCH_EVERY_MS * 2) this.finish(key)
      }
    }, WATCH_EVERY_MS)
  }

  private finish(key: string): void {
    const r = this.running.get(key)
    if (!r) return
    this.running.delete(key)
    // Count until the last moment we saw it alive.
    const end = Math.max(r.lastSeen, r.started)
    this.playtime.update((d) => {
      const rec = d.games[key] ?? { seconds: 0 }
      rec.seconds += Math.round((end - r.started) / 1000)
      rec.last = end
      d.games[key] = rec
    })
    this.changed()
    this.emit('running', key, false)
  }

  async stop(key: string): Promise<void> {
    const r = this.running.get(key)
    if (!r) return
    r.child?.kill()
    killAll(under(await listProcesses(), r.dir))
    r.childAlive = false
    r.lastSeen = Date.now()
    this.finish(key)
  }

  /** Recently played installed games, for the tray menu. */
  recent(limit = 5): Game[] {
    return this.list()
      .filter((g) => g.install && g.lastPlayed)
      .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
      .slice(0, limit)
  }

  flush(): void {
    this.cache.flush()
    this.installed.flush()
    this.playtime.flush()
    this.prefs.flush()
    this.artwork.flush()
  }
}

export const library = new Library()
