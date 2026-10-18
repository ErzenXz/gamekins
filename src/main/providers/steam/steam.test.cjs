// Offline unit checks for the Steam provider: node --test src/main/providers/steam/steam.test.cjs
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

const noNetwork = { net: { fetch: async () => { throw new Error('no network in tests') } } }
const vdf = load(join(__dirname, 'vdf.ts'))
const local = load(join(__dirname, 'local.ts'))
const api = load(join(__dirname, 'api.ts'), { electron: noNetwork })

const ME = '76561197960287930'
const FRIEND = '76561197960265728'
const ASKER = '76561197960265729'
const ASKED = '76561197960265730'

// ───────── real-world samples ─────────

const LIBRARY_FOLDERS = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
		"contentid"		"7067837422423560466"
		"totalsize"		"0"
		"update_clean_bytes_tally"		"2149003425"
		"time_last_update_verified"		"1792171228"
		"apps"
		{
			"730"		"73918888730"
			"228980"		"1057332804"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"label"		""
		"contentid"		"7678671697225291705"
		"totalsize"		"480085274624"
		"apps"
		{
			"367520"		"5231995691"
		}
	}
}
`

const OLD_LIBRARY_FOLDERS = `"LibraryFolders"
{
	"TimeNextStatsReport"		"1561832478"
	"ContentStatsID"		"-158337411110787451"
	"1"		"D:\\\\Games\\\\Steam"
	"2"		"E:\\\\SteamLibrary"
}
`

const CS2_MANIFEST = `"AppState"
{
	"appid"		"730"
	"universe"		"1"
	"LauncherPath"		"C:\\\\Program Files (x86)\\\\Steam\\\\steam.exe"
	"name"		"Counter-Strike 2"
	"StateFlags"		"4"
	"installdir"		"Counter-Strike Global Offensive"
	"LastUpdated"		"1792095720"
	"LastPlayed"		"1792288008"
	"SizeOnDisk"		"73918888730"
	"StagingSize"		"0"
	"buildid"		"25966348"
	"LastOwner"		"${ME}"
	"InstalledDepots"
	{
		"2347770"
		{
			"manifest"		"2520908610273941189"
			"size"		"65024032313"
		}
	}
	"SharedDepots"
	{
		"228988"		"228980"
	}
	"UserConfig"
	{
		"language"		"english"
		"BetaKey"		"public"
	}
}
`

const LOGIN_USERS = `"users"
{
	"${ME}"
	{
		"AccountName"		"someone"
		"PersonaName"		"Older Me"
		"RememberPassword"		"1"
		"MostRecent"		"0"
		"Timestamp"		"1700000000"
	}
	"${FRIEND}"
	{
		"AccountName"		"other"
		"PersonaName"		"Current"
		"MostRecent"		"1"
		"Timestamp"		"1600000000"
	}
}
`

// ───────── VDF ─────────

test('parses nested libraryfolders.vdf with escaped Windows paths', () => {
  const doc = vdf.parseVdf(LIBRARY_FOLDERS)
  assert.equal(doc.libraryfolders['0'].path, 'C:\\Program Files (x86)\\Steam')
  assert.equal(doc.libraryfolders['0'].apps['730'], '73918888730')
  assert.equal(doc.libraryfolders['1'].label, '')
  assert.deepEqual(local.parseLibraryFolders(LIBRARY_FOLDERS), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary'])
})

test('library list starts with the Steam folder and dedupes it; the old flat format works too', () => {
  const libs = local.parseLibraryFolders(LIBRARY_FOLDERS, 'C:\\Program Files (x86)\\Steam')
  assert.equal(libs.length, process.platform === 'linux' ? 3 : 2) // case-insensitive paths on Windows/macOS
  assert.deepEqual(local.parseLibraryFolders(OLD_LIBRARY_FOLDERS), ['D:\\Games\\Steam', 'E:\\SteamLibrary'])
})

test('comments, bare tokens, conditionals, escapes and a BOM', () => {
  const doc = vdf.parseVdf('\ufeff// header comment\n"Root" // trailing\n{\n  bare value [$WIN32]\n  "quote" "say \\"hi\\"\\n\\tdone"\n  "path" "C:\\Odd\\path"\n  Nested { "k" "v" }\n}\n')
  assert.equal(doc.Root.bare, 'value')
  assert.equal(doc.Root.quote, 'say "hi"\n\tdone')
  assert.equal(doc.Root.path, 'C:\\Odd\\path') // unknown escapes are kept literally
  assert.deepEqual(doc.Root.Nested, { k: 'v' })
  assert.equal(vdf.vdfString(vdf.vdfGet(doc, 'root'), 'QUOTE'), 'say "hi"\n\tdone')
  assert.equal(vdf.vdfObject(doc.Root, 'nested').k, 'v')
})

test('duplicate sections merge, last string wins, __proto__ is plain data', () => {
  const doc = vdf.parseVdf('"a" { "x" "1" } "a" { "y" "2" } "s" "old" "s" "new" "__proto__" { "polluted" "yes" }')
  assert.deepEqual(doc.a, { x: '1', y: '2' })
  assert.equal(doc.s, 'new')
  assert.equal({}.polluted, undefined)
  assert.equal(Object.getPrototypeOf(doc), Object.prototype)
  assert.equal(doc.__proto__.polluted, 'yes')
})

test('malformed input throws VdfError', () => {
  for (const bad of ['"a" { "b" "c"', '"a" "b" }', '"a" "unterminated', '{ "a" "b" }', '"a" { "b" }']) {
    assert.throws(() => vdf.parseVdf(bad), (err) => err.name === 'VdfError', bad)
  }
  assert.deepEqual(vdf.parseVdf(''), {})
  assert.deepEqual(vdf.parseVdf('#base "other.vdf"\n"k" "v"'), { k: 'v' })
})

// ───────── manifests → Gamekins records ─────────

test('appmanifest maps to a Steam ProviderGame and InstalledInfo', () => {
  const lib = 'D:\\SteamLibrary'
  const m = local.parseAppManifest(CS2_MANIFEST, lib)
  assert.equal(m.appid, '730')
  assert.equal(m.name, 'Counter-Strike 2')
  assert.equal(m.installdir, 'Counter-Strike Global Offensive')
  assert.equal(m.sizeOnDisk, 73918888730)
  assert.equal(m.buildid, '25966348')
  assert.equal(m.stateFlags, 4)
  assert.equal(m.lastPlayed, 1792288008)
  assert.ok(local.isInstalled(m))
  assert.ok(!local.isSteamTool(m))

  const g = local.manifestToGame(m, 'Windows')
  assert.equal(g.key, 'steam:730')
  assert.equal(g.provider, 'steam')
  assert.equal(g.appName, '730')
  assert.equal(g.title, 'Counter-Strike 2')
  assert.equal(g.thirdPartyManagedApp, undefined)
  assert.deepEqual(g.platforms, ['Windows'])
  assert.equal(g.storeUrl, 'https://store.steampowered.com/app/730/')
  assert.match(g.images.tall, /\/apps\/730\/library_600x900\.jpg$/)
  assert.match(g.images.wide, /\/apps\/730\/library_hero\.jpg$/)
  assert.match(g.images.logo, /\/apps\/730\/logo\.png$/)
  assert.match(g.images.thumb, /\/apps\/730\/header\.jpg$/)

  const i = local.manifestToInstall(m, 'Windows')
  assert.equal(i.path, join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive'))
  assert.equal(i.version, '25966348')
  assert.equal(i.sizeBytes, 73918888730)
  assert.equal(i.source, local.STEAM_INSTALL_SOURCE)
  assert.equal(i.executable, '')
  assert.equal(i.ownsFolder, false)
  assert.equal(i.installedAt, 1792095720 * 1000)
})

test('skips redistributables and unfinished installs; rejects non-app files', () => {
  assert.ok(local.isSteamTool({ appid: '228980', name: 'Steamworks Common Redistributables' }))
  assert.ok(local.isSteamTool({ appid: '1', name: 'Some Redistributable Pack' }))
  assert.ok(local.isSteamTool({ appid: '1493710', name: 'Proton Experimental' }))
  assert.ok(!local.isSteamTool({ appid: '2', name: 'Protonaut' }))
  const downloading = local.parseAppManifest(CS2_MANIFEST.replace('"StateFlags"\t\t"4"', '"StateFlags"\t\t"1026"'), 'C:\\S')
  assert.equal(downloading.stateFlags, 1026)
  assert.ok(!local.isInstalled(downloading))
  assert.ok(local.isInstalled({ ...downloading, stateFlags: 6 })) // installed, update pending
  assert.equal(local.parseAppManifest('"Other" { "appid" "1" }', 'C:\\S'), null)
  assert.equal(local.parseAppManifest('"AppState" { "appid" "abc" }', 'C:\\S'), null)
  assert.equal(local.parseAppManifest('"AppState" { "appid" "42" }', 'C:\\S').name, 'Steam app 42')
})

test('the Steam folder keeps the spelling from libraryfolders.vdf; soundtracks are skipped', () => {
  if (process.platform !== 'linux') {
    assert.deepEqual(local.parseLibraryFolders(LIBRARY_FOLDERS, 'c:/program files (x86)/steam'.replace(/\//g, '\\')), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary'])
  }
  assert.deepEqual(local.parseLibraryFolders(OLD_LIBRARY_FOLDERS, 'C:\\Steam'), ['C:\\Steam', 'D:\\Games\\Steam', 'E:\\SteamLibrary'])
  assert.ok(local.isSteamTool({ appid: '323140', name: 'Half-Life 2 Soundtrack' }))
})

test('store items give hashed art paths for newer apps', () => {
  const art = api.storeItemImages({
    appid: 3472550,
    success: 1,
    assets: {
      asset_url_format: 'steam/apps/3472550/${FILENAME}?t=1747736724',
      library_capsule: '09de/library_600x900.jpg',
      library_hero: '3e9c/library_hero.jpg',
      header: '4a18/header.jpg'
    }
  })
  assert.deepEqual(art, {
    tall: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3472550/09de/library_600x900.jpg?t=1747736724',
    wide: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3472550/3e9c/library_hero.jpg?t=1747736724',
    thumb: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3472550/4a18/header.jpg?t=1747736724'
  })
  assert.deepEqual(api.storeItemImages({ appid: 1, success: 1 }), {})
})

test('reads SteamPath from reg query output', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n\r\n'
  assert.equal(local.parseRegQuery(out, 'SteamPath'), 'c:/program files (x86)/steam')
  assert.equal(local.parseRegQuery(out, 'SteamExe'), null)
})

test('loginusers.vdf: MostRecent wins, else the latest timestamp', () => {
  const users = local.parseLoginUsers(LOGIN_USERS)
  assert.equal(users.length, 2)
  assert.equal(local.mostRecentUser(users).personaName, 'Current')
  const noFlag = users.map((u) => ({ ...u, mostRecent: false }))
  assert.equal(local.mostRecentUser(noFlag).steamId, ME)
  assert.equal(local.mostRecentUser([]), null)
})

// ───────── sign-in cookie & token ─────────

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const JWT = `${b64url({ typ: 'JWT', alg: 'EdDSA' })}.${b64url({ iss: 'steam', sub: ME, aud: ['web:community'], exp: 1792400000, iat: 1792313600 })}.c2lnbmF0dXJl`

test('parses the steamLoginSecure cookie (URL-encoded or not)', () => {
  assert.deepEqual(api.parseSteamLoginSecure(`${ME}%7C%7C${JWT}`), { steamId: ME, token: JWT })
  assert.deepEqual(api.parseSteamLoginSecure(`${ME}||${JWT}`), { steamId: ME, token: JWT })
  assert.equal(api.parseSteamLoginSecure(''), null)
  assert.equal(api.parseSteamLoginSecure('deleted'), null)
  assert.equal(api.parseSteamLoginSecure(`123%7C%7C${JWT}`), null)
  assert.equal(api.parseSteamLoginSecure(`${ME}%7C%7Cnot-a-jwt`), null)
})

test('decodes the JWT expiry', () => {
  const claims = api.decodeJwt(JWT)
  assert.equal(claims.sub, ME)
  assert.deepEqual(claims.aud, ['web:community'])
  assert.equal(api.jwtExpiry(JWT), 1792400000 * 1000)
  assert.equal(api.decodeJwt('x.!!!.y'), null)
  assert.equal(api.jwtExpiry(`${b64url({})}.${b64url({ sub: ME })}.x`), null)
})

// ───────── presence ─────────

test('persona states map to friend status and activity', () => {
  const p = (personaState, extra = {}) => api.personaPresence({ personaState, ...extra })
  assert.deepEqual(p(0), { status: 'offline' })
  assert.deepEqual(p(1), { status: 'online', activity: undefined })
  assert.deepEqual(p(2), { status: 'away', activity: 'Busy' })
  assert.deepEqual(p(3), { status: 'away', activity: undefined })
  assert.deepEqual(p(4), { status: 'away', activity: 'Snooze' })
  assert.deepEqual(p(5), { status: 'online', activity: 'Looking to trade' })
  assert.deepEqual(p(6), { status: 'online', activity: 'Looking to play' })
  assert.deepEqual(p(1, { gameId: '730', gameName: 'Counter-Strike 2' }), { status: 'playing', activity: 'Playing Counter-Strike 2', app: 'Counter-Strike 2' })
  assert.deepEqual(p(3, { gameId: '570' }), { status: 'playing', activity: 'Playing a game', app: undefined })
  assert.deepEqual(p(0, { gameId: '730', gameName: 'Counter-Strike 2' }), { status: 'offline' }) // invisible
})

test('friends list relationships split into friends and requests', () => {
  const { splitRelationships, steamFriend } = load(join(__dirname, 'social.ts'), { electron: noNetwork })
  const out = splitRelationships([
    { ulfriendid: FRIEND, efriendrelationship: 3 },
    { ulfriendid: ASKER, efriendrelationship: 2 },
    { ulfriendid: ASKED, efriendrelationship: 4 },
    { ulfriendid: '76561197960265731', efriendrelationship: 1 }
  ])
  assert.deepEqual(out.friends, [FRIEND])
  assert.deepEqual(out.requests, [{ id: ASKER, direction: 'incoming' }, { id: ASKED, direction: 'outgoing' }])
  const f = steamFriend(FRIEND, { steamId: FRIEND, name: 'Buddy', personaState: 0, lastLogoff: 1792000000 })
  assert.deepEqual(f, { id: FRIEND, displayName: 'Buddy', status: 'offline', lastOnline: 1792000000 * 1000 })
  assert.equal(steamFriend(FRIEND, undefined).displayName, 'Steam player')
})

// ───────── SteamSocial against a fake Web API ─────────

function fakeSteam(handlers) {
  const calls = []
  const fetch = async (url) => {
    const u = new URL(url)
    calls.push(u)
    const handler = handlers[u.pathname]
    if (!handler) return new Response('not found', { status: 404 })
    const [status, body] = handler(u)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  return { calls, electron: { net: { fetch } } }
}

test('SteamSocial loads friends, falls back from GetPlayerSummaries to GetPlayerLinkDetails, stays read-only', async () => {
  const steam = fakeSteam({
    '/IFriendsListService/GetFriendsList/v1/': () => [200, { response: { friendslist: { friends: [
      { ulfriendid: FRIEND, efriendrelationship: 3 },
      { ulfriendid: ASKER, efriendrelationship: 2 }
    ] } } }],
    '/ISteamUser/GetPlayerSummaries/v2/': () => [400, '<html>Required parameter \'key\' is missing</html>'],
    '/IPlayerService/GetPlayerLinkDetails/v1/': (u) => [200, { response: { accounts: [...u.searchParams.entries()]
      .filter(([k]) => k.startsWith('steamids['))
      .map(([, id]) => ({
        public_data: { steamid: id, persona_name: id === ME ? 'Me' : id === FRIEND ? 'Buddy' : 'Asker' },
        private_data: id === FRIEND ? { persona_state: 1, game_id: '730', game_extra_info: 'Counter-Strike 2' } : { persona_state: 0 }
      })) } }]
  })
  const { SteamSocial } = load(join(__dirname, 'social.ts'), { electron: steam.electron })
  const s = new SteamSocial(async () => ({ steamId: ME, displayName: 'Me', token: 'tok' }))
  await s.start('online')
  const state = s.state()
  s.stop()
  assert.equal(state.available, true)
  assert.equal(state.connection, 'online')
  assert.equal(state.error, undefined)
  assert.deepEqual(state.me, { id: ME, displayName: 'Me' })
  assert.equal(state.friends.length, 1)
  assert.equal(state.friends[0].displayName, 'Buddy')
  assert.equal(state.friends[0].status, 'playing')
  assert.equal(state.friends[0].activity, 'Playing Counter-Strike 2')
  assert.deepEqual(state.requests, [{ id: ASKER, direction: 'incoming', displayName: 'Asker' }])
  assert.ok(steam.calls.every((u) => u.searchParams.get('access_token') === 'tok' && !u.searchParams.has('key')))
  assert.equal(s.canChat, false)
  assert.equal(s.canAddFriends, false)
  assert.deepEqual(s.chat(FRIEND), [])
  assert.throws(() => s.sendMessage(FRIEND, 'hi'), /Steam client/)
  assert.equal(s.state().available, false)
})

test('SteamSocial retries once with a forced token refresh on 401', async () => {
  const seen = []
  const steam = fakeSteam({
    '/IFriendsListService/GetFriendsList/v1/': (u) => {
      seen.push(u.searchParams.get('access_token'))
      return u.searchParams.get('access_token') === 'old' ? [401, 'Unauthorized'] : [200, { response: { friendslist: { friends: [] } } }]
    },
    '/ISteamUser/GetPlayerSummaries/v2/': () => [200, { response: { players: [{ steamid: ME, personaname: 'Fresh Me', personastate: 1 }] } }]
  })
  const { SteamSocial } = load(join(__dirname, 'social.ts'), { electron: steam.electron })
  const forced = []
  const s = new SteamSocial(async (opts) => {
    forced.push(!!opts?.forceRefresh)
    return { steamId: ME, displayName: 'Me', token: opts?.forceRefresh ? 'new' : 'old' }
  })
  await s.start('online')
  const state = s.state()
  s.stop()
  assert.deepEqual(seen, ['old', 'new'])
  assert.ok(forced.includes(true))
  assert.equal(state.connection, 'online')
  assert.equal(state.me.displayName, 'Fresh Me')
})

test('SteamSocial reports errors without throwing', async () => {
  const steam = fakeSteam({ '/IFriendsListService/GetFriendsList/v1/': () => [500, 'boom'] })
  const { SteamSocial } = load(join(__dirname, 'social.ts'), { electron: steam.electron })
  const s = new SteamSocial(async () => ({ steamId: ME, displayName: 'Me', token: 't' }))
  // 500s are retried with backoff; keep the test fast.
  const realSetTimeout = global.setTimeout
  global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 60_000 ? ms : 0, ...rest)
  try {
    await s.start('online')
  } finally {
    global.setTimeout = realSetTimeout
  }
  const state = s.state()
  s.stop()
  assert.equal(state.connection, 'error')
  assert.match(state.error, /Steam friends/)
  assert.deepEqual(state.friends, [])
})
