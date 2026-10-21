const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const root = path.resolve(__dirname, '..')
const distributionModule = path.join(root, 'shared', 'distribution.ts')
const localArt = `gamekins-art://image/${'a'.repeat(64)}.png`

function loadSource(file, { store = true, stubs = {} } = {}, cache = new Map()) {
  file = path.resolve(file)
  if (file === distributionModule) return { STORE_DISTRIBUTION: store }
  if (cache.has(file)) return cache.get(file).exports
  const module = new Module(file)
  cache.set(file, module)
  module.filename = file
  module.paths = Module._nodeModulePaths(path.dirname(file))
  module.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name]
    if (name.endsWith('.css')) return {}
    if (name.startsWith('.') || name.startsWith('@shared/')) {
      const target = name.startsWith('@shared/') ? path.resolve(root, 'shared', name.slice(8)) : path.resolve(path.dirname(file), name)
      const resolved = ['.ts', '.tsx', ''].map((suffix) => target + suffix).find((candidate) => fs.existsSync(candidate))
      if (!resolved) throw new Error(`Missing source dependency: ${name}`)
      return loadSource(resolved, { store, stubs }, cache)
    }
    return require(name)
  }
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText
  module._compile(output, file)
  return module.exports
}

const policy = loadSource(path.join(__dirname, 'contentPolicy.ts'))

test('Store image policy blocks remote, disguised and data catalog images while keeping opaque local artwork', () => {
  for (const source of [
    'https://cdn.example.com/adult.png', 'http://localhost/art.png', '//cdn.example.com/art.png',
    'data:image/png;base64,aGVsbG8=', 'file:///tmp/catalog.png', 'blob:https://store.example.com/id',
    'https://example.com/assets/brand.png', '/assets/../catalog.png',
    localArt + '?remote=https://example.com', 'gamekins-art://image/../../session.bin'
  ]) assert.equal(policy.safeImageSource(source), undefined, source)
  for (const source of [localArt, 'assets/mark-hash.png', './assets/icon.png', '/assets/mark-hash.svg']) {
    assert.equal(policy.safeImageSource(source), source)
  }
  assert.equal(policy.safeImageSource('https://example.com/art.png', false), 'https://example.com/art.png')
})

test('Store IPC sanitization withholds nested catalog media without altering install and launch records', () => {
  const install = { path: '/Games/Example', executable: 'game.exe' }
  const prefs = { launchArgs: '-windowed', favorite: true }
  const game = { key: 'epic:game', provider: 'epic', title: 'Example', description: 'Unclassified catalog text',
    images: { tall: 'https://example.com/tall.png', wide: localArt, thumb: 'data:image/png;base64,AAAA' },
    install, prefs, running: true, playtimeSeconds: 42, dlc: [{ key: 'epic:dlc', image: 'https://example.com/dlc.png', title: 'DLC' }] }
  const safe = policy.sanitizeGameForDistribution(game)
  assert.deepEqual(safe.images, { wide: localArt })
  assert.equal(safe.description, undefined)
  assert.equal(safe.dlc[0].image, undefined)
  assert.equal(safe.title, game.title)
  assert.equal(safe.install, install)
  assert.equal(safe.prefs, prefs)
  assert.equal(safe.running, true)
  assert.equal(safe.playtimeSeconds, 42)
  assert.equal(game.description, 'Unclassified catalog text')
  assert.equal(game.dlc[0].image, 'https://example.com/dlc.png')
  assert.equal(policy.sanitizeGameForDistribution(game, false), game)
  const job = { id: 'job', image: game.images.tall, state: 'downloading', writtenBytes: 12 }
  assert.deepEqual(policy.sanitizeDownloadForDistribution(job), { ...job, image: undefined })
  assert.equal(policy.sanitizeDownloadForDistribution(job, false), job)
})

test('Store details never return cached rich descriptions, ratings, reviews, art or screenshots', () => {
  const details = { title: 'Example', fetchedAt: 123, steam: { about: 'Text', screenshots: ['remote'], reviews: 'reviews' }, hltb: { mainHours: 20 } }
  assert.deepEqual(policy.sanitizeGameDetailsForDistribution(details), { title: 'Example', fetchedAt: 123 })
  assert.equal(policy.sanitizeGameDetailsForDistribution(details, false), details)
})

test('main metadata short-circuits before cache, network and disk access in Store builds', async () => {
  const forbidden = () => { throw new Error('Store metadata must not access cache or network') }
  const metadata = loadSource(path.join(root, 'main/core/metadata.ts'), { stubs: {
    'node:fs/promises': { mkdir: forbidden, readFile: forbidden, writeFile: forbidden },
    '../providers/epic/api': { fetchRetry: forbidden }, './store': { dataDir: forbidden }
  } })
  const result = await metadata.gameDetails('epic:test', 'Example', true)
  assert.deepEqual(Object.keys(result).sort(), ['fetchedAt', 'title'])
  assert.equal(result.title, 'Example')
})

test('external store requests allow only HTTPS provider URLs without credentials or ports', () => {
  assert.equal(policy.externalStoreRequest('https://store.steampowered.com/app/123'), 'https://store.steampowered.com/app/123')
  for (const source of ['javascript:alert(1)', 'steam://run/1', 'https://steampowered.com.evil.test/', 'https://user:secret@www.gog.com/', 'https://www.gog.com:444/', 'https://example.com/']) {
    assert.equal(policy.externalStoreRequest(source), undefined, source)
  }
})

test('Store view contains no webview or catalog image and does not auto-open requested pages', () => {
  const state = { storeRequest: { n: 1, url: 'https://store.steampowered.com/app/123' } }
  const { StoreView } = loadSource(path.join(root, 'renderer/src/views/StoreView.tsx'), { stubs: {
    '../store': { useStore: (selector) => selector(state) },
    '../components/shell/storeSession': {}
  } })
  // No window/gamekins global exists: rendering must not invoke an external action.
  const html = renderToStaticMarkup(React.createElement(StoreView, { visible: true }))
  assert.match(html, /store-distribution-safeguards/)
  assert.match(html, /Open requested page in browser/)
  assert.match(html, /Support and content reporting/)
  assert.match(html, /parental controls/)
  assert.doesNotMatch(html, /<webview|<iframe|<img/)
})

test('image component renders title fallback before blocked image URLs reach the DOM', () => {
  const { Img } = loadSource(path.join(root, 'renderer/src/components/library/Img.tsx'))
  const html = renderToStaticMarkup(React.createElement(Img, { src: 'https://example.com/art.png', title: 'Example' }))
  assert.match(html, /Example/)
  assert.doesNotMatch(html, /<img|example.com/)
  const custom = renderToStaticMarkup(React.createElement(Img, { src: localArt, title: 'Example' }))
  assert.match(custom, /<img/)
  assert.match(custom, /gamekins-art:/)
})
