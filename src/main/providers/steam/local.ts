// What the Steam client has on this PC: where Steam lives, its library folders, the games
// installed in them (appmanifest_*.acf) and who is signed in to the client (loginusers.vdf).
// Read-only, and free of Electron so it can be tested and run from plain Node.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GameImages, InstalledInfo, Platform } from '@shared/types'
import type { ProviderGame } from '../types'
import { parseVdf, vdfObject, vdfString } from './vdf'

/**
 * `InstalledInfo.source` for games the Steam client put on disk. The library keeps these in
 * sync with the client and drops them when Steam no longer lists them.
 */
export const STEAM_INSTALL_SOURCE = 'steam' as const satisfies InstalledInfo['source']

/** Shown as "Managed by Steam": installs, updates and uninstalls go through the Steam client. */
export const STEAM_MANAGER = 'Steam'

/** Steam's own CDN for store/library art (no API key needed). */
const ART = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps'

export interface SteamAppManifest {
  appid: string
  name: string
  installdir: string
  sizeOnDisk: number
  buildid: string
  stateFlags: number
  /** Epoch seconds, 0 = never. */
  lastPlayed: number
  lastUpdated: number
  lastOwner?: string
  /** Library folder the manifest lives in (contains `steamapps`). */
  libraryPath: string
}

export interface SteamLibrary {
  path: string
  /** steamapps folder exists right now (false: drive disconnected or library removed). */
  reachable: boolean
}

export interface SteamLoginUser {
  steamId: string
  accountName?: string
  personaName?: string
  mostRecent: boolean
  /** Epoch seconds of the last sign-in. */
  timestamp: number
}

const STATE_FULLY_INSTALLED = 4

const num = (v: string | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

const pathKey = (p: string): string => {
  const r = resolve(p)
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
}

// ───────── finding Steam ─────────

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => (err ? fail(err) : ok(stdout)))
  })
}

/** Value of `name` from `reg query` output ("    SteamPath    REG_SZ    c:/program files (x86)/steam"). */
export function parseRegQuery(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line) ?? /^\s*(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line)
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[3].trim() || null
  }
  return null
}

async function regValue(key: string, name: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    return parseRegQuery(await run('reg', ['query', key, '/v', name]), name)
  } catch {
    return null
  }
}

/** The Steam install folder (contains steam.exe / steamapps), or null when Steam isn't installed. */
export async function findSteamRoot(): Promise<string | null> {
  const candidates: (string | null)[] = []
  if (process.platform === 'win32') {
    candidates.push(
      await regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      await regValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
      await regValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam')
    )
  } else if (process.platform === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Application Support', 'Steam'))
  } else {
    candidates.push(join(homedir(), '.steam', 'steam'), join(homedir(), '.local', 'share', 'Steam'), join(homedir(), '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'))
  }
  for (const c of candidates) {
    if (c && existsSync(join(c, 'steamapps'))) return resolve(c)
  }
  for (const c of candidates) if (c && existsSync(c)) return resolve(c)
  return null
}

/** The Steam client program (for `-applaunch`), or null. */
export async function findSteamExe(root: string | null): Promise<string | null> {
  if (process.platform === 'win32') {
    const reg = await regValue('HKCU\\Software\\Valve\\Steam', 'SteamExe')
    if (reg && existsSync(reg)) return resolve(reg)
    if (root && existsSync(join(root, 'steam.exe'))) return join(root, 'steam.exe')
    return null
  }
  if (process.platform === 'darwin') {
    for (const app of ['/Applications/Steam.app', join(homedir(), 'Applications', 'Steam.app')]) if (existsSync(app)) return app
  }
  if (process.platform === 'linux') {
    for (const exe of ['/usr/bin/steam', '/usr/local/bin/steam', ...(root ? [join(root, 'steam.sh')] : [])]) {
      if (existsSync(exe)) return exe
    }
  }
  return null
}

// ───────── library folders & manifests ─────────

/** Library folders from libraryfolders.vdf (new nested format and the old `"1" "D:\\Lib"` one). */
export function parseLibraryFolders(text: string, steamRoot?: string): string[] {
  const doc = parseVdf(text)
  const top = vdfObject(doc, 'libraryfolders') ?? vdfObject(doc, 'LibraryFolders') ?? {}
  const out: string[] = []
  const seen = new Set<string>()
  for (const [k, v] of Object.entries(top)) {
    if (!/^\d+$/.test(k)) continue // contentstatsid, TimeNextStatsReport...
    const p = typeof v === 'string' ? v : vdfString(v, 'path')
    if (!p || seen.has(pathKey(p))) continue
    seen.add(pathKey(p))
    out.push(p)
  }
  // The Steam folder is always a library (first), spelled as Steam itself writes it when listed.
  if (steamRoot) {
    const i = out.findIndex((p) => pathKey(p) === pathKey(steamRoot))
    out.unshift(i >= 0 ? out.splice(i, 1)[0] : steamRoot)
  }
  return out
}

/** One appmanifest_*.acf, or null if it isn't a usable app record. */
export function parseAppManifest(text: string, libraryPath: string): SteamAppManifest | null {
  const doc = parseVdf(text)
  const s = vdfObject(doc, 'AppState')
  if (!s) return null
  const appid = vdfString(s, 'appid')
  if (!appid || !/^\d+$/.test(appid)) return null
  const installdir = vdfString(s, 'installdir') ?? ''
  return {
    appid,
    name: vdfString(s, 'name') || installdir || `Steam app ${appid}`,
    installdir,
    sizeOnDisk: num(vdfString(s, 'SizeOnDisk')),
    buildid: vdfString(s, 'buildid') ?? '',
    stateFlags: num(vdfString(s, 'StateFlags')),
    lastPlayed: num(vdfString(s, 'LastPlayed')),
    lastUpdated: num(vdfString(s, 'LastUpdated')),
    lastOwner: vdfString(s, 'LastOwner'),
    libraryPath
  }
}

/** Steam runtime pieces and extras that aren't games (redistributables, Proton, soundtracks). */
export function isSteamTool(m: Pick<SteamAppManifest, 'appid' | 'name'>): boolean {
  return m.appid === '228980' || /redistributable|steamworks common|^proton\b|steam linux runtime|\bsoundtrack$/i.test(m.name)
}

/** Fully installed (bit 4), so a fresh download that's still in progress doesn't show as playable. */
export function isInstalled(m: SteamAppManifest): boolean {
  return (m.stateFlags & STATE_FULLY_INSTALLED) !== 0
}

export function installPath(m: Pick<SteamAppManifest, 'libraryPath' | 'installdir'>): string {
  return join(m.libraryPath, 'steamapps', 'common', m.installdir)
}

/** Read every library's manifests. Unreachable libraries are reported, not fatal. */
export async function scanSteamLibraries(root: string): Promise<{ libraries: SteamLibrary[]; apps: SteamAppManifest[] }> {
  let folders = [root]
  for (const file of [join(root, 'steamapps', 'libraryfolders.vdf'), join(root, 'config', 'libraryfolders.vdf')]) {
    try {
      folders = parseLibraryFolders(await readFile(file, 'utf8'), root)
      break
    } catch {
      /* missing or unreadable: try the next copy */
    }
  }
  const libraries: SteamLibrary[] = []
  const apps: SteamAppManifest[] = []
  const seen = new Set<string>()
  for (const lib of folders) {
    const dir = join(lib, 'steamapps')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      libraries.push({ path: lib, reachable: false })
      continue
    }
    libraries.push({ path: lib, reachable: true })
    for (const name of names) {
      if (!/^appmanifest_\d+\.acf$/i.test(name)) continue
      try {
        const m = parseAppManifest(await readFile(join(dir, name), 'utf8'), lib)
        if (!m || seen.has(m.appid) || isSteamTool(m) || !isInstalled(m)) continue
        seen.add(m.appid)
        apps.push(m)
      } catch {
        /* half-written or corrupt manifest: skip it this time */
      }
    }
  }
  return { libraries, apps }
}

// ───────── signed-in client user ─────────

export function parseLoginUsers(text: string): SteamLoginUser[] {
  const users = vdfObject(parseVdf(text), 'users') ?? {}
  const out: SteamLoginUser[] = []
  for (const [id, v] of Object.entries(users)) {
    if (!/^\d{17}$/.test(id) || typeof v !== 'object') continue
    out.push({
      steamId: id,
      accountName: vdfString(v, 'AccountName'),
      personaName: vdfString(v, 'PersonaName'),
      mostRecent: vdfString(v, 'MostRecent') === '1',
      timestamp: num(vdfString(v, 'Timestamp'))
    })
  }
  return out
}

/** The account most recently signed in to the Steam client ("MostRecent", else the latest timestamp). */
export function mostRecentUser(users: SteamLoginUser[]): SteamLoginUser | null {
  return users.find((u) => u.mostRecent) ?? [...users].sort((a, b) => b.timestamp - a.timestamp)[0] ?? null
}

export async function readClientUser(root: string): Promise<SteamLoginUser | null> {
  try {
    return mostRecentUser(parseLoginUsers(await readFile(join(root, 'config', 'loginusers.vdf'), 'utf8')))
  } catch {
    return null
  }
}

// ───────── mapping to Gamekins records ─────────

export function steamArt(appid: string): GameImages {
  const base = `${ART}/${appid}`
  return {
    tall: `${base}/library_600x900.jpg`,
    wide: `${base}/library_hero.jpg`,
    logo: `${base}/logo.png`,
    thumb: `${base}/header.jpg`
  }
}

export function storeUrl(appid: string): string {
  return `https://store.steampowered.com/app/${appid}/`
}

export function steamGame(appid: string, title: string, platforms: Platform[]): ProviderGame {
  return {
    key: `steam:${appid}`,
    provider: 'steam',
    appName: appid,
    title,
    namespace: '',
    catalogItemId: '',
    images: steamArt(appid),
    platforms,
    canRunOffline: true,
    requiresOwnershipToken: false,
    storeUrl: storeUrl(appid)
  }
}

export function manifestToGame(m: SteamAppManifest, platform: Platform): ProviderGame {
  return steamGame(m.appid, m.name, [platform])
}

export function manifestToInstall(m: SteamAppManifest, platform: Platform): InstalledInfo {
  return {
    path: installPath(m),
    version: m.buildid,
    // Steam starts the game; the library tracks whatever runs from the install folder.
    executable: '',
    launchCommand: '',
    platform,
    sizeBytes: m.sizeOnDisk,
    source: STEAM_INSTALL_SOURCE,
    installedAt: m.lastUpdated ? m.lastUpdated * 1000 : Date.now(),
    // Never ours to delete: uninstalling goes through the Steam client.
    ownsFolder: false
  }
}
