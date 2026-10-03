import { libraryIndex } from '../../lib/entityIndex'
import { useStore } from '../../store'

const IDLE_MS = 10 * 60_000
const HIDDEN_MS = 2 * 60_000

/** Only leaving Store starts the idle clock; other route changes retain its deadline. */
export function watchStoreLifetime(mount: (on: boolean) => void): () => void {
  let lastUsed = Date.now()
  let idle: ReturnType<typeof setTimeout> | undefined
  let hidden: ReturnType<typeof setTimeout> | undefined
  if (useStore.getState().route.view === 'store') mount(true)
  const unsubscribe = useStore.subscribe((s, previous) => {
    if (s.route.view === 'store' && (previous.route.view !== 'store' || s.storeActivation !== previous.storeActivation)) {
      clearTimeout(idle)
      lastUsed = Date.now()
      mount(true)
    } else if (previous.route.view === 'store' && s.route.view !== 'store') {
      lastUsed = Date.now()
      idle = setTimeout(() => mount(false), Math.max(0, IDLE_MS - (Date.now() - lastUsed)))
    }
    if (s.games !== previous.games && [...libraryIndex(s.games).runningKeys].some((key) => !libraryIndex(previous.games).runningKeys.has(key))) {
      clearTimeout(idle)
      mount(false)
    }
  })
  const visibility = (): void => {
    clearTimeout(hidden)
    if (document.visibilityState === 'hidden') hidden = setTimeout(() => mount(false), HIDDEN_MS)
    else if (useStore.getState().route.view === 'store') mount(true)
  }
  document.addEventListener('visibilitychange', visibility)
  visibility()
  return () => {
    unsubscribe()
    clearTimeout(idle)
    clearTimeout(hidden)
    document.removeEventListener('visibilitychange', visibility)
  }
}
