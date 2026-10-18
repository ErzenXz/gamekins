import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  net,
  Notification,
  session,
  shell
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { moveInstall } from './core/moves'
import { recoverRelocations } from './core/relocations'
import { operations } from './core/operations'
import { openExternalSafe, openPathChecked } from './core/external'
import { validateSender, validateArguments } from './core/ipcValidation'
import { pathKey } from './providers/epic/fsBoundary'
import { EVENTS } from '@shared/api'
import type { Account, ArtworkKind, CollectionEdit, Game, GamePrefs, ProviderId, Settings, StoreId, Toast } from '@shared/types'
import { downloads, freeBytes } from './core/downloads'
import { library } from './core/library'
import { settings, settingsStore } from './core/settings'
import { initLog } from './core/log'
import { artworkFromFile, registerArtworkProtocol } from './core/artwork'
import { gameDetails } from './core/metadata'
import {
  createDesktopShortcut,
  parseLaunchUrl,
  PROTOCOL,
  registerProtocol,
  storageInfo
} from './core/extras'
import { createTray } from './core/tray'
import { gogProvider, localProvider, providerInfo, providers, provider, steamProvider } from './providers'
import { SteamSocial } from './providers/steam/social'
import { GogSocial } from './providers/gog/social'

const epicProvider = provider('epic') as EpicProvider
// One friends list across stores; each signed-in store contributes its network.
const social = new SocialHub()
social.register(new EpicSocial(() => epicProvider.socialAuth()))
social.register(new GogSocial(() => gogProvider.socialAuth()))
social.register(new SteamSocial((o) => steamProvider.socialAuth(o)))
import { listPrograms } from './providers/local'
import { EPIC_PARTITION, type EpicProvider } from './providers/epic'
import { useFetch } from './providers/epic/api'
import { EpicSocial } from './providers/epic/social'
import { SocialHub } from './core/socialHub'

const isMac = process.platform === 'darwin'
/** Stores whose own client installs, updates and uninstalls their games. */
const CLIENT_MANAGED = new Set<ProviderId>(['steam', 'gog'])
/**
 * Stores that can be browsed in the Store tab. Each lives in its own partition, shared with
 * that store's sign-in window, and may only navigate within its own domains.
 */
interface StoreSite {
  id: 'epic' | 'steam' | 'gog'
  partition: string
  hosts: string[]
  home: string
}
const STORE_SITES: StoreSite[] = [
  { id: 'epic', partition: EPIC_PARTITION, hosts: ['epicgames.com', 'unrealengine.com', 'fab.com'], home: 'https://store.epicgames.com' },
  { id: 'steam', partition: 'persist:steam', hosts: ['steampowered.com', 'steamcommunity.com'], home: 'https://store.steampowered.com' },
  { id: 'gog', partition: 'persist:gog', hosts: ['gog.com'], home: 'https://www.gog.com' }
]
const siteForPartition = (partition: string | undefined): StoreSite | undefined => STORE_SITES.find((s) => s.partition === partition)
const siteForContents = (contents: Electron.WebContents): StoreSite =>
  STORE_SITES.find((s) => session.fromPartition(s.partition) === contents.session) ?? STORE_SITES[0]
/** Steam store buttons ("Install", "Play") hand off to the Steam client; nothing else is allowed. */
const STEAM_LINK = /^steam:\/\/(install|run|rungameid|store)\/\d{1,10}\/?$/
const REFRESH_EVERY_MS = 30 * 60_000
// --hidden: launched at login; the window isn't even created until it's opened from the tray.
const launchedAtLogin = process.argv.includes('--hidden')
// Dev/test runs: create the window but keep it hidden (args can't be passed through electron-vite).
const startHidden = launchedAtLogin || process.env.GAMEKINS_START_HIDDEN === '1'
// A window hidden in the tray this long is destroyed, freeing its renderer, images and GPU
// surfaces; reopening rebuilds it in about half a second. Downloads and tracking live here.
const DISCARD_HIDDEN_MS = 60_000
const STORE_CSS = `
  egs-navigation { display: none !important; }
  div:has(> egs-navigation), div:has(> div > egs-navigation) { height: 0 !important; min-height: 0 !important; }
  main#app-main-content > div:first-child:has(#global-search-input) { display: none !important; }
  /* 2026 store layout: a sticky search + Discover/Browse/News row duplicates our toolbar. */
  body > nav[class*="_topNav_"] { display: none !important; }
  body > [class*="_mainView_"] { padding-top: 16px !important; }
`

let win: BrowserWindow | null = null
const appUrl = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).href : pathToFileURL(join(__dirname, '../renderer/index.html')).href
let quitting = false
let discardTimer: ReturnType<typeof setTimeout> | undefined

function discardWhenHidden(): void {
  clearTimeout(discardTimer)
  discardTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.destroy()
  }, DISCARD_HIDDEN_MS)
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const toast = (t: Toast): void => send(EVENTS.toast, t)

function accounts(): Account[] {
  return providers.map((p) => p.account()).filter((a): a is Account => !!a)
}

function showWindow(view?: string): void {
  clearTimeout(discardTimer)
  const fresh = !win || win.isDestroyed()
  if (fresh) createWindow(true)
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (!view) return
  // A window rebuilt from the tray has no listeners yet: send once its preload is running
  // (the preload keeps the event until React subscribes).
  if (fresh) win.webContents.once('did-finish-load', () => send(EVENTS.navigate, { view }))
  else send(EVENTS.navigate, { view })
}

function quit(): void {
  quitting = true
  app.quit()
}

function createWindow(show = !startHidden): void {
  nativeTheme.themeSource = 'dark'
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0d12',
    title: 'Gamekins',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 17 } }
      : { titleBarOverlay: { color: '#0a0d12', symbolColor: '#a9b3c1', height: 48 } }),
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      webviewTag: true,
      // No spellchecker: it loads dictionaries and runs on every input for no benefit here.
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => {
    if (show) win?.show()
  })
  // Steam behaviour: closing the window keeps Gamekins running in the tray.
  win.on('close', (e) => {
    if (!quitting && (settings().closeToTray || isMac)) {
      e.preventDefault()
      win?.hide()
      discardWhenHidden()
    }
  })
  win.on('show', () => clearTimeout(discardTimer))
  win.on('closed', () => (win = null))
  win.webContents.on('will-navigate', (e, url) => { if (url !== appUrl) e.preventDefault() })
  win.webContents.on('will-redirect', (e, url) => { if (url !== appUrl) e.preventDefault() })
  win.webContents.on('will-frame-navigate', (e) => { if (e.url !== appUrl) e.preventDefault() })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url).catch((err) => console.warn('[external]', err))
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Lock down the store <webview>: Epic domains only, no preload, shared Epic session. */
function guardWebviews(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event, prefs, params) => {
      delete prefs.preload
      prefs.nodeIntegration = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      prefs.spellcheck = false
      const site = siteForPartition(params.partition) ?? STORE_SITES[0]
      prefs.partition = site.partition
      prefs.webSecurity = true
      params.partition = site.partition
      if (!isStoreUrl(params.src, site)) event.preventDefault()
    })

    if (contents.getType() !== 'webview') return
    contents.setUserAgent(contents.getUserAgent().replace(/ (Electron|gamekins)\/\S+/gi, ''))
    // Our own store bar replaces Epic's two header rows (and their "Download the launcher" button).
    const site = siteForContents(contents)
    contents.on('dom-ready', () => {
      if (site.id === 'epic' && isStoreUrl(contents.getURL(), site) && new URL(contents.getURL()).hostname === 'store.epicgames.com') void contents.insertCSS(STORE_CSS)
      // Steam's 'Install Steam' button makes no sense inside a launcher that already talks to Steam.
      if (site.id === 'steam' && isStoreUrl(contents.getURL(), site)) void contents.insertCSS('.header_installsteam_btn { display: none !important; }')
    })

    const intercept = (url: string): boolean => {
      if (site.id === 'epic' && url.startsWith('com.epicgames.launcher://')) {
        handleLauncherLink(url)
        return true
      }
      if (site.id === 'steam' && url.startsWith('steam://')) {
        if (STEAM_LINK.test(url)) void confirmSteamLink(url)
        return true
      }
      return false
    }
    contents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
      const view = { '1': 'store', '2': 'library', '3': 'downloads', ',': 'settings' }[input.key]
      if (view) {
        e.preventDefault()
        send(EVENTS.navigate, { view })
      }
    })
    contents.on('context-menu', (_e, params) => {
      const items: MenuItemConstructorOptions[] = []
      if (params.linkURL) {
        items.push(
          { label: 'Open link in browser', click: () => void openExternalSafe(params.linkURL).catch((err) => console.warn('[external]', err)) },
          { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' }
        )
      }
      if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' })
      else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' })
      items.push(
        { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: 'Reload', click: () => contents.reload() },
        { type: 'separator' },
        { label: 'Copy page address', click: () => clipboard.writeText(contents.getURL()) },
        { label: 'Open page in browser', click: () => void openExternalSafe(contents.getURL()).catch((err) => console.warn('[external]', err)) }
      )
      Menu.buildFromTemplate(items).popup()
    })
    const guard = (e: Electron.Event, url: string): void => {
      if (intercept(url) || !isStoreUrl(url, site)) e.preventDefault()
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.on('will-frame-navigate', (e) => guard(e, e.url))
    contents.on('did-navigate-in-page', (_e, url) => {
      if (!isStoreUrl(url, site)) { contents.stop(); void contents.loadURL(site.home).catch(console.warn) }
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (intercept(url)) return { action: 'deny' }
      // Epic opens checkout and some auth flows as popups; keep store pages in the view.
      if (isStoreUrl(url, site)) void contents.loadURL(url).catch((err) => console.warn('[store]', err))
      else void openExternalSafe(url).catch((err) => console.warn('[external]', err))
      return { action: 'deny' }
    })
  })
}

/**
 * A Steam store page wants to hand off to the Steam client ("Install", "Play"). Page scripts,
 * redirects and frames can trigger navigations too, so the user always confirms first.
 */
let steamPrompt = false
async function confirmSteamLink(url: string): Promise<void> {
  if (steamPrompt || !win || win.isDestroyed()) return
  steamPrompt = true
  try {
    const [, action, appid] = url.match(/^steam:\/\/(\w+)\/(\d+)/) ?? []
    const verb = action === 'install' ? 'install' : action === 'store' ? 'open the store page for' : 'start'
    const title = library.listAll().find((g) => g.key === `steam:${appid}`)?.title ?? `app ${appid}`
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Open Steam', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Open in Steam',
      message: `Ask Steam to ${verb} ${title}?`,
      detail: 'The Steam store page asked to hand this over to the Steam app.'
    })
    if (response === 0) await shell.openExternal(url)
  } finally {
    steamPrompt = false
  }
}

function isStoreUrl(url: string, site: StoreSite = STORE_SITES[0]): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'https:' && site.hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/**
 * The web store tries to hand off to the official launcher via
 * com.epicgames.launcher://apps/<ns>:<id>:<appName>?action=install|launch — we catch those.
 */
function handleLauncherLink(url: string): void {
  let appName: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'com.epicgames.launcher:' || parsed.hostname !== 'apps' || !['install', 'launch'].includes(parsed.searchParams.get('action') ?? '')) return
    const ids = decodeURIComponent(parsed.pathname.slice(1)).split(':')
    if (ids.length !== 3 || ids.some((id) => !id || id.length > 1024 || /[\\/\0]/.test(id))) return
    appName = ids[2]
  } catch { return }
  const key = 'epic:' + appName
  void (async () => {
    if (!library.get(key)) await library.refresh().catch(() => undefined)
    const game = library.get(key)
    send(EVENTS.navigate, { view: 'game', gameKey: game ? (game.dlcOf ?? key) : undefined })
  })()
}

const RETRY_DELAYS = [20_000, 60_000, 180_000]
let retryTimer: NodeJS.Timeout | null = null

/** Refresh, and on failure keep retrying in the background (flaky Wi-Fi, VPNs, sleep/wake...). */
let pendingUrl: string | null = null

/** gamekins://launch/<key> from desktop shortcuts. */
function handleGamekinsUrl(url: string): void {
  const key = parseLaunchUrl(url)
  console.info(`[protocol] ${url} -> ${key ?? '(no game)'}`)
  if (!key) return showWindow()
  void library.launch(key).catch((err) => {
    showWindow()
    toast({ kind: 'error', message: (err as Error).message })
  })
}

async function refreshLibrary(attempt = 0): Promise<void> {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  try {
    await library.refresh()
    downloads.queueUpdates()
  } catch (err) {
    const delay = RETRY_DELAYS[attempt]
    if (attempt === 0 || delay === undefined) {
      const next = delay ? ` Retrying in ${delay / 1000}s.` : ''
      toast({ kind: 'error', message: `Couldn't refresh your library: ${(err as Error).message}${next}` })
    }
    if (delay !== undefined) retryTimer = setTimeout(() => void refreshLibrary(attempt + 1), delay)
  }
}

function applyLoginItem(): void {
  if (isMac || process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: settings().launchAtLogin, args: ['--hidden'] })
  }
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event, ...args) => {
    validateSender(event, win?.webContents, appUrl)
    validateArguments(channel, args)
    return fn(...(args as A))
  })
}

function registerIpc(): void {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, providers: providerInfo }))
  handle('app:openExternal', openExternalSafe)
  handle('app:pickDirectory', async (defaultPath?: string) => {
    const res = await dialog.showOpenDialog(win!, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('app:quit', quit)
  handle(
    'app:pickFiles',
    async (opts?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }) => {
      const res = await dialog.showOpenDialog(win!, {
        title: opts?.title,
        filters: opts?.filters,
        properties: ['openFile', ...(opts?.multi ? (['multiSelections'] as const) : [])]
      })
      return res.canceled ? [] : res.filePaths
    }
  )
  handle('app:listPrograms', () => listPrograms())
  handle('app:storage', () => storageInfo(settings().installDir))

  handle('accounts:list', accounts)
  handle('accounts:login', async (id: ProviderId) => {
    const account = await provider(id).login(win!)
    send(EVENTS.accounts, accounts())
    void refreshLibrary()
    if (id !== 'local') void social.start(id)
    return account
  })
  handle('accounts:logout', async (id: ProviderId) => {
    if (id !== 'local') social.stop(id)
    try { await provider(id).logout() }
    finally {
      library.forgetProvider(id)
      send(EVENTS.accounts, accounts())
      if (provider(id).alwaysOn) void refreshLibrary()
    }
  })

  handle('library:get', () => library.list())
  handle('library:refresh', async () => {
    await library.refresh()
    downloads.queueUpdates()
    return library.list()
  })
  handle('library:freeGames', async () => {
    const out = []
    for (const p of providers) if (p.freeGames) out.push(...(await p.freeGames().catch(() => [])))
    return out
  })

  handle('games:plan', async (key: string, baseDir?: string) => {
    const game = library.providerGame(key)
    if (!game) throw new Error('Unknown game')
    const installPath = downloads.installPathFor(key, baseDir)
    const est = await provider(game.provider).estimate(game)
    return {
      installPath,
      downloadBytes: est.downloadBytes,
      installBytes: est.installBytes,
      version: est.version,
      freeBytes: await freeBytes(installPath)
    }
  })
  handle('games:install', async (key: string, baseDir?: string) => {
    const game = library.providerGame(key)
    if (!game) throw new Error('Unknown game')
    const p = provider(game.provider)
    if ((game.thirdPartyManagedApp || CLIENT_MANAGED.has(game.provider)) && p.installViaOfficial) {
      // Steam / GOG games, and EA / Ubisoft titles, are delivered by their own client.
      const release = operations.acquire(key, 'install via official launcher')
      try { return await p.installViaOfficial(game) } finally { release() }
    }
    if (baseDir && !game.dlcOf) settingsStore.update((s) => (s.installDir = baseDir))
    downloads.enqueue(key, 'install', downloads.installPathFor(key, baseDir))
  })
  handle('games:importFolder', (key: string, folder: string) => {
    const game = library.providerGame(key)
    if (!game) throw new Error('Unknown game')
    if (library.installInfo(key)) throw new Error('This game is already installed')
    // A repair against an empty "existing" install hashes what's there and fetches the rest.
    downloads.enqueue(key, 'repair', folder)
  })
  handle('games:update', async (key: string) => {
    const info = library.installInfo(key)
    if (!info) throw new Error('Game is not installed')
    const game = library.providerGame(key)
    const p = game && provider(game.provider)
    if (game && p && CLIENT_MANAGED.has(game.provider)) {
      if (!p.installViaOfficial) throw new Error(`${p.name} keeps this game up to date`)
      return p.installViaOfficial(game)
    }
    downloads.enqueue(key, 'update', info.path)
  })
  handle('games:repair', (key: string) => {
    const info = library.installInfo(key)
    if (!info) throw new Error('Game is not installed')
    downloads.enqueue(key, 'repair', info.path)
  })
  handle('games:uninstall', async (key: string) => {
    const release = operations.acquire(key, 'uninstall')
    try {
    if (downloads.jobs.some((j) => ['queued', 'paused', 'preparing', 'verifying', 'downloading', 'finalizing'].includes(j.state) && operations.groupFor(j.parentKey ?? j.gameKey) === operations.groupFor(key))) throw new Error('Cancel the group downloads before uninstalling')
    const game = library.providerGame(key)
    const info = library.installInfo(key)
    if (game?.provider === 'local') {
      // "Uninstall" = remove from the library (works even if the program is already gone).
      if (library.isRunning(key)) throw new Error('Close the game before removing it')
      await localProvider.uninstall(game)
      return library.removeGame(key)
    }
    if (!game || !info) return
    if (CLIENT_MANAGED.has(game.provider)) {
      // Their client asks and removes the files; the next library scan drops the record.
      await provider(game.provider).uninstall(game, info)
      setTimeout(() => void refreshLibrary(), 15_000)
      return
    }
    await provider(game.provider).uninstall(game, info, library.listAll().filter((g) => g.key !== key && g.install && pathKey(g.install.path) === pathKey(info.path)).map((g) => ({ appName: g.appName, install: g.install! })))
    library.setInstalled(key, null)
    } finally { release() }
  })
  handle('games:addLocal', async (paths: string[]) => {
    const keys = await localProvider.add(paths)
    await library.refreshLocal()
    return keys
  })
  handle('games:setArtwork', async (key: string, kind: ArtworkKind, filePath: string | null) => {
    library.setArtwork(key, kind, filePath ? await artworkFromFile(filePath) : null)
  })
  handle('games:details', (key: string, force?: boolean) => {
    const game = library.providerGame(key)
    if (!game) return null
    return gameDetails(key, game.title, force === true)
  })
  handle('games:createShortcut', async (key: string) => {
    await createDesktopShortcut(key)
  })
  handle('games:launch', async (key: string) => {
    await library.launch(key)
    if (settings().minimizeOnLaunch) win?.minimize()
  })
  handle('games:stop', (key: string) => library.stop(key))
  handle('games:openFolder', (key: string) => {
    const info = library.installInfo(key)
    if (info) return openPathChecked(info.path)
  })
  handle('games:editCollections', (edit: CollectionEdit) => library.editCollections(edit))
  handle('games:setPrefs', (key: string, patch: Partial<GamePrefs>) => library.setPrefs(key, patch))
  handle('games:moveInstall', moveInstall)

  handle('downloads:list', () => downloads.jobs)
  handle('downloads:pause', (id: string) => downloads.pause(id))
  handle('downloads:resume', (id: string) => downloads.resume(id))
  handle('downloads:cancel', (id: string) => downloads.cancel(id))
  handle('downloads:move', (id: string, delta: number) => downloads.move(id, delta))
  handle('downloads:clearFinished', () => downloads.clearFinished())

  handle('settings:get', () => settings())
  handle('settings:set', (patch: Partial<Settings>) => {
    settingsStore.update((s) => Object.assign(s, patch))
    if (patch.autoUpdate) downloads.queueUpdates()
    if (patch.importEpicLauncherInstalls !== undefined) void refreshLibrary()
    if (patch.launchAtLogin !== undefined) applyLoginItem()
    if (patch.downloadsDuringGameplay !== undefined || patch.bandwidthLimitMBps !== undefined) downloads.kick()
    if (patch.friendsStatus) social.setStatus(patch.friendsStatus)
    return settings()
  })

  handle('social:state', () => social.state())
  handle('social:refresh', () => social.refresh())
  handle('social:chat', (friendId: string) => social.chat(friendId))
  handle('social:send', (friendId: string, text: string) => social.sendMessage(friendId, text))
  handle('social:add', (store: StoreId, displayName: string) => social.addFriend(store, displayName))
  handle('social:accept', (friendId: string) => social.accept(friendId))
  handle('social:remove', (friendId: string) => social.remove(friendId))
  handle('social:markRead', (friendId: string) => social.markRead(friendId))
  handle('social:openExternal', async (friendId: string, kind: 'chat' | 'profile') => {
    const url = social.externalLink(friendId, kind)
    if (!url) throw new Error('Not available for this friend')
    if (url.startsWith('steam://')) await shell.openExternal(url)
    else await openExternalSafe(url)
  })
}

{
  app.on('second-instance', (_e, argv) => {
    console.info('[app] second instance', JSON.stringify(argv.slice(1)))
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (url) handleGamekinsUrl(url)
    else showWindow()
  })
  // macOS delivers links this way.
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (app.isReady()) handleGamekinsUrl(url)
    else pendingUrl = url
  })

  app.whenReady().then(async () => {
    initLog()
    app.setAppUserModelId('com.gamekins.launcher')
    useFetch((input, init) => net.fetch(input as string, init))
    await Promise.all(providers.map((p) => p.init()))
    epicProvider.onSessionExpired = () => {
      social.stop('epic')
      send(EVENTS.accounts, accounts())
      toast({ kind: 'error', message: 'Your Epic Games session expired. Sign in again to keep your library up to date.' })
    }

    steamProvider.onSessionExpired = () => {
      social.stop('steam')
      send(EVENTS.accounts, accounts())
      toast({ kind: 'error', message: 'Your Steam sign-in expired. Sign in again to see all your Steam games and friends.' })
    }
    gogProvider.onSessionExpired = () => {
      social.stop('gog')
      send(EVENTS.accounts, accounts())
      toast({ kind: 'error', message: 'Your GOG session expired. Sign in again to keep your GOG library up to date.' })
    }

    library.on('changed', (games: Game[]) => {
      send(EVENTS.library, games)
      // Friends see what you're playing through Gamekins.
      social.setActivity(games.find((g) => g.running)?.title ?? null)
    })
    social.on('changed', (state) => send(EVENTS.social, state))
    social.on('message', (m) => {
      send(EVENTS.socialMessage, m)
      if (win && !win.isDestroyed() && win.isFocused()) return
      if (!Notification.isSupported()) return
      const name = social.state().friends.find((f) => f.id === m.friendId)?.displayName ?? 'A friend'
      const note = new Notification({ title: name, body: m.message.text.slice(0, 180), silent: false })
      note.on('click', () => showWindow('friends:' + m.friendId))
      note.show()
    })
    social.setStatus(settings().friendsStatus)
    for (const p of providers) if (p.id !== 'local' && p.account()) void social.start(p.id)
    library.on('progress', (p) => send(EVENTS.libraryProgress, p))
    downloads.on('changed', (jobs) => send(EVENTS.downloads, jobs))

    Menu.setApplicationMenu(
      isMac
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { role: 'windowMenu' }
          ])
        : null
    )
    registerArtworkProtocol()
    await library.migrateArtwork()
    await recoverRelocations()
    registerIpc()
    for (const site of STORE_SITES) {
      const storeSession = session.fromPartition(site.partition)
      storeSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      storeSession.setPermissionCheckHandler(() => false)
    }
    guardWebviews()
    if (!launchedAtLogin) createWindow()
    createTray({
      show: showWindow,
      quit,
      play: (key) =>
        void library.launch(key).catch((err) => {
          showWindow()
          toast({ kind: 'error', message: (err as Error).message })
        })
    })
    applyLoginItem()
    registerProtocol()

    await library.reconcileSessions().catch((err) => console.warn('[sessions] reconciliation failed; keeping group reservations', err))
    downloads.start()
    const startUrl = pendingUrl ?? process.argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (startUrl) handleGamekinsUrl(startUrl)
    void refreshLibrary()
    // Periodic refresh, but never while a game is running: stay out of the way while you play.
    setInterval(() => {
      if (!library.anyRunning()) void refreshLibrary()
    }, REFRESH_EVERY_MS)

    app.on('activate', () => showWindow())
  })

  app.on('before-quit', () => {
    quitting = true
    social.stopAll()
    library.flush()
    localProvider.flush()
    downloads.flush()
    settingsStore.flush()
  })

  app.on('window-all-closed', () => {
    // A window discarded in the tray (or never opened after a login launch) keeps the app running.
    if (isMac || (!quitting && settings().closeToTray)) return
    app.quit()
  })
}
