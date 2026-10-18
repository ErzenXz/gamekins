// One friends list across stores: merges every connected network (Epic, Steam, GOG) into a
// single SocialState with ids prefixed by store ("steam:7656…"), and routes actions back to
// the network that owns the friend.

import { EventEmitter } from 'node:events'
import type { ChatMessage, MyStatus, SocialNetwork, SocialState, StoreId } from '@shared/types'
import type { SocialNetworkProvider } from '../providers/types'

interface HubEvents {
  changed: [SocialState]
  message: [{ friendId: string; message: ChatMessage }]
}

const split = (id: string): [StoreId, string] => {
  const i = id.indexOf(':')
  return [id.slice(0, i) as StoreId, id.slice(i + 1)]
}

export class SocialHub extends EventEmitter<HubEvents> {
  private readonly networks = new Map<StoreId, SocialNetworkProvider>()
  private readonly started = new Set<StoreId>()
  private status: MyStatus = 'online'
  private activity: string | null = null
  private emitTimer: ReturnType<typeof setTimeout> | undefined

  register(network: SocialNetworkProvider): void {
    this.networks.set(network.provider, network)
    network.on('changed', () => this.changed())
    network.on('message', ({ friendId, message }) => {
      const id = `${network.provider}:${friendId}`
      this.emit('message', { friendId: id, message: message.from === 'me' ? message : { ...message, from: id } })
    })
  }

  /** A store was signed in to (or the app started signed in). */
  async start(provider: StoreId): Promise<void> {
    const network = this.networks.get(provider)
    if (!network) return
    this.started.add(provider)
    await network.start(this.status)
    network.setActivity(this.activity)
  }

  /** A store was signed out of. */
  stop(provider: StoreId): void {
    this.started.delete(provider)
    this.networks.get(provider)?.stop()
    this.changed()
  }

  stopAll(): void {
    for (const p of [...this.started]) this.stop(p)
  }

  setStatus(status: MyStatus): void {
    this.status = status
    for (const p of this.started) this.networks.get(p)?.setStatus(status)
  }

  setActivity(title: string | null): void {
    if (title === this.activity) return
    this.activity = title
    for (const p of this.started) this.networks.get(p)?.setActivity(title)
  }

  state(): SocialState {
    const parts = [...this.started].flatMap((p) => {
      const network = this.networks.get(p)
      return network ? [{ network, state: network.state() }] : []
    })
    const live = parts.filter((x) => x.state.available)
    const networks: SocialNetwork[] = live.map(({ network, state }) => ({
      provider: network.provider,
      name: network.name,
      connection: state.connection,
      me: state.me,
      canChat: network.canChat,
      canAddFriends: network.canAddFriends,
      error: state.error
    }))
    const friends = live.flatMap(({ network, state }) =>
      state.friends.map((f) => ({ ...f, id: `${network.provider}:${f.id}`, accountId: f.id, provider: network.provider }))
    )
    const rank = { playing: 0, online: 1, away: 2, offline: 3 } as const
    friends.sort((a, b) => rank[a.status] - rank[b.status] || a.displayName.localeCompare(b.displayName))
    const unread: Record<string, number> = {}
    for (const { network, state } of live) for (const [id, n] of Object.entries(state.unread)) unread[`${network.provider}:${id}`] = n
    const primary = live.find((x) => x.network.canChat) ?? live[0]
    const order = ['online', 'connecting', 'error', 'off'] as const
    return {
      available: live.length > 0,
      networks,
      connection: networks.map((n) => n.connection).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? 'off',
      me: primary?.state.me,
      myStatus: this.status,
      friends,
      requests: live.flatMap(({ network, state }) =>
        state.requests.map((r) => ({ ...r, id: `${network.provider}:${r.id}`, accountId: r.id, provider: network.provider }))
      ),
      unread,
      loading: live.some((x) => x.state.loading),
      error: live.map((x) => x.state.error).find(Boolean)
    }
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.started].map((p) => this.networks.get(p)?.refresh().catch(() => undefined)))
  }

  chat(id: string): ChatMessage[] {
    const [p, accountId] = split(id)
    return this.net(p).chat(accountId).map((m) => (m.from === 'me' ? m : { ...m, from: id }))
  }

  sendMessage(id: string, text: string): ChatMessage {
    const [p, accountId] = split(id)
    const network = this.net(p)
    if (!network.canChat) throw new Error(`Chat with ${network.name} friends in the ${network.name} app`)
    return network.sendMessage(accountId, text)
  }

  markRead(id: string): void {
    const [p, accountId] = split(id)
    this.networks.get(p)?.markRead(accountId)
  }

  async addFriend(provider: StoreId, displayName: string): Promise<string> {
    const network = this.net(provider)
    if (!network.addFriend || !network.canAddFriends) throw new Error(`Add ${network.name} friends in the ${network.name} app`)
    return network.addFriend(displayName)
  }

  async accept(id: string): Promise<void> {
    const [p, accountId] = split(id)
    const network = this.net(p)
    if (!network.accept) throw new Error(`Accept ${network.name} requests in the ${network.name} app`)
    await network.accept(accountId)
  }

  async remove(id: string): Promise<void> {
    const [p, accountId] = split(id)
    const network = this.net(p)
    if (!network.remove) throw new Error(`Manage ${network.name} friends in the ${network.name} app`)
    await network.remove(accountId)
  }

  /**
   * Where to chat with / view a friend outside Gamekins. Built here from validated ids, never
   * from renderer-supplied URLs.
   */
  externalLink(id: string, kind: 'chat' | 'profile'): string | null {
    const [p, accountId] = split(id)
    const friend = this.state().friends.find((f) => f.id === id)
    if (p === 'steam' && /^\d{1,20}$/.test(accountId)) {
      return kind === 'chat' ? `steam://friends/message/${accountId}` : `https://steamcommunity.com/profiles/${accountId}`
    }
    if (p === 'gog' && kind === 'profile' && friend) return `https://www.gog.com/u/${encodeURIComponent(friend.displayName)}`
    return null
  }

  private net(provider: StoreId): SocialNetworkProvider {
    const network = this.started.has(provider) ? this.networks.get(provider) : undefined
    if (!network) throw new Error('That store is not signed in')
    return network
  }

  private changed(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.emit('changed', this.state())
    }, 100)
  }
}
