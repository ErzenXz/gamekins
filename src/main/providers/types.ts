import type { BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { Account, DownloadKind, FreeGame, Game, InstalledInfo, Platform, ProviderId } from '@shared/types'

/** What a provider knows about an owned game, before the library merges in local state. */
export type ProviderGame = Omit<
  Game,
  'install' | 'updateAvailable' | 'playtimeSeconds' | 'lastPlayed' | 'running' | 'prefs' | 'dlc'
>

export interface InstallProgress {
  downloadedBytes?: number
  writtenBytes?: number
  verifiedBytes?: number
  currentFile?: string
  phase?: 'verifying' | 'downloading' | 'finalizing'
  /** Totals can change once verification finds out what actually needs fetching. */
  totals?: Partial<InstallTotals>
}

export interface InstallTotals {
  installPath: string
  version: string
  totalDownloadBytes: number
  totalWriteBytes: number
  totalVerifyBytes: number
}

/**
 * A single install / update / repair. `prepare` resolves sizes so the queue can
 * show them; `run` does the work and must honour `signal` (pause & cancel abort it,
 * and running again later must resume where it left off).
 */
export interface InstallTask {
  prepare(signal: AbortSignal): Promise<InstallTotals>
  run(signal: AbortSignal, progress: (p: InstallProgress) => void): Promise<InstalledInfo>
}

export interface InstallRequest {
  kind: DownloadKind
  /** Folder the game will live in (already includes the game's own folder name). */
  installPath: string
  existing?: InstalledInfo
  /** Called with every downloaded byte count; resolves when we may continue (bandwidth limit). */
  throttle?: (bytes: number) => Promise<void>
}

export interface LaunchOptions {
  extraArgs?: string
  viaOfficialLauncher?: boolean
}

export interface GameProvider {
  readonly id: ProviderId
  readonly name: string
  readonly platform: Platform
  /** Provider works without an account (e.g. local, non-Epic games). */
  readonly alwaysOn?: boolean

  init(): Promise<void>
  account(): Account | null
  login(parent: BrowserWindow): Promise<Account>
  logout(): Promise<void>

  /** Owned games (and DLC, with `dlcOf` set) with metadata and their latest live version. */
  fetchLibrary(onProgress?: (done: number, total: number) => void): Promise<ProviderGame[]>
  /** Installs made by the provider's own launcher that we should adopt. */
  scanExternalInstalls(): Promise<Map<string, InstalledInfo>>
  /** Default folder name for a fresh install. */
  folderName(game: ProviderGame): string
  /** Promotional free games, if the store has such a thing. */
  freeGames?(): Promise<FreeGame[]>

  createInstallTask(game: ProviderGame, req: InstallRequest): InstallTask
  /** Size estimate shown in the install dialog. */
  estimate(game: ProviderGame): Promise<{ downloadBytes: number; installBytes: number; version: string }>
  /** Install through the provider's official client (games it can't hand to us, e.g. EA/Ubisoft titles). */
  installViaOfficial?(game: ProviderGame): Promise<void>
  launch(game: ProviderGame, install: InstalledInfo, opts: LaunchOptions): Promise<ChildProcess | null>
  /** Remove leftovers of a cancelled update/repair (temp files, resume logs). */
  discardPartial?(installPath: string): Promise<void>
  /** For DLC (`game.dlcOf`), removes only the DLC's own files. */
  uninstall(game: ProviderGame, install: InstalledInfo): Promise<void>
}
