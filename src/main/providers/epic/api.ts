// Thin client for Epic's (undocumented) launcher web services.
// Endpoints and client credentials are the ones the official launcher uses,
// as documented by the open-source community (Legendary / Heroic).

export const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a'
const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf'

const OAUTH_HOST = 'https://account-public-service-prod03.ol.epicgames.com'
const LAUNCHER_HOST = 'https://launcher-public-service-prod06.ol.epicgames.com'
const CATALOG_HOST = 'https://catalog-public-service-prod06.ol.epicgames.com'
const LIBRARY_HOST = 'https://library-service.live.use1a.on.epicgames.com'
const ECOMMERCE_HOST = 'https://ecommerceintegration-public-service-ecomprod02.ol.epicgames.com'

export const USER_AGENT =
  'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit'

export const LOGIN_REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`
export const LOGIN_URL = `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(LOGIN_REDIRECT_URL)}`

export interface EpicSession {
  access_token: string
  expires_at: string
  refresh_token: string
  refresh_expires_at: string
  account_id: string
  displayName: string
}

export interface LibraryRecord {
  appName: string
  catalogItemId: string
  namespace: string
  sandboxType?: string
  productId?: string
}

export interface CatalogImage {
  type: string
  url: string
  width?: number
  height?: number
}

export interface CatalogItem {
  id: string
  title: string
  description?: string
  developer?: string
  namespace: string
  keyImages?: CatalogImage[]
  categories?: { path: string }[]
  customAttributes?: Record<string, { type: string; value: string }>
  releaseInfo?: { appId: string; platform?: string[] }[]
  mainGameItem?: unknown
}

export interface Asset {
  appName: string
  labelName: string
  buildVersion: string
  catalogItemId: string
  namespace: string
}

export interface ManifestLocation {
  uri: string
  queryParams?: { name: string; value: string }[]
}

export interface ManifestInfo {
  appName: string
  buildVersion: string
  hash: string
  manifests: ManifestLocation[]
}

export class EpicApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

/**
 * The HTTP client for every Epic call (API, manifests, chunks). Defaults to Node's fetch;
 * the app swaps in Electron's `net.fetch` (Chromium's network stack: system proxy,
 * better connection handling, plays nicer with antivirus web shields).
 */
export let httpFetch: typeof fetch = (...args) => fetch(...args)
export function useFetch(impl: typeof fetch): void {
  httpFetch = impl
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** fetch with retries for flaky networks: connection failures, timeouts and 5xx/429. */
export async function fetchRetry(url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('Aborted')
    try {
      const timeout = AbortSignal.timeout(30_000)
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      const res = await httpFetch(url, { ...init, signal })
      if (!RETRY_STATUS.has(res.status) || i === attempts - 1) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      if (init.signal?.aborted) throw err
      lastErr = err
    }
    await sleep(Math.min(8000, 600 * 3 ** i))
  }
  const msg = lastErr instanceof Error ? (lastErr.cause as Error)?.message || lastErr.message : String(lastErr)
  throw new Error(`Couldn't reach Epic Games (${msg}). Check your connection.`)
}

async function request<T>(url: string, init: RequestInit & { raw?: false }): Promise<T>
async function request(url: string, init: RequestInit & { raw: true }): Promise<ArrayBuffer>
async function request(url: string, init: RequestInit & { raw?: boolean }): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('User-Agent', USER_AGENT)
  // Token exchanges must not be replayed blindly; everything else is safe to retry.
  const isOauth = url.includes('/oauth/token')
  const res = await fetchRetry(url, { ...init, headers }, isOauth ? 1 : 4)
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { errorMessage?: string; errorCode?: string }
      detail = body.errorMessage || body.errorCode || JSON.stringify(body)
    } catch {
      /* not json */
    }
    throw new EpicApiError(`Epic API ${res.status} for ${new URL(url).pathname}: ${detail}`, res.status)
  }
  if (init.raw) return res.arrayBuffer()
  if (res.status === 204) return undefined
  return res.json()
}

const basicAuth = (): string =>
  'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')

async function oauth(params: Record<string, string>): Promise<EpicSession> {
  return request<EpicSession>(`${OAUTH_HOST}/account/api/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, token_type: 'eg1' })
  })
}

export const exchangeAuthCode = (code: string): Promise<EpicSession> =>
  oauth({ grant_type: 'authorization_code', code })

export const refreshSession = (refreshToken: string): Promise<EpicSession> =>
  oauth({ grant_type: 'refresh_token', refresh_token: refreshToken })

export async function killSession(accessToken: string): Promise<void> {
  await request(`${OAUTH_HOST}/account/api/oauth/sessions/kill/${accessToken}`, {
    method: 'DELETE',
    headers: { Authorization: `bearer ${accessToken}` }
  })
}

/** Authenticated calls. `token` is resolved lazily so sessions can refresh in between. */
export class EpicApi {
  constructor(private readonly token: () => Promise<string>) {}

  private async get<T>(url: string): Promise<T> {
    return request<T>(url, { headers: { Authorization: `bearer ${await this.token()}` } })
  }

  async exchangeCode(): Promise<string> {
    const res = await this.get<{ code: string }>(`${OAUTH_HOST}/account/api/oauth/exchange`)
    return res.code
  }

  async libraryItems(): Promise<LibraryRecord[]> {
    const out: LibraryRecord[] = []
    let cursor: string | undefined
    do {
      const url = new URL(`${LIBRARY_HOST}/library/api/public/items`)
      url.searchParams.set('includeMetadata', 'true')
      if (cursor) url.searchParams.set('cursor', cursor)
      const page = await this.get<{
        records: LibraryRecord[]
        responseMetadata?: { nextCursor?: string }
      }>(url.toString())
      out.push(...page.records)
      cursor = page.responseMetadata?.nextCursor
    } while (cursor)
    return out
  }

  async catalogItem(namespace: string, id: string): Promise<CatalogItem | undefined> {
    const url = new URL(`${CATALOG_HOST}/catalog/api/shared/namespace/${namespace}/bulk/items`)
    url.searchParams.set('id', id)
    url.searchParams.set('includeDLCDetails', 'true')
    url.searchParams.set('includeMainGameDetails', 'true')
    url.searchParams.set('country', 'US')
    url.searchParams.set('locale', 'en')
    const res = await this.get<Record<string, CatalogItem>>(url.toString())
    return res[id]
  }

  async assets(platform: string): Promise<Asset[]> {
    return this.get<Asset[]>(`${LAUNCHER_HOST}/launcher/api/public/assets/${platform}?label=Live`)
  }

  async manifestInfo(
    platform: string,
    namespace: string,
    catalogItemId: string,
    appName: string
  ): Promise<ManifestInfo> {
    const res = await this.get<{ elements: ManifestInfo[] }>(
      `${LAUNCHER_HOST}/launcher/api/public/assets/v2/platform/${platform}/namespace/${namespace}` +
        `/catalogItem/${catalogItemId}/app/${appName}/label/Live`
    )
    if (!res.elements?.length) throw new Error(`No ${platform} build available for ${appName}`)
    return res.elements[0]
  }

  async ownershipToken(accountId: string, namespace: string, catalogItemId: string): Promise<Buffer> {
    const buf = await request(
      `${ECOMMERCE_HOST}/ecommerceintegration/api/public/platforms/EPIC/identities/${accountId}/ownershipToken`,
      {
        method: 'POST',
        raw: true,
        headers: {
          Authorization: `bearer ${await this.token()}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ nsCatalogItemId: `${namespace}:${catalogItemId}` })
      }
    )
    return Buffer.from(buf)
  }
}

/** Download a manifest file. Tries every mirror Epic gave us. */
export async function downloadManifest(info: ManifestInfo): Promise<{ data: Buffer; baseUrls: string[] }> {
  let lastErr: unknown
  const baseUrls = info.manifests.map((m) => m.uri.slice(0, m.uri.lastIndexOf('/')))
  for (const m of info.manifests) {
    const url = new URL(m.uri)
    for (const p of m.queryParams ?? []) url.searchParams.set(p.name, p.value)
    try {
      const data = Buffer.from(await request(url.toString(), { raw: true }))
      return { data, baseUrls }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('No manifest mirrors available')
}
