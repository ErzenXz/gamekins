// Must stay first: moves user data from the old app name before any store opens its files.
import './migrate'
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
  shell
} from 'electron'
import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { EVENTS } from '@shared/api'
import type { Account, ArtworkKind, GamePrefs, ProviderId, Settings, Toast } from '@shared/types'
import { downloads, freeBytes } from './core/downloads'
import { library } from './core/library'
import { settings, settingsStore } from './core/settings'
import { initLog } from './core/log'
import {
  artworkFromFile,
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
/** Games whose files are being moved right now: nothing else may touch them. */
const moving = new Set<string>()

function assertIdle(key: string, action: string): void {
  const base = library.providerGame(key)?.dlcOf ?? key
  if (moving.has(base)) throw new Error(`Wait for the move to finish before you ${action}`)
  if (library.isRunning(base)) throw new Error(`Close the game before you ${action}`)
}
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
    title: 'Lodestar',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#171d25', symbolColor: '#8b929a', height: 40 } }),
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      webviewTag: true
    }
  })

  win.once('ready-to-show', () => {
    if (show) win?.show()
  })
  // Steam behaviour: closing the window keeps Lodestar running in the tray.
  win.on('close', (e) => {
    if (!quitting && (settings().closeToTray || isMac)) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
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
      params.partition = EPIC_PARTITION
      if (!isStoreUrl(params.src)) event.preventDefault()
    })

    if (contents.getType() !== 'webview') return
    contents.setUserAgent(contents.getUserAgent().replace(/ (Electron|lodestar)\/\S+/gi, ''))
    // Our own store bar replaces Epic's two header rows (and their "Download the launcher" button).
    contents.on('dom-ready', () => {
      if (new URL(contents.getURL()).hostname === 'store.epicgames.com') void contents.insertCSS(STORE_CSS)
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
          { label: 'Open link in browser', click: () => void shell.openExternal(params.linkURL) },
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
        { label: 'Open page in browser', click: () => void shell.openExternal(contents.getURL()) }
      )
      Menu.buildFromTemplate(items).popup()
    })
    contents.on('will-navigate', (e, url) => {
      if (intercept(url)) return e.preventDefault()
      if (!isStoreUrl(url)) {
        e.preventDefault()
        void shell.openExternal(url)
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (intercept(url)) return { action: 'deny' }
      // Epic opens checkout and some auth flows as popups; keep store pages in the view.
      if (isStoreUrl(url)) void contents.loadURL(url)
      else if (url.startsWith('https:')) void shell.openExternal(url)
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
  const m = /apps\/([^?]+)\?action=(\w+)/.exec(url)
  if (!m) {
    send(EVENTS.navigate, { view: 'library' })
    return
  }
  const appName = decodeURIComponent(m[1]).split(':').pop()!
  const key = `epic:${appName}`
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

/** lodestar://launch/<key> from desktop shortcuts. */
function handleLodestarUrl(url: string): void {
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
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))
}

function registerIpc(): void {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, providers: providerInfo }))
  handle('app:openExternal', (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  })
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
    await provider(id).logout()
    library.forgetProvider(id)
    send(EVENTS.accounts, accounts())
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
      return p.installViaOfficial(game)
    }
    if (game.dlcOf) assertIdle(key, 'install DLC')
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
    assertIdle(key, 'update it')
    const info = library.installInfo(key)
    if (!info) throw new Error('Game is not installed')
    downloads.enqueue(key, 'update', info.path)
  })
  handle('games:repair', (key: string) => {
    assertIdle(key, 'verify it')
    const info = library.installInfo(key)
    if (!info) throw new Error('Game is not installed')
    downloads.enqueue(key, 'repair', info.path)
  })
  handle('games:uninstall', async (key: string) => {
    const game = library.providerGame(key)
    const info = library.installInfo(key)
    if (game?.provider === 'local') {
      // "Uninstall" = remove from the library (works even if the program is already gone).
      if (library.isRunning(key)) throw new Error('Close the game before removing it')
      await localProvider.uninstall(game)
      return library.removeGame(key)
    }
    if (!game || !info) return
    assertIdle(key, 'uninstall it')
    for (const k of [key, ...library.listAll().filter((g) => g.dlcOf === key).map((g) => g.key)]) {
      const job = downloads.find(k)
      if (job) await downloads.cancel(job.id)
    }
    await provider(game.provider).uninstall(game, info)
    library.setInstalled(key, null)
  })
  handle('games:addLocal', async (paths: string[]) => {
    const keys = await localProvider.add(paths)
    await library.refreshLocal()
    return keys
  })
  handle('games:setArtwork', (key: string, kind: ArtworkKind, filePath: string | null) => {
    library.setArtwork(key, kind, filePath ? artworkFromFile(filePath, kind) : null)
  })
  handle('games:createShortcut', async (key: string) => {
    await createDesktopShortcut(key)
  })
  handle('games:launch', async (key: string) => {
    if (moving.has(key)) throw new Error('This game is being moved; try again when it finishes')
    await library.launch(key)
    if (settings().minimizeOnLaunch) win?.minimize()
  })
  handle('games:stop', (key: string) => library.stop(key))
  handle('games:openFolder', (key: string) => {
    const info = library.installInfo(key)
    if (info) return shell.openPath(info.path)
  })
  handle('games:setPrefs', (key: string, patch: Partial<GamePrefs>) => library.setPrefs(key, patch))
  handle('games:moveInstall', async (key: string, baseDir: string) => {
    const info = library.installInfo(key)
    if (!info) throw new Error('Game is not installed')
    assertIdle(key, 'move it')
    if (downloads.find(key)) throw new Error('Wait for the current download to finish first')
    const target = join(baseDir, basename(info.path))
    if (resolve(target) === resolve(info.path)) return
    if (existsSync(target)) throw new Error(`${target} already exists`)
    await mkdir(baseDir, { recursive: true })
    moving.add(key)
    try {
      try {
        await rename(info.path, target) // instant on the same drive
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        await cp(info.path, target, { recursive: true, errorOnExist: true, force: false })
        await rm(info.path, { recursive: true, force: true })
      }
      library.relocate(info.path, target)
    } finally {
      moving.delete(key)
    }
  })

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

// One instance only: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    console.info('[app] second instance', JSON.stringify(argv.slice(1)))
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (url) handleLodestarUrl(url)
    else showWindow()
  })
  // macOS delivers links this way.
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (app.isReady()) handleLodestarUrl(url)
    else pendingUrl = url
  })

  app.whenReady().then(async () => {
    initLog()
    app.setAppUserModelId('com.lodestar.launcher')
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
    registerIpc()
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

    downloads.start()
    const startUrl = pendingUrl ?? process.argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (startUrl) handleLodestarUrl(startUrl)
    void refreshLibrary()
    setInterval(() => void refreshLibrary(), REFRESH_EVERY_MS)

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
