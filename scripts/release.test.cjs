'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { releaseConfig } = require('./release-policy.cjs')
const store = { WINDOWS_STORE_IDENTITY_NAME: '12345.Gamekins', WINDOWS_STORE_PUBLISHER: 'CN=example-id', WINDOWS_STORE_PUBLISHER_DISPLAY_NAME: 'Example Publisher' }
const apple = { CSC_LINK: 'certificate.p12', CSC_KEY_PASSWORD: 'password', APPLE_ID: 'developer@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-password', APPLE_TEAM_ID: 'ABCDEFGHIJ' }

test('macOS cannot silently skip signing or notarization', () => {
  assert.throws(() => releaseConfig('mac', false, {}), /CSC_NAME/)
  assert.throws(() => releaseConfig('mac', false, { CSC_LINK: 'certificate.p12', CSC_KEY_PASSWORD: 'password' }), /notarization/)
  assert.throws(() => releaseConfig('mac', false, { ...apple, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }), /disabled/)
  assert.deepEqual(releaseConfig('mac', false, apple), {})
  const { CSC_LINK, CSC_KEY_PASSWORD, ...notary } = apple
  assert.deepEqual(releaseConfig('mac', false, { ...notary, CSC_NAME: 'Developer ID Application: Example (ABCDEFGHIJ)' }), {})
  assert.deepEqual(releaseConfig('mac', false, { CSC_NAME: 'Developer ID Application: Example (ABCDEFGHIJ)', APPLE_KEYCHAIN_PROFILE: 'gamekins-notary' }), {})
})

test('unsigned macOS disables hardened runtime and notarization', () => {
  const config = releaseConfig('mac', true, {})
  assert.deepEqual(config.mac, { identity: null, forceCodeSigning: false, hardenedRuntime: false, notarize: false })
  assert.match(config.dmg.artifactName, /UNSIGNED/)
})

test('Windows installer requires signing credentials', () => {
  assert.throws(() => releaseConfig('win', false, {}), /CSC_LINK/)
  assert.deepEqual(releaseConfig('win', false, { WIN_CSC_LINK: 'certificate.pfx', WIN_CSC_KEY_PASSWORD: 'password' }), {})
  assert.equal(releaseConfig('win', true, {}).win.forceCodeSigning, false)
  assert.equal(releaseConfig('win', true, {}).win.signExecutable, false)
  assert.equal(releaseConfig('win', true, {}).win.signAndEditExecutable, undefined)
})

test('Store identity is mandatory even for unsigned validation', () => {
  assert.throws(() => releaseConfig('store', true, {}), /WINDOWS_STORE/)
  assert.throws(() => releaseConfig('store', false, { ...store, WINDOWS_STORE_IDENTITY_NAME: 'REPLACE.Gamekins' }), /placeholders/)
  assert.throws(() => releaseConfig('store', false, { ...store, WINDOWS_STORE_PUBLISHER: 'invalid' }), /Invalid/)
  assert.equal(releaseConfig('store', false, store).appx.identityName, store.WINDOWS_STORE_IDENTITY_NAME)
  assert.equal(releaseConfig('store', false, store).win.forceCodeSigning, false)
  assert.equal(releaseConfig('store', false, store).win.signExecutable, false)
  assert.equal(releaseConfig('store', false, store).win.signAndEditExecutable, undefined)
})

test('Linux requires no signing account and unknown platforms fail', () => {
  assert.deepEqual(releaseConfig('linux', false, {}), {})
  assert.throws(() => releaseConfig('unknown', true, {}), /Choose/)
})

test('CLI rejects unsupported architectures and unknown options before building', () => {
  const { spawnSync } = require('node:child_process')
  const { join } = require('node:path')
  const script = join(__dirname, 'release.cjs')
  for (const [args, env, message] of [
    [['store', '--arch=arm64', '--check'], store, /x64 only/],
    [['linux', '--arch=universal', '--check'], {}, /macOS only/],
    [['mac', '--unsigned', '--arch=x64', '--arch=arm64', '--check'], {}, /only one architecture/],
    [['linux', '--publish=always', '--check'], {}, /Unknown option/]
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
  }
})

test('checksum generation hashes only distributable files in stable order', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { join } = require('node:path')
  const { createHash } = require('node:crypto')
  const { spawnSync } = require('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'gamekins-checksums-'))
  try {
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'z.deb'), 'deb fixture')
    writeFileSync(join(dir, 'dist', 'a.dmg'), 'dmg fixture')
    writeFileSync(join(dir, 'dist', 'builder-debug.yml'), 'exclude debug data')
    const result = spawnSync(process.execPath, [join(__dirname, 'release-checksums.cjs')], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const hash = value => createHash('sha256').update(value).digest('hex')
    assert.equal(readFileSync(join(dir, 'dist', 'SHA256SUMS'), 'utf8'), `${hash('dmg fixture')}  a.dmg\n${hash('deb fixture')}  z.deb\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pnpm supports native executables, JavaScript entrypoints, and Windows shims', () => {
  const { pnpmInvocation } = require('./release-policy.cjs')
  assert.deepEqual(pnpmInvocation('/tools/pnpm-native', '/tools/node', 'darwin'), { command: '/tools/pnpm-native', prefix: [], shell: false })
  assert.deepEqual(pnpmInvocation('/tools/pnpm.cjs', '/tools/node', 'linux'), { command: '/tools/node', prefix: ['/tools/pnpm.cjs'], shell: false })
  assert.deepEqual(pnpmInvocation('C:\\tools\\pnpm.exe', 'C:\\node.exe', 'win32'), { command: 'C:\\tools\\pnpm.exe', prefix: [], shell: false })
  assert.deepEqual(pnpmInvocation(undefined, 'C:\\node.exe', 'win32'), { command: 'pnpm.cmd', prefix: [], shell: true })
})
