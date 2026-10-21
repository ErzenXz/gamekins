import { create } from 'zustand'
import type { ChatMessage, SocialState } from '@shared/types'
import { STORE_DISTRIBUTION } from '../../../shared/distribution'
import { locallyRestricted, openProviderConversation, useSocialSafety } from './socialSafety'

/**
 * Friends & chat state, separate from the main store so presence churn (friends coming
 * online, typing) never re-renders the library.
 */
interface SocialStore {
  state: SocialState | null
  open: boolean
  /** Friend whose conversation is showing in the panel. */
  chatWith: string | null
  chats: Record<string, ChatMessage[]>
  setOpen(open: boolean): void
  toggle(): void
  openChat(friendId: string): Promise<void>
  closeChat(): void
  send(friendId: string, text: string): Promise<void>
}

const api = (): typeof window.gamekins.social => window.gamekins.social
let rawState: SocialState | null = null
export function visibleSocialState(state: SocialState): SocialState {
  return {
    ...state,
    friends: state.friends.filter((friend) => !locallyRestricted(friend.id)),
    requests: state.requests.filter((request) => !locallyRestricted(request.id)),
    unread: STORE_DISTRIBUTION ? {} : Object.fromEntries(Object.entries(state.unread).filter(([id]) => !locallyRestricted(id))),
    networks: state.networks?.map((network) => STORE_DISTRIBUTION ? { ...network, canChat: false } : network)
  }
}

export const useSocial = create<SocialStore>((set, get) => ({
  state: null,
  open: false,
  chatWith: null,
  chats: {},
  setOpen(open) {
    set({ open })
    const { chatWith } = get()
    if (!STORE_DISTRIBUTION && open && chatWith && !locallyRestricted(chatWith)) void api().markRead(chatWith).catch(() => undefined)
  },
  toggle() {
    get().setOpen(!get().open)
  },
  async openChat(friendId) {
    if (locallyRestricted(friendId)) return
    if (STORE_DISTRIBUTION) {
      set({ open: true, chatWith: null, chats: {} })
      await openProviderConversation(friendId)
      return
    }
    set({ open: true, chatWith: friendId })
    const history = await api().chat(friendId).catch(() => [] as ChatMessage[])
    // Ignore a late answer if the conversation was closed or the account changed meanwhile.
    if (get().chatWith !== friendId || locallyRestricted(friendId)) return
    set((s) => ({ chats: { ...s.chats, [friendId]: history } }))
    void api().markRead(friendId).catch(() => undefined)
  },
  closeChat() {
    set({ chatWith: null })
  },
  async send(friendId, text) {
    if (STORE_DISTRIBUTION) throw new Error('Chat is handled in the provider’s own client or game in the Microsoft Store edition.')
    if (locallyRestricted(friendId)) throw new Error('This account is hidden or blocked in Gamekins.')
    const message = await api().send(friendId, text)
    if (locallyRestricted(friendId)) return
    set((s) => ({ chats: { ...s.chats, [friendId]: [...(s.chats[friendId] ?? []), message] } }))
  }
}))

useSocialSafety.subscribe(() => {
  const previous = useSocial.getState()
  useSocial.setState({
    state: rawState ? visibleSocialState(rawState) : previous.state ? visibleSocialState(previous.state) : null,
    chats: Object.fromEntries(Object.entries(previous.chats).filter(([id]) => !locallyRestricted(id))),
    chatWith: previous.chatWith && !locallyRestricted(previous.chatWith) ? previous.chatWith : null
  })
})

let started = false

/** Load the current state and follow updates (once per window). */
export function startSocial(): void {
  if (started || !window.gamekins.social) return
  started = true
  void api()
    .state()
    .then((state) => { rawState = state; useSocial.setState({ state: visibleSocialState(state) }) })
    .catch(() => undefined)
  window.gamekins.on.social((state) => {
    rawState = state
    const prev = useSocial.getState()
    // A store signed out or switched accounts: its cached conversations aren't this account's.
    const owner = (s: SocialState | null): Map<string, string> => new Map((s?.networks ?? []).map((n) => [n.provider, n.me?.id ?? '']))
    const before = owner(prev.state)
    const after = owner(state)
    const stale = [...before].filter(([p, id]) => after.get(p) !== id).map(([p]) => p + ':')
    if (!stale.length) return useSocial.setState({ state: visibleSocialState(state) })
    const chats = Object.fromEntries(Object.entries(prev.chats).filter(([id]) => !locallyRestricted(id) && !stale.some((p) => id.startsWith(p))))
    const chatWith = prev.chatWith && stale.some((p) => prev.chatWith!.startsWith(p)) ? null : prev.chatWith
    useSocial.setState({ state: visibleSocialState(state), chats, chatWith })
  })
  window.gamekins.on.socialMessage(({ friendId, message }) => {
    if (STORE_DISTRIBUTION || locallyRestricted(friendId)) return
    const s = useSocial.getState()
    useSocial.setState({ chats: { ...s.chats, [friendId]: [...(s.chats[friendId] ?? []), message] } })
    // Reading it right now: don't count it as unread.
    if (s.open && s.chatWith === friendId && document.hasFocus()) void api().markRead(friendId).catch(() => undefined)
  })
}

/** Total unread messages, for badges. */
export const unreadTotal = (s: SocialState | null): number => STORE_DISTRIBUTION ? 0 : Object.entries(s?.unread ?? {}).reduce((sum, [id, count]) => sum + (locallyRestricted(id) ? 0 : count), 0)
