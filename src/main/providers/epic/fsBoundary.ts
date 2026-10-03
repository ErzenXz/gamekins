import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

export function pathKey(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function inside(root: string, path: string): boolean {
  const rel = relative(pathKey(root), pathKey(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function manifestTarget(root: string, name: string): string {
  if (!name || /[\0\r\n\t:]/.test(name) || isAbsolute(name) || win32.isAbsolute(name)) {
    throw new Error(`Refusing unsafe manifest path: ${name}`)
  }
  const full = resolve(root, name.replace(/[\\/]+/g, sep))
  if (pathKey(full) === pathKey(root) || !inside(root, full)) throw new Error(`Refusing unsafe manifest path: ${name}`)
  // Metadata and staging names belong to the installer, never to the payload.
  const parts = relative(root, full).split(sep)
  if (process.platform === 'win32' && parts.some((p) => /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error(`Unsafe Windows manifest path: ${name}`)
  }
  if (parts.some((p) => p.toLowerCase() === '.lodestar' || p.toLowerCase().endsWith('.lodestar-tmp'))) {
    throw new Error(`Reserved manifest path: ${name}`)
  }
  return full
}

export class FsBoundary {
  private constructor(readonly root: string, private readonly canonicalRoot: string) {}

  static async create(root: string): Promise<FsBoundary> {
    root = resolve(root)
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Install root must not be a symlink or junction')
    return new FsBoundary(root, await realpath(root))
  }

  async check(path: string, allowLeafLink = false): Promise<void> {
    path = resolve(path)
    if (!inside(this.root, path)) throw new Error(`Path escapes install root: ${path}`)
    if (pathKey(await realpath(this.root)) !== pathKey(this.canonicalRoot)) throw new Error('Install root changed')
    let current = path
    for (;;) {
      try {
        const st = await lstat(current)
        if (st.isSymbolicLink() && !(allowLeafLink && current === path && current !== this.root)) {
          throw new Error(`Refusing symlink or junction: ${current}`)
        }
        if (!(allowLeafLink && current === path && st.isSymbolicLink())) {
          if (!inside(this.canonicalRoot, await realpath(current))) throw new Error(`Path escapes canonical install root: ${path}`)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      if (current === this.root) return
      current = dirname(current)
    }
  }

  async checkLink(path: string, target: string): Promise<void> {
    if (!target || isAbsolute(target) || win32.isAbsolute(target) || /[\0:]/.test(target)) {
      throw new Error(`Unsafe symlink target: ${target}`)
    }
    const destination = resolve(dirname(path), target.replace(/[\\/]+/g, sep))
    await this.check(destination)
  }
}
