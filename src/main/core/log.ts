// Persistent log at <userData>/logs/gamekins.log (rotated at 5 MB). console.* in the
// main process is mirrored into it, so bug reports can include what happened.

import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

const MAX_BYTES = 5 * 1024 * 1024
let file = ''

export function logFile(): string {
  return file
}

export function initLog(): void {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  file = join(dir, 'gamekins.log')
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, join(dir, 'gamekins.old.log'))
  } catch {
    /* rotation is best-effort */
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      write(level, format(...args))
    }
  }
  write('info', `--- Gamekins ${app.getVersion()} starting (${process.platform} ${process.arch}, Electron ${process.versions.electron})`)
}

function write(level: string, msg: string): void {
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${msg}\n`)
  } catch {
    /* never let logging crash the app */
  }
}
