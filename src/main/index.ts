import { app } from 'electron'

// No stores or migration modules load in a losing second instance.
if (!app.requestSingleInstanceLock()) app.quit()
else void import('./migrate').then(() => import('./bootstrap'))
