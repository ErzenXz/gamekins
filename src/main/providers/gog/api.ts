// Thin client for GOG's web services, as used by the GOG Galaxy client.
// Client credentials, endpoints and image formatters are the public ones documented by the
// open-source community (gogapidocs.readthedocs.io, Heroic / heroic-gogdl, Lutris).

import type { Platform } from '@shared/types'
import type { ProviderGame } from '../types'
import { fetchRetry } from '../epic/api'

/** The GOG Galaxy desktop client (the same public client Heroic, gogdl and Lutris use). */
export const CLIENT_ID = '46899977096215655'
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9'
export const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client'

const AUTH_HOST = 'https://auth.gog.com'
const EMBED_HOST = 'https://embed.gog.com'
const API_HOST = 'https://api.gog.com'
const USERS_HOST = 'https://users.gog.com'
const CHAT_HOST = 'https://chat.gog.com'
const PRESENCE_HOST = 'https://presence.gog.com'

export const USER_AGENT = 'Gamekins (GOG Galaxy compatible)'

export const LOGIN_URL = `${AUTH_HOST}/auth?${new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  layout: 'client2'
})}`

export interface GogSession {
  access_token: string
  refresh_token: string
  /** Galaxy user id (the id chat/presence/users services use). */
  user_id: string
  /** Epoch ms. */
  expires_at: number
  username: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user_id: string
  session_id?: string
}

export class GogApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

// ───────── OAuth ─────────

/**
 * Login code from the address GOG's sign-in page redirects to
 * (`https://embed.gog.com/on_login_success?origin=client&code=…`). Returns null for any
 * other address; throws when GOG reports an error (e.g. the user denied access).
 */
export function extractAuthCode(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'embed.gog.com' || parsed.pathname !== '/on_login_success') return null
  const error = parsed.searchParams.get('error')
  if (error) throw new Error(`GOG sign-in failed: ${parsed.searchParams.get('error_description') || error}`)
  const code = parsed.searchParams.get('code')
  return code && /^[\w.~-]{8,2048}$/.test(code) ? code : null
}

/** True for the page GOG redirects to after sign-in, with or without a code. */
export const isRedirectUrl = (url: string): boolean => url.startsWith('https://embed.gog.com/on_login_success')

async function token(params: Record<string, string>): Promise<GogSession> {
  const url = `${AUTH_HOST}/token?${new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params })}`
  // Codes and refresh tokens are single-use: never replay the request blindly.
  const res = await gogFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, 1)
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string }
  if (!res.ok || !body.access_token || !body.refresh_token || !body.user_id) {
    const status = res.ok ? 401 : res.status
    throw new GogApiError(`GOG sign-in ${status}: ${body.error_description || body.error || 'invalid token response'}`, status)
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    user_id: String(body.user_id),
    expires_at: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000,
    username: ''
  }
}

export const exchangeAuthCode = (code: string): Promise<GogSession> =>
  token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })

export const refreshSession = (refreshToken: string): Promise<GogSession> =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken })

/** fetchRetry with a GOG-specific connection error message. */
async function gogFetch(url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  try {
    return await fetchRetry(url, init, attempts)
  } catch (err) {
    if (init.signal?.aborted) throw err
    const msg = (err as Error).message?.replace(/^Couldn't reach Epic Games \((.*)\)\. Check your connection\.$/, '$1')
    throw new Error(`Couldn't reach GOG (${msg}). Check your connection.`)
  }
}

// ───────── responses ─────────

export interface GogUserData {
  isLoggedIn?: boolean
  userId?: string
  galaxyUserId?: string
  username?: string
}

/** One entry of `account/getFilteredProducts`. */
export interface FilteredProduct {
  id: number | string
  title?: string
  /** Protocol-relative image base without formatter/extension: "//images-1.gog-statics.com/<hash>". */
  image?: string
  /** "/game/<slug>" (sometimes with a locale prefix). */
  url?: string
  slug?: string
  worksOn?: Partial<Record<'Windows' | 'Mac' | 'Linux', boolean>>
  isGame?: boolean
  isMovie?: boolean
}

export interface FilteredProductsPage {
  products?: FilteredProduct[]
  page?: number
  totalPages?: number
  totalProducts?: number
}

interface Href { href?: string }

/** `api.gog.com/v2/games/{id}` (public, no sign-in needed). */
export interface GameV2 {
  size?: number
  _links?: {
    store?: Href
    logo?: Href
    boxArtImage?: Href
    backgroundImage?: Href
    galaxyBackgroundImage?: Href
    icon?: Href
    iconSquare?: Href
  }
  _embedded?: {
    product?: { id?: number; title?: string }
    productType?: string
    developers?: { name?: string }[]
    supportedOperatingSystems?: { operatingSystem?: { name?: string } }[]
  }
}

/** `api.gog.com/products/{id}` (public). */
export interface ProductV1 {
  id: number
  title?: string
  slug?: string
  game_type?: string
  content_system_compatibility?: { windows?: boolean; osx?: boolean; linux?: boolean }
  links?: { product_card?: string }
  images?: { background?: string; logo?: string; logo2x?: string; icon?: string }
}

export interface FriendEntry {
  user_id: string
  username?: string
  images?: { medium?: string; medium_2x?: string }
}

export interface PresenceEntry {
  user_id: string
  client_id?: string
  data?: Record<string, unknown>
  presence?: string
  status?: string
}

// ───────── authenticated & public calls ─────────

/** Authenticated calls. `token` resolves lazily so the session can refresh in between. */
export class GogApi {
  constructor(
    private readonly token: () => Promise<string>,
    /** Called once when GOG rejects the current token; should force a refresh. */
    private readonly reauth: () => Promise<void> = async () => undefined
  ) {}

  private async get<T>(url: string, retried = false): Promise<T> {
    const res = await gogFetch(url, {
      headers: { Authorization: `Bearer ${await this.token()}`, 'User-Agent': USER_AGENT, Accept: 'application/json' }
    })
    // Embed endpoints answer an unauthenticated request with a redirect to the login page (HTML).
    const json = (res.headers.get('content-type') ?? '').includes('json')
    const unauthorized = res.status === 401 || res.status === 403 || (res.ok && !json)
    if (unauthorized && !retried) {
      await this.reauth()
      return this.get<T>(url, true)
    }
    if (unauthorized) throw new GogApiError(`GOG didn't accept the session for ${new URL(url).pathname}`, 401)
    if (!res.ok) throw new GogApiError(`GOG API ${res.status} for ${new URL(url).pathname}`, res.status)
    return (await res.json()) as T
  }

  userData(): Promise<GogUserData> {
    return this.get(`${EMBED_HOST}/userData.json`)
  }

  /** Every owned product id (games, DLC and movies). */
  async ownedIds(): Promise<string[]> {
    const res = await this.get<{ owned?: (number | string)[] }>(`${EMBED_HOST}/user/data/games`)
    return (res.owned ?? []).map(String).filter((id) => /^\d{1,20}$/.test(id))
  }

  filteredProducts(page: number): Promise<FilteredProductsPage> {
    return this.get(`${EMBED_HOST}/account/getFilteredProducts?mediaType=1&sortBy=title&page=${page}`)
  }

  /** Owned games with titles and tile images, every page. */
  async allGames(): Promise<FilteredProduct[]> {
    const out: FilteredProduct[] = []
    let page = 1
    let total = 1
    do {
      const res = await this.filteredProducts(page)
      out.push(...(res.products ?? []))
      total = Math.min(Number(res.totalPages) || 1, 500)
      page++
    } while (page <= total)
    return out
  }

  /** Friends of a Galaxy user (needs the user's own token). */
  async friends(userId: string): Promise<FriendEntry[]> {
    const res = await this.get<{ items?: FriendEntry[] }>(`${CHAT_HOST}/users/${encodeURIComponent(userId)}/friends`)
    return (res.items ?? []).filter((f) => f && /^\d{1,24}$/.test(String(f.user_id))).map((f) => ({ ...f, user_id: String(f.user_id) }))
  }

  /** Users (of the given ids) currently online in Galaxy. */
  async statuses(userIds: string[]): Promise<PresenceEntry[]> {
    const out: PresenceEntry[] = []
    for (let i = 0; i < userIds.length; i += 100) {
      const ids = userIds.slice(i, i + 100)
      const res = await this.get<{ items?: PresenceEntry[] }>(`${PRESENCE_HOST}/statuses?user_id=${ids.map(encodeURIComponent).join(',')}`)
      out.push(...(res.items ?? []).filter((p) => p && p.user_id != null).map((p) => ({ ...p, user_id: String(p.user_id) })))
    }
    return out
  }
}

async function publicGet<T>(url: string): Promise<T | undefined> {
  const res = await gogFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  if (res.status === 404) return undefined
  if (!res.ok) throw new GogApiError(`GOG API ${res.status} for ${new URL(url).pathname}`, res.status)
  return (await res.json()) as T
}

/** Store metadata and art for one product; undefined when GOG no longer knows it. */
export const fetchGameV2 = (id: string, locale = 'en-US'): Promise<GameV2 | undefined> =>
  publicGet(`${API_HOST}/v2/games/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}`)

/** Up to 50 products per call (legacy product API: slug, game type, background, logo). */
export async function fetchProducts(ids: string[]): Promise<ProductV1[]> {
  const out: ProductV1[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    out.push(...((await publicGet<ProductV1[]>(`${API_HOST}/products?ids=${batch.join(',')}`)) ?? []))
  }
  return out
}

/** Public profile of a Galaxy user (username, avatar). */
export const fetchUser = (userId: string): Promise<{ id?: string; username?: string } | undefined> =>
  publicGet(`${USERS_HOST}/users/${encodeURIComponent(userId)}`)

// ───────── mapping ─────────

/** "//images.gog-statics.com/x.jpg" → "https://images.gog-statics.com/x.jpg"; rejects non-web URLs. */
export function httpsUrl(url: string | null | undefined): string | undefined {
  if (typeof url !== 'string') return undefined
  let s = url.trim()
  if (s.startsWith('//')) s = 'https:' + s
  else if (s.startsWith('http://')) s = 'https://' + s.slice(7)
  return /^https:\/\/[a-z0-9.-]+\//i.test(s) ? s : undefined
}

/**
 * A GOG image in a given size. GOG image URLs are `<host>/<64-hex hash>[_formatter].<ext>`;
 * known formatters include `_glx_vertical_cover` (webp portrait cover), `_196` / `_392`
 * (small tiles), `_product_card_v2_mobile_slider_639` (639×361) and `_bg_crop_1920x655`.
 */
export function gogImage(url: string | null | undefined, formatter: string, ext: 'jpg' | 'png' | 'webp'): string | undefined {
  const s = httpsUrl(url)
  if (!s) return undefined
  const m = /^(https:\/\/[^?#]*\/[0-9a-f]{64})(?:_[a-z0-9_]+)?(?:\.(?:jpe?g|png|webp))?$/i.exec(s)
  return m ? `${m[1]}${formatter}.${ext}` : s
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,200}$/i

/** "/game/the_witcher_3" or "/en/game/the_witcher_3" → "the_witcher_3". */
export function slugFromUrl(url: string | undefined): string | undefined {
  const m = url && /(?:^|\/)game\/([^/?#]+)/.exec(url)
  return m && SLUG.test(m[1]) ? m[1] : undefined
}

/** Compact per-product details we cache between library refreshes. */
export interface GogDetails {
  /** Epoch ms when fetched. */
  at: number
  /** GOG returned 404 (delisted); retried later. */
  missing?: boolean
  title?: string
  developer?: string
  tall?: string
  wide?: string
  logo?: string
  icon?: string
  /** Install size in MiB, as GOG reports it. */
  sizeMB?: number
  storeUrl?: string
  platforms?: Platform[]
  /** GAME / DLC / PACK. */
  type?: string
}

export function detailsFromV2(v2: GameV2, now = Date.now()): GogDetails {
  const links = v2._links ?? {}
  const emb = v2._embedded ?? {}
  const platforms = new Set<Platform>()
  for (const os of emb.supportedOperatingSystems ?? []) {
    const name = os.operatingSystem?.name?.toLowerCase()
    if (name === 'windows') platforms.add('Windows')
    else if (name === 'osx' || name === 'mac' || name === 'macos') platforms.add('Mac')
  }
  const developer = (emb.developers ?? []).map((d) => d.name?.trim()).filter(Boolean).join(', ')
  return {
    at: now,
    title: emb.product?.title || undefined,
    developer: developer || undefined,
    tall: gogImage(links.boxArtImage?.href, '_glx_vertical_cover', 'webp'),
    wide: httpsUrl(links.backgroundImage?.href) ?? httpsUrl(links.galaxyBackgroundImage?.href),
    logo: httpsUrl(links.logo?.href),
    icon: httpsUrl(links.iconSquare?.href) ?? httpsUrl(links.icon?.href),
    sizeMB: typeof v2.size === 'number' && Number.isFinite(v2.size) && v2.size > 0 ? v2.size : undefined,
    storeUrl: httpsUrl(links.store?.href),
    platforms: [...platforms],
    type: emb.productType || undefined
  }
}

/** One owned game before details are merged in. */
export interface OwnedEntry {
  id: string
  title?: string
  slug?: string
  /** Tile image base (protocol-relative, no formatter). */
  image?: string
  platforms?: Platform[]
}

function platformsFromWorksOn(w: FilteredProduct['worksOn']): Platform[] {
  const out: Platform[] = []
  if (w?.Windows) out.push('Windows')
  if (w?.Mac) out.push('Mac')
  return out
}

/** Games-only entries from `getFilteredProducts` (movies dropped). */
export function ownedFromFiltered(products: FilteredProduct[]): OwnedEntry[] {
  const out = new Map<string, OwnedEntry>()
  for (const p of products) {
    const id = String(p?.id ?? '')
    if (!/^\d{1,20}$/.test(id) || p.isMovie === true || p.isGame === false) continue
    out.set(id, {
      id,
      title: p.title?.trim() || undefined,
      slug: p.slug && SLUG.test(p.slug) ? p.slug : slugFromUrl(p.url),
      image: p.image,
      platforms: platformsFromWorksOn(p.worksOn)
    })
  }
  return [...out.values()]
}

/** Fallback when `getFilteredProducts` is unavailable: owned ids resolved through the product API. */
export function ownedFromProducts(products: ProductV1[]): OwnedEntry[] {
  return products
    .filter((p) => p && /^\d{1,20}$/.test(String(p.id)) && (p.game_type ?? 'game') === 'game')
    .map((p) => {
      const c = p.content_system_compatibility
      const platforms: Platform[] = []
      if (c?.windows) platforms.push('Windows')
      if (c?.osx) platforms.push('Mac')
      return {
        id: String(p.id),
        title: p.title?.trim() || undefined,
        slug: p.slug && SLUG.test(p.slug) ? p.slug : slugFromUrl(p.links?.product_card),
        // The legacy background is a full URL; reuse it as the tile base for wide art.
        image: p.images?.background,
        platforms
      }
    })
}

/** Library record for an owned GOG game. */
export function toProviderGame(entry: OwnedEntry, details?: GogDetails): ProviderGame {
  const d = details && !details.missing ? details : undefined
  const platforms = entry.platforms?.length ? entry.platforms : d?.platforms ?? []
  const tile = entry.image
  const tall = d?.tall
  return {
    key: `gog:${entry.id}`,
    provider: 'gog',
    appName: entry.id,
    title: entry.title || d?.title || `GOG game ${entry.id}`,
    namespace: '',
    catalogItemId: '',
    developer: d?.developer,
    images: {
      tall,
      wide: d?.wide ?? gogImage(tile, '_product_card_v2_mobile_slider_639', 'jpg'),
      logo: d?.logo,
      thumb: tall ?? gogImage(tile, '_196', 'jpg')
    },
    platforms: [...new Set(platforms)],
    // GOG games are DRM-free. Galaxy handles updates, so no latest version is tracked here.
    canRunOffline: true,
    requiresOwnershipToken: false,
    storeUrl: entry.slug ? `https://www.gog.com/game/${entry.slug}` : d?.storeUrl
  }
}
