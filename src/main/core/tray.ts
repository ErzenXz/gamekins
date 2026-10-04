import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { downloads } from './downloads'
import { library } from './library'

let tray: Tray | null = null

export interface TrayActions {
  show(view?: string): void
  quit(): void
  play(key: string): void
}

/** Steam-style tray icon: quick access to views, recent games and Exit. */
export function createTray(actions: TrayActions): void {
  if (tray) return
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Gamekins')
  tray.on('click', () => actions.show())
  if (process.platform === 'darwin') tray.on('right-click', () => tray?.popUpContextMenu())

  let signature = ''
  let tooltip = ''
  const rebuild = (): void => {
    if (!tray) return
    const recent = library.recent(5)
    const active = downloads.jobs.find((j) => ['downloading', 'verifying', 'preparing'].includes(j.state))
    const nextTooltip = active ? `Gamekins — ${active.title}` : 'Gamekins'
    if (nextTooltip !== tooltip) { tooltip = nextTooltip; tray.setToolTip(tooltip) }
    const nextSignature = JSON.stringify(recent.map((g) => [g.key, g.title, g.running]))
    if (nextSignature === signature) return
    signature = nextSignature
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(recent.length
          ? [
              { label: 'Recent games', enabled: false },
              ...recent.map((g) => ({
                label: g.running ? `${g.title}  (running)` : g.title,
                enabled: !g.running,
                click: () => actions.play(g.key)
              })),
              { type: 'separator' as const }
            ]
          : []),
        { label: 'Store', click: () => actions.show('store') },
        { label: 'Library', click: () => actions.show('library') },
        { label: 'Downloads', click: () => actions.show('downloads') },
        { label: 'Settings', click: () => actions.show('settings') },
        { type: 'separator' },
        { label: 'Exit Gamekins', click: () => actions.quit() }
      ])
    )
  }
  rebuild()
  library.on('changed', rebuild)
  let last = 0
  downloads.on('changed', () => {
    // Downloads tick 4x a second; the menu doesn't need that.
    if (Date.now() - last > 3000) {
      last = Date.now()
      rebuild()
    }
  })
  app.on('before-quit', () => {
    tray?.destroy()
    tray = null
  })
}
