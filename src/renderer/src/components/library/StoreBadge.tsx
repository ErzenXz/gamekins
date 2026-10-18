import type { ProviderId } from '@shared/types'

export const STORE_NAMES: Record<ProviderId, string> = { epic: 'Epic Games', steam: 'Steam', gog: 'GOG', local: 'Non-store game' }

/** Tiny store mark: shows which launcher a game or friend comes from. */
export function StoreBadge({ store, size = 16, title }: { store: ProviderId; size?: number; title?: string }): React.JSX.Element {
  return (
    <span className={`store-badge ${store}`} style={{ width: size, height: size }} title={title ?? STORE_NAMES[store]} aria-label={STORE_NAMES[store]}>
      <svg viewBox="0 0 16 16" width={size * 0.68} height={size * 0.68} aria-hidden>
        {store === 'epic' && (
          // Shield with a bold E: readable down to 12px.
          <path d="M3 1.5h10v10.2L8 14.5l-5-2.8zM5.6 4v6.2l2.4 1.3 2.4-1.3V9H7.6V7.7h2.2V6.4H7.6V5.3h2.8V4z" fill="currentColor" fillRule="evenodd" />
        )}
        {store === 'steam' && (
          <path
            d="M8 1.5a6.5 6.5 0 0 0-6.47 5.94l3.48 1.44a1.8 1.8 0 0 1 1.04-.31l1.55-2.25v-.03a2.45 2.45 0 1 1 2.45 2.45h-.06L7.78 10.3v.07a1.85 1.85 0 0 1-3.66.37L1.64 9.72A6.5 6.5 0 1 0 8 1.5zm-3.1 9.37l-.8-.33a1.38 1.38 0 1 0 .76-1.86l.82.34a1.02 1.02 0 1 1-.78 1.85zm6.1-4.47a1.63 1.63 0 1 0-1.63 1.63A1.63 1.63 0 0 0 11 6.4zm-2.85 0a1.22 1.22 0 1 1 1.22 1.22A1.22 1.22 0 0 1 8.15 6.4z"
            fill="currentColor"
          />
        )}
        {store === 'gog' && (
          <path
            d="M2 3h12v10H2zm2.2 2.2v2.6h2.1v.9H4.2V10h3.2V5.2zm1 1h1.1v.6H5.2zm3.3-1v4.8h3.3V5.2zm1 1h1.3v2.8H9.5z"
            fill="currentColor"
            fillRule="evenodd"
          />
        )}
        {store === 'local' && <path d="M3 3h10v7H3zM6 12h4v1.5H6z" fill="currentColor" />}
      </svg>
    </span>
  )
}
