const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

const filename = path.join(__dirname, 'authWindowSafety.ts')
const compiled = new Module(filename, module)
compiled.require = (name) => name === '../../shared/distribution' ? { STORE_DISTRIBUTION: true } : require(name)
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText, filename)
const { isAllowedAuthenticationUrl: allowed, protectAuthenticationWindow: protect, authenticationNavigationError } = compiled.exports

test('official provider login routes and callbacks are allowed without exposing their catalogs', () => {
  for (const [provider, urls] of [
    ['epic', ['https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect', 'https://www.epicgames.com/id/api/redirect?authorizationCode=secret', 'https://accounts.google.com/o/oauth2/auth?client_id=123', 'https://appleid.apple.com/auth/authorize']],
    ['steam', ['https://steamcommunity.com/login/home/?goto=', 'https://store.steampowered.com/login/', 'https://login.steampowered.com/jwt/refresh?redir=https%3A%2F%2Fsteamcommunity.com', 'https://steamcommunity.com/openid/login']],
    ['gog', ['https://auth.gog.com/auth?client_id=123', 'https://login.gog.com/auth', 'https://embed.gog.com/on_login_success?origin=client&code=secret', 'https://discord.com/oauth2/authorize']]
  ]) for (const url of urls) assert.equal(allowed(provider, url), true, url)
  for (const [provider, url] of [
    ['epic', 'https://store.epicgames.com/en-US/'], ['epic', 'https://www.epicgames.com/account/personal'],
    ['steam', 'https://steamcommunity.com/'], ['steam', 'https://steamcommunity.com/profiles/123'],
    ['steam', 'https://store.steampowered.com/app/123'], ['steam', 'https://steamcommunity.com/discussions/'],
    ['gog', 'https://www.gog.com/en/games'], ['gog', 'https://embed.gog.com/account'],
    ['epic', 'https://www.google.com/search?q=games'], ['gog', 'https://discord.com/channels/@me']
  ]) assert.equal(allowed(provider, url), false, url)
})

test('authentication policy rejects encoded paths, path traversal, spoofed origins and non-HTTPS URLs', () => {
  for (const url of [
    'https://steamcommunity.com/login/../../app/123', 'https://steamcommunity.com/login%2f..%2fapp/123',
    'https://steamcommunity.com/login/%252e%252e/app/123', 'https://steamcommunity.com/login%5capp',
    'https://steamcommunity.com.evil.test/login/home', 'https://steamcommunity.com@evil.test/login/home',
    'https://name:password@steamcommunity.com/login/', 'https://steamcommunity.com:444/login/',
    'http://steamcommunity.com/login/', 'data:text/html,secret', 'file:///tmp/login', 'javascript:alert(1)',
    'steam://open/store', 'about:blank'
  ]) assert.equal(allowed('steam', url), false, url)
  assert.equal(allowed('steam', 'https://store.steampowered.com/app/123', false), true)
})

function fakeWindow() {
  const webContents = new EventEmitter()
  webContents.session = { id: 'auth' }
  webContents.setWindowOpenHandler = (handler) => { webContents.popup = handler }
  webContents.stop = () => { webContents.stopped = true }
  return { webContents }
}

test('root redirects, subframe navigation and embedded webviews are blocked with no auth URL disclosure', () => {
  const win = fakeWindow(), errors = []
  protect(win, 'epic', (error) => errors.push(error))
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    let prevented = false
    const url = 'https://store.epicgames.com/en-US/?code=VERY_PRIVATE'
    win.webContents.emit(name, { url, preventDefault: () => { prevented = true } }, url)
    assert.equal(prevented, true, name)
  }
  let blockedWebview = false
  win.webContents.emit('will-attach-webview', { preventDefault: () => { blockedWebview = true } })
  assert.equal(blockedWebview, true)
  win.webContents.emit('did-navigate-in-page', {}, 'https://store.epicgames.com/')
  assert.equal(win.webContents.stopped, true)
  assert.equal(errors.length, 5)
  for (const error of errors) {
    assert.match(error.message, /only allows supported authentication pages/)
    assert.doesNotMatch(error.message, /VERY_PRIVATE|https:/)
  }
  assert.doesNotMatch(authenticationNavigationError().message, /code=/)
})

test('SSO children and nested popups inherit authentication-only navigation and secure session options', () => {
  const parent = fakeWindow(), child = fakeWindow(), nested = fakeWindow(), errors = []
  protect(parent, 'gog', (error) => errors.push(error))
  parent.webContents.emit('did-create-window', child)
  assert.equal(child.webContents.popup({ url: 'https://www.gog.com/en/games' }).action, 'deny')
  const permitted = child.webContents.popup({ url: 'https://accounts.google.com/signin/v2/identifier' })
  assert.equal(permitted.action, 'allow')
  assert.equal(permitted.overrideBrowserWindowOptions.webPreferences.session, child.webContents.session)
  assert.equal(permitted.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false)
  child.webContents.emit('did-create-window', nested)
  let prevented = false
  nested.webContents.emit('will-redirect', { preventDefault: () => { prevented = true } }, 'https://store.steampowered.com/')
  assert.equal(prevented, true)
  assert.equal(nested.webContents.popup({ url: 'https://www.gog.com/en' }).action, 'deny')
  assert.equal(errors.length, 3)
})

test('direct distributions preserve existing authentication window behavior', () => {
  const win = fakeWindow()
  protect(win, 'steam', () => assert.fail('must not alter direct login'), false)
  assert.equal(win.webContents.eventNames().length, 0)
})
