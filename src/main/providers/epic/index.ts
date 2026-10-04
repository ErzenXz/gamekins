import { app, BrowserWindow, safeStorage, shell, session as electronSession } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, renameSync, realpathSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { FsBoundary, manifestTarget, pathKey } from './fsBoundary'
import { splitArgs } from '../../core/args'
import { access, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import type { Account, FreeGame, InstalledInfo, Platform } from '@shared/types'
import { settings } from '../../core/settings'
import { dataDir } from '../../core/store'
import { object, text, string } from '../../core/validation'
import type { GameProvider, InstallRequest, InstallTask, LaunchOptions, ProviderGame } from '../types'
import {
  type CatalogItem,
  downloadManifest,
  EpicApi,
  type EpicSession,
  exchangeAuthCode,
  fetchRetry,
  killSession,
  LOGIN_REDIRECT_URL,
  LOGIN_URL,
  refreshSession
} from './api'
import { discardPartial, EpicInstallTask } from './installer'
import {
  defaultEpicRoots,
  readEgstoreManifest,
  removeEglRecord,
  relocateEglRecords,
  scanEglInstalls,
  listEgstoreFolders,
  readEgstoreManifests
} from './launcherData'
import { parseManifest } from './manifest'

/** Session partition shared by the login window and the in-app store, so one login covers both. */
export const EPIC_PARTITION = 'persist:epic'

type CatalogCache = Record<string, CatalogItem>
const validSession = (value: unknown): boolean => object(value) && string(value.access_token) && !!value.access_token &&
  string(value.refresh_token) && !!value.refresh_token && text(value.account_id) && string(value.displayName) &&
  typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at)) &&
  typeof value.refresh_expires_at === 'string' && Number.isFinite(Date.parse(value.refresh_expires_at))

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

function pickImage(item: CatalogItem, ...types: string[]): string | undefined {
  for (const t of types) {
    const img = item.keyImages?.find((k) => k.type === t)
    if (img) return img.url
  }
  return undefined
}

export class EpicProvider implements GameProvider {
  readonly id = 'epic' as const
  readonly name = 'Epic Games'
  readonly platform: Platform = process.platform === 'darwin' ? 'Mac' : 'Windows'

  private generation = 0
  private sessionWrites: Promise<void> = Promise.resolve()
  private loginPromise: Promise<Account> | null = null
  private loginWindow: BrowserWindow | null = null
  partialRefreshError?: string
  accountGeneration(): number { return this.generation }
  seedLibrary(games: ProviderGame[]): void { this.lastGames = games }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('Account changed during operation')
  }
  private session: EpicSession | null = null
  private refreshing: Promise<EpicSession> | null = null
  private catalog: CatalogCache = {}
  /** Games and DLC from the last library fetch (for matching orphaned install folders). */
  private lastGames: ProviderGame[] = []
  private freeCache: { at: number; games: FreeGame[] } | null = null
  private readonly api = new EpicApi(() => this.accessToken())

  private get dir(): string {
    return dataDir('epic')
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(join(this.dir, 'session.bin'))
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
      this.session = JSON.parse(json)
      if (!validSession(this.session)) throw new Error('Invalid saved Epic session')
    } catch {
      this.session = null
    }
    try {
      this.catalog = JSON.parse(await readFile(join(this.dir, 'catalog.json'), 'utf8'))
    } catch {
      this.catalog = {}
    }
  }

  private saveSession(s: EpicSession | null, generation = this.generation): Promise<void> {
    this.assertGeneration(generation)
    if (s && !validSession(s)) throw new Error('Invalid Epic session response')
    this.session = s
    const file = join(this.dir, 'session.bin')
    const work = this.sessionWrites.catch(() => undefined).then(async () => {
      this.assertGeneration(generation)
      if (!s) { await rm(file, { force: true }); return }
      const json = JSON.stringify(s)
      const tmp = file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(tmp, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json, { flag: 'wx', mode: 0o600 })
        this.assertGeneration(generation)
        // The generation check and promotion are synchronous: logout cannot interleave.
        renameSync(tmp, file)
      } finally { await rm(tmp, { force: true }).catch(() => undefined) }
    })
    this.sessionWrites = work
    return work
  }

  account(): Account | null {
    if (!this.session) return null
    return { provider: 'epic', id: this.session.account_id, displayName: this.session.displayName }
  }

  private async accessToken(): Promise<string> {
    const generation = this.generation
    const s = this.session
    if (!s) throw new Error('Not signed in to Epic Games')
    if (new Date(s.expires_at).getTime() - Date.now() > 10 * 60_000) return s.access_token
    if (new Date(s.refresh_expires_at).getTime() < Date.now()) return this.expire()
    this.refreshing ??= refreshSession(s.refresh_token)
      .then(async (next) => {
        this.assertGeneration(generation)
        await this.saveSession(next, generation)
        return next
      })
      .catch(async (err) => {
        // Refresh token rejected (revoked, password changed...): the session is dead.
        if (generation !== this.generation) throw err
        if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 401) {
          await this.expire()
        }
        throw err
      })
      .finally(() => { if (generation === this.generation) this.refreshing = null })
    const next = await this.refreshing
    this.assertGeneration(generation)
    return next.access_token
  }

  /** Called when the session dies so the UI can ask the user to sign in again. */
  onSessionExpired: (() => void) | null = null

  private async expire(): Promise<never> {
    ++this.generation
    this.refreshing = null
    await this.saveSession(null)
    this.onSessionExpired?.()
    throw new Error('Your Epic Games session expired. Please sign in again.')
  }

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
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 520,
      height: 780,
      title: 'Sign in to Epic Games',
      autoHideMenuBar: true,
      backgroundColor: '#18181c',
      webPreferences: { partition: EPIC_PARTITION, sandbox: true, contextIsolation: true, spellcheck: false }
    })
    this.loginWindow = win
    // Epic's login rejects obviously-embedded browsers; look like plain Chrome.
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ (Electron|gamekins)\/\S+/gi, ''))
    // Social sign-ins (Google, Apple, Facebook, consoles…) may use popups that report back
    // to the login page, so they must stay in-app and share the session.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('https:')) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: win,
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          backgroundColor: '#18181c',
          webPreferences: { partition: EPIC_PARTITION, sandbox: true, contextIsolation: true, spellcheck: false }
        }
      }
    })
    win.webContents.on('did-create-window', (child) =>
      child.webContents.setUserAgent(win.webContents.getUserAgent())
    )

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

      win.webContents.on('did-finish-load', async () => {
        if (settled || exchanging || !win.webContents.getURL().startsWith(LOGIN_REDIRECT_URL.split('?')[0])) return
        exchanging = true
        try {
          const text: string = await win.webContents.executeJavaScript('document.body.innerText')
          const { authorizationCode } = JSON.parse(text)
          if (!authorizationCode) {
            // Logged-in cookie without a fresh code: go back through the login page once.
            exchanging = false
            await win.loadURL(LOGIN_URL)
            return
          }
          const session = await exchangeAuthCode(authorizationCode)
          if (settled) throw new Error('Sign-in was cancelled')
          this.assertGeneration(generation)
          await this.saveSession(session, generation)
          this.assertGeneration(generation)
          if (settled) throw new Error('Sign-in was cancelled')
          finish(null, this.account()!)
        } catch (err) {
          finish(err as Error)
        }
      })
      win.on('closed', () => {
        if (!settled && generation === this.generation) { ++this.generation; this.refreshing = null }
        finish(new Error('Sign-in was cancelled'))
      })
      void win.loadURL(LOGIN_URL)
    })
  }

  async logout(): Promise<void> {
    const token = this.session?.access_token
    ++this.generation
    this.loginPromise = null
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close()
    this.loginWindow = null
    this.refreshing = null
    this.lastGames = []
    this.partialRefreshError = undefined
    this.session = null
    const partition = electronSession.fromPartition(EPIC_PARTITION)
    await Promise.all([this.saveSession(null), partition.clearStorageData(), partition.clearCache()])
    if (token) await killSession(token).catch(() => undefined)
  }

  async fetchLibrary(onProgress?: (done: number, total: number) => void): Promise<ProviderGame[]> {
    if (!this.session) return []
    const generation = this.generation
    this.partialRefreshError = undefined
    const [records, assets] = await Promise.all([
      this.api.libraryItems(),
      this.api.assets(this.platform).catch(() => [])
    ])
    this.assertGeneration(generation)
    const latest = new Map(assets.map((a) => [a.appName, a.buildVersion]))

    const owned = new Map<string, (typeof records)[number]>()
    for (const r of records) {
      if (!r.appName || r.namespace === 'ue' || r.sandboxType === 'PRIVATE') continue
      owned.set(r.appName, r)
    }

    const missing = [...owned.values()].filter((r) => !this.catalog[r.catalogItemId])
    let done = 0
    onProgress?.(0, missing.length)
    let failed = 0
    const fetched = await mapLimit(missing, 12, async (r) => {
      this.assertGeneration(generation)
      const item = await this.api.catalogItem(r.namespace, r.catalogItemId).catch(() => undefined)
      if (!item) failed++
      onProgress?.(++done, missing.length)
      return { id: r.catalogItemId, item }
    })
    this.assertGeneration(generation)
    for (const { id, item } of fetched) if (item) this.catalog[id] = item
    if (missing.length) await writeFile(join(this.dir, 'catalog.json'), JSON.stringify(this.catalog))

    // catalogItemId -> appName, to attach DLC to the game they belong to.
    const appByItem = new Map([...owned.values()].map((r) => [r.catalogItemId, r.appName]))

    const games: ProviderGame[] = []
    for (const r of owned.values()) {
      const item = this.catalog[r.catalogItemId]
      if (!item) {
        const cached = this.lastGames.find((g) => g.appName === r.appName)
        games.push(cached ? { ...cached, latestVersion: latest.get(r.appName) ?? cached.latestVersion } : {
          key: 'epic:' + r.appName, provider: 'epic', appName: r.appName, title: r.appName,
          namespace: r.namespace, catalogItemId: r.catalogItemId, images: {},
          platforms: latest.has(r.appName) ? [this.platform] : [], latestVersion: latest.get(r.appName),
          canRunOffline: false, requiresOwnershipToken: false
        })
        continue
      }
      const main = item.mainGameItem as { id?: string } | undefined
      let dlcOf: string | undefined
      if (main) {
        const parent = main.id ? appByItem.get(main.id) : undefined
        if (!parent) continue // DLC for a game we don't own (or can't resolve)
        dlcOf = `epic:${parent}`
      } else if (item.categories?.some((c) => c.path === 'addons' || c.path === 'digitalextras')) {
        continue
      }
      const attrs = item.customAttributes ?? {}
      const platforms = new Set<Platform>()
      for (const rel of item.releaseInfo ?? [])
        for (const p of rel.platform ?? []) if (p === 'Windows' || p === 'Mac') platforms.add(p)
      if (latest.has(r.appName)) platforms.add(this.platform)

      games.push({
        key: `epic:${r.appName}`,
        provider: 'epic',
        appName: r.appName,
        title: item.title,
        namespace: r.namespace,
        catalogItemId: r.catalogItemId,
        developer: item.developer,
        description: item.description,
        images: {
          tall: pickImage(item, 'DieselGameBoxTall', 'OfferImageTall', 'Thumbnail'),
          wide: pickImage(item, 'DieselGameBox', 'OfferImageWide', 'DieselStoreFrontWide', 'Featured'),
          logo: pickImage(item, 'DieselGameBoxLogo'),
          thumb: pickImage(item, 'DieselGameBoxTall', 'Thumbnail', 'OfferImageTall')
        },
        platforms: [...platforms],
        latestVersion: latest.get(r.appName),
        thirdPartyManagedApp: attrs.ThirdPartyManagedApp?.value || attrs.partnerLinkType?.value || undefined,
        canRunOffline: attrs.CanRunOffline?.value === 'true',
        requiresOwnershipToken: attrs.OwnershipToken?.value === 'true',
        storeUrl: attrs['com.epicgames.app.productSlug']?.value
          ? `https://store.epicgames.com/en-US/p/${attrs['com.epicgames.app.productSlug'].value.replace(/\/home$/, '')}`
          : undefined,
        dlcOf
      })
    }
    this.assertGeneration(generation)
    this.lastGames = games
    if (failed) this.partialRefreshError = `Partial refresh: metadata unavailable for ${failed} owned games`
    return games
  }

  async freeGames(): Promise<FreeGame[]> {
    if (this.freeCache && Date.now() - this.freeCache.at < 60 * 60_000) return this.freeCache.games
    const res = await fetchRetry(
      'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US'
    )
    if (!res.ok) throw new Error(`Free games: HTTP ${res.status}`)
    const json = (await res.json()) as FreePromoResponse
    const out: FreeGame[] = []
    for (const e of json.data?.Catalog?.searchStore?.elements ?? []) {
      const promos = e.promotions
      const now = promos?.promotionalOffers?.[0]?.promotionalOffers?.find((o) => o.discountSetting?.discountPercentage === 0)
      const next = promos?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.find(
        (o) => o.discountSetting?.discountPercentage === 0
      )
      const offer = now ?? next
      if (!offer) continue
      const slug = e.productSlug?.replace(/\/home$/, '') || e.catalogNs?.mappings?.[0]?.pageSlug || e.urlSlug
      const img = (t: string): string | undefined => e.keyImages?.find((k) => k.type === t)?.url
      out.push({
        title: e.title,
        image: img('OfferImageWide') ?? img('featuredMedia') ?? img('DieselStoreFrontWide') ?? img('Thumbnail'),
        url: slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/en-US/free-games',
        startDate: offer.startDate,
        endDate: offer.endDate,
        current: !!now
      })
    }
    out.sort((a, b) => Number(b.current) - Number(a.current))
    this.freeCache = { at: Date.now(), games: out }
    return out
  }

  async scanExternalInstalls(): Promise<Map<string, InstalledInfo>> {
    if (!settings().importEpicLauncherInstalls) return new Map()
    const found = await scanEglInstalls(this.platform)
    const claimed = new Set(
      [...found.entries()].filter(([app]) => !this.isDlc(app)).map(([, i]) => resolve(i.path).toLowerCase())
    )
    const unclaimed = this.lastGames.filter((g) => !g.dlcOf && !found.has(g.appName))
    if (!unclaimed.length) return found

    // Folders the launcher forgot about: match them to owned games (and their DLC).
    // Parsing big manifests (Fortnite's are ~10 MB) and checking thousands of files is slow,
    // so results are cached per folder and only recomputed when its manifests change.
    const cache = await this.loadAdoptCache()
    const next: AdoptCache = {}
    const roots = [...defaultEpicRoots(), settings().installDir]
    for (const ref of await listEgstoreFolders(roots)) {
      const id = resolve(ref.path).toLowerCase()
      if (claimed.has(id)) continue
      let entry = cache[id]
      if (!entry || entry.sig !== ref.sig || (!entry.apps.length && Date.now() - (entry.at ?? 0) >= 24 * 60 * 60_000) || entry.apps.some(([, i]) => i.executable && !existsSync(join(i.path, i.executable)))) entry = await this.adoptFolder(ref.path, ref.sig, unclaimed)
      next[id] = entry
      for (const [appName, info] of entry.apps) {
        if (found.has(appName)) continue
        if (!this.lastGames.some((g) => g.appName === appName)) continue // no longer owned
        found.set(appName, info)
      }
      if (entry.apps.length && !cache[id]) {
        const title = this.lastGames.find((g) => g.appName === entry.apps[0][0])?.title ?? entry.apps[0][0]
        console.info(`[epic] adopted ${title} from ${ref.path}${ref.pending ? ' (unfinished update pending)' : ''}`)
      }
    }
    await this.saveAdoptCache(next)
    return found
  }

  async relocateInstall(from: string, to: string): Promise<void> {
    await relocateEglRecords(from, to)
    const cache = await this.loadAdoptCache()
    for (const entry of Object.values(cache)) for (const [, info] of entry.apps) if (pathKey(info.path) === pathKey(from)) info.path = to
    await this.saveAdoptCache(cache)
  }

  private async adoptFolder(path: string, sig: string, unclaimed: ProviderGame[]): Promise<AdoptEntry> {
    const manifests = await readEgstoreManifests(path).catch(() => [])
    const apps: [string, InstalledInfo][] = []
    if (manifests.length) {
      const [base, ...extra] = manifests
      const m = base.manifest
      const game = matchFolder(unclaimed, m.buildVersion, basename(path), (g) => this.folderName(g))
      const gutted = !!m.launchExe && !existsSync(join(path, m.launchExe))
      if (game && !gutted) {
        const record = async (mf: typeof m, manifestId: string): Promise<InstalledInfo> => ({
          path,
          version: mf.buildVersion,
          executable: mf.launchExe,
          launchCommand: mf.launchCommand,
          platform: this.platform,
          sizeBytes: await installedSize(mf, path),
          source: 'epic-launcher',
          installedAt: Date.now(),
          manifestId
        })
        apps.push([game.appName, await record(m, base.file.replace(/\.manifest$/i, ''))])
        // DLC manifests carry the DLC's store app name.
        for (const d of extra) {
          const dlc = this.lastGames.find((g) => g.dlcOf === `epic:${game.appName}` && g.appName === d.manifest.appName)
          if (dlc) apps.push([dlc.appName, await record(d.manifest, d.file.replace(/\.manifest$/i, ''))])
        }
      }
    }
    return { sig, apps, at: Date.now() }
  }

  private adoptCacheFile(): string {
    return join(this.dir, 'adopted.json')
  }

  private async loadAdoptCache(): Promise<AdoptCache> {
    try {
      return JSON.parse(await readFile(this.adoptCacheFile(), 'utf8'))
    } catch {
      return {}
    }
  }

  private async saveAdoptCache(cache: AdoptCache): Promise<void> {
    await writeFile(this.adoptCacheFile(), JSON.stringify(cache)).catch(() => undefined)
  }

  private isDlc(appName: string): boolean {
    return this.lastGames.some((g) => g.appName === appName && !!g.dlcOf)
  }

  folderName(game: ProviderGame): string {
    const attr = this.catalog[game.catalogItemId]?.customAttributes?.FolderName?.value
    const name = attr || game.title || game.appName
    return name.replace(/[<>:"/\\|?*]/g, '').trim() || game.appName
  }

  private manifestFile(appName: string): string {
    return join(dataDir('manifests', 'epic'), `${createHash('sha256').update(appName).digest('hex')}.manifest`)
  }

  private async ownManifest(appName: string): Promise<Buffer | null> {
    const file = this.manifestFile(appName)
    await (await FsBoundary.create(dirname(file))).check(file)
    if (existsSync(file)) return readFile(file)
    // Migrate old safe leaf names without ever resolving an app identifier as a path.
    if (!/^[a-zA-Z0-9_.+-]{1,200}$/.test(appName)) return null
    const root = dataDir('manifests', 'epic')
    const legacy = join(root, `${appName}.manifest`)
    if (!existsSync(legacy)) return null
    const boundary = await FsBoundary.create(root)
    await boundary.check(legacy)
    const data = await readFile(legacy)
    if (parseManifest(data).appName !== appName) return null
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, data, { flag: 'wx' })
      renameSync(tmp, file)
      await rm(legacy, { force: true })
    } finally { await rm(tmp, { force: true }).catch(() => undefined) }
    return data
  }

  createInstallTask(game: ProviderGame, req: InstallRequest): InstallTask {
    return new EpicInstallTask(
      {
        api: this.api,
        platform: this.platform,
        maxWorkers: () => settings().maxWorkers,
        installPrerequisites: () => settings().installPrerequisites,
        loadInstalledManifest: async (install) => {
          const own = await this.ownManifest(game.appName)
          if (install.source === 'gamekins' && own) return own
          const egs = await readEgstoreManifest(install.path, { manifestId: install.manifestId, appName: game.appName })
          return egs ?? own
        },
        installedManifestPath: (appName) => this.manifestFile(appName),
        saveInstalledManifest: (appName, data) => writeFile(this.manifestFile(appName), data)
      },
      game,
      req
    )
  }

  async estimate(game: ProviderGame): Promise<{ downloadBytes: number; installBytes: number; version: string }> {
    const info = await this.api.manifestInfo(this.platform, game.namespace, game.catalogItemId, game.appName)
    const manifest = parseManifest((await downloadManifest(info)).data)
    let downloadBytes = 0
    for (const c of manifest.chunks.values()) downloadBytes += c.fileSize
    const installBytes = manifest.files.reduce((n, f) => n + f.size, 0)
    return { downloadBytes, installBytes, version: manifest.buildVersion }
  }

  private officialUri(game: ProviderGame, action: 'launch' | 'install'): string {
    const id = encodeURIComponent(`${game.namespace}:${game.catalogItemId}:${game.appName}`)
    return `com.epicgames.launcher://apps/${id}?action=${action}${action === 'launch' ? '&silent=true' : ''}`
  }

  async installViaOfficial(game: ProviderGame): Promise<void> {
    await shell.openExternal(this.officialUri(game, 'install'))
  }

  async launch(game: ProviderGame, install: InstalledInfo, opts: LaunchOptions): Promise<ChildProcess | null> {
    if (opts.viaOfficialLauncher || settings().launchViaEpicLauncher || game.thirdPartyManagedApp) {
      await shell.openExternal(this.officialUri(game, 'launch'))
      return null
    }

    const exe = join(install.path, install.executable)
    if (!install.executable || !existsSync(exe)) {
      throw new Error(`Can't find the game executable. Try "Verify & repair files".\n${exe}`)
    }

    const args = splitArgs(install.launchCommand)
    const s = this.session
    if (s) {
      let code: string | null = null
      try {
        code = await this.api.exchangeCode()
      } catch (err) {
        if (!game.canRunOffline) throw err
      }
      if (code) {
        args.push('-AUTH_LOGIN=unused', `-AUTH_PASSWORD=${code}`, '-AUTH_TYPE=exchangecode')
      }
      args.push(`-epicapp=${game.appName}`, '-epicenv=Prod')
      if (game.requiresOwnershipToken && code) {
        const token = await this.api.ownershipToken(s.account_id, game.namespace, game.catalogItemId)
        const ovt = join(dataDir('epic', 'ovt'), `${createHash('sha256').update(game.appName).digest('hex')}.ovt`)
        await (await FsBoundary.create(dirname(ovt))).check(ovt)
        await writeFile(ovt, token)
        args.push(`-epicovt=${ovt}`)
      }
      args.push(
        '-EpicPortal',
        `-epicusername=${s.displayName}`,
        `-epicuserid=${s.account_id}`,
        `-epiclocale=${app.getLocale().split('-')[0] || 'en'}`,
        `-epicsandboxid=${game.namespace}`
      )
    } else if (!game.canRunOffline) {
      throw new Error('Sign in to Epic Games to play this game.')
    }
    if (opts.extraArgs?.trim()) args.push(...splitArgs(opts.extraArgs))

    if (process.platform === 'darwin' && exe.endsWith('.app')) {
      return spawn('open', ['-W', '-a', exe, '--args', ...args], { detached: true, stdio: 'ignore' })
    }
    return spawn(exe, args, { cwd: dirname(exe), detached: true, stdio: 'ignore' })
  }

  private async exactInstalledManifest(appName: string, install: InstalledInfo): Promise<Buffer | null> {
    if (install.source === 'gamekins') {
      const data = await this.ownManifest(appName)
      if (data) {
        const m = parseManifest(data)
        if (m.appName === appName && m.buildVersion === install.version) return data
      }
    }
    return readEgstoreManifest(install.path, { manifestId: install.manifestId, appName, exact: true })
  }

  private async removeManifestFiles(game: ProviderGame, install: InstalledInfo, shared: { appName: string; install: InstalledInfo }[]): Promise<void> {
    const own = this.manifestFile(game.appName)
    const data = await this.exactInstalledManifest(game.appName, install)
    if (!data) throw new Error('No exact manifest match; refusing to delete shared installation files')
    const m = parseManifest(data)
    const boundary = await FsBoundary.create(install.path)
    const root = boundary.root
    const protectedFiles = new Set<string>()
    for (const record of shared) {
      const other = await this.exactInstalledManifest(record.appName, record.install)
      if (!other) throw new Error('Cannot establish shared file ownership; refusing deletion')
      for (const file of parseManifest(other).files) protectedFiles.add(pathKey(manifestTarget(root, file.filename)))
    }
    const files = m.files.map((f) => manifestTarget(root, f.filename)).filter((file) => !protectedFiles.has(pathKey(file)))
    for (const file of files) await boundary.check(file, true)
    const dirs = new Set<string>()
    for (const file of files) {
      await boundary.check(file, true)
      await rm(file, { force: true })
      for (let d = dirname(file); pathKey(d) !== pathKey(root); d = dirname(d)) dirs.add(d)
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      await boundary.check(dir)
      await rmdir(dir).catch(() => undefined)
    }
    if (install.manifestId) {
      const file = manifestTarget(root, '.egstore/' + install.manifestId + '.manifest')
      await boundary.check(file)
      await rm(file, { force: true })
    }
    await rm(own, { force: true })
  }

  discardPartial(installPath: string): Promise<void> {
    return discardPartial(installPath)
  }

  async uninstall(game: ProviderGame, install: InstalledInfo, shared: { appName: string; install: InstalledInfo }[] = []): Promise<void> {
    if (game.dlcOf || install.ownsFolder === false) {
      // DLC shares its game's folder, and "located" installs live in a folder the user chose:
      // remove only the files the game's manifest put there.
      await this.removeManifestFiles(game, install, shared)
      await removeEglRecord(game.appName)
      return
    }
    const boundary = await FsBoundary.create(install.path)
    await boundary.check(install.path)
    const target = realpathSync(install.path)
    const forbidden = [homedir(), resolve(settings().installDir), parse(target).root].map((p) => pathKey(existsSync(p) ? realpathSync(p) : resolve(p)))
    if (forbidden.includes(pathKey(target))) throw new Error(`Refusing to delete ${target}`)
    await rm(target, { recursive: true, force: true })
    await rm(this.manifestFile(game.appName), { force: true })
    await removeEglRecord(game.appName) // in case the Epic launcher also had a record of it
  }
}

interface FreePromoOffer {
  startDate: string
  endDate: string
  discountSetting?: { discountPercentage: number }
}

interface FreePromoResponse {
  data?: {
    Catalog?: {
      searchStore?: {
        elements: {
          title: string
          productSlug?: string | null
          urlSlug?: string
          catalogNs?: { mappings?: { pageSlug: string }[] | null }
          keyImages?: { type: string; url: string }[]
          promotions?: {
            promotionalOffers?: { promotionalOffers?: FreePromoOffer[] }[]
            upcomingPromotionalOffers?: { promotionalOffers?: FreePromoOffer[] }[]
          } | null
        }[]
      }
    }
  }
}

/** "++Fortnite+Release-42.30-CL-1-Windows" -> "++fortnite+" (the build branch, stable across versions). */
function branchOf(version?: string): string | null {
  const m = version && /^(\+\+[^+]+\+)/.exec(version)
  return m ? m[1].toLowerCase() : null
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Pick the owned game an orphaned install folder belongs to, by build branch and folder name. */
function matchFolder(
  games: ProviderGame[],
  buildVersion: string,
  folder: string,
  folderName: (g: ProviderGame) => string
): ProviderGame | undefined {
  const byName = (g: ProviderGame): boolean =>
    [folderName(g), g.title, g.appName].some((n) => norm(n) === norm(folder))
  const branch = branchOf(buildVersion)
  const sameBranch = branch ? games.filter((g) => branchOf(g.latestVersion) === branch) : []
  if (sameBranch.length === 1) return sameBranch[0]
  if (sameBranch.length > 1) return sameBranch.find(byName)
  return games.find(byName)
}

/** Bytes of the files from this manifest that are actually on disk (optional packs may be missing). */
async function installedSize(m: { files: { filename: string; size: number }[] }, dir: string): Promise<number> {
  let n = 0
  // Non-blocking and batched: thousands of stat calls must not freeze the main process.
  for (let i = 0; i < m.files.length; i += 64) {
    const batch = m.files.slice(i, i + 64)
    const ok = await Promise.all(batch.map((f) => access(join(dir, f.filename)).then(() => true, () => false)))
    batch.forEach((f, k) => ok[k] && (n += f.size))
  }
  return n
}

interface AdoptEntry {
  at?: number
  /** Signature of the folder's manifests when this was computed. */
  sig: string
  apps: [string, InstalledInfo][]
}
type AdoptCache = Record<string, AdoptEntry>
