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
// "<name>.gamekins-tmp" and swapped in at the very end, so the old files stay intact as
// a source until everything is ready.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { appendFile, chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InstalledInfo, Platform } from '@shared/types'
import type { InstallProgress, InstallRequest, InstallTask, InstallTotals, ProviderGame } from '../types'
import { dataDir } from '../../core/store'
import { FsBoundary, manifestTarget, pathKey } from './fsBoundary'
import { downloadManifest, type EpicApi, httpFetch, USER_AGENT } from './api'
import {
  chunkPath,
  decodeChunk,
  FILE_FLAG_EXECUTABLE,
  MAX_CHUNK_BYTES,
  type FileEntry,
  type Manifest,
  parseManifest
} from './manifest'

const MAX_CHUNK_CACHE_BYTES = 128 * 1024 * 1024
const STAGE_SUFFIX = '.gamekins-tmp'

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
  /** Retained for existing callers; the installer writes the canonical path atomically. */
  saveInstalledManifest: (appName: string, data: Buffer) => Promise<void>
  /** Defaults to the provider's existing manifest location. */
  installedManifestPath?: (appName: string) => string
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

export class EpicInstallTask implements InstallTask {
  private manifest!: Manifest
  private manifestData!: Buffer
  private manifestHash = ''
  private boundary!: FsBoundary
  private baseUrls: string[] = []
  private toWrite: FileEntry[] = []
  private toVerify: FileEntry[] = []
  private toDelete: string[] = []
  private completed = new Set<string>()
  /** chunk guid -> places in the old build's files holding parts of it. */
  private reuse = new Map<string, ReuseSource[]>()
  /** Existing payloads whose replacements must be staged. */
  private staged = new Set<string>()
  private inventory = new Set<string>()
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
    return join(this.req.installPath, '.gamekins', `resume-${this.game.appName}.log`)
  }

  private get stagingInventory(): string {
    return inventoryPath(this.req.installPath, this.game.appName, this.req.jobId)
  }

  async prepare(signal: AbortSignal): Promise<InstallTotals> {
    signal.throwIfAborted()
    if (!/^[A-Za-z0-9_.-]+$/.test(this.game.appName) || ['.', '..'].includes(this.game.appName)) {
      throw new Error('Unsafe Epic app identifier')
    }
    if (this.req.jobId && !/^[A-Za-z0-9_-]+$/.test(this.req.jobId)) throw new Error('Unsafe install job identifier')
    this.boundary = await FsBoundary.create(this.req.installPath)
    await this.boundary.check(this.resumeLog)
    await this.boundary.check(this.stagingInventory)
    const { api, platform } = this.deps
    const info = await api.manifestInfo(platform, this.game.namespace, this.game.catalogItemId, this.game.appName)
    if (signal.aborted) throw abortError()
    const { data, baseUrls } = await downloadManifest(info)
    signal.throwIfAborted()
    this.manifestData = data
    this.baseUrls = baseUrls
    this.manifest = parseManifest(data)
    this.manifestHash = createHash('sha1').update(data).digest('hex')
    const m = this.manifest
    await this.validatePaths(m)

    // Files already finished for this exact build in an earlier (paused/crashed) run.
    this.completed = new Set()
    this.staged = new Set()
    const byName = new Map(m.files.map((f) => [f.filename, f]))
    try {
      for (const line of (await readFile(this.resumeLog, 'utf8')).split('\n')) {
        const [digest, name, mode, jobId = ''] = line.split('\t')
        const file = byName.get(name)
        if (digest !== this.manifestHash || jobId !== (this.req.jobId ?? '') || !file || !['staged', 'final'].includes(mode)) continue
        const path = this.target(name) + (mode === 'staged' ? STAGE_SUFFIX : '')
        await this.boundary.check(path, !!file.symlinkTarget)
        if (await this.completeFileExists(file, path)) {
          this.completed.add(name)
          if (mode === 'staged') this.staged.add(name)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.inventory = await readInventory(this.stagingInventory, this.boundary)

    this.toVerify = []
    this.toDelete = []

    const oldData =
      this.req.kind !== 'install' && this.req.existing
        ? await this.deps.loadInstalledManifest(this.req.existing).catch(() => null)
        : null
    const old = oldData ? safeParse(oldData) : null
    if (old) await this.validatePaths(old)

    this.files = this.req.kind === 'install' ? m.files : this.installedSelection(m, old)
    let needed: FileEntry[] = this.files

    if (old) {
      const newNames = new Set(m.files.map((f) => f.filename))
      this.toDelete = old.files.filter((f) => !newNames.has(f.filename)).map((f) => f.filename)
    }

    this.reuse = new Map()
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
    } else if (this.req.kind !== 'install') {
      // Repair, or an update where we don't know what's on disk: hash everything.
      this.toVerify = this.files.filter((f) => !this.completed.has(f.filename))
      needed = this.files.filter((f) => this.completed.has(f.filename))
    }

    // Every existing payload stays live until its verified replacement is committed.
    for (const f of this.files) {
      const st = await lstat(this.target(f.filename)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
        return null
      })
      if (st && !st.isFile() && !st.isSymbolicLink()) throw new Error(`Not a regular payload file: ${f.filename}`)
      if (st && !this.completed.has(f.filename)) this.staged.add(f.filename)
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
      totalVerifyBytes: this.toVerify.reduce((n, f) => n + f.size, 0),
      requiredDiskBytes: [...this.toWrite, ...this.toVerify].reduce((n, f) => n + f.size, 0)
    }
  }

  async run(signal: AbortSignal, progress: (p: InstallProgress) => void): Promise<InstalledInfo> {
    const controller = new AbortController()
    signal = AbortSignal.any([signal, controller.signal])
    try {
      return await this.execute(signal, progress)
    } finally {
      controller.abort()
    }
  }

  private async execute(signal: AbortSignal, progress: (p: InstallProgress) => void): Promise<InstalledInfo> {
    signal.throwIfAborted()
    const report = (phase?: InstallProgress['phase']): void =>
      progress({
        phase,
        downloadedBytes: this.downloaded,
        writtenBytes: this.written,
        verifiedBytes: this.verified,
        currentFile: this.currentFile
      })

    try {
      await this.boundary.check(this.resumeLog)
      await mkdir(join(this.req.installPath, '.gamekins'), { recursive: true })
      await discardLegacyPartial(this.req.installPath, this.game.appName).catch((err) => console.warn('[installer] legacy cleanup failed', err))
      await this.boundary.check(this.resumeLog)
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

    signal.throwIfAborted()
    report('finalizing')
    signal.throwIfAborted()
    // A disappeared completed file must be rebuilt, including a missing staging file.
    const missing: FileEntry[] = []
    for (const f of this.files) {
      if (!this.completed.has(f.filename)) continue
      const path = this.target(f.filename) + (this.staged.has(f.filename) ? STAGE_SUFFIX : '')
      await this.boundary.check(path, !!f.symlinkTarget)
      if (!(await this.completeFileExists(f, path))) missing.push(f)
    }
    if (missing.length) {
      this.toWrite = missing
      await this.writeFiles(signal, () => report('downloading'))
      report('finalizing')
    }
    for (const name of this.staged) {
      if (!this.completed.has(name)) continue
      signal.throwIfAborted()
      const path = this.target(name)
      await this.boundary.check(path, true)
      await this.boundary.check(path + STAGE_SUFFIX, true)
      const file = this.files.find((f) => f.filename === name)!
      if (!(await this.completeFileExists(file, path + STAGE_SUFFIX))) throw new Error(`Missing completed staging file: ${name}`)
      signal.throwIfAborted()
      if (await lstat(path).then((st) => st.isFile(), (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
        return false
      })) await chmod(path, 0o666)
      signal.throwIfAborted()
      await rename(path + STAGE_SUFFIX, path)
    }
    for (const name of this.toDelete) {
      signal.throwIfAborted()
      await this.boundary.check(this.target(name), true)
      signal.throwIfAborted()
      await rm(this.target(name), { force: true })
    }
    signal.throwIfAborted()
    // Individual promotions are not crash-transactional; a commit journal is a separate change.
    const manifestPath = this.deps.installedManifestPath?.(this.game.appName) ??
      join(dataDir('manifests', 'epic'), `${createHash('sha256').update(this.game.appName).digest('hex')}.manifest`)
    await (await FsBoundary.create(dirname(manifestPath))).check(manifestPath)
    await writeAtomic(manifestPath, this.manifestData, signal)
    signal.throwIfAborted()
    await this.boundary.check(this.resumeLog)
    await rm(this.resumeLog, { force: true })
    await this.boundary.check(this.stagingInventory)
    await rm(this.stagingInventory, { force: true })
    await rmdir(join(this.req.installPath, '.gamekins')).catch(() => undefined) // only if now empty

    const m = this.manifest
    const info: InstalledInfo = {
      path: this.req.installPath,
      version: m.buildVersion,
      executable: m.launchExe,
      launchCommand: m.launchCommand,
      platform: this.deps.platform,
      sizeBytes: this.files.reduce((n, f) => n + f.size, 0),
      // We now hold this build's manifest ourselves, so Gamekins owns the install from here on.
      source: 'gamekins',
      installedAt: this.req.existing?.installedAt ?? Date.now(),
      ownsFolder: this.req.existing?.ownsFolder ?? (this.req.createdFolder === true && !this.game.dlcOf),
      prereqsInstalled: this.req.existing?.prereqsInstalled
    }

    if (this.deps.platform === 'Windows' && m.prereqPath && info.prereqsInstalled !== true) {
      info.prereqsInstalled = false
    }
    this.req.onCommitted?.({ ...info })
    if (
      info.prereqsInstalled !== true &&
      this.deps.platform === 'Windows' &&
      m.prereqPath &&
      this.deps.installPrerequisites()
    ) {
      signal.throwIfAborted()
      await this.boundary.check(this.target(m.prereqPath))
      info.prereqsInstalled = await runElevated(this.target(m.prereqPath), m.prereqArgs, signal).catch(() => false)
    }
    signal.throwIfAborted()
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
    return manifestTarget(this.req.installPath, name)
  }

  private async validatePaths(m: Manifest): Promise<void> {
    const seen = new Set<string>()
    for (const f of m.files) {
      const path = this.target(f.filename)
      const key = pathKey(path)
      if (seen.has(key)) throw new Error(`Duplicate manifest path: ${f.filename}`)
      seen.add(key)
      await this.boundary.check(path, !!f.symlinkTarget)
      if (f.symlinkTarget) await this.boundary.checkLink(path, f.symlinkTarget)
    }
    if (m.prereqPath) await this.boundary.check(this.target(m.prereqPath))
  }

  private async completeFileExists(f: FileEntry, path: string): Promise<boolean> {
    try {
      const st = await lstat(path)
      if (f.symlinkTarget) return st.isSymbolicLink() && (await readlink(path)) === f.symlinkTarget
      return st.isFile() && st.size === f.size
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  private async verify(files: FileEntry[], signal: AbortSignal, tick: () => void): Promise<FileEntry[]> {
    const broken: FileEntry[] = []
    let last = 0
    for (const f of files) {
      if (signal.aborted) throw abortError()
      const path = this.target(f.filename)
      await this.boundary.check(path, !!f.symlinkTarget)
      this.currentFile = f.filename
      let ok = false
      try {
        if (f.symlinkTarget) ok = await this.completeFileExists(f, path)
        else {
          const st = await stat(path)
          if (st.size === f.size) ok = (await sha1File(path, signal)).equals(f.sha1)
        }
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
        if (!res.body) throw new Error('Missing chunk response body')
        const reader = res.body.getReader()
        const raw = Buffer.allocUnsafe(chunk.fileSize)
        let offset = 0
        try {
          for (;;) {
            signal.throwIfAborted()
            const { value, done } = await reader.read()
            signal.throwIfAborted()
            if (done) break
            if (value.length > raw.length - offset) throw new Error('Chunk response exceeds declared size')
            for (let at = 0; at < value.length; at += 64 * 1024) {
              const slice = value.subarray(at, Math.min(value.length, at + 64 * 1024))
              if (this.req.throttleWithSignal) await this.req.throttleWithSignal(slice.length, signal)
              else if (this.req.throttle) await this.req.throttle(slice.length)
              signal.throwIfAborted()
              raw.set(slice, offset)
              offset += slice.length
              this.downloaded += slice.length
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
        if (offset !== raw.length) throw new Error('Truncated chunk response')
        return decodeChunk(raw, chunk)
      } catch (err) {
        if (signal.aborted) throw err
        lastErr = err
        await sleep(Math.min(8000, 400 * 2 ** attempt), signal)
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
    const controller = new AbortController()
    signal = AbortSignal.any([signal, controller.signal])
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
        await this.boundary.check(this.target(file))
        signal.throwIfAborted()
        fh = await open(this.target(file), 'r')
        sources.set(file, fh)
      }
      return fh
    }

    type Entry = { promise: Promise<Buffer>; bytes: number; settled: boolean }
    const cache = new Map<string, Entry>()
    const pending = new Set<Promise<Buffer>>()
    let next = 0
    let inflight = 0
    let cachedBytes = 0
    let wanted: string | undefined
    // Leave space for a single old-file reuse slice alongside the chunk pipeline.
    const budget = MAX_CHUNK_CACHE_BYTES - MAX_CHUNK_BYTES
    const configuredWorkers = this.deps.maxWorkers()
    const workers = Number.isFinite(configuredWorkers) ? Math.max(1, Math.min(32, Math.floor(configuredWorkers))) : 1

    const reservation = (guid: string): number => {
      const chunk = this.manifest.chunks.get(guid)
      if (!chunk) throw new Error(`Unknown chunk: ${guid}`)
      // Raw body, the reader's current block, inflated payload and stream overhead.
      const bytes = 2 * chunk.fileSize + chunk.windowSize + 64 * 1024
      if (bytes > budget) throw new Error(`Chunk exceeds memory budget: ${guid}`)
      return bytes
    }

    const drop = (guid: string): void => {
      const entry = cache.get(guid)
      if (!entry) return
      cachedBytes -= entry.bytes
      cache.delete(guid)
    }

    const start = (guid: string): Promise<Buffer> => {
      inflight++
      const bytes = reservation(guid)
      if (cachedBytes + bytes > budget) throw new Error('Chunk reservation exceeds memory budget')
      cachedBytes += bytes
      const entry: Entry = { promise: Promise.resolve(Buffer.alloc(0)), bytes, settled: false }
      const p = this.fetchChunk(guid, signal).then((buf) => {
        // Charge the completed backing buffer before allowing another fetch.
        cachedBytes += buf.buffer.byteLength - entry.bytes
        entry.bytes = buf.buffer.byteLength
        entry.settled = true
        return buf
      }, (err) => {
        cachedBytes -= entry.bytes
        entry.bytes = 0
        entry.settled = true
        throw err
      }).finally(() => {
        inflight--
        pending.delete(p)
        pump()
      })
      entry.promise = p
      cache.set(guid, entry)
      pending.add(p)
      void p.catch(() => undefined)
      return p
    }
    const pump = (): void => {
      if (signal.aborted) return
      if (wanted && !cache.has(wanted)) return
      while (next < order.length && inflight < workers) {
        const guid = order[next]
        if (cache.has(guid)) {
          next++
          continue
        }
        if (cachedBytes + reservation(guid) > budget) break
        next++
        start(guid)
      }
    }
    const take = async (guid: string): Promise<Buffer> => {
      wanted = guid
      signal.throwIfAborted()
      const existing = cache.get(guid)
      if (existing) return existing.promise
      const bytes = reservation(guid)
      while (cachedBytes + bytes > budget || inflight >= workers) {
        signal.throwIfAborted()
        // Prefetched chunks and chunks needed again later can be fetched again.
        const victim = [...cache.entries()].reverse().find(([key, entry]) => key !== guid && entry.settled)
        if (victim && cachedBytes + bytes > budget) {
          drop(victim[0])
          continue
        }
        if (!pending.size) throw new Error('Unable to reserve chunk memory')
        await Promise.race([...pending].map((p) => p.then(() => undefined, () => undefined)))
      }
      signal.throwIfAborted()
      return start(guid)
    }
    const release = (guid: string): void => {
      const left = (refs.get(guid) ?? 1) - 1
      refs.set(guid, left)
      if (left <= 0) {
        drop(guid)
      }
      wanted = undefined
      pump()
    }

    let last = 0
    /** Write one file; returns whether its SHA-1 matched. */
    const writeOne = async (f: FileEntry, path: string, allowReuse: boolean): Promise<boolean> => {
      const hash = createHash('sha1')
      signal.throwIfAborted()
      await this.boundary.check(path)
      const fh = await open(path, 'wx')
      try {
        for (const part of f.parts) {
          signal.throwIfAborted()
          const src = allowReuse ? this.reusable(part) : undefined
          let slice: Buffer
          if (src) {
            slice = Buffer.allocUnsafe(part.size)
            const at = src.fileOffset + (part.offset - src.chunkOffset)
            const { bytesRead } = await (await source(src.file)).read(slice, 0, part.size, at)
            signal.throwIfAborted()
            if (bytesRead !== part.size) return false
          } else {
            const chunk = await take(part.guid)
            signal.throwIfAborted()
            slice = chunk.subarray(part.offset, part.offset + part.size)
            if (slice.length !== part.size) throw new Error('Chunk slice out of bounds')
          }
          await writeAll(fh, slice, signal)
          hash.update(slice)
          this.written += slice.length
          if (!src) release(part.guid)
          if (Date.now() - last > 200) {
            last = Date.now()
            tick()
          }
        }
        signal.throwIfAborted()
        if ((await fh.stat()).size !== f.size) throw new Error(`File size mismatch writing ${f.filename}`)
        await fh.sync()
        signal.throwIfAborted()
      } catch (err) {
        // A missing old file just means we can't reuse from it.
        if (allowReuse && (err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      } finally {
        await fh.close()
      }
      return hash.digest().equals(f.sha1)
    }

    try {
      pump()
      for (const f of files) {
        if (signal.aborted) throw abortError()
        const final = this.target(f.filename)
        // Recheck at write time; a file may have appeared since planning.
        if (!this.staged.has(f.filename)) {
          const st = await lstat(final).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err
            return null
          })
          if (st && !st.isFile() && !st.isSymbolicLink()) throw new Error(`Not a regular payload file: ${f.filename}`)
          if (st) this.staged.add(f.filename)
        }
        const path = this.staged.has(f.filename) ? final + STAGE_SUFFIX : final
        this.currentFile = f.filename
        await this.boundary.check(path, !!f.symlinkTarget)
        await mkdir(dirname(path), { recursive: true })
        await this.boundary.check(path, !!f.symlinkTarget)
        signal.throwIfAborted()

        if (this.staged.has(f.filename)) {
          const owned = this.inventory.has(f.filename)
          if (!owned && await lstat(path).then(() => true, (err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err
            return false
          })) throw new Error(`Unowned staging file already exists: ${path}`)
          this.inventory.add(f.filename)
          await this.boundary.check(this.stagingInventory)
          await writeAtomic(this.stagingInventory, Buffer.from(JSON.stringify([...this.inventory])), signal, this.boundary)
          if (owned) await rm(path, { force: true })
        }

        if (f.symlinkTarget) {
          await this.boundary.checkLink(final, f.symlinkTarget)
          signal.throwIfAborted()
          await symlink(f.symlinkTarget, path)
        } else {
          const before = this.written
          let ok = await writeOne(f, path, this.reuse.size > 0)
          if (!ok && this.reuse.size > 0) {
            // The old file on disk wasn't what the old manifest said: fetch this one in full.
            this.written = before
            await this.boundary.check(path)
            await unlink(path)
            ok = await writeOne(f, path, false)
          }
          if (!ok) throw new Error(`Hash mismatch writing ${f.filename}`)
          if (f.flags & FILE_FLAG_EXECUTABLE && process.platform !== 'win32') await chmod(path, 0o755)
        }
        signal.throwIfAborted()
        await this.boundary.check(this.resumeLog)
        await appendFile(this.resumeLog, `${this.manifestHash}\t${f.filename}\t${this.staged.has(f.filename) ? 'staged' : 'final'}\t${this.req.jobId ?? ''}\n`)
        this.completed.add(f.filename)
      }
    } finally {
      controller.abort()
      await Promise.allSettled([...pending])
      await Promise.allSettled([...sources.values()].map((fh) => fh.close()))
      sources.clear()
      cache.clear()
      cachedBytes = 0
    }
    tick()
  }
}

/** Remove only the app's recorded staging files; shared DLC metadata is preserved. */
export async function discardPartial(installPath: string, appName?: string, jobId?: string): Promise<void> {
  // Legacy callers without an app identity cannot safely select a job's leftovers.
  if (!appName || !/^[A-Za-z0-9_.-]+$/.test(appName) || ['.', '..'].includes(appName)) return
  if (jobId && !/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Unsafe install job identifier')
  const boundary = await FsBoundary.create(installPath)
  const inventoryFile = inventoryPath(installPath, appName, jobId)
  const inventory = await readInventory(inventoryFile, boundary)
  for (const name of inventory) {
    const path = manifestTarget(installPath, name) + STAGE_SUFFIX
    await boundary.check(path, true)
    await rm(path, { force: true })
  }
  const log = join(installPath, '.gamekins', `resume-${appName}.log`)
  await boundary.check(log)
  await rm(log, { force: true })
  await boundary.check(inventoryFile)
  await rm(inventoryFile, { force: true })
  await rmdir(join(installPath, '.gamekins')).catch(() => undefined)
  await discardLegacyPartial(installPath, appName).catch((err) => console.warn('[installer] legacy cleanup failed', err))
}

/** The app's earlier names, which named the job folder `.<name>` and staged files `<file>.<name>-tmp`. */
const LEGACY_NAMES = ['vapor', 'lodestar']

/**
 * Remove an app's leftovers from jobs started under an earlier name. Their resume logs
 * can't be reused (older format, or bound to a different staging suffix), so only the
 * staged files those logs and inventories name are deleted; installed files are untouched.
 */
export async function discardLegacyPartial(installPath: string, appName: string): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(appName) || ['.', '..'].includes(appName)) return
  const boundary = await FsBoundary.create(installPath)
  for (const legacy of LEGACY_NAMES) {
    const dir = join(installPath, `.${legacy}`)
    if (!existsSync(dir)) continue
    const own = (f: string): boolean =>
      f === `resume-${appName}.log` || f === `staging-${appName}.json` || (f.startsWith(`staging-${appName}-`) && f.endsWith('.json'))
    const files = (await readdir(dir).catch(() => [] as string[])).filter(own)
    const names = new Set<string>()
    for (const f of files) {
      const path = join(dir, f)
      await boundary.check(path)
      const text = await readFile(path, 'utf8').catch(() => '')
      if (f.endsWith('.log')) {
        // Old lines are "version\tfile", newer ones "hash\tfile\tmode\tjob": the file is always second.
        for (const line of text.split('\n')) {
          const name = line.split('\t')[1]
          if (name) names.add(name)
        }
      } else {
        try {
          const list: unknown = JSON.parse(text)
          if (Array.isArray(list)) for (const name of list) if (typeof name === 'string') names.add(name)
        } catch {
          /* unreadable inventory: nothing to remove from it */
        }
      }
    }
    for (const name of names) {
      let path: string
      try {
        path = manifestTarget(installPath, name) + `.${legacy}-tmp`
        await boundary.check(path, true)
      } catch {
        continue // a name that escapes the install folder is never touched
      }
      await rm(path, { force: true })
    }
    for (const f of files) await rm(join(dir, f), { force: true })
    await rmdir(dir).catch(() => undefined) // only if now empty
  }
}

function inventoryPath(installPath: string, appName: string, jobId?: string): string {
  return join(installPath, '.gamekins', `staging-${appName}${jobId ? `-${jobId}` : ''}.json`)
}

async function readInventory(path: string, boundary: FsBoundary): Promise<Set<string>> {
  await boundary.check(path)
  try {
    const names: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new Error('Invalid staging inventory')
    for (const name of names) manifestTarget(boundary.root, name)
    return new Set(names as string[])
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
}

function safeParse(data: Buffer): Manifest | null {
  try {
    return parseManifest(data)
  } catch {
    return null
  }
}

export async function writeAll(fh: Pick<Awaited<ReturnType<typeof open>>, 'write'>, slice: Buffer, signal: AbortSignal): Promise<void> {
  let offset = 0
  while (offset < slice.length) {
    signal.throwIfAborted()
    const { bytesWritten } = await fh.write(slice, offset, slice.length - offset)
    signal.throwIfAborted()
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > slice.length - offset) {
      throw new Error('File write made no valid progress')
    }
    offset += bytesWritten
  }
}

async function writeAtomic(path: string, data: Buffer, signal: AbortSignal, boundary?: FsBoundary): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  signal.throwIfAborted()
  await boundary?.check(temporary)
  const fh = await open(temporary, 'wx')
  try {
    try {
      await writeAll(fh, data, signal)
      await fh.sync()
    } finally {
      await fh.close()
    }
    signal.throwIfAborted()
    await boundary?.check(path)
    signal.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await boundary?.check(temporary)
    await rm(temporary, { force: true })
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
export function runElevated(exe: string, args: string, signal: AbortSignal, timeoutMs = 10 * 60_000): Promise<boolean> {
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
        `$p = Start-Process -FilePath ${q(exe)}${argList} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`
      ],
      { windowsHide: true }
    )
    let settled = false
    const done = (success: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolvePromise(success)
    }
    const abort = (): void => { ps.kill(); done(false) }
    const timer = setTimeout(abort, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    ps.on('exit', (code) => done(code === 0))
    ps.on('error', () => done(false))
  })
}
