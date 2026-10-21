const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const ts = require('typescript')

function credentials(platform, available, backend = 'gnome_libsecret') {
  const safeStorage = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.from('encrypted:' + text),
    decryptString: (raw) => {
      if (!raw.toString().startsWith('encrypted:')) throw new Error('Invalid encrypted credentials')
      return raw.toString().slice(10)
    }
  }
  const output = ts.transpileModule(readFileSync(join(__dirname, 'credentials.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', 'Buffer', output)(
    (id) => { assert.equal(id, 'electron'); return { safeStorage } },
    module, module.exports, { platform }, Buffer
  )
  return module.exports
}

test('Linux basic_text cannot persist or read credentials even when encryption reports available', () => {
  const storage = credentials('linux', true, 'basic_text')
  assert.equal(storage.sessionEncryptionAvailable(), false)
  assert.throws(() => storage.encryptSession('secret'), /keyring/)
  assert.throws(() => storage.decryptSession(Buffer.from('secret')), /keyring/)
})

test('an unavailable or locked OS keyring never falls back to plaintext', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const storage = credentials(platform, false)
    assert.equal(storage.sessionEncryptionAvailable(), false)
    assert.throws(() => storage.encryptSession('secret'), /keyring/)
  }
})

test('supported OS keyrings round-trip encrypted sessions and reject legacy plaintext', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const storage = credentials(platform, true)
    const raw = storage.encryptSession('{"token":"secret"}')
    assert.notEqual(raw.toString(), '{"token":"secret"}')
    assert.equal(storage.decryptSession(raw), '{"token":"secret"}')
    assert.throws(() => storage.decryptSession(Buffer.from('{"token":"secret"}')), /Invalid/)
  }
})
