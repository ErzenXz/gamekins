// One-time move of user data from the app's pre-release name ("Vapor") to its new home.
// Must be imported before anything else in the main process: the JSON stores open their
// files as soon as their modules load.
//
// Chromium creates the userData folder before our code runs, so "folder missing" can't be
// the signal. A marker file records that the migration has been considered.

import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, writeFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

const OLD_NAMES = ['Vapor', 'vapor']
/** Our own data (not Chromium's caches): settings, library, play time, login, store cookies. */
const APP_DATA = [
  'settings.json',
  'installed.json',
  'library-cache.json',
  'playtime.json',
  'game-prefs.json',
  'artwork.json',
  'downloads.json',
  'local-games.json',
  'epic',
  'manifests',
  'Partitions',
  // Holds the key that encrypts the saved login and cookies; without it they can't be read.
  'Local State'
]

const target = app.getPath('userData')
const marker = join(target, '.migrated')

if (!existsSync(marker)) {
  const old = OLD_NAMES.map((n) => join(app.getPath('appData'), n)).find(
    (p) => p.toLowerCase() !== target.toLowerCase() && existsSync(join(p, 'library-cache.json'))
  )
  const copy = (from: string, to: string): void => {
    const source = lstatSync(from)
    if (source.isSymbolicLink()) return
    if (source.isDirectory()) {
      if (existsSync(to) && !lstatSync(to).isDirectory()) return
      mkdirSync(to, { recursive: true })
      for (const name of readdirSync(from)) {
        try { copy(join(from, name), join(to, name)) }
        catch (err) { console.error('[migrate] partial copy failed', err) }
      }
    } else if (!existsSync(to) || lstatSync(to).mtimeMs < source.mtimeMs) {
      if (existsSync(to) && lstatSync(to).isSymbolicLink()) return
      cpSync(from, to)
    }
  }
  try {
    mkdirSync(target, { recursive: true })
    if (old) for (const item of APP_DATA) {
      const from = join(old, item)
      try { if (existsSync(from)) copy(from, join(target, item)) }
      catch (err) { console.error('[migrate] partial copy failed', err) }
    }
  } catch (err) {
    console.error('[migrate] could not copy old data', err)
  } finally {
    try { writeFileSync(marker, old ? 'considered ' + old + '\n' : 'fresh\n') }
    catch (err) { console.error('[migrate] could not write marker', err) }
  }
}
