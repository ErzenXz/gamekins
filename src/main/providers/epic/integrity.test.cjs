// Offline unit checks: node --test src/main/providers/epic/integrity.test.cjs
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { dirname, join, resolve } = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const { deflateSync } = require('node:zlib')

const sha = (buffer) => createHash('sha1').update(buffer).digest()
const deferred = () => {
  let resolvePromise
  const promise = new Promise((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}
const blob = (n, bytes = 4) => {
  let value = BigInt(n)
  return Array.from({ length: bytes }, () => {
    const byte = Number(value & 255n)
    value >>= 8n
    return String(byte).padStart(3, '0')
  }).join('')
}
const hashBlob = (buffer) => [...sha(buffer)].map((n) => String(n).padStart(3, '0')).join('')
const guid = (n) => n.toString(16).toUpperCase().padStart(32, '0')

function manifest(files, count = 1) {
  return {
    AppNameString: 'TestApp', BuildVersionString: 'same-version', ManifestFileVersion: blob(15),
    ChunkHashList: Object.fromEntries(Array.from({ length: count }, (_, i) => [guid(i + 1), blob(i + 1, 8)])),
    DataGroupList: Object.fromEntries(Array.from({ length: count }, (_, i) => [guid(i + 1), blob(0)])),
    ChunkFilesizeList: Object.fromEntries(Array.from({ length: count }, (_, i) => [guid(i + 1), blob(41 + 1024 * 1024, 8)])),
    FileManifestList: files.map(([name, ids]) => ({
      Filename: name, FileHash: hashBlob(Buffer.from(ids.flatMap((id) => [id, id, id, id]))),
      FileChunkParts: ids.map((id) => ({ Guid: guid(id), Offset: blob(0), Size: blob(4) }))
    }))
  }
}

function chunk(n, payload = Buffer.alloc(1024 * 1024, n), compressed = false, version = 1) {
  const body = compressed ? deflateSync(payload) : payload
  const header = Buffer.alloc(version >= 3 ? 66 : version >= 2 ? 62 : 41)
  header.writeUInt32LE(0xb1fe3aa2, 0)
  header.writeUInt32LE(version, 4)
  header.writeUInt32LE(header.length, 8)
  header.writeUInt32LE(body.length, 12)
  for (let i = 0; i < 4; i++) header.writeUInt32LE(parseInt(guid(n).slice(i * 8, i * 8 + 8), 16), 16 + i * 4)
  header.writeBigUInt64LE(BigInt(n), 32)
  header[40] = compressed ? 1 : 0
  if (version >= 2) { sha(payload).copy(header, 41); header[61] = 2 }
  if (version >= 3) header.writeUInt32LE(payload.length, 62)
  return Buffer.concat([header, body])
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(join(__dirname, '.integrity-'))
  t.after(async () => {
    assert.equal(dirname(root), __dirname)
    assert.ok(root.startsWith(join(__dirname, '.integrity-')))
    await fs.rm(root, { recursive: true, force: true })
  })
  const games = new Map()
  const installs = new Map()
  const library = Object.assign(new EventEmitter(), {
    get: (key) => games.get(key), providerGame: (key) => games.get(key), installInfo: (key) => installs.get(key),
    setInstalled: (key, info) => installs.set(key, info), anyRunning: () => false, isRunning: () => false,
    listAll: () => [...games.values()], prefsFor: () => ({})
  })
  const settings = { downloadsDuringGameplay: true, bandwidthLimitMBps: 0, autoUpdate: true }
  class Store {
    constructor(_name, defaults) { this.data = defaults; this.saves = 0 }
    flush() { this.saves++ }
  }
  const api = {
    USER_AGENT: 'offline-test',
    downloadManifest: async () => { throw new Error('No test manifest configured') },
    httpFetch: async () => { throw new Error('Network disabled in offline tests') }
  }
  let taskFactory
  const provider = { createInstallTask: (...args) => taskFactory(...args) }
  const stubs = new Map([
    ['electron', { Notification: { isSupported: () => false } }],
    [resolve(__dirname, '../../core/store.ts'), { JsonStore: Store, dataDir: () => root }],
    [resolve(__dirname, '../../core/library.ts'), { library }],
    [resolve(__dirname, '../../core/settings.ts'), { settings: () => settings }],
    [resolve(__dirname, '../../providers.ts'), { provider: () => provider }],
    [resolve(__dirname, 'api.ts'), api],
    ['node:fs/promises', { ...fs, ...options.fs }]
  ])
  const cache = new Map()
  function load(filename) {
    filename = resolve(filename)
    if (stubs.has(filename)) return stubs.get(filename)
    if (cache.has(filename)) return cache.get(filename).exports
    const m = new Module(filename, module)
    cache.set(filename, m)
    m.filename = filename
    m.paths = module.paths
    m.require = (name) => {
      if (stubs.has(name)) return stubs.get(name)
      if (name.startsWith('.')) return load(resolve(dirname(filename), `${name}.ts`))
      if (name.startsWith('node:')) return require(name)
      throw new Error(`Unexpected dependency in offline tests: ${name}`)
    }
    let source = readFileSync(filename, 'utf8')
    if (filename.endsWith('downloads.ts')) source += '\nexport { Downloads, Throttle }\n'
    m._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, filename)
    return m.exports
  }
  const installer = load(join(__dirname, 'installer.ts'))
  const manifestModule = load(join(__dirname, 'manifest.ts'))
  const boundary = load(join(__dirname, 'fsBoundary.ts'))
  function installTask(json, req = {}, deps = {}) {
    api.downloadManifest = async () => ({ data: Buffer.from(JSON.stringify(json)), baseUrls: ['https://offline.invalid'] })
    api.httpFetch = async (url) => new Response(chunk(parseInt(url.match(/_([A-F0-9]+)\.chunk$/)[1], 16)))
    return new installer.EpicInstallTask({
      api: { manifestInfo: async () => ({}) }, platform: 'Windows', maxWorkers: () => 4,
      installPrerequisites: () => false, loadInstalledManifest: async () => null,
      saveInstalledManifest: async () => { throw new Error('Non-atomic saver must not be used') },
      installedManifestPath: () => join(root, 'saved.manifest'), ...deps
    }, { provider: 'epic', appName: 'TestApp', namespace: 'test', catalogItemId: 'test' },
    { kind: 'install', installPath: root, ...req })
  }
  const game = (key = 'epic:TestApp', fields = {}) => {
    const result = { key, provider: 'epic', appName: key.split(':')[1], title: 'Test', images: {}, ...fields }
    games.set(key, result)
    return result
  }
  return { root, load, installer, manifestModule, boundary, api, game, games, installs, library, settings, installTask,
    queue: () => new (load(resolve(__dirname, '../../core/downloads.ts')).Downloads)(),
    setTaskFactory: (fn) => { taskFactory = fn } }
}

test('short writes are retried; zero writes and aborts fail', async (t) => {
  const { installer } = await fixture(t)
  const writes = []
  const fh = { write: async (slice, offset) => { writes.push(slice[offset]); return { bytesWritten: 1 } } }
  await installer.writeAll(fh, Buffer.from('abcd'), new AbortController().signal)
  assert.deepEqual(writes, [...Buffer.from('abcd')])
  await assert.rejects(installer.writeAll({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from('x'), new AbortController().signal), /progress/)
  const controller = new AbortController()
  await assert.rejects(installer.writeAll({ write: async () => { controller.abort(); return { bytesWritten: 1 } } }, Buffer.from('xy'), controller.signal))
})

test('repair and unknown-manifest updates preserve originals when finalization is cancelled', async (t) => {
  const f = await fixture(t)
  for (const kind of ['repair', 'update']) {
    await fs.writeFile(join(f.root, 'game.bin'), 'original')
    const task = f.installTask(manifest([['game.bin', [1]]]), { kind })
    const controller = new AbortController()
    const totals = await task.prepare(controller.signal)
    assert.equal(totals.requiredDiskBytes, 4)
    await assert.rejects(task.run(controller.signal, (p) => { if (p.phase === 'finalizing') controller.abort() }))
    assert.equal(await fs.readFile(join(f.root, 'game.bin'), 'utf8'), 'original')
    assert.deepEqual(await fs.readFile(join(f.root, 'game.bin.lodestar-tmp')), Buffer.alloc(4, 1))
    await f.installer.discardPartial(f.root, 'TestApp')
  }
})

test('resume is bound to manifest bytes and validates final/staged sizes', async (t) => {
  const f = await fixture(t)
  const json = manifest([['game.bin', [1]]])
  const digest = sha(Buffer.from(JSON.stringify(json))).toString('hex')
  await fs.mkdir(join(f.root, '.lodestar'))
  await fs.writeFile(join(f.root, '.lodestar', 'resume-TestApp.log'), `${digest}\tgame.bin\tfinal\n`)
  for (const bytes of [null, Buffer.alloc(1), Buffer.alloc(4, 1)]) {
    if (bytes) await fs.writeFile(join(f.root, 'game.bin'), bytes)
    const task = f.installTask(json)
    await task.prepare(new AbortController().signal)
    assert.equal(task.toWrite.length, bytes?.length === 4 ? 0 : 1)
  }
  const changed = { ...json, LaunchCommand: 'changed manifest, same version' }
  const task = f.installTask(changed)
  await task.prepare(new AbortController().signal)
  assert.equal(task.toWrite.length, 1)
  await fs.writeFile(join(f.root, '.lodestar', 'resume-TestApp.log'), `${digest}\tgame.bin\tstaged\n`)
  const staged = f.installTask(json)
  await staged.prepare(new AbortController().signal)
  assert.equal(staged.toWrite.length, 1)
})

test('missing completed staging files are rewritten before atomic manifest save', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(join(f.root, 'game.bin'), 'original')
  const json = manifest([['game.bin', [1]]])
  const task = f.installTask(json, { kind: 'repair' })
  await task.prepare(new AbortController().signal)
  let removed = false
  await task.run(new AbortController().signal, (p) => {
    if (p.phase === 'finalizing' && !removed) {
      require('node:fs').unlinkSync(join(f.root, 'game.bin.lodestar-tmp'))
      removed = true
    }
  })
  assert.deepEqual(await fs.readFile(join(f.root, 'game.bin')), Buffer.alloc(4, 1))
  assert.equal(await fs.readFile(join(f.root, 'saved.manifest'), 'utf8'), JSON.stringify(json))
  assert.deepEqual((await fs.readdir(f.root)).filter((name) => name.endsWith('.tmp')), [])
})

test('a completed final file that becomes truncated is rebuilt through staging', async (t) => {
  const f = await fixture(t)
  const json = manifest([['game.bin', [1]]])
  await fs.writeFile(join(f.root, 'game.bin'), Buffer.alloc(4, 1))
  await fs.mkdir(join(f.root, '.lodestar'))
  const digest = sha(Buffer.from(JSON.stringify(json))).toString('hex')
  await fs.writeFile(join(f.root, '.lodestar', 'resume-TestApp.log'), `${digest}\tgame.bin\tfinal\n`)
  const task = f.installTask(json)
  const controller = new AbortController()
  await task.prepare(controller.signal)
  let finalizations = 0
  await assert.rejects(task.run(controller.signal, (p) => {
    if (p.phase !== 'finalizing') return
    if (++finalizations === 1) require('node:fs').writeFileSync(join(f.root, 'game.bin'), 'x')
    else controller.abort()
  }))
  assert.equal(await fs.readFile(join(f.root, 'game.bin'), 'utf8'), 'x')
  assert.deepEqual(await fs.readFile(join(f.root, 'game.bin.lodestar-tmp')), Buffer.alloc(4, 1))
})

test('scoped discard leaves other apps and unrelated suffix files untouched', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(join(f.root, '.lodestar'))
  await fs.writeFile(join(f.root, '.lodestar', 'staging-TestApp.json'), JSON.stringify(['game.bin']))
  await fs.writeFile(join(f.root, '.lodestar', 'resume-TestApp.log'), 'test')
  await fs.writeFile(join(f.root, '.lodestar', 'resume-Dlc.log'), 'keep')
  await fs.writeFile(join(f.root, 'game.bin.lodestar-tmp'), 'remove')
  await fs.writeFile(join(f.root, 'unrelated.lodestar-tmp'), 'keep')
  await f.installer.discardPartial(f.root, 'TestApp')
  assert.equal(await fs.readFile(join(f.root, 'unrelated.lodestar-tmp'), 'utf8'), 'keep')
  assert.equal(await fs.readFile(join(f.root, '.lodestar', 'resume-Dlc.log'), 'utf8'), 'keep')
  await assert.rejects(fs.stat(join(f.root, 'game.bin.lodestar-tmp')), { code: 'ENOENT' })
})

test('body is throttled in 64 KiB slices before the next read', async (t) => {
  const f = await fixture(t)
  const task = f.installTask(manifest([['game.bin', [1]]]), {
    throttleWithSignal: async (bytes) => { assert.ok(bytes <= 64 * 1024); throttled += bytes; calls++ }
  })
  let throttled = 0
  let calls = 0
  await task.prepare(new AbortController().signal)
  const raw = chunk(1)
  let offset = 0
  f.api.httpFetch = async () => ({ ok: true, body: { getReader: () => ({
    read: async () => {
      assert.equal(throttled, offset)
      if (offset === raw.length) return { done: true }
      const value = raw.subarray(offset, Math.min(raw.length, offset + 64 * 1024))
      offset += value.length
      return { done: false, value }
    }, cancel: async () => {}, releaseLock: () => {}
  }) } })
  await task.run(new AbortController().signal, () => {})
  assert.equal(throttled, raw.length)
  assert.ok(calls > 1)
})

test('distant shared chunks can be evicted and fetched again within the memory budget', async (t) => {
  const f = await fixture(t)
  const ids = Array.from({ length: 120 }, (_, i) => i + 1)
  const task = f.installTask(manifest([['first.bin', ids], ['last.bin', ids]], ids.length))
  const counts = new Map()
  await task.prepare(new AbortController().signal)
  f.api.httpFetch = async (url) => {
    const id = parseInt(url.match(/_([A-F0-9]+)\.chunk$/)[1], 16)
    counts.set(id, (counts.get(id) ?? 0) + 1)
    return new Response(chunk(id))
  }
  await task.run(new AbortController().signal, () => {})
  assert.equal(counts.size, 120)
  assert.ok([...counts.values()].some((n) => n > 1), 'budget pressure must evict rather than pin all 120 chunks')
  assert.deepEqual(await fs.readFile(join(f.root, 'first.bin')), await fs.readFile(join(f.root, 'last.bin')))
})

test('writer failure aborts and drains outstanding chunk workers', async (t) => {
  const f = await fixture(t, { fs: { open: async (path, ...args) => {
    if (String(path).endsWith('game.bin')) throw new Error('mock disk failure')
    return fs.open(path, ...args)
  } } })
  const task = f.installTask(manifest([['game.bin', [1, 2, 3, 4]]], 4))
  await task.prepare(new AbortController().signal)
  let active = 0
  let stopped = 0
  f.api.httpFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    active++
    signal.addEventListener('abort', () => {
      setTimeout(() => { active--; stopped++; reject(signal.reason) }, 20)
    }, { once: true })
  })
  await assert.rejects(task.run(new AbortController().signal, () => {}), /mock disk failure/)
  assert.equal(active, 0)
  assert.equal(stopped, 4)
})

test('paths reject duplicates, absolute names, escaping links and junction parents', async (t) => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  for (const name of ['../escape', 'C:\\escape', '/escape', '.lodestar/owner', 'game.bin.lodestar-tmp']) {
    await assert.rejects(f.installTask(manifest([[name, [1]]])).prepare(signal), /path/i)
  }
  await assert.rejects(f.installTask(manifest([['game.bin', [1]], ['.\\game.bin', [1]]])).prepare(signal), /Duplicate/)
  const link = manifest([['link.bin', [1]]])
  for (const target of ['../escape', 'C:\\escape', '/escape']) {
    link.FileManifestList[0].SymlinkTarget = target
    await assert.rejects(f.installTask(link).prepare(signal), /symlink|escape|root/i)
  }
  const outside = join(f.root, 'outside')
  const install = join(f.root, 'install')
  await fs.mkdir(outside); await fs.mkdir(install)
  await fs.symlink(outside, join(install, 'junction'), 'junction')
  await assert.rejects(f.installTask(manifest([['junction/game.bin', [1]]]), { installPath: install }).prepare(signal), /symlink|junction|escape/i)
})

test('malformed binary bounds, excessive counts and decompression expansion fail', async (t) => {
  const { manifestModule: m } = await fixture(t)
  const empty = Buffer.from(JSON.stringify(manifest([], 0)))
  assert.equal(m.parseManifest(Buffer.concat([Buffer.from('\uFEFF \r\n\t'), empty])).files.length, 0)
  for (let size = 0; size < 41; size++) assert.throws(() => m.decodeChunk(chunk(1).subarray(0, size)))
  const bomb = chunk(1, Buffer.alloc(2 * 1024 * 1024), true)
  assert.throws(() => m.decodeChunk(bomb), /larger|size|length/i)
  const valid = chunk(1, Buffer.alloc(1024 * 1024, 1), true, 3)
  assert.equal(m.decodeChunk(valid).length, 1024 * 1024)
  valid[41] ^= 1
  assert.throws(() => m.decodeChunk(valid), /hash/)
  const body = Buffer.alloc(4)
  body.writeUInt32LE(0xffffffff)
  const header = Buffer.alloc(37)
  header.writeUInt32LE(0x44bec00c)
  header.writeUInt32LE(header.length, 4)
  header.writeUInt32LE(body.length, 8)
  header.writeUInt32LE(body.length, 12)
  sha(body).copy(header, 16)
  assert.throws(() => m.parseManifest(Buffer.concat([header, body])), /Truncated|invalid/i)
})

test('binary manifest blocks parse locally and reject a hostile chunk count', async (t) => {
  const { manifestModule: m } = await fixture(t)
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const string = (value) => Buffer.concat([u32(Buffer.byteLength(value) + 1), Buffer.from(`${value}\0`)])
  const block = (...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 4), body]) }
  const meta = block(Buffer.from([0]), u32(15), Buffer.from([0]), u32(1),
    string('TestApp'), string('version'), string('game.exe'), string(''), u32(0), string(''), string(''), string(''))
  const chunks = block(Buffer.from([0]), u32(0))
  const files = block(Buffer.from([0]), u32(0))
  const wrap = (body) => {
    const header = Buffer.alloc(37)
    header.writeUInt32LE(0x44bec00c); header.writeUInt32LE(37, 4)
    header.writeUInt32LE(body.length, 8); header.writeUInt32LE(body.length, 12); sha(body).copy(header, 16)
    return Buffer.concat([header, body])
  }
  assert.equal(m.parseManifest(wrap(Buffer.concat([meta, chunks, files]))).appName, 'TestApp')
  assert.throws(() => m.parseManifest(wrap(Buffer.concat([meta, block(Buffer.from([0]), u32(0xffffffff)), files]))), /count/)
  const corruptMeta = Buffer.from(meta)
  corruptMeta.writeUInt32LE(meta.length - 2)
  assert.throws(() => m.parseManifest(wrap(Buffer.concat([corruptMeta, chunks, files]))), /Truncated|invalid/i)
})

test('pause awaits preparation and rejects late state changes', async (t) => {
  const f = await fixture(t)
  f.game()
  const started = deferred()
  const prepare = deferred()
  let ran = false
  f.setTaskFactory(() => ({ prepare: async () => { started.resolve(); return prepare.promise }, run: async () => { ran = true } }))
  const queue = f.queue()
  const job = queue.enqueue('epic:TestApp', 'install', join(f.root, 'game'))
  await started.promise
  let paused = false
  const pause = queue.pause(job.id).then(() => { paused = true })
  await new Promise((r) => setImmediate(r))
  assert.equal(paused, false)
  prepare.resolve({ totalDownloadBytes: 4, totalWriteBytes: 4, totalVerifyBytes: 0 })
  await pause
  assert.equal(job.state, 'paused')
  assert.equal(queue.active, null)
  assert.equal(ran, false)
  await queue.cancel(job.id)
})

test('preempted late progress keeps the job queued until its workers stop', async (t) => {
  const f = await fixture(t)
  f.game()
  f.settings.downloadsDuringGameplay = false
  let running = false
  f.library.anyRunning = () => running
  const started = deferred()
  const finish = deferred()
  f.setTaskFactory(() => ({
    prepare: async () => ({ totalDownloadBytes: 4, totalWriteBytes: 4, totalVerifyBytes: 0 }),
    run: async (signal, progress) => {
      started.resolve()
      await finish.promise
      progress({ phase: 'downloading' })
      signal.throwIfAborted()
    }
  }))
  const queue = f.queue()
  const job = queue.enqueue('epic:TestApp', 'install', join(f.root, 'game'))
  await started.promise
  const active = queue.active
  running = true
  queue.preempt(job)
  assert.equal(job.state, 'queued')
  assert.equal(queue.active, active)
  finish.resolve()
  await active.promise
  assert.equal(job.state, 'queued')
  assert.equal(queue.active, null)
  await queue.cancel(job.id)
})

test('successful jobs discard their telemetry histories', async (t) => {
  const f = await fixture(t)
  f.game()
  const gate = deferred()
  const started = deferred()
  f.setTaskFactory(() => ({
    prepare: async () => ({ totalDownloadBytes: 4, totalWriteBytes: 4, totalVerifyBytes: 0 }),
    run: async () => { started.resolve(); await gate.promise; return { path: f.root, version: 'ok' } }
  }))
  const queue = f.queue()
  const job = queue.enqueue('epic:TestApp', 'install', join(f.root, 'game'))
  await started.promise
  job.speedHistory = [1, 2]; job.diskHistory = [3, 4]
  const active = queue.active
  gate.resolve()
  await active.promise
  assert.equal(job.state, 'done')
  assert.deepEqual(job.speedHistory, [])
  assert.deepEqual(job.diskHistory, [])
})

test('cancel awaits writes; recursively removes only its owned non-DLC folder', async (t) => {
  for (const scenario of ['owned', 'missing metadata', 'DLC', 'existing empty']) {
    const f = await fixture(t)
    f.game('epic:TestApp', scenario === 'DLC' ? { dlcOf: 'epic:Base' } : {})
    const folder = join(f.root, 'game')
    if (['DLC', 'existing empty'].includes(scenario)) await fs.mkdir(folder)
    const started = deferred()
    const finish = deferred()
    f.setTaskFactory(() => ({
      prepare: async () => ({ totalDownloadBytes: 4, totalWriteBytes: 4, totalVerifyBytes: 0 }),
      run: async (signal, progress) => {
        started.resolve()
        await finish.promise
        progress({ phase: 'downloading', writtenBytes: 4 })
        await fs.writeFile(join(folder, 'late-write'), 'stopped')
        signal.throwIfAborted()
      }
    }))
    const queue = f.queue()
    const job = queue.enqueue('epic:TestApp', 'install', folder)
    await started.promise
    if (scenario === 'missing metadata') f.games.clear()
    let cancelled = false
    const cancel = queue.cancel(job.id).then(() => { cancelled = true })
    await new Promise((r) => setImmediate(r))
    assert.equal(cancelled, false)
    assert.equal(job.state, 'cancelled')
    finish.resolve()
    await cancel
    assert.equal(job.state, 'cancelled')
    assert.equal(queue.active, null)
    if (scenario === 'owned') await assert.rejects(fs.stat(folder), { code: 'ENOENT' })
    else assert.equal(await fs.readFile(join(folder, 'late-write'), 'utf8'), 'stopped')
  }
})

test('existing nonempty folder is rejected and never recursively deleted', async (t) => {
  const f = await fixture(t)
  f.game()
  const folder = join(f.root, 'existing')
  await fs.mkdir(folder)
  await fs.writeFile(join(folder, 'unrelated'), 'keep')
  const queue = f.queue()
  const job = queue.enqueue('epic:TestApp', 'install', folder)
  await queue.active.promise
  assert.equal(job.state, 'error')
  await queue.cancel(job.id)
  assert.equal(await fs.readFile(join(folder, 'unrelated'), 'utf8'), 'keep')
})

test('third-party updates are skipped and telemetry checkpoints are throttled', async (t) => {
  const f = await fixture(t)
  f.game('epic:ThirdParty', { thirdPartyManagedApp: 'EA', updateAvailable: true, install: { path: f.root } })
  const queue = f.queue()
  queue.queueUpdates()
  assert.equal(queue.jobs.length, 0)
  queue.emitNow()
  const saves = queue.store.saves
  for (let i = 0; i < 10; i++) queue.emitNow(false)
  assert.equal(queue.store.saves, saves)
  queue.lastCheckpoint -= 5001
  queue.emitNow(false)
  assert.equal(queue.store.saves, saves + 1)
})

test('bandwidth limiter accounts for requests larger than one second of allowance and aborts promptly', async (t) => {
  const f = await fixture(t)
  f.settings.bandwidthLimitMBps = 1
  const { Throttle } = f.load(resolve(__dirname, '../../core/downloads.ts'))
  const start = Date.now()
  await new Throttle().take(2 * 1024 * 1024, new AbortController().signal)
  assert.ok(Date.now() - start >= 1900)
  const controller = new AbortController()
  const wait = new Throttle().take(2 * 1024 * 1024, controller.signal)
  controller.abort()
  await assert.rejects(wait)
})
