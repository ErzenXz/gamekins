'use strict'
// Native Electron capture of the packaged application; no mock API or invented games.
// pnpm exec electron scripts/store-screenshots.cjs path/to/app.asar /absolute/output
const { app } = require('electron')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { join, resolve, isAbsolute } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')

if (!process.argv[2] || !process.argv[3] || !isAbsolute(process.argv[3])) {
  console.error('Pass the packaged app.asar and an absolute screenshot output directory.')
  process.exit(1)
}
const archive = resolve(process.argv[2])
const output = resolve(process.argv[3])
const profile = fs.mkdtempSync(join(tmpdir(), 'gamekins-listing-'))
fs.mkdirSync(output, { recursive: true })
app.setName('Gamekins')
app.getVersion = () => require('../package.json').version
app.setPath('appData', profile)
app.setPath('userData', join(profile, 'data'))
fs.mkdirSync(app.getPath('userData'), { recursive: true })
// Capture must not register a protocol or startup task on the runner.
app.setAsDefaultProtocolClient = () => false
app.setLoginItemSettings = () => {}
app.commandLine.appendSwitch('force-device-scale-factor', '1')
process.env.GAMEKINS_START_HIDDEN = '1'
delete process.env.ELECTRON_RENDERER_URL
// This opposing runtime value proves the captured safeguards belong to the package.
process.env.GAMEKINS_DISTRIBUTION = 'direct'
const manifest = {
  platform: process.platform,
  version: app.getVersion(),
  distribution: 'ms-store',
  capturedAt: new Date().toISOString(),
  source: 'Real packaged Gamekins application, isolated signed-out profile. No fixture accounts, games, purchases, or download activity.',
  screenshots: [],
  omitted: []
}
let finished = false
const timeout = setTimeout(() => finish(new Error('Screenshot capture exceeded 150 seconds')), 150000)
const pause = ms => new Promise(done => setTimeout(done, ms))

function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  if (error) { manifest.error = error.stack || error.message; console.error(error) }
  fs.writeFileSync(join(output, 'capture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('Capture manifest:', join(output, 'capture-manifest.json'))
  console.log('Isolated temporary profile:', profile)
  app.exit(error ? 1 : 0)
}
process.on('uncaughtException', finish)
process.on('unhandledRejection', finish)

async function waitFor(win, expression, label, maxMs = 20000) {
  const until = Date.now() + maxMs
  do {
    if (await win.webContents.executeJavaScript(expression)) return
    await pause(150)
  } while (Date.now() < until)
  throw new Error(`Timed out waiting for ${label}`)
}
async function click(win, selector, text) {
  await win.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)});
    if (!target || target.disabled) throw new Error('Missing UI action: ' + ${JSON.stringify(text)});
    target.click();
  })()`)
}
async function capture(win, file, caption) {
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  await pause(700)
  assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".boot-errors, .error-boundary")'), false, 'Application error is visible')
  const image = await win.webContents.capturePage()
  const size = image.getSize()
  assert.ok(size.width >= 1366 && size.height >= 768, `Screenshot too small: ${size.width}x${size.height}`)
  const png = image.toPNG()
  fs.writeFileSync(join(output, file), png)
  manifest.screenshots.push({ file, caption, ...size, sha256: createHash('sha256').update(png).digest('hex') })
  console.log(`Captured ${file}: ${size.width}x${size.height}`)
}

let mainWindowSeen = false
app.on('browser-window-created', (_event, win) => {
  if (mainWindowSeen) return
  mainWindowSeen = true
  win.setContentSize(1440, 900)
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    try {
      win.show()
      await waitFor(win, '!!window.gamekins && !document.querySelector(".boot") && !!document.querySelector(".signin")', 'signed-out library')
      const info = await win.webContents.executeJavaScript('window.gamekins.app.info()')
      assert.equal(info.platform, process.platform)
      assert.equal(info.distribution, 'ms-store', 'Capture must use the compiled Microsoft Store edition')
      assert.equal(win.webContents.getLastWebPreferences().webviewTag, false, 'Embedded storefront support must be disabled in the packaged main process')
      const history = await win.webContents.executeJavaScript('window.gamekins.social.chat("epic:00000000000000000000000000000000")')
      assert.deepEqual(history, [], 'Store package must not return native chat history')
      const sendError = await win.webContents.executeJavaScript(`window.gamekins.social.send('epic:00000000000000000000000000000000', 'safety probe').then(() => null, error => error.message)`)
      assert.match(sendError || '', /Native chat is disabled.*Microsoft Store edition/, 'The packaged main-process chat IPC gate must reject sends')
      manifest.safeguardsVerified = { compiledStoreEdition: true, opposingRuntimeDistribution: 'direct', embeddedWebviews: false, nativeChatHistory: false, nativeChatSending: false }
      assert.equal(await win.webContents.executeJavaScript('typeof window.require'), 'undefined')
      assert.equal(win.webContents.getLastWebPreferences().sandbox, true)
      assert.deepEqual(await win.webContents.executeJavaScript('window.gamekins.accounts.list()'), [])
      await capture(win, '01-library-welcome.png', 'Connect your game accounts from the Gamekins library welcome screen.')

      await click(win, '.tb-tab', 'Downloads')
      await waitFor(win, 'document.body.innerText.includes("There are no downloads in the queue")', 'downloads view')
      await capture(win, '02-downloads.png', 'Keep game installations and updates together in the download queue.')

      // Use the same keyboard shortcut handled by the app, without touching renderer state.
      await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent("keydown", {key: ",", code: "Comma", ctrlKey: ${process.platform !== 'darwin'}, metaKey: ${process.platform === 'darwin'}, bubbles: true}))`)
      await waitFor(win, 'document.querySelector(".st-title")?.textContent === "Account"', 'account settings')
      await capture(win, '03-connected-stores.png', 'Connect supported stores and manage account access from one place.')

      await click(win, '.st-nav-item', 'Downloads')
      await waitFor(win, 'document.querySelector(".st-title")?.textContent === "Downloads"', 'download settings')
      await capture(win, '04-download-settings.png', 'Adjust download bandwidth, parallel transfers, and installation preferences.')

      await click(win, '.st-nav-item', 'Interface')
      await waitFor(win, 'document.querySelector(".st-title")?.textContent === "Interface"', 'interface settings')
      await capture(win, '05-interface-settings.png', 'Customize the appearance and behavior of your Gamekins library.')

      await click(win, '.tb-tab', 'Store')
      await waitFor(win, '!!document.querySelector("[data-testid=store-distribution-safeguards]")', 'Microsoft Store distribution safeguards')
      assert.equal(await win.webContents.executeJavaScript('!!document.querySelector("webview")'), false, 'Store package must not embed an unrestricted storefront')
      assert.equal(await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].some(button => button.title === "Friends & chat")'), false, 'Store package must not expose unrestricted chat')
      await capture(win, '06-store-safeguards.png', 'The Microsoft Store edition provides game-launcher tools without embedded storefront browsing or unrestricted chat.')
      assert.equal(manifest.screenshots.length, 6)
      finish()
    } catch (error) { finish(error) }
  })
})
require(join(archive, 'out/main/index.js'))
