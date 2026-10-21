const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const ts = require('typescript')

function load(name, stubs = {}, platform = process.platform) {
  const file = join(__dirname, name + '.ts')
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  const proc = Object.create(process)
  Object.defineProperty(proc, 'platform', { value: platform })
  new Function('require', 'module', 'exports', 'process', output)(
    (id) => stubs[id] ?? require(id), module, module.exports, proc)
  return module.exports
}

test('Linux process snapshots resolve executable paths and retain inaccessible identities', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'gamekins-proc-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const stat = (pid, ppid, start) => `${pid} (game ) with spaces) S ${ppid} ${Array(17).fill('0').join(' ')} ${start} 0 0\n`
  for (const pid of [101, 102, 103]) await fsp.mkdir(join(root, String(pid)))
  await fsp.writeFile(join(root, '101/stat'), stat(101, 1, 1234))
  await fsp.writeFile(join(root, '102/stat'), stat(102, 101, 1235))
  // 103 has vanished between enumeration and reading stat.
  const gameDir = join(root, 'games', 'My Game')
  const executable = join(gameDir, 'bin', 'game')
  const helper = join(gameDir, 'bin', 'helper')
  // Mock only the procfs exe symlink syscall; Windows runners need no symlink privilege.
  const links = new Map([[join(root, '101/exe'), executable], [join(root, '102/exe'), helper + ' (deleted)']])
  const processes = load('processes', { 'node:fs/promises': { ...fsp, readlink: async (path) => {
    if (!links.has(path)) throw Object.assign(new Error('exe is inaccessible'), { code: 'EACCES' })
    return links.get(path)
  } } })
  const found = await processes.scanLinuxProcesses(root)
  assert.deepEqual(found, [
    { pid: 101, parentPid: 1, created: '1234', path: executable },
    { pid: 102, parentPid: 101, created: '1235', path: helper }
  ])
  assert.equal(processes.under(found, gameDir).length, 2)
  links.delete(join(root, '102/exe'))
  const inaccessible = await processes.scanLinuxProcesses(root)
  assert.throws(() => processes.trackedProcesses(inaccessible, found, gameDir, executable, false), /Cannot verify executable identity/)
  assert.equal(processes.sameProcess(found[0], { ...found[0], created: '9999' }), false)
})

test('owned install aliases resolve once without filesystem lookups for every PID', () => {
  const alias = join(tmpdir(), 'steam-alias', 'game')
  const canonical = join(tmpdir(), 'steam-canonical', 'game')
  const executable = join(canonical, 'game-bin')
  const calls = []
  const processes = load('processes', { 'node:fs': { ...fs, realpathSync: (path) => {
    calls.push(path)
    if (path === alias) return canonical
    if (path === join(alias, 'game-bin')) return executable
    throw Object.assign(new Error('unavailable'), { code: 'ENOENT' })
  } } })
  const procs = [{ pid: 90001, path: executable }, { pid: 90002, path: join(tmpdir(), 'unrelated') },
    { pid: 90003, path: join(alias, 'game-bin') }]
  assert.deepEqual(processes.trackedProcesses(procs, [], alias, join(alias, 'game-bin'), false).map((p) => p.pid), [90001, 90003])
  assert.deepEqual(calls, [alias])
  calls.length = 0
  assert.deepEqual(processes.trackedProcesses(procs, [], alias, join(alias, 'game-bin'), true).map((p) => p.pid), [90001, 90003])
  assert.deepEqual(calls, [join(alias, 'game-bin')])
})

test('Proton attribution is bounded, game specific, and preserves executable/PID identities', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'gamekins-proton-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const stat = (pid, start = '1234') => `${pid} (wine process) S 1 ${Array(17).fill('0').join(' ')} ${start} 0 0\n`
  const wine = join(root, 'Proton', 'files', 'bin', 'wine64-preloader')
  const links = new Map()
  const environment = {
    201: 'SteamAppId=570\0SteamGameId=570\0IGNORED_SECRET=fixture\0',
    202: 'SteamAppId=730\0SteamGameId=730\0',
    203: undefined,
    204: 'SteamAppId=570\0SteamGameId=730\0',
    205: 'SteamGameId=570\0',
    206: 'SteamAppId=570suffix\0',
    207: 'SteamAppId=570\0' + 'x'.repeat(64 * 1024) + '\0',
    208: 'SteamAppId=570\0',
    209: 'SteamAppId=570\0',
    210: 'SteamAppId=570\0SteamAppId=730\0'
  }
  for (const [pid, env] of Object.entries(environment)) {
    await fsp.mkdir(join(root, pid))
    await fsp.writeFile(join(root, pid, 'stat'), stat(pid))
    if (env !== undefined) await fsp.writeFile(join(root, pid, 'environ'), env)
    links.set(join(root, pid, 'exe'), pid === '208' ? join(root, 'unrelated-tool') : wine)
  }
  const envReads = []
  const processes = load('processes', { 'node:fs/promises': { ...fsp,
    readlink: async (path) => links.get(path),
    open: async (path, flags) => {
      envReads.push(path)
      if (path === join(root, '209/environ')) await fsp.writeFile(join(root, '209/stat'), stat(209, '9999'))
      return fsp.open(path, flags)
    }
  } })
  const snapshot = await processes.scanLinuxProcesses(root)
  assert.equal(envReads.includes(join(root, '208/environ')), false, 'native process environments must never be read')
  assert.equal(snapshot.some((p) => p.pid === 209), false, 'PID reuse during attribution must discard the snapshot')
  const own = processes.trackedProcesses(snapshot, [], join(root, 'Dota'), '', false, '570')
  assert.deepEqual(own.map((p) => p.pid), [201, 205])
  assert.deepEqual(processes.trackedProcesses(snapshot, [], join(root, 'CS'), '', false, '730').map((p) => p.pid), [202])
  assert.deepEqual(processes.trackedProcesses(snapshot, [], join(root, 'Dota'), '', false), [])
  assert.deepEqual(processes.trackedProcesses(snapshot, [], join(root, 'Dota'), '', false, '570suffix'), [])
  assert.equal(own[0].path, wine, 'signals must verify the actual Wine executable, not the Windows payload')
  assert.equal(own[0].created, '1234')
  assert.equal(JSON.stringify(snapshot).includes('IGNORED_SECRET'), false)
  assert.equal(processes.sameProcess(own[0], { ...own[0], created: '9999' }), false)
  const reattributed = { ...own[0], steamAppId: '730' }
  assert.equal(processes.sameProcess(own[0], reattributed), false)
  assert.deepEqual(processes.trackedProcesses([reattributed], [own[0]], join(root, 'Dota'), '', false, '570'), [])
  const missingAttribution = { ...own[0], steamAppId: undefined }
  assert.equal(processes.sameProcess(own[0], missingAttribution), false)
  assert.throws(() => processes.trackedProcesses([missingAttribution], [own[0]], join(root, 'Dota'), '', false, '570'), /Cannot verify Steam game identity/)
  // An attributed parent must not absorb another game's Wine process through ancestry.
  const wrongChild = { ...snapshot.find((p) => p.pid === 202), parentPid: 201 }
  assert.deepEqual(processes.trackedProcesses([own[0], wrongChild], [], join(root, 'Dota'), '', false, '570').map((p) => p.pid), [201])
})

test('Linux desktop shortcuts use a desktop entry and preserve launch URL encoding', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'gamekins-shortcut-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const extras = load('extras', {
    electron: { app: { getPath: () => root } },
    './library': { library: { get: () => ({ title: 'My Game' }) } }
  }, 'linux')
  const file = await extras.createDesktopShortcut('local:abc&123')
  assert.equal(file.endsWith('.desktop'), true)
  const content = await fsp.readFile(file, 'utf8')
  assert.match(content, /^\[Desktop Entry\]\nType=Link\n/)
  assert.match(content, /URL=gamekins:\/\/launch\/local%3Aabc%26123/)
})

test('Linux shortcut display names cannot inject desktop entry fields', async () => {
  let content
  const extras = load('extras', {
    electron: { app: { getPath: () => tmpdir() } },
    './library': { library: { get: () => ({ title: 'My Game\nInjected=bad' }) } },
    'node:fs/promises': { ...fsp, writeFile: async (_file, text) => { content = text } }
  }, 'linux')
  await extras.createDesktopShortcut('local:game')
  assert.doesNotMatch(content, /\nInjected=/)
})

test('persisted Linux installs and platform arrays pass validation', () => {
  const validation = load('validation')
  assert.equal(validation.fields({ path: join(tmpdir(), 'gamekins-schema', 'game'), version: '1', executable: 'game', launchCommand: '', platform: 'Linux', sizeBytes: 1, source: 'local', installedAt: 1 }, validation.installSchema), true)
  assert.equal(validation.gameSchema.platforms(['Windows', 'Mac', 'Linux']), true)
})
