// Offline checks for the cross-store friends hub: node --test src/main/core/socialHub.test.cjs
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

function loadHub() {
  const file = join(__dirname, 'socialHub.ts')
  const m = new Module(file, module)
  m.filename = file
  m.paths = module.paths
  m.require = (name) => (name.startsWith('node:') ? require(name) : {})
  m._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, file)
  return m.exports.SocialHub
}

function fakeNetwork(provider, { canChat, friends }) {
  const n = new EventEmitter()
  Object.assign(n, {
    provider, name: provider === 'epic' ? 'Epic Games' : 'Steam', canChat, canAddFriends: canChat,
    started: false, status: null, activity: null, sent: [], read: [],
    async start(status) { this.started = true; this.status = status },
    stop() { this.started = false },
    setStatus(s) { this.status = s },
    setActivity(t) { this.activity = t },
    state() {
      return { available: this.started, connection: 'online', me: { id: 'me', displayName: 'Me' }, myStatus: 'online', friends, requests: [{ id: 'r1', displayName: 'Req', direction: 'incoming' }], unread: { [friends[0].id]: 2 }, loading: false }
    },
    async refresh() {},
    chat: () => [{ id: 'm1', from: friends[0].id, text: 'yo', at: 1 }],
    sendMessage(id, text) { this.sent.push([id, text]); return { id: 'x', from: 'me', text, at: 2 } },
    markRead(id) { this.read.push(id) },
    async remove(id) { this.removed = id }
  })
  return n
}

test('merges stores into one list with store-prefixed ids, sorted by status', async () => {
  const SocialHub = loadHub()
  const hub = new SocialHub()
  const epic = fakeNetwork('epic', { canChat: true, friends: [{ id: 'a'.repeat(32), displayName: 'Zed', status: 'offline' }] })
  const steam = fakeNetwork('steam', { canChat: false, friends: [{ id: '76561198000000001', displayName: 'Amy', status: 'playing', activity: 'Playing CS2' }] })
  hub.register(epic)
  hub.register(steam)
  hub.setStatus('away')
  await hub.start('epic')
  await hub.start('steam')
  assert.equal(epic.status, 'away')
  const s = hub.state()
  assert.deepEqual(s.friends.map((f) => f.id), ['steam:76561198000000001', 'epic:' + 'a'.repeat(32)])
  assert.equal(s.friends[0].provider, 'steam')
  assert.equal(s.friends[0].accountId, '76561198000000001')
  assert.deepEqual(s.networks.map((n) => [n.provider, n.canChat]), [['epic', true], ['steam', false]])
  assert.equal(s.unread['epic:' + 'a'.repeat(32)], 2)
  assert.deepEqual(s.requests.map((r) => r.id).sort(), ['epic:r1', 'steam:r1'])
})

test('routes actions to the owning store and guards chat', async () => {
  const SocialHub = loadHub()
  const hub = new SocialHub()
  const epic = fakeNetwork('epic', { canChat: true, friends: [{ id: 'e1', displayName: 'E', status: 'online' }] })
  const steam = fakeNetwork('steam', { canChat: false, friends: [{ id: '1', displayName: 'S', status: 'online' }] })
  hub.register(epic)
  hub.register(steam)
  await hub.start('epic')
  await hub.start('steam')
  hub.sendMessage('epic:e1', 'hi')
  assert.deepEqual(epic.sent, [['e1', 'hi']])
  assert.throws(() => hub.sendMessage('steam:1', 'hi'), /Steam app/)
  assert.equal(hub.chat('epic:e1')[0].from, 'epic:e1')
  hub.markRead('epic:e1')
  assert.deepEqual(epic.read, ['e1'])
  await hub.remove('epic:e1')
  assert.equal(epic.removed, 'e1')
  await assert.rejects(hub.addFriend('steam', 'x'), /Steam app/)
  hub.stop('steam')
  assert.throws(() => hub.chat('steam:1'), /not signed in/)
  assert.equal(hub.state().networks.length, 1)
})

test('incoming messages are re-tagged with the store prefix', async () => {
  const SocialHub = loadHub()
  const hub = new SocialHub()
  const epic = fakeNetwork('epic', { canChat: true, friends: [{ id: 'e1', displayName: 'E', status: 'online' }] })
  hub.register(epic)
  await hub.start('epic')
  const got = []
  hub.on('message', (m) => got.push(m))
  epic.emit('message', { friendId: 'e1', message: { id: '1', from: 'e1', text: 'gg', at: 1 } })
  assert.deepEqual(got[0], { friendId: 'epic:e1', message: { id: '1', from: 'epic:e1', text: 'gg', at: 1 } })
})

test('external links are built from validated ids only', async () => {
  const SocialHub = loadHub()
  const hub = new SocialHub()
  const steam = fakeNetwork('steam', { canChat: false, friends: [{ id: '76561198000000001', displayName: 'Amy', status: 'online' }] })
  hub.register(steam)
  await hub.start('steam')
  assert.equal(hub.externalLink('steam:76561198000000001', 'chat'), 'steam://friends/message/76561198000000001')
  assert.equal(hub.externalLink('steam:76561198000000001', 'profile'), 'https://steamcommunity.com/profiles/76561198000000001')
  assert.equal(hub.externalLink('steam:1;rungameid/730', 'chat'), null)
  assert.equal(hub.externalLink('epic:abc', 'chat'), null)
})
