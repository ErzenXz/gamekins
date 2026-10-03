// Types shared between the main process, preload and renderer.

/** Every store/launcher we can talk to. Add new ids here as providers are written. */
export type ProviderId = 'epic' | 'local'

export type Platform = 'Windows' | 'Mac'

export interface ProviderInfo {
  id: string
  name: string
  /** Whether the provider is implemented yet (false = "coming soon" placeholder). */
  available: boolean
}

export interface Account {
  provider: ProviderId
  id: string
  displayName: string
}

export interface GameImages {
  /** Portrait cover art (library grid capsules). */
  tall?: string
  /** Landscape art (hero banner). */
  wide?: string
  /** Transparent logo drawn over the hero. */
  logo?: string
  /** Small square-ish image for the sidebar list. */
  thumb?: string
}

export interface InstalledInfo {
  path: string
  version: string
  executable: string
  launchCommand: string
  platform: Platform
  sizeBytes: number
  /** Who put the game on disk. Imported installs are still fully managed by us. */
  source: 'lodestar' | 'epic-launcher' | 'local'
  installedAt: number
  prereqsInstalled?: boolean
  /** Epic launcher installation GUID (names its `.egstore/<id>.manifest`). */
  manifestId?: string
  /**
   * The folder belongs to the game (created by an installer), so uninstall may delete it
   * whole. False for "Locate existing install" folders: only the game's own files are removed.
   */
  ownsFolder?: boolean
}

/** Per-game user preferences (Properties dialog, favorites, hiding). */
export interface GamePrefs {
  favorite?: boolean
  hidden?: boolean
  /** Extra command line arguments appended on launch. */
  launchArgs?: string
  /** Launch this game through the official launcher instead of directly. */
  launchViaOfficial?: boolean
  /** false = never queue updates automatically for this game. */
  autoUpdate?: boolean
  /** User collections this game belongs to (Steam-style). */
  collections?: string[]
}

export interface DlcInfo {
  key: string
  appName: string
  title: string
  image?: string
  /** Has downloadable content (some DLC is just an entitlement unlocked in-game). */
  installable: boolean
  install?: InstalledInfo
  updateAvailable: boolean
}

export interface Game {
  /** Globally unique: `${provider}:${appName}` */
  key: string
  provider: ProviderId
  appName: string
  title: string
  namespace: string
  catalogItemId: string
  developer?: string
  description?: string
  images: GameImages
  platforms: Platform[]
  /** Latest live build for the current OS, if any. */
  latestVersion?: string
  /** e.g. "Origin" / "the EA app" / "Uplay" — the game is managed by another launcher. */
  thirdPartyManagedApp?: string
  canRunOffline: boolean
  requiresOwnershipToken: boolean
  /** The game's store page, when the catalog tells us its slug. */
  storeUrl?: string
  /** Set on DLC records: key of the game this DLC belongs to. */
  dlcOf?: string
  install?: InstalledInfo
  updateAvailable: boolean
  playtimeSeconds: number
  lastPlayed?: number
  prefs: GamePrefs
  dlc: DlcInfo[]
  /** Set by the library from the launcher, not persisted. */
  running?: boolean
}

export type DownloadKind = 'install' | 'update' | 'repair'

export type DownloadState =
  | 'queued'
  | 'preparing'
  | 'verifying'
  | 'downloading'
  | 'finalizing'
  | 'paused'
  | 'done'
  | 'error'
  | 'cancelled'

export interface DownloadJob {
  id: string
  gameKey: string
  title: string
  image?: string
  kind: DownloadKind
  state: DownloadState
  installPath: string
  /** Compressed bytes pulled from the CDN. */
  downloadedBytes: number
  totalDownloadBytes: number
  /** Uncompressed bytes written to disk. */
  writtenBytes: number
  totalWriteBytes: number
  /** Verification progress (bytes hashed) for update/repair. */
  verifiedBytes: number
  totalVerifyBytes: number
  speedBps: number
  diskBps: number
  /** Last ~60 samples, for the Steam-style graphs. */
  speedHistory: number[]
  diskHistory: number[]
  currentFile?: string
  /** Why a queued job isn't running (e.g. a game is being played). */
  waitingReason?: string
  error?: string
  addedAt: number
  finishedAt?: number
}

export interface InstallPlan {
  installPath: string
  downloadBytes: number
  installBytes: number
  freeBytes: number
  version: string
}

export interface Settings {
  installDir: string
  maxWorkers: number
  autoUpdate: boolean
  /** Launch through the official Epic launcher instead of directly (fallback for picky games). */
  launchViaEpicLauncher: boolean
  importEpicLauncherInstalls: boolean
  installPrerequisites: boolean
  minimizeOnLaunch: boolean
  /** 0 = unlimited. */
  bandwidthLimitMBps: number
  downloadsDuringGameplay: boolean
  closeToTray: boolean
  launchAtLogin: boolean
}

export interface FreeGame {
  title: string
  image?: string
  url: string
  startDate: string
  endDate: string
  /** true = free right now, false = upcoming. */
  current: boolean
}

export interface LibraryProgress {
  loading: boolean
  done: number
  total: number
  /** Set when the last refresh failed (we keep showing cached games and retry). */
  error?: string
}

/** A program found on this PC, offered in "Add a non-Epic game". */
export interface LocalProgram {
  name: string
  path: string
  /** data: URL of the program icon. */
  icon?: string
}

export type ArtworkKind = 'tall' | 'wide' | 'logo'

export interface StorageGame {
  key: string
  title: string
  path: string
  sizeBytes: number
}

/** One drive in the storage manager. */
export interface StorageDrive {
  root: string
  totalBytes: number
  freeBytes: number
  games: StorageGame[]
}

export interface AppInfo {
  version: string
  platform: string
  providers: ProviderInfo[]
}

export type Toast = { kind: 'info' | 'success' | 'error'; message: string }
