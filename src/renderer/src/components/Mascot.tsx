import wave from '../assets/mascot-wave.png'
import sleep from '../assets/mascot-sleep.png'
import cheer from '../assets/mascot-cheer.png'

const POSES = { wave, sleep, cheer }

/** The Gamekin mascot (branding/mascot-*.png, rendered to assets/ by scripts/make-icons.cjs). */
export function Mascot({
  pose,
  size = 120,
  className
}: {
  pose: keyof typeof POSES
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <img
      src={POSES[pose]}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
      className={`mascot ${className ?? ''}`}
    />
  )
}
