// Find running processes by executable location. Used to tell whether a game is
// still running after its bootstrapper exits (most Epic games hand off to a
// second exe), and to stop it.

import { execFile } from 'node:child_process'
import { resolve, sep } from 'node:path'

export interface Proc {
  pid: number
  path: string
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (_err, stdout) =>
      resolvePromise(stdout ?? '')
    )
  })
}

export async function listProcesses(): Promise<Proc[]> {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath | ' +
        'Where-Object ExecutablePath | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }'
    ])
    return parse(out, '|')
  }
  // macOS / Linux: `comm` is the full executable path on macOS.
  const out = await run('ps', ['-axo', 'pid=,comm='])
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), path: m[2] }))
}

function parse(out: string, delim: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf(delim)
    if (i <= 0) continue
    const pid = Number(line.slice(0, i))
    if (pid) procs.push({ pid, path: line.slice(i + 1).trim() })
  }
  return procs
}

/** Processes whose executable lives inside `dir`. */
export function under(procs: Proc[], dir: string): Proc[] {
  const root = resolve(dir).toLowerCase() + sep
  return procs.filter((p) => resolve(p.path).toLowerCase().startsWith(root))
}

export function killAll(procs: Proc[]): void {
  for (const p of procs) {
    try {
      process.kill(p.pid)
    } catch {
      /* already gone or not ours */
    }
  }
}
