/** Small Steam-style glyphs (filled shapes lucide doesn't have). They inherit `currentColor`. */

export function PlayGlyph({ size }: { size?: number }): React.JSX.Element {
  return (
    <svg className="glyph" viewBox="0 0 36 36" width={size} height={size} aria-hidden>
      <path d="M10 6.5v23a1.5 1.5 0 0 0 2.3 1.27l18.4-11.5a1.5 1.5 0 0 0 0-2.54L12.3 5.23A1.5 1.5 0 0 0 10 6.5z" fill="currentColor" />
    </svg>
  )
}

export function DownloadGlyph({ size }: { size?: number }): React.JSX.Element {
  return (
    <svg className="glyph" viewBox="0 0 36 36" width={size} height={size} aria-hidden>
      <path d="M16 4h4v15.2l5.6-5.6 2.8 2.8L18 26.8 7.6 16.4l2.8-2.8 5.6 5.6z" fill="currentColor" />
      <path d="M5 28h26v4H5z" fill="currentColor" />
    </svg>
  )
}

export function PauseGlyph({ size }: { size?: number }): React.JSX.Element {
  return (
    <svg className="glyph" viewBox="0 0 36 36" width={size} height={size} aria-hidden>
      <path d="M9 6h6v24H9zM21 6h6v24h-6z" fill="currentColor" />
    </svg>
  )
}

export function StopGlyph({ size }: { size?: number }): React.JSX.Element {
  return (
    <svg className="glyph" viewBox="0 0 36 36" width={size} height={size} aria-hidden>
      <path d="M9.2 6.4 18 15.2l8.8-8.8 2.8 2.8-8.8 8.8 8.8 8.8-2.8 2.8-8.8-8.8-8.8 8.8-2.8-2.8 8.8-8.8-8.8-8.8z" fill="currentColor" />
    </svg>
  )
}

/** Steam's 2×2 "Collections" button glyph. */
export function GridGlyph(): React.JSX.Element {
  return (
    <span className="grid-glyph" aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

/** Line-art house behind the left panel's "Home" bar. */
export function HouseArt(): React.JSX.Element {
  return (
    <svg className="home-art" viewBox="0 0 222 134" aria-hidden>
      <path
        d="M22 124 111 66l89 58M150 91V70h14v30M44 110v24M178 110v24M100 92h22v14h-22zM111 92v14M100 99h22"
        fill="rgba(255,255,255,.05)"
        stroke="#9b9b9b"
        strokeWidth="2"
      />
    </svg>
  )
}

export function ClockGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 5.5V10l3 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function ReadyGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.2 6.6v6.8L13.6 10z" fill="currentColor" />
    </svg>
  )
}

/** "—" / "+" collapse glyph of left-list section headers. */
export function CollapseGlyph({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg className="collapse-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d="M3 7.25h10v1.5H3z" fill="currentColor" />
      {!open && <path d="M7.25 3h1.5v10h-1.5z" fill="currentColor" />}
    </svg>
  )
}

/** Download ring that replaces a list icon while the game downloads. */
export function ProgressRing({ pct, paused }: { pct: number; paused?: boolean }): React.JSX.Element {
  const c = 2 * Math.PI * 8.5
  return (
    <svg className={`ring ${paused ? 'paused' : ''}`} viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="rgba(116,209,255,.18)" strokeWidth="2" />
      <circle
        cx="10"
        cy="10"
        r="8.5"
        fill="none"
        strokeWidth="2"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, pct)))}
        transform="rotate(-90 10 10)"
      />
    </svg>
  )
}
