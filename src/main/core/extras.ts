// Odds and ends behind Steam-style features: custom artwork, desktop shortcuts,
// the storage manager and the lodestar:// link protocol.

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { statfs, stat, realpath, writeFile } from 'node:fs/promises'
import { join, parse, resolve, dirname } from 'node:path'
import type { StorageDrive } from '@shared/types'
import { library } from './library'

export const PROTOCOL = 'lodestar'

export function launchUrl(key: string): string {
  return `${PROTOCOL}://launch/${encodeURIComponent(key)}`
}

/** "lodestar://launch/epic%3AFortnite" -> "epic:Fortnite" */
export function parseLaunchUrl(url: string): string | null {
  const m = /^lodestar:\/\/launch\/([^/?#]+)/i.exec(url)
  try { return m ? decodeURIComponent(m[1]) : null } catch { return null }
}

/** Make lodestar:// links open this app (dev runs need the script path too). */
export function registerProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }
}

/** Desktop shortcut that launches the game through Lodestar (works even when Lodestar is closed). */
export async function createDesktopShortcut(key: string): Promise<string> {
  const game = library.get(key)
  if (!game) throw new Error('Unknown game')
  const safe = game.title.replace(/[<>:"/\\|?*]/g, '').trim() || 'Game'
  const desktop = app.getPath('desktop')
  if (process.platform === 'darwin') {
    const file = join(desktop, `${safe}.webloc`)
    await writeFile(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${launchUrl(key)}</string></dict></plist>\n`
    )
    return file
  }
  const file = join(desktop, `${safe}.url`)
  const icon = game.install ? join(game.install.path, game.install.executable) : process.execPath
  await writeFile(file, `[InternetShortcut]\r\nURL=${launchUrl(key)}\r\nIconFile=${icon}\r\nIconIndex=0\r\n`)
  return file
}

/** Drives holding installed games (plus the default install drive), with per-game sizes. */
export async function storageInfo(installDir: string): Promise<StorageDrive[]> {
  const drives = new Map<string, StorageDrive>()
  const driveOf = async (p: string): Promise<string> => {
    if (process.platform === 'win32') return parse(resolve(p)).root.toUpperCase()
    let existing = resolve(p)
    const external = process.platform === 'darwin' && /^\/Volumes\/[^/]+/.exec(existing)?.[0]
    if (external && !existsSync(external)) return external
    for (;;) {
      try { await stat(existing); break }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        if (dirname(existing) === existing) return existing
        existing = dirname(existing)
      }
    }
    // macOS mounts are distinguished by device id, including external volumes and symlinks.
    let mount = await realpath(existing)
    const device = (await stat(mount)).dev
    while (dirname(mount) !== mount) {
      const parent = dirname(mount)
      if ((await stat(parent)).dev !== device) break
      mount = parent
    }
    return mount
  }
  const ensure = async (root: string): Promise<StorageDrive> => {
    let d = drives.get(root)
    if (!d) {
      let totalBytes = 0
      let freeBytes = 0
      try {
        const s = await statfs(root)
        totalBytes = s.blocks * s.bsize
        freeBytes = s.bavail * s.bsize
      } catch {
        /* drive gone */
      }
      d = { root, totalBytes, freeBytes, games: [] }
      drives.set(root, d)
    }
    return d
  }
  await ensure(await driveOf(installDir))
  for (const g of library.list()) {
    if (!g.install || g.provider === 'local') continue
    const dlcBytes = g.dlc.reduce((n, d) => n + (d.install?.sizeBytes ?? 0), 0)
    const d = await ensure(await driveOf(g.install.path))
    d.games.push({ key: g.key, title: g.title, path: g.install.path, sizeBytes: g.install.sizeBytes + dlcBytes })
  }
  for (const d of drives.values()) d.games.sort((a, b) => b.sizeBytes - a.sizeBytes)
  return [...drives.values()]
}
