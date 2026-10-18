import '../styles/friends-chrome.css'
import { ChevronLeft, ChevronRight, TriangleAlert, Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { unreadTotal, useSocial } from '../lib/social'
import type { Account } from '@shared/types'
import { type Route, useStore } from '../store'
import { Modal } from './Modal'
import { confirmSignOut } from './shell/account'
import { Dropdown, type MenuItem } from './shell/Dropdown'
import { isMac, modKey } from './shell/format'
import { STORE_LINKS, STORE_SITES } from './shell/storeLinks'
import { GamekinsMark } from './GamekinsMark'

const RUNNING = ['preparing', 'verifying', 'downloading', 'finalizing']
const REDEEM_URL = 'https://www.epicgames.com/redeem'
const FREE_URL = 'https://store.epicgames.com/en-US/free-games'
const EPIC_ACCOUNT = 'https://www.epicgames.com/account/personal'

type MenuId = 'gamekins' | 'account'
type NavId = 'store' | 'library' | 'downloads'

const go = (r: Route): void => useStore.getState().navigate(r)
const storeName = (p: Account['provider']): string => ({ epic: 'Epic Games', steam: 'Steam', gog: 'GOG', local: 'Gamekins' })[p]
const openLibrary = (page: 'home' | 'collections'): void => {
  const s = useStore.getState()
  s.navigate({ view: 'library' })
  s.setLibraryPage(page)
}

/** Window chrome: one slim row with the app menu, history, Steam's big nav tabs and the account. */
export function TitleBar(): React.JSX.Element {
  const view = useStore((s) => s.route.view)
  const section = useStore((s) => (s.route.view === 'settings' ? s.route.section : undefined))
  const canBack = useStore((s) => s.back.length > 0)
  const canForward = useStore((s) => s.forward.length > 0)
  const accounts = useStore((s) => s.accounts)
  const storeInfos = useStore((s) => s.info?.providers)
  // The pill shows Epic first (the store with chat), then whichever store is connected.
  const account = accounts.find((a) => a.provider === 'epic') ?? accounts[0]
  const sessionExpired = useStore((s) => s.sessionExpired)
  const signingIn = useStore((s) => s.signingIn)
  const refreshing = useStore((s) => s.refreshing)
  // Primitive selectors: a download tick that doesn't change these doesn't re-render the bar.
  const liveCount = useStore((s) => s.jobs.filter((j) => j.state !== 'done' && j.state !== 'cancelled').length)
  const downloading = useStore((s) => s.jobs.some((j) => RUNNING.includes(j.state)))

  const friendsOpen = useSocial((st) => st.open)
  const friendsUnread = useSocial((st) => unreadTotal(st.state))
  const [open, setOpen] = useState<{ id: MenuId; keyboard: boolean } | null>(null)
  const [about, setAbout] = useState(false)
  const [focused, setFocused] = useState(() => document.hasFocus())
  const mod = modKey()

  const s = useStore.getState
  const signIn = (): void => void s().signIn('epic')
  const signOut = (): void => {
    if (account) confirmSignOut(account.provider)
  }
  const exit = (): void => {
    const active = s().jobs.find((j) => RUNNING.includes(j.state))
    if (!active) return void window.gamekins.app.quit()
    s().setConfirm({
      title: isMac() ? 'Quit Gamekins?' : 'Exit Gamekins?',
      message: `${active.title} is still downloading. It will stop now and pick up where it left off the next time you open Gamekins.`,
      confirmLabel: isMac() ? 'Quit' : 'Exit',
      onConfirm: () => window.gamekins.app.quit()
    })
  }

  const menus: Record<MenuId, MenuItem[]> = {
    gamekins: [
      { heading: 'Library' },
      { label: 'Collections', onSelect: () => openLibrary('collections') },
      { label: 'Add a non-Epic game…', onSelect: () => s().setAddGameOpen(true) },
      { label: refreshing ? 'Refreshing library…' : 'Refresh library', disabled: refreshing, onSelect: () => void s().refresh() },
      { heading: 'Store' },
      { label: 'Free games this week', onSelect: () => go({ view: 'store', url: FREE_URL }) },
      { label: 'Redeem a code…', onSelect: () => go({ view: 'store', url: REDEEM_URL }) },
      { separator: true },
      { label: 'Settings', shortcut: `${mod}+,`, checked: view === 'settings' && section !== 'storage', onSelect: () => go({ view: 'settings' }) },
      { label: 'Storage', checked: view === 'settings' && section === 'storage', onSelect: () => go({ view: 'settings', section: 'storage' }) },
      { label: 'Epic Games support', onSelect: () => void window.gamekins.app.openExternal('https://www.epicgames.com/help') },
      { label: 'Epic Games status', onSelect: () => void window.gamekins.app.openExternal('https://status.epicgames.com') },
      { label: 'About Gamekins', onSelect: () => setAbout(true) },
      { separator: true },
      account
        ? { label: 'Sign out of account…', onSelect: signOut }
        : { label: signingIn ? 'Signing in…' : 'Sign in to Epic Games…', disabled: signingIn, onSelect: signIn },
      { label: isMac() ? 'Quit Gamekins' : 'Exit', shortcut: isMac() ? '⌘+Q' : undefined, onSelect: exit }
    ],
    account: [
      ...(sessionExpired && !accounts.some((a) => a.provider === 'epic') ? [{ heading: 'Your Epic session expired' }] : []),
      ...accounts.map((a) => ({ heading: `${a.displayName} · ${storeName(a.provider)}`, accent: true })),
      ...(storeInfos ?? [{ id: 'epic', name: 'Epic Games', available: true }])
        .filter((p) => p.available && !accounts.some((a) => a.provider === p.id))
        .map((p) => ({
          label: signingIn ? 'Signing in…' : `Sign in to ${p.name}…`,
          disabled: signingIn,
          onSelect: () => void s().signIn(p.id as Account['provider'])
        })),
      { separator: true },
      { label: 'Connected stores & account', onSelect: () => go({ view: 'settings', section: 'account' }) },
      ...(accounts.some((a) => a.provider === 'epic') ? [{ label: 'Epic account page', onSelect: () => void window.gamekins.app.openExternal(EPIC_ACCOUNT) }] : []),
      { label: 'Settings', onSelect: () => go({ view: 'settings' }) },
      ...(accounts.length ? [{ separator: true } as MenuItem] : []),
      ...accounts.map((a) => ({ label: `Sign out of ${storeName(a.provider)}…`, onSelect: () => confirmSignOut(a.provider, storeName(a.provider)) }))
    ]
  }

  useEffect(() => {
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])

  // Escape closes an open menu even when it was opened with the mouse (focus is elsewhere).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    const onBlur = (): void => setOpen(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  // Global shortcuts: Alt+←/→ history, Ctrl/⌘+1..3 tabs, Ctrl/⌘+, settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector('.modal-backdrop')) return
      const st = useStore.getState()
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          st.goBack()
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          st.goForward()
        }
        return
      }
      if ((isMac() ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const target: Route | null =
          e.key === '1' ? { view: 'store' } : e.key === '2' ? { view: 'library' } : e.key === '3' ? { view: 'downloads' } : null
        if (target) {
          e.preventDefault()
          st.navigate(target)
        } else if (e.key === ',' || e.code === 'Comma') {
          e.preventDefault()
          st.navigate({ view: 'settings' })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggle = (id: MenuId) => (e: React.MouseEvent) => {
    e.preventDefault()
    setOpen(open?.id === id ? null : { id, keyboard: false })
  }
  const keyOpen = (id: MenuId) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen({ id, keyboard: true })
    }
  }

  const menuButton = (id: MenuId, label: React.ReactNode): React.JSX.Element => (
    <div className="tb-menu-wrap">
      <button
        className={`tb-menu-btn ${open?.id === id ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open?.id === id}
        onMouseDown={toggle(id)}
        onKeyDown={keyOpen(id)}
      >
        {label}
      </button>
      {open?.id === id && <Dropdown items={menus[id]} autoFocus={open.keyboard} onClose={() => setOpen(null)} />}
    </div>
  )

  const activeTab: NavId | null = view === 'store' || view === 'library' || view === 'downloads' ? view : null
  const accountActive = view === 'settings' && (section === 'account' || section === 'accounts')

  return (
    <>
      <header className={`titlebar ${focused ? 'focused' : ''}`}>
        {open && <div className="tb-backdrop" onMouseDown={() => setOpen(null)} />}
        {menuButton(
          'gamekins',
          <>
            <GamekinsMark size={22} />
            <span className="tb-brand">Gamekins</span>
            <Caret />
          </>
        )}
        <div className="tb-history">
          <button className="tb-arrow" disabled={!canBack} onClick={() => s().goBack()} title="Back (Alt+←)" aria-label="Back">
            <ChevronLeft size={18} strokeWidth={2.2} />
          </button>
          <button className="tb-arrow" disabled={!canForward} onClick={() => s().goForward()} title="Forward (Alt+→)" aria-label="Forward">
            <ChevronRight size={18} strokeWidth={2.2} />
          </button>
        </div>
        <nav className="tb-tabs">
          <NavTab
            id="store"
            label="Store"
            active={activeTab === 'store'}
            title={`Store (${mod}+1)`}
            onClick={() => go({ view: 'store' })}
            items={[
              { label: 'Epic Games Store', onSelect: () => go({ view: 'store', url: STORE_SITES.epic.home }) },
              { label: 'Steam Store', onSelect: () => go({ view: 'store', url: STORE_SITES.steam.home }) },
              { label: 'GOG Store', onSelect: () => go({ view: 'store', url: STORE_SITES.gog.home }) },
              { separator: true },
              ...STORE_LINKS.filter((l) => l.label !== 'Discover').map((l) => ({ label: `Epic: ${l.label}`, onSelect: () => go({ view: 'store', url: l.url }) }))
            ]}
          />
          <NavTab
            id="library"
            label="Library"
            active={activeTab === 'library'}
            title={`Library (${mod}+2)`}
            onClick={() => go({ view: 'library' })}
            items={[
              { label: 'Home', onSelect: () => openLibrary('home') },
              { label: 'Collections', onSelect: () => openLibrary('collections') },
              { label: 'Downloads', onSelect: () => go({ view: 'downloads' }) }
            ]}
          />
          <NavTab
            id="downloads"
            label="Downloads"
            active={activeTab === 'downloads'}
            title={`Downloads (${mod}+3)`}
            onClick={() => go({ view: 'downloads' })}
            badge={liveCount > 0 ? <span className={`tb-badge ${downloading ? 'busy' : ''}`}>{liveCount}</span> : null}
          />
        </nav>
        <div className="tb-drag" />
        <div className="tb-controls">
          {!account && sessionExpired && (
            <button className="tb-pill tb-alert" onClick={signIn} title="Your Epic Games session expired. Sign in again." disabled={signingIn}>
              <TriangleAlert size={14} />
              <span>Session expired</span>
            </button>
          )}
          {account && (
            <button
              className={`tb-friends ${friendsOpen ? 'on' : ''}`}
              title="Friends & chat"
              aria-pressed={friendsOpen}
              onClick={() => useSocial.getState().toggle()}
            >
              <Users size={17} />
              {friendsUnread > 0 && <span className="tb-friends-badge">{friendsUnread > 9 ? '9+' : friendsUnread}</span>}
            </button>
          )}
          <div className="tb-menu-wrap">
            <button
              className={`tb-pill tb-account ${account ? 'online' : 'signed-out'} ${open?.id === 'account' || accountActive ? 'open' : ''}`}
              onMouseDown={toggle('account')}
              onKeyDown={keyOpen('account')}
              aria-haspopup="menu"
              aria-expanded={open?.id === 'account'}
              title={account ? `Signed in to Epic Games as ${account.displayName}` : 'Not signed in to Epic Games'}
            >
              <span className="tb-avatar">{account ? account.displayName[0]?.toUpperCase() : '?'}</span>
              <span className="tb-account-name">{account ? account.displayName : signingIn ? 'Signing in…' : 'Sign in'}</span>
              <Caret />
            </button>
            {open?.id === 'account' && (
              <Dropdown items={menus.account} align="right" autoFocus={open.keyboard} onClose={() => setOpen(null)} />
            )}
          </div>
        </div>
      </header>
      {about && <AboutDialog onClose={() => setAbout(false)} />}
    </>
  )
}

function Caret(): React.JSX.Element {
  return (
    <svg className="tb-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A SuperNav tab: click navigates; hovering drops Steam's submenu. */
function NavTab({
  label,
  active,
  title,
  onClick,
  items,
  badge
}: {
  id: NavId
  label: string
  active: boolean
  title: string
  onClick: () => void
  items?: MenuItem[]
  badge?: React.ReactNode
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const enter = (): void => {
    clearTimeout(timer.current)
    if (items) timer.current = window.setTimeout(() => setHover(true), 180)
  }
  const leave = (): void => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setHover(false), 160)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <div className="tb-tab-wrap" onMouseEnter={enter} onMouseLeave={leave}>
      <button
        className={`tb-tab ${active ? 'active' : ''}`}
        title={title}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          setHover(false)
          onClick()
        }}
        onKeyDown={(e) => {
          if (items && e.key === 'ArrowDown') {
            e.preventDefault()
            setHover(true)
          }
        }}
      >
        <span className="tb-tab-label">{label}</span>
        {badge}
      </button>
      {hover && items && (
        <Dropdown className="tb-submenu" items={items} onClose={() => setHover(false)} autoFocus={false} />
      )}
    </div>
  )
}

function AboutDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const info = useStore((s) => s.info)
  const os = info?.platform === 'darwin' ? 'macOS' : info?.platform === 'win32' ? 'Windows' : info?.platform
  return (
    <Modal
      title="About Gamekins"
      onClose={onClose}
      width={440}
      footer={
        <button className="btn btn-blue" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="about">
        <GamekinsMark size={64} />
        <div className="about-name">Gamekins</div>
        <div className="about-version">
          Version {info?.version ?? '—'} · {os}
        </div>
        <p className="about-blurb">
          A fast, Steam-style client for your Epic Games library.
          <br />
          Not affiliated with Epic Games, Inc. or Valve Corporation.
        </p>
      </div>
    </Modal>
  )
}
