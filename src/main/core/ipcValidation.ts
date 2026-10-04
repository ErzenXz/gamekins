import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { resolve } from 'node:path'
import { library } from './library'
import { downloads } from './downloads'
import { array, boolean, fields, number, object, oneOf, optional, path, prefsSchema, settingsSchema, text, type Validator } from './validation'

const empty = ['app:info', 'app:quit', 'app:listPrograms', 'app:storage', 'accounts:list', 'library:get', 'library:refresh', 'library:freeGames', 'downloads:list', 'downloads:clearFinished', 'settings:get']
const schemas: Record<string, Validator[]> = Object.fromEntries(empty.map((name) => [name, []]))
Object.assign(schemas, {
  'app:openExternal': [text], 'app:pickDirectory': [optional(path)],
  'app:pickFiles': [optional((v) => fields(v, {
    title: optional(text), multi: optional(boolean), filters: optional(array((f) => fields(f, {
      name: text, extensions: array((e) => typeof e === 'string' && /^(\*|[a-zA-Z0-9]{1,16})$/.test(e), 30)
    }), 30))
  }))],
  'accounts:login': [oneOf('epic')], 'accounts:logout': [oneOf('epic')],
  'games:plan': [text, optional(path)], 'games:install': [text, optional(path)],
  'games:importFolder': [text, path], 'games:moveInstall': [text, path],
  'games:addLocal': [array(path, 500)],
  'games:setArtwork': [text, oneOf('tall', 'wide', 'logo'), (v: unknown) => v === null || path(v)],
  'games:details': [text, optional(boolean)],
  'games:setPrefs': [text, (v: unknown) => fields(v, prefsSchema)],
  'games:editCollections': [(v: unknown) => fields(v, {
    operation: oneOf('add', 'remove', 'rename', 'delete'), gameKeys: array(text, 10000),
    name: (n) => text(n) && (n as string).trim().length > 0 && (n as string).length <= 60,
    replacement: optional((n) => text(n) && (n as string).trim().length > 0 && (n as string).length <= 60)
  }) && (object(v) && (v.operation !== 'rename' || typeof v.replacement === 'string'))],
  'settings:set': [(v: unknown) => object(v) && Object.entries(v).every(([k, value]) => Object.hasOwn(settingsSchema, k) && settingsSchema[k as keyof typeof settingsSchema](value))],
  'downloads:move': [text, (v: unknown) => number(Math.abs(v as number)) && (v === -1 || v === 1)]
})
for (const name of ['update', 'repair', 'uninstall', 'launch', 'stop', 'openFolder', 'createShortcut']) schemas[`games:${name}`] = [text]
for (const name of ['pause', 'resume', 'cancel']) schemas[`downloads:${name}`] = [text]

export function validateSender(event: IpcMainInvokeEvent, contents: WebContents | undefined, appUrl: string): void {
  if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
      event.senderFrame.url !== appUrl) throw new Error('Untrusted IPC sender')
}

export function validateArguments(channel: string, args: unknown[]): void {
  const schema = schemas[channel]
  if (!schema || args.length > schema.length || !schema.every((check, i) => check(args[i]))) throw new Error(`Invalid arguments for ${channel}`)
  if (channel.startsWith('games:') && !['games:addLocal', 'games:editCollections'].includes(channel)) {
    const game = library.providerGame(args[0] as string)
    if (!game) throw new Error('Unknown game')
    const managed = ['games:plan', 'games:importFolder', 'games:update', 'games:repair', 'games:moveInstall']
    if (managed.includes(channel) && (game.provider !== 'epic' || game.thirdPartyManagedApp)) throw new Error('This operation is not supported for this game')
    if (channel === 'games:install' && game.provider !== 'epic') throw new Error('Local games cannot be installed by Gamekins')
    if (['games:launch', 'games:stop', 'games:moveInstall'].includes(channel) && game.dlcOf) throw new Error('Use the base game for this operation')
  }
  if (channel.startsWith('downloads:') && !['downloads:list', 'downloads:clearFinished'].includes(channel) && !downloads.jobs.some((job) => job.id === args[0])) throw new Error('Unknown download')
  // Normalize filesystem arguments before they enter stores and provider APIs.
  for (const [i, check] of schema.entries()) if (check === path && typeof args[i] === 'string') args[i] = resolve(args[i])
  if (['games:plan', 'games:install', 'app:pickDirectory'].includes(channel)) {
    const i = channel === 'app:pickDirectory' ? 0 : 1
    if (typeof args[i] === 'string') args[i] = resolve(args[i])
  }
  if (channel === 'games:setArtwork' && typeof args[2] === 'string') args[2] = resolve(args[2])
  if (channel === 'games:addLocal') args[0] = (args[0] as string[]).map((p) => resolve(p))
  if (channel === 'settings:set' && object(args[0]) && typeof args[0].installDir === 'string') args[0].installDir = resolve(args[0].installDir)
}
