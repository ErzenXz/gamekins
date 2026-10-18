// Epic friends, presence and chat, like the official launcher: the friends service (REST)
// for the list and requests, and Epic's XMPP service for live presence and messages.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, Friend, FriendRequest, MyStatus, SocialState } from '@shared/types'
import type { SocialEvents, SocialNetworkProvider } from '../types'
import { fetchRetry, USER_AGENT } from './api'
import { child, escapeXml, XMPP_DOMAIN, XmppConnection, type XmlNode } from './xmpp'

const FRIENDS = 'https://friends-public-service-prod.ol.epicgames.com/friends/api/v1'
const ACCOUNTS = 'https://account-public-service-prod.ol.epicgames.com/account/api/public/account'
const PRESENCE = 'https://presence-public-service-prod.ol.epicgames.com/presence/api/v1/_'
const MAX_CHAT = 200
const MAX_MESSAGE = 2000

export interface SocialAuth {
  accountId: string
  displayName: string
  token: string
}

interface Live {
  show: 'online' | 'away'
  activity?: string
  app?: string
  playing: boolean
}

interface SummaryEntry {
  accountId: string
  favorite?: boolean
  created?: string
}

/** App names from presence resources ("V2:Fortnite:WIN::…" → "Fortnite"). */
function appFromResource(resource: string | undefined): string | undefined {
  const parts = resource?.split(':') ?? []
  const app = parts[0] === 'V2' ? parts[1] : parts[0]
  if (!app || /^launcher$/i.test(app)) return undefined
  return app === 'Fortnite' ? 'Fortnite' : app
}

export class EpicSocial extends EventEmitter<SocialEvents> implements SocialNetworkProvider {
  readonly provider = 'epic' as const
  readonly name = 'Epic Games'
  readonly canChat = true
  readonly canAddFriends = true
  private me: SocialAuth | null = null
  private friends = new Map<string, SummaryEntry>()
  private requests: FriendRequest[] = []
  private names = new Map<string, string>()
  private live = new Map<string, Map<string, Live>>() // friend → resource → presence
  private lastOnline = new Map<string, number>()
  private chats = new Map<string, ChatMessage[]>()
  private unread: Record<string, number> = {}
  private xmpp: XmppConnection | null = null
  private connection: SocialState['connection'] = 'off'
  private status: MyStatus = 'online'
  private activity: string | null = null
  private loading = false
  private error: string | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private retryDelay = 2000
  private emitTimer: ReturnType<typeof setTimeout> | undefined
  private refetchTimer: ReturnType<typeof setTimeout> | undefined
  private generation = 0

  constructor(private readonly auth: () => Promise<SocialAuth | null>) {
    super()
  }

  // ───────── lifecycle ─────────

  /** Signed in (or the app started signed in): load friends and go live. */
  async start(status: MyStatus): Promise<void> {
    this.stop()
    const generation = ++this.generation
    this.status = status
    const me = await this.auth().catch(() => null)
    if (!me || generation !== this.generation) return
    this.me = me
    this.names.set(me.accountId, me.displayName)
    await this.refresh()
    if (generation === this.generation && this.status !== 'offline') this.connect()
  }

  /** Signed out or quitting. */
  stop(): void {
    this.generation++
    clearTimeout(this.retry)
    clearTimeout(this.refetchTimer)
    this.xmpp?.close()
    this.xmpp = null
    this.me = null
    this.friends.clear()
    this.requests = []
    this.live.clear()
    this.lastOnline.clear()
    this.chats.clear()
    this.unread = {}
    this.connection = 'off'
    this.error = undefined
    this.changed()
  }

  setStatus(status: MyStatus): void {
    if (status === this.status) return
    this.status = status
    if (!this.me) return
    if (status === 'offline') {
      // Appear offline: leave the presence network entirely.
      clearTimeout(this.retry)
      this.xmpp?.close()
      this.xmpp = null
      this.live.clear()
      this.connection = 'off'
      void this.loadLastOnline()
    } else if (this.xmpp?.ready) this.sendPresence()
    else this.connect()
    this.changed()
  }

  /** The game being played through Gamekins (shown to friends), or null. */
  setActivity(title: string | null): void {
    if (title === this.activity) return
    this.activity = title
    if (this.xmpp?.ready) this.sendPresence()
  }

  // ───────── state for the UI ─────────

  state(): SocialState {
    const friends: Friend[] = [...this.friends.values()].map((f) => {
      const sessions = [...(this.live.get(f.accountId)?.values() ?? [])]
      const best = sessions.find((s) => s.playing) ?? sessions.find((s) => s.show === 'online') ?? sessions[0]
      return {
        id: f.accountId,
        displayName: this.names.get(f.accountId) ?? 'Epic player',
        status: !best ? 'offline' : best.playing ? 'playing' : best.show,
        activity: best?.activity,
        app: best?.app,
        lastOnline: this.lastOnline.get(f.accountId),
        favorite: f.favorite,
        since: f.created ? Date.parse(f.created) : undefined
      }
    })
    const rank = { playing: 0, online: 1, away: 2, offline: 3 } as const
    friends.sort((a, b) => rank[a.status] - rank[b.status] || a.displayName.localeCompare(b.displayName))
    return {
      available: !!this.me,
      connection: this.connection,
      me: this.me ? { id: this.me.accountId, displayName: this.me.displayName } : undefined,
      myStatus: this.status,
      friends,
      requests: this.requests.map((r) => ({ ...r, displayName: this.names.get(r.id) ?? r.displayName })),
      unread: { ...this.unread },
      loading: this.loading,
      error: this.error
    }
  }

  chat(friendId: string): ChatMessage[] {
    return this.chats.get(friendId) ?? []
  }

  markRead(friendId: string): void {
    if (!this.unread[friendId]) return
    delete this.unread[friendId]
    this.changed()
  }

  // ───────── friends (REST) ─────────

  async refresh(): Promise<void> {
    const me = this.me
    if (!me) return
    this.loading = true
    this.changed()
    try {
      const summary = await this.get<{ friends: SummaryEntry[]; incoming: SummaryEntry[]; outgoing: SummaryEntry[] }>(
        `${FRIENDS}/${me.accountId}/summary`
      )
      if (me !== this.me) return
      this.friends = new Map(summary.friends.map((f) => [f.accountId, f]))
      this.requests = [
        ...summary.incoming.map((r) => ({ id: r.accountId, displayName: '', direction: 'incoming' as const, at: r.created ? Date.parse(r.created) : undefined })),
        ...summary.outgoing.map((r) => ({ id: r.accountId, displayName: '', direction: 'outgoing' as const, at: r.created ? Date.parse(r.created) : undefined }))
      ]
      await this.loadNames([...this.friends.keys(), ...this.requests.map((r) => r.id)])
      this.error = undefined
      void this.loadLastOnline()
    } catch (err) {
      this.error = `Couldn't load your friends: ${(err as Error).message}`
    } finally {
      this.loading = false
      this.changed()
    }
  }

  /** Send a request by Epic display name (or accept theirs if they already asked). */
  async addFriend(displayName: string): Promise<string> {
    const me = this.requireMe()
    const name = displayName.trim()
    if (!name || name.length > 64) throw new Error('Enter an Epic display name')
    let target: { id: string; displayName: string }
    try {
      target = await this.get(`${ACCOUNTS}/displayName/${encodeURIComponent(name)}`)
    } catch (err) {
      if ((err as { status?: number }).status === 404) throw new Error(`No Epic account is called "${name}"`)
      throw err
    }
    if (target.id === me.accountId) throw new Error("That's you!")
    if (this.friends.has(target.id)) throw new Error(`${target.displayName} is already your friend`)
    this.names.set(target.id, target.displayName)
    await this.call('POST', `${FRIENDS}/${me.accountId}/friends/${target.id}`)
    await this.refresh()
    return target.displayName
  }

  async accept(friendId: string): Promise<void> {
    const me = this.requireMe()
    await this.call('POST', `${FRIENDS}/${me.accountId}/friends/${encodeURIComponent(friendId)}`)
    await this.refresh()
  }

  /** Decline an incoming request, cancel an outgoing one, or remove a friend. */
  async remove(friendId: string): Promise<void> {
    const me = this.requireMe()
    await this.call('DELETE', `${FRIENDS}/${me.accountId}/friends/${encodeURIComponent(friendId)}`)
    this.live.delete(friendId)
    await this.refresh()
  }

  // ───────── chat ─────────

  sendMessage(friendId: string, text: string): ChatMessage {
    this.requireMe()
    const body = text.trim().slice(0, MAX_MESSAGE)
    if (!body) throw new Error('Message is empty')
    if (!this.friends.has(friendId)) throw new Error('You can only message friends')
    if (!this.xmpp?.ready) throw new Error(this.status === 'offline' ? 'You appear offline. Go online to chat.' : 'Chat is reconnecting. Try again in a moment.')
    this.xmpp.send(`<message type="chat" to="${escapeXml(friendId)}@${XMPP_DOMAIN}" id="${randomUUID()}"><body>${escapeXml(body)}</body></message>`)
    const message: ChatMessage = { id: randomUUID(), from: 'me', text: body, at: Date.now() }
    this.push(friendId, message)
    return message
  }

  // ───────── internals ─────────

  private connect(): void {
    if (!this.me || this.status === 'offline') return
    clearTimeout(this.retry)
    this.xmpp?.close()
    const generation = this.generation
    this.connection = 'connecting'
    this.changed()
    void this.auth()
      .then((fresh) => {
        if (!fresh || generation !== this.generation || this.status === 'offline') return
        const conn = new XmppConnection(fresh.accountId, fresh.token)
        this.xmpp = conn
        conn.on('online', () => {
          if (conn !== this.xmpp) return
          this.connection = 'online'
          this.retryDelay = 2000
          this.error = undefined
          this.sendPresence()
          this.changed()
        })
        conn.on('presence', (n) => conn === this.xmpp && this.onPresence(n))
        conn.on('message', (n) => conn === this.xmpp && this.onMessage(n))
        conn.on('closed', (err) => {
          if (conn !== this.xmpp) return
          this.xmpp = null
          this.live.clear()
          if (!err || generation !== this.generation || this.status === 'offline') {
            this.connection = 'off'
          } else {
            this.connection = 'error'
            this.retry = setTimeout(() => this.connect(), this.retryDelay)
            this.retryDelay = Math.min(60_000, this.retryDelay * 2)
          }
          this.changed()
        })
        conn.connect()
      })
      .catch(() => {
        if (generation !== this.generation || !this.me || this.status === 'offline') return
        this.connection = 'error'
        this.retry = setTimeout(() => this.connect(), this.retryDelay)
        this.retryDelay = Math.min(60_000, this.retryDelay * 2)
        this.changed()
      })
  }

  private sendPresence(): void {
    const playing = !!this.activity
    const status = JSON.stringify({
      Status: playing ? `Playing ${this.activity}` : '',
      bIsPlaying: playing,
      bIsJoinable: false,
      bHasVoiceSupport: false,
      SessionId: '',
      ProductName: playing ? this.activity : '',
      Properties: {}
    })
    const show = this.status === 'away' ? '<show>away</show>' : ''
    this.xmpp?.send(`<presence>${show}<status>${escapeXml(status)}</status></presence>`)
  }

  private onPresence(n: XmlNode): void {
    const [bare, resource = ''] = (n.attrs.from ?? '').split('/')
    const id = bare.split('@')[0]
    if (!id || id === this.me?.accountId || !this.friends.has(id)) return
    const sessions = this.live.get(id) ?? new Map<string, Live>()
    if (n.attrs.type === 'unavailable') {
      sessions.delete(resource)
      this.lastOnline.set(id, Date.now())
    } else {
      let status: { Status?: string; bIsPlaying?: boolean; ProductName?: string } = {}
      try {
        status = JSON.parse(child(n, 'status')?.text || '{}')
      } catch {
        /* plain-text status */
      }
      const show = child(n, 'show')?.text
      const app = status.ProductName || appFromResource(resource)
      sessions.set(resource, {
        show: show === 'away' || show === 'xa' || show === 'dnd' ? 'away' : 'online',
        activity: status.Status?.trim() || (status.bIsPlaying && app ? `Playing ${app}` : undefined),
        app,
        playing: !!status.bIsPlaying || (!!app && !!status.Status)
      })
    }
    if (sessions.size) this.live.set(id, sessions)
    else this.live.delete(id)
    this.changed()
  }

  private onMessage(n: XmlNode): void {
    const body = child(n, 'body')?.text ?? ''
    const from = (n.attrs.from ?? '').split('/')[0]
    // Friend list changes arrive as JSON notices from the service account.
    if (from.startsWith('xmpp-admin@')) {
      if (/friend/i.test(body)) {
        clearTimeout(this.refetchTimer)
        this.refetchTimer = setTimeout(() => void this.refresh(), 800)
      }
      return
    }
    if (n.attrs.type !== 'chat' || !body.trim()) return
    const id = from.split('@')[0]
    if (!this.friends.has(id)) return
    const message: ChatMessage = { id: n.attrs.id || randomUUID(), from: id, text: body.slice(0, MAX_MESSAGE), at: Date.now() }
    this.unread[id] = (this.unread[id] ?? 0) + 1
    this.push(id, message)
    this.emit('message', { friendId: id, message })
  }

  private push(friendId: string, message: ChatMessage): void {
    const list = this.chats.get(friendId) ?? []
    list.push(message)
    if (list.length > MAX_CHAT) list.splice(0, list.length - MAX_CHAT)
    this.chats.set(friendId, list)
    this.changed()
  }

  private async loadNames(ids: string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.names.has(id))
    for (let i = 0; i < missing.length; i += 100) {
      const url = new URL(ACCOUNTS)
      for (const id of missing.slice(i, i + 100)) url.searchParams.append('accountId', id)
      const accounts = await this.get<{ id: string; displayName?: string; externalAuths?: Record<string, { externalDisplayName?: string }> }[]>(url.toString()).catch(() => [])
      for (const a of accounts) {
        const external = Object.values(a.externalAuths ?? {}).find((x) => x.externalDisplayName)?.externalDisplayName
        this.names.set(a.id, a.displayName || external || 'Epic player')
      }
    }
  }

  private async loadLastOnline(): Promise<void> {
    const me = this.me
    if (!me) return
    try {
      const data = await this.get<Record<string, { last_online?: string }[]>>(`${PRESENCE}/${me.accountId}/last-online`)
      if (me !== this.me) return
      for (const [id, list] of Object.entries(data)) {
        const at = Date.parse(list?.[0]?.last_online ?? '')
        if (Number.isFinite(at)) this.lastOnline.set(id, at)
      }
      this.changed()
    } catch {
      /* optional */
    }
  }

  private requireMe(): SocialAuth {
    if (!this.me) throw new Error('Sign in to Epic Games to use friends')
    return this.me
  }

  private async get<T>(url: string): Promise<T> {
    return (await this.call('GET', url)) as T
  }

  private async call(method: string, url: string): Promise<unknown> {
    const fresh = await this.auth()
    if (!fresh) throw new Error('Sign in to Epic Games to use friends')
    const res = await fetchRetry(url, {
      method,
      headers: { Authorization: `bearer ${fresh.token}`, 'User-Agent': USER_AGENT }
    }, method === 'GET' ? 3 : 1)
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { errorMessage?: string }
        detail = body.errorMessage ?? ''
      } catch {
        /* not json */
      }
      throw Object.assign(new Error(detail || `Epic returned ${res.status}`), { status: res.status })
    }
    return res.status === 204 ? undefined : res.json().catch(() => undefined)
  }

  /** Coalesce bursts (presence floods on connect) into one UI update. */
  private changed(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.emit('changed', this.state())
    }, 120)
  }
}
