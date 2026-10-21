// Types shared between the main process, preload and renderer.

/** Every store/launcher we can talk to. Add new ids here as providers are written. */
export type ProviderId = 'epic' | 'steam' | 'gog' | 'local'
/** Stores with accounts (everything but local, non-store games). */
export type StoreId = Exclude<ProviderId, 'local'>

export type Platform = 'Windows' | 'Mac' | 'Linux'

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
  source: 'gamekins' | 'epic-launcher' | 'steam' | 'gog' | 'local'
  installedAt: number
  unavailable?: boolean
  workingDirectory?: string
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
  /** GPU rendering for the UI. Off saves memory and leaves graphics memory to games; applies after a restart. */
  hardwareAcceleration: boolean
  /** How friends see you: online, away, or appear offline. */
  friendsStatus: MyStatus
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
export interface CollectionEdit {
  operation: 'add' | 'remove' | 'rename' | 'delete'
  gameKeys: string[]
  name: string
  replacement?: string
}

export interface LocalProgram {
  shortcutPath?: string
  arguments?: string
  workingDirectory?: string
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

// ───────────── Rich game details (Steam store data + HowLongToBeat) ─────────────

export interface SteamInfo {
  appId: number
  url: string
  name: string
  shortDescription?: string
  about?: string
  genres: string[]
  /** Steam "categories": Single-player, Controller support, Achievements... */
  features: string[]
  developers: string[]
  publishers: string[]
  releaseDate?: string
  metacritic?: { score: number; url: string }
  /** Steam user reviews, e.g. "Very Positive", 10152 of 10731 positive. */
  reviews?: { summary: string; positive: number; total: number }
  screenshots: { thumb: string; full: string }[]
  trailers: { name: string; thumb: string }[]
  /** Steam library art (may 404 for some titles; fall back gracefully). */
  art: { hero?: string; logo?: string; cover?: string; header?: string }
  website?: string
  controllerSupport?: string
  requirements?: { minimum?: string; recommended?: string }
  achievements?: number
}

export interface HltbInfo {
  id: number
  url: string
  name: string
  mainHours?: number
  extraHours?: number
  completionistHours?: number
  allStylesHours?: number
  image?: string
  score?: number
}

export interface GameDetails {
  fetchedAt: number
  title: string
  steam?: SteamInfo
  hltb?: HltbInfo
}

// ───────────── Friends & chat (Epic social) ─────────────

export type PresenceStatus = 'online' | 'away' | 'offline'
/** What we show to friends; 'offline' means appear offline (no live presence either way). */
export type MyStatus = 'online' | 'away' | 'offline'

export interface Friend {
  /** Unique across stores: "${store}:${accountId}" once merged by the hub. */
  id: string
  /** Which store this friendship lives on (set by the hub). */
  provider?: StoreId
  /** The store's own account id (set by the hub). */
  accountId?: string
  displayName: string
  status: 'playing' | 'online' | 'away' | 'offline'
  /** "Playing Rocket League", "Battle Royale Lobby - 1 / 4"… */
  activity?: string
  /** Epic app/game they're in (from their presence resource), e.g. "Fortnite". */
  app?: string
  lastOnline?: number
  favorite?: boolean
  /** Epoch ms when the friendship started. */
  since?: number
}

export interface FriendRequest {
  /** "${store}:${accountId}" once merged by the hub. */
  id: string
  provider?: StoreId
  accountId?: string
  displayName: string
  direction: 'incoming' | 'outgoing'
  at?: number
}

export interface ChatMessage {
  id: string
  /** 'me' or the friend's account id. */
  from: string
  text: string
  at: number
}

/** One store's friends network, as shown in the panel's header and settings. */
export interface SocialNetwork {
  provider: StoreId
  name: string
  connection: 'off' | 'connecting' | 'online' | 'error'
  me?: { id: string; displayName: string }
  /** Messages can be sent from Gamekins (otherwise "Chat in <store>" opens its client). */
  canChat: boolean
  /** Friend requests by name can be sent from Gamekins. */
  canAddFriends: boolean
  error?: string
}

export interface SocialState {
  /** Signed in to a provider with friends. */
  available: boolean
  /** Every connected store's network (set by the hub). */
  networks?: SocialNetwork[]
  /** Live presence/chat connection. */
  connection: 'off' | 'connecting' | 'online' | 'error'
  me?: { id: string; displayName: string }
  myStatus: MyStatus
  friends: Friend[]
  requests: FriendRequest[]
  unread: Record<string, number>
  loading: boolean
  error?: string
}
