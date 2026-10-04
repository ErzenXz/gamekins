import { CircleAlert, Clock, Download, FolderSearch, LayoutGrid, LoaderCircle, LockKeyhole, LogIn, ShoppingBag, WifiOff } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ProviderInfo } from '@shared/types'
import { Sidebar } from '../components/Sidebar'
import { Mascot } from '../components/Mascot'
import { libraryIndex } from '../lib/entityIndex'
import { img } from '../lib/format'
import { act, useStore } from '../store'
import { LibraryHome, LibraryLoading } from './LibraryHome'

const GamePageHost = lazy(() => import('./library/GamePageHost'))
const CollectionsPage = lazy(() => import('./library/CollectionsPage').then((m) => ({ default: m.CollectionsPage })))
const CollectionDetail = lazy(() => import('./library/CollectionsPage').then((m) => ({ default: m.CollectionDetail })))

const WIDTH_KEY = 'gamekins.sidebar.width'
const NO_PROVIDERS: ProviderInfo[] = []
const MIN_W = 256

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    return v >= MIN_W && v <= 900 ? v : 272
  } catch {
    return 272
  }
}

export function LibraryView(): React.JSX.Element {
  const signedIn = useStore((s) => s.accounts.length > 0)
  const hasGames = useStore((s) => s.games.length > 0)
  const gameKey = useStore((s) => (s.route.view === 'library' ? s.route.gameKey : undefined))
  const gameExists = useStore((s) => (gameKey ? libraryIndex(s.games).gamesByKey.has(gameKey) : false))
  const page = useStore((s) => s.libraryPage)
  const refreshing = useStore((s) => s.refreshing)
  const loading = useStore((s) => s.libraryProgress.loading)
  const root = useRef<HTMLDivElement>(null)
  const [width] = useState(readWidth)

  if (!signedIn && !hasGames) return <SignIn />

  let content: React.JSX.Element
  if (gameKey && gameExists) content = <GamePageHost gameKey={gameKey} />
  else if (!hasGames) content = loading || refreshing ? <LibraryLoading /> : <EmptyLibrary />
  else if (page === 'collections') content = <CollectionsPage />
  else if (page.startsWith('collection:')) content = <CollectionDetail name={page.slice('collection:'.length)} />
  else content = <LibraryHome />

  return (
    <div className="library" ref={root} style={{ '--side-w': `${width}px` } as React.CSSProperties}>
      <Sidebar />
      <Divider root={root} />
      <main className="library-main">
        <LibraryNotice />
        <div className="library-content"><Suspense fallback={null}>{gameKey && !gameExists && hasGames ? <MissingGame /> : content}</Suspense></div>
      </main>
    </div>
  )
}

/** Steam's draggable splitter between the game list and the main pane. */
function Divider({ root }: { root: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const [drag, setDrag] = useState(false)
  useEffect(() => {
    if (!drag) return
    const el = root.current
    const move = (e: PointerEvent): void => {
      if (!el) return
      const left = el.getBoundingClientRect().left
      const max = Math.max(MIN_W, Math.min(el.clientWidth * 0.5, el.clientWidth - 400))
      const w = Math.round(Math.max(MIN_W, Math.min(max, e.clientX - left)))
      el.style.setProperty('--side-w', `${w}px`)
    }
    const up = (): void => {
      setDrag(false)
      const w = parseInt(el?.style.getPropertyValue('--side-w') ?? '', 10)
      try {
        if (w) localStorage.setItem(WIDTH_KEY, String(w))
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, root])
  return (
    <div
      className={`lib-divider ${drag ? 'dragging' : ''}`}
      onPointerDown={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDoubleClick={() => {
        root.current?.style.setProperty('--side-w', '272px')
        try {
          localStorage.setItem(WIDTH_KEY, '272')
        } catch {
          /* ignore */
        }
      }}
      title="Drag to resize · double-click to reset"
      role="separator"
      aria-orientation="vertical"
    />
  )
}

/** Signed-out (expired session) and failed-refresh notices above the library. */
function LibraryNotice(): React.JSX.Element | null {
  const signedIn = useStore((s) => s.accounts.length > 0)
  const hasEpic = useStore((s) => s.games.some((g) => g.provider === 'epic'))
  const error = useStore((s) => s.libraryProgress.error)
  const hasGames = useStore((s) => s.games.length > 0)
  const refreshing = useStore((s) => s.refreshing)
  const [busy, setBusy] = useState(false)
  if (!signedIn && hasEpic) {
    return (
      <div className="lib-notice warn">
        <LockKeyhole size={15} />
        <span>
          <b>You're signed out of Epic Games.</b> Sign in again to refresh your library, get updates and play online games.
        </span>
        <button
          className="lbtn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await act(() => window.gamekins.accounts.login('epic'), 'Signed in to Epic Games')
            setBusy(false)
          }}
        >
          {busy ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />} Sign in
        </button>
      </div>
    )
  }
  if (error && hasGames) {
    return (
      <div className="lib-notice error">
        <CircleAlert size={15} />
        <span>
          <b>Couldn't refresh your library.</b> {error} Showing the games we already know about.
        </span>
        <button className="lbtn" disabled={refreshing} onClick={() => void useStore.getState().refresh()}>
          {refreshing ? <LoaderCircle size={14} className="spin" /> : null} Retry
        </button>
      </div>
    )
  }
  return null
}

function MissingGame(): React.JSX.Element {
  return (
    <div className="lib-empty">
      <Mascot pose="sleep" className="lib-empty-mascot" />
      <h2>This game isn't in your library anymore</h2>
      <p>It may have been removed, or it belongs to an account that is signed out.</p>
      <div className="lib-empty-actions">
        <button className="lbtn primary" onClick={() => useStore.getState().navigate({ view: 'library' })}>
          Go to Home
        </button>
      </div>
    </div>
  )
}

function EmptyLibrary(): React.JSX.Element {
  const { navigate, refresh } = useStore.getState()
  const error = useStore((s) => s.libraryProgress.error)
  if (error) {
    return (
      <div className="lib-empty">
        <div className="lib-empty-icon">
          <WifiOff size={34} />
        </div>
        <h2>Couldn&apos;t load your library</h2>
        <p>{error}</p>
        <p className="muted small">Gamekins keeps retrying in the background.</p>
        <div className="lib-empty-actions">
          <button className="lbtn primary" onClick={() => void refresh()}>
            Try again now
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="lib-empty">
      <Mascot pose="cheer" className="lib-empty-mascot" />
      <h2>Your library is empty</h2>
      <p>Games you own on Epic show up here, including the free ones you claimed. Grab something from the store!</p>
      <div className="lib-empty-actions">
        <button className="lbtn primary" onClick={() => navigate({ view: 'store' })}>
          <ShoppingBag size={15} /> Browse the store
        </button>
        <button className="lbtn" onClick={() => useStore.getState().setAddGameOpen(true)}>
          Add a non-Epic game…
        </button>
        <button className="lbtn" onClick={() => void refresh()}>
          Refresh library
        </button>
      </div>
    </div>
  )
}

const FEATURES = [
  { icon: <Download size={18} />, title: 'Fast downloads', text: 'Parallel, resumable, with Steam-style graphs.' },
  { icon: <LayoutGrid size={18} />, title: 'A library that feels right', text: 'Favorites, search, collections-style shelves.' },
  { icon: <Clock size={18} />, title: 'Play time & updates', text: 'Tracks hours played and keeps games current.' },
  { icon: <FolderSearch size={18} />, title: 'Keeps your installs', text: 'Picks up games from the Epic launcher.' }
]

export function SignIn(): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const free = useStore((s) => s.freeGames)
  const providers = useStore((s) => s.info?.providers) ?? NO_PROVIDERS
  const soon = providers.filter((p) => !p.available)
  const art = free.map((f) => f.image).filter(Boolean) as string[]

  return (
    <div className="signin">
      <div className="signin-bg" aria-hidden>
        {art.length > 0 && (
          <div className="signin-mosaic">
            {Array.from({ length: 8 }, (_, i) => (
              <img key={i} src={img(art[i % art.length], 360)} alt="" draggable={false} decoding="async" />
            ))}
          </div>
        )}
        <div className="signin-glow" />
      </div>

      <div className="signin-card">
        <div className="signin-main">
        <Mascot pose="wave" size={160} className="signin-mascot" />
        <h1>
          Your games,
          <br />
          <span>without the bad launcher.</span>
        </h1>
        <p className="signin-lead">
          Connect your Epic Games account to see your whole library, install and update games, and track your play time,
          in a client that's actually nice to use.
        </p>

        <button
          className="signin-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await act(() => window.gamekins.accounts.login('epic'), 'Signed in to Epic Games')
            setBusy(false)
          }}
        >
          {busy ? <LoaderCircle className="spin" size={18} /> : <LogIn size={18} />}
          {busy ? 'Waiting for Epic…' : 'Sign in with Epic Games'}
        </button>

        <p className="signin-fine">
          <LockKeyhole size={12} /> Sign-in happens on Epic&apos;s own page. Gamekins never sees your password; it only
          receives a login token, stored encrypted on this device.
        </p>
        </div>

        <div className="signin-side">
        <div className="signin-features">
          {FEATURES.map((f) => (
            <div key={f.title} className="signin-feature">
              <span className="signin-feature-icon">{f.icon}</span>
              <div>
                <b>{f.title}</b>
                <span>{f.text}</span>
              </div>
            </div>
          ))}
        </div>

        {soon.length > 0 && (
          <div className="signin-soon">
            <span>Coming later</span>
            {soon.map((p) => (
              <span key={p.id} className="signin-soon-chip">
                {p.name}
              </span>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
