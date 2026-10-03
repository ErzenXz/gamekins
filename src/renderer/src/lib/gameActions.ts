import type { ArtworkKind, DlcInfo, DownloadJob, Game } from '@shared/types'
import { act, errorMessage, useStore } from '../store'

export type PrimaryKind =
  | 'play'
  | 'stop'
  | 'install'
  | 'update'
  | 'pause'
  | 'resume'
  | 'retry'
  | 'unavailable'
  | 'launching'
  | 'moving'

export interface Primary {
  kind: PrimaryKind
  label: string
}

const OS_NAME: Record<string, string> = { win32: 'Windows', darwin: 'macOS' }

export function jobProgress(j: DownloadJob): number {
  if (j.state === 'verifying') return j.totalVerifyBytes ? j.verifiedBytes / j.totalVerifyBytes : 0
  if (j.state === 'done') return 1
  return j.totalWriteBytes ? Math.min(1, j.writtenBytes / j.totalWriteBytes) : 0
}

export function jobStatus(j: DownloadJob): string {
  const pct = `${Math.floor(jobProgress(j) * 100)}%`
  switch (j.state) {
    case 'queued':
      return 'Queued'
    case 'preparing':
      return 'Preparing…'
    case 'verifying':
      return `Verifying ${pct}`
    case 'downloading':
      return `${j.kind === 'update' ? 'Updating' : 'Downloading'} ${pct}`
    case 'finalizing':
      return 'Finishing up…'
    case 'paused':
      return `Paused ${pct}`
    case 'error':
      return 'Error'
    case 'done':
      return 'Complete'
    case 'cancelled':
      return 'Cancelled'
  }
}

/** Steam's left-list / play-bar wording: "Downloading", "Update Queued", "Update Paused"… */
export function jobPhrase(j: DownloadJob): string {
  const what = j.kind === 'update' ? 'Update' : j.kind === 'repair' ? 'Verification' : 'Download'
  switch (j.state) {
    case 'queued':
      return `${what} Queued`
    case 'paused':
      return `${what} Paused`
    case 'error':
      return `${what} Error`
    case 'verifying':
      return 'Verifying'
    case 'preparing':
      return 'Preparing'
    case 'finalizing':
      return 'Finishing'
    default:
      return j.kind === 'update' ? 'Updating' : j.kind === 'repair' ? 'Repairing' : 'Downloading'
  }
}

/** Games added from this PC ("non-Epic games"). */
export const isLocal = (g: Pick<Game, 'provider'>): boolean => g.provider === 'local'

/** Whether this game has a build for the OS we're running on. */
export function availableHere(game: Game, platform: string): boolean {
  if (isLocal(game) || game.thirdPartyManagedApp || !game.platforms.length) return true
  return game.platforms.includes(platform === 'darwin' ? 'Mac' : 'Windows')
}

/** Lodestar can download/repair this game's files itself (not local, not EA/Ubisoft-managed). */
export const managedByLodestar = (g: Game): boolean => !isLocal(g) && !g.thirdPartyManagedApp

export function canInstall(game: Game, job: DownloadJob | undefined, platform: string): boolean {
  return !game.install && !job && !isLocal(game) && availableHere(game, platform)
}

/** "Locate existing install…" makes sense for not-installed games Lodestar can manage on this OS. */
export function canLocate(game: Game, job: DownloadJob | undefined, platform: string): boolean {
  return canInstall(game, job, platform) && managedByLodestar(game)
}

/** Verify / update / move are only safe while nothing else touches the files. */
export function canModify(game: Game, job: DownloadJob | undefined): boolean {
  const s = useStore.getState()
  return !!game.install && !job && !game.running && !s.moving[game.key] && !s.launching[game.key]
}

export function canVerify(game: Game, job: DownloadJob | undefined): boolean {
  return canModify(game, job) && managedByLodestar(game)
}

export function primaryAction(
  game: Game,
  job: DownloadJob | undefined,
  platform: string,
  busy?: { launching?: boolean; moving?: boolean }
): Primary {
  if (game.running) return { kind: 'stop', label: 'Stop' }
  if (busy?.moving) return { kind: 'moving', label: 'Moving…' }
  if (busy?.launching) return { kind: 'launching', label: 'Launching' }
  if (job) {
    if (job.state === 'paused') return { kind: 'resume', label: 'Resume' }
    if (job.state === 'error') return { kind: 'retry', label: 'Retry' }
    return { kind: 'pause', label: 'Pause' }
  }
  if (game.install) {
    if (game.updateAvailable && !isLocal(game)) return { kind: 'update', label: 'Update' }
    return { kind: 'play', label: 'Play' }
  }
  if (!availableHere(game, platform)) {
    return { kind: 'unavailable', label: `Not on ${OS_NAME[platform] ?? platform}` }
  }
  return { kind: 'install', label: 'Install' }
}

/** Primary actions that can be fired from a quick button / double click / Enter. */
export const isQuickKind = (k: PrimaryKind): boolean => k === 'play' || k === 'install' || k === 'update'

export function runPrimary(game: Game, job: DownloadJob | undefined, kind: PrimaryKind): Promise<void> {
  const v = window.lodestar
  switch (kind) {
    case 'play':
      return launchGame(game)
    case 'stop':
      confirmStop(game)
      return Promise.resolve()
    case 'install':
      useStore.getState().setInstallKey(game.key)
      return Promise.resolve()
    case 'update':
      return act(() => v.games.update(game.key))
    case 'pause':
      return act(() => v.downloads.pause(job!.id))
    case 'resume':
    case 'retry':
      return act(() => v.downloads.resume(job!.id))
    default:
      return Promise.resolve()
  }
}

/**
 * Launch with a per-game "launching" flag so Play can't fire twice. The flag clears once the
 * library reports the game running, on failure, or after a timeout.
 */
export async function launchGame(game: Game): Promise<void> {
  const s = useStore.getState()
  if (s.launching[game.key] || s.moving[game.key]) return
  const current = s.games.find((g) => g.key === game.key)
  if (current?.running) return
  s.setLaunching(game.key, true)
  let settled = false
  let unsub = (): void => undefined
  let timer = 0
  const done = (): void => {
    if (settled) return
    settled = true
    unsub()
    clearTimeout(timer)
    useStore.getState().setLaunching(game.key, false)
  }
  try {
    await window.lodestar.games.launch(game.key)
  } catch (err) {
    done()
    useStore.getState().toast({ kind: 'error', message: errorMessage(err) })
    return
  }
  if (useStore.getState().games.find((g) => g.key === game.key)?.running) return done()
  let lastGames = useStore.getState().games
  unsub = useStore.subscribe((st) => {
    if (st.games === lastGames) return
    lastGames = st.games
    if (st.games.find((g) => g.key === game.key)?.running) done()
  })
  timer = window.setTimeout(done, 8000)
}

export function confirmStop(game: Game): void {
  useStore.getState().setConfirm({
    title: `Stop ${game.title}?`,
    message: 'Lodestar will close the game. Any progress that the game has not saved will be lost.',
    confirmLabel: 'Stop game',
    danger: true,
    onConfirm: () => act(() => window.lodestar.games.stop(game.key))
  })
}

export function confirmUninstall(game: Game): void {
  if (isLocal(game)) return confirmRemoveLocal(game)
  useStore.getState().setConfirm({
    title: `Uninstall ${game.title}?`,
    message: `This deletes all of the game's files from\n${game.install?.path}\n\nSaves stored in the cloud or in your user folder are not affected.`,
    confirmLabel: 'Uninstall',
    danger: true,
    onConfirm: () => act(() => window.lodestar.games.uninstall(game.key), `${game.title} was uninstalled`)
  })
}

/** Non-Epic games: "uninstall" only takes the entry out of the library. */
export function confirmRemoveLocal(game: Game): void {
  const s = useStore.getState()
  s.setConfirm({
    title: `Remove ${game.title}?`,
    message: `${game.title} will be removed from your Lodestar library.\n\nThe program itself stays on your PC:\n${game.install?.path ?? ''}`,
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: async () => {
      const st = useStore.getState()
      if (st.route.view === 'library' && st.route.gameKey === game.key) st.navigate({ view: 'library' })
      await act(() => window.lodestar.games.uninstall(game.key), `${game.title} was removed from your library`)
    }
  })
}

/** Cancelling deletes partial data for fresh installs, so always ask. */
export function confirmCancelJob(job: DownloadJob, title = job.title): void {
  const fresh = job.kind === 'install'
  useStore.getState().setConfirm({
    title: `Cancel ${fresh ? 'install' : job.kind} of ${title}?`,
    message: fresh
      ? 'The files downloaded so far will be deleted. You can install it again later.'
      : 'The download stops. Files already updated stay on disk.',
    confirmLabel: 'Cancel download',
    danger: true,
    onConfirm: () => act(() => window.lodestar.downloads.cancel(job.id))
  })
}

/** The game's store page, or an Epic store search when the catalog has no product slug. */
export function storeUrl(game: Pick<Game, 'title' | 'storeUrl'>): string {
  if (game.storeUrl) return game.storeUrl
  return `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(game.title)}&sortBy=relevancy&sortDir=DESC&count=40`
}

export const SUPPORT_URL = 'https://www.epicgames.com/help'

export function toggleFavorite(game: Game): Promise<void> {
  const favorite = !game.prefs.favorite
  return act(
    () => window.lodestar.games.setPrefs(game.key, { favorite }),
    favorite ? `Added ${game.title} to Favorites` : undefined
  )
}

export function toggleHidden(game: Game): Promise<void> {
  const hidden = !game.prefs.hidden
  return act(
    () => window.lodestar.games.setPrefs(game.key, { hidden }),
    hidden ? `${game.title} is now hidden` : `${game.title} is visible again`
  )
}

const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()

/** "Locate existing install…": adopt a copy of the game that's already on disk. */
export function locateInstall(game: Game): void {
  const s = useStore.getState()
  s.setContextMenu(null)
  const base = s.settings?.installDir
  s.setConfirm({
    title: `Locate ${game.title}`,
    message:
      `Select the folder that holds ${game.title} itself, not the folder that contains all your games.\n\n` +
      'Lodestar checks the files in that folder and downloads anything that is missing or damaged into it.',
    confirmLabel: 'Choose folder…',
    onConfirm: async () => {
      // Open the picker on where this game would normally live (installDir\<game folder>).
      let suggested = base
      try {
        const plan = await Promise.race([
          window.lodestar.games.plan(game.key, base),
          new Promise<null>((r) => setTimeout(() => r(null), 4000))
        ])
        if (plan) suggested = plan.installPath
      } catch {
        /* fall back to the install folder */
      }
      const dir = await window.lodestar.app.pickDirectory(suggested)
      if (!dir) return
      const n = norm(dir)
      if ((base && n === norm(base)) || /^[a-z]:$/.test(n) || n === '') {
        useStore.getState().toast({
          kind: 'error',
          message: `${dir} looks like a folder of games or a drive. Pick ${game.title}'s own folder instead.`
        })
        return
      }
      await act(() => window.lodestar.games.importFolder(game.key, dir), `Checking ${game.title} in ${dir}…`)
    }
  })
}

export function installDlc(dlc: DlcInfo): Promise<void> {
  return act(() => window.lodestar.games.install(dlc.key), `${dlc.title} was added to your downloads`)
}

export function confirmUninstallDlc(dlc: DlcInfo, game: Game): void {
  useStore.getState().setConfirm({
    title: `Uninstall ${dlc.title}?`,
    message: `This removes the DLC's files from ${game.title}. You still own it and can install it again at any time.`,
    confirmLabel: 'Uninstall',
    danger: true,
    onConfirm: () => act(() => window.lodestar.games.uninstall(dlc.key), `${dlc.title} was uninstalled`)
  })
}

/** The OS name the user is on, for "Not available on macOS" style messages. */
export function osName(platform: string): string {
  return OS_NAME[platform] ?? platform
}

export function createShortcut(game: Game): Promise<void> {
  return act(() => window.lodestar.games.createShortcut(game.key), `Added a desktop shortcut for ${game.title}`)
}

export const ARTWORK_LABELS: Record<ArtworkKind, string> = { tall: 'Cover', wide: 'Hero', logo: 'Logo' }

/** Pick an image and use it as this game's cover / hero / logo. */
export async function pickArtwork(game: Game, kind: ArtworkKind): Promise<void> {
  let files: string[]
  try {
    files = await window.lodestar.app.pickFiles({
      title: `Choose a ${ARTWORK_LABELS[kind].toLowerCase()} image for ${game.title}`,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
  } catch (err) {
    useStore.getState().toast({ kind: 'error', message: errorMessage(err) })
    return
  }
  if (!files[0]) return
  await act(() => window.lodestar.games.setArtwork(game.key, kind, files[0]), `${ARTWORK_LABELS[kind]} updated`)
}

export function resetArtwork(game: Game, kind: ArtworkKind): Promise<void> {
  return act(() => window.lodestar.games.setArtwork(game.key, kind, null), `${ARTWORK_LABELS[kind]} reset`)
}

// ───────── Collections (stored per game in prefs.collections) ─────────

const same = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0

/** Every user collection, A→Z: names found on games plus empty ones the user created. */
export function collectionNames(games: Game[], empty: string[]): string[] {
  const out: string[] = []
  const add = (n: string): void => {
    if (n && !out.some((x) => same(x, n))) out.push(n)
  }
  for (const g of games) for (const c of g.prefs.collections ?? []) add(c)
  for (const c of empty) add(c)
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
}

export const inCollection = (g: Game, name: string): boolean => (g.prefs.collections ?? []).some((c) => same(c, name))

/** Validate a new collection name; returns an error message or null. */
export function collectionNameError(name: string, existing: string[], current?: string): string | null {
  const n = name.trim()
  if (!n) return 'Enter a name.'
  if (n.length > 60) return 'Keep it under 60 characters.'
  if (same(n, 'Favorites') || same(n, 'Uncategorized') || same(n, 'All games')) return `“${n}” is a built-in section.`
  if (existing.some((x) => same(x, n) && !(current && same(current, x)))) return 'A collection with that name already exists.'
  return null
}

function gamesByKey(keys: string[]): Game[] {
  const all = useStore.getState().games
  return keys.map((k) => all.find((g) => g.key === k)).filter(Boolean) as Game[]
}

export async function addToCollection(keys: string[], name: string): Promise<void> {
  const games = gamesByKey(keys).filter((g) => !inCollection(g, name))
  await act(async () => {
    for (const g of games) {
      await window.lodestar.games.setPrefs(g.key, { collections: [...(g.prefs.collections ?? []), name] })
    }
  }, games.length === 1 ? `Added ${games[0].title} to ${name}` : `Added ${games.length} games to ${name}`)
  const s = useStore.getState()
  if (s.emptyCollections.some((c) => same(c, name))) s.setEmptyCollections(s.emptyCollections.filter((c) => !same(c, name)))
}

export async function removeFromCollection(keys: string[], name: string): Promise<void> {
  const games = gamesByKey(keys).filter((g) => inCollection(g, name))
  await act(async () => {
    for (const g of games) {
      await window.lodestar.games.setPrefs(g.key, { collections: (g.prefs.collections ?? []).filter((c) => !same(c, name)) })
    }
  }, games.length === 1 ? `Removed ${games[0].title} from ${name}` : undefined)
}

/** Create a collection, optionally with games in it. */
export async function createCollection(name: string, keys: string[] = []): Promise<void> {
  const n = name.trim()
  if (keys.length) return addToCollection(keys, n)
  const s = useStore.getState()
  s.setEmptyCollections([...s.emptyCollections, n])
  s.toast({ kind: 'success', message: `Created collection ${n}` })
}

export async function renameCollection(from: string, to: string): Promise<void> {
  const n = to.trim()
  const s = useStore.getState()
  const games = s.games.filter((g) => inCollection(g, from))
  await act(async () => {
    for (const g of games) {
      const list = (g.prefs.collections ?? []).filter((c) => !same(c, from))
      await window.lodestar.games.setPrefs(g.key, { collections: [...list, n] })
    }
  }, `Renamed ${from} to ${n}`)
  const st = useStore.getState()
  if (st.emptyCollections.some((c) => same(c, from))) {
    st.setEmptyCollections([...st.emptyCollections.filter((c) => !same(c, from)), ...(games.length ? [] : [n])])
  }
  if (st.libraryPage === `collection:${from}`) st.setLibraryPage(`collection:${n}`)
}

/** Deleting only removes the name from every game; the games stay in the library. */
export function confirmDeleteCollection(name: string): void {
  const s = useStore.getState()
  const count = s.games.filter((g) => inCollection(g, name)).length
  s.setConfirm({
    title: `Delete collection ${name}?`,
    message: count
      ? `${count === 1 ? 'The game in it stays' : `The ${count} games in it stay`} in your library; only the collection goes away.`
      : 'This collection is empty.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      const games = useStore.getState().games.filter((g) => inCollection(g, name))
      await act(async () => {
        for (const g of games) {
          await window.lodestar.games.setPrefs(g.key, {
            collections: (g.prefs.collections ?? []).filter((c) => !same(c, name))
          })
        }
      }, `Deleted collection ${name}`)
      const st = useStore.getState()
      st.setEmptyCollections(st.emptyCollections.filter((c) => !same(c, name)))
      if (st.libraryPage === `collection:${name}`) st.setLibraryPage('collections')
    }
  })
}

/** Open the game context menu under an element (keyboard: Shift+F10 / Menu key, or a ⋯ button). */
export function openMenuAt(el: Element, gameKey: string, alignRight = false): void {
  const r = el.getBoundingClientRect()
  useStore.getState().setContextMenu({ x: alignRight ? Math.max(6, r.right - 250) : r.left + 8, y: r.bottom + 4, gameKey })
}
