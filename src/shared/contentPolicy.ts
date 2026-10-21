import { STORE_DISTRIBUTION } from './distribution'
import type { DownloadJob, Game, GameDetails, GameImages } from './types'

/** Store builds display no unclassified catalog media. Local artwork uses opaque IDs. */
export function safeImageSource(source: string | undefined, store = STORE_DISTRIBUTION): string | undefined {
  if (!source || !store) return source
  if (/^gamekins-art:\/\/image\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(source)) return source
  // Bundled app assets are emitted by Vite. Do not accept network-relative paths,
  // data URLs, file URLs, or arbitrary local paths supplied by catalog metadata.
  if (/^(?:\.\/)?assets\/[A-Za-z0-9_.-]+\.(png|jpg|webp|svg)$/.test(source) ||
      /^\/assets\/[A-Za-z0-9_.-]+\.(png|jpg|webp|svg)$/.test(source)) return source
  return undefined
}

function localArtwork(source: string | undefined): string | undefined {
  return source?.startsWith('gamekins-art:') ? safeImageSource(source, true) : undefined
}

/** Titles, ownership, install state and launch behavior remain available. */
export function sanitizeGameForDistribution(game: Game, store = STORE_DISTRIBUTION): Game {
  if (!store) return game
  const images: GameImages = {}
  for (const key of ['tall', 'wide', 'logo', 'thumb'] as const) {
    const source = localArtwork(game.images[key])
    if (source) images[key] = source
  }
  return {
    ...game,
    description: undefined,
    images,
    dlc: game.dlc.map((dlc) => ({ ...dlc, image: localArtwork(dlc.image) }))
  }
}

export function sanitizeDownloadForDistribution(job: DownloadJob, store = STORE_DISTRIBUTION): DownloadJob {
  return store ? { ...job, image: localArtwork(job.image) } : job
}

export function sanitizeGameDetailsForDistribution(details: GameDetails, store = STORE_DISTRIBUTION): GameDetails {
  return store ? { title: details.title, fetchedAt: details.fetchedAt } : details
}

/** Store requests are displayed as explicit external actions, never auto-opened. */
export function externalStoreRequest(source: string | undefined): string | undefined {
  if (!source) return undefined
  try {
    const url = new URL(source)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
    const hosts = ['epicgames.com', 'steampowered.com', 'steamcommunity.com', 'gog.com']
    return hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : undefined
  } catch {
    return undefined
  }
}
