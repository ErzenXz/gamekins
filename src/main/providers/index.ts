import type { ProviderId, ProviderInfo } from '@shared/types'
import { EpicProvider } from './epic'
import { LocalProvider } from './local'
import type { GameProvider } from './types'

/** Every implemented provider. Add GOG / EA / Ubisoft here as they're written. */
export const localProvider = new LocalProvider()
export const providers: GameProvider[] = [new EpicProvider(), localProvider]

/** Shown in Settings so users can see what's coming. */
export const providerInfo: ProviderInfo[] = [
  { id: 'epic', name: 'Epic Games', available: true },
  { id: 'gog', name: 'GOG Galaxy', available: false },
  { id: 'ea', name: 'EA app', available: false },
  { id: 'ubisoft', name: 'Ubisoft Connect', available: false }
]

export function provider(id: ProviderId): GameProvider {
  const p = providers.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown provider ${id}`)
  return p
}
