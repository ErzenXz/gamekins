import { Gift } from 'lucide-react'
import { useMemo } from 'react'
import { Img } from '../../components/library/Img'
import { img, shortDate } from '../../lib/format'
import { useStore } from '../../store'
import { Shelf } from './Shelf'

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, '')

/** "Free on Epic this week", laid out like Steam's What's New shelf (event capsules, paged). */
export function FreeGamesShelf(): React.JSX.Element | null {
  const free = useStore((s) => s.freeGames)
  const games = useStore((s) => s.games)
  const owned = useMemo(() => new Set(games.map((g) => norm(g.title))), [games])
  if (!free.length) return null
  const sorted = [...free].sort((a, b) => Number(b.current) - Number(a.current))

  return (
    <div className="whatsnew">
      <Shelf title="Free on Epic this week" className="whatsnew-shelf">
        {sorted.map((f) => {
          const inLib = owned.has(norm(f.title))
          return (
            <div key={f.title + f.startDate} className="event">
              <div className="event-when">
                {f.current ? `Free until ${shortDate(f.endDate)}` : `${shortDate(f.startDate)} – ${shortDate(f.endDate)}`}
              </div>
              <button
                className={`event-card ${f.current ? 'now' : 'soon'}`}
                onClick={() => useStore.getState().navigate({ view: 'store', url: f.url })}
                title={f.current ? `Get ${f.title} in the store` : `${f.title} is free from ${shortDate(f.startDate)}`}
              >
                <div className="event-art">
                  <Img src={img(f.image, 640)} title={f.title} />
                </div>
                <div className="event-foot">
                  <span className={`event-tag ${f.current ? 'now' : 'soon'}`}>{f.current ? 'Free now' : 'Coming soon'}</span>
                  {inLib && <span className="event-tag owned">In library</span>}
                  <span className="event-title">{f.title}</span>
                  <span className="event-src">
                    <Gift size={13} /> Epic Games Store
                  </span>
                </div>
              </button>
            </div>
          )
        })}
      </Shelf>
    </div>
  )
}
