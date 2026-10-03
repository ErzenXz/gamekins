import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  hint?: string | number
  icon?: ReactNode
}

/** Steam-style dropdown (native <select> popups can't be styled). Arrow keys, Enter and Esc work. */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  className = '',
  label,
  align = 'left',
  title
}: {
  value: T
  options: DropdownOption<T>[]
  onChange: (v: T) => void
  className?: string
  /** Custom content for the closed button (defaults to the selected label). */
  label?: ReactNode
  align?: 'left' | 'right'
  title?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        btn.current?.focus()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    // Focus the selected option.
    ref.current?.querySelector<HTMLElement>('.ldd-item.active, .ldd-item')?.focus({ preventScroll: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('.ldd-item') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (k: number): void => {
      e.preventDefault()
      items[(k + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className={`ldd ${open ? 'open' : ''} ${className}`} ref={ref}>
      <button
        ref={btn}
        className="ldd-btn"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ldd-value">
          {label ?? (
            <>
              {current?.icon}
              <span className="ldd-label">{current?.label}</span>
            </>
          )}
        </span>
        <span className="ldd-arrow">
          <ChevronDown size={14} />
        </span>
      </button>
      {open && (
        <div className={`ldd-menu ${align}`} role="listbox" onKeyDown={onMenuKey}>
          {options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`ldd-item ${o.value === value ? 'active' : ''}`}
              onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
                btn.current?.focus()
              }}
            >
              <span className="ldd-check">{o.value === value && <Check size={13} />}</span>
              {o.icon}
              <span className="ldd-item-label">{o.label}</span>
              {o.hint !== undefined && <span className="ldd-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Accessible on/off switch (Steam toggle). */
export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`lib-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

/** Steam DialogCheckbox. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <label className={`lcheck ${disabled ? 'disabled' : ''}`} htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="lcheck-box" aria-hidden>
        <svg viewBox="0 0 18 18">
          <path d="M3.5 9.5l3.5 3.5 7.5-8" />
        </svg>
      </span>
      <span className="lcheck-label">{label}</span>
    </label>
  )
}

/** Label + description + control row used in Properties. */
export function OptionRow({
  title,
  hint,
  children,
  disabled
}: {
  title: ReactNode
  hint?: ReactNode
  children: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={`opt-row ${disabled ? 'disabled' : ''}`}>
      <div className="opt-text">
        <div className="opt-title">{title}</div>
        {hint && <div className="opt-hint">{hint}</div>}
      </div>
      <div className="opt-control">{children}</div>
    </div>
  )
}
