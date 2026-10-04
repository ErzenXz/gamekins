// "Non-Epic games": any program on this PC, added to the library like Steam's
// "Add a Non-Steam Game". No downloads; Lodestar just launches and tracks it.

import { app, shell } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync }  from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { Account, InstalledInfo, LocalProgram, Platform } from '@shared/types'
import { splitArgs } from '../../core/args'
import { openPathChecked } from '../../core/external'
import { JsonStore } from '../../core/store'
import type { GameProvider, InstallTask, LaunchOptions, ProviderGame } from '../types'

interface LocalEntry {
  id: string
  title: string
  exe: string
  args: string
  workingDirectory?: string
  icon?: string
  addedAt: number
}

const store = new JsonStore<{ games: LocalEntry[] }>('local-games', { games: [] })

async function iconFor(path: string): Promise<string | undefined> {
  try {
    const img = await app.getFileIcon(path, { size: 'large' })
    return img.isEmpty() ? undefined : img.toDataURL()
  } catch {
    return undefined
  }
}

function prettyName(path: string): string {
  const base = basename(path, extname(path))
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || base
}

export class LocalProvider implements GameProvider {
  readonly id = 'local' as const
  readonly name = 'Other games'
  readonly platform: Platform = process.platform === 'darwin' ? 'Mac' : 'Windows'
  readonly alwaysOn = true

  async init(): Promise<void> {}

  /** Local games don't need an account; the library treats this provider as always on. */
  account(): Account | null {
    return null
  }

  async login(): Promise<Account> {
    throw new Error('Non-Epic games need no sign-in')
  }

  async logout(): Promise<void> {}

  private toGame(e: LocalEntry): ProviderGame {
    return {
      key: `local:${e.id}`,
      provider: 'local',
      appName: e.id,
      title: e.title,
      namespace: '',
      catalogItemId: '',
      description: e.exe,
      images: { thumb: e.icon },
      platforms: [this.platform],
      canRunOffline: true,
      requiresOwnershipToken: false
    }
  }

  async fetchLibrary(): Promise<ProviderGame[]> {
    return store.data.games.map((e) => this.toGame(e))
  }

  /** Every local game counts as installed while its program exists. */
  async scanExternalInstalls(): Promise<Map<string, InstalledInfo>> {
    const out = new Map<string, InstalledInfo>()
    for (const e of store.data.games) {
      if (!existsSync(e.exe)) continue
      out.set(e.id, {
        path: dirname(e.exe),
        version: '',
        executable: basename(e.exe),
        launchCommand: e.args,
        workingDirectory: e.workingDirectory,
        platform: this.platform,
        sizeBytes: 0,
        source: 'local',
        installedAt: e.addedAt
      })
    }
    return out
  }

  folderName(game: ProviderGame): string {
    return game.title
  }

  async add(paths: string[]): Promise<string[]> {
    const keys: string[] = []
    for (const p of paths) {
      let exe = p
      let args = ''
      let workingDirectory: string | undefined
      let title = prettyName(p)
      // Windows shortcuts: add what they point at.
      if (process.platform === 'win32' && extname(p).toLowerCase() === '.lnk') {
        try {
          const link = shell.readShortcutLink(p)
          exe = link.target
          args = link.args ?? ''
          workingDirectory = link.cwd || undefined
          title = basename(p, '.lnk')
        } catch {
          /* keep the .lnk itself */
        }
      }
      const keyOf = (path: string): string => {
        const canonical = existsSync(path) ? realpathSync(path) : path
        return process.platform === 'win32' ? canonical.toLowerCase() : canonical
      }
      const existing = store.data.games.find((g) => keyOf(g.exe) === keyOf(exe) && g.args === args)
      if (existing) { keys.push('local:' + existing.id); continue }
      const entry: LocalEntry = { workingDirectory, id: randomUUID().slice(0, 8), title, exe, args, icon: await iconFor(exe), addedAt: Date.now() }
      store.update((d) => d.games.push(entry))
      keys.push(`local:${entry.id}`)
    }
    return keys
  }

  createInstallTask(): InstallTask {
    throw new Error('Non-Epic games are installed outside Lodestar')
  }

  async estimate(): Promise<{ downloadBytes: number; installBytes: number; version: string }> {
    throw new Error('Non-Epic games are installed outside Lodestar')
  }

  async launch(game: ProviderGame, install: InstalledInfo, opts: LaunchOptions): Promise<ChildProcess | null> {
    const exe = join(install.path, install.executable)
    if (!existsSync(exe)) throw new Error(`Can't find ${exe}. It may have been moved or uninstalled.`)
    const clean = splitArgs([install.launchCommand, opts.extraArgs].filter(Boolean).join(' '))
    if (process.platform === 'darwin' && exe.endsWith('.app')) {
      return spawn('open', ['-W', '-a', exe, '--args', ...clean], { detached: true, stdio: 'ignore' })
    }
    const ext = extname(exe).toLowerCase()
    if (process.platform === 'win32' && !['.exe', '.bat', '.cmd'].includes(ext)) {
      // URLs, documents etc.: let Windows decide how to open them.
      await openPathChecked(exe)
      return null
    }
    return spawn(exe, clean, { cwd: install.workingDirectory || dirname(exe), detached: true, stdio: 'ignore', shell: ext === '.bat' || ext === '.cmd' })
  }

  /** "Uninstall" for a non-Epic game only removes it from the library; its files are not ours. */
  async uninstall(game: ProviderGame): Promise<void> {
    store.update((d) => {
      d.games = d.games.filter((g) => g.id !== game.appName)
    })
  }

  flush(): void {
    store.flush()
  }
}

/** Programs on this PC to offer in "Add a non-Epic game" (Start Menu shortcuts / Applications). */
export async function listPrograms(): Promise<LocalProgram[]> {
  const out = new Map<string, LocalProgram>()
  if (process.platform === 'win32') {
    const roots = [
      join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    ]
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3 || !existsSync(dir)) return
      for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) await walk(p, depth + 1)
        else if (ent.name.toLowerCase().endsWith('.lnk')) {
          try {
            const link = shell.readShortcutLink(p)
            const target = link.target
            if (!target || extname(target).toLowerCase() !== '.exe' || !existsSync(target)) continue
            if (/uninst|unins\d|setup|update|helper|crash|report|readme/i.test(basename(target))) continue
            // Windows' own tools (Character Map, Administrative Tools...) aren't games.
            if (target.toLowerCase().startsWith((process.env.SystemRoot || 'C:\\Windows').toLowerCase() + '\\')) continue
            const name = basename(p, '.lnk')
            const canonical = realpathSync(target).toLowerCase()
            const id = canonical + '\0' + (link.args ?? '')
            if (!out.has(id)) out.set(id, { name, path: target, shortcutPath: p, arguments: link.args ?? '', workingDirectory: link.cwd || undefined })
          } catch {
            /* unreadable shortcut */
          }
        }
      }
    }
    for (const r of roots) await walk(r, 0)
  } else if (process.platform === 'darwin') {
    for (const dir of ['/Applications', join(app.getPath('home'), 'Applications')]) {
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.endsWith('.app')) out.set(join(dir, name), { name: name.replace(/\.app$/, ''), path: join(dir, name) })
      }
    }
  }
  const list = [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  await Promise.all(list.map(async (p) => (p.icon = await iconFor(p.path))))
  return list
}
