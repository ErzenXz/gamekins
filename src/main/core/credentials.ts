import { safeStorage } from 'electron'

/** Linux's basic_text backend uses a hard-coded key, so it is not a keyring. */
export function sessionEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
}

export function encryptSession(json: string): Buffer {
  if (!sessionEncryptionAvailable()) throw new Error('An OS keyring is required to save sign-in credentials')
  return safeStorage.encryptString(json)
}

export function decryptSession(raw: Buffer): string {
  if (!sessionEncryptionAvailable()) throw new Error('Unlock your OS keyring and sign in again')
  return safeStorage.decryptString(raw)
}
