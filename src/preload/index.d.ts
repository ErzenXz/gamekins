import type { GamekinsApi } from '../shared/api'

declare global {
  interface Window {
    gamekins: GamekinsApi
  }
}
