import { ExternalLink, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ProviderId, ProviderInfo, Settings } from '@shared/types'
import { confirmSignOut } from '../components/shell/account'
import { Select } from '../components/shell/Select'
import { modKey } from '../components/shell/format'
import { LodestarMark } from '../components/TitleBar'
import { act, bootstrap, useStore } from '../store'
import { StorageManager } from './shell/StorageManager'

const SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'interface', label: 'Interface' },
  { id: 'library', label: 'Library' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'storage', label: 'Storage' },
  { id: 'startup', label: 'Startup' },
  { id: 'about', label: 'About Lodestar' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** Names other parts of the app may use for a section. */
const ALIASES: Record<string, SectionId> = {
  accounts: 'account',
  general: 'interface'
}

/** Stable fallback: a fresh [] from a selector would re-render forever. */
const NO_PROVIDERS: ProviderInfo[] = []
const BANDWIDTH = [0, 1, 2, 5, 10, 25, 50, 100]
const WORKERS = [4, 8, 16, 24, 32]

export function SettingsView(): React.JSX.Element {
  const raw = useStore((s) => (s.route.view === 'settings' ? s.route.section : undefined))
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.info)

  const wanted = raw ? (ALIASES[raw] ?? raw) : undefined
  const section: SectionId = SECTIONS.some((s) => s.id === wanted) ? (wanted as SectionId) : 'account'
  const current = SECTIONS.find((s) => s.id === section)!
  const platform = info?.platform ?? 'win32'
  const needsSettings = section === 'downloads' || section === 'library' || section === 'startup'

  return (
    <div className="st">
      <nav className="st-nav scroll" aria-label="Settings sections">
        <div className="st-nav-title">Lodestar Settings</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`st-nav-item ${s.id === section ? 'active' : ''}`}
            aria-current={s.id === section ? 'page' : undefined}
            onClick={() => useStore.getState().replaceRoute({ view: 'settings', section: s.id })}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="st-panel scroll" key={section}>
        <div className="st-panel-inner">
          <h1 className="st-title">{section === 'account' ? 'Account' : current.label}</h1>
          {needsSettings && !settings ? (
            <SettingsUnavailable />
          ) : (
            <>
              {section === 'account' && <AccountSection />}
              {section === 'interface' && <InterfaceSection />}
              {section === 'library' && <LibrarySection settings={settings!} />}
              {section === 'downloads' && <DownloadsSection settings={settings!} platform={platform} />}
              {section === 'storage' && <StorageManager />}
              {section === 'startup' && <StartupSection settings={settings!} platform={platform} />}
              {section === 'about' && <AboutSection version={info?.version ?? '—'} platform={platform} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SettingsUnavailable(): React.JSX.Element {
  return (
    <div className="st-unavailable">
      <TriangleAlert size={18} />
      <span>Your settings couldn’t be loaded.</span>
      <button className="btn btn-ghost small" onClick={() => void bootstrap()}>
        Retry
      </button>
    </div>
  )
}

/* ───────── building blocks (Steam's settings Field) ───────── */

function save(patch: Partial<Settings>): Promise<void> {
  return act(() => useStore.getState().saveSettings(patch))
}

function Heading({ children }: { children: ReactNode }): React.JSX.Element {
  return <h2 className="st-sub">{children}</h2>
}

function Row({
  label,
  hint,
  children,
  htmlFor,
  disabled
}: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  htmlFor?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={`st-row ${disabled ? 'disabled' : ''}`}>
      <div className="st-row-text">
        <label className="st-label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint && <div className="st-hint">{hint}</div>}
      </div>
      {children !== undefined && <div className="st-control">{children}</div>}
    </div>
  )
}

type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings]

function Toggle({ settings, k, label, hint }: { settings: Settings; k: BoolKey; label: string; hint?: ReactNode }): React.JSX.Element {
  const id = `st-${k}`
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={settings[k]}
        onChange={(e) => void save({ [k]: e.target.checked })}
      />
    </Row>
  )
}

/* ───────── sections ───────── */

function AccountSection(): React.JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const providers = useStore((s) => s.info?.providers ?? NO_PROVIDERS)
  const sessionExpired = useStore((s) => s.sessionExpired)
  const signingIn = useStore((s) => s.signingIn)
  const epic = accounts.find((a) => a.provider === 'epic')
  const list = providers.length ? providers : [{ id: 'epic', name: 'Epic Games', available: true }]

  const signOut = (id: ProviderId, name: string): void => confirmSignOut(id, name)

  return (
    <>
      {sessionExpired && !epic && (
        <div className="st-alert">
          <TriangleAlert size={16} />
          <span>Your Epic Games session expired. Sign in again to keep your library and updates current.</span>
          <button className="btn btn-blue small" disabled={signingIn} onClick={() => void useStore.getState().signIn('epic')}>
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      )}
      {epic && (
        <div className="st-account-card">
          <span className="st-avatar">{epic.displayName[0]?.toUpperCase()}</span>
          <div>
            <div className="st-account-name">{epic.displayName}</div>
            <div className="st-hint">
              <i className="st-online" /> Signed in to Epic Games
            </div>
          </div>
        </div>
      )}

      <Heading>Connected stores</Heading>
      {list
        .filter((p) => p.id !== 'local')
        .map((p) => {
          const account = accounts.find((a) => a.provider === p.id)
          return (
            <Row
              key={p.id}
              label={
                <span className="st-provider">
                  <span className={`st-provider-logo ${p.id}`}>{p.name[0]}</span>
                  {p.name}
                </span>
              }
              hint={
                !p.available
                  ? 'Coming soon: Lodestar can’t connect to this store yet.'
                  : account
                    ? `Signed in as ${account.displayName}`
                    : p.id === 'epic' && sessionExpired
                      ? 'Session expired'
                      : 'Not connected'
              }
              disabled={!p.available}
            >
              {!p.available ? (
                <span className="st-soon">Coming soon</span>
              ) : account ? (
                <button className="btn btn-ghost" onClick={() => signOut(p.id as ProviderId, p.name)}>
                  Sign out…
                </button>
              ) : (
                <button className="btn btn-blue" disabled={signingIn} onClick={() => void useStore.getState().signIn(p.id as ProviderId)}>
                  {signingIn && <Loader2 size={14} className="spin" />} {signingIn ? 'Signing in…' : 'Sign in'}
                </button>
              )}
            </Row>
          )
        })}

      <Heading>Epic Games account</Heading>
      <Row label="Account details" hint="Profile, password, two-factor authentication and linked accounts.">
        <LinkButton url="https://www.epicgames.com/account/personal" />
      </Row>
      <Row label="Transactions" hint="Purchase history, receipts and refunds.">
        <LinkButton url="https://www.epicgames.com/account/transactions" />
      </Row>
      <Row label="Redeem a code" hint="Activate a game or add-on with a product code.">
        <button className="btn btn-ghost" onClick={() => useStore.getState().navigate({ view: 'store', url: 'https://www.epicgames.com/redeem' })}>
          Redeem…
        </button>
      </Row>
    </>
  )
}

function LinkButton({ url, label = 'Open' }: { url: string; label?: string }): React.JSX.Element {
  return (
    <button className="btn btn-ghost" onClick={() => void window.lodestar.app.openExternal(url)}>
      <ExternalLink size={14} /> {label}
    </button>
  )
}

const SIZES = [
  { value: 120, label: 'Small' },
  { value: 160, label: 'Medium' },
  { value: 220, label: 'Large' }
]

function InterfaceSection(): React.JSX.Element {
  const gridSize = useStore((s) => s.gridSize)
  const sort = useStore((s) => s.librarySort)
  const mod = modKey()
  const nearest = SIZES.reduce((a, b) => (Math.abs(b.value - gridSize) < Math.abs(a.value - gridSize) ? b : a)).value
  const sizeOptions = SIZES.some((s) => s.value === gridSize)
    ? SIZES
    : [...SIZES, { value: gridSize, label: `Custom (${gridSize}px)` }]
  const shortcuts: [string, string][] = [
    [`${mod} + 1`, 'Store'],
    [`${mod} + 2`, 'Library'],
    [`${mod} + 3`, 'Downloads'],
    [`${mod} + ,`, 'Settings'],
    [`${mod} + F`, 'Search your library'],
    ['Alt + ← / →', 'Back / forward'],
    ['↑ ↓  Home  End', 'Move through the game list'],
    ['Page Up / Page Down', 'Jump through the game list'],
    ['Type a letter', 'Jump to a game by name'],
    ['Enter', 'Play, install or update the selected game'],
    ['Esc', 'Close the open menu or dialog']
  ]
  return (
    <>
      <Heading>Library</Heading>
      <Row label="Library display size" hint="Size of game capsules in the library grid." htmlFor="st-size">
        <Select
          id="st-size"
          value={sizeOptions.some((s) => s.value === gridSize) ? gridSize : nearest}
          options={sizeOptions}
          onChange={(v) => useStore.getState().setGridSize(v)}
        />
      </Row>
      <Row label="Sort games by" hint="Order of the All Games grid on the library home." htmlFor="st-sort">
        <Select
          id="st-sort"
          value={sort}
          options={[
            { value: 'alpha', label: 'Alphabetical' },
            { value: 'recent', label: 'Last played' },
            { value: 'playtime', label: 'Hours played' },
            { value: 'size', label: 'Size on disk' },
            { value: 'installed', label: 'Installed first' }
          ]}
          onChange={(v) => useStore.getState().setLibrarySort(v)}
        />
      </Row>
      <Heading>Keyboard shortcuts</Heading>
      <div className="st-shortcuts">
        {shortcuts.map(([k, v]) => (
          <div key={k} className="st-shortcut">
            <span>{v}</span>
            <kbd>{k}</kbd>
          </div>
        ))}
      </div>
    </>
  )
}

function DownloadsSection({ settings, platform }: { settings: Settings; platform: string }): React.JSX.Element {
  const nav = useStore.getState().navigate
  return (
    <>
      <Heading>Content libraries</Heading>
      <Row label="Default install folder" hint="New games are installed into their own folder here.">
        <div className="st-path-picker">
          <span className="st-path" title={settings.installDir}>
            <bdi dir="ltr">{settings.installDir}</bdi>
          </span>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              const dir = await window.lodestar.app.pickDirectory(settings.installDir)
              if (dir) await save({ installDir: dir })
            }}
          >
            Change…
          </button>
        </div>
      </Row>
      <Row label="Storage manager" hint="See what’s installed on each drive, and move or uninstall games.">
        <button className="btn btn-ghost" onClick={() => useStore.getState().replaceRoute({ view: 'settings', section: 'storage' })}>
          Open storage manager
        </button>
      </Row>

      <Heading>Download restrictions</Heading>
      <Row label="Limit bandwidth to" hint="Caps download speed so the rest of the house can still stream and play." htmlFor="st-bw">
        <Select
          id="st-bw"
          value={settings.bandwidthLimitMBps}
          options={[
            ...(BANDWIDTH.includes(settings.bandwidthLimitMBps) ? [] : [{ value: settings.bandwidthLimitMBps, label: `${settings.bandwidthLimitMBps} MB/s` }]),
            ...BANDWIDTH.map((n) => ({ value: n, label: n === 0 ? 'No limit' : `${n} MB/s` }))
          ]}
          onChange={(v) => void save({ bandwidthLimitMBps: v })}
        />
      </Row>
      <Row label="Parallel connections" hint="More is faster on good connections. 16 suits most." htmlFor="st-workers">
        <Select
          id="st-workers"
          value={settings.maxWorkers}
          options={[
            ...(WORKERS.includes(settings.maxWorkers) ? [] : [{ value: settings.maxWorkers, label: `${settings.maxWorkers} connections` }]),
            ...WORKERS.map((n) => ({ value: n, label: `${n} connections` }))
          ]}
          onChange={(v) => void save({ maxWorkers: v })}
        />
      </Row>
      <Toggle
        settings={settings}
        k="downloadsDuringGameplay"
        label="Allow downloads during gameplay"
        hint="If this is off, downloads pause while a game is running and resume when you quit."
      />

      <Heading>Updates</Heading>
      <Toggle settings={settings} k="autoUpdate" label="Keep games up to date" hint="Queue updates automatically when a new build is released." />
      {platform === 'win32' && (
        <Toggle
          settings={settings}
          k="installPrerequisites"
          label="Install game prerequisites"
          hint="Run a game’s redistributables installer (DirectX, Visual C++) after its first install. Windows asks for admin rights."
        />
      )}

      <Heading>Queue</Heading>
      <Row label="Downloads" hint="See progress, reorder the queue and clear finished items.">
        <button className="btn btn-ghost" onClick={() => nav({ view: 'downloads' })}>
          Open downloads
        </button>
      </Row>
    </>
  )
}

function LibrarySection({ settings }: { settings: Settings }): React.JSX.Element {
  const refreshing = useStore((s) => s.refreshing)
  return (
    <>
      <Heading>Existing installs</Heading>
      <Toggle
        settings={settings}
        k="importEpicLauncherInstalls"
        label="Find games installed by the Epic Games Launcher"
        hint="Adopt existing installs instead of downloading them again."
      />
      <Row label="Refresh library" hint="Re-read your owned games and installed builds now.">
        <button className="btn btn-ghost" disabled={refreshing} onClick={() => void useStore.getState().refresh()}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
      </Row>
      <Heading>Launching games</Heading>
      <Toggle
        settings={settings}
        k="launchViaEpicLauncher"
        label="Launch through the Epic Games Launcher"
        hint="A fallback for games that won’t start directly. You can also set this per game in Properties."
      />
      <Toggle settings={settings} k="minimizeOnLaunch" label="Minimize Lodestar when a game starts" hint="Get the launcher out of the way while you play." />
      <Heading>Non-Epic games</Heading>
      <Row label="Add a non-Epic game" hint="Put any program on this PC in your library and launch it from Lodestar.">
        <button className="btn btn-ghost" onClick={() => useStore.getState().setAddGameOpen(true)}>
          Add a game…
        </button>
      </Row>
    </>
  )
}

function StartupSection({ settings, platform }: { settings: Settings; platform: string }): React.JSX.Element {
  const mac = platform === 'darwin'
  return (
    <>
      <Toggle
        settings={settings}
        k="launchAtLogin"
        label={`Run Lodestar when ${mac ? 'you log in' : 'Windows starts'}`}
        hint="Start in the background so updates are ready before you are."
      />
      {mac ? (
        <Row
          label="Closing the window"
          hint="On macOS, closing the window keeps Lodestar running in the menu bar so downloads continue. Use Lodestar › Quit Lodestar (⌘Q) to quit."
        />
      ) : (
        <Toggle
          settings={settings}
          k="closeToTray"
          label="Close to the system tray"
          hint="Closing the window keeps Lodestar running in the tray so downloads continue. Use Lodestar › Exit to quit."
        />
      )}
    </>
  )
}

function AboutSection({ version, platform }: { version: string; platform: string }): React.JSX.Element {
  const os = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform
  return (
    <>
      <div className="st-about">
        <LodestarMark size={64} />
        <div>
          <div className="st-about-name">LODESTAR</div>
          <div className="st-about-version">
            Version {version} · {os}
          </div>
          <p className="st-hint">A fast, Steam-style client for your Epic Games library.</p>
        </div>
      </div>
      <Heading>Help</Heading>
      <Row label="Epic Games status" hint="Check whether sign-in, downloads or the store are having trouble.">
        <LinkButton url="https://status.epicgames.com" />
      </Row>
      <Row label="Epic Games support" hint="Account, purchase and refund help from Epic.">
        <LinkButton url="https://www.epicgames.com/help" />
      </Row>
      <Row label="Epic Games Store" hint="Open the store in your web browser.">
        <LinkButton url="https://store.epicgames.com/" />
      </Row>
      <p className="st-legal">
        Lodestar is an independent project and is not affiliated with, endorsed by or sponsored by Epic Games, Inc. or Valve
        Corporation. All trademarks are property of their respective owners.
      </p>
    </>
  )
}
