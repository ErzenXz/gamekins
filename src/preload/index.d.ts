import type { LodestarApi } from '../shared/api'

declare global {
  interface Window {
    lodestar: LodestarApi
  }
}
