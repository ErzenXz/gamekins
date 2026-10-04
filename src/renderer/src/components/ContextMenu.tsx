import { Check, ChevronRight } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Game } from '@shared/types'
import {
  addToCollection,
  canLocate,
  canVerify,
  collectionNames,
  confirmCancelJob,
  confirmDeleteCollection,
  confirmUninstall,
  createShortcut,
  inCollection,
  isLocal,
  launchGame,
  locateInstall,
  primaryAction,
  removeFromCollection,
  runPrimary,
  toggleFavorite,
  toggleHidden
} from '../lib/gameActions'
import { act, jobFor, useStore } from '../store'
import { CollectionPrompt } from './library/CollectionPrompt'

interface Item {
  label: string
  onClick?: () => void
  disabled?: boolean
  submenu?: Entry[]
  /** Big PLAY / INSTALL style pill at the top of the menu. */
  action?: 'green' | 'blue'
  checked?: boolean
  /** Keep the menu open after clicking (checkable collection rows). */
  keepOpen?: boolean
}
type Entry = Item | 'sep'

const PAD = 6

/**
 * Steam-style right-click menu, driven by `store.contextMenu` (a game, or a collection when
 * `collection` is set). Also hosts the collection name prompt so it is always mounted.
 */
export function GameContextMenu(): React.JSX.Element {
  return (
    <>
      <MenuHost />
      <CollectionPrompt />
    </>
  )
}

function MenuHost(): React.JSX.Element | null {
  const menu = useStore((s) => s.contextMenu)
  const game = useStore((s) => (s.contextMenu?.gameKey ? s.games.find((g) => g.key === s.contextMenu!.gameKey) : undefined))
  const games = useStore((s) => s.games)
  const empty = useStore((s) => s.emptyCollections)
  const job = useStore((s) => (s.contextMenu?.gameKey ? jobFor(s.jobs, s.contextMenu.gameKey) : undefined))
  const platform = useStore((s) => s.info?.platform ?? 'win32')
  const launching = useStore((s) => !!(s.contextMenu && s.launching[s.contextMenu.gameKey]))
  const moving = useStore((s) => !!(s.contextMenu && s.moving[s.contextMenu.gameKey]))
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const close = (): void => useStore.getState().setContextMenu(null)

  // Clamp into the viewport once we know the menu's size, then focus the first item.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null)
    const r = ref.current.getBoundingClientRect()
    const x = Math.max(PAD, Math.min(menu.x, window.innerWidth - r.width - PAD))
    const below = menu.y + r.height <= window.innerHeight - PAD
    const y = below ? menu.y : Math.max(PAD, Math.min(menu.y - r.height, window.innerHeight - r.height - PAD))
    setPos({ x, y })
  }, [menu])

  // Focus the first item once the menu is visible (hidden elements can't take focus).
  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLElement>('[data-mi]:not(:disabled)')?.focus({ preventScroll: true })
  }, [pos])

  // Highlight the row / capsule the menu belongs to (Steam's ContextMenuOpen row style).
  useEffect(() => {
    const key = menu?.gameKey
    if (!key) return
    const els = document.querySelectorAll(`[data-ctx-key="${CSS.escape(key)}"]`)
    els.forEach((el) => el.classList.add('ctx-target'))
    return () => els.forEach((el) => el.classList.remove('ctx-target'))
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const restore = document.activeElement as HTMLElement | null
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element
      // Let a trigger (e.g. the game page ⋯ button) toggle the menu itself.
      if (ref.current?.contains(t) || t.closest?.('[data-ctx-trigger]')) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        close()
        if (restore && document.contains(restore)) restore.focus({ preventScroll: true })
      }
    }
    const onScroll = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!menu) return null
  let entries: Entry[]
  let label: string
  if (menu.collection) {
    entries = collectionEntries(menu.collection)
    label = menu.collection
  } else if (game) {
    entries = gameEntries(game, platform, { launching, moving }, collectionNames(games, empty))
    label = game.title
  } else return null

  return (
    <div
      ref={ref}
      className="ctx"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
      aria-label={label}
    >
      <MenuItems entries={entries} close={close} />
    </div>
  )

  function gameEntries(
    game: Game,
    platform: string,
    busy: { launching: boolean; moving: boolean },
    names: string[]
  ): Entry[] {
    const v = window.gamekins
    const s = useStore.getState()
    const primary = primaryAction(game, job, platform, busy)
    const local = isLocal(game)
    const out: Entry[] = []

    if (primary.kind !== 'unavailable') {
      const green = primary.kind === 'play' || primary.kind === 'launching'
      out.push({
        label: primary.label,
        action: green ? 'green' : 'blue',
        disabled: primary.kind === 'launching' || primary.kind === 'moving',
        onClick: () => void runPrimary(game, job, primary.kind)
      })
    }
    if (game.install && game.updateAvailable && !job && !game.running && !local) {
      out.push({ label: 'Play without updating', disabled: busy.launching, onClick: () => void launchGame(game) })
    }
    if (job) {
      out.push({ label: 'Cancel download…', onClick: () => confirmCancelJob(job, game.title) })
      out.push({ label: 'View in Downloads', onClick: () => s.navigate({ view: 'downloads' }) })
    }
    if (out.length) out.push('sep')

    out.push({
      label: game.prefs.favorite ? 'Remove from Favorites' : 'Add to Favorites',
      onClick: () => void toggleFavorite(game)
    })
    out.push({
      label: 'Add to',
      submenu: [
        ...names.map<Item>((n) => ({
          label: n,
          checked: inCollection(game, n),
          keepOpen: true,
          onClick: () => void (inCollection(game, n) ? removeFromCollection([game.key], n) : addToCollection([game.key], n))
        })),
        ...(names.length ? (['sep'] as Entry[]) : []),
        { label: 'New collection…', onClick: () => s.setCollectionPrompt({ mode: 'create', gameKeys: [game.key] }) }
      ]
    })
    const mine = names.filter((n) => inCollection(game, n))
    if (mine.length) {
      out.push({
        label: 'Remove from',
        submenu: mine.map((n) => ({ label: n, onClick: () => void removeFromCollection([game.key], n) }))
      })
    }

    const manage: Entry[] = []
    if (game.install) manage.push({ label: 'Add desktop shortcut', onClick: () => void createShortcut(game) })
    manage.push({ label: 'Set custom artwork…', onClick: () => s.openProperties(game.key, 'customization') })
    if (game.install) {
      manage.push({
        label: 'Browse local files',
        disabled: busy.moving,
        onClick: () => void act(() => v.games.openFolder(game.key))
      })
    }
    if (game.install && !local && !game.thirdPartyManagedApp) {
      manage.push({
        label: 'Verify integrity of game files',
        disabled: !canVerify(game, job),
        onClick: () => void act(() => v.games.repair(game.key), 'Verification queued')
      })
    }
    if (canLocate(game, job, platform)) manage.push({ label: 'Locate existing install…', onClick: () => locateInstall(game) })
    manage.push('sep')
    manage.push({
      label: game.prefs.hidden ? 'Remove from Hidden' : 'Hide this game',
      onClick: () => void toggleHidden(game)
    })
    if (local) {
      manage.push({ label: 'Remove non-Epic game from library…', disabled: !!game.running, onClick: () => confirmUninstall(game) })
    } else if (game.install) {
      manage.push({
        label: 'Uninstall…',
        disabled: !!game.running || busy.moving || !!job,
        onClick: () => confirmUninstall(game)
      })
    }
    out.push({ label: 'Manage', submenu: manage })
    out.push('sep')
    out.push({ label: 'Properties…', onClick: () => s.openProperties(game.key) })
    return out
  }
}

function collectionEntries(name: string): Entry[] {
  const s = useStore.getState()
  return [
    {
      label: 'Open collection',
      onClick: () => {
        s.setLibraryPage(`collection:${name}`)
        s.navigate({ view: 'library' })
      }
    },
    'sep',
    { label: 'Rename collection…', onClick: () => s.setCollectionPrompt({ mode: 'rename', name }) },
    { label: 'Delete collection…', onClick: () => confirmDeleteCollection(name) }
  ]
}

/** Arrow-key navigation within one menu level. */
function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>, back?: () => void): void {
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(':scope > [data-mi]:not(:disabled), :scope > .ctx-sub-wrap > [data-mi]')
  ]
  const i = items.indexOf(document.activeElement as HTMLElement)
  const go = (k: number): void => {
    e.preventDefault()
    e.stopPropagation()
    items[(k + items.length) % items.length]?.focus({ preventScroll: true })
  }
  switch (e.key) {
    case 'ArrowDown':
      return go(i + 1)
    case 'ArrowUp':
      return go(i < 0 ? items.length - 1 : i - 1)
    case 'Home':
      return go(0)
    case 'End':
      return go(items.length - 1)
    case 'ArrowLeft':
      if (back) {
        e.preventDefault()
        e.stopPropagation()
        back()
      }
      return
    case 'Tab':
      e.preventDefault()
      return go(e.shiftKey ? i - 1 : i + 1)
  }
}

function MenuItems({ entries, close, back }: { entries: Entry[]; close: () => void; back?: () => void }): React.JSX.Element {
  const [openSub, setOpenSub] = useState<number | null>(null)
  const [focusSub, setFocusSub] = useState(false)
  const timer = useRef<number>(0)
  const triggers = useRef<Record<number, HTMLButtonElement | null>>({})
  useEffect(() => () => clearTimeout(timer.current), [])

  const openWithKeys = (i: number): void => {
    clearTimeout(timer.current)
    setFocusSub(true)
    setOpenSub(i)
  }

  return (
    <div className="ctx-items" onKeyDown={(e) => onMenuKey(e, back)}>
      {entries.map((e, i) =>
        e === 'sep' ? (
          <div key={`s${i}`} className="ctx-sep" role="separator" />
        ) : e.submenu ? (
          <div
            key={e.label}
            className={`ctx-sub-wrap ${openSub === i ? 'open' : ''}`}
            onMouseEnter={() => {
              clearTimeout(timer.current)
              timer.current = window.setTimeout(() => {
                setFocusSub(false)
                setOpenSub(i)
              }, 60)
            }}
            onMouseLeave={() => {
              clearTimeout(timer.current)
              timer.current = window.setTimeout(() => setOpenSub(null), 220)
            }}
          >
            <button
              ref={(el) => {
                triggers.current[i] = el
              }}
              data-mi
              className="ctx-item"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openSub === i}
              onClick={() => openWithKeys(i)}
              onKeyDown={(ev) => {
                if (ev.key === 'ArrowRight' || ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  ev.stopPropagation()
                  openWithKeys(i)
                }
              }}
            >
              <span className="ctx-label">{e.label}</span>
              <ChevronRight size={14} className="ctx-chev" />
            </button>
            {openSub === i && (
              <Submenu
                entries={e.submenu}
                close={close}
                autoFocus={focusSub}
                back={() => {
                  setOpenSub(null)
                  triggers.current[i]?.focus({ preventScroll: true })
                }}
              />
            )}
          </div>
        ) : (
          <button
            key={e.label + i}
            data-mi
            role={e.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={e.checked}
            className={`ctx-item ${e.action ? `ctx-action ${e.action}` : ''} ${e.checked ? 'checked' : ''}`}
            disabled={e.disabled}
            onMouseEnter={(ev) => {
              ev.currentTarget.focus({ preventScroll: true })
              clearTimeout(timer.current)
              timer.current = window.setTimeout(() => setOpenSub(null), 160)
            }}
            onClick={() => {
              if (!e.keepOpen) close()
              e.onClick?.()
            }}
          >
            {e.checked !== undefined && <span className="ctx-check">{e.checked && <Check size={13} />}</span>}
            <span className="ctx-label">{e.label}</span>
          </button>
        )
      )}
    </div>
  )
}

function Submenu({
  entries,
  close,
  back,
  autoFocus
}: {
  entries: Entry[]
  close: () => void
  back: () => void
  autoFocus: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [flip, setFlip] = useState<{ x: boolean; dy: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const parent = el.parentElement!.getBoundingClientRect()
    const x = parent.right + r.width > window.innerWidth - PAD
    const overflow = parent.top + r.height - (window.innerHeight - PAD)
    setFlip({ x, dy: overflow > 0 ? -Math.min(overflow, parent.top - PAD) : 0 })
  }, [])
  useEffect(() => {
    if (flip && autoFocus) ref.current?.querySelector<HTMLElement>('[data-mi]:not(:disabled)')?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flip])
  return (
    <div
      ref={ref}
      className={`ctx ctx-sub ${flip?.x ? 'left' : ''}`}
      style={{ marginTop: flip?.dy ?? 0, visibility: flip ? 'visible' : 'hidden' }}
      role="menu"
    >
      <MenuItems entries={entries} close={close} back={back} />
    </div>
  )
}
