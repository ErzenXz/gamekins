import type { ProviderId, ProviderInfo } from '@shared/types'
import { EpicProvider } from './epic'
import { GogProvider } from './gog'
import { LocalProvider } from './local'
import { SteamProvider } from './steam'
import type { GameProvider } from './types'

/** Every implemented provider. Add GOG / EA / Ubisoft here as they're written. */
export const localProvider = new LocalProvider()
export const gogProvider = new GogProvider()
export const steamProvider = new SteamProvider()
export const providers: GameProvider[] = [new EpicProvider(), steamProvider, gogProvider, localProvider]

/** Shown in Settings so users can see what's coming. */
export const providerInfo: ProviderInfo[] = [
  { id: 'epic', name: 'Epic Games', available: true },
  { id: 'steam', name: 'Steam', available: true },
  { id: 'gog', name: 'GOG', available: true },
  { id: 'ea', name: 'EA app', available: false },
  { id: 'ubisoft', name: 'Ubisoft Connect', available: false }
]

export function provider(id: ProviderId): GameProvider {
  const p = providers.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown provider ${id}`)
  return p
}
