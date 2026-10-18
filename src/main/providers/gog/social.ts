// GOG friends, read-only: the friends list from GOG Galaxy's chat service and who is online
// from its presence service, polled every minute. GOG has no public chat or friend-request
// API we can rely on, so messaging and requests stay in GOG Galaxy.

import { EventEmitter } from 'node:events'
import type { ChatMessage, Friend, MyStatus, SocialState } from '@shared/types'
import type { SocialEvents, SocialNetworkProvider } from '../types'
import { type FriendEntry, GogApi, type PresenceEntry } from './api'

export interface GogSocialAuth {
  /** Galaxy user id. */
  accountId: string
  displayName: string
  token: string
}

export const POLL_MS = 60_000

/** Presence entry → what we show. Being listed at all means online in Galaxy. */
export function presenceStatus(p: PresenceEntry | undefined): { status: Friend['status']; activity?: string } {
  if (!p) return { status: 'offline' }
  const raw = String(p.presence ?? p.status ?? (p.data && (p.data.presence ?? p.data.status)) ?? '').toLowerCase()
  if (raw === 'offline' || raw === 'invisible') return { status: 'offline' }
  const data = p.data ?? {}
  const game = ['game_title', 'gameTitle', 'game_name', 'gameName', 'title'].map((k) => data[k]).find((v) => typeof v === 'string' && v.trim())
  if (typeof game === 'string') return { status: 'playing', activity: `Playing ${game.trim()}` }
  return { status: raw === 'away' || raw === 'idle' || raw === 'busy' ? 'away' : 'online' }
}

export class GogSocial extends EventEmitter<SocialEvents> implements SocialNetworkProvider {
  readonly provider = 'gog' as const
  readonly name = 'GOG'
  readonly canChat = false
  readonly canAddFriends = false
  private me: GogSocialAuth | null = null
  private friends = new Map<string, FriendEntry>()
  private presence = new Map<string, PresenceEntry>()
  private lastOnline = new Map<string, number>()
  private connection: SocialState['connection'] = 'off'
  private status: MyStatus = 'online'
  private loading = false
  private error: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private emitTimer: ReturnType<typeof setTimeout> | undefined
  private lastEmitted = ''
  private generation = 0
  private readonly api: GogApi

  constructor(private readonly auth: () => Promise<GogSocialAuth | null>, api?: GogApi) {
    super()
    this.api = api ?? new GogApi(async () => {
      const fresh = await this.auth()
      if (!fresh) throw new Error('Sign in to GOG to see your GOG friends')
      return fresh.token
    })
  }

  async start(status: MyStatus): Promise<void> {
    this.stop()
    const generation = ++this.generation
    this.status = status
    const me = await this.auth().catch(() => null)
    if (!me || generation !== this.generation) return
    this.me = me
    this.connection = 'connecting'
    await this.refresh()
    if (generation === this.generation) this.schedule()
  }

  stop(): void {
    this.generation++
    clearTimeout(this.timer)
    this.timer = undefined
    this.me = null
    this.friends.clear()
    this.presence.clear()
    this.lastOnline.clear()
    this.connection = 'off'
    this.error = undefined
    this.changed()
  }

  /** Read-only: we don't publish a presence of our own to GOG. */
  setStatus(status: MyStatus): void {
    if (status === this.status) return
    this.status = status
    this.changed()
  }

  setActivity(): void {
    /* GOG presence is not written from Gamekins */
  }

  state(): SocialState {
    const friends: Friend[] = [...this.friends.values()].map((f) => {
      const { status, activity } = presenceStatus(this.presence.get(f.user_id))
      return {
        id: f.user_id,
        displayName: f.username || 'GOG user',
        status,
        activity,
        lastOnline: this.lastOnline.get(f.user_id)
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
      requests: [],
      unread: {},
      loading: this.loading,
      error: this.error
    }
  }

  async refresh(): Promise<void> {
    const me = this.me
    if (!me) return
    this.loading = true
    this.changed()
    try {
      const list = await this.api.friends(me.accountId)
      if (me !== this.me) return
      this.friends = new Map(list.map((f) => [f.user_id, f]))
      await this.refreshPresence()
      this.error = undefined
      this.connection = 'online'
    } catch (err) {
      if (me !== this.me) return
      this.error = `Couldn't load your GOG friends: ${(err as Error).message}`
      this.connection = 'error'
    } finally {
      this.loading = false
      this.changed()
    }
  }

  private async refreshPresence(): Promise<void> {
    const ids = [...this.friends.keys()]
    const online = ids.length ? await this.api.statuses(ids).catch(() => null) : []
    if (!online) return // keep the last known presence on a failed poll
    const next = new Map(online.filter((p) => this.friends.has(p.user_id)).map((p) => [p.user_id, p]))
    const now = Date.now()
    for (const id of this.presence.keys()) if (!next.has(id)) this.lastOnline.set(id, now)
    this.presence = next
  }

  private schedule(): void {
    clearTimeout(this.timer)
    const generation = this.generation
    this.timer = setTimeout(async () => {
      if (generation !== this.generation) return
      await this.refresh()
      if (generation === this.generation) this.schedule()
    }, POLL_MS)
    this.timer.unref?.()
  }

  chat(): ChatMessage[] {
    return []
  }

  sendMessage(): ChatMessage {
    throw new Error('Chat with GOG friends in GOG Galaxy')
  }

  markRead(): void {}

  /** Coalesce bursts into one update, and skip polls that changed nothing. */
  private changed(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      const state = this.state()
      const signature = JSON.stringify(state)
      if (signature === this.lastEmitted) return
      this.lastEmitted = signature
      this.emit('changed', state)
    }, 120)
  }
}
