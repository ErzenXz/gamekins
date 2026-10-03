const { test } = require('node:test')
const assert = require('node:assert/strict')
const { installLoader, mockWindow, root } = require('./load-source.cjs')
installLoader()
mockWindow()
const { libraryIndex, jobIndex, shareEntities } = require(root + '/lib/entityIndex.ts')
const { visibleRows, visibleItems } = require(root + '/components/library/virtualWindow.ts')
const { applyLibrary, bootstrap, useStore } = require(root + '/store.ts')
const { addToCollection, renameCollection, removeFromCollection, confirmDeleteCollection } = require(root + '/lib/gameActions.ts')

const game = (key, overrides = {}) => ({ key, title: key, images: {}, prefs: {}, dlc: [], platforms: ['Windows'], playtimeSeconds: 0, ...overrides })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('indexes share unchanged entities and include nested DLC installation changes', () => {
  const games = [game('The Alpha', { prefs: { collections: ['Story'] } }), game('Beta', { dlc: [{ key: 'dlc', install: { path: 'D:/games', sizeBytes: 100 } }] })]
  const unchanged = shareEntities(games, structuredClone(games))
  assert.equal(unchanged, games)
  assert.equal(libraryIndex(games), libraryIndex(games))
  assert.deepEqual(libraryIndex(games).sortedKeys, ['The Alpha', 'Beta'])
  assert.deepEqual(libraryIndex(games).collections.get('story'), [games[0]])
  const changed = structuredClone(games)
  changed[1].dlc[0].install.sizeBytes = 200
  const shared = shareEntities(games, changed)
  assert.equal(shared[0], games[0])
  assert.equal(shared[1].images, games[1].images)
  assert.notEqual(libraryIndex(shared).installationSignature, libraryIndex(games).installationSignature)
  const jobs = [{ gameKey: 'a', state: 'done' }, { gameKey: 'a', state: 'queued' }, { gameKey: 'b', state: 'cancelled' }]
  assert.equal(jobIndex(jobs), jobIndex(jobs))
  assert.equal(jobIndex(jobs).get('a'), jobs[1])
  assert.equal(jobIndex(jobs).has('b'), false)
})

test('row/item windows are bounded throughout a 600-game scroll', () => {
  const stride = 154 * 4 / 3 + 18
  for (const columns of [1, 3, 5, 8]) {
    const rows = Math.ceil(600 / columns)
    for (let top = 0; top < rows * stride; top += 137) {
      const [start, end] = visibleRows(top, top + 700, rows, stride)
      assert.ok(start <= Math.floor(top / stride))
      assert.ok(end >= Math.min(rows, Math.ceil((top + 700) / stride)))
      assert.ok(end - start <= Math.ceil(700 / stride) + 5)
    }
  }
  assert.deepEqual(visibleRows(-2000, -1000, 120, stride), [0, 0])
  const offsets = Array.from({ length: 600 }, (_, i) => i * 170)
  const widths = offsets.map(() => 154)
  for (let left = 0; left < 100000; left += 179) {
    const actual = visibleItems(offsets, widths, left, 900)
    const expected = offsets.flatMap((x, i) => x + widths[i] >= left - 32 && x <= left + 932 ? [i] : [])
    assert.deepEqual(actual, expected)
    assert.ok(actual.length <= 8)
  }
})

test('bootstrap commits independent domains promptly and never overwrites newer events or failure state', async () => {
  const listeners = {}
  const parts = Object.fromEntries(['info', 'games', 'jobs', 'accounts', 'settings'].map((key) => [key, deferred()]))
  window.lodestar = {
    on: Object.fromEntries(['library', 'libraryProgress', 'downloads', 'accounts', 'toast', 'navigate'].map((key) => [key, (fn) => { listeners[key] = fn }])),
    app: { info: () => parts.info.promise },
    library: { get: () => parts.games.promise, freeGames: async () => [] },
    downloads: { list: () => parts.jobs.promise }, accounts: { list: () => parts.accounts.promise },
    settings: { get: () => parts.settings.promise }
  }
  const boot = bootstrap()
  parts.info.resolve({ version: 'test', platform: 'win32', providers: [] })
  parts.settings.resolve({ installDir: 'D:/games' })
  await tick()
  assert.equal(useStore.getState().settings.installDir, 'D:/games')
  const newer = [game('newer')]
  const newerJobs = [{ id: 'job', gameKey: 'newer', state: 'downloading', downloadedBytes: 123 }]
  listeners.library(newer)
  listeners.downloads(newerJobs)
  listeners.accounts([{ provider: 'epic', displayName: 'new account' }])
  parts.games.resolve([game('old')])
  parts.jobs.resolve([])
  parts.accounts.reject(new Error('snapshot failed'))
  await boot
  assert.equal(useStore.getState().games[0].key, 'newer')
  assert.equal(useStore.getState().jobs[0].downloadedBytes, 123)
  assert.equal(useStore.getState().accounts[0].displayName, 'new account')
  assert.deepEqual(useStore.getState().bootErrors, ['accounts: snapshot failed'])
  listeners.downloads(structuredClone(newerJobs))
  assert.equal(useStore.getState().jobs[0], newerJobs[0])
})

test('collection calls serialize against the latest state before coalesced events arrive', async () => {
  applyLibrary([game('a')])
  const first = deferred()
  const calls = []
  window.lodestar.games = { setPrefs: async (key, patch) => { calls.push({ key, patch }); if (calls.length === 1) await first.promise } }
  const a = addToCollection(['a'], 'Story')
  const b = addToCollection(['a'], 'Co-op')
  await tick()
  assert.equal(calls.length, 1)
  first.resolve()
  assert.equal(await a, true)
  assert.equal(await b, true)
  assert.deepEqual(calls[1].patch.collections, ['Story', 'Co-op'])
  applyLibrary([game('a')]) // Delayed pre-edit event.
  assert.deepEqual(useStore.getState().games[0].prefs.collections, ['Story', 'Co-op'])
  assert.equal(await removeFromCollection(['a'], 'Story'), true)
  assert.deepEqual(useStore.getState().games[0].prefs.collections, ['Co-op'])
  applyLibrary([game('a', { prefs: { collections: ['Co-op'] } })]) // Acknowledgement.
})

test('failed bulk edits stop follow-up navigation/empty-state changes and leave the queue usable', async () => {
  applyLibrary([game('a', { prefs: { collections: ['Old'] } }), game('b', { prefs: { collections: ['Old'] } })])
  useStore.setState({ emptyCollections: ['Old'], libraryPage: 'collection:Old' })
  window.lodestar.games.setPrefs = async (key) => { if (key === 'b') throw new Error('write failed') }
  assert.equal(await renameCollection('Old', 'New'), false)
  assert.equal(useStore.getState().libraryPage, 'collection:Old')
  assert.deepEqual(useStore.getState().emptyCollections, ['Old'])
  assert.deepEqual(useStore.getState().games[0].prefs.collections, ['New'])
  assert.deepEqual(useStore.getState().games[1].prefs.collections, ['Old'])
  confirmDeleteCollection('Old')
  await useStore.getState().confirm.onConfirm()
  assert.equal(useStore.getState().libraryPage, 'collection:Old')
  assert.deepEqual(useStore.getState().emptyCollections, ['Old'])
  window.lodestar.games.setPrefs = async () => undefined
  assert.equal(await renameCollection('Old', 'New'), true)
  assert.equal(useStore.getState().libraryPage, 'collection:New')
})

test('a telemetry tick changes only the affected tile job snapshot', () => {
  const { tileJobIndex } = require(root + '/components/library/libraryData.ts')
  const jobs = [
    { id: 'a', gameKey: 'a', state: 'downloading', totalWriteBytes: 1000, writtenBytes: 100 },
    { id: 'b', gameKey: 'b', state: 'queued', totalWriteBytes: 1000, writtenBytes: 0 }
  ]
  const first = tileJobIndex(jobs)
  const subpercent = tileJobIndex(jobs.map((j) => ({ ...j, writtenBytes: j.gameKey === 'a' ? 109 : 0 })))
  assert.equal(first.get('a'), subpercent.get('a'))
  const percent = tileJobIndex(jobs.map((j) => ({ ...j, writtenBytes: j.gameKey === 'a' ? 110 : 0 })))
  assert.notEqual(first.get('a'), percent.get('a'))
  assert.equal(first.get('b'), percent.get('b'))
})

test('Store idle expiry survives unrelated navigation; running/hidden transitions unload it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const events = new Map()
  document.visibilityState = 'visible'
  document.addEventListener = (name, fn) => events.set(name, fn)
  document.removeEventListener = (name) => events.delete(name)
  useStore.setState({ route: { view: 'store' }, games: [] })
  const mounted = []
  const { watchStoreLifetime } = require(root + '/components/shell/storeLifetime.ts')
  const stop = watchStoreLifetime((on) => mounted.push(on))
  useStore.getState().navigate({ view: 'library' })
  t.mock.timers.tick(9 * 60_000)
  useStore.getState().navigate({ view: 'settings' })
  t.mock.timers.tick(60_000)
  assert.equal(mounted.at(-1), false)
  useStore.getState().navigate({ view: 'store' })
  assert.equal(mounted.at(-1), true)
  applyLibrary([game('first', { running: true })])
  assert.equal(mounted.at(-1), false)
  useStore.getState().navigate({ view: 'store' })
  assert.equal(mounted.at(-1), true)
  applyLibrary([game('first', { running: true }), game('second', { running: true })])
  assert.equal(mounted.at(-1), false)
  useStore.getState().navigate({ view: 'store' })
  document.visibilityState = 'hidden'
  events.get('visibilitychange')()
  t.mock.timers.tick(119999)
  assert.equal(mounted.at(-1), true)
  t.mock.timers.tick(1)
  assert.equal(mounted.at(-1), false)
  document.visibilityState = 'visible'
  events.get('visibilitychange')()
  assert.equal(mounted.at(-1), true)
  stop()
  assert.equal(events.size, 0)
})

// Exercise the actual hook callbacks without a DOM; browser reconciliation/layout is still
// a separate required verification step. No new test dependencies are needed.
function hookHarness(file) {
  const Module = require('node:module')
  const react = require('react')
  const load = Module._load
  const state = [], refs = [], deps = [], effects = [], callbacks = []
  let stateIndex = 0, refIndex = 0, effectIndex = 0
  const hooks = {
    ...react,
    useState(initial) {
      const i = stateIndex++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next }]
    },
    useRef(value) { const i = refIndex++; return refs[i] ??= { current: value } },
    useEffect(fn, next) {
      const i = effectIndex++
      if (!deps[i] || !next || next.some((v, j) => v !== deps[i][j])) effects.push(fn)
      deps[i] = next
    },
    useMemo: (fn) => fn(),
    useCallback(fn) { callbacks.push(fn); return fn }
  }
  Module._load = function(id, ...args) { return id === 'react' ? hooks : load.call(this, id, ...args) }
  let exports
  try { exports = require(root + file) } finally { Module._load = load }
  const storeModule = require(root + '/store.ts')
  const realStore = storeModule.useStore
  const fakeStore = Object.assign((selector) => selector(realStore.getState()), realStore)
  return {
    exports, state, callbacks,
    render(fn, props) {
      stateIndex = refIndex = effectIndex = 0
      storeModule.useStore = fakeStore
      try { return fn(props) } finally { storeModule.useStore = realStore }
    },
    flush() { return effects.splice(0).map((fn) => fn()) }
  }
}

test('Properties consumes a requested tab once and keys the body and General per game', () => {
  useStore.setState({ games: [game('a'), game('b')], propertiesKey: 'a', propertiesTab: 'files' })
  const harness = hookHarness('/components/PropertiesDialog.tsx')
  const body = harness.render(harness.exports.PropertiesDialog)
  assert.equal(body.key, 'a')
  harness.render(body.type, body.props)
  harness.flush()
  assert.equal(useStore.getState().propertiesTab, null)
  harness.render(body.type, body.props)
  harness.flush()
  assert.equal(harness.state[0], 'files')
  useStore.getState().openProperties('a', 'customization')
  harness.render(body.type, body.props)
  harness.flush()
  harness.render(body.type, body.props)
  harness.flush()
  assert.equal(harness.state[0], 'customization')
  useStore.getState().openProperties('b')
  const next = harness.render(harness.exports.PropertiesDialog)
  assert.equal(next.key, 'b')
})

test('Storage ignores older responses and responses after unmount', async () => {
  const requests = []
  window.lodestar.app.storage = () => { const request = deferred(); requests.push(request); return request.promise }
  const harness = hookHarness('/views/shell/StorageManager.tsx')
  harness.render(harness.exports.StorageManager)
  const [cleanup] = harness.flush()
  const second = harness.callbacks[0]()
  requests[1].resolve([{ root: 'new' }])
  await second
  requests[0].resolve([{ root: 'old' }])
  await tick()
  assert.deepEqual(harness.state[0], [{ root: 'new' }])
  const third = harness.callbacks[0]()
  cleanup()
  requests[2].resolve([{ root: 'after unmount' }])
  await third
  assert.deepEqual(harness.state[0], [{ root: 'new' }])
})
