const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { resolve, dirname } = require('node:path')
const ts = require('typescript')

const EPIC = 'epic:' + 'a'.repeat(32)
const STEAM = 'steam:76561197960287930'
const GOG = 'gog:12345'
const tick = () => new Promise((yes) => setImmediate(yes))
function storageFixture() {
  const data = new Map()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}
function fixture(store = false, storage = storageFixture()) {
  const events = {}, calls = []
  const friend = (id) => ({ id, displayName: id, status: 'online' })
  const state = { available: true, connection: 'online', myStatus: 'online', loading: false,
    friends: [friend(EPIC), friend(STEAM), friend(GOG)], requests: [{ id: EPIC, displayName: 'request', direction: 'incoming' }],
    unread: { [EPIC]: 2, [STEAM]: 3 }, networks: [{ provider: 'epic', me: { id: 'me' }, canChat: true }] }
  const api = {
    state: async () => state,
    chat: async (id) => { calls.push(['chat', id]); return [{ id: 'old', text: 'history', from: id, at: 1 }] },
    send: async (id, text) => { calls.push(['send', id]); return { id: 'sent', text, from: 'me', at: 2 } },
    markRead: async (id) => { calls.push(['markRead', id]) },
    openExternal: async (...args) => { calls.push(['provider', ...args]) }
  }
  const window = { gamekins: { social: api, app: { openExternal: async (url) => calls.push(['external', url]) },
    on: { social: (fn) => { events.state = fn }, socialMessage: (fn) => { events.message = fn } } } }
  const cache = new Map()
  function load(file) {
    file = resolve(file.endsWith('.ts') ? file : file + '.ts')
    if (file.endsWith('/shared/distribution.ts') || file.endsWith('\\shared\\distribution.ts')) return { STORE_DISTRIBUTION: store }
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    new Function('require', 'module', 'exports', 'window', 'document', 'globalThis', code)(
      (id) => id.startsWith('.') ? load(resolve(dirname(file), id)) : require(id),
      module, module.exports, window, { hasFocus: () => true }, { localStorage: storage })
    return module.exports
  }
  return { social: load(resolve(__dirname, '../src/lib/social.ts')),
    safety: load(resolve(__dirname, '../src/lib/socialSafety.ts')), events, calls, state, storage }
}

test('Store edition never fetches, caches, marks read or sends native chat', async () => {
  const f = fixture(true)
  f.social.startSocial(); await tick()
  assert.deepEqual(f.social.useSocial.getState().state.unread, {})
  assert.equal(f.social.useSocial.getState().state.networks[0].canChat, false)
  await f.social.useSocial.getState().openChat(STEAM)
  await f.social.useSocial.getState().openChat(EPIC)
  await f.social.useSocial.getState().openChat(GOG)
  await assert.rejects(f.social.useSocial.getState().send(EPIC, 'must never be sent'), /provider/)
  f.events.message({ friendId: EPIC, message: { id: 'incoming', text: 'must never be cached' } })
  f.social.useSocial.getState().setOpen(true)
  assert.deepEqual(f.social.useSocial.getState().chats, {})
  assert.equal(f.social.useSocial.getState().chatWith, null)
  assert.equal(f.calls.some(([name]) => ['chat', 'send', 'markRead'].includes(name)), false)
  assert.deepEqual(f.calls[0], ['provider', STEAM, 'chat'])
  assert.deepEqual(f.calls[1], ['external', f.safety.PROVIDER_SAFETY.epic])
  assert.deepEqual(f.calls[2], ['provider', GOG, 'profile'])
  assert.equal(f.social.unreadTotal(f.state), 0)
})

test('local block, hide and removal persist across restart and filter provider updates/messages', async () => {
  const f = fixture()
  f.social.startSocial(); await tick()
  await f.social.useSocial.getState().openChat(EPIC)
  assert.equal(f.social.useSocial.getState().chats[EPIC].length, 1)
  f.safety.useSocialSafety.getState().restrict(EPIC, 'Epic friend', 'blocked')
  f.safety.useSocialSafety.getState().restrict(STEAM, 'Steam friend', 'hidden')
  f.safety.useSocialSafety.getState().restrict(GOG, 'GOG friend', 'removed')
  f.events.state(f.state)
  f.events.message({ friendId: EPIC, message: { id: 'blocked', text: 'hidden content' } })
  const current = f.social.useSocial.getState()
  assert.deepEqual(current.state.friends, [])
  assert.deepEqual(current.state.requests, [])
  assert.deepEqual(current.state.unread, {})
  assert.deepEqual(current.chats, {})
  assert.equal(current.chatWith, null)
  await assert.rejects(current.send(EPIC, 'blocked'), /hidden or blocked/)
  const restarted = fixture(false, f.storage)
  restarted.social.startSocial(); await tick()
  assert.deepEqual(restarted.social.useSocial.getState().state.friends, [])
  assert.equal(restarted.safety.useSocialSafety.getState().entries.length, 3)
  restarted.safety.useSocialSafety.getState().restore(EPIC)
  assert.deepEqual(restarted.social.useSocial.getState().state.friends.map((friend) => friend.id), [EPIC])
  assert.equal(restarted.calls.some(([name]) => ['provider', 'external', 'send'].includes(name)), false)
})

test('failed persistence does not claim to save a block; corrupt entries are ignored', () => {
  const f = fixture(false, { getItem: () => '[]', setItem: () => { throw new Error('quota') } })
  assert.throws(() => f.safety.useSocialSafety.getState().restrict(EPIC, 'friend', 'blocked'), /Could not save/)
  assert.deepEqual(f.safety.useSocialSafety.getState().entries, [])
  const corrupt = fixture(false, { getItem: () => '[{"id":"javascript:bad","displayName":"x","restriction":"blocked"}]', setItem() {} })
  assert.deepEqual(corrupt.safety.useSocialSafety.getState().entries, [])
})

test('report drafts have only the private recipient and are never automatically sent', () => {
  const f = fixture(true)
  const link = new URL(f.safety.safetyReportUrl(EPIC, 'name?cc=attacker@example.com\n&subject=other'))
  assert.equal(link.protocol, 'mailto:')
  assert.equal(link.pathname, 'erzen@quad-labs.com')
  assert.equal(link.searchParams.get('subject'), 'Gamekins safety report')
  assert.equal(link.searchParams.has('cc'), false)
  assert.match(link.searchParams.get('body'), /Provider account: epic:/)
  assert.deepEqual(f.calls, [])
})
