import '../../styles/friends.css'
import { ArrowLeft, Check, ChevronDown, Ellipsis, LoaderCircle, MessageSquare, RefreshCw, Search, SendHorizontal, UserPlus, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Friend, FriendRequest, MyStatus, SocialNetwork, SocialState, StoreId } from '@shared/types'
import { STORE_DISTRIBUTION } from '../../../../shared/distribution'
import { StoreBadge } from '../library/StoreBadge'
import { useSocial } from '../../lib/social'
import { act, useStore } from '../../store'
import { COMMUNITY_URL, openProviderConversation, PROVIDER_SAFETY, safetyReportUrl, useSocialSafety, type Restriction } from '../../lib/socialSafety'

const STATUS_LABEL: Record<MyStatus, string> = { online: 'Online', away: 'Away', offline: 'Appear offline' }

/** Stable, pleasant avatar colour per account. */
function hue(id: string): number {
  // FNV-1a: ids that differ by one character still land far apart on the colour wheel.
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 0) % 360
}

export function Avatar({ id, name, status, size = 34 }: { id: string; name: string; status?: Friend['status'] | MyStatus; size?: number }): React.JSX.Element {
  const h = hue(id)
  return (
    <span
      className={`fr-avatar ${status ?? ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 40) % 360} 58% 38%))` }}
      aria-hidden
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

function ago(ms: number | undefined): string {
  if (!ms) return 'Offline'
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 2) return 'Last online just now'
  if (m < 60) return `Last online ${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `Last online ${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `Last online ${d} ${d === 1 ? 'day' : 'days'} ago`
  return `Last online ${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
}

export function friendLine(f: Friend): string {
  if (f.status === 'playing') return f.activity || (f.app ? `Playing ${f.app}` : 'In game')
  if (f.status === 'online') return f.activity || (f.app ? `In ${f.app}` : 'Online')
  if (f.status === 'away') return f.activity ? `Away · ${f.activity}` : 'Away'
  return ago(f.lastOnline)
}

const storeOf = (x: { provider?: StoreId; id: string }): StoreId => x.provider ?? (x.id.split(':')[0] as StoreId)
const netOf = (state: SocialState, x: { provider?: StoreId; id: string }): SocialNetwork | undefined =>
  state.networks?.find((n) => n.provider === storeOf(x))

export default function FriendsPanel(): React.JSX.Element {
  const state = useSocial((s) => s.state)
  const chatWith = useSocial((s) => s.chatWith)
  const setOpen = useSocial((s) => s.setOpen)
  const signIn = (): void => void useStore.getState().signIn('epic')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  const friend = chatWith ? state?.friends.find((f) => f.id === chatWith) : undefined

  return (
    <aside className="fr-panel" aria-label={STORE_DISTRIBUTION ? 'Friends' : 'Friends and chat'}>
      {!state?.available ? (
        <div className="fr-empty">
          <MessageSquare size={30} />
          <b>{STORE_DISTRIBUTION ? 'Friends' : 'Friends & chat'}</b>
          <span>Sign in to see your friends and who's playing.{!STORE_DISTRIBUTION && ' Epic chat is also available.'}</span>
          <button className="btn btn-blue" onClick={signIn}>
            Sign in with Epic Games
          </button>
          <button className="fr-close abs" title="Close" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>
        </div>
      ) : friend && !STORE_DISTRIBUTION ? (
        <Chat friend={friend} state={state} />
      ) : (
        <FriendList state={state} />
      )}
      <SafetyPanel />
    </aside>
  )
}

function MeHeader({ state }: { state: SocialState }): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const setOpen = useSocial((s) => s.setOpen)
  const me = state.me!
  const choose = (status: MyStatus): void => {
    setMenu(false)
    void useStore.getState().saveSettings({ friendsStatus: status })
  }
  const live = state.connection
  return (
    <header className="fr-me">
      <Avatar id={me.id} name={me.displayName} status={state.myStatus} size={38} />
      <div className="fr-me-text">
        <b>{me.displayName}</b>
        <div className="fr-status-wrap">
          <button className={`fr-status ${state.myStatus}`} onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
            <i />
            {live === 'connecting' ? 'Connecting…' : live === 'error' ? 'Reconnecting…' : STATUS_LABEL[state.myStatus]}
            <ChevronDown size={13} />
          </button>
          {menu && (
            <>
              <div className="fr-backdrop" onMouseDown={() => setMenu(false)} />
              <div className="dd fr-status-menu" role="menu">
                {(['online', 'away', 'offline'] as MyStatus[]).map((s) => (
                  <button key={s} role="menuitemradio" aria-checked={state.myStatus === s} className="dd-item" onClick={() => choose(s)}>
                    <span className={`fr-dot ${s}`} />
                    <span className="dd-label">{STATUS_LABEL[s]}</span>
                    {state.myStatus === s && <Check size={14} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <button className="fr-close" title="Close (Esc)" onClick={() => setOpen(false)}>
        <X size={16} />
      </button>
    </header>
  )
}

function FriendList({ state }: { state: SocialState }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [showOffline, setShowOffline] = useState(false)
  const [store, setStore] = useState<StoreId | 'all'>('all')
  const networks = state.networks ?? []
  const q = query.trim().toLowerCase()
  const friends = useMemo(
    () => state.friends.filter((f) => (store === 'all' || storeOf(f) === store) && (!q || f.displayName.toLowerCase().includes(q))),
    [state.friends, q, store]
  )
  const canAdd = networks.some((n) => n.canAddFriends)
  const playing = friends.filter((f) => f.status === 'playing')
  const online = friends.filter((f) => f.status === 'online' || f.status === 'away')
  const offline = friends.filter((f) => f.status === 'offline')
  const requests = state.requests.filter((r) => store === 'all' || storeOf(r) === store)
  const incoming = requests.filter((r) => r.direction === 'incoming')
  const outgoing = requests.filter((r) => r.direction === 'outgoing')

  return (
    <>
      <MeHeader state={state} />
      <div className="fr-tools">
        <div className="fr-search">
          <Search size={14} />
          <input placeholder="Search friends" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="Search friends" />
          {query && (
            <button title="Clear" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </div>
        {canAdd && (
          <button className={`fr-tool ${adding ? 'on' : ''}`} title="Add a friend" aria-pressed={adding} onClick={() => setAdding(!adding)}>
            <UserPlus size={16} />
          </button>
        )}
        <button className="fr-tool" title="Refresh" disabled={state.loading} onClick={() => void window.gamekins.social.refresh()}>
          <RefreshCw size={15} className={state.loading ? 'spin' : ''} />
        </button>
      </div>
      {networks.length > 1 && (
        <div className="fr-stores" role="tablist" aria-label="Show friends from">
          <button role="tab" aria-selected={store === 'all'} className={store === 'all' ? 'on' : ''} onClick={() => setStore('all')}>
            All
          </button>
          {networks.map((n) => (
            <button
              key={n.provider}
              role="tab"
              aria-selected={store === n.provider}
              className={store === n.provider ? 'on' : ''}
              onClick={() => setStore(n.provider)}
              title={n.error ?? n.name}
            >
              <StoreBadge store={n.provider} size={14} />
              {n.name}
              {n.connection === 'error' && <i className="fr-store-err" />}
            </button>
          ))}
        </div>
      )}
      {adding && <AddFriend networks={networks.filter((n) => n.canAddFriends)} onDone={() => setAdding(false)} />}
      {state.error && <div className="fr-error">{state.error}</div>}

      <div className="fr-list scroll">
        {incoming.length > 0 && (
          <Section title="Friend requests" count={incoming.length} accent>
            {incoming.map((r) => (
              <RequestRow key={r.id} request={r} network={netOf(state, r)} badge={networks.length > 1} />
            ))}
          </Section>
        )}
        {playing.length > 0 && (
          <Section title="In game" count={playing.length}>
            {playing.map((f) => (
              <FriendRow key={f.id} friend={f} unread={state.unread[f.id] ?? 0} network={netOf(state, f)} badge={networks.length > 1} />
            ))}
          </Section>
        )}
        {online.length > 0 && (
          <Section title="Online" count={online.length}>
            {online.map((f) => (
              <FriendRow key={f.id} friend={f} unread={state.unread[f.id] ?? 0} network={netOf(state, f)} badge={networks.length > 1} />
            ))}
          </Section>
        )}
        {offline.length > 0 && (
          <Section title="Offline" count={offline.length} collapsed={!showOffline && !q} onToggle={() => setShowOffline(!showOffline)}>
            {offline.map((f) => (
              <FriendRow key={f.id} friend={f} unread={state.unread[f.id] ?? 0} network={netOf(state, f)} badge={networks.length > 1} />
            ))}
          </Section>
        )}
        {outgoing.length > 0 && !q && (
          <Section title="Sent requests" count={outgoing.length}>
            {outgoing.map((r) => (
              <RequestRow key={r.id} request={r} network={netOf(state, r)} badge={networks.length > 1} />
            ))}
          </Section>
        )}
        {friends.length === 0 && !state.loading && (
          <div className="fr-none">{q ? `No friends match "${query}".` : 'No friends yet. Add someone by their Epic display name.'}</div>
        )}
        {state.loading && state.friends.length === 0 && (
          <div className="fr-none">
            <LoaderCircle size={18} className="spin" />
          </div>
        )}
      </div>
    </>
  )
}

function Section({
  title,
  count,
  accent,
  collapsed,
  onToggle,
  children
}: {
  title: string
  count: number
  accent?: boolean
  collapsed?: boolean
  onToggle?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="fr-sec">
      <button className={`fr-sec-head ${accent ? 'accent' : ''}`} onClick={onToggle} disabled={!onToggle} aria-expanded={onToggle ? !collapsed : undefined}>
        {onToggle && <ChevronDown size={13} className={collapsed ? 'closed' : ''} />}
        <span>{title}</span>
        <em>{count}</em>
      </button>
      {!collapsed && children}
    </section>
  )
}

const FriendRow = memo(function FriendRow({
  friend: f,
  unread,
  network,
  badge
}: {
  friend: Friend
  unread: number
  network?: SocialNetwork
  badge: boolean
}): React.JSX.Element {
  const openChatHere = useSocial((s) => s.openChat)
  const [menu, setMenu] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 60, right: 12 })
  const store = storeOf(f)
  const external = (kind: 'chat' | 'profile'): void => void act(() => window.gamekins.social.openExternal(f.id, kind))
  // Epic chats in Gamekins; Steam chat opens in the Steam client.
  const openChat = (id: string): void => {
    if (STORE_DISTRIBUTION) void act(() => openProviderConversation(id))
    else if (network?.canChat) void openChatHere(id)
    else if (store === 'steam') external('chat')
    else if (store !== 'epic') external('profile')
  }
  const remove = (): void => {
    setMenu(false)
    useStore.getState().setConfirm({
      title: `Remove ${f.displayName}?`,
      message: `${f.displayName} will be removed from your ${network?.name ?? 'provider'} friends. You can send a new request later.`,
      confirmLabel: 'Remove friend',
      danger: true,
      onConfirm: () => act(() => window.gamekins.social.remove(f.id), `Removed ${f.displayName}`)
    })
  }
  return (
    <div className={`fr-row ${f.status}`} role="button" tabIndex={0} onClick={() => void openChat(f.id)} onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && void openChat(f.id)}>
      <Avatar id={f.id} name={f.displayName} status={f.status} />
      <div className="fr-row-text">
        <b>
          <span className="fr-name">{f.displayName}</span>
          {badge && <StoreBadge store={store} size={14} />}
        </b>
        <span title={friendLine(f)}>{friendLine(f)}</span>
      </div>
      {unread > 0 && <span className="fr-unread">{unread}</span>}
      <div className="fr-row-menu" onClick={(e) => e.stopPropagation()}>
        <button className="fr-more" title="More" aria-haspopup="menu" aria-expanded={menu} onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenuPosition({ top: Math.max(54, Math.min(rect.bottom + 4, window.innerHeight - 390)), right: Math.max(8, window.innerWidth - rect.right) })
          setMenu(!menu)
        }}>
          <Ellipsis size={16} />
        </button>
        {menu && createPortal(
          <>
            <div className="fr-backdrop" style={{ zIndex: 1401 }} onMouseDown={() => setMenu(false)} />
            <div className="dd fr-friend-menu" style={{ position: 'fixed', ...menuPosition, zIndex: 1402 }} role="menu">
              {!STORE_DISTRIBUTION && network?.canChat ? (
                <button className="dd-item" onClick={() => (setMenu(false), openChat(f.id))}>
                  Send a message
                </button>
              ) : store === 'steam' ? (
                <button className="dd-item" onClick={() => (setMenu(false), external('chat'))}>
                  Chat in Steam
                </button>
              ) : STORE_DISTRIBUTION ? (
                <button className="dd-item" onClick={() => (setMenu(false), openChat(f.id))}>
                  {store === 'epic' ? 'Epic chat and safety help' : 'Open GOG profile'}
                </button>
              ) : null}
              {store !== 'epic' && (
                <button className="dd-item" onClick={() => (setMenu(false), external('profile'))}>
                  View profile
                </button>
              )}
              {network?.canAddFriends && (
                <>
                  <div className="dd-sep" />
                  <button className="dd-item danger" onClick={remove}>
                    Remove provider friendship…
                  </button>
                </>
              )}
              <SafetyMenuItems friend={f} close={() => setMenu(false)} />
            </div>
          </>, document.body
        )}
      </div>
    </div>
  )
})

function restrictLocally(friend: Pick<Friend, 'id' | 'displayName'>, restriction: Restriction): void {
  void act(async () => useSocialSafety.getState().restrict(friend.id, friend.displayName, restriction),
    restriction === 'blocked' ? 'Blocked in Gamekins on this device' : restriction === 'removed' ? 'Removed from your Gamekins list on this device' : 'Hidden in Gamekins on this device')
}

function SafetyMenuItems({ friend, close }: { friend: Friend; close(): void }): React.JSX.Element {
  return <>
    <div className="dd-sep" />
    <button className="dd-item" onClick={() => { close(); restrictLocally(friend, 'hidden') }}>Hide in Gamekins</button>
    <button className="dd-item" onClick={() => { close(); restrictLocally(friend, 'blocked') }}>Block in Gamekins</button>
    <button className="dd-item" onClick={() => { close(); restrictLocally(friend, 'removed') }}>Remove from Gamekins list</button>
    <button className="dd-item" onClick={() => { close(); void act(() => window.gamekins.app.openExternal(safetyReportUrl(friend.id, friend.displayName))) }}>Report to Gamekins…</button>
    <button className="dd-item" onClick={() => { close(); void act(() => window.gamekins.app.openExternal(PROVIDER_SAFETY[storeOf(friend)])) }}>Report or block with provider…</button>
  </>
}

function SafetyPanel(): React.JSX.Element {
  const entries = useSocialSafety((s) => s.entries)
  return <div className="fr-safety">
    {STORE_DISTRIBUTION && <p>Use the provider’s client or game for chat. This Store edition does not display or send chat.</p>}
    <p>Names, presence and other player content come from Epic, Steam or GOG. Gamekins does not pre-screen provider content.</p>
    <button className="fr-safety-link" onClick={() => void act(() => window.gamekins.app.openExternal(COMMUNITY_URL))}>Community guidelines & reporting</button>
    <button className="fr-safety-link" onClick={() => void act(() => window.gamekins.app.openExternal('mailto:erzen@quad-labs.com?subject=Gamekins%20safety%20report'))}>Report a safety concern…</button>
    <details>
      <summary>Local safety controls{entries.length ? ` (${entries.length})` : ''}</summary>
      <p>Hide, block and remove apply only to Gamekins on this device. They hide friends, requests and messages here. Use the provider’s controls to block communication or remove a friendship on its network.</p>
      <div className="fr-safety-entries scroll">
        {entries.map((entry) => <div key={entry.id} className="fr-safety-entry">
          <span>{entry.displayName} · {entry.restriction}<small>{entry.id}</small></span>
          <button className="btn small btn-ghost" onClick={() => void act(async () => useSocialSafety.getState().restore(entry.id), 'Local restriction removed')}>Restore</button>
        </div>)}
        {!entries.length && <p>No local restrictions.</p>}
      </div>
    </details>
  </div>
}

function RequestRow({ request: r, network, badge }: { request: FriendRequest; network?: SocialNetwork; badge: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>, done: string): Promise<void> => {
    setBusy(true)
    await act(fn, done)
    setBusy(false)
  }
  return (
    <div className="fr-row request">
      <Avatar id={r.id} name={r.displayName || '?'} />
      <div className="fr-row-text">
        <b>
          <span className="fr-name">{r.displayName || 'Player'}</span>
          {badge && <StoreBadge store={storeOf(r)} size={14} />}
        </b>
        <span>{r.direction === 'incoming' ? 'Wants to be your friend' : 'Request sent'}</span>
      </div>
      <button className="btn small btn-ghost" onClick={() => restrictLocally(r, 'blocked')} title="Hide this request and future messages in Gamekins on this device">Block locally</button>
      {!network?.canAddFriends ? (
        <button className="btn small btn-ghost" onClick={() => void act(() => window.gamekins.social.openExternal(r.id, 'profile'))}>
          Open in {network?.name ?? 'store'}
        </button>
      ) : r.direction === 'incoming' ? (
        <div className="fr-req-actions">
          <button className="fr-accept" title="Accept" disabled={busy} onClick={() => void run(() => window.gamekins.social.accept(r.id), `You're now friends with ${r.displayName}`)}>
            <Check size={15} />
          </button>
          <button className="fr-decline" title="Decline" disabled={busy} onClick={() => void run(() => window.gamekins.social.remove(r.id), 'Request declined')}>
            <X size={15} />
          </button>
        </div>
      ) : (
        <button className="btn small btn-ghost" disabled={busy} onClick={() => void run(() => window.gamekins.social.remove(r.id), 'Request cancelled')}>
          Cancel
        </button>
      )}
    </div>
  )
}

function AddFriend({ networks, onDone }: { networks: SocialNetwork[]; onDone: () => void }): React.JSX.Element {
  const [store, setStore] = useState<StoreId>(networks[0]?.provider ?? 'epic')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const matched = await window.gamekins.social.add(store, name)
      useStore.getState().toast({ kind: 'success', message: `Friend request sent to ${matched}` })
      onDone()
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="fr-add"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label htmlFor="fr-add-name">Add a friend by their {networks.find((n) => n.provider === store)?.name ?? 'Epic Games'} display name</label>
      {networks.length > 1 && (
        <div className="fr-stores small">
          {networks.map((n) => (
            <button type="button" key={n.provider} className={store === n.provider ? 'on' : ''} onClick={() => setStore(n.provider)}>
              <StoreBadge store={n.provider} size={14} />
              {n.name}
            </button>
          ))}
        </div>
      )}
      <div className="fr-add-row">
        <input id="fr-add-name" ref={input} className="input" placeholder="Display name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        <button className="btn btn-blue" disabled={!name.trim() || busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : 'Send'}
        </button>
      </div>
      {error && <span className="fr-add-error">{error}</span>}
    </form>
  )
}

function Chat({ friend: f, state }: { friend: Friend; state: SocialState }): React.JSX.Element {
  const messages = useSocial((s) => s.chats[f.id])
  const closeChat = useSocial((s) => s.closeChat)
  const send = useSocial((s) => s.send)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const canChat = state.connection === 'online' && state.myStatus !== 'offline'

  useEffect(() => box.current?.focus(), [f.id])
  useLayoutEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages?.length])
  useEffect(() => {
    if (state.unread[f.id]) void window.gamekins.social.markRead(f.id)
  }, [state.unread, f.id])

  const submit = async (): Promise<void> => {
    const body = text.trim()
    if (!body || !canChat) return
    setError('')
    try {
      await send(f.id, body)
      setText('')
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className="fr-chat">
      <header className="fr-chat-head">
        <button className="fr-close" title="Back to friends" onClick={closeChat}>
          <ArrowLeft size={17} />
        </button>
        <Avatar id={f.id} name={f.displayName} status={f.status} size={34} />
        <div className="fr-row-text">
          <b>{f.displayName}</b>
          <span className={`fr-chat-status ${f.status}`}>{friendLine(f)}</span>
        </div>
        <button className="fr-close" title="Close (Esc)" onClick={() => useSocial.getState().setOpen(false)}>
          <X size={16} />
        </button>
      </header>
      <div className="fr-safety-quick">
        <button onClick={() => restrictLocally(f, 'blocked')}>Block in Gamekins</button>
        <button onClick={() => void act(() => window.gamekins.app.openExternal(safetyReportUrl(f.id, f.displayName)))}>Report…</button>
      </div>
      <div className="fr-msgs scroll" ref={list}>
        {!messages?.length ? (
          <div className="fr-chat-empty">
            <Avatar id={f.id} name={f.displayName} status={f.status} size={56} />
            <b>{f.displayName}</b>
            <span>Say hi! Messages go to {f.displayName} on Epic Games and Fortnite. Chat history is kept while Gamekins is open.</span>
          </div>
        ) : (
          messages.map((m, i) => {
            const mine = m.from === 'me'
            const prev = messages[i - 1]
            const gap = !prev || m.at - prev.at > 5 * 60_000
            return (
              <div key={m.id}>
                {gap && <div className="fr-time">{new Date(m.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>}
                <div className={`fr-msg ${mine ? 'mine' : 'theirs'} ${prev && prev.from === m.from && !gap ? 'cont' : ''}`}>{m.text}</div>
              </div>
            )
          })
        )}
      </div>
      <form
        className="fr-compose"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {!canChat && (
          <div className="fr-compose-note">
            {state.myStatus === 'offline' ? 'You appear offline. Switch to Online or Away to chat.' : 'Connecting to chat…'}
          </div>
        )}
        {error && <div className="fr-compose-note err">{error}</div>}
        <div className="fr-compose-row">
          <textarea
            ref={box}
            rows={1}
            value={text}
            maxLength={2000}
            placeholder={`Message ${f.displayName}`}
            disabled={!canChat}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <button className="fr-send" title="Send (Enter)" disabled={!canChat || !text.trim()}>
            <SendHorizontal size={16} />
          </button>
        </div>
      </form>
    </div>
  )
}
