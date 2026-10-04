import '../styles/store.css'
import { ChevronLeft, ChevronRight, ExternalLink, Heart, Home, Lock, RotateCw, Search, ShoppingCart, WifiOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { STORE_HOME, STORE_LINKS, storeSearchUrl } from '../components/shell/storeLinks'
import { useStore } from '../store'
import { handledStoreRequest, rememberStoreRequest, rememberStoreURL, storeURL } from '../components/shell/storeSession'

const TABS = STORE_LINKS.filter((l) => l.label !== 'Wishlist' && l.label !== 'Cart')
const WISHLIST = STORE_LINKS.find((l) => l.label === 'Wishlist')!
const CART = STORE_LINKS.find((l) => l.label === 'Cart')!

/** The subset of Electron's <webview> element we use. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  setAudioMuted(muted: boolean): void
}

type FailEvent = Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

/** Human-readable URL for the bar: no scheme, no trailing slash, percent-escapes decoded. */
function displayUrl(url: string): string {
  let out = url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  try {
    out = decodeURIComponent(out)
  } catch {
    /* malformed escape: show as is */
  }
  return out
}

/**
 * Epic's web store, embedded. It shares the Epic session with our sign-in window,
 * so purchases land in the account and show up in the library on next refresh.
 *
 * Electron's webview methods throw until the guest is attached and has emitted `dom-ready`,
 * so before that we only ever set the `src` attribute (safe at any time).
 */
export function StoreView({ visible }: { visible: boolean }): React.JSX.Element {
  const ref = useRef<WebviewElement>(null)
  const ready = useRef(false)
  const visibleNow = useRef(visible)
  visibleNow.current = visible
  const request = useStore((s) => s.storeRequest)
  const [initial] = useState(() => {
    const request = useStore.getState().storeRequest
    if (request && request.n > handledStoreRequest) { rememberStoreRequest(request.n); rememberStoreURL(request.url); return request.url }
    return storeURL()
  })
  const handled = useRef(handledStoreRequest)
  const [guest, setGuest] = useState(0)
  const [guestURL, setGuestURL] = useState(initial)
  const [nav, setNav] = useState({ back: false, forward: false, url: initial, loading: true })
  const [failed, setFailed] = useState<{ url: string; text: string } | null>(null)
  const [inert, setInert] = useState(false)
  const [query, setQuery] = useState('')
  // Bumped each time a load starts so the progress line restarts its animation.
  const [loadId, setLoadId] = useState(0)

  const live = (): WebviewElement | null => {
    const el = ref.current
    return el && ready.current && typeof el.loadURL === 'function' ? el : null
  }
  /** Run a webview method, never letting it throw into React. */
  const call = (fn: (el: WebviewElement) => void): void => {
    const el = live()
    if (!el) return
    try {
      fn(el)
    } catch (err) {
      console.warn('[store] webview call failed', err)
    }
  }

  function go(url: string): void {
    rememberStoreURL(url)
    setFailed(null)
    const el = ref.current
    if (!el) return
    setNav((n) => ({ ...n, url }))
    if (live()) {
      try {
        void el.loadURL(url).catch(() => undefined)
        return
      } catch {
        /* fall through to the attribute */
      }
    }
    // Not ready yet (or not Electron): the attribute is picked up when the guest attaches.
    el.setAttribute('src', url)
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof (el as Partial<WebviewElement>).loadURL !== 'function') {
      // Plain browser preview: <webview> is an inert element.
      setInert(true)
      setNav((n) => ({ ...n, loading: false }))
      return
    }
    const sync = (): void => {
      if (!ready.current) return
      try {
        const url = el.getURL()
        rememberStoreURL(url)
        setNav((n) => ({ ...n, back: el.canGoBack(), forward: el.canGoForward(), url: url || n.url }))
      } catch {
        /* guest went away */
      }
    }
    const domReady = (): void => {
      ready.current = true
      el.setAudioMuted(!visibleNow.current || document.visibilityState === 'hidden')
      sync()
    }
    const start = (): void => {
      setLoadId((i) => i + 1)
      setFailed(null)
      setNav((n) => ({ ...n, loading: true }))
    }
    const stop = (): void => {
      setNav((n) => ({ ...n, loading: false }))
      sync()
    }
    const fail = (e: Event): void => {
      const f = e as FailEvent
      // -3 = aborted (a new navigation replaced this one): not an error.
      if (f.errorCode === -3 || f.isMainFrame === false) return
      setFailed({ url: f.validatedURL || el.getAttribute('src') || STORE_HOME, text: f.errorDescription || 'The page could not be loaded.' })
      setNav((n) => ({ ...n, loading: false }))
    }
    const navigated = (e: Event): void => {
      sync()
      // After checkout, pull the new purchase into the library.
      const url = (e as Event & { url?: string }).url ?? ''
      if (/purchase|checkout|order-confirmation/i.test(url)) void useStore.getState().refresh()
    }
    const gone = (): void => {
      ready.current = false
      setFailed({ url: storeURL(), text: 'The store stopped unexpectedly. Reload to continue.' })
      setNav((n) => ({ ...n, loading: false }))
    }
    el.addEventListener('render-process-gone', gone)
    el.addEventListener('dom-ready', domReady)
    el.addEventListener('did-start-loading', start)
    el.addEventListener('did-stop-loading', stop)
    el.addEventListener('did-fail-load', fail)
    el.addEventListener('did-navigate', navigated)
    el.addEventListener('did-navigate-in-page', sync)
    return () => {
      ready.current = false
      el.removeEventListener('render-process-gone', gone)
      el.removeEventListener('dom-ready', domReady)
      el.removeEventListener('did-start-loading', start)
      el.removeEventListener('did-stop-loading', stop)
      el.removeEventListener('did-fail-load', fail)
      el.removeEventListener('did-navigate', navigated)
      el.removeEventListener('did-navigate-in-page', sync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest])

  useEffect(() => {
    const mute = (): void => call((el) => el.setAudioMuted(!visible || document.visibilityState === 'hidden'))
    mute()
    document.addEventListener('visibilitychange', mute)
    return () => document.removeEventListener('visibilitychange', mute)
  }, [visible, guest])

  const reload = (): void => {
    if (failed && !ready.current) {
      rememberStoreURL(failed.url)
      setGuestURL(failed.url)
      setFailed(null)
      setNav((n) => ({ ...n, url: storeURL(), loading: true }))
      setGuest((n) => n + 1)
    } else if (failed) go(failed.url)
    else if (live()) call((el) => el.reload())
    else go(nav.url)
  }

  // Every "open in store" request navigates, even to a URL we already showed earlier.
  useEffect(() => {
    if (!request || request.n === handled.current) return
    handled.current = request.n
    rememberStoreRequest(request.n)
    go(request.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const search = (e: React.FormEvent): void => {
    e.preventDefault()
    const q = query.trim()
    if (q) go(storeSearchUrl(q))
  }

  const path = pathOf(nav.url)
  const secure = nav.url.startsWith('https:')
  const loading = nav.loading && !inert

  return (
    <div className="store" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="store-urlbar">
        <button className="sb-btn" disabled={!nav.back} onClick={() => call((el) => el.goBack())} title="Back">
          <ChevronLeft size={18} />
        </button>
        <button className="sb-btn" disabled={!nav.forward} onClick={() => call((el) => el.goForward())} title="Forward">
          <ChevronRight size={18} />
        </button>
        {loading ? (
          <button className="sb-btn" onClick={() => call((el) => el.stop())} title="Stop loading">
            <X size={16} />
          </button>
        ) : (
          <button
            className="sb-btn"
            onClick={reload}
            title="Reload"
          >
            <RotateCw size={15} />
          </button>
        )}
        <button className="sb-btn" onClick={() => go(STORE_HOME)} title="Store home">
          <Home size={15} />
        </button>
        <div className="store-url" title={displayUrl(nav.url)}>
          {secure && <Lock size={12} className="store-lock" />}
          <span>{displayUrl(nav.url)}</span>
        </div>
        <button className="sb-btn" title="Open in your browser" onClick={() => void window.gamekins.app.openExternal(nav.url)}>
          <ExternalLink size={15} />
        </button>
      </div>

      <div className="store-navbar">
        <nav className="store-nav">
          <div className="store-tabs">
            {TABS.map((l) => (
              <button key={l.label} className={`store-tab ${l.match.test(path) ? 'active' : ''}`} onClick={() => go(l.url)}>
                {l.label}
              </button>
            ))}
          </div>
          <form className="store-search" onSubmit={search} role="search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search the store"
              spellCheck={false}
              aria-label="Search the store"
            />
            <button type="submit" title="Search" disabled={!query.trim()}>
              <Search size={15} />
            </button>
          </form>
          <div className="store-quick">
            <button className={`store-pill ${WISHLIST.match.test(path) ? 'active' : ''}`} onClick={() => go(WISHLIST.url)}>
              <Heart size={12} /> Wishlist
            </button>
            <button className={`store-pill cart ${CART.match.test(path) ? 'active' : ''}`} onClick={() => go(CART.url)}>
              <ShoppingCart size={12} /> Cart
            </button>
          </div>
        </nav>
      </div>

      <div className="store-page">
        <div key={loadId} className={`store-loading ${loading ? 'on' : 'off'}`}>
          <div />
        </div>
        <webview
          key={guest}
          ref={ref as unknown as React.Ref<HTMLWebViewElement>}
          className="store-webview"
          src={guestURL}
          partition="persist:epic"
          // Electron only checks that the attribute is present; React warns on a bare boolean.
          allowpopups={'true' as unknown as boolean}
        />
        {failed && (
          <div className="store-overlay">
            <WifiOff size={40} strokeWidth={1.4} />
            <div className="store-overlay-title">The store couldn’t be reached</div>
            <p>
              {failed.text}
              <br />
              <span className="mono">{displayUrl(failed.url)}</span>
            </p>
            <div className="store-overlay-actions">
              <button className="btn btn-blue" onClick={reload}>
                Retry
              </button>
              <button className="btn btn-ghost" onClick={() => void window.gamekins.app.openExternal(failed.url)}>
                Open in browser
              </button>
            </div>
          </div>
        )}
        {inert && (
          <div className="store-overlay">
            <ShoppingCart size={40} strokeWidth={1.4} />
            <div className="store-overlay-title">Epic Games Store</div>
            <p>
              The store page loads here inside the Gamekins app.
              <br />
              <span className="mono">{displayUrl(nav.url)}</span>
            </p>
            <div className="store-overlay-actions">
              <button className="btn btn-ghost" onClick={() => void window.gamekins.app.openExternal(nav.url)}>
                Open in browser
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
