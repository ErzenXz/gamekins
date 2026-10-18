// Steam: installed games straight from the Steam client's library folders (no sign-in needed),
// owned games and play time from the Web API once signed in on Steam's own login page.
// The Steam client installs, updates, uninstalls and starts its games; Gamekins hands those
// actions over with steam:// links and tracks the game's processes while it runs.

import { BrowserWindow, safeStorage, session as electronSession, shell } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Account, InstalledInfo, Platform } from '@shared/types'
import { splitArgs } from '../../core/args'
import { dataDir } from '../../core/store'
import type { GameProvider, InstallTask, LaunchOptions, ProviderGame } from '../types'
import { communityName, getOwnedGames, getPersonas, getStoreArt, isAuthError, jwtExpiry, type OwnedGame, parseSteamLoginSecure, type StoreArt } from './api'
import {
  findSteamExe,
  findSteamRoot,
  manifestToGame,
  manifestToInstall,
  readClientUser,
  scanSteamLibraries,
  type SteamAppManifest,
  steamGame
} from './local'
import type { SteamSocialAuth } from './social'

export { STEAM_INSTALL_SOURCE } from './local'

/** Session partition of the login window (and the hidden window that renews the token). */
export const STEAM_PARTITION = 'persist:steam'
export const STEAM_LOGIN_URL = 'https://steamcommunity.com/login/home/?goto='
/** Steam's own renewal: with a valid refresh cookie it redirects back with a fresh steamLoginSecure. */
const REFRESH_URL = `https://login.steampowered.com/jwt/refresh?redir=${encodeURIComponent('https://steamcommunity.com')}`
const COOKIE_URL = 'https://steamcommunity.com'
const RENEW_BEFORE_MS = 10 * 60_000

interface SteamSession {
  steamId: string
  token: string
  displayName: string
  /** Token expiry, epoch ms. */
  expiresAt: number
}

type InstallCache = Record<string, SteamAppManifest[]>
/** appid → store art (hashed asset paths) and when it was looked up. */
type ArtCache = Record<string, StoreArt & { at: number }>
const ART_TTL_MS = 7 * 24 * 60 * 60_000

const validSession = (v: unknown): v is SteamSession => {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.steamId === 'string' && /^\d{17}$/.test(s.steamId) && typeof s.token === 'string' && !!s.token &&
    typeof s.displayName === 'string' && typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt)
}

const validManifest = (v: unknown): v is SteamAppManifest => {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return typeof m.appid === 'string' && /^\d+$/.test(m.appid) && typeof m.name === 'string' && typeof m.installdir === 'string' &&
    typeof m.libraryPath === 'string' && typeof m.buildid === 'string' && typeof m.sizeOnDisk === 'number'
}

const libKey = (p: string): string => (process.platform === 'linux' ? resolve(p) : resolve(p).toLowerCase())
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const plainChrome = (ua: string): string => ua.replace(/ (Electron|gamekins)\/\S+/gi, '')

export class SteamProvider implements GameProvider {
  readonly id = 'steam' as const
  readonly name = 'Steam'
  readonly platform: Platform = process.platform === 'darwin' ? 'Mac' : 'Windows'
  /** Installed Steam games show up without signing in. */
  readonly alwaysOn = true
  partialRefreshError?: string
  /** Called when the web session dies so the UI can ask the user to sign in again. */
  onSessionExpired: (() => void) | null = null

  private generation = 0
  private session: SteamSession | null = null
  private sessionWrites: Promise<void> = Promise.resolve()
  private refreshing: Promise<SteamSession> | null = null
  private loginPromise: Promise<Account> | null = null
  private loginWindow: BrowserWindow | null = null
  private root: { at: number; path: Promise<string | null> } | null = null
  private scan: { at: number; work: Promise<SteamAppManifest[]> } | null = null
  /** appid → manifest from the last scan (installed games). */
  private manifests = new Map<string, SteamAppManifest>()
  /** appid → owned game from the last Web API fetch (signed in only). */
  private owned = new Map<string, OwnedGame>()
  private lastGames: ProviderGame[] = []
  private art: ArtCache | null = null

  accountGeneration(): number { return this.generation }
  seedLibrary(games: ProviderGame[]): void { this.lastGames = games }

  private get dir(): string {
    return dataDir('steam')
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('Account changed during operation')
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(join(this.dir, 'session.bin'))
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
      const s: unknown = JSON.parse(json)
      this.session = validSession(s) ? s : null
    } catch {
      this.session = null
    }
  }

  account(): Account | null {
    return this.session ? { provider: 'steam', id: this.session.steamId, displayName: this.session.displayName } : null
  }

  // ───────── session ─────────

  private saveSession(s: SteamSession | null, generation = this.generation): Promise<void> {
    this.assertGeneration(generation)
    this.session = s
    const file = join(this.dir, 'session.bin')
    const work = this.sessionWrites.catch(() => undefined).then(async () => {
      this.assertGeneration(generation)
      if (!s) { await rm(file, { force: true }); return }
      const json = JSON.stringify(s)
      const tmp = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(tmp, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json, { flag: 'wx', mode: 0o600 })
        this.assertGeneration(generation)
        renameSync(tmp, file)
      } finally { await rm(tmp, { force: true }).catch(() => undefined) }
    })
    this.sessionWrites = work
    return work
  }

  /** The newest signed-in steamLoginSecure cookie in our partition (optionally for one account). */
  private async cookieSession(steamId?: string): Promise<{ steamId: string; token: string; expiresAt: number } | null> {
    const cookies = await electronSession.fromPartition(STEAM_PARTITION).cookies.get({ url: COOKIE_URL, name: 'steamLoginSecure' })
    let best: { steamId: string; token: string; expiresAt: number } | null = null
    for (const c of cookies) {
      const parsed = parseSteamLoginSecure(c.value)
      if (!parsed || (steamId && parsed.steamId !== steamId)) continue
      const expiresAt = jwtExpiry(parsed.token) ?? Date.now() + 60 * 60_000
      if (!best || expiresAt > best.expiresAt) best = { ...parsed, expiresAt }
    }
    return best
  }

  /** A web access token, renewed shortly before it expires. `force`: the last one was rejected. */
  private async accessToken(force = false): Promise<string> {
    const generation = this.generation
    const s = this.session
    if (!s) throw new Error('Not signed in to Steam')
    if (!force && s.expiresAt - Date.now() > RENEW_BEFORE_MS) return s.token
    const work = this.refreshing ??= this.renew(s, generation)
    void work.finally(() => { if (this.refreshing === work) this.refreshing = null }).catch(() => undefined)
    try {
      const next = await work
      this.assertGeneration(generation)
      return next.token
    } catch (err) {
      if (generation !== this.generation) throw err
      // Renewal failed but the current token still has a little life left: keep using it.
      if (!force && s.expiresAt - Date.now() > 60_000) return s.token
      return this.expire()
    }
  }

  private async renew(s: SteamSession, generation: number): Promise<SteamSession> {
    let fresh = await this.cookieSession(s.steamId)
    if (!fresh || fresh.token === s.token || fresh.expiresAt - Date.now() < RENEW_BEFORE_MS) {
      // Let Steam rotate the cookie in a hidden page of the same partition (uses its refresh cookie).
      const win = new BrowserWindow({
        show: false,
        width: 480,
        height: 320,
        webPreferences: { partition: STEAM_PARTITION, sandbox: true, contextIsolation: true, spellcheck: false }
      })
      try {
        win.webContents.setUserAgent(plainChrome(win.webContents.getUserAgent()))
        win.webContents.setAudioMuted(true)
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        await Promise.race([win.loadURL(REFRESH_URL).catch(() => undefined), sleep(20_000)])
      } finally {
        if (!win.isDestroyed()) win.destroy()
      }
      this.assertGeneration(generation)
      fresh = await this.cookieSession(s.steamId)
    }
    if (!fresh || fresh.token === s.token || fresh.expiresAt <= Date.now() + 60_000) throw new Error('Steam did not renew the session')
    const next: SteamSession = { ...s, token: fresh.token, expiresAt: fresh.expiresAt }
    this.assertGeneration(generation)
    await this.saveSession(next, generation)
    return next
  }

  private async expire(): Promise<never> {
    ++this.generation
    this.refreshing = null
    this.owned.clear()
    await this.saveSession(null)
    // The cookies are dead too; a stale one must not be picked up by the next sign-in.
    await electronSession.fromPartition(STEAM_PARTITION).clearStorageData({ storages: ['cookies'] }).catch(() => undefined)
    this.onSessionExpired?.()
    throw new Error('Your Steam session expired. Please sign in again.')
  }

  /** Credentials for SteamSocial (renewed as needed); null when signed out or the session died. */
  async socialAuth(opts?: { forceRefresh?: boolean }): Promise<SteamSocialAuth | null> {
    const s = this.session
    if (!s) return null
    try {
      const token = await this.accessToken(!!opts?.forceRefresh)
      return { steamId: s.steamId, displayName: this.session?.displayName ?? s.displayName, token }
    } catch (err) {
      if (!this.session) return null
      throw err
    }
  }

  // ───────── sign in / out ─────────

  login(parent: BrowserWindow): Promise<Account> {
    if (this.loginPromise) return this.loginPromise
    const work = this.loginImpl(parent)
    this.loginPromise = work
    void work.finally(() => { if (this.loginPromise === work) this.loginPromise = null }).catch(() => undefined)
    return work
  }

  private loginImpl(parent: BrowserWindow): Promise<Account> {
    const generation = ++this.generation
    this.refreshing = null
    const partition = electronSession.fromPartition(STEAM_PARTITION)
    const webPreferences = { partition: STEAM_PARTITION, sandbox: true, contextIsolation: true, spellcheck: false }
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 540,
      height: 780,
      title: 'Sign in to Steam',
      autoHideMenuBar: true,
      backgroundColor: '#171a21',
      webPreferences
    })
    this.loginWindow = win
    win.webContents.setUserAgent(plainChrome(win.webContents.getUserAgent()))
    // Only web pages in this window; steam:// and other app links are not followed.
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('https:')) e.preventDefault() })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('https:')) return { action: 'deny' }
      return { action: 'allow', overrideBrowserWindowOptions: { parent: win, width: 540, height: 700, autoHideMenuBar: true, backgroundColor: '#171a21', webPreferences } }
    })
    win.webContents.on('did-create-window', (child) => child.webContents.setUserAgent(win.webContents.getUserAgent()))

    return new Promise((resolvePromise, reject) => {
      let settled = false
      let finishing = false
      const onCookie = (_e: unknown, cookie: Electron.Cookie, _cause: string, removed: boolean): void => {
        if (!removed && cookie.name === 'steamLoginSecure') void check()
      }
      const finish = (err: Error | null, account?: Account): void => {
        if (settled) return
        settled = true
        partition.cookies.removeListener('changed', onCookie)
        if (this.loginWindow === win) this.loginWindow = null
        if (!win.isDestroyed()) win.close()
        if (err) reject(err)
        else resolvePromise(account!)
      }
      // The user signs in (password + Steam Guard, or Steam's QR code) on Steam's page; we only
      // watch for the session cookie Steam sets afterwards.
      const check = async (): Promise<void> => {
        if (settled || finishing) return
        const found = await this.cookieSession().catch(() => null)
        if (!found || found.expiresAt - Date.now() < 60_000 || settled || finishing) return
        finishing = true
        try {
          const displayName = await this.lookupName(found.steamId, found.token)
          if (settled) throw new Error('Sign-in was cancelled')
          this.assertGeneration(generation)
          await this.saveSession({ steamId: found.steamId, token: found.token, displayName, expiresAt: found.expiresAt }, generation)
          this.assertGeneration(generation)
          finish(null, this.account()!)
        } catch (err) {
          finish(err as Error)
        }
      }
      partition.cookies.on('changed', onCookie)
      win.webContents.on('did-navigate', () => void check())
      win.webContents.on('did-finish-load', () => void check())
      win.on('closed', () => {
        if (!settled && generation === this.generation) { ++this.generation; this.refreshing = null }
        finish(new Error('Sign-in was cancelled'))
      })
      void win.loadURL(STEAM_LOGIN_URL).catch(() => undefined)
    })
  }

  /** Persona name: Web API, then the public profile, then the Steam client's login list. */
  private async lookupName(steamId: string, token: string): Promise<string> {
    try {
      const name = (await getPersonas(token, [steamId])).get(steamId)?.name?.trim()
      if (name) return name
    } catch { /* try the next source */ }
    try {
      const name = await communityName(steamId)
      if (name) return name
    } catch { /* try the next source */ }
    const client = await this.clientUser()
    return (client?.steamId === steamId && client.personaName) || 'Steam user'
  }

  async logout(): Promise<void> {
    ++this.generation
    this.loginPromise = null
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close()
    this.loginWindow = null
    this.refreshing = null
    this.owned.clear()
    this.lastGames = []
    this.partialRefreshError = undefined
    this.session = null
    const partition = electronSession.fromPartition(STEAM_PARTITION)
    await Promise.all([this.saveSession(null), partition.clearStorageData(), partition.clearCache()])
  }

  /** "Signed in to the Steam client as …" (from config/loginusers.vdf), independent of the web session. */
  async clientUser(): Promise<{ steamId: string; personaName?: string } | null> {
    const root = await this.steamRoot()
    const u = root ? await readClientUser(root) : null
    return u ? { steamId: u.steamId, personaName: u.personaName } : null
  }

  // ───────── library ─────────

  private steamRoot(): Promise<string | null> {
    // Re-check now and then in case Steam gets installed (or moved) while we run.
    if (!this.root || Date.now() - this.root.at > 5 * 60_000) {
      const path = findSteamRoot().catch(() => null)
      this.root = { at: Date.now(), path }
    }
    return this.root.path
  }

  /** Installed games (cached for a few seconds: fetchLibrary and scanExternalInstalls run back to back). */
  private installedManifests(): Promise<SteamAppManifest[]> {
    if (this.scan && Date.now() - this.scan.at < 5000) return this.scan.work
    const work = this.scanNow()
    this.scan = { at: Date.now(), work }
    work.catch(() => { if (this.scan?.work === work) this.scan = null })
    return work
  }

  private async scanNow(): Promise<SteamAppManifest[]> {
    const root = await this.steamRoot()
    if (!root) {
      this.manifests = new Map()
      return []
    }
    const { libraries, apps } = await scanSteamLibraries(root)
    // Libraries on a disconnected drive keep their last known games, so the library shows them
    // as "drive not connected" instead of forgetting them.
    const cache = await this.loadInstallCache()
    const next: InstallCache = {}
    const all = [...apps]
    const seen = new Set(apps.map((a) => a.appid))
    for (const lib of libraries) {
      const key = libKey(lib.path)
      if (lib.reachable) next[key] = apps.filter((a) => libKey(a.libraryPath) === key)
      else if (cache[key]) {
        next[key] = cache[key]
        for (const m of cache[key]) if (!seen.has(m.appid)) { seen.add(m.appid); all.push(m) }
      }
    }
    await writeFile(join(this.dir, 'installs.json'), JSON.stringify(next)).catch(() => undefined)
    this.manifests = new Map(all.map((m) => [m.appid, m]))
    return all
  }

  private async loadInstallCache(): Promise<InstallCache> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.dir, 'installs.json'), 'utf8'))
      if (!raw || typeof raw !== 'object') return {}
      const out: InstallCache = {}
      for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.filter(validManifest)
      return out
    } catch {
      return {}
    }
  }

  async fetchLibrary(): Promise<ProviderGame[]> {
    const generation = this.generation
    this.partialRefreshError = undefined
    const games = new Map<string, ProviderGame>()
    for (const m of await this.installedManifests()) games.set(m.appid, manifestToGame(m, this.platform))
    if (this.session) {
      try {
        let owned: OwnedGame[]
        try {
          owned = await getOwnedGames(await this.accessToken(), this.session.steamId)
        } catch (err) {
          if (!isAuthError(err) || !this.session) throw err
          owned = await getOwnedGames(await this.accessToken(true), this.session.steamId)
        }
        this.assertGeneration(generation)
        this.owned = new Map(owned.map((o) => [String(o.appid), o]))
        for (const o of owned) {
          const id = String(o.appid)
          if (!games.has(id)) games.set(id, steamGame(id, o.name?.trim() || `Steam app ${id}`, []))
        }
      } catch (err) {
        if (generation !== this.generation) throw err
        // Keep the owned games we already knew about; installed ones are always fresh.
        for (const g of this.lastGames) if (g.provider === 'steam' && !games.has(g.appName)) games.set(g.appName, g)
        this.partialRefreshError = `Couldn't load your Steam library: ${(err as Error).message}`
      }
    }
    const list = await this.withStoreArt([...games.values()])
    this.assertGeneration(generation)
    this.lastGames = list
    return list
  }

  /**
   * Swap the guessed CDN art for the store's real asset paths: newer apps keep their art in
   * hashed folders, where the plain library_600x900.jpg path 404s. Best effort, cached a week.
   */
  private async withStoreArt(games: ProviderGame[]): Promise<ProviderGame[]> {
    const file = join(this.dir, 'art.json')
    if (!this.art) {
      this.art = {}
      try {
        const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (raw && typeof raw === 'object') {
          for (const [id, v] of Object.entries(raw)) {
            if (!/^\d+$/.test(id) || !v || typeof v !== 'object' || typeof (v as { at?: unknown }).at !== 'number') continue
            const e = v as Record<string, unknown>
            const url = (k: string): string | undefined => (typeof e[k] === 'string' && (e[k] as string).startsWith('https://') ? (e[k] as string) : undefined)
            this.art[id] = { at: e.at as number, tall: url('tall'), wide: url('wide'), thumb: url('thumb') }
          }
        }
      } catch { /* no cache yet */ }
    }
    const art = this.art
    const stale = games.map((g) => g.appName).filter((id) => !art[id] || Date.now() - art[id].at > ART_TTL_MS)
    if (stale.length) {
      try {
        const found = await getStoreArt(stale)
        for (const id of stale) art[id] = { at: Date.now(), ...found.get(id) }
        await writeFile(file, JSON.stringify(art)).catch(() => undefined)
      } catch { /* offline: keep the default CDN paths and try again next refresh */ }
    }
    return games.map((g) => {
      const a = art[g.appName]
      if (!a) return g
      const images = { ...g.images }
      if (a.tall) images.tall = a.tall
      if (a.wide) images.wide = a.wide
      if (a.thumb) images.thumb = a.thumb
      return { ...g, images }
    })
  }

  /**
   * Steam's own play time and last-played dates, keyed by appName (appid). Owned games need a
   * sign-in; installed games still report their last-played time from the manifest.
   */
  playStats(): Record<string, { seconds: number; lastPlayed?: number }> {
    const out: Record<string, { seconds: number; lastPlayed?: number }> = {}
    for (const [id, o] of this.owned) {
      out[id] = { seconds: (o.playtime_forever ?? 0) * 60, lastPlayed: o.rtime_last_played ? o.rtime_last_played * 1000 : undefined }
    }
    for (const [id, m] of this.manifests) {
      if (!m.lastPlayed) continue
      const cur = out[id] ?? { seconds: 0 }
      cur.lastPlayed = Math.max(cur.lastPlayed ?? 0, m.lastPlayed * 1000)
      out[id] = cur
    }
    return out
  }

  /** Every game the Steam client has installed, keyed by appid. */
  async scanExternalInstalls(): Promise<Map<string, InstalledInfo>> {
    const apps = await this.installedManifests()
    return new Map(apps.map((m) => [m.appid, manifestToInstall(m, this.platform)]))
  }

  folderName(game: ProviderGame): string {
    const dir = this.manifests.get(game.appName)?.installdir
    return dir || game.title.replace(/[<>:"/\\|?*]/g, '').trim() || game.appName
  }

  // ───────── installs: all through the Steam client ─────────

  createInstallTask(): InstallTask {
    throw new Error('Steam installs and updates its own games. Use Install to hand this game to the Steam client.')
  }

  async estimate(game: ProviderGame): Promise<{ downloadBytes: number; installBytes: number; version: string }> {
    const m = this.manifests.get(game.appName)
    return { downloadBytes: m?.sizeOnDisk ?? 0, installBytes: m?.sizeOnDisk ?? 0, version: m?.buildid ?? '' }
  }

  private appId(game: ProviderGame): string {
    if (!/^\d+$/.test(game.appName)) throw new Error('Not a Steam game')
    return game.appName
  }

  async installViaOfficial(game: ProviderGame): Promise<void> {
    await shell.openExternal(`steam://install/${this.appId(game)}`)
  }

  /**
   * Steam starts the game (and handles DRM, cloud saves, updates). Returns null: the library
   * tracks the processes running from the install folder.
   */
  async launch(game: ProviderGame, _install: InstalledInfo, opts: LaunchOptions): Promise<ChildProcess | null> {
    const appid = this.appId(game)
    const args = opts.extraArgs?.trim() ? splitArgs(opts.extraArgs) : []
    if (args.length) {
      const exe = await findSteamExe(await this.steamRoot())
      if (exe) {
        const child = process.platform === 'darwin'
          ? spawn('open', ['-a', exe, '--args', '-applaunch', appid, ...args], { detached: true, stdio: 'ignore' })
          : spawn(exe, ['-applaunch', appid, ...args], { detached: true, stdio: 'ignore' })
        child.once('error', (err) => console.error('[steam] launch', err))
        child.unref()
        return null
      }
    }
    await shell.openExternal(`steam://rungameid/${appid}`)
    return null
  }

  /** Opens Steam's uninstall confirmation; the next library scan picks up the result. */
  async uninstall(game: ProviderGame): Promise<void> {
    await shell.openExternal(`steam://uninstall/${this.appId(game)}`)
  }
}
