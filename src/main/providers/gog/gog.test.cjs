// Offline unit checks for the GOG provider: node --test src/main/providers/gog/gog.test.cjs
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
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

const offline = { fetchRetry: async () => { throw new Error('no network in tests') } }
const api = load(join(__dirname, 'api.ts'), { '../epic/api': offline })
const discovery = load(join(__dirname, 'discovery.ts'))

const WITCHER_INFO = JSON.stringify({
  buildId: '51311234',
  clientId: '12345',
  gameId: '1207658930',
  language: 'English',
  name: 'The Witcher 2: Assassins of Kings Enhanced Edition',
  playTasks: [
    { category: 'document', isPrimary: false, name: 'Manual', path: 'manual.pdf', type: 'FileTask' },
    { category: 'game', isPrimary: true, name: 'The Witcher 2', path: 'bin\\witcher2.exe', arguments: '-nointro', workingDir: 'bin', type: 'FileTask' },
    { category: 'other', link: 'https://www.gog.com/support', name: 'Support', type: 'URLTask' }
  ],
  rootGameId: '1207658930',
  version: 1
})

// ───────── goggame-<id>.info ─────────

test('info file: primary play task becomes the executable, args and working dir', () => {
  const info = discovery.parseInfoFile('\uFEFF' + WITCHER_INFO)
  assert.equal(info.gameId, '1207658930')
  assert.equal(info.buildId, '51311234')
  const root = join(tmpdir(), 'GOG Games', 'The Witcher 2')
  const installed = discovery.infoToInstalled(info, { root, platform: 'Windows', version: '3.4.4.1', installedAt: 1 })
  assert.deepEqual(installed, {
    path: root,
    version: '3.4.4.1',
    executable: join('bin', 'witcher2.exe'),
    launchCommand: '-nointro',
    workingDirectory: join(root, 'bin'),
    platform: 'Windows',
    sizeBytes: 0,
    source: 'gog',
    installedAt: 1
  })
  assert.equal(discovery.GOG_INSTALL_SOURCE, 'gog')
})

test('info file: falls back to the first game task, rejects junk and URL-only tasks', () => {
  const noPrimary = discovery.parseInfoFile(JSON.stringify({
    gameId: 1, playTasks: [{ type: 'URLTask', link: 'https://x' }, { category: 'game', path: 'DOSBOX\\DOSBox.exe', arguments: '-conf "..\\dosbox.conf"', type: 'FileTask' }]
  }))
  assert.equal(discovery.primaryTask(noPrimary).path, 'DOSBOX\\DOSBox.exe')
  const urlOnly = discovery.parseInfoFile(JSON.stringify({ gameId: '2', playTasks: [{ type: 'URLTask', link: 'https://x' }] }))
  assert.equal(discovery.infoToInstalled(urlOnly, { root: tmpdir(), platform: 'Windows' }), null)
  assert.equal(discovery.parseInfoFile('not json'), null)
  assert.equal(discovery.parseInfoFile(JSON.stringify({ gameId: '../evil' })), null)
  assert.equal(discovery.parseInfoFile(JSON.stringify(['x'])), null)
})

test('info file inside a macOS bundle resolves relative to Contents/Resources', () => {
  const bundle = join(tmpdir(), 'Applications', 'Game.app')
  const resources = join(bundle, 'Contents', 'Resources')
  const info = discovery.parseInfoFile(JSON.stringify({ gameId: '3', playTasks: [{ isPrimary: true, path: '../MacOS/Game', type: 'FileTask' }] }))
  const installed = discovery.infoToInstalled(info, { root: bundle, infoDir: resources, platform: 'Mac' })
  assert.equal(installed.path, bundle)
  assert.equal(installed.executable, join('Contents', 'MacOS', 'Game'))
})

// ───────── registry ─────────

const REG_OUTPUT = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658930',
  '    buildId    REG_SZ    51311234',
  '    dependsOn    REG_SZ    ',
  '    exe    REG_SZ    C:\\GOG Games\\The Witcher 2\\bin\\witcher2.exe',
  '    gameID    REG_SZ    1207658930',
  '    gameName    REG_SZ    The Witcher 2: Assassins of Kings Enhanced Edition',
  '    launchParam    REG_SZ    -nointro',
  '    path    REG_SZ    C:\\GOG Games\\The Witcher 2',
  '    ver    REG_SZ    3.4.4.1',
  '    workingDir    REG_SZ    C:\\GOG Games\\The Witcher 2\\bin',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207659999',
  '    dependsOn    REG_SZ    1207658930',
  '    gameName    REG_SZ    Some DLC',
  '    path    REG_SZ    C:\\GOG Games\\The Witcher 2',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\Odd Key',
  '    GAMEID    REG_SZ    1440000000',
  '    PATH    REG_SZ    D:\\Games\\Odd',
  '    EXE    REG_SZ    D:\\Games\\Odd\\odd.exe',
  ''
].join('\r\n')

test('registry: one entry per game key, case-insensitive values, DLC flagged', () => {
  const games = discovery.parseRegistry(REG_OUTPUT)
  assert.deepEqual([...games.keys()].sort(), ['1207658930', '1207659999', '1440000000'])
  const witcher = games.get('1207658930')
  assert.equal(witcher.values.gamename, 'The Witcher 2: Assassins of Kings Enhanced Edition')
  assert.equal(witcher.values.path, 'C:\\GOG Games\\The Witcher 2')
  assert.equal(witcher.values.dependson, '')
  assert.equal(discovery.isDlcEntry(witcher), false)
  assert.equal(discovery.isDlcEntry(games.get('1207659999')), true)
  assert.equal(games.get('1440000000').values.exe, 'D:\\Games\\Odd\\odd.exe')
  assert.equal(discovery.parseRegistry('').size, 0)
})

test('registry-only install (no .info file) uses exe, launchParam and workingDir', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
  const installed = discovery.registryToInstalled(discovery.parseRegistry(REG_OUTPUT).get('1207658930'), 5)
  assert.deepEqual(installed, {
    path: 'C:\\GOG Games\\The Witcher 2',
    version: '3.4.4.1',
    executable: 'bin\\witcher2.exe',
    launchCommand: '-nointro',
    workingDirectory: 'C:\\GOG Games\\The Witcher 2\\bin',
    platform: 'Windows',
    sizeBytes: 0,
    source: 'gog',
    installedAt: 5
  })
})

test('Windows scan: registry entries + .info files + untracked folders, skipping DLC', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gamekins-gog-'))
  try {
    const witcher = join(root, 'The Witcher 2')
    mkdirSync(join(witcher, 'bin'), { recursive: true })
    writeFileSync(join(witcher, 'bin', 'witcher2.exe'), '')
    writeFileSync(join(witcher, 'goggame-1207658930.info'), WITCHER_INFO)
    // DLC .info next to the game's must not replace it.
    writeFileSync(join(witcher, 'goggame-1207659999.info'), JSON.stringify({ gameId: '1207659999', rootGameId: '1207658930', playTasks: [] }))
    const portable = join(root, 'Portable Game')
    mkdirSync(portable)
    writeFileSync(join(portable, 'game.exe'), '')
    writeFileSync(join(portable, 'goggame-1500000000.info'), JSON.stringify({ gameId: '1500000000', playTasks: [{ isPrimary: true, path: 'game.exe', type: 'FileTask' }] }))
    const broken = join(root, 'Deleted Exe')
    mkdirSync(broken)
    writeFileSync(join(broken, 'goggame-1600000000.info'), JSON.stringify({ gameId: '1600000000', playTasks: [{ isPrimary: true, path: 'gone.exe', type: 'FileTask' }] }))

    const reg = REG_OUTPUT.split('C:\\GOG Games\\The Witcher 2').join(witcher)
    const calls = []
    const childProcess = {
      execFile: (cmd, args, opts, cb) => {
        calls.push(args[1])
        if (args[1].includes('WOW6432Node')) cb(null, reg, '')
        else cb(Object.assign(new Error('missing'), { code: 1 }), '', 'ERROR: The system was unable to find the specified registry key or value.')
      }
    }
    const d = load(join(__dirname, 'discovery.ts'), { 'node:child_process': childProcess })
    const found = await d.scanWindows([root])
    assert.deepEqual(calls, d.REGISTRY_KEYS)
    assert.deepEqual([...found.keys()].sort(), ['1207658930', '1500000000'])
    const w = found.get('1207658930')
    assert.equal(w.path, witcher)
    assert.equal(w.executable, join('bin', 'witcher2.exe'))
    assert.equal(w.version, '3.4.4.1')
    assert.equal(w.launchCommand, '-nointro')
    assert.equal(found.get('1500000000').path, portable)
    assert.equal(found.get('1500000000').source, 'gog')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows scan refuses to report "nothing installed" when reg cannot run', async () => {
  const d = load(join(__dirname, 'discovery.ts'), {
    'node:child_process': { execFile: (cmd, args, opts, cb) => cb(Object.assign(new Error('spawn reg ENOENT'), { code: 'ENOENT' }), '', '') }
  })
  const warn = console.warn
  console.warn = () => {}
  try {
    await assert.rejects(d.scanWindows([]), /registry/)
  } finally {
    console.warn = warn
  }
})

// ───────── library mapping ─────────

const HASH = 'ebed1d5546a4fa382d7d36db8aee7f298eac7db3a8dc2f4389120b5b7b3155a9'
const BOX = 'bd7a2173c9827d05fc6823b783fa86bde87bc55a908ecadf2c2c7d12a207a3f4'

test('images: protocol-relative URLs become https and take a size formatter', () => {
  assert.equal(api.httpsUrl(`//images-3.gog-statics.com/${HASH}.jpg`), `https://images-3.gog-statics.com/${HASH}.jpg`)
  assert.equal(api.httpsUrl('http://images.gog.com/x.png'), 'https://images.gog.com/x.png')
  assert.equal(api.httpsUrl('javascript:alert(1)'), undefined)
  assert.equal(api.httpsUrl(null), undefined)
  assert.equal(api.gogImage(`//images-1.gog-statics.com/${HASH}`, '_196', 'jpg'), `https://images-1.gog-statics.com/${HASH}_196.jpg`)
  assert.equal(api.gogImage(`https://images.gog-statics.com/${BOX}.jpg`, '_glx_vertical_cover', 'webp'), `https://images.gog-statics.com/${BOX}_glx_vertical_cover.webp`)
  assert.equal(api.gogImage(`//images-2.gog-statics.com/${HASH}_glx_logo_2x.jpg`, '_196', 'jpg'), `https://images-2.gog-statics.com/${HASH}_196.jpg`)
})

test('getFilteredProducts → ProviderGame: games only, slug, platforms, tile art', () => {
  const owned = api.ownedFromFiltered([
    { id: 1207658691, title: "Unreal Tournament 2004 Editor's Choice Edition", image: `//images-4.gog-statics.com/${HASH}`, url: '/game/unreal_tournament_2004_ece', slug: 'unreal_tournament_2004_ece', worksOn: { Windows: true, Mac: false, Linux: false }, isGame: true, isMovie: false },
    { id: 1207665463, title: 'A Movie', image: '//images-1.gog-statics.com/x', url: '/movie/a_movie', isGame: false, isMovie: true },
    { id: 1423049311, title: 'Cyberpunk 2077', image: `//images-2.gog-statics.com/${HASH}`, url: '/en/game/cyberpunk_2077', worksOn: {}, isGame: true },
    { id: 'nope', title: 'bad id' }
  ])
  assert.deepEqual(owned.map((o) => o.id), ['1207658691', '1423049311'])
  assert.equal(owned[1].slug, 'cyberpunk_2077')

  const ut = api.toProviderGame(owned[0])
  assert.deepEqual(ut, {
    key: 'gog:1207658691',
    provider: 'gog',
    appName: '1207658691',
    title: "Unreal Tournament 2004 Editor's Choice Edition",
    namespace: '',
    catalogItemId: '',
    developer: undefined,
    images: {
      tall: undefined,
      wide: `https://images-4.gog-statics.com/${HASH}_product_card_v2_mobile_slider_639.jpg`,
      logo: undefined,
      thumb: `https://images-4.gog-statics.com/${HASH}_196.jpg`
    },
    platforms: ['Windows'],
    canRunOffline: true,
    requiresOwnershipToken: false,
    storeUrl: 'https://www.gog.com/game/unreal_tournament_2004_ece'
  })
})

test('v2 game details fill in cover, background, logo, developer, size and platforms', () => {
  const v2 = {
    size: 107826,
    _links: {
      store: { href: 'https://www.gog.com/en/game/cyberpunk_2077' },
      logo: { href: 'https://images.gog-statics.com/logo.png' },
      boxArtImage: { href: `https://images.gog-statics.com/${BOX}.jpg` },
      backgroundImage: { href: `//images.gog-statics.com/${HASH}.jpg` }
    },
    _embedded: {
      product: { id: 1423049311, title: 'Cyberpunk 2077' },
      productType: 'GAME',
      developers: [{ name: 'CD PROJEKT RED' }, { name: ' ' }],
      supportedOperatingSystems: [{ operatingSystem: { name: 'windows' } }, { operatingSystem: { name: 'osx' } }, { operatingSystem: { name: 'linux' } }]
    }
  }
  const d = api.detailsFromV2(v2, 42)
  assert.deepEqual(d, {
    at: 42,
    title: 'Cyberpunk 2077',
    developer: 'CD PROJEKT RED',
    tall: `https://images.gog-statics.com/${BOX}_glx_vertical_cover.webp`,
    wide: `https://images.gog-statics.com/${HASH}.jpg`,
    logo: 'https://images.gog-statics.com/logo.png',
    icon: undefined,
    sizeMB: 107826,
    storeUrl: 'https://www.gog.com/en/game/cyberpunk_2077',
    platforms: ['Windows', 'Mac'],
    type: 'GAME'
  })
  // worksOn is sometimes empty: platforms come from the details then.
  const g = api.toProviderGame({ id: '1423049311', title: 'Cyberpunk 2077', slug: 'cyberpunk_2077', image: `//images-2.gog-statics.com/${HASH}`, platforms: [] }, d)
  assert.deepEqual(g.platforms, ['Windows', 'Mac'])
  assert.equal(g.developer, 'CD PROJEKT RED')
  assert.equal(g.images.tall, d.tall)
  assert.equal(g.images.thumb, d.tall)
  assert.equal(g.images.wide, d.wide)
  assert.equal(g.images.logo, d.logo)
  // Delisted products keep the tile art and a store link from the slug.
  const gone = api.toProviderGame({ id: '5', slug: 'old_game' }, { at: 1, missing: true })
  assert.equal(gone.title, 'GOG game 5')
  assert.equal(gone.storeUrl, 'https://www.gog.com/game/old_game')
})

test('fallback owned ids → product API keeps games, drops DLC and packs', () => {
  const owned = api.ownedFromProducts([
    { id: 1, title: 'Game', slug: 'game', game_type: 'game', content_system_compatibility: { windows: true, osx: true }, images: { background: `//images-3.gog-statics.com/${HASH}.jpg` } },
    { id: 2, title: 'DLC', game_type: 'dlc' },
    { id: 3, title: 'Pack', game_type: 'pack' }
  ])
  assert.deepEqual(owned.map((o) => o.id), ['1'])
  assert.deepEqual(owned[0].platforms, ['Windows', 'Mac'])
  assert.equal(api.toProviderGame(owned[0]).images.thumb, `https://images-3.gog-statics.com/${HASH}_196.jpg`)
})

// ───────── OAuth ─────────

test('OAuth: login URL and redirect code extraction', () => {
  const login = new URL(api.LOGIN_URL)
  assert.equal(login.origin + login.pathname, 'https://auth.gog.com/auth')
  assert.equal(login.searchParams.get('client_id'), '46899977096215655')
  assert.equal(login.searchParams.get('redirect_uri'), 'https://embed.gog.com/on_login_success?origin=client')
  assert.equal(login.searchParams.get('response_type'), 'code')
  assert.equal(login.searchParams.get('layout'), 'client2')

  const code = 'oF8OSgZVMFb7a8Y3Dolrz4YPqDUnG7TCTsekYKcWnFNcm-WWCJH7XJS3RN9d9NB0slx4FS1kss_llBEXvgkCX8oNT'
  assert.equal(api.extractAuthCode(`https://embed.gog.com/on_login_success?origin=client&code=${code}`), code)
  assert.equal(api.isRedirectUrl(`https://embed.gog.com/on_login_success?origin=client&code=${code}`), true)
  assert.equal(api.extractAuthCode('https://embed.gog.com/on_login_success?origin=client'), null)
  assert.equal(api.extractAuthCode(`https://evil.example/on_login_success?code=${code}`), null)
  assert.equal(api.extractAuthCode(`http://embed.gog.com/on_login_success?code=${code}`), null)
  assert.equal(api.extractAuthCode('https://login.gog.com/auth?client_id=1'), null)
  assert.equal(api.extractAuthCode('not a url'), null)
  assert.throws(() => api.extractAuthCode('https://embed.gog.com/on_login_success?origin=client&error=access_denied'), /access_denied/)
})

test('token exchange sends the Galaxy client credentials once and maps the response', async () => {
  const seen = []
  const a = load(join(__dirname, 'api.ts'), {
    '../epic/api': {
      fetchRetry: async (url, init, attempts) => {
        seen.push({ url: new URL(url), attempts })
        return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600, user_id: 48628349957132247n.toString(), token_type: 'bearer' }), { headers: { 'content-type': 'application/json' } })
      }
    }
  })
  const s = await a.exchangeAuthCode('code123')
  assert.equal(seen[0].attempts, 1)
  assert.equal(seen[0].url.origin + seen[0].url.pathname, 'https://auth.gog.com/token')
  assert.equal(seen[0].url.searchParams.get('grant_type'), 'authorization_code')
  assert.equal(seen[0].url.searchParams.get('code'), 'code123')
  assert.equal(seen[0].url.searchParams.get('redirect_uri'), 'https://embed.gog.com/on_login_success?origin=client')
  assert.equal(seen[0].url.searchParams.get('client_id'), '46899977096215655')
  assert.equal(s.access_token, 'A')
  assert.equal(s.user_id, '48628349957132247')
  assert.ok(s.expires_at > Date.now() + 3500_000)

  const bad = load(join(__dirname, 'api.ts'), {
    '../epic/api': { fetchRetry: async () => new Response('{"error":"invalid_grant","error_description":"Invalid refresh token"}', { status: 400 }) }
  })
  await assert.rejects(bad.refreshSession('x'), (err) => err.status === 400 && /Invalid refresh token/.test(err.message))
})

test('authenticated calls: login-page HTML triggers one re-auth, then a 401 error', async () => {
  let calls = 0
  const a = load(join(__dirname, 'api.ts'), {
    '../epic/api': { fetchRetry: async () => { calls++; return new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } }) } }
  })
  let reauths = 0
  const client = new a.GogApi(async () => 't', async () => { reauths++ })
  await assert.rejects(client.ownedIds(), (err) => err.status === 401)
  assert.equal(calls, 2)
  assert.equal(reauths, 1)
})

test('getFilteredProducts is paginated until totalPages', async () => {
  const pages = []
  const a = load(join(__dirname, 'api.ts'), {
    '../epic/api': {
      fetchRetry: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'))
        pages.push(page)
        return new Response(JSON.stringify({ page, totalPages: 3, products: [{ id: page, title: `G${page}` }] }), { headers: { 'content-type': 'application/json' } })
      }
    }
  })
  const all = await new a.GogApi(async () => 't').allGames()
  assert.deepEqual(pages, [1, 2, 3])
  assert.deepEqual(all.map((p) => p.id), [1, 2, 3])
})

// ───────── friends ─────────

function social(friends, online) {
  const fakeApi = {
    friends: async () => friends,
    statuses: async (ids) => (typeof online === 'function' ? online(ids) : online).filter((p) => ids.includes(p.user_id))
  }
  const { GogSocial } = load(join(__dirname, 'social.ts'), { '../epic/api': offline })
  return new GogSocial(async () => ({ accountId: '1', displayName: 'Me', token: 't' }), fakeApi)
}

test('friends: read-only network, presence maps to online/away/playing/offline', async () => {
  const s = social(
    [{ user_id: '10', username: 'zed' }, { user_id: '11', username: 'amy' }, { user_id: '12', username: 'bob' }, { user_id: '13', username: 'cat' }],
    [{ user_id: '10', client_id: 'x', data: {} }, { user_id: '11', presence: 'away' }, { user_id: '12', data: { game_title: 'Gwent' } }, { user_id: '99' }]
  )
  assert.equal(s.canChat, false)
  assert.equal(s.canAddFriends, false)
  await s.start('online')
  const st = s.state()
  s.stop()
  assert.equal(st.available, true)
  assert.equal(st.connection, 'online')
  assert.deepEqual(st.me, { id: '1', displayName: 'Me' })
  assert.deepEqual(st.friends.map((f) => [f.displayName, f.status, f.activity]), [
    ['bob', 'playing', 'Playing Gwent'],
    ['zed', 'online', undefined],
    ['amy', 'away', undefined],
    ['cat', 'offline', undefined]
  ])
  assert.deepEqual(st.requests, [])
  assert.throws(() => s.sendMessage('10', 'hi'), /GOG Galaxy/)
})

test('friends: change events are coalesced and unchanged polls emit nothing', async () => {
  let online = [{ user_id: '10' }]
  const s = social([{ user_id: '10', username: 'zed' }], () => online)
  const events = []
  s.on('changed', (st) => events.push(st))
  await s.start('online')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(events.length, 1)
  assert.equal(events[0].friends[0].status, 'online')
  await s.refresh()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(events.length, 1, 'identical poll is not re-emitted')
  online = []
  await s.refresh()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(events.length, 2)
  assert.equal(events[1].friends[0].status, 'offline')
  assert.ok(events[1].friends[0].lastOnline > 0)
  s.stop()
})

test('friends: a failed friends request reports an error state', async () => {
  const { GogSocial } = load(join(__dirname, 'social.ts'), { '../epic/api': offline })
  const s = new GogSocial(async () => ({ accountId: '1', displayName: 'Me', token: 't' }), {
    friends: async () => { throw new Error('GOG API 500') },
    statuses: async () => []
  })
  await s.start('online')
  const st = s.state()
  s.stop()
  assert.equal(st.connection, 'error')
  assert.match(st.error, /GOG API 500/)
})
