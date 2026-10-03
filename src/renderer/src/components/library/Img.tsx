import { memo, useLayoutEffect, useRef, useState } from 'react'

/** Deterministic hue for a title, so fallback cards look intentional and stay stable. */
function hue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

export function TitleCard({ title, className = '' }: { title: string; className?: string }): React.JSX.Element {
  const h = hue(title)
  return (
    <div
      className={`title-card ${className}`}
      style={{
        background: `linear-gradient(160deg, hsl(${h} 32% 26%) 0%, hsl(${(h + 40) % 360} 38% 13%) 100%)`
      }}
    >
      <span>{title}</span>
    </div>
  )
}

interface ImgProps {
  src?: string
  /** Shown as a title card when the image is missing or fails to load. */
  title?: string
  className?: string
  /** Skip native lazy-loading (heroes, above-the-fold art). */
  eager?: boolean
  /** Render nothing (instead of a title card) when the image fails. */
  quietFallback?: boolean
}

/**
 * Image with a shimmer skeleton while loading, a fade-in when ready and a
 * generated title card when the art is missing or broken.
 */
export const Img = memo(function Img({ src, title = '', className = '', eager, quietFallback }: ImgProps) {
  const ref = useRef<HTMLImageElement>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  // Cached images may finish before React attaches onLoad.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && el.complete && el.naturalWidth > 0) setLoaded(src ?? null)
  }, [src])

  if (!src || failed === src) {
    return quietFallback ? <div className={`img failed ${className}`} /> : <TitleCard title={title} className={`img ${className}`} />
  }
  const state = loaded === src ? 'loaded' : 'loading'
  return (
    <div className={`img ${state} ${className}`}>
      <img
        ref={ref}
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        loading={eager ? 'eager' : 'lazy'}
        onLoad={() => setLoaded(src)}
        onError={() => setFailed(src)}
      />
    </div>
  )
})
