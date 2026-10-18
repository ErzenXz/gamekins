// Steam web sign-in tokens and the Web API calls Gamekins makes with them.
//
// Signing in on steamcommunity.com sets the `steamLoginSecure` cookie: "<steamid64>||<JWT>"
// (URL-encoded as "%7C%7C"). That JWT is a web access token: the Web API accepts it as
// `access_token=` on service methods (IPlayerService, IFriendsListService...) without an API key.

import { net } from 'electron'
import type { Friend, GameImages } from '@shared/types'

const API = 'https://api.steampowered.com'

export interface SteamTokenClaims {
  /** steamid64 of the account. */
  sub?: string
  /** Expiry, epoch seconds. */
  exp?: number
  iat?: number
  aud?: string[] | string
}

export interface OwnedGame {
  appid: number
  name?: string
  /** Minutes. */
  playtime_forever?: number
  playtime_2weeks?: number
  /** Epoch seconds. */
  rtime_last_played?: number
  img_icon_url?: string
}

/** What we know about a Steam account's public profile and presence. */
export interface Persona {
  steamId: string
  name?: string
  /** 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 looking to trade, 6 looking to play. */
  personaState: number
  gameId?: string
  gameName?: string
  /** Epoch seconds. */
  lastLogoff?: number
}

export class SteamApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SteamApiError'
  }
}

export const isAuthError = (err: unknown): boolean => err instanceof SteamApiError && (err.status === 401 || err.status === 403)

// ───────── cookies & tokens ─────────

/** steamLoginSecure → { steamId, token }, or null if it isn't a signed-in cookie. */
export function parseSteamLoginSecure(value: string | undefined | null): { steamId: string; token: string } | null {
  if (!value) return null
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    /* already decoded */
  }
  const sep = decoded.indexOf('||')
  if (sep < 0) return null
  const steamId = decoded.slice(0, sep)
  const token = decoded.slice(sep + 2)
  if (!/^\d{17}$/.test(steamId) || token.split('.').length !== 3) return null
  return { steamId, token }
}

/** The JWT's claims (unverified: only used to learn the expiry), or null if it isn't a JWT. */
export function decodeJwt(token: string): SteamTokenClaims | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const claims = JSON.parse(json) as unknown
    return claims && typeof claims === 'object' ? (claims as SteamTokenClaims) : null
  } catch {
    return null
  }
}

/** Token expiry in epoch ms, or null if unknown. */
export function jwtExpiry(token: string): number | null {
  const exp = decodeJwt(token)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

// ───────── presence ─────────

const STATE_TEXT: Record<number, string> = { 2: 'Busy', 4: 'Snooze', 5: 'Looking to trade', 6: 'Looking to play' }

/** Steam persona → the friends list's status/activity. */
export function personaPresence(p: Pick<Persona, 'personaState' | 'gameId' | 'gameName'>): Pick<Friend, 'status' | 'activity' | 'app'> {
  const state = p.personaState
  if (!state) return { status: 'offline' }
  const playing = !!p.gameName || (!!p.gameId && p.gameId !== '0')
  if (playing) {
    const game = p.gameName?.trim() || 'a game'
    return { status: 'playing', activity: `Playing ${game}`, app: p.gameName?.trim() || undefined }
  }
  return {
    status: state === 2 || state === 3 || state === 4 ? 'away' : 'online',
    activity: STATE_TEXT[state]
  }
}

// ───────── HTTP ─────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const RETRY = new Set([408, 429, 500, 502, 503, 504])

/** GET with retries on network failures, 429 and 5xx. Uses Chromium's network stack (system proxy). */
export async function steamFetch(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await net.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
      if (!RETRY.has(res.status) || i === attempts - 1) return res
      last = new Error(`HTTP ${res.status}`)
    } catch (err) {
      last = err
    }
    await sleep(500 * 3 ** i)
  }
  const msg = last instanceof Error ? (last.cause as Error)?.message || last.message : String(last)
  throw new Error(`Couldn't reach Steam (${msg}). Check your connection.`)
}

/** Call a Web API method with a web access token. Throws SteamApiError on HTTP errors. */
export async function webApi<T>(path: string, token: string, params: Record<string, string | number | boolean | (string | number)[]> = {}): Promise<T> {
  const url = new URL(`${API}/${path}`)
  url.searchParams.set('access_token', token)
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item, i) => url.searchParams.set(`${k}[${i}]`, String(item)))
    else url.searchParams.set(k, String(v))
  }
  const res = await steamFetch(url.toString())
  if (!res.ok) throw new SteamApiError(`Steam returned ${res.status}`, res.status)
  return (await res.json()) as T
}

export async function getOwnedGames(token: string, steamId: string): Promise<OwnedGame[]> {
  const data = await webApi<{ response?: { games?: OwnedGame[] } }>('IPlayerService/GetOwnedGames/v1/', token, {
    steamid: steamId,
    include_appinfo: true,
    include_played_free_games: true,
    skip_unvetted_apps: false
  })
  return (data.response?.games ?? []).filter((g) => Number.isInteger(g.appid) && g.appid > 0)
}

export interface FriendsListEntry {
  ulfriendid: string
  /** 0 none, 1 blocked, 2 request recipient (they asked us), 3 friend, 4 request initiator (we asked), 5 ignored, 6 ignored friend. */
  efriendrelationship: number
}

export async function getFriendsList(token: string): Promise<FriendsListEntry[]> {
  const data = await webApi<{ response?: { friendslist?: { friends?: FriendsListEntry[] } } }>('IFriendsListService/GetFriendsList/v1/', token)
  return (data.response?.friendslist?.friends ?? []).filter((f) => /^\d{17}$/.test(String(f.ulfriendid)))
}

/**
 * ISteamUser/GetPlayerSummaries is a classic (key-based) method; when it answers 400 ("key is
 * missing") for access tokens we switch to IPlayerService/GetPlayerLinkDetails, the service
 * method Steam's own web friends list uses, for the rest of the session.
 */
let summariesUnsupported = false

interface SummaryPlayer {
  steamid: string
  personaname?: string
  personastate?: number
  gameid?: string
  gameextrainfo?: string
  lastlogoff?: number
}

interface LinkDetails {
  public_data?: { steamid?: string; persona_name?: string }
  private_data?: { persona_state?: number; game_id?: string; game_extra_info?: string; last_logoff_time?: number }
}

async function summaries(token: string, ids: string[]): Promise<Persona[]> {
  const data = await webApi<{ response?: { players?: SummaryPlayer[] } }>('ISteamUser/GetPlayerSummaries/v2/', token, { steamids: ids.join(',') })
  return (data.response?.players ?? []).map((p) => ({
    steamId: String(p.steamid),
    name: p.personaname,
    personaState: p.personastate ?? 0,
    gameId: p.gameid,
    gameName: p.gameextrainfo,
    lastLogoff: p.lastlogoff
  }))
}

async function linkDetails(token: string, ids: string[]): Promise<Persona[]> {
  const data = await webApi<{ response?: { accounts?: LinkDetails[] } }>('IPlayerService/GetPlayerLinkDetails/v1/', token, { steamids: ids })
  const out: Persona[] = []
  for (const a of data.response?.accounts ?? []) {
    const id = a.public_data?.steamid
    if (!id) continue
    const p = a.private_data ?? {}
    out.push({
      steamId: String(id),
      name: a.public_data?.persona_name,
      personaState: p.persona_state ?? 0,
      gameId: p.game_id && p.game_id !== '0' ? String(p.game_id) : undefined,
      gameName: p.game_extra_info || undefined,
      lastLogoff: p.last_logoff_time
    })
  }
  return out
}

/** Names and presence for up to any number of accounts (batches of 100). */
export async function getPersonas(token: string, steamIds: string[]): Promise<Map<string, Persona>> {
  const out = new Map<string, Persona>()
  const ids = [...new Set(steamIds)]
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100)
    let list: Persona[] | null = null
    if (!summariesUnsupported) {
      try {
        list = await summaries(token, batch)
      } catch (err) {
        if (!(err instanceof SteamApiError) || ![400, 401, 403].includes(err.status)) throw err
        if (err.status === 400) summariesUnsupported = true
      }
    }
    // Auth errors from the service method are real (expired token): let them propagate.
    list ??= await linkDetails(token, batch)
    for (const p of list) out.set(p.steamId, p)
  }
  return out
}

const ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/'

interface StoreItem {
  appid?: number
  success?: number
  assets?: Record<string, string | number | undefined> & { asset_url_format?: string }
}

export type StoreArt = Pick<GameImages, 'tall' | 'wide' | 'thumb'>

/** Art URLs from a store item's asset list (newer apps keep art under hashed folders). */
export function storeItemImages(item: StoreItem): StoreArt {
  const a = item.assets
  const format = a?.asset_url_format
  if (!a || typeof format !== 'string') return {}
  const url = (key: string): string | undefined => {
    const file = a[key]
    return typeof file === 'string' && file ? ASSET_BASE + format.replace('${FILENAME}', file) : undefined
  }
  return {
    tall: url('library_capsule'),
    wide: url('library_hero'),
    thumb: url('header')
  }
}

/** Library art for many apps at once from the public store API (no key or token). */
export async function getStoreArt(appids: string[]): Promise<Map<string, StoreArt>> {
  const out = new Map<string, StoreArt>()
  for (let i = 0; i < appids.length; i += 100) {
    const input = {
      ids: appids.slice(i, i + 100).map((id) => ({ appid: Number(id) })),
      context: { language: 'english', country_code: 'US' },
      data_request: { include_assets: true }
    }
    const res = await steamFetch(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`)
    if (!res.ok) throw new SteamApiError(`Steam returned ${res.status}`, res.status)
    const data = (await res.json()) as { response?: { store_items?: StoreItem[] } }
    for (const item of data.response?.store_items ?? []) {
      if (item.success !== 1 || !item.appid) continue
      out.set(String(item.appid), storeItemImages(item))
    }
  }
  return out
}

/** Persona name from the public community profile XML (no token needed). */
export async function communityName(steamId: string): Promise<string | undefined> {
  const res = await steamFetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, {}, 1)
  if (!res.ok) return undefined
  const m = /<steamID>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/steamID>/.exec(await res.text())
  return (m?.[1] ?? m?.[2])?.trim() || undefined
}
