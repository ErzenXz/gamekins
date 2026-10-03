import { STORE_HOME } from './storeLinks'

let lastURL = STORE_HOME
try { lastURL = localStorage.getItem('lodestar.store.url') || STORE_HOME } catch { /* unavailable */ }
export let handledStoreRequest = 0
export function rememberStoreRequest(n: number): void { handledStoreRequest = n }
export function storeURL(): string { return lastURL }
export function rememberStoreURL(url: string): void {
  if (!url || url === 'about:blank') return
  lastURL = url
  try { localStorage.setItem('lodestar.store.url', url) } catch { /* unavailable */ }
}
