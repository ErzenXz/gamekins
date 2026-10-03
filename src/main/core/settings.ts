import { app } from 'electron'
import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { JsonStore } from './store'

function defaultInstallDir(): string {
  if (process.platform === 'win32') {
    // Avoid Program Files: it needs elevation and is virtualized for packaged (MSIX) apps.
    const drive = process.env.SystemDrive || 'C:'
    return join(drive + '\\', 'Games')
  }
  return join(app.getPath('home'), 'Games')
}

export const settingsStore = new JsonStore<Settings>('settings', {
  installDir: defaultInstallDir(),
  maxWorkers: 16,
  autoUpdate: true,
  launchViaEpicLauncher: false,
  importEpicLauncherInstalls: true,
  installPrerequisites: true,
  minimizeOnLaunch: false,
  bandwidthLimitMBps: 0,
  downloadsDuringGameplay: false,
  closeToTray: true,
  launchAtLogin: false
})

export const settings = (): Settings => settingsStore.data
