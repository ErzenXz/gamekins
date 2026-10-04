import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENTS, type LodestarApi } from '@shared/api'

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: LodestarApi = {
  app: {
    info: invoke('app:info'),
    openExternal: invoke('app:openExternal'),
    pickDirectory: invoke('app:pickDirectory'),
    quit: invoke('app:quit'),
    pickFiles: invoke('app:pickFiles'),
    listPrograms: invoke('app:listPrograms'),
    storage: invoke('app:storage')
  },
  accounts: {
    list: invoke('accounts:list'),
    login: invoke('accounts:login'),
    logout: invoke('accounts:logout')
  },
  library: {
    get: invoke('library:get'),
    refresh: invoke('library:refresh'),
    freeGames: invoke('library:freeGames')
  },
  games: {
    plan: invoke('games:plan'),
    install: invoke('games:install'),
    importFolder: invoke('games:importFolder'),
    update: invoke('games:update'),
    repair: invoke('games:repair'),
    uninstall: invoke('games:uninstall'),
    launch: invoke('games:launch'),
    stop: invoke('games:stop'),
    openFolder: invoke('games:openFolder'),
    setPrefs: invoke('games:setPrefs'),
    editCollections: invoke('games:editCollections'),
    moveInstall: invoke('games:moveInstall'),
    addLocal: invoke('games:addLocal'),
    setArtwork: invoke('games:setArtwork'),
    createShortcut: invoke('games:createShortcut'),
    details: invoke('games:details')
  },
  downloads: {
    list: invoke('downloads:list'),
    pause: invoke('downloads:pause'),
    resume: invoke('downloads:resume'),
    cancel: invoke('downloads:cancel'),
    move: invoke('downloads:move'),
    clearFinished: invoke('downloads:clearFinished')
  },
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set')
  },
  on: {
    library: subscribe(EVENTS.library),
    libraryProgress: subscribe(EVENTS.libraryProgress),
    downloads: subscribe(EVENTS.downloads),
    accounts: subscribe(EVENTS.accounts),
    toast: subscribe(EVENTS.toast),
    navigate: subscribe(EVENTS.navigate)
  }
} as LodestarApi

contextBridge.exposeInMainWorld('lodestar', api)
