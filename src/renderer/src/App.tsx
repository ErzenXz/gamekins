import { useEffect, useState } from 'react'
import { BottomBar } from './components/BottomBar'
import { ConfirmDialog } from './components/ConfirmDialog'
import { GameContextMenu } from './components/ContextMenu'
import { InstallDialog } from './components/InstallDialog'
import { AddGameDialog } from './components/library/AddGameDialog'
import { PropertiesDialog } from './components/PropertiesDialog'
import { ErrorBoundary } from './components/shell/ErrorBoundary'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { bootstrap, useStore } from './store'
import { DownloadsView } from './views/DownloadsView'
import { LibraryView } from './views/LibraryView'
import { SettingsView } from './views/SettingsView'
import { StoreView } from './views/StoreView'

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
    if (view === 'store') setStoreMounted(true)
  }, [view])

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
                <StoreView visible={view === 'store'} />
              </ErrorBoundary>
            )}
            {view !== 'store' && (
              // Keyed per view so each tab switch gets a quick fade-in (and a fresh error boundary).
              <div className="view" key={view}>
                <ErrorBoundary scope="view" onHome={goHome}>
                  {view === 'library' && <LibraryView />}
                  {view === 'downloads' && <DownloadsView />}
                  {view === 'settings' && <SettingsView />}
                </ErrorBoundary>
              </div>
            )}
          </>
        )}
      </div>
      {view !== 'store' && <BottomBar />}
      {ready && (
        <>
          <InstallDialog />
          <PropertiesDialog />
          <AddGameDialog />
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
