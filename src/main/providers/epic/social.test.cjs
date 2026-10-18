// Offline unit checks for Epic friends/presence/chat: node --test src/main/providers/epic/social.test.cjs
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

function load(filename, stubs = {}) {
  const cache = new Map()
  const loadOne = (file) => {
    file = resolve(file)
    if (cache.has(file)) return cache.get(file).exports
    const m = new Module(file, module)
    cache.set(file, m)
    m.filename = file
    m.paths = module.paths
    m.require = (name) => {
      if (stubs[name]) return stubs[name]
      if (name.startsWith('.')) return loadOne(resolve(dirname(file), `${name}.ts`))
      if (name.startsWith('node:')) return require(name)
      throw new Error(`Unexpected dependency: ${name}`)
    }
    const out = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
    m._compile(out.outputText, file)
    return m.exports
  }
  return loadOne(filename)
}

const xmpp = load(join(__dirname, 'xmpp.ts'))
const FRIEND = 'a'.repeat(32)
const ME = 'b'.repeat(32)

function social() {
  const sent = []
  const { EpicSocial } = load(join(__dirname, 'social.ts'), {
    './api': { fetchRetry: async () => { throw new Error('no network in tests') }, USER_AGENT: 'test' }
  })
  const s = new EpicSocial(async () => ({ accountId: ME, displayName: 'Me', token: 't' }))
  s.me = { accountId: ME, displayName: 'Me', token: 't' }
  s.friends.set(FRIEND, { accountId: FRIEND })
  s.names.set(FRIEND, 'Buddy')
  s.xmpp = { ready: true, send: (x) => sent.push(x), close() {} }
  return { s, sent }
}

test('parses stanzas: attributes, nested text, entities and CDATA', () => {
  const n = xmpp.parseXml(`<message from="${FRIEND}@prod.ol.epicgames.com/V2:Fortnite:WIN::AB" type="chat"><body>hi &amp; &lt;3 &#128512;</body><x><![CDATA[<raw>]]></x></message>`)
  assert.equal(n.name, 'message')
  assert.equal(n.attrs.type, 'chat')
  assert.equal(xmpp.child(n, 'body').text, 'hi & <3 😀')
  assert.equal(xmpp.child(n, 'x').text, '<raw>')
  assert.equal(xmpp.parseXml('<stream:features><mechanisms/></stream:features>').name, 'stream:features')
  assert.equal(xmpp.escapeXml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;')
})

test('Fortnite presence shows the friend as playing with their status text', () => {
  const { s } = social()
  const status = JSON.stringify({ Status: 'Battle Royale Lobby - 1 / 4', bIsPlaying: true, ProductName: 'Fortnite' })
  s.onPresence(xmpp.parseXml(`<presence from="${FRIEND}@prod.ol.epicgames.com/V2:Fortnite:WIN::AB"><status>${xmpp.escapeXml(status)}</status></presence>`))
  const f = s.state().friends[0]
  assert.equal(f.status, 'playing')
  assert.equal(f.activity, 'Battle Royale Lobby - 1 / 4')
  assert.equal(f.app, 'Fortnite')
})

test('launcher presence is online, away maps from <show>, unavailable goes offline', () => {
  const { s } = social()
  const from = `${FRIEND}@prod.ol.epicgames.com/V2:launcher:WIN::CD`
  s.onPresence(xmpp.parseXml(`<presence from="${from}"><status>{"Status":"","bIsPlaying":false}</status></presence>`))
  assert.equal(s.state().friends[0].status, 'online')
  assert.equal(s.state().friends[0].app, undefined)
  s.onPresence(xmpp.parseXml(`<presence from="${from}"><show>away</show><status>{}</status></presence>`))
  assert.equal(s.state().friends[0].status, 'away')
  s.onPresence(xmpp.parseXml(`<presence from="${from}" type="unavailable"/>`))
  assert.equal(s.state().friends[0].status, 'offline')
  assert.ok(s.state().friends[0].lastOnline > 0)
})

test('playing in one app wins over being idle in another', () => {
  const { s } = social()
  s.onPresence(xmpp.parseXml(`<presence from="${FRIEND}@prod.ol.epicgames.com/V2:launcher:WIN::1"><show>away</show><status>{}</status></presence>`))
  s.onPresence(xmpp.parseXml(`<presence from="${FRIEND}@prod.ol.epicgames.com/V2:Fortnite:WIN::2"><status>{"Status":"In match","bIsPlaying":true}</status></presence>`))
  assert.equal(s.state().friends[0].status, 'playing')
  assert.equal(s.state().friends[0].activity, 'In match')
})

test('presence from strangers and our own resources is ignored', () => {
  const { s } = social()
  s.onPresence(xmpp.parseXml(`<presence from="${'c'.repeat(32)}@prod.ol.epicgames.com/V2:launcher:WIN::1"><status>{}</status></presence>`))
  s.onPresence(xmpp.parseXml(`<presence from="${ME}@prod.ol.epicgames.com/V2:launcher:WIN::1"><status>{}</status></presence>`))
  assert.equal(s.state().friends.length, 1)
  assert.equal(s.state().friends[0].status, 'offline')
})

test('incoming chat from a friend is stored, counted unread and emitted; strangers are dropped', () => {
  const { s } = social()
  const got = []
  s.on('message', (m) => got.push(m))
  s.onMessage(xmpp.parseXml(`<message type="chat" from="${FRIEND}@prod.ol.epicgames.com/V2:Fortnite:WIN::AB"><body>gg</body></message>`))
  s.onMessage(xmpp.parseXml(`<message type="chat" from="${'c'.repeat(32)}@prod.ol.epicgames.com/x"><body>spam</body></message>`))
  assert.equal(got.length, 1)
  assert.equal(s.chat(FRIEND)[0].text, 'gg')
  assert.equal(s.state().unread[FRIEND], 1)
  s.markRead(FRIEND)
  assert.equal(s.state().unread[FRIEND], undefined)
})

test('sending escapes the body and only goes to friends', () => {
  const { s, sent } = social()
  const m = s.sendMessage(FRIEND, '  <b>hi</b> & bye  ')
  assert.equal(m.text, '<b>hi</b> & bye')
  assert.match(sent.at(-1), new RegExp(`^<message type="chat" to="${FRIEND}@prod\\.ol\\.epicgames\\.com" id="[^"]+"><body>&lt;b&gt;hi&lt;/b&gt; &amp; bye</body></message>$`))
  assert.throws(() => s.sendMessage('c'.repeat(32), 'hi'), /only message friends/)
  assert.throws(() => s.sendMessage(FRIEND, '   '), /empty/)
})

test('our presence advertises the game being played and away status', () => {
  const { s, sent } = social()
  s.setActivity('Rocket League')
  let status = JSON.parse(xmpp.parseXml(sent.at(-1)).children.find((c) => c.name === 'status').text)
  assert.equal(status.Status, 'Playing Rocket League')
  assert.equal(status.bIsPlaying, true)
  s.status = 'online'
  s.setStatus('away')
  assert.match(sent.at(-1), /<show>away<\/show>/)
  s.setActivity(null)
  status = JSON.parse(xmpp.parseXml(sent.at(-1)).children.find((c) => c.name === 'status').text)
  assert.equal(status.bIsPlaying, false)
})

test('friend-list notices from the service schedule a refresh', async () => {
  const { s } = social()
  let refreshed = 0
  s.refresh = async () => { refreshed++ }
  s.onMessage(xmpp.parseXml(`<message from="xmpp-admin@prod.ol.epicgames.com"><body>{"type":"FRIENDSHIP_REQUEST","from":"x"}</body></message>`))
  await new Promise((r) => setTimeout(r, 900))
  assert.equal(refreshed, 1)
  s.stop()
})
