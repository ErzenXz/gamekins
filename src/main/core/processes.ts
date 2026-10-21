import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface Proc {
  pid: number
  path: string
  parentPid?: number
  created?: string
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
        const after = await readFile(join(dir, 'stat'), 'utf8')
        const next = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/)
        if (next[19] !== fields[19]) return null // PID was reused during this snapshot.
        return { pid: Number(id), parentPid: Number(fields[1]), created: fields[19], path }
      } catch (err) {
        if (['ENOENT', 'ESRCH'].includes((err as NodeJS.ErrnoException).code ?? '')) return null
        throw err
      }
    }))
    for (const proc of batch) if (proc) out.push(proc)
  }
  return out
}
const identity = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
export function sameProcess(a: Proc, b: Proc): boolean {
  return a.pid === b.pid && identity(a.path) === identity(b.path) && (!a.created || a.created === b.created)
}
function requireVisibleIdentities(procs: Proc[], cached: Proc[]): void {
  for (const old of cached) {
    const current = procs.find((p) => p.pid === old.pid)
    if (current && (!current.path || (old.created && !current.created))) {
      throw new Error(`Cannot verify executable identity for tracked PID ${old.pid}`)
    }
  }
}
export function under(procs: Proc[], dir: string): Proc[] {
  const root = identity(dir) + sep
  return procs.filter((p) => p.path && identity(p.path).startsWith(root))
}
export function trackedProcesses(procs: Proc[], cached: Proc[], dir: string, executable: string, local: boolean): Proc[] {
  requireVisibleIdentities(procs, cached)
  const known = procs.filter((p) => cached.some((old) => sameProcess(p, old)))
  // Ordinary local programs share folders with unrelated programs. A .app is its own boundary.
  const owned = local && !executable.endsWith('.app')
    ? procs.filter((p) => p.path && identity(p.path) === identity(executable))
    : under(procs, executable.endsWith('.app') ? executable : dir)
  const result = new Map([...known, ...owned].map((p) => [p.pid, p]))
  let changed = true
  while (changed) {
    changed = false
    for (const p of procs) if (p.path && p.parentPid && result.has(p.parentPid) && !result.has(p.pid)) {
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
