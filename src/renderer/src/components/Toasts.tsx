import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Toast } from '@shared/types'
import { useStore } from '../store'

type Shown = Toast & { id: number; leaving?: boolean; at: number }

const ICON = { error: CircleAlert, success: CircleCheck, info: Info }
const TITLE = { error: 'Something went wrong', success: 'Lodestar', info: 'Lodestar' }

/**
 * Steam desktop toasts (bottom-right, stacked upward). The store removes toasts outright; we
 * keep a removed toast around for a beat so it can animate out. Hovering the stack pauses
 * auto-dismiss so long messages can be read.
 */
export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const [shown, setShown] = useState<Shown[]>([])
  const timers = useRef(new Map<number, number>())

  useEffect(() => {
    // Nothing left under the pointer: never leave timers paused.
    if (!toasts.length) useStore.getState().holdToasts(false)
    setShown((prev) => {
      const live = new Set(toasts.map((t) => t.id))
      const next: Shown[] = prev.map((t) => (live.has(t.id) ? t : { ...t, leaving: true }))
      for (const t of toasts) if (!prev.some((p) => p.id === t.id)) next.push({ ...t, at: Date.now() })
      for (const t of next) {
        if (t.leaving && !timers.current.has(t.id)) {
          timers.current.set(
            t.id,
            window.setTimeout(() => {
              timers.current.delete(t.id)
              setShown((s) => s.filter((x) => x.id !== t.id))
            }, 260)
          )
        }
      }
      return next
    })
  }, [toasts])

  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((t) => clearTimeout(t))
      useStore.getState().holdToasts(false)
    }
  }, [])

  return (
    <div
      className="toasts"
      aria-live="polite"
      onMouseEnter={() => useStore.getState().holdToasts(true)}
      onMouseLeave={() => useStore.getState().holdToasts(false)}
    >
      {shown.map((t) => {
        const Icon = ICON[t.kind]
        return (
          <div key={t.id} className={`toast toast-${t.kind} ${t.leaving ? 'leaving' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <div className="toast-icon">
              <Icon size={22} strokeWidth={1.8} />
            </div>
            <div className="toast-text">
              <div className="toast-head">
                <span className="toast-title">{TITLE[t.kind]}</span>
                <span className="toast-time">
                  {new Date(t.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
              <div className="toast-msg" title={t.message}>
                {t.message}
              </div>
            </div>
            <button
              className="toast-close"
              onClick={() => useStore.getState().dismissToast(t.id)}
              title="Dismiss"
              aria-label="Dismiss notification"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
