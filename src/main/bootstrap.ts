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
  session
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
import type { Account, ArtworkKind, CollectionEdit, GamePrefs, ProviderId, Settings, Toast } from '@shared/types'
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
import { localProvider, providerInfo, providers, provider } from './providers'

const epicProvider = provider('epic') as EpicProvider
import { listPrograms } from './providers/local'
import { EPIC_PARTITION, type EpicProvider } from './providers/epic'
import { useFetch } from './providers/epic/api'

const isMac = process.platform === 'darwin'
const STORE_HOSTS = ['epicgames.com', 'unrealengine.com', 'fab.com']
const REFRESH_EVERY_MS = 30 * 60_000
const startHidden = process.argv.includes('--hidden')
const STORE_CSS = `
  egs-navigation { display: none !important; }
  div:has(> egs-navigation), div:has(> div > egs-navigation) { height: 0 !important; min-height: 0 !important; }
  main#app-main-content > div:first-child:has(#global-search-input) { display: none !important; }
`

let win: BrowserWindow | null = null
const appUrl = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).href : pathToFileURL(join(__dirname, '../renderer/index.html')).href
let quitting = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const toast = (t: Toast): void => send(EVENTS.toast, t)

function accounts(): Account[] {
  return providers.map((p) => p.account()).filter((a): a is Account => !!a)
}

function showWindow(view?: string): void {
  if (!win || win.isDestroyed()) createWindow(true)
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (view) send(EVENTS.navigate, { view })
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
    backgroundColor: '#171d25',
    title: 'Gamekins',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#171d25', symbolColor: '#8b929a', height: 40 } }),
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
    }
  })
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
      prefs.partition = EPIC_PARTITION
      prefs.webSecurity = true
      params.partition = EPIC_PARTITION
      if (!isStoreUrl(params.src)) event.preventDefault()
    })

    if (contents.getType() !== 'webview') return
    contents.setUserAgent(contents.getUserAgent().replace(/ (Electron|gamekins)\/\S+/gi, ''))
    // Our own store bar replaces Epic's two header rows (and their "Download the launcher" button).
    contents.on('dom-ready', () => {
      if (isStoreUrl(contents.getURL()) && new URL(contents.getURL()).hostname === 'store.epicgames.com') void contents.insertCSS(STORE_CSS)
    })

    const intercept = (url: string): boolean => {
      if (url.startsWith('com.epicgames.launcher://')) {
        handleLauncherLink(url)
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
      if (intercept(url) || !isStoreUrl(url)) e.preventDefault()
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.on('will-frame-navigate', (e) => guard(e, e.url))
    contents.on('did-navigate-in-page', (_e, url) => {
      if (!isStoreUrl(url)) { contents.stop(); void contents.loadURL('https://store.epicgames.com').catch(console.warn) }
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (intercept(url)) return { action: 'deny' }
      // Epic opens checkout and some auth flows as popups; keep store pages in the view.
      if (isStoreUrl(url)) void contents.loadURL(url).catch((err) => console.warn('[store]', err))
      else void openExternalSafe(url).catch((err) => console.warn('[external]', err))
      return { action: 'deny' }
    })
  })
}

function isStoreUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'https:' && STORE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))
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
    return account
  })
  handle('accounts:logout', async (id: ProviderId) => {
    try { await provider(id).logout() }
    finally {
      library.forgetProvider(id)
      send(EVENTS.accounts, accounts())
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
    if (game.thirdPartyManagedApp && p.installViaOfficial) {
      // EA / Ubisoft titles are delivered by their own launcher; let the official client broker that.
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
  handle('games:update', (key: string) => {
    const info = library.installInfo(key)
    if (!info) throw new Error('Game is not installed')
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
    return settings()
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
      send(EVENTS.accounts, accounts())
      toast({ kind: 'error', message: 'Your Epic Games session expired. Sign in again to keep your library up to date.' })
    }

    library.on('changed', (games) => send(EVENTS.library, games))
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
    const epicSession = session.fromPartition(EPIC_PARTITION)
    epicSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    epicSession.setPermissionCheckHandler(() => false)
    guardWebviews()
    createWindow()
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
    library.flush()
    localProvider.flush()
    downloads.flush()
    settingsStore.flush()
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
}
