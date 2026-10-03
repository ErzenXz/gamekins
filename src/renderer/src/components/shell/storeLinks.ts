/** Epic store destinations shared by the Store tab's sub-nav and the STORE hover menu. */
export const STORE_BASE = 'https://store.epicgames.com/en-US'
export const STORE_HOME = `${STORE_BASE}/`

export const STORE_LINKS: { label: string; url: string; match: RegExp }[] = [
  { label: 'Discover', url: STORE_HOME, match: /^\/(en-US\/?)?$/ },
  { label: 'Browse', url: `${STORE_BASE}/browse`, match: /\/browse/ },
  { label: 'Free Games', url: `${STORE_BASE}/free-games`, match: /\/free-games/ },
  { label: 'News', url: `${STORE_BASE}/news`, match: /\/news/ },
  { label: 'Wishlist', url: `${STORE_BASE}/wishlist`, match: /\/wishlist/ },
  { label: 'Cart', url: `${STORE_BASE}/cart`, match: /\/cart/ }
]

export const storeSearchUrl = (q: string): string =>
  `${STORE_BASE}/browse?q=${encodeURIComponent(q)}&sortBy=relevancy&sortDir=DESC&count=40`
