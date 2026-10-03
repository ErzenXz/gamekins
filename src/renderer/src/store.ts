import { create } from 'zustand'
import type { Account, AppInfo, DownloadJob, FreeGame, Game, LibraryProgress, Settings, Toast } from '@shared/types'

export type Route =
  | { view: 'store'; url?: string }
  | { view: 'library'; gameKey?: string }
  | { view: 'downloads' }
  | { view: 'settings'; section?: string }

export type LibraryFilter = 'all' | 'installed' | 'updates' | 'favorites' | 'hidden'

/** Sort order of the library home grid. */
export type LibrarySort = 'alpha' | 'recent' | 'playtime' | 'size' | 'installed'

export interface Confirm {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

export interface ContextMenuState {
  x: number
  y: number
  gameKey: string
  /** Library UI: set (with gameKey '') for a collection's right-click menu instead of a game's. */
  collection?: string
}

/** Tabs of the per-game Properties dialog (library UI). */
export type PropertiesTab = 'general' | 'updates' | 'files' | 'dlc' | 'customization'

/** "New collection…" / "Rename collection…" prompt (library UI). */
export interface CollectionPrompt {
  mode: 'create' | 'rename'
  /** Rename: the current name. */
  name?: string
  /** Create: games to put in the new collection. */
  gameKeys?: string[]
}

/** Library main pane when no game is open: 'home' | 'collections' | `collection:<name>`. */
export type LibraryPage = 'home' | 'collections' | `collection:${string}`

interface State {
  route: Route
  back: Route[]
  forward: Route[]
  info: AppInfo | null
  games: Game[]
  jobs: DownloadJob[]
  accounts: Account[]
  settings: Settings | null
  freeGames: FreeGame[]
  libraryProgress: LibraryProgress
  refreshing: boolean
  toasts: (Toast & { id: number })[]
  /** Game whose install dialog is open. */
  installKey: string | null
  /** Game whose Properties dialog is open. */
  propertiesKey: string | null
  contextMenu: ContextMenuState | null
  confirm: Confirm | null
  search: string
  filter: LibraryFilter
  /** Library grid capsule width in px (Steam's zoom slider). */
  gridSize: number
  /** Library home grid sort order (persisted). */
  librarySort: LibrarySort

  // ── Library UI additions ──
  /** "Add a non-Epic game" dialog (mounted by the shell, driven by this flag). */
  addGameOpen: boolean
  setAddGameOpen(open: boolean): void
  /** Tab the Properties dialog should open on (consumed by the dialog). */
  propertiesTab: PropertiesTab | null
  openProperties(key: string, tab?: PropertiesTab): void
  /** Games whose launch is in flight (Play is disabled meanwhile). */
  launching: Record<string, boolean>
  setLaunching(key: string, on: boolean): void
  /** Games whose install folder is being moved. */
  moving: Record<string, boolean>
  setMoving(key: string, on: boolean): void
  collectionPrompt: CollectionPrompt | null
  setCollectionPrompt(p: CollectionPrompt | null): void
  /** Collections that exist but hold no games yet (persisted; the rest live in game prefs). */
  emptyCollections: string[]
  setEmptyCollections(names: string[]): void
  libraryPage: LibraryPage
  setLibraryPage(p: LibraryPage): void
  /** Left list "Recent" toggle: sort by recent activity, grouped by date. */
  sideRecent: boolean
  setSideRecent(on: boolean): void

  // ── Shell additions ──
  /** Last "open this URL in the store" request; `n` changes on every request, even for the same URL. */
  storeRequest: { url: string; n: number } | null
  /** The Epic session ended without the user signing out (expired / revoked). */
  sessionExpired: boolean
  /** A sign-in window is open (one at a time). */
  signingIn: boolean
  /** Open the provider's sign-in window (deduplicated; cancelling is not an error). */
  signIn(provider?: Account['provider']): Promise<void>
  /** Sign out (the caller confirms first). */
  signOut(provider: Account['provider']): Promise<void>
  /** Startup calls that failed (the app still renders; Retry re-runs them). */
  bootErrors: string[]
  /** Browser connectivity (navigator.onLine). */
  online: boolean
  /** Pause toast auto-dismiss while the pointer is over them. */
  holdToasts(on: boolean): void

  navigate(route: Route): void
  /** Swap the current route without adding a history entry (e.g. settings sub-pages). */
  replaceRoute(route: Route): void
  goBack(): void
  goForward(): void
  toast(t: Toast): void
  dismissToast(id: number): void
  setInstallKey(key: string | null): void
  setPropertiesKey(key: string | null): void
  setContextMenu(m: ContextMenuState | null): void
  setConfirm(c: Confirm | null): void
  setSearch(s: string): void
  setFilter(f: LibraryFilter): void
  setGridSize(px: number): void
  setLibrarySort(s: LibrarySort): void
  refresh(): Promise<void>
  saveSettings(patch: Partial<Settings>): Promise<void>
}

let toastId = 0
let storeNonce = 0
let loggingOut = false
let loginPromise: Promise<void> | null = null
/** Auto-dismiss timers per toast; paused (remaining kept) while the stack is hovered. */
const toastTimers = new Map<number, { timer?: number; remaining: number; started: number }>()
let toastsHeld = false
const same =(a: Route, b: Route): boolean => JSON.stringify(a) === JSON.stringify(b)

function readGridSize(): number {
  try {
    const v = Number(localStorage.getItem('lodestar.gridSize'))
    return v >= 110 && v <= 260 ? v : 160
  } catch {
    return 160
  }
}

function readSort(): LibrarySort {
  try {
    const v = localStorage.getItem('lodestar.librarySort')
    return v === 'recent' || v === 'playtime' || v === 'size' || v === 'installed' ? v : 'alpha'
  } catch {
    return 'alpha'
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}

export const useStore = create<State>((set, get) => ({
  route: { view: 'library' },
  back: [],
  forward: [],
  info: null,
  games: [],
  jobs: [],
  accounts: [],
  settings: null,
  freeGames: [],
  libraryProgress: { loading: false, done: 0, total: 0 },
  refreshing: false,
  toasts: [],
  installKey: null,
  propertiesKey: null,
  contextMenu: null,
  confirm: null,
  search: '',
  filter: 'all',
  gridSize: readGridSize(),
  librarySort: readSort(),
  addGameOpen: false,
  propertiesTab: null,
  launching: {},
  moving: {},
  collectionPrompt: null,
  emptyCollections: readJson<string[]>('lodestar.collections.empty', []),
  libraryPage: 'home',
  sideRecent: readJson<boolean>('lodestar.sidebar.recent', false),
  storeRequest: null,
  sessionExpired: false,
  signingIn: false,
  bootErrors: [],
  online: typeof navigator === 'undefined' ? true : navigator.onLine,

  signIn(provider = 'epic') {
    if (loginPromise) return loginPromise
    set({ signingIn: true })
    loginPromise = window.lodestar.accounts
      .login(provider)
      .then((acc) => {
        set({ sessionExpired: false })
        get().toast({ kind: 'success', message: `Signed in as ${acc.displayName}` })
      })
      .catch((err) => {
        const msg = errorMessage(err)
        // Closing the sign-in window is a choice, not a failure.
        if (/cancel|closed/i.test(msg)) get().toast({ kind: 'info', message: 'Sign-in was cancelled' })
        else get().toast({ kind: 'error', message: msg })
      })
      .finally(() => {
        loginPromise = null
        set({ signingIn: false })
      })
    return loginPromise
  },
  async signOut(provider) {
    loggingOut = true
    try {
      await window.lodestar.accounts.logout(provider)
      set({ sessionExpired: false })
    } catch (err) {
      get().toast({ kind: 'error', message: errorMessage(err) })
    } finally {
      // Grace period: the accounts event may land just after the IPC reply.
      setTimeout(() => (loggingOut = false), 1500)
    }
  },
  holdToasts(on) {
    if (toastsHeld === on) return
    toastsHeld = on
    const now = Date.now()
    for (const [id, t] of toastTimers) {
      if (on) {
        clearTimeout(t.timer)
        t.timer = undefined
        t.remaining = Math.max(800, t.remaining - (now - t.started))
      } else {
        t.started = now
        t.timer = window.setTimeout(() => get().dismissToast(id), t.remaining)
      }
    }
  },

  setAddGameOpen: (addGameOpen) => set({ addGameOpen, contextMenu: null }),
  openProperties: (key, tab) => set({ propertiesKey: key, propertiesTab: tab ?? null, contextMenu: null }),
  setLaunching(key, on) {
    const launching = { ...get().launching }
    if (on) launching[key] = true
    else delete launching[key]
    set({ launching })
  },
  setMoving(key, on) {
    const moving = { ...get().moving }
    if (on) moving[key] = true
    else delete moving[key]
    set({ moving })
  },
  setCollectionPrompt: (collectionPrompt) => set({ collectionPrompt, contextMenu: null }),
  setEmptyCollections(emptyCollections) {
    set({ emptyCollections })
    writeJson('lodestar.collections.empty', emptyCollections)
  },
  setLibraryPage: (libraryPage) => set({ libraryPage }),
  setSideRecent(sideRecent) {
    set({ sideRecent })
    writeJson('lodestar.sidebar.recent', sideRecent)
  },

  navigate(route) {
    const { route: cur, back } = get()
    // Every "open in store" request navigates, even to the URL already shown (it may have moved on).
    if (route.view === 'store' && route.url) set({ storeRequest: { url: route.url, n: ++storeNonce } })
    if (same(cur, route)) return
    set({ route, back: [...back.slice(-49), cur], forward: [], contextMenu: null })
  },
  replaceRoute(route) {
    if (!same(get().route, route)) set({ route, contextMenu: null })
  },
  goBack() {
    const { back, route, forward } = get()
    const prev = back.at(-1)
    if (prev) set({ route: prev, back: back.slice(0, -1), forward: [route, ...forward] })
  },
  goForward() {
    const { back, route, forward } = get()
    const next = forward[0]
    if (next) set({ route: next, back: [...back, route], forward: forward.slice(1) })
  },
  toast(t) {
    const id = ++toastId
    const toasts = get().toasts
    // Same message already showing (e.g. repeated errors): don't stack duplicates.
    if (toasts.some((x) => x.kind === t.kind && x.message === t.message)) return
    for (const old of toasts.slice(0, -3)) {
      clearTimeout(toastTimers.get(old.id)?.timer)
      toastTimers.delete(old.id)
    }
    set({ toasts: [...toasts.slice(-3), { ...t, id }] })
    const remaining = t.kind === 'error' ? 8000 : 5000
    toastTimers.set(id, {
      remaining,
      started: Date.now(),
      timer: toastsHeld ? undefined : window.setTimeout(() => get().dismissToast(id), remaining)
    })
  },
  dismissToast(id) {
    clearTimeout(toastTimers.get(id)?.timer)
    toastTimers.delete(id)
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
  setInstallKey: (installKey) => set({ installKey, contextMenu: null }),
  setPropertiesKey: (propertiesKey) => set({ propertiesKey, contextMenu: null }),
  setContextMenu: (contextMenu) => set({ contextMenu }),
  setConfirm: (confirm) => set({ confirm, contextMenu: null }),
  setSearch: (search) => set({ search }),
  setFilter: (filter) => set({ filter }),
  setGridSize(gridSize) {
    set({ gridSize })
    try {
      localStorage.setItem('lodestar.gridSize', String(gridSize))
    } catch {
      /* storage unavailable */
    }
  },
  setLibrarySort(librarySort) {
    set({ librarySort })
    try {
      localStorage.setItem('lodestar.librarySort', librarySort)
    } catch {
      /* storage unavailable */
    }
  },

  async refresh() {
    if (get().refreshing) return
    set({ refreshing: true })
    try {
      set({ games: await window.lodestar.library.refresh() })
    } catch (err) {
      get().toast({ kind: 'error', message: errorMessage(err) })
    } finally {
      set({ refreshing: false })
    }
  },
  async saveSettings(patch) {
    set({ settings: await window.lodestar.settings.set(patch) })
  }
}))

/** Strip Electron's "Error invoking remote method 'x': Error:" prefix. */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

/** Run an IPC action and surface failures as toasts. */
export async function act(fn: () => Promise<unknown>, success?: string): Promise<void> {
  try {
    await fn()
    if (success) useStore.getState().toast({ kind: 'success', message: success })
  } catch (err) {
    useStore.getState().toast({ kind: 'error', message: errorMessage(err) })
  }
}

let subscribed = false

/** Subscribe to main-process events once per page (StrictMode runs mount effects twice in dev). */
function subscribe(): void {
  if (subscribed) return
  subscribed = true
  const v = window.lodestar
  v.on.library((games) => useStore.setState({ games }))
  v.on.libraryProgress((libraryProgress) => useStore.setState({ libraryProgress }))
  v.on.downloads((jobs) => useStore.setState({ jobs }))
  v.on.accounts((accounts) => {
    const prev = useStore.getState().accounts
    // A provider vanished without the user signing out: its session expired.
    const lost = prev.some((a) => !accounts.some((b) => b.provider === a.provider))
    useStore.setState({
      accounts,
      sessionExpired: lost && !loggingOut ? true : accounts.length ? false : useStore.getState().sessionExpired
    })
  })
  v.on.toast((t) => useStore.getState().toast(t))
  v.on.navigate((r) => {
    const s = useStore.getState()
    if (r.view === 'game' && r.gameKey) s.navigate({ view: 'library', gameKey: r.gameKey })
    else if (r.view === 'store' || r.view === 'downloads' || r.view === 'settings') s.navigate({ view: r.view })
    else s.navigate({ view: 'library' })
  })
  window.addEventListener('online', () => useStore.setState({ online: true }))
  window.addEventListener('offline', () => useStore.setState({ online: false }))
}

let booting: Promise<void> | null = null

/**
 * Load the initial state. Every call is independent: whatever fails is reported in
 * `bootErrors` (the UI still renders with what it has) and can be retried.
 */
export function bootstrap(): Promise<void> {
  booting ??= load().finally(() => (booting = null))
  return booting
}

async function load(): Promise<void> {
  const v = window.lodestar
  subscribe()
  const s = useStore.getState()
  const parts = [
    ['app info', v.app.info()],
    ['library', v.library.get()],
    ['downloads', v.downloads.list()],
    ['accounts', v.accounts.list()],
    ['settings', v.settings.get()]
  ] as const
  const results = await Promise.allSettled(parts.map(([, p]) => p))
  const errors: string[] = []
  const ok = <T>(i: number, fallback: T): T => {
    const r = results[i]
    if (r.status === 'fulfilled') return r.value as T
    errors.push(`${parts[i][0]}: ${errorMessage(r.reason)}`)
    return fallback
  }
  const info = ok<AppInfo | null>(0, s.info)
  useStore.setState({
    info:
      info ??
      // Keep the shell usable even without app info.
      { version: '—', platform: /Mac/i.test(navigator.platform) ? 'darwin' : 'win32', providers: [] },
    games: ok(1, s.games),
    jobs: ok(2, s.jobs),
    accounts: ok(3, s.accounts),
    settings: ok(4, s.settings),
    bootErrors: errors
  })
  document.documentElement.dataset.platform = useStore.getState().info!.platform

  // Free games are a nice-to-have; never block startup on them.
  v.library
    .freeGames()
    .then((freeGames) => useStore.setState({ freeGames }))
    .catch(() => undefined)
}

/** The live download job for a game, if any. */
export function jobFor(jobs: DownloadJob[], key: string): DownloadJob | undefined {
  return jobs.find((j) => j.gameKey === key && !['done', 'cancelled'].includes(j.state))
}
