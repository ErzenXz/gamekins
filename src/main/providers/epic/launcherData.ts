// Reads (and on uninstall, cleans up) the official Epic Games Launcher's install
// records so games it installed show up in Lodestar without re-downloading.

import { existsSync } from 'node:fs'
import { readdir, readFile, stat, unlink, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { InstalledInfo, Platform } from '@shared/types'
import { type Manifest, parseManifest } from './manifest'

interface EglItem {
  AppName: string
  DisplayName?: string
  InstallLocation: string
  LaunchExecutable: string
  LaunchCommand?: string
  AppVersionString: string
  InstallSize?: number
  InstallationGuid?: string
  ManifestLocation?: string
  bIsIncompleteInstall?: boolean
  MainGameAppName?: string
}

export function eglManifestDir(): string | null {
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    return join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  }
  return null
}

async function readItems(): Promise<{ file: string; item: EglItem }[]> {
  const dir = eglManifestDir()
  if (!dir || !existsSync(dir)) return []
  const out: { file: string; item: EglItem }[] = []
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.item')) continue
    const file = join(dir, name)
    try {
      out.push({ file, item: JSON.parse(await readFile(file, 'utf8')) })
    } catch {
      /* skip unreadable */
    }
  }
  return out
}

/** Installs the Epic launcher has records for (games and their DLC). */
export async function scanEglInstalls(platform: Platform): Promise<Map<string, InstalledInfo>> {
  const result = new Map<string, InstalledInfo>()
  for (const { file, item } of await readItems()) {
    if (item.bIsIncompleteInstall) continue
    if (!item.InstallLocation || !existsSync(item.InstallLocation)) continue
    const installedAt = (await stat(file).catch(() => null))?.mtimeMs ?? Date.now()
    result.set(item.AppName, {
      path: item.InstallLocation,
      version: item.AppVersionString,
      executable: item.LaunchExecutable,
      launchCommand: item.LaunchCommand ?? '',
      platform,
      sizeBytes: item.InstallSize ?? 0,
      source: 'epic-launcher',
      installedAt,
      manifestId: item.InstallationGuid,
      ownsFolder: !item.MainGameAppName || item.MainGameAppName === item.AppName
    })
  }
  return result
}

export interface EgstoreManifest {
  file: string
  manifest: Manifest
  data: Buffer
  size: number
}

/** Every build manifest the Epic launcher left in `<game>/.egstore` (base game + DLC). */
export async function readEgstoreManifests(installPath: string): Promise<EgstoreManifest[]> {
  const dir = join(installPath, '.egstore')
  if (!existsSync(dir)) return []
  const out: EgstoreManifest[] = []
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.manifest')) continue
    try {
      const data = await readFile(join(dir, name))
      const manifest = parseManifest(data)
      out.push({ file: name, manifest, data, size: manifest.files.reduce((n, f) => n + f.size, 0) })
    } catch {
      /* unreadable / foreign file */
    }
  }
  return out.sort((a, b) => b.size - a.size)
}

/**
 * The manifest describing what's on disk for one app. A game folder can hold several
 * (the game plus DLC), so prefer the launcher's exact record, then a manifest for this
 * app name (DLC manifests carry the store app name), then the biggest (the base game).
 */
export async function readEgstoreManifest(
  installPath: string,
  opts: { manifestId?: string; appName?: string; exact?: boolean } = {}
): Promise<Buffer | null> {
  const all = await readEgstoreManifests(installPath)
  if (!all.length) return null
  const byId = opts.manifestId && all.find((m) => m.file.toLowerCase() === `${opts.manifestId}.manifest`.toLowerCase())
  const byApp = opts.appName && all.find((m) => m.manifest.appName === opts.appName)
  return (byId || byApp || (opts.exact ? undefined : all[0]))?.data ?? null
}

export interface EgstoreFolder {
  path: string
  manifests: EgstoreManifest[]
  /** Epic left an unfinished update behind (`.egstore/Pending`). */
  pending: boolean
}

/**
 * Game folders that still carry Epic's install data (`.egstore/*.manifest`) even though
 * the launcher has no record of them — e.g. after reinstalling Windows or the launcher.
 */
export async function scanEgstoreFolders(roots: string[]): Promise<EgstoreFolder[]> {
  const out: EgstoreFolder[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const name of entries) {
      const path = join(root, name)
      const key = path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const manifests = await readEgstoreManifests(path).catch(() => [])
      if (!manifests.length) continue
      out.push({ path, manifests, pending: existsSync(join(path, '.egstore', 'Pending')) })
    }
  }
  return out
}

export interface EgstoreFolderRef {
  path: string
  /** Changes whenever any of the folder's Epic manifests change (name/size/mtime). */
  sig: string
  pending: boolean
}

/**
 * Cheap version of {@link scanEgstoreFolders}: only stats the manifests, so callers can
 * skip re-parsing folders that haven't changed since last time.
 */
export async function listEgstoreFolders(roots: string[]): Promise<EgstoreFolderRef[]> {
  const out: EgstoreFolderRef[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const entries = await readdir(root).catch(() => [] as string[])
    for (const name of entries) {
      const path = join(root, name)
      if (seen.has(path.toLowerCase())) continue
      seen.add(path.toLowerCase())
      const egs = join(path, '.egstore')
      const files = (await readdir(egs).catch(() => [] as string[])).filter((n) => n.endsWith('.manifest'))
      if (!files.length) continue
      const parts = await Promise.all(
        files.sort().map(async (n) => {
          const st = await stat(join(egs, n)).catch(() => null)
          return st ? `${n}:${st.size}:${Math.round(st.mtimeMs)}` : n
        })
      )
      out.push({ path, sig: parts.join('|'), pending: existsSync(join(egs, 'Pending')) })
    }
  }
  return out
}

export function defaultEpicRoots(): string[] {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [join(pf, 'Epic Games'), join(pf86, 'Epic Games')]
  }
  if (process.platform === 'darwin') return ['/Users/Shared/Epic Games', join(homedir(), 'Epic Games')]
  return []
}

/** Remove the Epic launcher's record so it doesn't show a ghost install. */
export async function removeEglRecord(appName: string): Promise<void> {
  for (const { file, item } of await readItems()) {
    if (item.AppName === appName) await unlink(file).catch(() => undefined)
  }
}

/** Keep adopted launcher's exact records in sync with a confirmed relocation. */
export async function relocateEglRecords(from: string, to: string): Promise<void> {
  const key = (p: string): string => process.platform === 'win32' ? p.toLowerCase() : p
  for (const { file, item } of await readItems()) {
    if (key(item.InstallLocation) !== key(from)) continue
    const tmp = file + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(tmp, JSON.stringify({ ...item, InstallLocation: to }), { flag: 'wx' })
      await rename(tmp, file)
    } finally { await unlink(tmp).catch(() => undefined) }
  }
}
