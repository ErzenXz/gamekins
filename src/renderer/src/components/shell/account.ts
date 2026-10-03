import type { ProviderId } from '@shared/types'
import { useStore } from '../../store'

/** Ask before signing out; mentions downloads that will stop because their games leave the library. */
export function confirmSignOut(provider: ProviderId, name = 'Epic Games'): void {
  const s = useStore.getState()
  const live = s.jobs.filter((j) => j.gameKey.startsWith(`${provider}:`) && !['done', 'cancelled', 'error'].includes(j.state))
  const downloads = live.length
    ? `\n\n${live.length} download${live.length === 1 ? '' : 's'} in your queue will stop until you sign back in.`
    : ''
  s.setConfirm({
    title: `Sign out of ${name}?`,
    message: `Installed games stay on disk and reappear when you sign back in.${downloads}`,
    confirmLabel: 'Sign out',
    onConfirm: () => useStore.getState().signOut(provider)
  })
}
