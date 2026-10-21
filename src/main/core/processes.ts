import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { open, readdir, readFile, readlink } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

export interface Proc {
  pid: number
  path: string
  parentPid?: number
  created?: string
  steamAppId?: string
}
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((yes, no) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (err, stdout) =>
      err ? no(new Error('Process scan failed: ' + err.message)) : yes(stdout))
  })
}
let scanning: Promise<Proc[]> | null = null
export function listProcesses(): Promise<Proc[]> {
  scanning ??= scanProcesses().finally(() => { scanning = null })
  return scanning
}
async function scanProcesses(): Promise<Proc[]> {
  if (process.platform === 'linux') return scanLinuxProcesses()
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate | ForEach-Object { $created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { "" }; "$($_.ProcessId)|$($_.ParentProcessId)|$created|$($_.ExecutablePath)" }'])
    return out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, parentPid, created, ...path] = line.split('|')
      if (!/^\d+$/.test(pid) || !/^\d+$/.test(parentPid)) throw new Error('Invalid process scan output')
      return { pid: Number(pid), parentPid: Number(parentPid), created, path: path.join('|').trim() }
    })
  }
  const out = await run('ps', ['-axo', 'pid=,ppid=,lstart=,comm='])
  return out.split('\n').filter((l) => l.trim()).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/)
    if (!m) throw new Error('Invalid process scan output')
    return { pid: Number(m[1]), parentPid: Number(m[2]), created: m[3], path: m[4] }
  })
}

/** Linux ps comm is a short command name, not the executable's absolute path. */
export async function scanLinuxProcesses(root = '/proc'): Promise<Proc[]> {
  const ids = (await readdir(root)).filter((name) => /^\d+$/.test(name))
  const out: Proc[] = []
  for (let i = 0; i < ids.length; i += 64) {
    const batch = await Promise.all(ids.slice(i, i + 64).map(async (id): Promise<Proc | null> => {
      const dir = join(root, id)
      try {
        const before = await readFile(join(dir, 'stat'), 'utf8')
        // comm may contain spaces and closing parentheses; stat's remaining fields do not.
        const fields = before.slice(before.lastIndexOf(')') + 2).trim().split(/\s+/)
        if (fields.length < 20 || !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[19])) throw new Error('Invalid Linux process stat')
        let path = ''
        try { path = (await readlink(join(dir, 'exe'))).replace(/ \(deleted\)$/, '') }
        catch { /* Keep inaccessible PIDs visible so tracked identities cannot silently disappear. */ }
        const steamAppId = wineExecutable(path) ? await steamIdentity(join(dir, 'environ')) : undefined
        const after = await readFile(join(dir, 'stat'), 'utf8')
        const next = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/)
        if (next[19] !== fields[19]) return null // PID was reused during this snapshot.
        return { pid: Number(id), parentPid: Number(fields[1]), created: fields[19], path, ...(steamAppId ? { steamAppId } : {}) }
      } catch (err) {
        if (['ENOENT', 'ESRCH'].includes((err as NodeJS.ErrnoException).code ?? '')) return null
        throw err
      }
    }))
    for (const proc of batch) if (proc) out.push(proc)
  }
  return out
}
const validSteamAppId = (value: string): boolean => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 0xffffffff
const wineExecutable = (path: string): boolean => /^(wine|wine64|wine-preloader|wine64-preloader)$/.test(basename(path))

/** Read only bounded Wine process environments; retain only a validated game identifier. */
async function steamIdentity(file: string): Promise<string | undefined> {
  const limit = 64 * 1024
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(limit + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > limit || (length && buffer[length - 1] !== 0)) return undefined
      const ids: string[] = []
      for (const entry of buffer.subarray(0, length).toString('utf8').split('\0')) {
        if (entry.startsWith('SteamAppId=') || entry.startsWith('SteamGameId=')) {
          const id = entry.slice(entry.indexOf('=') + 1)
          if (!validSteamAppId(id)) return undefined
          ids.push(id)
        }
      }
      return ids.length && ids.every((id) => id === ids[0]) ? ids[0] : undefined
    } finally { await handle.close() }
  } catch { return undefined }
}
const identity = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const ownedIdentity = (path: string): string => {
  try { return identity(realpathSync(path)) } catch { return identity(path) }
}
export function sameProcess(a: Proc, b: Proc): boolean {
  return a.pid === b.pid && identity(a.path) === identity(b.path) && (!a.created || a.created === b.created) &&
    (!a.steamAppId || a.steamAppId === b.steamAppId)
}
function requireVisibleIdentities(procs: Proc[], cached: Proc[]): void {
  for (const old of cached) {
    const current = procs.find((p) => p.pid === old.pid)
    if (current && (!current.path || (old.created && !current.created))) {
      throw new Error(`Cannot verify executable identity for tracked PID ${old.pid}`)
    }
    if (current && old.steamAppId && !current.steamAppId && current.created === old.created &&
      identity(current.path) === identity(old.path)) {
      throw new Error(`Cannot verify Steam game identity for tracked PID ${old.pid}`)
    }
  }
}
export function under(procs: Proc[], dir: string): Proc[] {
  const roots = [identity(dir) + sep, ownedIdentity(dir) + sep]
  return procs.filter((p) => p.path && roots.some((root) => identity(p.path).startsWith(root)))
}
export function trackedProcesses(procs: Proc[], cached: Proc[], dir: string, executable: string, local: boolean, steamAppId?: string): Proc[] {
  requireVisibleIdentities(procs, cached)
  const known = procs.filter((p) => cached.some((old) => sameProcess(p, old)))
  // Ordinary local programs share folders with unrelated programs. A .app is its own boundary.
  const executableIdentity = local && !executable.endsWith('.app') ? ownedIdentity(executable) : undefined
  const owned = executableIdentity
    ? procs.filter((p) => p.path && (identity(p.path) === executableIdentity || identity(p.path) === identity(executable)))
    : under(procs, executable.endsWith('.app') ? executable : dir)
  const proton = steamAppId && validSteamAppId(steamAppId)
    ? procs.filter((p) => p.steamAppId === steamAppId && wineExecutable(p.path)) : []
  const result = new Map([...known, ...owned, ...proton].map((p) => [p.pid, p]))
  let changed = true
  while (changed) {
    changed = false
    for (const p of procs) if (p.path && p.parentPid && result.has(p.parentPid) && !result.has(p.pid) &&
      !(steamAppId && p.steamAppId && p.steamAppId !== steamAppId)) {
      result.set(p.pid, p); changed = true
    }
  }
  return [...result.values()].filter((p) => p.pid !== process.pid)
}
/** Scan immediately before signaling, then scan until exit is confirmed. */
export async function terminateTracked(tracked: Proc[]): Promise<void> {
  const current = await listProcesses()
  requireVisibleIdentities(current, tracked)
  const targets = current.filter((p) => tracked.some((old) => sameProcess(p, old)))
  const errors: string[] = []
  for (const p of targets) {
    try {
      if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(p.pid), '/F'])
      else process.kill(p.pid, 'SIGTERM')
    } catch (err) { errors.push((err as Error).message) }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const scan = await listProcesses()
    requireVisibleIdentities(scan, targets)
    const survivors = scan.filter((p) => targets.some((old) => sameProcess(p, old)))
    if (!survivors.length) return
    if (attempt === 4) throw new Error('Game processes survived Stop: ' + survivors.map((p) => p.pid).join(', ') + (errors.length ? '; ' + errors.join('; ') : ''))
    await new Promise((r) => setTimeout(r, 500))
  }
}
