import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  /** Optional richer row content in the open menu. */
  render?: ReactNode
}

/**
 * Steam's DialogDropDown: translucent slate button with a blue chevron, opening a dark menu.
 * Keyboard: Enter/Space/↓ open, ↑↓ move, Enter selects, Esc closes, type-ahead by first letter.
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  id,
  disabled,
  minWidth = 180,
  display,
  ariaLabel
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (v: T) => void
  id?: string
  disabled?: boolean
  minWidth?: number
  /** Custom content for the closed button. */
  display?: ReactNode
  ariaLabel?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState(0)
  const [up, setUp] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onBlur = (): void => setOpen(false)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  // Open upward when there isn't room below.
  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const need = Math.min(320, options.length * 38 + 8)
    setUp(window.innerHeight - r.bottom < need + 12 && r.top > need)
  }, [open, options.length])

  const openMenu = (): void => {
    setFocus(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const pick = (i: number): void => {
    const o = options[i]
    setOpen(false)
    btn.current?.focus()
    if (o && o.value !== value) onChange(o.value)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocus((f) => Math.min(options.length - 1, f + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocus((f) => Math.max(0, f - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setFocus(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setFocus(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(focus)
    } else if (e.key === 'Tab') {
      setOpen(false)
    } else if (e.key.length === 1) {
      const i = options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()))
      if (i >= 0) setFocus(i)
    }
  }

  return (
    <div className="sel" ref={wrap} style={{ minWidth }}>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`sel-btn ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="sel-value">{display ?? current?.label ?? '—'}</span>
        <svg className="sel-arrow" width="12" height="8" viewBox="0 0 12 8" aria-hidden>
          <path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className={`sel-menu ${up ? 'up' : ''}`} role="listbox" id={listId}>
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              role="option"
              aria-selected={o.value === value}
              className={`sel-item ${i === focus ? 'focus' : ''} ${o.value === value ? 'selected' : ''}`}
              onMouseEnter={() => setFocus(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              {o.render ?? o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
