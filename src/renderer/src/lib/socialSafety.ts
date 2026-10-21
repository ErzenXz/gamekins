import { create } from 'zustand'
import type { StoreId } from '@shared/types'

export const COMMUNITY_URL = 'https://github.com/ErzenXz/gamekins/blob/release/cross-platform/docs/COMMUNITY.md'
export const PROVIDER_SAFETY: Record<StoreId, string> = {
  epic: 'https://safety.epicgames.com/policies/reporting-misconduct',
  steam: 'https://help.steampowered.com/en/faqs/view/4F8E-AE41-B6B1-F836',
  gog: 'https://support.gog.com/hc/en-us/requests/new'
}
const STORAGE_KEY = 'gamekins.social-safety.v1'
export type Restriction = 'hidden' | 'blocked' | 'removed'
export interface SafetyEntry { id: string; displayName: string; restriction: Restriction }
interface SafetyStore {
  entries: SafetyEntry[]
  restrict(id: string, displayName: string, restriction: Restriction): void
  restore(id: string): void
}
export const validSocialId = (id: string): boolean => /^(epic:[0-9a-f]{32}|steam:\d{1,20}|gog:\d{1,24})$/i.test(id)

/** Local display controls only: these never change a provider account or send reports. */
export function createSafetyStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
  let entries: SafetyEntry[] = []
  try {
    const saved: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(saved)) entries = saved.filter((entry): entry is SafetyEntry =>
      !!entry && typeof entry === 'object' && typeof entry.id === 'string' && validSocialId(entry.id) &&
      typeof entry.displayName === 'string' && entry.displayName.length <= 1024 &&
      ['hidden', 'blocked', 'removed'].includes(entry.restriction)).slice(0, 10000)
  } catch { /* A fresh profile or invalid saved entry has no local restrictions. */ }
  return create<SafetyStore>((set, get) => {
    const save = (next: SafetyEntry[]): void => {
      if (!storage) throw new Error('Local safety settings cannot be saved in this profile.')
      try { storage.setItem(STORAGE_KEY, JSON.stringify(next)) }
      catch { throw new Error('Could not save your local safety settings. Free some space or check this profile’s storage permissions.') }
      set({ entries: next })
    }
    return {
      entries,
      restrict(id, displayName, restriction) {
        if (!validSocialId(id) || !['hidden', 'blocked', 'removed'].includes(restriction)) throw new Error('Unknown friend')
        if (get().entries.length >= 10000 && !get().entries.some((entry) => entry.id === id)) throw new Error('The local safety list is full. Restore an entry before adding another restriction.')
        save([...get().entries.filter((entry) => entry.id !== id), { id, displayName: displayName.slice(0, 1024), restriction }])
      },
      restore(id) { save(get().entries.filter((entry) => entry.id !== id)) }
    }
  })
}
let storage: Storage | null = null
try { storage = globalThis.localStorage } catch { /* Saving will show a concrete error. */ }
export const useSocialSafety = createSafetyStore(storage)
export const locallyRestricted = (id: string): boolean => useSocialSafety.getState().entries.some((entry) => entry.id === id)

export function safetyReportUrl(id: string, displayName: string): string {
  if (!validSocialId(id)) throw new Error('Unknown friend')
  const body = `Gamekins safety report\nProvider account: ${id}\nDisplay name: ${displayName.slice(0, 1024)}\n\nDescribe what happened, when, and where. Add evidence only if you choose.\nPlease do not include passwords, sign-in codes, or access tokens.\n\n`
  return `mailto:erzen@quad-labs.com?subject=${encodeURIComponent('Gamekins safety report')}&body=${encodeURIComponent(body)}`
}

/** Epic has no supported external chat URI. Use its official help, never invent a URI. */
export async function openProviderConversation(id: string): Promise<void> {
  if (!validSocialId(id)) throw new Error('Unknown friend')
  const provider = id.split(':')[0].toLowerCase() as StoreId
  if (provider === 'steam') await window.gamekins.social.openExternal(id, 'chat')
  else if (provider === 'gog') await window.gamekins.social.openExternal(id, 'profile')
  else await window.gamekins.app.openExternal(PROVIDER_SAFETY.epic)
}
