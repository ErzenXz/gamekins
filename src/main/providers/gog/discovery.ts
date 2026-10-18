// Finds GOG games installed by GOG Galaxy or GOG's offline installers:
// Windows: the GOG.com\Games registry keys plus `goggame-<id>.info` files in install folders;
// macOS: `goggame-<id>.info` inside app bundles in /Applications.
// Pure parsing lives here (no Electron) so it can be unit-tested offline.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { InstalledInfo, Platform } from '@shared/types'

/**
 * The `InstalledInfo.source` GOG installs use: the game is on disk because GOG Galaxy (or a
 * GOG offline installer) put it there, and the library drops the record once GOG no longer
 * reports it.
 */
export const GOG_INSTALL_SOURCE = 'gog' as const satisfies InstalledInfo['source']

export const REGISTRY_KEYS = ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 'HKLM\\SOFTWARE\\GOG.com\\Games']

export interface PlayTask {
  isPrimary?: boolean
  type?: string
  category?: string
  name?: string
  /** Relative to the folder containing the .info file (or absolute). */
  path?: string
  arguments?: string
  /** Relative to the folder containing the .info file (or absolute). */
  workingDir?: string
  link?: string
}

export interface GogInfo {
  gameId: string
  rootGameId?: string
  name?: string
  buildId?: string
  playTasks: PlayTask[]
}

/** Parse a `goggame-<id>.info` file; null when it isn't one. */
export function parseInfoFile(text: string): GogInfo | null {
  let json: unknown
  try {
    // Some installers write a UTF-8 BOM.
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const gameId = o.gameId != null ? String(o.gameId) : ''
  if (!/^\d{1,20}$/.test(gameId)) return null
  const rootGameId = o.rootGameId != null && /^\d{1,20}$/.test(String(o.rootGameId)) ? String(o.rootGameId) : undefined
  const tasks = Array.isArray(o.playTasks) ? (o.playTasks.filter((t) => t && typeof t === 'object') as PlayTask[]) : []
  return {
    gameId,
    rootGameId,
    name: typeof o.name === 'string' ? o.name : undefined,
    buildId: o.buildId != null ? String(o.buildId) : undefined,
    playTasks: tasks
  }
}

/** The task GOG Galaxy's Play button runs: the primary file task, else the first game file task. */
export function primaryTask(info: GogInfo): PlayTask | undefined {
  const files = info.playTasks.filter((t) => (t.type ?? 'FileTask') === 'FileTask' && typeof t.path === 'string' && t.path.trim())
  return files.find((t) => t.isPrimary) ?? files.find((t) => (t.category ?? 'game') === 'game') ?? files[0]
}

/** GOG paths use backslashes; normalise for this OS. */
const nativePath = (p: string): string => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/'))

/** Relative-to-root path for `InstalledInfo.executable` (library joins it with `path`). */
function relativeTo(root: string, base: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(base, nativePath(p))
  return relative(root, abs)
}

export interface InfoInstallOptions {
  /** Folder the game lives in (InstalledInfo.path). */
  root: string
  /** Folder containing the .info file (Windows: same as root; macOS: <bundle>/Contents/Resources). */
  infoDir?: string
  platform: Platform
  version?: string
  installedAt?: number
}

/** InstalledInfo for a game folder from its .info file; null without a launchable task. */
export function infoToInstalled(info: GogInfo, opts: InfoInstallOptions): InstalledInfo | null {
  const task = primaryTask(info)
  if (!task?.path) return null
  const base = opts.infoDir ?? opts.root
  const workingDirectory = task.workingDir?.trim()
    ? (isAbsolute(task.workingDir) ? task.workingDir : resolve(base, nativePath(task.workingDir)))
    : undefined
  return {
    path: opts.root,
    version: opts.version || info.buildId || '',
    executable: relativeTo(opts.root, base, task.path),
    launchCommand: task.arguments?.trim() ?? '',
    workingDirectory,
    platform: opts.platform,
    sizeBytes: 0,
    source: GOG_INSTALL_SOURCE,
    installedAt: opts.installedAt ?? Date.now()
  }
}

export interface RegistryGame {
  id: string
  /** Lower-cased value names → data. */
  values: Record<string, string>
}

/** Parse `reg query <GOG.com\Games> /s` output into one entry per game key. */
export function parseRegistry(stdout: string): Map<string, RegistryGame> {
  const out = new Map<string, RegistryGame>()
  let current: RegistryGame | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue
    if (/^HKEY_/i.test(raw)) {
      const m = /\\GOG\.com\\Games\\([^\\]+)\s*$/i.exec(raw)
      current = m ? { id: m[1], values: {} } : null
      if (current) out.set(current.id, current)
      continue
    }
    const v = /^\s+(.+?)\s{4}(REG_[A-Z0-9_]+)(?:\s{4}(.*))?$/.exec(raw)
    if (v && current) current.values[v[1].trim().toLowerCase()] = (v[3] ?? '').trim()
  }
  // The key name is normally the product id; fall back to the gameID value.
  for (const [key, game] of [...out]) {
    const id = /^\d{1,20}$/.test(key) ? key : game.values.gameid ?? game.values.productid
    out.delete(key)
    if (id && /^\d{1,20}$/.test(id)) out.set(id, { ...game, id })
  }
  return out
}

/** Base games only: DLC keys name the game they extend in `dependsOn`. */
export const isDlcEntry = (g: RegistryGame): boolean => !!g.values.dependson?.trim()

/** InstalledInfo from registry values alone (when the folder has no usable .info file). */
export function registryToInstalled(g: RegistryGame, installedAt = Date.now()): InstalledInfo | null {
  const root = g.values.path
  const exe = g.values.exe || (g.values.exefile && root ? join(root, g.values.exefile) : '')
  if (!root || !exe) return null
  return {
    path: root,
    version: g.values.ver || g.values.version || g.values.buildid || '',
    executable: relative(root, isAbsolute(exe) ? exe : join(root, exe)),
    launchCommand: g.values.launchparam ?? '',
    workingDirectory: g.values.workingdir || undefined,
    platform: 'Windows',
    sizeBytes: 0,
    source: GOG_INSTALL_SOURCE,
    installedAt
  }
}

// ───────── scanning (I/O) ─────────

/** Runs `reg query`; empty output when the key doesn't exist. */
export function queryRegistry(key: string, recursive = true): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('reg', ['query', key, ...(recursive ? ['/s'] : [])], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolvePromise(stdout)
      // reg.exe exits with 1 when the key doesn't exist (no GOG games installed). Its message is
      // localized, so the exit code is what we go by; failing to run reg at all still rejects.
      if ((err as { code?: unknown }).code === 1) return resolvePromise('')
      reject(Object.assign(err, { stderr: String(stderr).trim() }))
    })
  })
}

async function readInfo(dir: string, id?: string): Promise<GogInfo | null> {
  const names = id ? [`goggame-${id}.info`] : (await readdir(dir).catch(() => [] as string[])).filter((n) => /^goggame-\d+\.info$/i.test(n))
  const infos: GogInfo[] = []
  for (const name of names) {
    const info = parseInfoFile(await readFile(join(dir, name), 'utf8').catch(() => ''))
    if (info) infos.push(info)
  }
  // DLC ship their own .info files next to the game's; the base game's root id is its own id.
  return infos.find((i) => !i.rootGameId || i.rootGameId === i.gameId) ?? null
}

/** Where GOG Galaxy installs games (its configured library folder) plus the usual defaults. */
export async function defaultGogRoots(): Promise<string[]> {
  const roots = new Set<string>()
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    try {
      const cfg = JSON.parse(await readFile(join(programData, 'GOG.com', 'Galaxy', 'config.json'), 'utf8')) as { libraryPath?: unknown }
      if (typeof cfg.libraryPath === 'string' && cfg.libraryPath) roots.add(cfg.libraryPath)
    } catch { /* Galaxy not installed */ }
    roots.add(join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GOG Galaxy', 'Games'))
    roots.add('C:\\GOG Games')
  } else if (process.platform === 'darwin') {
    roots.add('/Applications')
    roots.add(join(homedir(), 'Applications'))
  }
  return [...roots]
}

/** Windows: registry entries, completed with each folder's .info, plus untracked folders under `roots`. */
export async function scanWindows(roots: string[]): Promise<Map<string, InstalledInfo>> {
  const found = new Map<string, InstalledInfo>()
  const registry = new Map<string, RegistryGame>()
  let failures = 0
  for (const key of REGISTRY_KEYS) {
    try {
      for (const [id, g] of parseRegistry(await queryRegistry(key))) if (!registry.has(id)) registry.set(id, g)
    } catch (err) {
      failures++
      console.warn(`[gog] registry query failed for ${key}`, err)
    }
  }
  // Never report "nothing installed" because the registry couldn't be read: the library would
  // forget every GOG install.
  if (failures === REGISTRY_KEYS.length) throw new Error('Could not read the GOG registry keys')

  for (const g of registry.values()) {
    if (isDlcEntry(g)) continue
    const root = g.values.path
    if (!root || !existsSync(root)) continue
    const info = await readInfo(root, g.id)
    const fromInfo = info ? infoToInstalled(info, { root, platform: 'Windows', version: g.values.ver }) : null
    const record = fromInfo ?? registryToInstalled(g)
    if (record) found.set(g.id, record)
  }

  // Folders without registry keys (portable copies, moved installs): one level below each root.
  const claimed = new Set([...found.values()].map((i) => resolve(i.path).toLowerCase()))
  for (const root of roots) {
    for (const ent of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!ent.isDirectory()) continue
      const dir = join(root, ent.name)
      if (claimed.has(resolve(dir).toLowerCase())) continue
      const info = await readInfo(dir)
      if (!info || found.has(info.gameId)) continue
      const record = infoToInstalled(info, { root: dir, platform: 'Windows' })
      if (record && existsSync(join(record.path, record.executable))) found.set(info.gameId, record)
    }
  }
  return found
}

/** macOS: GOG app bundles carry `Contents/Resources/goggame-<id>.info`. */
export async function scanMac(roots: string[]): Promise<Map<string, InstalledInfo>> {
  const found = new Map<string, InstalledInfo>()
  for (const root of roots) {
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!name.endsWith('.app') || name === 'GOG Galaxy.app') continue
      const bundle = join(root, name)
      const resources = join(bundle, 'Contents', 'Resources')
      const info = await readInfo(resources)
      if (!info || found.has(info.gameId)) continue
      const record = infoToInstalled(info, { root: bundle, infoDir: resources, platform: 'Mac' })
      // The bundle itself is what we open; keep the task's executable only when it exists.
      found.set(info.gameId, record && existsSync(join(record.path, record.executable)) ? record : {
        path: bundle, version: info.buildId ?? '', executable: '', launchCommand: record?.launchCommand ?? '',
        platform: 'Mac', sizeBytes: 0, source: GOG_INSTALL_SOURCE, installedAt: Date.now()
      })
    }
  }
  return found
}

/** GOG Galaxy's executable, if installed. */
export async function findGalaxyClient(): Promise<string | null> {
  if (process.platform === 'darwin') {
    const app = '/Applications/GOG Galaxy.app'
    return existsSync(app) ? app : null
  }
  if (process.platform !== 'win32') return null
  try {
    const out = await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient')
    const dir = /^\s+client\s{4}REG_SZ\s{4}(.+)$/im.exec(out)?.[1]?.trim()
    const exe = /^\s+clientExecutable\s{4}REG_SZ\s{4}(.+)$/im.exec(out)?.[1]?.trim() || 'GalaxyClient.exe'
    if (dir && existsSync(join(dir, exe))) return join(dir, exe)
  } catch { /* fall through to the default location */ }
  const fallback = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GOG Galaxy', 'GalaxyClient.exe')
  return existsSync(fallback) ? fallback : null
}
