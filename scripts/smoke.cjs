// Run with pnpm exec electron scripts/smoke.cjs [path/to/app.asar].
// Exercises the built application with isolated data and no protocol/login registration.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(join(tmpdir(), 'gamekins-smoke-'))
app.setName('Gamekins Smoke')
app.getVersion = () => require('../package.json').version
app.setPath('appData', root)
app.setPath('userData', join(root, 'data'))
fs.mkdirSync(app.getPath('userData'), { recursive: true })
app.setAsDefaultProtocolClient = () => false
app.setLoginItemSettings = () => {}
process.env.GAMEKINS_START_HIDDEN = '1'
delete process.env.ELECTRON_RENDERER_URL
const entry = process.argv[2] ? join(resolve(process.argv[2]), 'out/main/index.js') : resolve(__dirname, '../out/main/index.js')
const failures = []
const deadline = setTimeout(() => finish(new Error('Timed out waiting for the built app')), 30000)
let finished = false
function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(deadline)
  if (error) console.error(error)
  app.exit(error ? 1 : 0)
}
process.on('uncaughtException', finish)
process.on('unhandledRejection', finish)
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('render-process-gone', (_event, detail) => failures.push(detail.reason))
  win.webContents.once('did-finish-load', async () => {
    try {
      assert.equal(win.webContents.getLastWebPreferences().sandbox, true)
      assert.equal(win.webContents.getLastWebPreferences().contextIsolation, true)
      const deadline = Date.now() + 15000
      let result
      do {
        result = await win.webContents.executeJavaScript(`(async () => {
          if (!window.gamekins) throw new Error('Missing preload API');
          const [info, settings, games] = await Promise.all([window.gamekins.app.info(), window.gamekins.settings.get(), window.gamekins.library.get()]);
          return {info, settings, games: games.length, text: document.body.innerText, ready: !document.querySelector('.boot') && !!document.querySelector('.content .view'), node: typeof window.require};
        })()`)
        if (result.ready) break
        await new Promise(resolve => setTimeout(resolve, 100))
      } while (Date.now() < deadline)
      assert.equal(result.ready, true, 'App content did not become ready')
      assert.equal(result.node, 'undefined', 'Node must not be exposed in the renderer')
      assert.equal(result.info.platform, process.platform)
      assert.ok(result.settings.installDir)
      assert.deepEqual(failures, [])
      console.log('Built application smoke passed:', JSON.stringify({ platform: result.info.platform, version: result.info.version, games: result.games, sandbox: true, contextIsolation: true, rendererNode: false }))
      if (process.env.GAMEKINS_SMOKE_SCREENSHOT) {
        // Let the view's entrance animation paint before taking review evidence.
        await new Promise(resolve => setTimeout(resolve, 400))
        fs.writeFileSync(process.env.GAMEKINS_SMOKE_SCREENSHOT, (await win.webContents.capturePage()).toPNG())
      }
      finish()
    } catch (error) { finish(error) }
  })
})
// The parent process can remove this isolated directory after Electron has exited.
console.log('Smoke data:', root)
require(entry)
