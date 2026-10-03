import { X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** Open modals, innermost last — only the top one reacts to Escape/Tab. */
const stack: string[] = []

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function Modal({
  title,
  children,
  onClose,
  footer,
  width = 520,
  danger = false,
  dismissable = true,
  className = ''
}: {
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  width?: number
  /** Destructive dialog: red focus line along the top (Steam). */
  danger?: boolean
  /** false while busy: Escape, the backdrop and the × do nothing. */
  dismissable?: boolean
  className?: string
}): React.JSX.Element {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dismissRef = useRef(dismissable)
  dismissRef.current = dismissable

  // Animate out, then let the owner unmount us.
  const requestClose = useCallback(() => {
    if (!dismissRef.current) return
    setClosing(true)
    window.setTimeout(() => {
      onCloseRef.current()
      setClosing(false) // the owner may decide to keep us open (e.g. a busy confirm)
    }, 120)
  }, [])

  useEffect(() => {
    stack.push(id)
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    // Autofocus: an explicit [data-autofocus], else the primary footer button, else the dialog.
    const target =
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog?.querySelector<HTMLElement>(
        '.modal-footer .btn-blue:not(:disabled), .modal-footer .btn-danger:not(:disabled)'
      ) ??
      dialog
    target?.focus()
    return () => {
      stack.splice(stack.indexOf(id), 1)
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (stack.at(-1) !== id) return
      if (e.key === 'Escape') {
        e.preventDefault()
        requestClose()
      } else if (e.key === 'Tab' && ref.current) {
        // Keep focus inside the dialog.
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        if (!items.length) return e.preventDefault()
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement
        if (e.shiftKey && (active === first || !ref.current.contains(active))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, requestClose])

  return (
    <div
      className={`modal-backdrop ${closing ? 'closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      <div
        ref={ref}
        className={`modal ${danger ? 'danger' : ''} ${className}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={`${id}-title`}>
            {title}
          </h2>
          <button className="modal-close" onClick={requestClose} title="Close (Esc)" tabIndex={-1} disabled={!dismissable}>
            <X size={14} strokeWidth={2.2} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
