import { lazy, Suspense, useEffect, useState } from 'react'
import { BottomBar } from './components/BottomBar'
import { ConfirmDialog } from './components/ConfirmDialog'
import { GameContextMenu } from './components/ContextMenu'
import { ErrorBoundary } from './components/shell/ErrorBoundary'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { bootstrap, useStore } from './store'
import { LibraryView } from './views/LibraryView'

// Everything but the library loads on first use: smaller startup bundle, faster first paint.
const DownloadsView = lazy(() => import('./views/DownloadsView').then((m) => ({ default: m.DownloadsView })))
const SettingsView = lazy(() => import('./views/SettingsView').then((m) => ({ default: m.SettingsView })))
const StoreView = lazy(() => import('./views/StoreView').then((m) => ({ default: m.StoreView })))
const InstallDialog = lazy(() => import('./components/InstallDialog').then((m) => ({ default: m.InstallDialog })))
const PropertiesDialog = lazy(() =>
  import('./components/PropertiesDialog').then((m) => ({ default: m.PropertiesDialog }))
)
const AddGameDialog = lazy(() =>
  import('./components/library/AddGameDialog').then((m) => ({ default: m.AddGameDialog }))
)

/** The store's web page is the heaviest thing we host; drop it after this long unused. */
const STORE_IDLE_UNLOAD_MS = 10 * 60_000

// Dev builds only: poke at state from DevTools (`__lodestarStore.getState()`).
if (import.meta.env.DEV) Object.assign(window, { __lodestarStore: useStore, __lodestarBootstrap: bootstrap })

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary scope="app">
      <Shell />
    </ErrorBoundary>
  )
}

function Shell(): React.JSX.Element {
  const [ready, setReady] = useState(false)
  // Only the view name: download ticks and other store churn must not re-render the shell.
  const view = useStore((s) => s.route.view)
  // Mount the store lazily, then keep it alive so it doesn't reload on every tab switch.
  const [storeMounted, setStoreMounted] = useState(false)

  useEffect(() => {
    let alive = true
    void bootstrap().finally(() => alive && setReady(true))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (view === 'store') {
      setStoreMounted(true)
      return
    }
    // Free the store's renderer process (often 100MB+) when it hasn't been used for a while.
    const t = setTimeout(() => setStoreMounted(false), STORE_IDLE_UNLOAD_MS)
    return () => clearTimeout(t)
  }, [view])
  // Dialogs are only fetched once something opens them.
  const installOpen = useStore((s) => s.installKey !== null)
  const propertiesOpen = useStore((s) => s.propertiesKey !== null)
  const addGameOpen = useStore((s) => s.addGameOpen)

  useEffect(() => {
    // Mouse back/forward buttons, like a browser (and like Steam).
    const onMouse = (e: MouseEvent): void => {
      if (document.querySelector('.modal-backdrop')) return
      if (e.button === 3) useStore.getState().goBack()
      if (e.button === 4) useStore.getState().goForward()
    }
    window.addEventListener('mouseup', onMouse)
    return () => window.removeEventListener('mouseup', onMouse)
  }, [])

  const goHome = (): void => useStore.getState().navigate({ view: 'library' })

  return (
    <div className={`app view-${view}`}>
      <TitleBar />
      <BootErrors />
      <div className="content">
        {!ready && (
          <div className="boot">
            <div className="boot-spinner" />
          </div>
        )}
        {ready && (
          <>
            {storeMounted && (
              <ErrorBoundary scope="view" onHome={goHome}>
                <Suspense fallback={null}>
                  <StoreView visible={view === 'store'} />
                </Suspense>
              </ErrorBoundary>
            )}
            {view !== 'store' && (
              // Keyed per view so each tab switch gets a quick fade-in (and a fresh error boundary).
              <div className="view" key={view}>
                <ErrorBoundary scope="view" onHome={goHome}>
                  <Suspense fallback={null}>
                    {view === 'library' && <LibraryView />}
                    {view === 'downloads' && <DownloadsView />}
                    {view === 'settings' && <SettingsView />}
                  </Suspense>
                </ErrorBoundary>
              </div>
            )}
          </>
        )}
      </div>
      {view !== 'store' && <BottomBar />}
      {ready && (
        <>
          <Suspense fallback={null}>
            {installOpen && <InstallDialog />}
            {propertiesOpen && <PropertiesDialog />}
            {addGameOpen && <AddGameDialog />}
          </Suspense>
          <GameContextMenu />
        </>
      )}
      <ConfirmDialog />
      <Toasts />
    </div>
  )
}

/** Startup calls that failed: the app renders with what it has and offers a retry. */
function BootErrors(): React.JSX.Element | null {
  const errors = useStore((s) => s.bootErrors)
  const [busy, setBusy] = useState(false)
  if (!errors.length) return null
  return (
    <div className="boot-errors" role="alert">
      <span className="boot-errors-text" title={errors.join('\n')}>
        Some of your data couldn’t be loaded ({errors.map((e) => e.split(':')[0]).join(', ')}). {errors[0]}
      </span>
      <button
        className="btn btn-ghost small"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void bootstrap().finally(() => setBusy(false))
        }}
      >
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}
