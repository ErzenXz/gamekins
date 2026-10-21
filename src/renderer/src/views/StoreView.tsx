import '../styles/store.css'
import { ChevronLeft, ChevronRight, ExternalLink, Heart, Home, Lock, RotateCw, Search, ShoppingCart, WifiOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { siteOf, STORE_SITES, type StoreSite } from '../components/shell/storeLinks'
import { StoreBadge } from '../components/library/StoreBadge'
import { useStore } from '../store'
import { handledStoreRequest, rememberStoreRequest, rememberStoreSite, rememberStoreURL, storeSite, storeURL } from '../components/shell/storeSession'
import { STORE_DISTRIBUTION } from '../../../shared/distribution'
import { externalStoreRequest } from '../../../shared/contentPolicy'

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
  return STORE_DISTRIBUTION ? <StoreDistributionView /> : <EmbeddedStoreView visible={visible} />
}

const EXTERNAL_STORES = [
  { name: 'Epic Games', home: 'https://store.epicgames.com/', support: 'https://safety.epicgames.com/policies/reporting-misconduct', controls: 'https://safety.epicgames.com/en-US/parental-controls' },
  { name: 'Steam', home: 'https://store.steampowered.com/', support: 'https://help.steampowered.com/en/faqs/view/4DE7-17AA-0E8B-C1AD', controls: 'https://store.steampowered.com/account/familymanagement/' },
  { name: 'GOG', home: 'https://www.gog.com/', support: 'https://support.gog.com/hc/en-us/articles/16033687971613-Infringing-Content-and-Copyright-Policy-effective-from-17-February-2024', controls: 'https://support.gog.com/hc/en-us/sections/115000136785-Policies' }
]

/** Catalogs remain with their providers; this view contains no embedded web content. */
export function StoreDistributionView(): React.JSX.Element {
  const request = useStore((state) => state.storeRequest)
  const [error, setError] = useState('')
  const requested = externalStoreRequest(request?.url)
  const open = (url: string): void => {
    setError('')
    void window.gamekins.app.openExternal(url).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The browser could not be opened.'))
  }
  return (
    <section data-testid="store-distribution-safeguards" aria-labelledby="external-store-title" style={{ padding: '32px', maxWidth: '1040px', margin: '0 auto', overflowY: 'auto', height: '100%' }}>
      <h1 id="external-store-title">Visit your game stores</h1>
      <p style={{ lineHeight: 1.7, maxWidth: '760px' }}>
        Gamekins manages your library, installs and play time. Store catalogs and purchases open in your browser when you choose a link.
        Catalog images, descriptions, reviews and promotions are withheld in this Microsoft Store edition. You can still choose your own local artwork.
      </p>
      <p style={{ lineHeight: 1.7, maxWidth: '760px' }}>
        These services are provided by Epic Games, Valve and GOG. Their sites can contain mature content and use their own accounts, payments, privacy policies,
        age checks and parental controls. Review those controls before browsing. Provider support pages explain how to report inappropriate content; Gamekins does not review or moderate their catalogs.
      </p>
      {requested && (
        <div className="gp-panel" style={{ padding: '20px', margin: '20px 0' }}>
          <h2>Requested store page</h2>
          <p style={{ overflowWrap: 'anywhere' }}>{new URL(requested).hostname}</p>
          <button className="btn btn-blue" onClick={() => open(requested)}><ExternalLink size={16} /> Open requested page in browser</button>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(235px, 1fr))', gap: '16px', marginTop: '24px' }}>
        {EXTERNAL_STORES.map((provider) => (
          <article key={provider.name} className="gp-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '14px' }}>
            <h2 style={{ margin: 0 }}>{provider.name}</h2>
            <button className="btn btn-blue" onClick={() => open(provider.home)}><ExternalLink size={16} /> Open store in browser</button>
            <button className="btn btn-ghost" onClick={() => open(provider.support)}>Support and content reporting</button>
            <button className="btn btn-ghost" onClick={() => open(provider.controls)}>{provider.name === 'GOG' ? 'Provider policies' : 'Family and parental controls'}</button>
          </article>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

function EmbeddedStoreView({ visible }: { visible: boolean }): React.JSX.Element {
  const ref = useRef<WebviewElement>(null)
  const ready = useRef(false)
  const visibleNow = useRef(visible)
  visibleNow.current = visible
  const request = useStore((s) => s.storeRequest)
  const [initial] = useState(() => {
    const request = useStore.getState().storeRequest
    if (request && request.n > handledStoreRequest) {
      rememberStoreRequest(request.n)
      rememberStoreURL(request.url)
      rememberStoreSite(siteOf(request.url))
      return request.url
    }
    return storeURL()
  })
  // One store page at a time (each store is its own renderer process): switching swaps it.
  const [site, setSite] = useState<StoreSite>(() => siteOf(initial) === storeSite() ? storeSite() : siteOf(initial))
  const config = STORE_SITES[site]
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
    const target = siteOf(url)
    if (target !== site) return switchSite(target, url)
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
      setFailed({ url: f.validatedURL || el.getAttribute('src') || STORE_SITES[siteOf(el.getAttribute('src') || '')].home, text: f.errorDescription || 'The page could not be loaded.' })
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

  function switchSite(next: StoreSite, url = storeURL(next)): void {
    rememberStoreSite(next)
    rememberStoreURL(url)
    ready.current = false
    setFailed(null)
    setSite(next)
    setGuestURL(url)
    setNav({ back: false, forward: false, url, loading: true })
    setGuest((n) => n + 1)
  }

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
    if (q) go(config.search(q))
  }

  const path = pathOf(nav.url)
  const secure = nav.url.startsWith('https:')
  const loading = nav.loading && !inert
  // URL bar: host emphasised, path dimmed.
  const shown = displayUrl(nav.url)
  const slash = shown.indexOf('/')
  const host = slash < 0 ? shown : shown.slice(0, slash)
  const rest = slash < 0 ? '' : shown.slice(slash)

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
        <button className="sb-btn" onClick={() => go(config.home)} title={`${config.name} home`}>
          <Home size={15} />
        </button>
        <div className="store-url" title={shown}>
          {secure && <Lock size={13} className="store-lock" />}
          <span>
            <span className="store-host">{host}</span>
            {rest}
          </span>
        </div>
        <button className="sb-btn" title="Open in your browser" onClick={() => void window.gamekins.app.openExternal(nav.url)}>
          <ExternalLink size={15} />
        </button>
      </div>

      <div className="store-navbar">
        <nav className="store-nav">
          <div className="store-sites" role="tablist" aria-label="Store">
            {(Object.keys(STORE_SITES) as StoreSite[]).map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={site === id}
                className={`store-site ${site === id ? 'on' : ''}`}
                title={STORE_SITES[id].name}
                onClick={() => site !== id && switchSite(id)}
              >
                <StoreBadge store={id} size={16} />
                <span>{STORE_SITES[id].name}</span>
              </button>
            ))}
          </div>
          <div className="store-tabs">
            {config.tabs.map((l) => (
              <button key={l.label} className={`store-tab ${l.match.test(path) ? 'active' : ''}`} onClick={() => go(l.url)}>
                {l.label}
              </button>
            ))}
          </div>
          <form className="store-search" onSubmit={search} role="search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${config.name}`}
              spellCheck={false}
              aria-label="Search the store"
            />
            <button type="submit" title="Search" disabled={!query.trim()}>
              <Search size={15} />
            </button>
          </form>
          <div className="store-quick">
            <button className={`store-pill ${config.wishlist.match.test(path) ? 'active' : ''}`} onClick={() => go(config.wishlist.url)}>
              <Heart size={12} /> Wishlist
            </button>
            <button className={`store-pill cart ${config.cart.match.test(path) ? 'active' : ''}`} onClick={() => go(config.cart.url)}>
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
          key={`${site}-${guest}`}
          ref={ref as unknown as React.Ref<HTMLWebViewElement>}
          className="store-webview"
          src={guestURL}
          partition={config.partition}
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
            <div className="store-overlay-title">{config.name} store</div>
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
