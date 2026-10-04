import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { library } from './library'
import { downloads } from './downloads'
import { operations } from './operations'
import { beginRelocation, finishRelocation } from './relocations'
import { provider } from '../providers'
import { FsBoundary, pathKey } from '../providers/epic/fsBoundary'

export async function moveInstall(key: string, baseDir: string): Promise<void> {
  const release = operations.acquire(key, 'move')
  let staging: string | undefined
  let journal: string | undefined
  try {
    const game = library.providerGame(key)
    const info = library.installInfo(key)
    if (game?.provider !== 'epic') throw new Error('Only Epic installations can be moved')
    if (!info || info.unavailable) throw new Error('Game is not available on disk')
    if (downloads.jobs.some((j) => ['queued', 'paused', 'preparing', 'verifying', 'downloading', 'finalizing'].includes(j.state) && operations.groupFor(j.parentKey ?? j.gameKey) === operations.groupFor(key))) throw new Error('Wait for group downloads to finish')
    const originalPath = info.path
    const source = await realpath(originalPath)
    await FsBoundary.create(info.path)
    const canonical = async (p: string): Promise<string> => {
      try { return await realpath(p) }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        if (dirname(p) === p) throw err
        return join(await canonical(dirname(p)), basename(p))
      }
    }
    const target = await canonical(join(baseDir, basename(info.path)))
    const contains = (a: string, b: string): boolean => {
      const rel = relative(pathKey(a), pathKey(b))
      return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
    }
    if (contains(source, target) || contains(target, source)) throw new Error('Move destination overlaps the source')
    if (existsSync(target)) throw new Error(target + ' already exists')
    await mkdir(dirname(target), { recursive: true })
    journal = await beginRelocation(key, originalPath, target)
    try {
      await rename(source, target)
      try {
        library.relocate(originalPath, target)
        await provider(game.provider).relocateInstall?.(originalPath, target)
      } catch (err) {
        await rename(target, source)
        library.relocate(target, originalPath)
        await finishRelocation(journal)
        journal = undefined
        throw err
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      staging = join(dirname(target), '.' + basename(target) + '.moving-' + randomUUID())
      await mkdir(staging)
      await cp(source, staging, { recursive: true, errorOnExist: true, force: false })
      await rename(staging, target)
      staging = undefined
      library.relocate(originalPath, target)
      await provider(game.provider).relocateInstall?.(originalPath, target)
      // The destination and durable records exist before the original is removed.
      await (await FsBoundary.create(source)).check(source)
      await rm(source, { recursive: true })
    }
    if (journal) await finishRelocation(journal)
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch((err) => console.warn('[move] staging cleanup failed', err))
    release()
  }
}
