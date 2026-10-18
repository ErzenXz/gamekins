import { create } from 'zustand'
import type { ChatMessage, SocialState } from '@shared/types'

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

export const useSocial = create<SocialStore>((set, get) => ({
  state: null,
  open: false,
  chatWith: null,
  chats: {},
  setOpen(open) {
    set({ open })
    const { chatWith } = get()
    if (open && chatWith) void api().markRead(chatWith).catch(() => undefined)
  },
  toggle() {
    get().setOpen(!get().open)
  },
  async openChat(friendId) {
    set({ open: true, chatWith: friendId })
    const history = await api().chat(friendId).catch(() => [] as ChatMessage[])
    // Ignore a late answer if the conversation was closed or the account changed meanwhile.
    if (get().chatWith !== friendId) return
    set((s) => ({ chats: { ...s.chats, [friendId]: history } }))
    void api().markRead(friendId).catch(() => undefined)
  },
  closeChat() {
    set({ chatWith: null })
  },
  async send(friendId, text) {
    const message = await api().send(friendId, text)
    set((s) => ({ chats: { ...s.chats, [friendId]: [...(s.chats[friendId] ?? []), message] } }))
  }
}))

let started = false

/** Load the current state and follow updates (once per window). */
export function startSocial(): void {
  if (started || !window.gamekins.social) return
  started = true
  void api()
    .state()
    .then((state) => useSocial.setState({ state }))
    .catch(() => undefined)
  window.gamekins.on.social((state) => {
    const prev = useSocial.getState()
    // A store signed out or switched accounts: its cached conversations aren't this account's.
    const owner = (s: SocialState | null): Map<string, string> => new Map((s?.networks ?? []).map((n) => [n.provider, n.me?.id ?? '']))
    const before = owner(prev.state)
    const after = owner(state)
    const stale = [...before].filter(([p, id]) => after.get(p) !== id).map(([p]) => p + ':')
    if (!stale.length) return useSocial.setState({ state })
    const chats = Object.fromEntries(Object.entries(prev.chats).filter(([id]) => !stale.some((p) => id.startsWith(p))))
    const chatWith = prev.chatWith && stale.some((p) => prev.chatWith!.startsWith(p)) ? null : prev.chatWith
    useSocial.setState({ state, chats, chatWith })
  })
  window.gamekins.on.socialMessage(({ friendId, message }) => {
    const s = useSocial.getState()
    useSocial.setState({ chats: { ...s.chats, [friendId]: [...(s.chats[friendId] ?? []), message] } })
    // Reading it right now: don't count it as unread.
    if (s.open && s.chatWith === friendId && document.hasFocus()) void api().markRead(friendId).catch(() => undefined)
  })
}

/** Total unread messages, for badges. */
export const unreadTotal = (s: SocialState | null): number => Object.values(s?.unread ?? {}).reduce((a, b) => a + b, 0)
