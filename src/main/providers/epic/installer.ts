// Installs, updates and repairs Epic games straight from Epic's CDN.
//
// Pipeline: fetch manifest -> work out which files need writing -> download the
// chunks those files reference (in parallel, bounded memory) -> stream chunk
// slices into files in order, SHA-1 checking every file as it's written.
// Finished files are appended to a resume log so pause/resume and crashes
// never redo completed work.
//
// Updates reuse data already on disk: any piece of a new file that also exists in
// the old build is copied from the old file instead of downloaded (like the official
// launcher's delta patching). Changed files are written next to the originals as
// "<name>.lodestar-tmp" and swapped in at the very end, so the old files stay intact as
// a source until everything is ready.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { appendFile, chmod, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { InstalledInfo, Platform } from '@shared/types'
import type { InstallProgress, InstallRequest, InstallTask, InstallTotals, ProviderGame } from '../types'
import { downloadManifest, type EpicApi, httpFetch, USER_AGENT } from './api'
import {
  chunkPath,
  decodeChunk,
  FILE_FLAG_EXECUTABLE,
  type FileEntry,
  type Manifest,
  parseManifest
} from './manifest'

const MAX_CHUNK_CACHE_BYTES = 768 * 1024 * 1024
const STAGE_SUFFIX = '.lodestar-tmp'

/** Where an old build already has a piece of a chunk on disk. */
interface ReuseSource {
  file: string
  fileOffset: number
  chunkOffset: number
  size: number
}

export interface InstallerDeps {
  api: EpicApi
  platform: Platform
  maxWorkers: () => number
  installPrerequisites: () => boolean
  /** Manifest of the build currently on disk, if we can find one. */
  loadInstalledManifest: (install: InstalledInfo) => Promise<Buffer | null>
  saveInstalledManifest: (appName: string, data: Buffer) => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

export class EpicInstallTask implements InstallTask {
  private manifest!: Manifest
  private manifestData!: Buffer
  private baseUrls: string[] = []
  private toWrite: FileEntry[] = []
  private toVerify: FileEntry[] = []
  private toDelete: string[] = []
  private completed = new Set<string>()
  /** chunk guid -> places in the old build's files holding parts of it. */
  private reuse = new Map<string, ReuseSource[]>()
  /** Files rewritten via a temp file (they exist in the old build and serve as reuse sources). */
  private staged = new Set<string>()
  /** The files of the new build this install actually has (optional packs filtered out). */
  private files: FileEntry[] = []

  private downloaded = 0
  private written = 0
  private verified = 0
  private totals!: InstallTotals

  constructor(
    private readonly deps: InstallerDeps,
    private readonly game: ProviderGame,
    private readonly req: InstallRequest
  ) {}

  private get resumeLog(): string {
    // One log per app: DLC installs into its base game's folder alongside it.
    return join(this.req.installPath, '.lodestar', `resume-${this.game.appName}.log`)
  }

  async prepare(signal: AbortSignal): Promise<InstallTotals> {
    const { api, platform } = this.deps
    const info = await api.manifestInfo(platform, this.game.namespace, this.game.catalogItemId, this.game.appName)
    if (signal.aborted) throw abortError()
    const { data, baseUrls } = await downloadManifest(info)
    this.manifestData = data
    this.baseUrls = baseUrls
    this.manifest = parseManifest(data)
    const m = this.manifest

    // Files already finished for this exact build in an earlier (paused/crashed) run.
    this.completed = new Set()
    try {
      for (const line of (await readFile(this.resumeLog, 'utf8')).split('\n')) {
        const [version, name] = line.split('\t')
        if (version === m.buildVersion && name) this.completed.add(name)
      }
    } catch {
      /* no resume log */
    }

    this.toVerify = []
    this.toDelete = []

    const oldData =
      this.req.kind !== 'install' && this.req.existing
        ? await this.deps.loadInstalledManifest(this.req.existing).catch(() => null)
        : null
    const old = oldData ? safeParse(oldData) : null

    this.files = this.req.kind === 'install' ? m.files : this.installedSelection(m, old)
    let needed: FileEntry[] = this.files

    if (old) {
      const newNames = new Set(m.files.map((f) => f.filename))
      this.toDelete = old.files.filter((f) => !newNames.has(f.filename)).map((f) => f.filename)
    }

    this.reuse = new Map()
    this.staged = new Set()
    if (this.req.kind === 'update' && old) {
      const oldByName = new Map(old.files.map((f) => [f.filename, f]))
      needed = this.files.filter((f) => {
        const prev = oldByName.get(f.filename)
        return !prev || !prev.sha1.equals(f.sha1) || prev.symlinkTarget !== f.symlinkTarget
      })
      for (const f of old.files) {
        if (f.symlinkTarget) continue
        let pos = 0
        for (const p of f.parts) {
          const list = this.reuse.get(p.guid) ?? []
          list.push({ file: f.filename, fileOffset: pos, chunkOffset: p.offset, size: p.size })
          this.reuse.set(p.guid, list)
          pos += p.size
        }
      }
      for (const f of needed) if (oldByName.has(f.filename) && !f.symlinkTarget) this.staged.add(f.filename)
    } else if (this.req.kind !== 'install') {
      // Repair, or an update where we don't know what's on disk: hash everything.
      this.toVerify = this.files.filter((f) => !this.completed.has(f.filename))
      needed = this.files.filter((f) => this.completed.has(f.filename))
    }

    this.toWrite = needed.filter((f) => !this.completed.has(f.filename))
    this.computeTotals(needed)
    return this.totals
  }

  private computeTotals(needed: FileEntry[]): void {
    const chunkBytes = (files: FileEntry[]): number => {
      const seen = new Set<string>()
      let n = 0
      for (const f of files)
        for (const p of f.parts) {
          if (seen.has(p.guid) || this.reusable(p)) continue
          seen.add(p.guid)
          n += this.manifest.chunks.get(p.guid)?.fileSize ?? 0
        }
      return n
    }
    const totalDownload = chunkBytes(needed)
    const totalWrite = needed.reduce((n, f) => n + f.size, 0)
    // Baselines so resumed jobs show overall progress, not "remaining" progress.
    this.downloaded = totalDownload - chunkBytes(this.toWrite)
    this.written = totalWrite - this.toWrite.reduce((n, f) => n + f.size, 0)
    this.totals = {
      installPath: this.req.installPath,
      version: this.manifest.buildVersion,
      totalDownloadBytes: totalDownload,
      totalWriteBytes: totalWrite,
      totalVerifyBytes: this.toVerify.reduce((n, f) => n + f.size, 0)
    }
  }

  async run(signal: AbortSignal, progress: (p: InstallProgress) => void): Promise<InstalledInfo> {
    const report = (phase?: InstallProgress['phase']): void =>
      progress({
        phase,
        downloadedBytes: this.downloaded,
        writtenBytes: this.written,
        verifiedBytes: this.verified,
        currentFile: this.currentFile
      })

    try {
      await mkdir(join(this.req.installPath, '.lodestar'), { recursive: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        throw new Error(
          `No permission to write to ${this.req.installPath}. Folders like Program Files need admin rights — ` +
            'uninstall and reinstall the game into a folder such as C:\\Games.'
        )
      }
      throw err
    }

    if (this.toVerify.length) {
      report('verifying')
      const broken = await this.verify(this.toVerify, signal, () => report('verifying'))
      const needed = [...this.toWrite, ...broken]
      this.toWrite = needed
      this.toVerify = []
      this.computeTotals(needed)
      // Everything that verified fine counts as already written.
      progress({ totals: this.totals })
    }

    report('downloading')
    await this.writeFiles(signal, () => report('downloading'))

    report('finalizing')
    for (const name of this.staged) {
      const path = this.target(name)
      if (!existsSync(path + STAGE_SUFFIX)) continue
      if (existsSync(path)) await chmod(path, 0o666).catch(() => undefined)
      await rename(path + STAGE_SUFFIX, path)
    }
    for (const name of this.toDelete) {
      await rm(this.target(name), { force: true }).catch(() => undefined)
    }
    await this.deps.saveInstalledManifest(this.game.appName, this.manifestData)
    await rm(this.resumeLog, { force: true })
    await rmdir(join(this.req.installPath, '.lodestar')).catch(() => undefined) // only if now empty

    const m = this.manifest
    const info: InstalledInfo = {
      path: this.req.installPath,
      version: m.buildVersion,
      executable: m.launchExe,
      launchCommand: m.launchCommand,
      platform: this.deps.platform,
      sizeBytes: this.files.reduce((n, f) => n + f.size, 0),
      // We now hold this build's manifest ourselves, so Lodestar owns the install from here on.
      source: 'lodestar',
      installedAt: this.req.existing?.installedAt ?? Date.now(),
      ownsFolder: this.req.existing?.ownsFolder ?? this.req.kind === 'install',
      prereqsInstalled: this.req.existing?.prereqsInstalled
    }

    if (
      this.req.kind === 'install' &&
      this.deps.platform === 'Windows' &&
      m.prereqPath &&
      this.deps.installPrerequisites()
    ) {
      info.prereqsInstalled = await runElevated(this.target(m.prereqPath), m.prereqArgs).catch(() => false)
    }
    return info
  }

  /**
   * Games like Fortnite split content into optional packs ("install tags"). For an existing
   * install, keep exactly the packs that are on disk, plus packs that are new in this build.
   * Untagged files are always part of the game.
   */
  private installedSelection(m: Manifest, old: Manifest | null): FileEntry[] {
    const tagsOf = (f: FileEntry): string[] => f.installTags.filter(Boolean)
    if (!m.files.some((f) => tagsOf(f).length)) return m.files
    const ref = old ?? m
    const have = new Set<string>()
    for (const f of ref.files) {
      const tags = tagsOf(f)
      if (tags.length && tags.some((t) => !have.has(t)) && existsSync(this.target(f.filename))) {
        for (const t of tags) have.add(t)
      }
    }
    if (old) {
      const known = new Set(old.files.flatMap(tagsOf))
      for (const f of m.files) for (const t of tagsOf(f)) if (!known.has(t)) have.add(t)
    }
    return m.files.filter((f) => {
      const tags = tagsOf(f)
      return !tags.length || tags.some((t) => have.has(t))
    })
  }

  /** Resolve a manifest path inside the install dir, refusing anything that escapes it. */
  private target(name: string): string {
    const root = resolve(this.req.installPath)
    const full = resolve(root, name.replace(/[\\/]+/g, sep))
    if (full !== root && !full.startsWith(root + sep)) throw new Error(`Refusing unsafe path in manifest: ${name}`)
    return full
  }

  private async verify(files: FileEntry[], signal: AbortSignal, tick: () => void): Promise<FileEntry[]> {
    const broken: FileEntry[] = []
    let last = 0
    for (const f of files) {
      if (signal.aborted) throw abortError()
      const path = this.target(f.filename)
      this.currentFile = f.filename
      let ok = false
      try {
        const st = await stat(path)
        if (st.size === f.size) ok = (await sha1File(path, signal)).equals(f.sha1)
      } catch (err) {
        if (signal.aborted) throw err
      }
      this.verified += f.size
      if (!ok) broken.push(f)
      if (Date.now() - last > 200) {
        last = Date.now()
        tick()
      }
    }
    tick()
    return broken
  }

  private async fetchChunk(guid: string, signal: AbortSignal): Promise<Buffer> {
    const chunk = this.manifest.chunks.get(guid)
    if (!chunk) throw new Error(`Manifest references unknown chunk ${guid}`)
    const rel = chunkPath(this.manifest, chunk)
    let lastErr: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      if (signal.aborted) throw abortError()
      const base = this.baseUrls[attempt % this.baseUrls.length]
      try {
        const res = await httpFetch(`${base}/${rel}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          headers: { 'User-Agent': USER_AGENT }
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching chunk`)
        const raw = Buffer.from(await res.arrayBuffer())
        this.downloaded += raw.length
        if (this.req.throttle) await this.req.throttle(raw.length)
        return decodeChunk(raw)
      } catch (err) {
        if (signal.aborted) throw err
        lastErr = err
        await sleep(Math.min(8000, 400 * 2 ** attempt))
      }
    }
    throw new Error(`Failed to download chunk ${guid}: ${(lastErr as Error)?.message}`)
  }

  private currentFile?: string

  /** An old-build location holding this exact slice of the chunk, if any. */
  private reusable(p: { guid: string; offset: number; size: number }): ReuseSource | undefined {
    return this.reuse
      .get(p.guid)
      ?.find((s) => s.chunkOffset <= p.offset && p.offset + p.size <= s.chunkOffset + s.size)
  }

  private async writeFiles(signal: AbortSignal, tick: () => void): Promise<void> {
    const files = this.toWrite
    const refs = new Map<string, number>()
    const order: string[] = []
    for (const f of files)
      for (const p of f.parts) {
        if (this.reusable(p)) continue
        if (!refs.has(p.guid)) order.push(p.guid)
        refs.set(p.guid, (refs.get(p.guid) ?? 0) + 1)
      }
    type Handle = Awaited<ReturnType<typeof open>>
    const sources = new Map<string, Handle>()
    const source = async (file: string): Promise<Handle> => {
      let fh = sources.get(file)
      if (!fh) {
        if (sources.size >= 32) {
          const [k, v] = sources.entries().next().value!
          sources.delete(k)
          await v.close().catch(() => undefined)
        }
        fh = await open(this.target(file), 'r')
        sources.set(file, fh)
      }
      return fh
    }

    const cache = new Map<string, Promise<Buffer>>()
    const sizes = new Map<string, number>()
    let next = 0
    let inflight = 0
    let cachedBytes = 0
    const workers = Math.max(1, this.deps.maxWorkers())

    const start = (guid: string): Promise<Buffer> => {
      inflight++
      const p = this.fetchChunk(guid, signal).finally(() => {
        inflight--
        pump()
      })
      p.then(
        (buf) => {
          // Only count it if it's still wanted (it may have been consumed already).
          if (cache.get(guid) === p) {
            sizes.set(guid, buf.length)
            cachedBytes += buf.length
          }
        },
        () => undefined
      )
      cache.set(guid, p)
      return p
    }
    const pump = (): void => {
      if (signal.aborted) return
      while (next < order.length && inflight < workers) {
        const guid = order[next]
        const window = this.manifest.chunks.get(guid)?.windowSize ?? 1 << 20
        if (cachedBytes + (inflight + 1) * window > MAX_CHUNK_CACHE_BYTES) break
        next++
        if (!cache.has(guid)) start(guid)
      }
    }
    const take = (guid: string): Promise<Buffer> => cache.get(guid) ?? start(guid)
    const release = (guid: string): void => {
      const left = (refs.get(guid) ?? 1) - 1
      refs.set(guid, left)
      if (left <= 0) {
        cache.delete(guid)
        cachedBytes -= sizes.get(guid) ?? 0
        sizes.delete(guid)
      }
    }

    let last = 0
    /** Write one file; returns whether its SHA-1 matched. */
    const writeOne = async (f: FileEntry, path: string, allowReuse: boolean): Promise<boolean> => {
      const hash = createHash('sha1')
      const fh = await openForWrite(path)
      try {
        for (const part of f.parts) {
          const src = allowReuse ? this.reusable(part) : undefined
          let slice: Buffer
          if (src) {
            slice = Buffer.allocUnsafe(part.size)
            const at = src.fileOffset + (part.offset - src.chunkOffset)
            const { bytesRead } = await (await source(src.file)).read(slice, 0, part.size, at)
            if (bytesRead !== part.size) return false
          } else {
            const chunk = await take(part.guid)
            slice = chunk.subarray(part.offset, part.offset + part.size)
            release(part.guid)
          }
          await fh.write(slice, 0, slice.length)
          hash.update(slice)
          this.written += slice.length
          if (Date.now() - last > 200) {
            last = Date.now()
            tick()
          }
        }
      } catch (err) {
        // A missing old file just means we can't reuse from it.
        if (allowReuse && (err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      } finally {
        await fh.close()
      }
      return hash.digest().equals(f.sha1)
    }

    pump()
    try {
      for (const f of files) {
        if (signal.aborted) throw abortError()
        const final = this.target(f.filename)
        const path = this.staged.has(f.filename) ? final + STAGE_SUFFIX : final
        this.currentFile = f.filename
        await mkdir(dirname(path), { recursive: true })

        if (f.symlinkTarget) {
          await unlink(path).catch(() => undefined)
          await symlink(f.symlinkTarget, path)
        } else {
          const before = this.written
          let ok = await writeOne(f, path, this.reuse.size > 0)
          if (!ok && this.reuse.size > 0) {
            // The old file on disk wasn't what the old manifest said: fetch this one in full.
            this.written = before
            ok = await writeOne(f, path, false)
          }
          if (!ok) throw new Error(`Hash mismatch writing ${f.filename}`)
          if (f.flags & FILE_FLAG_EXECUTABLE && process.platform !== 'win32') await chmod(path, 0o755)
        }
        await appendFile(this.resumeLog, `${this.manifest.buildVersion}\t${f.filename}\n`)
      }
    } finally {
      for (const fh of sources.values()) await fh.close().catch(() => undefined)
    }
    tick()
  }
}

/** Throw away a cancelled update/repair: staged temp files and resume logs. Original files stay. */
export async function discardPartial(installPath: string): Promise<void> {
  const names = await readdir(installPath, { recursive: true }).catch(() => [] as string[])
  for (const n of names) if (n.endsWith(STAGE_SUFFIX)) await rm(join(installPath, n), { force: true }).catch(() => undefined)
  await rm(join(installPath, '.lodestar'), { recursive: true, force: true }).catch(() => undefined)
}

function safeParse(data: Buffer): Manifest | null {
  try {
    return parseManifest(data)
  } catch {
    return null
  }
}

async function openForWrite(path: string): ReturnType<typeof open> {
  try {
    return await open(path, 'w')
  } catch (err) {
    // Read-only files left behind by other launchers.
    if ((err as NodeJS.ErrnoException).code === 'EPERM' && existsSync(path)) {
      await chmod(path, 0o666)
      return open(path, 'w')
    }
    throw err
  }
}

function sha1File(path: string, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(path, { highWaterMark: 1 << 20, signal })
    stream.on('data', (d) => hash.update(d))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest()))
  })
}

/** Run a prerequisite installer with a UAC prompt. Resolves true on success. */
function runElevated(exe: string, args: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    if (!existsSync(exe)) return resolvePromise(false)
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
    const argList = args.trim() ? ` -ArgumentList ${q(args)}` : ''
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Start-Process -FilePath ${q(exe)}${argList} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
      ],
      { windowsHide: true }
    )
    ps.on('exit', (code) => resolvePromise(code === 0))
    ps.on('error', () => resolvePromise(false))
  })
}
