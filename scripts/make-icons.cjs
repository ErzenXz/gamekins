// Renders branding/icon-1024.png (app tile) and branding/mark-1024.png (bare star) to
// every PNG the Windows/Mac/Store packages need.
// Run with: npx electron scripts/make-icons.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const dataUrl = (file) => 'data:image/png;base64,' + readFileSync(join(root, 'branding', file)).toString('base64')
const ICON = dataUrl('icon-1024.png')
const MARK = dataUrl('mark-1024.png')

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
  ['src/renderer/src/assets/mark.png', 256, 256, MARK, 1]
]

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } })
  for (const [file, w, h, src, scale] of targets) {
    const size = Math.round(Math.min(w, h) * scale)
    const html = `<html><body style="margin:0;width:${w}px;height:${h}px;display:grid;place-items:center;background:transparent">
      <img src="${src}" style="width:${size}px;height:${size}px;image-rendering:auto"></body></html>`
    win.setContentSize(w, h)
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await new Promise((r) => setTimeout(r, 200))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h })
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), img.resize({ width: w, height: h, quality: 'best' }).toPNG())
    console.log('wrote', file)
  }
  app.quit()
})
