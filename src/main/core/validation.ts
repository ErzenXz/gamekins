import { isAbsolute } from 'node:path'

export type Validator = (value: unknown) => boolean
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const string: Validator = (v) => typeof v === 'string' && v.length <= 32768 && !v.includes('\0')
export const text: Validator = (v) => string(v) && (v as string).length > 0 && (v as string).length <= 1024
export const boolean: Validator = (v) => typeof v === 'boolean'
export const number: Validator = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
export const path: Validator = (v) => text(v) && isAbsolute(v as string)
export const optional = (check: Validator): Validator => (v) => v === undefined || check(v)
export const oneOf = (...values: unknown[]): Validator => (v) => values.includes(v)
export const array = (check: Validator, max = 10000): Validator => (v) => Array.isArray(v) && v.length <= max && v.every(check)
export function fields(v: unknown, schema: Record<string, Validator>): boolean {
  return object(v) && Object.keys(v).every((k) => Object.hasOwn(schema, k)) &&
    Object.entries(schema).every(([k, check]) => check(v[k]))
}
export const prefsSchema = {
  favorite: optional(boolean), hidden: optional(boolean), launchArgs: optional(string),
  launchViaOfficial: optional(boolean), autoUpdate: optional(boolean), collections: optional(array((v) => text(v) && (v as string).length <= 60, 500))
}
export const settingsSchema = {
  installDir: path, maxWorkers: (v: unknown) => number(v) && Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 64,
  bandwidthLimitMBps: number, autoUpdate: boolean, launchViaEpicLauncher: boolean,
  importEpicLauncherInstalls: boolean, installPrerequisites: boolean, minimizeOnLaunch: boolean,
  downloadsDuringGameplay: boolean, closeToTray: boolean, launchAtLogin: boolean
}
export const installSchema = {
  path, version: string, executable: string, launchCommand: string, platform: oneOf('Windows', 'Mac'),
  sizeBytes: number, source: oneOf('lodestar', 'epic-launcher', 'local'), installedAt: number,
  prereqsInstalled: optional(boolean), manifestId: optional(text), ownsFolder: optional(boolean),
  unavailable: optional(boolean), workingDirectory: optional(path)
}
const imageString: Validator = (v) => typeof v === 'string' && v.length <= 24 * 1024 * 1024 && !v.includes('\0')
export const imagesSchema = { tall: optional(imageString), wide: optional(imageString), logo: optional(imageString), thumb: optional(imageString) }
export const gameSchema = {
  key: text, provider: oneOf('epic', 'local'), appName: text, title: text, namespace: string,
  catalogItemId: string, developer: optional(string), description: optional(string),
  images: (v: unknown) => fields(v, imagesSchema), platforms: array(oneOf('Windows', 'Mac'), 2),
  latestVersion: optional(string), thirdPartyManagedApp: optional(string), canRunOffline: boolean,
  requiresOwnershipToken: boolean, storeUrl: optional(string), dlcOf: optional(text)
}
const jobSchema = {
  id: text, gameKey: text, title: text, image: optional(string), kind: oneOf('install', 'repair', 'update'),
  state: oneOf('queued', 'preparing', 'verifying', 'downloading', 'finalizing', 'paused', 'done', 'error', 'cancelled'),
  installPath: path, downloadedBytes: number, totalDownloadBytes: number, writtenBytes: number, totalWriteBytes: number,
  verifiedBytes: number, totalVerifyBytes: number, speedBps: number, diskBps: number,
  speedHistory: array(number, 60), diskHistory: optional(array(number, 60)), currentFile: optional(string),
  waitingReason: optional(string), error: optional(string), addedAt: number, finishedAt: optional(number),
  providerId: optional(oneOf('epic', 'local')), appName: optional(text), parentKey: optional(text), createdFolder: optional(boolean)
}

/** Dynamic maps need record schemas; an empty default cannot express their shape. */
/**
 * Upgrade entries written by older versions before validating them, so a renamed value
 * (the app was called "Vapor" before release) never gets a valid record thrown away.
 */
export function upgradeStoreEntry(name: string, v: unknown): unknown {
  if (!object(v)) return v
  if ((name === 'installed' || name === 'downloads') && v.source === 'vapor') return { ...v, source: 'lodestar' }
  return v
}

export function validStoreEntry(name: string, v: unknown): boolean {
  switch (name) {
    case 'library-cache': return fields(v, gameSchema)
    case 'installed': return fields(v, installSchema)
    case 'game-prefs': return fields(v, prefsSchema)
    case 'artwork': return fields(v, imagesSchema)
    case 'playtime': return fields(v, { seconds: number, last: optional(number) })
    case 'downloads': return fields(v, jobSchema)
    case 'local-games': return fields(v, { id: text, title: text, exe: path, args: string, icon: optional(string), addedAt: number, workingDirectory: optional(path) })
    case 'active-sessions': return object(v) && text(v.group) && path(v.dir) && path(v.executable) &&
      boolean(v.local) && number(v.checkpoint) && number(v.started) && number(v.lastSeen) && number(v.grace) &&
      optional(number)(v.spawnedPid) && array((p) => fields(p, { pid: number, path: string, parentPid: optional(number), created: optional(string) }), 1000)(v.processes)
    default: return true
  }
}
