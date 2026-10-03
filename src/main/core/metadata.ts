// Rich game details beyond what Epic's catalog offers: screenshots, genres, reviews and
// Steam's library art (Steam's public store API), plus "how long to beat" (HowLongToBeat).
// Fetched lazily when a game page opens and cached on disk; every source is best-effort.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameDetails, HltbInfo, SteamInfo } from '@shared/types'
import { fetchRetry } from '../providers/epic/api'
import { dataDir } from './store'

const FRESH_MS = 14 * 24 * 60 * 60_000
const MISS_MS = 3 * 24 * 60 * 60_000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

// ───────────── title matching ─────────────

const EDITION_WORDS =
  /\b(game of the year|goty|definitive|deluxe|complete|ultimate|gold|standard|enhanced|remastered|anniversary|director'?s cut|edition|collection)\b/g

/** "Rocket League®" -> "rocket league", for comparing names across stores. */
export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const looseTitle = (t: string): string => normTitle(t).replace(EDITION_WORDS, ' ').replace(/\s+/g, ' ').trim()

/** Sørensen–Dice similarity of character bigrams, 0..1. */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2)
    const n = grams.get(g) ?? 0
    if (n > 0) {
      grams.set(g, n - 1)
      hits++
    }
  }
  return (2 * hits) / (a.length + b.length - 2)
}

/** Numbers in a title ("Cat Quest II" vs "Cat Quest") must agree, so sequels never match. */
function sequelMarks(t: string): string {
  const roman: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' }
  return t
    .split(' ')
    .map((w) => roman[w] ?? w)
    .filter((w) => /^\d+$/.test(w))
    .join(',')
}

/** Pick the candidate that is the same game as `title`, or nothing if none is close enough. */
export function bestMatch<T>(title: string, items: T[], nameOf: (t: T) => string): T | undefined {
  const exact = normTitle(title)
  const loose = looseTitle(title)
  const marks = sequelMarks(loose)
  let best: T | undefined
  let bestScore = 0
  for (const it of items) {
    const n = normTitle(nameOf(it))
    if (n === exact) return it
    const l = looseTitle(nameOf(it))
    if (sequelMarks(l) !== marks) continue
    const score = l === loose ? 0.99 : similarity(l, loose)
    if (score > bestScore) {
      bestScore = score
      best = it
    }
  }
  return bestScore >= 0.88 ? best : undefined
}

// ───────────── Steam ─────────────

interface SteamSearchItem {
  id: number
  name: string
  type: string
}

/** Steam's store HTML -> readable plain text with paragraph breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchRetry(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) } }, 2)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`)
  return (await res.json()) as T
}

async function steamInfo(title: string): Promise<SteamInfo | undefined> {
  const search = await json<{ items?: SteamSearchItem[] }>(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=US`
  )
  const hit = bestMatch(title, (search.items ?? []).filter((i) => i.type === 'app'), (i) => i.name)
  if (!hit) return undefined

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const detailsRes = await json<Record<string, { success: boolean; data?: any }>>(
    `https://store.steampowered.com/api/appdetails?appids=${hit.id}&l=english&cc=US`
  )
  const d = detailsRes[String(hit.id)]?.data
  if (!d) return undefined
  const reviews = await json<{ query_summary?: any }>(
    `https://store.steampowered.com/appreviews/${hit.id}?json=1&language=all&purchase_type=all&num_per_page=0`
  ).catch(() => null)
  const q = reviews?.query_summary
  const cdn = `https://cdn.akamai.steamstatic.com/steam/apps/${hit.id}`
  return {
    appId: hit.id,
    url: `https://store.steampowered.com/app/${hit.id}`,
    name: d.name,
    shortDescription: d.short_description ? htmlToText(d.short_description) : undefined,
    about: d.about_the_game ? htmlToText(d.about_the_game).slice(0, 6000) : undefined,
    genres: (d.genres ?? []).map((g: any) => g.description),
    features: (d.categories ?? []).map((c: any) => c.description),
    developers: d.developers ?? [],
    publishers: d.publishers ?? [],
    releaseDate: d.release_date?.date || undefined,
    metacritic: d.metacritic?.score ? { score: d.metacritic.score, url: d.metacritic.url } : undefined,
    reviews:
      q && q.total_reviews > 0
        ? { summary: q.review_score_desc, positive: q.total_positive, total: q.total_reviews }
        : undefined,
    screenshots: (d.screenshots ?? []).slice(0, 12).map((s: any) => ({ thumb: s.path_thumbnail, full: s.path_full })),
    trailers: (d.movies ?? []).slice(0, 4).map((m: any) => ({ name: m.name, thumb: m.thumbnail })),
    art: {
      hero: `${cdn}/library_hero.jpg`,
      logo: `${cdn}/logo.png`,
      cover: `${cdn}/library_600x900.jpg`,
      header: d.header_image
    },
    website: d.website || undefined,
    controllerSupport: d.controller_support || undefined,
    requirements: {
      minimum: d.pc_requirements?.minimum ? htmlToText(d.pc_requirements.minimum) : undefined,
      recommended: d.pc_requirements?.recommended ? htmlToText(d.pc_requirements.recommended) : undefined
    },
    achievements: d.achievements?.total || undefined
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ───────────── HowLongToBeat ─────────────
// No official API: this mirrors what howlongtobeat.com's own search page does
// (a short-lived token from /api/search/site/init, then POST /api/search/site).

const HLTB = 'https://howlongtobeat.com'
let hltbToken: { value: string; at: number } | null = null

async function hltbAuth(force = false): Promise<string> {
  if (!force && hltbToken && Date.now() - hltbToken.at < 10 * 60_000) return hltbToken.value
  const r = await json<{ token: string }>(`${HLTB}/api/search/site/init?t=${Date.now()}`, {
    headers: { Referer: `${HLTB}/` }
  })
  hltbToken = { value: r.token, at: Date.now() }
  return r.token
}

interface HltbRow {
  game_id: number
  game_name: string
  game_image?: string
  comp_main: number
  comp_plus: number
  comp_100: number
  comp_all: number
  review_score?: number
}

async function hltbInfo(title: string): Promise<HltbInfo | undefined> {
  const body = {
    searchType: 'games',
    searchTerms: looseTitle(title).split(' ').filter(Boolean),
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: '',
        sortCategory: 'popular',
        rangeCategory: 'main',
        rangeTime: { min: null, max: null },
        gameplay: { perspective: '', flow: '', genre: '' },
        year: '',
        modifier: ''
      },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '',
      sort: 0,
      randomizer: 0
    },
    useCache: true
  }
  const search = async (token: string): Promise<Response> =>
    fetchRetry(
      `${HLTB}/api/search/site`,
      {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Referer: `${HLTB}/`,
          Origin: HLTB,
          'Content-Type': 'application/json',
          'x-auth-token': token
        },
        body: JSON.stringify(body)
      },
      2
    )
  let res = await search(await hltbAuth())
  if (res.status === 403) res = await search(await hltbAuth(true)) // token expired
  if (!res.ok) throw new Error(`HowLongToBeat: HTTP ${res.status}`)
  const rows = ((await res.json()) as { data?: HltbRow[] }).data ?? []
  const hit = bestMatch(title, rows, (r) => r.game_name)
  if (!hit) return undefined
  const hours = (s: number): number | undefined => (s > 0 ? Math.round((s / 3600) * 10) / 10 : undefined)
  return {
    id: hit.game_id,
    url: `${HLTB}/game/${hit.game_id}`,
    name: hit.game_name,
    mainHours: hours(hit.comp_main),
    extraHours: hours(hit.comp_plus),
    completionistHours: hours(hit.comp_100),
    allStylesHours: hours(hit.comp_all),
    image: hit.game_image ? `${HLTB}/games/${hit.game_image}` : undefined,
    score: hit.review_score || undefined
  }
}

// ───────────── cache + public entry ─────────────

const inflight = new Map<string, Promise<GameDetails>>()

function cacheFile(key: string): string {
  const id = createHash('sha1').update(key).digest('hex').slice(0, 16)
  return join(dataDir('metadata'), `${id}.json`)
}

async function readCache(key: string): Promise<GameDetails | null> {
  try {
    return JSON.parse(await readFile(cacheFile(key), 'utf8')) as GameDetails
  } catch {
    return null
  }
}

/** Details for a game, from cache when fresh. `force` refetches. Never throws. */
export async function gameDetails(key: string, title: string, force = false): Promise<GameDetails> {
  const cached = await readCache(key)
  if (cached && !force) {
    const age = Date.now() - cached.fetchedAt
    const complete = !!cached.steam && !!cached.hltb
    if (age < (complete ? FRESH_MS : MISS_MS)) return cached
  }
  const running = inflight.get(key)
  if (running) return running

  const task = (async (): Promise<GameDetails> => {
    const [steam, hltb] = await Promise.allSettled([steamInfo(title), hltbInfo(title)])
    const pick = <T>(r: PromiseSettledResult<T | undefined>, prev?: T): T | undefined => {
      if (r.status === 'fulfilled') return r.value
      console.warn('[metadata]', title, (r.reason as Error)?.message)
      return prev // keep the last good data when a source is temporarily down
    }
    const details: GameDetails = {
      fetchedAt: Date.now(),
      title,
      steam: pick(steam, cached?.steam),
      hltb: pick(hltb, cached?.hltb)
    }
    await mkdir(dataDir('metadata'), { recursive: true })
    await writeFile(cacheFile(key), JSON.stringify(details)).catch(() => undefined)
    return details
  })().finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}
