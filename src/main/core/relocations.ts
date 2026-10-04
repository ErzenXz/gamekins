import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, rename, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from './store'
import { library } from './library'
import { provider } from '../providers'
import { FsBoundary, pathKey } from '../providers/epic/fsBoundary'
import { fields, path, text } from './validation'

/** Written before promotion; recovery never removes either complete game copy. */
export async function beginRelocation(key: string, from: string, to: string): Promise<string> {
  const file = join(dataDir('relocations'), `${randomUUID()}.json`)
  const tmp = `${file}.tmp`
  const handle = await open(tmp, 'wx')
  try { await handle.writeFile(JSON.stringify({ key, from, to })); await handle.sync() }
  finally { await handle.close() }
  await rename(tmp, file)
  return file
}

export async function finishRelocation(file: string): Promise<void> {
  await rm(file, { force: true })
}

export async function recoverRelocations(): Promise<void> {
  const root = dataDir('relocations')
  const boundary = await FsBoundary.create(root)
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
    const file = join(root, name)
    try {
      await boundary.check(file)
      const record = JSON.parse(await readFile(file, 'utf8')) as { key: string; from: string; to: string }
      if (!fields(record, { key: text, from: path, to: path }) || !record.key.startsWith('epic:')) throw new Error('Invalid relocation journal')
      const info = library.installInfo(record.key)
      if (!info || ![pathKey(record.from), pathKey(record.to)].includes(pathKey(info.path))) throw new Error('Relocation no longer matches installed records')
      if (existsSync(record.to)) {
        await FsBoundary.create(record.to)
        if (info.executable && !existsSync(join(record.to, info.executable))) throw new Error('Relocation target is incomplete')
        library.relocate(record.from, record.to)
        await provider('epic').relocateInstall?.(record.from, record.to)
        console.info('[move] recovered location; any surviving source copy was preserved', record.key)
      } else if (!existsSync(record.from)) throw new Error('Both relocation paths are unavailable')
      await finishRelocation(file)
    } catch (err) { console.warn('[move] relocation recovery deferred', err) }
  }
}
