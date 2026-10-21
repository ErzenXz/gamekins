import type { BrowserWindow } from 'electron'
import { STORE_DISTRIBUTION } from '../../shared/distribution'

type Provider = 'epic' | 'steam' | 'gog'

/** Authentication pages only. Store, community, profile and account-content pages
 * are deliberately excluded even when hosted by the same provider. */
export function isAllowedAuthenticationUrl(provider: Provider, source: string, store = STORE_DISTRIBUTION): boolean {
  if (!store) return true
  let url: URL
  try { url = new URL(source) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || /[%\\]/.test(url.pathname)) return false
  const host = url.hostname
  const path = url.pathname
  if (provider === 'steam') {
    if (host === 'steamcommunity.com' || host === 'www.steamcommunity.com') return /^\/(?:login|openid\/login)(?:\/|$)/.test(path)
    if (host === 'store.steampowered.com') return /^\/login(?:\/|$)/.test(path)
    if (host === 'login.steampowered.com') return /^\/jwt\/(?:refresh|finalizelogin|transfer|checkdevice)(?:\/|$)/.test(path)
    return false
  }
  if (provider === 'epic' && (host === 'www.epicgames.com' || host === 'epicgames.com')) {
    return /^\/id\/(?:login|register|api\/redirect|authorize|exchange|logout|verify|mfa|activate|reset-password)(?:\/|$)/.test(path)
  }
  if (provider === 'gog') {
    if (host === 'auth.gog.com' || host === 'login.gog.com') return /^\/(?:auth|login|signin|sign_in|authorize|oauth|two_step|two-factor)(?:\/|$)/.test(path)
    if (host === 'embed.gog.com') return path === '/on_login_success'
  }
  // Known federated sign-in endpoints. Unknown providers fail closed with a clear
  // cancellation message, rather than turning the auth window into a web browser.
  if (host === 'accounts.google.com') return /^\/(?:o\/oauth2|signin|v[23]\/signin|ServiceLogin|AccountChooser|gsi)(?:\/|$)/.test(path)
  if (host === 'appleid.apple.com') return /^\/auth\//.test(path)
  if (host === 'www.facebook.com' || host === 'm.facebook.com') return /^\/(?:v\d+\.\d+\/dialog\/oauth|dialog\/oauth|login(?:\.php)?|checkpoint)(?:\/|$)/.test(path)
  if (host === 'login.live.com') return /^\/(?:oauth20_authorize\.srf|oauth20_desktop\.srf|login\.srf|ppsecure\/post\.srf|GetCredentialType\.srf)$/.test(path)
  if (host === 'login.microsoftonline.com') return /^\/(?:common|consumers|organizations)\/(?:oauth2|login|reprocess|SAS)(?:\/|$)/.test(path)
  if (host === 'accounts.nintendo.com') return /^\/(?:authorize|login|connect|select_account)(?:\/|$)/.test(path)
  if (host === 'ca.account.sony.com') return /^\/(?:api\/authz\/v3\/oauth\/authorize|signin)(?:\/|$)/.test(path)
  if (host === 'id.sonyentertainmentnetwork.com') return /^\/signin(?:\/|$)/.test(path)
  if (provider === 'epic' && host === 'steamcommunity.com') return /^\/openid\/login(?:\/|$)/.test(path)
  if (provider === 'gog' && (host === 'discord.com' || host === 'www.discord.com')) return /^\/(?:oauth2\/authorize|login|register)(?:\/|$)/.test(path)
  // Authentication challenge frames cannot navigate to unrelated provider pages.
  if (host === 'www.google.com' || host === 'www.recaptcha.net') return /^\/recaptcha\//.test(path)
  if (host === 'challenges.cloudflare.com') return /^\/cdn-cgi\/challenge-platform\//.test(path)
  if (host === 'hcaptcha.com' || host === 'newassets.hcaptcha.com') return /^\/captcha\//.test(path)
  return false
}

export function authenticationNavigationError(): Error {
  // Never put a URL, authorization code or token in logs/toasts.
  return new Error('This sign-in window only allows supported authentication pages. Store and community browsing are unavailable here. Try the provider’s direct sign-in method.')
}

/** Protect both the original login window and every SSO popup recursively. */
export function protectAuthenticationWindow(
  win: BrowserWindow,
  provider: Provider,
  onBlocked: (error: Error) => void,
  store = STORE_DISTRIBUTION
): void {
  if (!store) return
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (isAllowedAuthenticationUrl(provider, url, true)) return
    event.preventDefault()
    onBlocked(authenticationNavigationError())
  }
  win.webContents.on('will-navigate', guard)
  win.webContents.on('will-redirect', guard)
  win.webContents.on('will-frame-navigate', (event) => guard(event, event.url))
  win.webContents.on('did-navigate-in-page', (_event, url) => {
    if (!isAllowedAuthenticationUrl(provider, url, true)) {
      win.webContents.stop()
      onBlocked(authenticationNavigationError())
    }
  })
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
    onBlocked(authenticationNavigationError())
  })
  win.webContents.on('did-create-window', (child) => {
    protectAuthenticationWindow(child, provider, onBlocked, true)
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedAuthenticationUrl(provider, url, true)) {
        onBlocked(authenticationNavigationError())
        return { action: 'deny' }
      }
      return { action: 'allow', overrideBrowserWindowOptions: {
        parent: child, webPreferences: { session: child.webContents.session, sandbox: true, contextIsolation: true, nodeIntegration: false }
      } }
    })
  })
}
