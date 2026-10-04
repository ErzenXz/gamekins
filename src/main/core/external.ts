import { shell } from 'electron'

export async function openExternalSafe(url: string): Promise<void> {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only HTTP and HTTPS links are allowed')
  }
  await shell.openExternal(parsed.href)
}

export async function openPathChecked(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}
