import { shell } from 'electron'

export async function openExternalSafe(url: string): Promise<void> {
  const parsed = new URL(url)
  // Opens the user's mail composer only. The user chooses the report details and
  // sends it; this never silently uploads logs or sends a message.
  if (parsed.protocol === 'mailto:' && parsed.pathname === 'erzen@quad-labs.com' &&
      !parsed.hash && [...parsed.searchParams.keys()].every((key) => key === 'subject' || key === 'body') &&
      url.length <= 8192) {
    await shell.openExternal(parsed.href)
    return
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only HTTP and HTTPS links are allowed')
  }
  await shell.openExternal(parsed.href)
}

export async function openPathChecked(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}
