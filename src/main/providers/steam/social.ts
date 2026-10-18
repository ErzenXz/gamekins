// Steam friends: the friends list and presence from the Web API, polled once a minute.
// Steam's chat and presence run over the client's own connection, so Gamekins can show
// friends and what they play but can't chat, change your Steam status or send requests.

import { EventEmitter } from 'node:events'
import type { ChatMessage, Friend, FriendRequest, MyStatus, SocialState } from '@shared/types'
import type { SocialEvents, SocialNetworkProvider } from '../types'
import { type FriendsListEntry, getFriendsList, getPersonas, isAuthError, type Persona, personaPresence } from './api'

export interface SteamSocialAuth {
  steamId: string
  displayName: string
  token: string
}

/** `forceRefresh`: the last token was rejected, get a new one (or null if the session is gone). */
export type SteamSocialAuthSource = (opts?: { forceRefresh?: boolean }) => Promise<SteamSocialAuth | null>

const POLL_MS = 60_000
const REL_FRIEND = 3
const REL_REQUEST_RECIPIENT = 2
const REL_REQUEST_INITIATOR = 4

/** A friend's row from their persona (pure; exported for tests). */
export function steamFriend(id: string, persona: Persona | undefined): Friend {
  const presence = persona ? personaPresence(persona) : { status: 'offline' as const }
  return {
    id,
    displayName: persona?.name?.trim() || 'Steam player',
    ...presence,
    lastOnline: persona?.lastLogoff ? persona.lastLogoff * 1000 : undefined
  }
}

/** Split the friends list into friends and pending requests (pure; exported for tests). */
export function splitRelationships(list: FriendsListEntry[]): { friends: string[]; requests: { id: string; direction: FriendRequest['direction'] }[] } {
  const friends: string[] = []
  const requests: { id: string; direction: FriendRequest['direction'] }[] = []
  for (const f of list) {
    const id = String(f.ulfriendid)
    if (f.efriendrelationship === REL_FRIEND) friends.push(id)
    else if (f.efriendrelationship === REL_REQUEST_RECIPIENT) requests.push({ id, direction: 'incoming' })
    else if (f.efriendrelationship === REL_REQUEST_INITIATOR) requests.push({ id, direction: 'outgoing' })
  }
  return { friends, requests }
}

export class SteamSocial extends EventEmitter<SocialEvents> implements SocialNetworkProvider {
  readonly provider = 'steam' as const
  readonly name = 'Steam'
  readonly canChat = false
  readonly canAddFriends = false
  private me: SteamSocialAuth | null = null
  private friendIds: string[] = []
  private requestIds: { id: string; direction: FriendRequest['direction'] }[] = []
  private personas = new Map<string, Persona>()
  private connection: SocialState['connection'] = 'off'
  private status: MyStatus = 'online'
  private loading = false
  private error: string | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private emitTimer: ReturnType<typeof setTimeout> | undefined
  private refreshing: Promise<void> | null = null
  private generation = 0

  constructor(private readonly auth: SteamSocialAuthSource) {
    super()
  }

  // ───────── lifecycle ─────────

  async start(status: MyStatus): Promise<void> {
    this.stop()
    const generation = ++this.generation
    this.status = status
    const me = await this.auth().catch(() => null)
    if (!me || generation !== this.generation) return
    this.me = me
    this.connection = 'connecting'
    this.changed()
    await this.refresh()
  }

  stop(): void {
    this.generation++
    clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    this.refreshing = null
    this.me = null
    this.friendIds = []
    this.requestIds = []
    this.personas.clear()
    this.connection = 'off'
    this.loading = false
    this.error = undefined
    this.changed()
  }

  /** Steam presence is set by the Steam client; Gamekins only remembers the choice for the UI. */
  setStatus(status: MyStatus): void {
    if (status === this.status) return
    this.status = status
    this.changed()
  }

  /** Steam shows what you play from the client itself; nothing to send. */
  setActivity(_title: string | null): void {}

  // ───────── state for the UI ─────────

  state(): SocialState {
    const friends = this.friendIds.map((id) => steamFriend(id, this.personas.get(id)))
    const rank = { playing: 0, online: 1, away: 2, offline: 3 } as const
    friends.sort((a, b) => rank[a.status] - rank[b.status] || a.displayName.localeCompare(b.displayName))
    const me = this.me
    return {
      available: !!me,
      connection: this.connection,
      me: me ? { id: me.steamId, displayName: this.personas.get(me.steamId)?.name || me.displayName } : undefined,
      myStatus: this.status,
      friends,
      requests: this.requestIds.map((r) => ({ id: r.id, direction: r.direction, displayName: this.personas.get(r.id)?.name || 'Steam player' })),
      unread: {},
      loading: this.loading,
      error: this.error
    }
  }

  chat(_friendId: string): ChatMessage[] {
    return []
  }

  sendMessage(_friendId: string, _text: string): ChatMessage {
    throw new Error('Chat with Steam friends in the Steam client')
  }

  markRead(_friendId: string): void {}

  // ───────── polling ─────────

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    const work: Promise<void> = this.load().finally(() => { if (this.refreshing === work) this.refreshing = null })
    this.refreshing = work
    return work
  }

  private async load(): Promise<void> {
    const generation = this.generation
    if (!this.me) return
    clearTimeout(this.pollTimer)
    this.loading = true
    this.changed()
    try {
      let auth = await this.auth()
      if (!auth) throw new Error('Sign in to Steam to see your friends')
      let result: { list: FriendsListEntry[]; personas: Map<string, Persona> }
      try {
        result = await this.fetchAll(auth.token, auth.steamId)
      } catch (err) {
        if (!isAuthError(err)) throw err
        // Token rejected before its expiry (revoked or rotated): one retry with a fresh one.
        auth = await this.auth({ forceRefresh: true })
        if (!auth) throw new Error('Your Steam session expired. Sign in again to see your friends.')
        result = await this.fetchAll(auth.token, auth.steamId)
      }
      if (generation !== this.generation) return
      const { friends, requests } = splitRelationships(result.list)
      this.me = auth
      this.friendIds = friends
      this.requestIds = requests
      this.personas = result.personas
      this.connection = 'online'
      this.error = undefined
    } catch (err) {
      if (generation !== this.generation) return
      this.connection = 'error'
      this.error = `Couldn't load your Steam friends: ${(err as Error).message}`
    } finally {
      if (generation === this.generation) {
        this.loading = false
        this.changed()
        if (this.me) {
          this.pollTimer = setTimeout(() => void this.refresh(), POLL_MS)
          this.pollTimer.unref?.()
        }
      }
    }
  }

  private async fetchAll(token: string, steamId: string): Promise<{ list: FriendsListEntry[]; personas: Map<string, Persona> }> {
    const list = await getFriendsList(token)
    const ids = [steamId, ...list.filter((f) => [REL_FRIEND, REL_REQUEST_RECIPIENT, REL_REQUEST_INITIATOR].includes(f.efriendrelationship)).map((f) => String(f.ulfriendid))]
    const personas = await getPersonas(token, ids)
    return { list, personas }
  }

  /** Coalesce bursts into one UI update. */
  private changed(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.emit('changed', this.state())
    }, 120)
  }
}
