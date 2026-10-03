import type {
  Account,
  AppInfo,
  DownloadJob,
  DownloadKind,
  FreeGame,
  Game,
  GameDetails,
  GamePrefs,
  InstallPlan,
  LibraryProgress,
  ArtworkKind,
  LocalProgram,
  ProviderId,
  Settings,
  StorageDrive,
  Toast
} from './types'

/** The surface exposed to the renderer as `window.lodestar`. */
export interface LodestarApi {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    pickDirectory(defaultPath?: string): Promise<string | null>
    quit(): Promise<void>
    /** Pick files (e.g. a game executable or an image). */
    pickFiles(opts?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }): Promise<string[]>
    /** Programs installed on this PC (Start Menu / Applications), for "Add a non-Epic game". */
    listPrograms(): Promise<LocalProgram[]>
    /** Drives that hold games, with per-game sizes (Steam's storage manager). */
    storage(): Promise<StorageDrive[]>
  }
  accounts: {
    list(): Promise<Account[]>
    login(provider: ProviderId): Promise<Account>
    logout(provider: ProviderId): Promise<void>
  }
  library: {
    get(): Promise<Game[]>
    refresh(): Promise<Game[]>
    freeGames(): Promise<FreeGame[]>
  }
  games: {
    plan(key: string, baseDir?: string): Promise<InstallPlan>
    install(key: string, baseDir?: string): Promise<void>
    /** Adopt a copy of the game already sitting in `folder` (verifies and fills in missing files). */
    importFolder(key: string, folder: string): Promise<void>
    update(key: string): Promise<void>
    repair(key: string): Promise<void>
    uninstall(key: string): Promise<void>
    launch(key: string): Promise<void>
    stop(key: string): Promise<void>
    openFolder(key: string): Promise<void>
    setPrefs(key: string, patch: Partial<GamePrefs>): Promise<void>
    /** Move the install into `baseDir` (keeps its folder name). Resolves when done. */
    moveInstall(key: string, baseDir: string): Promise<void>
    /** Add any program as a library entry ("non-Epic game"). Returns the new keys. */
    addLocal(paths: string[]): Promise<string[]>
    /** Set (filePath) or reset (null) custom artwork. */
    setArtwork(key: string, kind: ArtworkKind, filePath: string | null): Promise<void>
    /** Put a desktop shortcut that launches the game through Lodestar. */
    createShortcut(key: string): Promise<void>
    /** Rich details (Steam store data, HowLongToBeat); cached for two weeks, `force` refetches. */
    details(key: string, force?: boolean): Promise<GameDetails | null>
  }
  downloads: {
    list(): Promise<DownloadJob[]>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    cancel(id: string): Promise<void>
    move(id: string, delta: number): Promise<void>
    clearFinished(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  on: {
    library(cb: (games: Game[]) => void): () => void
    libraryProgress(cb: (p: LibraryProgress) => void): () => void
    downloads(cb: (jobs: DownloadJob[]) => void): () => void
    accounts(cb: (accounts: Account[]) => void): () => void
    toast(cb: (toast: Toast) => void): () => void
    /** Main asks the UI to navigate somewhere (tray menu, launcher deep links from the store). */
    navigate(cb: (route: { view: string; gameKey?: string }) => void): () => void
  }
}

/** Channel names. Invoke channels are `${namespace}:${method}`. */
export const EVENTS = {
  library: 'evt:library',
  libraryProgress: 'evt:libraryProgress',
  downloads: 'evt:downloads',
  accounts: 'evt:accounts',
  toast: 'evt:toast',
  navigate: 'evt:navigate'
} as const
