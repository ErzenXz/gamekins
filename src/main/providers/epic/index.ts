import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import type { Account, FreeGame, InstalledInfo, Platform } from '@shared/types'
import { settings } from '../../core/settings'
import { dataDir } from '../../core/store'
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
  scanEglInstalls,
  scanEgstoreFolders
} from './launcherData'
import { parseManifest } from './manifest'

/** Session partition shared by the login window and the in-app store, so one login covers both. */
export const EPIC_PARTITION = 'persist:epic'

type CatalogCache = Record<string, CatalogItem>

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

/** Split a launch command the way a shell would (quotes group words). */
function splitArgs(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3])
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
    } catch {
      this.session = null
    }
    try {
      this.catalog = JSON.parse(await readFile(join(this.dir, 'catalog.json'), 'utf8'))
    } catch {
      this.catalog = {}
    }
  }

  private async saveSession(s: EpicSession | null): Promise<void> {
    this.session = s
    const file = join(this.dir, 'session.bin')
    if (!s) return rm(file, { force: true })
    const json = JSON.stringify(s)
    await writeFile(file, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json)
  }

  account(): Account | null {
    if (!this.session) return null
    return { provider: 'epic', id: this.session.account_id, displayName: this.session.displayName }
  }

  private async accessToken(): Promise<string> {
    const s = this.session
    if (!s) throw new Error('Not signed in to Epic Games')
    if (new Date(s.expires_at).getTime() - Date.now() > 10 * 60_000) return s.access_token
    if (new Date(s.refresh_expires_at).getTime() < Date.now()) return this.expire()
    this.refreshing ??= refreshSession(s.refresh_token)
      .then(async (next) => {
        await this.saveSession(next)
        return next
      })
      .catch(async (err) => {
        // Refresh token rejected (revoked, password changed...): the session is dead.
        if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 401) {
          await this.expire()
        }
        throw err
      })
      .finally(() => (this.refreshing = null))
    return (await this.refreshing).access_token
  }

  /** Called when the session dies so the UI can ask the user to sign in again. */
  onSessionExpired: (() => void) | null = null

  private async expire(): Promise<never> {
    await this.saveSession(null)
    this.onSessionExpired?.()
    throw new Error('Your Epic Games session expired. Please sign in again.')
  }

  login(parent: BrowserWindow): Promise<Account> {
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 520,
      height: 780,
      title: 'Sign in to Epic Games',
      autoHideMenuBar: true,
      backgroundColor: '#18181c',
      webPreferences: { partition: EPIC_PARTITION, sandbox: true, contextIsolation: true }
    })
    // Epic's login rejects obviously-embedded browsers; look like plain Chrome.
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ (Electron|lodestar)\/\S+/gi, ''))
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
          webPreferences: { partition: EPIC_PARTITION, sandbox: true, contextIsolation: true }
        }
      }
    })
    win.webContents.on('did-create-window', (child) =>
      child.webContents.setUserAgent(win.webContents.getUserAgent())
    )

    return new Promise((resolvePromise, reject) => {
      let settled = false
      const finish = (err: Error | null, account?: Account): void => {
        if (settled) return
        settled = true
        if (!win.isDestroyed()) win.close()
        if (err) reject(err)
        else resolvePromise(account!)
      }

      win.webContents.on('did-finish-load', async () => {
        if (!win.webContents.getURL().startsWith(LOGIN_REDIRECT_URL.split('?')[0])) return
        try {
          const text: string = await win.webContents.executeJavaScript('document.body.innerText')
          const { authorizationCode } = JSON.parse(text)
          if (!authorizationCode) {
            // Logged-in cookie without a fresh code: go back through the login page once.
            await win.loadURL(LOGIN_URL)
            return
          }
          const session = await exchangeAuthCode(authorizationCode)
          await this.saveSession(session)
          finish(null, this.account()!)
        } catch (err) {
          finish(err as Error)
        }
      })
      win.on('closed', () => finish(new Error('Sign-in was cancelled')))
      void win.loadURL(LOGIN_URL)
    })
  }

  async logout(): Promise<void> {
    const token = this.session?.access_token
    await this.saveSession(null)
    if (token) await killSession(token).catch(() => undefined)
  }

  async fetchLibrary(onProgress?: (done: number, total: number) => void): Promise<ProviderGame[]> {
    if (!this.session) return []
    const [records, assets] = await Promise.all([
      this.api.libraryItems(),
      this.api.assets(this.platform).catch(() => [])
    ])
    const latest = new Map(assets.map((a) => [a.appName, a.buildVersion]))

    const owned = new Map<string, (typeof records)[number]>()
    for (const r of records) {
      if (!r.appName || r.namespace === 'ue' || r.sandboxType === 'PRIVATE') continue
      owned.set(r.appName, r)
    }

    const missing = [...owned.values()].filter((r) => !this.catalog[r.catalogItemId])
    let done = 0
    onProgress?.(0, missing.length)
    await mapLimit(missing, 12, async (r) => {
      const item = await this.api.catalogItem(r.namespace, r.catalogItemId).catch(() => undefined)
      if (item) this.catalog[r.catalogItemId] = item
      onProgress?.(++done, missing.length)
    })
    if (missing.length) await writeFile(join(this.dir, 'catalog.json'), JSON.stringify(this.catalog))

    // catalogItemId -> appName, to attach DLC to the game they belong to.
    const appByItem = new Map([...owned.values()].map((r) => [r.catalogItemId, r.appName]))

    const games: ProviderGame[] = []
    for (const r of owned.values()) {
      const item = this.catalog[r.catalogItemId]
      if (!item) continue
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
    this.lastGames = games
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
    const roots = [...defaultEpicRoots(), settings().installDir]
    for (const folder of await scanEgstoreFolders(roots)) {
      if (claimed.has(resolve(folder.path).toLowerCase())) continue
      const [base, ...extra] = folder.manifests
      const m = base.manifest
      const game = matchFolder(unclaimed, m.buildVersion, basename(folder.path), (g) => this.folderName(g))
      if (!game || found.has(game.appName)) continue
      if (m.launchExe && !existsSync(join(folder.path, m.launchExe))) continue // gutted install
      const record = (mf: typeof m, manifestId: string): InstalledInfo => ({
        path: folder.path,
        version: mf.buildVersion,
        executable: mf.launchExe,
        launchCommand: mf.launchCommand,
        platform: this.platform,
        sizeBytes: installedSize(mf, folder.path),
        source: 'epic-launcher',
        installedAt: Date.now(),
        manifestId
      })
      found.set(game.appName, record(m, base.file.replace(/\.manifest$/i, '')))
      // DLC manifests carry the DLC's store app name.
      for (const d of extra) {
        const dlc = this.lastGames.find((g) => g.dlcOf === `epic:${game.appName}` && g.appName === d.manifest.appName)
        if (dlc && !found.has(dlc.appName)) found.set(dlc.appName, record(d.manifest, d.file.replace(/\.manifest$/i, '')))
      }
      console.info(`[epic] adopted ${game.title} from ${folder.path}${folder.pending ? ' (unfinished update pending)' : ''}`)
    }
    return found
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
    return join(dataDir('manifests', 'epic'), `${appName}.manifest`)
  }

  createInstallTask(game: ProviderGame, req: InstallRequest): InstallTask {
    return new EpicInstallTask(
      {
        api: this.api,
        platform: this.platform,
        maxWorkers: () => settings().maxWorkers,
        installPrerequisites: () => settings().installPrerequisites,
        loadInstalledManifest: async (install) => {
          const own = this.manifestFile(game.appName)
          if (install.source === 'lodestar' && existsSync(own)) return readFile(own)
          const egs = await readEgstoreManifest(install.path, { manifestId: install.manifestId, appName: game.appName })
          return egs ?? (existsSync(own) ? readFile(own) : null)
        },
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
        const ovt = join(dataDir('epic', 'ovt'), `${game.appName}.ovt`)
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

  private async removeManifestFiles(game: ProviderGame, install: InstalledInfo): Promise<void> {
    const own = this.manifestFile(game.appName)
    const data = existsSync(own)
      ? await readFile(own)
      : await readEgstoreManifest(install.path, { manifestId: install.manifestId, appName: game.appName })
    if (data) {
      const m = parseManifest(data)
      const root = resolve(install.path)
      const dirs = new Set<string>()
      for (const f of m.files) {
        const p = resolve(root, f.filename)
        if (!p.startsWith(root + sep)) continue
        await rm(p, { force: true }).catch(() => undefined)
        for (let d = dirname(p); d.startsWith(root + sep); d = dirname(d)) dirs.add(d)
      }
      // Tidy up folders the game's files leave empty (deepest first); rmdir refuses non-empty ones.
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(d).catch(() => undefined)
      if (install.manifestId) await rm(join(root, '.egstore', `${install.manifestId}.manifest`), { force: true })
      await rmdir(root).catch(() => undefined)
    }
    await rm(own, { force: true })
  }

  discardPartial(installPath: string): Promise<void> {
    return discardPartial(installPath)
  }

  async uninstall(game: ProviderGame, install: InstalledInfo): Promise<void> {
    if (game.dlcOf || install.ownsFolder === false) {
      // DLC shares its game's folder, and "located" installs live in a folder the user chose:
      // remove only the files the game's manifest put there.
      await this.removeManifestFiles(game, install)
      await removeEglRecord(game.appName)
      return
    }
    const target = resolve(install.path)
    const forbidden = [homedir(), resolve(settings().installDir), parse(target).root].map((p) => resolve(p))
    if (forbidden.includes(target)) throw new Error(`Refusing to delete ${target}`)
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
function installedSize(m: { files: { filename: string; size: number }[] }, dir: string): number {
  let n = 0
  for (const f of m.files) if (existsSync(join(dir, f.filename))) n += f.size
  return n
}
