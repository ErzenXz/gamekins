/** Stores browsable in the Store tab, with their sub-nav destinations. */
export type StoreSite = 'epic' | 'steam' | 'gog'

interface StoreLink {
  label: string
  url: string
  match: RegExp
}

interface SiteConfig {
  name: string
  /** Shared with the store's sign-in window, so you're signed in on its pages too. */
  partition: string
  home: string
  hosts: string[]
  tabs: StoreLink[]
  wishlist: StoreLink
  cart: StoreLink
  search(q: string): string
}

/** Epic store destinations shared by the Store tab's sub-nav and the STORE hover menu. */
export const STORE_BASE = 'https://store.epicgames.com/en-US'
export const STORE_HOME = `${STORE_BASE}/`

export const STORE_LINKS: StoreLink[] = [
  { label: 'Discover', url: STORE_HOME, match: /^\/(en-US\/?)?$/ },
  { label: 'Browse', url: `${STORE_BASE}/browse`, match: /\/browse/ },
  { label: 'Free Games', url: `${STORE_BASE}/free-games`, match: /\/free-games/ },
  { label: 'News', url: `${STORE_BASE}/news`, match: /\/news/ },
  { label: 'Wishlist', url: `${STORE_BASE}/wishlist`, match: /\/wishlist/ },
  { label: 'Cart', url: `${STORE_BASE}/cart`, match: /\/cart/ }
]

export const storeSearchUrl = (q: string): string =>
  `${STORE_BASE}/browse?q=${encodeURIComponent(q)}&sortBy=relevancy&sortDir=DESC&count=40`

const STEAM = 'https://store.steampowered.com'
const GOG = 'https://www.gog.com/en'

export const STORE_SITES: Record<StoreSite, SiteConfig> = {
  epic: {
    name: 'Epic Games',
    partition: 'persist:epic',
    home: STORE_HOME,
    hosts: ['epicgames.com', 'unrealengine.com', 'fab.com'],
    tabs: STORE_LINKS.filter((l) => l.label !== 'Wishlist' && l.label !== 'Cart'),
    wishlist: STORE_LINKS.find((l) => l.label === 'Wishlist')!,
    cart: STORE_LINKS.find((l) => l.label === 'Cart')!,
    search: storeSearchUrl
  },
  steam: {
    name: 'Steam',
    partition: 'persist:steam',
    home: `${STEAM}/`,
    hosts: ['steampowered.com', 'steamcommunity.com'],
    tabs: [
      { label: 'Featured', url: `${STEAM}/`, match: /^\/?$/ },
      { label: 'Discover', url: `${STEAM}/explore/`, match: /^\/explore/ },
      { label: 'Specials', url: `${STEAM}/specials/`, match: /^\/specials/ },
      { label: 'Free to Play', url: `${STEAM}/genre/Free%20to%20Play/`, match: /^\/genre\/Free/ }
    ],
    wishlist: { label: 'Wishlist', url: `${STEAM}/wishlist/`, match: /^\/wishlist/ },
    cart: { label: 'Cart', url: `${STEAM}/cart/`, match: /^\/cart/ },
    search: (q) => `${STEAM}/search/?term=${encodeURIComponent(q)}`
  },
  gog: {
    name: 'GOG',
    partition: 'persist:gog',
    home: `${GOG}/`,
    hosts: ['gog.com'],
    tabs: [
      { label: 'Home', url: `${GOG}/`, match: /^\/(en\/?)?$/ },
      { label: 'Browse', url: `${GOG}/games`, match: /^\/(en\/)?games(?!.*discounted)/ },
      { label: 'On sale', url: `${GOG}/games?discounted=true`, match: /discounted=true/ },
      { label: 'Free', url: `${GOG}/games?priceRange=0,0`, match: /priceRange=0,0/ }
    ],
    wishlist: { label: 'Wishlist', url: `${GOG}/account/wishlist`, match: /wishlist/ },
    cart: { label: 'Cart', url: `${GOG}/checkout`, match: /checkout|cart/ },
    search: (q) => `${GOG}/games?query=${encodeURIComponent(q)}`
  }
}

/** Which store a URL belongs to (Epic when unknown). */
export function siteOf(url: string): StoreSite {
  try {
    const host = new URL(url).hostname
    for (const [id, site] of Object.entries(STORE_SITES) as [StoreSite, SiteConfig][]) {
      if (site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return id
    }
  } catch {
    /* not a URL */
  }
  return 'epic'
}
