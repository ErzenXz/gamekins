// GOG: sign in with GOG's own page (Galaxy's public OAuth client), owned games from the GOG
// account, installs made by GOG Galaxy / offline installers, direct DRM-free launching.
// Installing and updating stay with GOG Galaxy in v1.

import { BrowserWindow, safeStorage, shell, session as electronSession } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Account, InstalledInfo, Platform } from '@shared/types'
import { splitArgs } from '../../core/args'
import { settings } from '../../core/settings'
import { dataDir } from '../../core/store'
import type { GameProvider, InstallTask, LaunchOptions, ProviderGame } from '../types'
import {
  detailsFromV2,
  exchangeAuthCode,
  extractAuthCode,
  fetchGameV2,
  fetchProducts,
  fetchUser,
  GogApi,
  GogApiError,
  type GogDetails,
  type GogSession,
  isRedirectUrl,
  LOGIN_URL,
  type OwnedEntry,
  ownedFromFiltered,
  ownedFromProducts,
  refreshSession,
  toProviderGame
} from './api'
import { defaultGogRoots, findGalaxyClient, scanMac, scanWindows } from './discovery'

export { GOG_INSTALL_SOURCE } from './discovery'

/** Session partition of the GOG sign-in window. */
export const GOG_PARTITION = 'persist:gog'

/** Cached store details are refreshed after this long (art and developer rarely change). */
const DETAILS_TTL = 30 * 24 * 60 * 60_000
/** Delisted products (404) are asked about again after a day. */
const MISSING_TTL = 24 * 60 * 60_000

type DetailsCache = Record<string, GogDetails>

const validSession = (v: unknown): v is GogSession => {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.access_token === 'string' && !!s.access_token && typeof s.refresh_token === 'string' && !!s.refresh_token &&
    typeof s.user_id === 'string' && /^\d{1,24}$/.test(s.user_id) && typeof s.username === 'string' &&
    typeof s.expires_at === 'number' && Number.isFinite(s.expires_at)
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export class GogProvider implements GameProvider {
  readonly id = 'gog' as const
  readonly name = 'GOG'
  readonly platform: Platform = process.platform === 'darwin' ? 'Mac' : 'Windows'

  private generation = 0
  private session: GogSession | null = null
  private sessionWrites: Promise<void> = Promise.resolve()
  private refreshing: Promise<GogSession> | null = null
  private loginPromise: Promise<Account> | null = null
  private loginWindow: BrowserWindow | null = null
  private details: DetailsCache = {}
  private lastGames: ProviderGame[] = []
  partialRefreshError?: string
  /** Called when the session dies so the UI can ask the user to sign in again. */
  onSessionExpired: (() => void) | null = null

  private readonly api = new GogApi(() => this.accessToken(), () => this.forceRefresh())

  accountGeneration(): number { return this.generation }
  seedLibrary(games: ProviderGame[]): void { this.lastGames = games }

  private get dir(): string {
    return dataDir('gog')
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
    try {
      const cache: unknown = JSON.parse(await readFile(join(this.dir, 'details.json'), 'utf8'))
      this.details = cache && typeof cache === 'object' && !Array.isArray(cache) ? (cache as DetailsCache) : {}
    } catch {
      this.details = {}
    }
  }

  // ───────── session ─────────

  private saveSession(s: GogSession | null, generation = this.generation): Promise<void> {
    this.assertGeneration(generation)
    if (s && !validSession(s)) throw new Error('Invalid GOG session response')
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

  account(): Account | null {
    if (!this.session) return null
    return { provider: 'gog', id: this.session.user_id, displayName: this.session.username || 'GOG user' }
  }

  private async accessToken(): Promise<string> {
    const s = this.session
    if (!s) throw new Error('Not signed in to GOG')
    if (s.expires_at - Date.now() > 5 * 60_000) return s.access_token
    return (await this.refresh()).access_token
  }

  /** GOG rejected a token that looked valid: get a new one (once per burst). */
  private async forceRefresh(): Promise<void> {
    await this.refresh()
  }

  private refresh(): Promise<GogSession> {
    const generation = this.generation
    const s = this.session
    if (!s) return Promise.reject(new Error('Not signed in to GOG'))
    this.refreshing ??= refreshSession(s.refresh_token)
      .then(async (next) => {
        this.assertGeneration(generation)
        const merged = { ...next, username: s.username, user_id: next.user_id || s.user_id }
        await this.saveSession(merged, generation)
        return merged
      })
      .catch(async (err) => {
        if (generation !== this.generation) throw err
        const status = (err as { status?: number }).status
        // Refresh token rejected (revoked, password changed…): the session is dead.
        if (status === 400 || status === 401) await this.expire()
        throw err
      })
      .finally(() => { if (generation === this.generation) this.refreshing = null })
    return this.refreshing
  }

  private async expire(): Promise<never> {
    ++this.generation
    this.refreshing = null
    await this.saveSession(null)
    this.onSessionExpired?.()
    throw new Error('Your GOG session expired. Please sign in again.')
  }

  /** Credentials for the friends/presence services (a fresh token, refreshed as needed). */
  async socialAuth(): Promise<{ accountId: string; displayName: string; token: string } | null> {
    const s = this.session
    if (!s) return null
    const token = await this.accessToken()
    return { accountId: s.user_id, displayName: s.username || 'GOG user', token }
  }

  /** Display name for a fresh session: embed userData, else the public Galaxy profile. */
  private async lookupUsername(s: GogSession): Promise<string> {
    const api = new GogApi(async () => s.access_token)
    const data = await api.userData().catch(() => null)
    if (data?.username) return data.username
    const user = await fetchUser(s.user_id).catch(() => undefined)
    return user?.username || ''
  }

  // ───────── sign-in ─────────

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
    const webPreferences = { partition: GOG_PARTITION, sandbox: true, contextIsolation: true, spellcheck: false }
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 520,
      height: 760,
      title: 'Sign in to GOG',
      autoHideMenuBar: true,
      backgroundColor: '#18181c',
      webPreferences
    })
    this.loginWindow = win
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ (Electron|gamekins)\/\S+/gi, ''))
    // Social sign-ins (Google, Facebook, Discord…) open popups that report back to GOG's page.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('https:')) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { parent: win, width: 520, height: 700, autoHideMenuBar: true, backgroundColor: '#18181c', webPreferences }
      }
    })
    win.webContents.on('did-create-window', (child) => child.webContents.setUserAgent(win.webContents.getUserAgent()))

    return new Promise((resolvePromise, reject) => {
      let settled = false
      let exchanging = false
      const finish = (err: Error | null, account?: Account): void => {
        if (settled) return
        settled = true
        if (this.loginWindow === win) this.loginWindow = null
        if (!win.isDestroyed()) win.close()
        if (err) reject(err)
        else resolvePromise(account!)
      }

      // The user signs in on GOG's own page; we only watch for the redirect that carries the code.
      const onUrl = (event: { preventDefault(): void } | null, url: string): void => {
        if (settled || exchanging || !isRedirectUrl(url)) return
        event?.preventDefault()
        let code: string | null
        try {
          code = extractAuthCode(url)
        } catch (err) {
          finish(err as Error)
          return
        }
        if (!code) {
          // Redirected without a code: go through the sign-in page once more.
          void win.loadURL(LOGIN_URL)
          return
        }
        exchanging = true
        void (async () => {
          try {
            const session = await exchangeAuthCode(code)
            if (settled) throw new Error('Sign-in was cancelled')
            this.assertGeneration(generation)
            session.username = await this.lookupUsername(session)
            this.assertGeneration(generation)
            await this.saveSession(session, generation)
            if (settled) throw new Error('Sign-in was cancelled')
            finish(null, this.account()!)
          } catch (err) {
            finish(err as Error)
          }
        })()
      }
      win.webContents.on('will-redirect', (event, url) => onUrl(event, url))
      win.webContents.on('will-navigate', (event, url) => onUrl(event, url))
      win.webContents.on('did-navigate', (_event, url) => onUrl(null, url))
      win.webContents.on('did-redirect-navigation', (_event, url) => onUrl(null, url))
      win.on('closed', () => {
        if (!settled && generation === this.generation) { ++this.generation; this.refreshing = null }
        finish(new Error('Sign-in was cancelled'))
      })
      void win.loadURL(LOGIN_URL)
    })
  }

  async logout(): Promise<void> {
    ++this.generation
    this.loginPromise = null
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close()
    this.loginWindow = null
    this.refreshing = null
    this.lastGames = []
    this.partialRefreshError = undefined
    this.session = null
    const partition = electronSession.fromPartition(GOG_PARTITION)
    await Promise.all([this.saveSession(null), partition.clearStorageData(), partition.clearCache()])
  }

  // ───────── library ─────────

  /** Owned games: the account's game shelf, or (if that fails) owned ids resolved through the product API. */
  private async owned(): Promise<OwnedEntry[]> {
    try {
      return ownedFromFiltered(await this.api.allGames())
    } catch (err) {
      if ((err as GogApiError).status === 401 || !this.session) throw err
      console.warn('[gog] getFilteredProducts failed, falling back to owned ids', err)
      return ownedFromProducts(await fetchProducts(await this.api.ownedIds()))
    }
  }

  async fetchLibrary(onProgress?: (done: number, total: number) => void): Promise<ProviderGame[]> {
    if (!this.session) return []
    const generation = this.generation
    this.partialRefreshError = undefined
    const owned = await this.owned()
    this.assertGeneration(generation)

    const now = Date.now()
    const stale = owned.filter((o) => {
      const d = this.details[o.id]
      return !d || now - d.at > (d.missing ? MISSING_TTL : DETAILS_TTL)
    })
    let done = 0
    let failed = 0
    onProgress?.(0, stale.length)
    const fetched = await mapLimit(stale, 8, async (o) => {
      this.assertGeneration(generation)
      let d: GogDetails | undefined
      try {
        const v2 = await fetchGameV2(o.id)
        d = v2 ? detailsFromV2(v2) : { at: Date.now(), missing: true }
      } catch {
        failed++
      }
      onProgress?.(++done, stale.length)
      return { id: o.id, d }
    })
    this.assertGeneration(generation)
    for (const { id, d } of fetched) if (d) this.details[id] = d
    if (stale.length) await writeFile(join(this.dir, 'details.json'), JSON.stringify(this.details)).catch(() => undefined)

    const games = owned.map((o) => toProviderGame(o, this.details[o.id]))
    this.lastGames = games
    if (failed) this.partialRefreshError = `Partial refresh: GOG details unavailable for ${failed} games`
    return games
  }

  async scanExternalInstalls(): Promise<Map<string, InstalledInfo>> {
    const roots = await defaultGogRoots()
    const installDir = settings().installDir
    if (installDir && !roots.includes(installDir)) roots.push(installDir)
    if (process.platform === 'win32') return scanWindows(roots)
    if (process.platform === 'darwin') return scanMac(roots)
    return new Map()
  }

  folderName(game: ProviderGame): string {
    return game.title.replace(/[<>:"/\\|?*]/g, '').trim() || game.appName
  }

  // ───────── install / uninstall: GOG Galaxy's job in v1 ─────────

  createInstallTask(): InstallTask {
    throw new Error('GOG games are installed by GOG Galaxy. Use Install to open the game in GOG Galaxy (or its page on GOG.com).')
  }

  async estimate(game: ProviderGame): Promise<{ downloadBytes: number; installBytes: number; version: string }> {
    let sizeMB = this.details[game.appName]?.sizeMB
    if (sizeMB === undefined) {
      const v2 = await fetchGameV2(game.appName).catch(() => undefined)
      sizeMB = v2 ? detailsFromV2(v2).sizeMB : undefined
    }
    const bytes = sizeMB ? Math.round(sizeMB * 1024 * 1024) : 0
    return { downloadBytes: bytes, installBytes: bytes, version: '' }
  }

  private storePage(game: ProviderGame): string {
    return game.storeUrl?.startsWith('https://www.gog.com/') ? game.storeUrl : 'https://www.gog.com/account'
  }

  /** Opens the game in GOG Galaxy (which installs it), or its GOG.com page without Galaxy. */
  async installViaOfficial(game: ProviderGame): Promise<void> {
    if (!/^\d{1,20}$/.test(game.appName)) throw new Error('Unknown GOG game')
    if (await findGalaxyClient()) await shell.openExternal(`goggalaxy://openGameView/${game.appName}`)
    else await shell.openExternal(this.storePage(game))
  }

  async launch(game: ProviderGame, install: InstalledInfo, opts: LaunchOptions): Promise<ChildProcess | null> {
    if (opts.viaOfficialLauncher && process.platform === 'win32' && /^\d{1,20}$/.test(game.appName)) {
      const galaxy = await findGalaxyClient()
      if (galaxy) {
        // Galaxy parses /path="…" itself, so pass the command line verbatim.
        const child = spawn(galaxy, ['/command=runGame', `/gameId=${game.appName}`, `/path="${install.path}"`], {
          detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true
        })
        child.once('error', (err) => console.error('[gog] GOG Galaxy launch failed', err))
        child.unref()
        return null
      }
    }

    const args = splitArgs([install.launchCommand, opts.extraArgs].filter((s) => s?.trim()).join(' '))
    if (process.platform === 'darwin' && install.path.endsWith('.app')) {
      return spawn('open', ['-W', '-a', install.path, ...(args.length ? ['--args', ...args] : [])], { detached: true, stdio: 'ignore' })
    }
    const exe = join(install.path, install.executable)
    if (!install.executable || !existsSync(exe)) {
      throw new Error(`Can't find the game executable. Try repairing the game in GOG Galaxy.\n${exe}`)
    }
    return spawn(exe, args, {
      cwd: install.workingDirectory && existsSync(install.workingDirectory) ? install.workingDirectory : dirname(exe),
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
  }

  /**
   * Runs the game's own uninstaller (GOG installers are Inno Setup: unins000.exe in the game
   * folder). We never delete GOG folders ourselves. Without one, GOG Galaxy is opened instead.
   */
  async uninstall(game: ProviderGame, install: InstalledInfo): Promise<void> {
    const uninstaller = process.platform === 'win32' ? join(install.path, 'unins000.exe') : null
    if (uninstaller && existsSync(uninstaller)) {
      // `start /wait` goes through ShellExecute, so the UAC prompt for Program Files installs works.
      const code = await new Promise<number | null>((resolvePromise, reject) => {
        const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" /wait "${uninstaller}"`], {
          windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore'
        })
        child.once('error', reject)
        child.once('exit', resolvePromise)
      })
      if (existsSync(join(install.path, install.executable)) && existsSync(uninstaller)) {
        throw new Error(code ? `The GOG uninstaller was cancelled or failed (exit code ${code}).` : 'The game is still installed. The GOG uninstaller may have been cancelled.')
      }
      return
    }
    if (/^\d{1,20}$/.test(game.appName) && (await findGalaxyClient())) {
      await shell.openExternal(`goggalaxy://openGameView/${game.appName}`)
      throw new Error('This game has no uninstaller of its own. Uninstall it from GOG Galaxy (opened for you).')
    }
    throw new Error(`This game has no uninstaller. Remove its folder manually:\n${install.path}`)
  }
}
