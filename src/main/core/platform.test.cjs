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
