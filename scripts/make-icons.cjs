// Renders branding/icon-1024.png (app tile), branding/mark-1024.png (the Gamekin on its own)
// and the mascot poses to every PNG the Windows/Mac/Store packages and the UI need.
// Run with: npx electron scripts/make-icons.cjs [outDir]
// outDir (default: the repo) helps when antivirus folder protection stops electron.exe writing
// into the project: render elsewhere, then copy the tree over.
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')

const root = join(__dirname, '..')
const out = process.argv.slice(2).find((a) => !a.startsWith('-') && !a.endsWith('make-icons.cjs')) || root
// File URLs, not data: URLs: the 1024px art is bigger than Chromium's 2 MB URL limit.
const art = (file) => pathToFileURL(join(root, 'branding', file)).href
const ICON = art('icon-1024.png')
const MARK = art('mark-1024.png')
const WAVE = art('mascot-wave.png')
const SLEEP = art('mascot-sleep.png')
const CHEER = art('mascot-cheer.png')

// [file, width, height, source, scale] — scale < 1 pads the art (Store tiles want margins).
const targets = [
  ['resources/icon.png', 512, 512, ICON, 1],
  ['build/icon.png', 1024, 1024, ICON, 1],
  ['build/appx/StoreLogo.png', 50, 50, ICON, 1],
  ['build/appx/Square44x44Logo.png', 44, 44, ICON, 1],
  ['build/appx/Square150x150Logo.png', 150, 150, MARK, 0.62],
  ['build/appx/Wide310x150Logo.png', 310, 150, MARK, 0.62],
  ['build/appx/LargeTile.png', 310, 310, MARK, 0.62],
  ['build/appx/SmallTile.png', 71, 71, MARK, 0.7],
  ['src/renderer/src/assets/mark.png', 128, 128, MARK, 1],
  // 2x the size they're shown at.
  ['src/renderer/src/assets/mascot-wave.png', 320, 320, WAVE, 1],
  ['src/renderer/src/assets/mascot-sleep.png', 256, 256, SLEEP, 1],
  ['src/renderer/src/assets/mascot-cheer.png', 256, 256, CHEER, 1]
]

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } })
  for (const [file, w, h, src, scale] of targets) {
    const size = Math.round(Math.min(w, h) * scale)
    const html = `<html><body style="margin:0;width:${w}px;height:${h}px;display:grid;place-items:center;background:transparent">
      <img src="${src}" style="width:${size}px;height:${size}px;image-rendering:auto"></body></html>`
    win.setContentSize(w, h)
    const page = join(tmpdir(), 'gamekins-icon.html')
    writeFileSync(page, html)
    await win.loadFile(page)
    rmSync(page, { force: true })
    await new Promise((r) => setTimeout(r, 200))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h })
    mkdirSync(join(out, file, '..'), { recursive: true })
    writeFileSync(join(out, file), img.resize({ width: w, height: h, quality: 'best' }).toPNG())
    console.log('wrote', file)
  }
  app.quit()
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
