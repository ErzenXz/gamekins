import markUrl from '../assets/mark.png'

/** The Gamekins guiding-star mark (branding/mark-1024.png, rendered to assets/mark.png). */
export function GamekinsMark({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <img
      src={markUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      className="gamekins-mark"
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}
