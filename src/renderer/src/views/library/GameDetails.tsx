import '../../styles/game-details.css'
import { ChevronLeft, ChevronRight, ExternalLink, Film, Gamepad2, Timer, X } from 'lucide-react'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { GameDetails, HltbInfo, SteamInfo } from '@shared/types'

// ───────────── data: one fetch per game per session, shared by every component ─────────────

type Entry = { status: 'loading' | 'done'; details: GameDetails | null }
const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

function load(key: string, force = false): void {
  const cur = cache.get(key)
  if (cur && !force && (cur.status === 'loading' || cur.details)) return
  cache.set(key, { status: 'loading', details: cur?.details ?? null })
  notify()
  window.gamekins.games
    .details(key, force)
    .then((details) => cache.set(key, { status: 'done', details }))
    .catch(() => cache.set(key, { status: 'done', details: cur?.details ?? null }))
    .finally(notify)
}

/** Steam + HowLongToBeat details for a game (fetched lazily, cached by main for two weeks). */
export function useGameDetails(key: string): { details: GameDetails | null; loading: boolean; refresh: () => void } {
  useEffect(() => load(key), [key])
  const entry = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => cache.get(key)
  )
  const refresh = useCallback(() => load(key, true), [key])
  return { details: entry?.details ?? null, loading: entry?.status === 'loading', refresh }
}

const open = (url: string): void => void window.gamekins.app.openExternal(url)

// ───────────── How long to beat ─────────────

export function HltbCard({ hltb }: { hltb?: HltbInfo }): React.JSX.Element | null {
  if (!hltb || !(hltb.mainHours || hltb.extraHours || hltb.completionistHours)) return null
  const rows: [string, number | undefined, string][] = [
    ['Main Story', hltb.mainHours, 'main'],
    ['Main + Extras', hltb.extraHours, 'extra'],
    ['Completionist', hltb.completionistHours, 'comp']
  ]
  const max = Math.max(...rows.map(([, h]) => h ?? 0), 1)
  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title gd-title-icon">
        <Timer size={13} /> How long to beat
      </h3>
      <div className="gp-panel gd-hltb">
        {rows.map(([label, hours, tone]) =>
          hours ? (
            <div key={label} className="gd-hltb-row">
              <div className="gd-hltb-label">
                <span>{label}</span>
                <b>{formatHours(hours)}</b>
              </div>
              <div className="gd-hltb-bar">
                <div className={`gd-hltb-fill ${tone}`} style={{ width: `${Math.max(6, (hours / max) * 100)}%` }} />
              </div>
            </div>
          ) : null
        )}
        <button className="gp-panel-link" onClick={() => open(hltb.url)}>
          View on HowLongToBeat <ExternalLink size={11} />
        </button>
      </div>
    </section>
  )
}

function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`
  return `${h % 1 === 0 ? h : h.toFixed(1)} hours`
}

// ───────────── Reviews ─────────────

function reviewTone(summary: string): string {
  if (/overwhelmingly positive|very positive/i.test(summary)) return 'pos'
  if (/positive/i.test(summary)) return 'pos-mild'
  if (/mixed/i.test(summary)) return 'mixed'
  return 'neg'
}

export function ReviewsCard({ steam }: { steam?: SteamInfo }): React.JSX.Element | null {
  if (!steam?.reviews && !steam?.metacritic) return null
  const r = steam.reviews
  const pct = r && r.total ? Math.round((r.positive / r.total) * 100) : undefined
  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title">Reviews</h3>
      <div className="gp-panel gd-reviews">
        {r && (
          <button className="gd-review" onClick={() => open(steam.url)} title="Open on Steam">
            <span className="gd-review-src">Steam reviews</span>
            <span className={`gd-review-sum ${reviewTone(r.summary)}`}>{r.summary}</span>
            <span className="gd-review-meta">
              {pct}% of {r.total.toLocaleString()} reviews positive
            </span>
          </button>
        )}
        {steam.metacritic && (
          <button className="gd-meta" onClick={() => open(steam.metacritic!.url)} title="Open on Metacritic">
            <span
              className={`gd-meta-score ${steam.metacritic.score >= 75 ? 'good' : steam.metacritic.score >= 50 ? 'ok' : 'bad'}`}
            >
              {steam.metacritic.score}
            </span>
            <span className="gd-review-src">Metascore</span>
          </button>
        )}
      </div>
    </section>
  )
}

// ───────────── Details (genres, dates, publisher…) ─────────────

const CONTROLLER: Record<string, string> = { full: 'Full controller support', partial: 'Partial controller support' }

export function DetailsCard({ steam }: { steam?: SteamInfo }): React.JSX.Element | null {
  if (!steam) return null
  const rows: [string, React.ReactNode][] = []
  if (steam.genres.length)
    rows.push([
      'Genres',
      <span key="g" className="gd-chips">
        {steam.genres.map((g) => (
          <span key={g} className="gd-chip">
            {g}
          </span>
        ))}
      </span>
    ])
  if (steam.releaseDate) rows.push(['Release date', steam.releaseDate])
  if (steam.publishers.length) rows.push(['Publisher', steam.publishers.join(', ')])
  if (steam.controllerSupport) rows.push(['Controller', CONTROLLER[steam.controllerSupport] ?? steam.controllerSupport])
  if (steam.achievements) rows.push(['Achievements', `${steam.achievements} on Steam`])
  if (!rows.length) return null
  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title">Details</h3>
      <div className="gp-panel">
        {rows.map(([label, value]) => (
          <div key={label} className="gp-row">
            <span className="gp-row-label">{label}</span>
            <span className="gp-row-value">{value}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ───────────── Media: screenshots + trailers, with a lightbox ─────────────

export function MediaSection({ steam }: { steam?: SteamInfo }): React.JSX.Element | null {
  const [index, setIndex] = useState<number | null>(null)
  const shots = steam?.screenshots ?? []
  if (!steam || (!shots.length && !steam.trailers.length)) return null
  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title">
        Screenshots
        <span>{shots.length}</span>
      </h3>
      <div className="gd-media">
        {steam.trailers.slice(0, 1).map((t) => (
          <button key={t.thumb} className="gd-shot trailer" onClick={() => open(steam.url)} title={`${t.name} (opens on Steam)`}>
            <img src={t.thumb} alt="" loading="lazy" decoding="async" draggable={false} />
            <span className="gd-play">
              <Film size={16} /> Trailer
            </span>
          </button>
        ))}
        {shots.map((s, i) => (
          <button key={s.thumb} className="gd-shot" onClick={() => setIndex(i)} title="View screenshot">
            <img src={s.thumb} alt="" loading="lazy" decoding="async" draggable={false} />
          </button>
        ))}
      </div>
      {index !== null && <Lightbox shots={shots} index={index} onIndex={setIndex} onClose={() => setIndex(null)} />}
    </section>
  )
}

function Lightbox({
  shots,
  index,
  onIndex,
  onClose
}: {
  shots: { thumb: string; full: string }[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}): React.JSX.Element {
  const go = useCallback((d: number) => onIndex((index + d + shots.length) % shots.length), [index, onIndex, shots.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [go, onClose])
  return (
    <div className="gd-lightbox" role="dialog" aria-label="Screenshot viewer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <img key={shots[index].full} src={shots[index].full} alt="" draggable={false} />
      <button className="gd-lb-btn prev" onClick={() => go(-1)} aria-label="Previous screenshot">
        <ChevronLeft size={28} />
      </button>
      <button className="gd-lb-btn next" onClick={() => go(1)} aria-label="Next screenshot">
        <ChevronRight size={28} />
      </button>
      <button className="gd-lb-close" onClick={onClose} aria-label="Close">
        <X size={20} />
      </button>
      <div className="gd-lb-count">
        {index + 1} / {shots.length}
      </div>
    </div>
  )
}

// ───────────── Features + system requirements ─────────────

export function FeaturesSection({ steam }: { steam?: SteamInfo }): React.JSX.Element | null {
  const [reqOpen, setReqOpen] = useState(false)
  if (!steam) return null
  const req = steam.requirements
  const hasReq = !!(req?.minimum || req?.recommended)
  if (!steam.features.length && !hasReq) return null
  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title">Features</h3>
      <div className="gp-panel">
        {steam.features.length > 0 && (
          <div className="gd-chips gd-features">
            {steam.features.slice(0, 14).map((f) => (
              <span key={f} className="gd-chip">
                {/controller/i.test(f) && <Gamepad2 size={12} />}
                {f}
              </span>
            ))}
          </div>
        )}
        {hasReq && (
          <>
            <button className="gp-panel-link" onClick={() => setReqOpen(!reqOpen)}>
              {reqOpen ? 'Hide system requirements' : 'Show system requirements'}
            </button>
            {reqOpen && (
              <div className="gd-req">
                {req?.minimum && (
                  <div>
                    <b>Minimum</b>
                    <pre>{req.minimum.replace(/^Minimum:\s*/i, '')}</pre>
                  </div>
                )}
                {req?.recommended && (
                  <div>
                    <b>Recommended</b>
                    <pre>{req.recommended.replace(/^Recommended:\s*/i, '')}</pre>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/** Small attribution line for third-party data. */
export function DataSources({ details }: { details: GameDetails | null }): React.JSX.Element | null {
  if (!details || (!details.steam && !details.hltb)) return null
  return (
    <p className="gd-sources">
      Extra details from{' '}
      {details.steam && <button onClick={() => open(details.steam!.url)}>Steam</button>}
      {details.steam && details.hltb && ' and '}
      {details.hltb && <button onClick={() => open(details.hltb!.url)}>HowLongToBeat</button>}. Matched by title.
    </p>
  )
}
