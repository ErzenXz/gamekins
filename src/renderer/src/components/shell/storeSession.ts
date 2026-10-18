import { STORE_SITES, siteOf, type StoreSite } from './storeLinks'

/** Last page per store and the store last shown, so the Store tab reopens where you were. */
const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* unavailable */
  }
}

const legacy = read('gamekins.store.url')
const lastURL: Record<StoreSite, string> = {
  epic: read('gamekins.store.url.epic') || legacy || STORE_SITES.epic.home,
  steam: read('gamekins.store.url.steam') || STORE_SITES.steam.home,
  gog: read('gamekins.store.url.gog') || STORE_SITES.gog.home
}
let lastSite: StoreSite = (['epic', 'steam', 'gog'] as const).find((s) => s === read('gamekins.store.site')) ?? 'epic'

export let handledStoreRequest = 0
export function rememberStoreRequest(n: number): void {
  handledStoreRequest = n
}
export function storeSite(): StoreSite {
  return lastSite
}
export function rememberStoreSite(site: StoreSite): void {
  lastSite = site
  write('gamekins.store.site', site)
}
export function storeURL(site: StoreSite = lastSite): string {
  return lastURL[site]
}
export function rememberStoreURL(url: string): void {
  if (!url || url === 'about:blank') return
  const site = siteOf(url)
  lastURL[site] = url
  write(`gamekins.store.url.${site}`, url)
}
