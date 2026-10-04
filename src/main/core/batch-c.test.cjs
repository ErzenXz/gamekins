// Main-process regression tests: mocked Electron, processes and HTTP; no app launch.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { resolve, join, dirname } = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const { EventEmitter } = require('node:events')

const deferred = () => {
  let yes
  const promise = new Promise((r) => { yes = r })
  return { promise, yes }
}

async function fixture(t, overrides = {}) {
  const root = await fsp.mkdtemp(join(__dirname, '.batch-c-'))
  const cache = new Map()
  const storageClears = []
  const opened = []
  const electron = {
    app: { getPath: () => root, getFileIcon: async () => ({ isEmpty: () => true }) },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { fromPartition: (id) => ({ clearStorageData: async () => storageClears.push(id), clearCache: async () => {} }) },
    shell: { openExternal: async (url) => opened.push(url), openPath: async () => '', readShortcutLink: () => ({}) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    ...overrides.electron
  }
  const stubs = new Map([['electron', electron], ...Object.entries(overrides.stubs ?? {})])
  function filename(path) {
    if (fs.existsSync(path) && fs.statSync(path).isDirectory()) return join(path, 'index.ts')
    return path.endsWith('.ts') ? path : path + '.ts'
  }
  function load(path) {
    path = filename(resolve(__dirname, path))
    if (stubs.has(path)) return stubs.get(path)
    if (cache.has(path)) return cache.get(path).exports
    const m = new Module(path, module)
    cache.set(path, m)
    m.filename = path
    m.paths = module.paths
    m.require = (name) => {
      if (stubs.has(name)) return stubs.get(name)
      if (name.startsWith('.')) return load(resolve(dirname(path), name))
      if (name.startsWith('@shared/')) return load(resolve(__dirname, '../../shared', name.slice(8)))
      if (name.startsWith('node:')) return require(name)
      throw new Error('Unexpected dependency: ' + name)
    }
    const output = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    m._compile(output, path)
    return m.exports
  }
  t.after(async () => {
    for (const m of cache.values()) {
      const library = m.exports.library
      if (library) {
        clearTimeout(library.watcher); clearTimeout(library.emitTimer)
        for (const field of ['cache', 'installed', 'playtime', 'prefs', 'artwork', 'sessions']) clearTimeout(library[field]?.timer)
      }
    }
    assert.equal(dirname(root), __dirname)
    await fsp.rm(root, { recursive: true, force: true })
  })
  return { root, load, stubs, storageClears, opened }
}

test('installation group reservations exclude DLC writes and launches synchronously', async (t) => {
  const f = await fixture(t)
  const { operations: op } = f.load('operations')
  op.groupFor = (key) => key === 'dlc' ? 'base' : key
  const release = op.acquire('dlc', 'repair')
  assert.throws(() => op.acquire('base', 'launch'), /repair/)
  release()
  op.setRunning('base', true)
  for (const action of ['install', 'repair', 'update', 'move', 'uninstall', 'resume']) assert.throws(() => op.acquire('dlc', action), /Close/)
  const stop = op.acquire('base', 'stop', true)
  assert.throws(() => op.acquire('base', 'move'), /stop/)
  stop(); op.setRunning('base', false)
  op.acquire('dlc', 'update')()
})

test('stores quarantine malformed shapes and preserve valid settings fields', async (t) => {
  const f = await fixture(t)
  fs.writeFileSync(join(f.root, 'settings.json'), JSON.stringify({ maxWorkers: -1, autoUpdate: false, installDir: 'relative' }))
  fs.writeFileSync(join(f.root, 'downloads.json'), '{"jobs":null}')
  const { JsonStore } = f.load('store')
  const settings = new JsonStore('settings', { maxWorkers: 16, autoUpdate: true, installDir: f.root })
  assert.deepEqual(settings.data, { maxWorkers: 16, autoUpdate: false, installDir: f.root })
  assert.deepEqual(new JsonStore('downloads', { jobs: [] }).data, { jobs: [] })
  assert.equal(fs.readdirSync(f.root).filter((p) => /\.corrupt-\d+\.json$/.test(p)).length, 2)
})

test('failed store writes retain data and retry without throwing', async (t) => {
  let failing = true
  const f = await fixture(t, { stubs: { 'node:fs': { ...fs, writeFileSync: (...args) => {
    if (failing) throw new Error('disk full')
    return fs.writeFileSync(...args)
  } } } })
  const { JsonStore } = f.load('store')
  const store = new JsonStore('test', { value: 1 })
  store.update((d) => { d.value = 2 })
  assert.equal(store.flush(), false)
  assert.ok(store.timer)
  failing = false
  assert.equal(store.flush(), true)
  assert.equal(JSON.parse(fs.readFileSync(store.file)).value, 2)
})

test('IPC validates the metadata channel, sender frame, strict patches and bounds', async (t) => {
  const f = await fixture(t, { stubs: {
    [resolve(__dirname, 'library.ts')]: { library: { providerGame: (key) => key === 'epic:game' ? { provider: 'epic' } : undefined } },
    [resolve(__dirname, 'downloads.ts')]: { downloads: { jobs: [{ id: 'job' }] } }
  } })
  const { validateArguments: args, validateSender } = f.load('ipcValidation')
  args('games:details', ['epic:game']); args('games:details', ['epic:game', true])
  assert.throws(() => args('games:details', ['epic:game', 'yes']))
  assert.throws(() => args('games:details', ['missing']))
  for (const patch of [{ maxWorkers: NaN }, { maxWorkers: 65 }, { maxWorkers: 1.5 }, { bandwidthLimitMBps: -1 }, { installDir: 'relative' }, { unknown: true }]) assert.throws(() => args('settings:set', [patch]))
  args('settings:set', [{ maxWorkers: 64, bandwidthLimitMBps: 0, installDir: f.root }])
  assert.throws(() => args('downloads:move', ['job', Infinity]))
  const url = 'file:///app/index.html', frame = { url }, contents = { mainFrame: frame }
  validateSender({ sender: contents, senderFrame: frame }, contents, url)
  assert.throws(() => validateSender({ sender: contents, senderFrame: { url } }, contents, url))
  assert.throws(() => validateSender({ sender: {}, senderFrame: frame }, contents, url))
  frame.url = 'https://remote.invalid'
  assert.throws(() => validateSender({ sender: contents, senderFrame: frame }, contents, url))
})

test('local tracking excludes neighboring executables and rejects unverifiable reused identities', async (t) => {
  const f = await fixture(t)
  const { trackedProcesses, sameProcess } = f.load('processes')
  const game = { pid: 90001, path: join(f.root, 'game.exe'), created: 'first' }
  const child = { pid: 90002, path: join(f.root, 'helper.exe'), parentPid: game.pid }
  const neighbor = { pid: 90003, path: join(f.root, 'other.exe') }
  assert.deepEqual(trackedProcesses([game, child, neighbor], [game], f.root, game.path, true).map((p) => p.pid), [game.pid, child.pid])
  assert.equal(sameProcess(game, { ...game, created: 'reused' }), false)
  assert.throws(() => trackedProcesses([{ pid: game.pid, path: '' }], [game], f.root, game.path, true), /Cannot verify/)
  const bundle = join(f.root, 'Game.app')
  assert.deepEqual(trackedProcesses([{ pid: 5, path: join(bundle, 'Contents/MacOS/Game') }, neighbor], [], f.root, bundle, true).map((p) => p.pid), [5])
})

test('process scans share one promise and distinguish scan errors from empty lists', async (t) => {
  const callback = deferred()
  let calls = 0, done
  const f = await fixture(t, { stubs: { 'node:child_process': { execFile: (_cmd, _args, _opts, cb) => { calls++; done = cb; callback.yes() } } } })
  const { listProcesses } = f.load('processes')
  const one = listProcesses(), two = listProcesses()
  assert.equal(one, two); assert.equal(calls, 1)
  await callback.promise
  done(new Error('access denied'), '')
  await assert.rejects(one, /scan failed/)
  const empty = listProcesses(); done(null, '')
  assert.deepEqual(await empty, [])
})

test('OAuth grants get one attempt on retryable HTTP errors', async (t) => {
  const f = await fixture(t)
  const api = f.load('../providers/epic/api')
  let calls = 0
  api.useFetch(async () => { calls++; return new Response('{}', { status: 503 }) })
  await assert.rejects(api.exchangeAuthCode('offline'), /503/)
  assert.equal(calls, 1)
  await assert.rejects(api.refreshSession('offline'), /503/)
  assert.equal(calls, 2)
})

test('logout prevents an in-flight token refresh from restoring the session', async (t) => {
  const next = deferred()
  const f = await fixture(t)
  f.stubs.set(resolve(__dirname, '../providers/epic/api.ts'), {
    EpicApi: class {}, refreshSession: () => next.promise, killSession: async () => {}
  })
  const { EpicProvider } = f.load('../providers/epic/index')
  const provider = new EpicProvider()
  provider.session = { access_token: 'old', refresh_token: 'old', expires_at: new Date(0).toISOString(), refresh_expires_at: new Date(Date.now() + 60000).toISOString(), account_id: 'old', displayName: 'Old' }
  const refreshing = provider.accessToken()
  const rejected = assert.rejects(refreshing, /Account changed/)
  await provider.logout()
  next.yes({ ...provider.session, access_token: 'new' })
  await rejected
  assert.equal(provider.account(), null)
  assert.equal(fs.existsSync(join(f.root, 'epic/session.bin')), false)
  assert.deepEqual(f.storageClears, ['persist:epic'])
})

test('partial catalog failures keep cached owned metadata and create placeholders', async (t) => {
  const f = await fixture(t)
  f.stubs.set(resolve(__dirname, '../providers/epic/api.ts'), { EpicApi: class {
    async libraryItems() { return [{ appName: 'known', catalogItemId: 'one', namespace: 'test' }, { appName: 'new', catalogItemId: 'two', namespace: 'test' }] }
    async assets() { return [] }
    async catalogItem() { throw new Error('offline failure') }
  } })
  const { EpicProvider } = f.load('../providers/epic/index')
  const provider = new EpicProvider()
  provider.session = { account_id: 'test' }
  provider.seedLibrary([{ key: 'epic:known', appName: 'known', title: 'Cached title', images: { wide: 'cached' } }])
  const games = await provider.fetchLibrary()
  assert.equal(games.length, 2)
  assert.equal(games[0].title, 'Cached title')
  assert.equal(games[1].title, 'new')
  assert.match(provider.partialRefreshError, /2 owned games/)
})

test('destructive manifest lookup requires exact identity instead of largest file', async (t) => {
  const f = await fixture(t)
  f.stubs.set(resolve(__dirname, '../providers/epic/manifest.ts'), { parseManifest: (data) => JSON.parse(data) })
  fs.mkdirSync(join(f.root, '.egstore'))
  fs.writeFileSync(join(f.root, '.egstore/base.manifest'), JSON.stringify({ appName: 'base', files: [{ size: 100 }] }))
  const { readEgstoreManifest } = f.load('../providers/epic/launcherData')
  assert.equal(await readEgstoreManifest(f.root, { appName: 'dlc', exact: true }), null)
  assert.ok(await readEgstoreManifest(f.root, { manifestId: 'base', exact: true }))
})

test('external links reject OS protocols and openPath errors propagate', async (t) => {
  const f = await fixture(t, { electron: { shell: { openExternal: async () => {}, openPath: async () => 'File not found' } } })
  const { openExternalSafe, openPathChecked } = f.load('external')
  for (const url of ['file:///etc/passwd', 'steam://run/1', 'javascript:alert(1)', 'https://user:pass@example.com']) await assert.rejects(openExternalSafe(url))
  await openExternalSafe('https://example.com')
  await assert.rejects(openPathChecked(f.root), /File not found/)
})

test('argument parsing preserves quoted values attached to options', async (t) => {
  const f = await fixture(t)
  const { splitArgs } = f.load('args')
  assert.deepEqual(splitArgs('-option="value with spaces" "" plain'), ['-option=value with spaces', '', 'plain'])
  assert.deepEqual(splitArgs('"C:\\Games\\Game.exe" -foo'), ['C:\\Games\\Game.exe', '-foo'])
  assert.throws(() => splitArgs('"unfinished'), /Unclosed/)
})

async function libraryFixture(t, provider = {}) {
  class MemoryStore {
    constructor(_name, defaults) { this.data = structuredClone(defaults) }
    update(fn) { fn(this.data) }
    set(value) { this.data = value }
    save() {}
    flush() { return true }
  }
  let procs = [], scanError = null, stopError = null
  const p = { id: 'epic', platform: 'Windows', account: () => ({ id: 'test' }), launch: async () => null,
    fetchLibrary: async () => [], scanExternalInstalls: async () => new Map(), ...provider }
  const f = await fixture(t, { stubs: {
    [resolve(__dirname, 'store.ts')]: { JsonStore: MemoryStore },
    [resolve(__dirname, '../providers/index.ts')]: { providers: [p], provider: () => p },
    [resolve(__dirname, 'processes.ts')]: {
      listProcesses: async () => { if (scanError) throw scanError; return procs },
      trackedProcesses: (all) => all,
      terminateTracked: async () => { if (stopError) throw stopError; procs = [] }
    }
  } })
  const { library } = f.load('library')
  const game = { key: 'epic:game', provider: 'epic', appName: 'game', title: 'Game', images: {}, platforms: ['Windows'] }
  library.cache.data.games[game.key] = game
  const path = join(f.root, 'Game')
  fs.mkdirSync(path); fs.writeFileSync(join(path, 'game.exe'), 'offline')
  library.setInstalled(game.key, { path, executable: 'game.exe', version: 'one', platform: 'Windows' })
  return { ...f, library, game, provider: p,
    processes: (value) => { procs = value }, scanError: (err) => { scanError = err }, stopError: (err) => { stopError = err } }
}

test('running playtime checkpoints keep the session active and failed Stop keeps write protection', async (t) => {
  const f = await libraryFixture(t)
  f.processes([{ pid: 50000, path: join(f.root, 'Game/game.exe') }])
  await f.library.launch(f.game.key)
  f.library.running.get(f.game.key).checkpoint -= 60000
  f.library.flush()
  assert.ok(f.library.get(f.game.key).playtimeSeconds >= 60)
  assert.equal(f.library.isRunning(f.game.key), true)
  assert.ok(f.library.sessions.data.games[f.game.key])
  f.stopError(new Error('Game processes survived Stop'))
  await assert.rejects(f.library.stop(f.game.key), /survived/)
  assert.equal(f.library.isRunning(f.game.key), true)
  assert.equal(f.load('operations').operations.blocked(f.game.key), true)
  f.scanError(new Error('Cannot enumerate'))
  await assert.rejects(f.library.stop(f.game.key), /enumerate/)
  assert.equal(f.library.isRunning(f.game.key), true)
})

test('late library refresh cannot restore a forgotten account', async (t) => {
  const response = deferred()
  const f = await libraryFixture(t, { fetchLibrary: () => response.promise })
  const refreshing = f.library.refresh()
  f.library.forgetProvider('epic')
  response.yes([f.game])
  await refreshing
  assert.equal(f.library.providerGame(f.game.key), undefined)
})

test('collections apply against current main state atomically and composed library is revision-cached', async (t) => {
  const f = await libraryFixture(t)
  const before = f.library.list()
  assert.equal(f.library.list(), before)
  f.library.editCollections({ operation: 'add', gameKeys: [f.game.key], name: 'First' })
  f.library.editCollections({ operation: 'add', gameKeys: [f.game.key], name: 'Second' })
  assert.deepEqual(f.library.prefsFor(f.game.key).collections, ['First', 'Second'])
  assert.notEqual(f.library.list(), before)
  assert.throws(() => f.library.editCollections({ operation: 'remove', gameKeys: [f.game.key, 'missing'], name: 'First' }), /Unknown/)
  assert.deepEqual(f.library.prefsFor(f.game.key).collections, ['First', 'Second'])
})

test('unavailable installs survive refresh and recover on reconnection', async (t) => {
  const f = await libraryFixture(t)
  f.provider.fetchLibrary = async () => [f.game]
  const info = f.library.installInfo(f.game.key)
  const saved = join(f.root, 'Disconnected')
  await fsp.rename(info.path, saved)
  await f.library.refresh()
  assert.equal(f.library.installInfo(f.game.key).unavailable, true)
  await fsp.rename(saved, info.path)
  await f.library.refresh()
  assert.equal(f.library.installInfo(f.game.key).unavailable, false)
})

test('migration preserves newer destination data and marks partial copies considered', async (t) => {
  const f = await fixture(t)
  const old = join(f.root, 'Vapor'), target = join(f.root, 'Gamekins')
  fs.mkdirSync(old); fs.mkdirSync(target)
  fs.writeFileSync(join(old, 'library-cache.json'), 'old')
  fs.writeFileSync(join(target, 'library-cache.json'), 'new')
  fs.utimesSync(join(old, 'library-cache.json'), new Date(1000), new Date(1000))
  fs.writeFileSync(join(old, 'settings.json'), 'cannot copy')
  f.stubs.set('electron', { app: { getPath: (kind) => kind === 'userData' ? target : f.root } })
  f.stubs.set('node:fs', { ...fs, cpSync: () => { throw new Error('partial copy failure') } })
  f.load('../migrate')
  assert.equal(fs.readFileSync(join(target, 'library-cache.json'), 'utf8'), 'new')
  assert.ok(fs.existsSync(join(target, '.migrated')))
})

test('relocation recovery repairs metadata after promotion and preserves surviving source data', async (t) => {
  const f = await fixture(t)
  const from = join(f.root, 'source'), to = join(f.root, 'target')
  fs.mkdirSync(from); fs.mkdirSync(to)
  fs.writeFileSync(join(from, 'game.exe'), 'source')
  fs.writeFileSync(join(to, 'game.exe'), 'copied')
  const info = { path: from, executable: 'game.exe' }, records = []
  f.stubs.set(resolve(__dirname, 'library.ts'), { library: { installInfo: () => info, relocate: (_from, to) => { info.path = to } } })
  f.stubs.set(resolve(__dirname, '../providers/index.ts'), { provider: () => ({ relocateInstall: async (...args) => records.push(args) }) })
  const moves = f.load('relocations')
  const journal = await moves.beginRelocation('epic:game', from, to)
  await moves.recoverRelocations()
  assert.equal(info.path, to)
  assert.deepEqual(records, [[from, to]])
  assert.equal(fs.readFileSync(join(from, 'game.exe'), 'utf8'), 'source')
  assert.equal(fs.existsSync(journal), false)
})

test('shortcut additions deduplicate resolved targets plus arguments and retain working directories', async (t) => {
  const f = await fixture(t)
  const exe = join(f.root, 'game.exe')
  fs.writeFileSync(exe, 'offline')
  f.stubs.set('electron', {
    app: { getPath: () => f.root, getFileIcon: async () => ({ isEmpty: () => true }) },
    shell: { readShortcutLink: (file) => ({ target: exe, args: file.endsWith('three.lnk') ? '-second' : '-first', cwd: f.root }) }
  })
  const { LocalProvider } = f.load('../providers/local/index')
  const local = new LocalProvider()
  const keys = await local.add(['one.lnk', 'two.lnk', 'three.lnk'].map((p) => join(f.root, p)))
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2])
  const installs = [...(await local.scanExternalInstalls()).values()]
  assert.deepEqual(installs.map((i) => i.launchCommand), ['-first', '-second'])
  assert.ok(installs.every((i) => i.workingDirectory === f.root))
  local.flush()
})

test('prerequisite timeout and cancellation resolve failure without holding the queue', async (t) => {
  let kills = 0
  const f = await fixture(t, { stubs: { 'node:child_process': { spawn: () => Object.assign(new EventEmitter(), { kill: () => { kills++ } }) } } })
  f.stubs.set(resolve(__dirname, '../providers/epic/api.ts'), {})
  const exe = join(f.root, 'setup.exe')
  fs.writeFileSync(exe, 'offline')
  const { runElevated } = f.load('../providers/epic/installer')
  assert.equal(await runElevated(exe, '', new AbortController().signal, 1), false)
  const controller = new AbortController()
  const run = runElevated(exe, '', controller.signal)
  controller.abort()
  assert.equal(await run, false)
  assert.equal(kills, 2)
})

async function moveFixture(t, failCopy = false) {
  const f = await fixture(t)
  const source = join(f.root, 'Game', 'Game'), baseDir = join(f.root, 'Destination'), target = join(baseDir, 'Game')
  fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(join(source, 'game.exe'), 'complete')
  const info = { path: source, executable: 'game.exe' }, order = []
  let stage
  f.stubs.set(resolve(__dirname, 'library.ts'), { library: {
    providerGame: () => ({ provider: 'epic' }), installInfo: () => info,
    relocate: (_from, to) => { info.path = to; order.push('records') }
  } })
  f.stubs.set(resolve(__dirname, 'downloads.ts'), { downloads: { jobs: [] } })
  f.stubs.set(resolve(__dirname, '../providers/index.ts'), { provider: () => ({ relocateInstall: async () => order.push('provider') }) })
  f.stubs.set('node:fs/promises', { ...fsp,
    rename: async (from, to) => {
      if (from === source && to === target) throw Object.assign(new Error('cross volume'), { code: 'EXDEV' })
      return fsp.rename(from, to)
    },
    cp: async (from, to, options) => { stage = to; if (failCopy) throw new Error('copy failed'); await fsp.cp(from, to, options) },
    rm: async (path, options) => {
      if (path === source) { assert.deepEqual(order, ['records', 'provider']); order.push('delete source') }
      await fsp.rm(path, options)
    }
  })
  return { ...f, source, target, baseDir, info, order, stage: () => stage, move: f.load('moves').moveInstall }
}

test('moves reject equal, ancestor and descendant destinations while holding the group lock', async (t) => {
  const f = await moveFixture(t)
  for (const destination of [dirname(f.source), f.source, f.root]) await assert.rejects(f.move('epic:game', destination), /overlaps/)
  assert.equal(fs.readFileSync(join(f.source, 'game.exe'), 'utf8'), 'complete')
  const moving = f.move('epic:game', f.baseDir)
  assert.throws(() => f.load('operations').operations.acquire('epic:game', 'launch'), /move/)
  await moving
})

test('cross-volume copy failure removes only its unique staging folder', async (t) => {
  const f = await moveFixture(t, true)
  await assert.rejects(f.move('epic:game', f.baseDir), /copy failed/)
  assert.equal(fs.readFileSync(join(f.source, 'game.exe'), 'utf8'), 'complete')
  assert.equal(fs.existsSync(f.target), false)
  assert.equal(fs.existsSync(f.stage()), false)
  assert.equal(f.info.path, f.source)
})

test('cross-volume moves promote the complete copy and record its location before source deletion', async (t) => {
  const f = await moveFixture(t)
  await f.move('epic:game', f.baseDir)
  assert.deepEqual(f.order, ['records', 'provider', 'delete source'])
  assert.equal(fs.readFileSync(join(f.target, 'game.exe'), 'utf8'), 'complete')
  assert.equal(fs.existsSync(f.source), false)
  assert.equal(f.info.path, f.target)
})

test('process termination verifies tracked identities and reports inaccessible survivors', async (t) => {
  let scan = 0
  const signals = []
  const executable = join(__dirname, 'game.exe')
  const f = await fixture(t, { stubs: { 'node:child_process': { execFile: (cmd, args, _options, callback) => {
    if (cmd === 'taskkill.exe') { signals.push(args); callback(null, ''); return }
    scan++
    const path = scan === 1 ? executable : ''
    callback(null, `90001|1|created|${path}\n90002|1|created|${join(__dirname, 'unrelated.exe')}\n`)
  } } } })
  if (process.platform !== 'win32') return t.skip('Windows process output format')
  const { terminateTracked } = f.load('processes')
  await assert.rejects(terminateTracked([{ pid: 90001, path: executable, created: 'created' }]), /Cannot verify/)
  assert.deepEqual(signals, [['/PID', '90001', '/F']])
})

test('legacy manifests migrate to hashed filenames without accepting escaping app names', async (t) => {
  const f = await fixture(t)
  f.stubs.set(resolve(__dirname, '../providers/epic/api.ts'), { EpicApi: class {} })
  f.stubs.set(resolve(__dirname, '../providers/epic/manifest.ts'), { parseManifest: (data) => JSON.parse(data) })
  const dir = join(f.root, 'manifests/epic')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'App.manifest'), JSON.stringify({ appName: 'App', buildVersion: 'one' }))
  const { EpicProvider } = f.load('../providers/epic/index')
  const provider = new EpicProvider()
  assert.ok(await provider.ownManifest('App'))
  assert.equal(fs.existsSync(join(dir, 'App.manifest')), false)
  assert.match(fs.readdirSync(dir)[0], /^[a-f0-9]{64}\.manifest$/)
  assert.equal(await provider.ownManifest('../App'), null)
})

test('artwork is file-backed with pixel bounds and a protocol limited to opaque image names', async (t) => {
  const f = await fixture(t)
  let handler
  f.stubs.set('electron', {
    app: { getPath: () => f.root },
    protocol: { registerSchemesAsPrivileged() {}, handle(_scheme, callback) { handler = callback } },
    net: { fetch: async () => new Response('offline image') }
  })
  const art = f.load('artwork')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64')
  const url = await art.cacheArtwork(png)
  assert.match(url, /^gamekins-art:\/\/image\/[a-f0-9]{64}\.png$/)
  assert.equal(fs.readdirSync(join(f.root, 'artwork-files')).length, 1)
  png.writeUInt32BE(100000, 16)
  await assert.rejects(art.cacheArtwork(png), /dimensions/)
  art.registerArtworkProtocol()
  assert.equal((await handler({ method: 'GET', url })).status, 200)
  assert.equal((await handler({ method: 'GET', url: 'gamekins-art://image/../../session.bin' })).status, 404)
  assert.equal((await handler({ method: 'GET', url: url + '?path=session.bin' })).status, 404)
})
