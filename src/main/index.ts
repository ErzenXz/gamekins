import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// No stores or migration modules load in a losing second instance.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  // GPU rendering can only be turned off before the app is ready, so this one setting is
  // read straight from disk. Off: a little less memory and no video memory taken from games.
  try {
    const saved = JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')) as { hardwareAcceleration?: unknown }
    if (saved.hardwareAcceleration === false) app.disableHardwareAcceleration()
  } catch {
    /* no settings yet: keep the default (on) */
  }
  void import('./migrate').then(() => import('./bootstrap'))
}
