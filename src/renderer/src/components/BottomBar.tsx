import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DownloadJob } from '@shared/types'
import { img } from '../lib/format'
import { jobProgress } from '../lib/gameActions'
import { useStore } from '../store'
import { Dropdown } from './shell/Dropdown'
import { STORE_HOME } from './shell/storeLinks'

const RUNNING: DownloadJob['state'][] = ['preparing', 'verifying', 'downloading', 'finalizing']
const REDEEM_URL = 'https://www.epicgames.com/redeem'

interface Summary {
  mode: 'idle' | 'active' | 'waiting' | 'paused' | 'error' | 'complete'
  text: string
  pct: number
  title: string
  image?: string
}

/** Everything the footer shows, as a flat (shallow-comparable) summary. */
function summarize(jobs: DownloadJob[]): Summary {
  const live = jobs.filter((j) => j.state !== 'done' && j.state !== 'cancelled')
  const done = jobs.filter((j) => j.state === 'done').length
  const active = live.find((j) => RUNNING.includes(j.state))
  const total = live.length + done
  if (active) {
    const index = done + 1
    const verb = active.state === 'verifying' ? 'Verifying' : active.kind === 'update' ? 'Updating' : 'Downloading'
    return {
      mode: 'active',
      text: total > 1 ? `${verb} ${index} of ${total}` : verb,
      pct: Math.floor(jobProgress(active) * 100),
      title: active.title,
      image: active.image
    }
  }
  const waiting = live.find((j) => j.waitingReason)
  const errors = live.filter((j) => j.state === 'error').length
  const pending = live.length - errors
  if (waiting) return { mode: 'waiting', text: `Downloads Paused - ${pending} Item${pending === 1 ? '' : 's'} Queued`, pct: 0, title: waiting.waitingReason ?? '' }
  if (pending > 0) return { mode: 'paused', text: `Downloads Paused - ${pending} Item${pending === 1 ? '' : 's'} Queued`, pct: 0, title: '' }
  if (errors) return { mode: 'error', text: `Downloads - ${errors} Item${errors === 1 ? '' : 's'} Failed`, pct: 0, title: '' }
  if (done) return { mode: 'complete', text: `Downloads - ${done} of ${done} Item${done === 1 ? '' : 's'} Complete`, pct: 100, title: '' }
  return { mode: 'idle', text: 'Manage Downloads', pct: 0, title: '' }
}

/** Steam library footer: Add a Game · download status · presence. */
export function BottomBar(): React.JSX.Element {
  // Re-render only when what we display changes (not on every speed sample).
  const { mode, text, pct, title, image } = useStore(useShallow((s) => summarize(s.jobs)))
  const view = useStore((s) => s.route.view)
  const account = useStore((s) => s.accounts[0])
  const online = useStore((s) => s.online)
  const sessionExpired = useStore((s) => s.sessionExpired)
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    if (!menu) return
    const close = (e: Event): void => {
      if (e.type === 'blur' || (e as KeyboardEvent).key === 'Escape') setMenu(false)
    }
    window.addEventListener('keydown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  const st = useStore.getState

  const presence = !account ? (sessionExpired ? 'Session expired' : 'Signed out') : online ? 'Online' : 'No connection'
  const presenceClass = !account ? 'signed-out' : online ? 'online' : 'offline'

  return (
    <footer className="bottombar">
      <div className="bb-left">
        <div className="bb-add-wrap">
          {menu && <div className="bb-backdrop" onMouseDown={() => setMenu(false)} />}
          <button
            className={`bb-add ${menu ? 'open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 4.5v7M4.5 8h7" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span>Add a Game</span>
          </button>
          {menu && (
            <Dropdown
              direction="up"
              autoFocus={false}
              onClose={() => setMenu(false)}
              items={[
                { label: 'Add a Non-Epic Game…', onSelect: () => st().setAddGameOpen(true) },
                { label: 'Redeem a Code…', onSelect: () => st().navigate({ view: 'store', url: REDEEM_URL }) },
                { label: 'Browse the Epic Games Store…', onSelect: () => st().navigate({ view: 'store', url: STORE_HOME }) }
              ]}
            />
          )}
        </div>
      </div>

      <button
        className={`bb-downloads mode-${mode} ${view === 'downloads' ? 'current' : ''}`}
        onClick={() => st().navigate({ view: 'downloads' })}
        title={title || 'Open the downloads page'}
      >
        {mode === 'active' ? (
          <>
            <span className="bb-dl-icon art">
              {image ? <img src={img(image, 120)} alt="" /> : <span className="bb-dl-blank" />}
            </span>
            <span className="bb-dl-col">
              <span className="bb-dl-line">
                <span className="bb-dl-text">{text}</span>
                <span className="bb-dl-pct">{pct}%</span>
              </span>
              <span className="bb-dl-progress">
                <span style={{ width: `${pct}%` }} />
              </span>
            </span>
          </>
        ) : (
          <>
            <svg className="bb-dl-glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M8 1.5v9M4 7l4 4 4-4M2 14.5h12" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            <span className="bb-dl-text">{text}</span>
          </>
        )}
      </button>

      <div className="bb-right">
        <button
          className={`bb-presence ${presenceClass}`}
          onClick={() => (account ? st().navigate({ view: 'settings', section: 'account' }) : void st().signIn('epic'))}
          title={
            account
              ? `Signed in to Epic Games as ${account.displayName}${online ? '' : ' — this PC appears to be offline'}`
              : 'Sign in to Epic Games'
          }
        >
          <span>{account ? `${account.displayName} · ${presence}` : presence}</span>
          <i className="bb-dot" />
        </button>
      </div>
    </footer>
  )
}
