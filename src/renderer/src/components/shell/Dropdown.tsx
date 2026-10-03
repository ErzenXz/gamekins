import { useEffect, useRef, type ReactNode } from 'react'

export type MenuItem =
  | {
      label: string
      onSelect: () => void
      icon?: ReactNode
      shortcut?: string
      disabled?: boolean
      danger?: boolean
      checked?: boolean
    }
  | { separator: true }
  | { heading: string; accent?: boolean }

/**
 * Steam desktop context-menu style dropdown: #3d4450 panel, items invert to a light
 * highlight on hover/focus. Positioning is left to the caller's wrapper (`position: relative`).
 */
export function Dropdown({
  items,
  onClose,
  align = 'left',
  direction = 'down',
  autoFocus = false,
  className = ''
}: {
  items: MenuItem[]
  onClose: () => void
  align?: 'left' | 'right'
  direction?: 'down' | 'up'
  autoFocus?: boolean
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [autoFocus])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      buttons[(i + 1) % buttons.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      buttons[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      buttons.at(-1)?.focus()
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const hasCheck = items.some((it) => 'checked' in it && it.checked !== undefined)

  return (
    <div ref={ref} className={`dd ${align} ${direction} ${className}`} role="menu" onKeyDown={onKeyDown}>
      {items.map((it, i) => {
        if ('separator' in it) return <div key={i} className="dd-sep" role="separator" />
        if ('heading' in it)
          return (
            <div key={i} className={`dd-heading ${it.accent ? 'accent' : ''}`}>
              {it.heading}
            </div>
          )
        return (
          <button
            key={i}
            role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={it.checked}
            className={`dd-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}`}
            disabled={it.disabled}
            onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
          >
            {hasCheck && <span className="dd-check">{it.checked ? '✓' : ''}</span>}
            {it.icon && <span className="dd-icon">{it.icon}</span>}
            <span className="dd-label">{it.label}</span>
            {it.shortcut && <span className="dd-shortcut">{it.shortcut}</span>}
          </button>
        )
      })}
    </div>
  )
}
