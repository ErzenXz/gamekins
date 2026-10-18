import { lazy, type ComponentProps, type ComponentType } from 'react'

/**
 * React.lazy plus preload(). Once preloaded, the component renders directly instead of
 * suspending: React holds a Suspense reveal back (~300 ms) even when the chunk is already
 * in memory, which made the first game page open feel slow.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithPreload<C extends ComponentType<any>>(
  factory: () => Promise<{ default: C }>
): ComponentType<ComponentProps<C>> & { preload: () => Promise<unknown> } {
  let loaded: C | undefined
  let pending: Promise<{ default: C }> | undefined
  const load = (): Promise<{ default: C }> =>
    (pending ??= factory().then((m) => {
      loaded = m.default
      return m
    }))
  const Lazy = lazy(load)
  const Component = (props: ComponentProps<C>): React.JSX.Element => {
    const Loaded = loaded
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />
  }
  return Object.assign(Component, { preload: load })
}
