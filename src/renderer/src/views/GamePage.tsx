import '../styles/game-page.css'
import {
  Apple,
  ChevronDown,
  CircleAlert,
  CircleArrowDown,
  Clock,
  Ellipsis,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Image as ImageIcon,
  Info,
  Link2,
  LoaderCircle,
  Monitor,
  Package,
  Settings,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  WifiOff
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DownloadJob, Game } from '@shared/types'
import { DlcList } from '../components/library/DlcList'
import { DownloadGlyph, PauseGlyph, PlayGlyph, StopGlyph } from '../components/library/glyphs'
import { Img } from '../components/library/Img'
import { DataSources, DetailsCard, FeaturesSection, HltbCard, MediaSection, ReviewsCard, useGameDetails } from './library/GameDetails'
import { useTileJob, useLiveJob, usePlatform, usePrimary } from '../components/library/libraryData'
import { LocalTile } from '../components/Capsule'
import { baseName, bytes, dateTime, eta, hoursShort, img, lastPlayed, playtime, shortDate, speed } from '../lib/format'
import {
  canLocate,
  canModify,
  canVerify,
  confirmUninstall,
  createShortcut,
  isLocal,
  jobPhrase,
  jobProgress,
  launchGame,
  locateInstall,
  openMenuAt,
  osName,
  type PrimaryKind,
  pickArtwork,
  runPrimary,
  storeUrl,
  SUPPORT_URL,
  toggleFavorite
} from '../lib/gameActions'
import { act, useStore } from '../store'

const INFO_KEY = 'lodestar.gamepage.info'

export function GamePage({ game }: { game: Game }): React.JSX.Element {
  const job = useTileJob(game.key)
  const primary = usePrimary(game, job)
  const platform = usePlatform()
  const scroller = useRef<HTMLDivElement>(null)
  const hero = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const dlcRef = useRef<HTMLDivElement>(null)
  const [showInfo, setShowInfo] = useState(() => {
    try {
      return localStorage.getItem(INFO_KEY) === '1'
    } catch {
      return false
    }
  })
  const local = isLocal(game)
  const { details } = useGameDetails(game.key)
  const steam = details?.steam
  const [heroFailed, setHeroFailed] = useState<string[]>([])
  useEffect(() => setHeroFailed([]), [game.key])

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    hero.current?.style.setProperty('--sy', '0')
    bar.current?.classList.remove('stuck')
  }, [game.key])

  // Parallax hero + "stuck" action bar, without re-rendering React on scroll.
  const onScroll = (): void => {
    const el = scroller.current
    if (!el || !hero.current) return
    const y = el.scrollTop
    hero.current.style.setProperty('--sy', String(Math.min(y, 700)))
    bar.current?.classList.toggle('stuck', y >= hero.current.offsetHeight - 1)
  }

  const toggleInfo = (): void => {
    const next = !showInfo
    setShowInfo(next)
    try {
      localStorage.setItem(INFO_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  // Like Steam: a clean, text-free hero banner with the logo on top. Steam's library hero is
  // preferred (Epic's wide art usually has the title baked in); fall back if it doesn't exist.
  const heroSources = [steam?.art.hero, game.images.wide, game.images.tall].filter(
    (src): src is string => !!src && !heroFailed.includes(src)
  )
  const art = heroSources[0]
  const steamHero = !!art && art === steam?.art.hero
  const s = useStore.getState()

  return (
    <div className="gp">
      <div className="gp-scroll scroll" ref={scroller} onScroll={onScroll}>
        <div className="gp-backdrop" aria-hidden>
          {art && (
            <>
              <img key={art} className="gp-blur" src={img(art, 640)} alt="" draggable={false} />
              <img key={`${art}-flip`} className="gp-blur-flip" src={img(art, 640)} alt="" draggable={false} />
            </>
          )}
        </div>

        <header className={`gp-hero ${art ? '' : 'no-art'}`} ref={hero}>
          <div className="gp-hero-art">
            {art ? (
              <Img
                key={art}
                src={img(art, 1920)}
                title={game.title}
                eager
                quietFallback
                onFail={() => setHeroFailed((f) => [...f, art])}
              />
            ) : local && game.images.thumb ? (
              <img className="gp-hero-icon" src={game.images.thumb} alt="" draggable={false} />
            ) : null}
          </div>
          <HeroTags game={game} />
          <div className="gp-logo-area">
            {/* Steam's logo only goes on Steam's text-free hero; Epic art already shows the title. */}
            <GameLogo game={game} sources={steamHero ? [steam?.art.logo, game.images.logo] : [game.images.logo]} />
          </div>
        </header>

        <div className="gp-bar" ref={bar}>
          <div className="gp-mini">
            {game.images.thumb || game.images.tall ? (
              <img src={game.images.thumb?.startsWith('data:') ? game.images.thumb : img(game.images.thumb ?? game.images.tall, 64)} alt="" />
            ) : (
              <span className="gp-mini-letter">{game.title.slice(0, 1)}</span>
            )}
            <span>{game.title}</span>
          </div>
          <PrimaryButton key={game.key} game={game} job={job} kind={primary.kind} label={primary.label} />
          {job ? <InlineProgress gameKey={game.key} /> : <Stats game={game} />}
          <div className="gp-icons">
            <button className="gp-icon" title="Properties" onClick={() => s.openProperties(game.key)}>
              <Settings size={18} />
            </button>
            <button
              className={`gp-icon ${showInfo ? 'on' : ''}`}
              title={showInfo ? 'Hide game info' : 'Show game info'}
              aria-pressed={showInfo}
              onClick={toggleInfo}
            >
              <Info size={18} />
            </button>
            <button
              className={`gp-icon fav ${game.prefs.favorite ? 'on' : ''}`}
              title={game.prefs.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
              aria-pressed={!!game.prefs.favorite}
              onClick={() => void toggleFavorite(game)}
            >
              <Star size={18} fill={game.prefs.favorite ? 'currentColor' : 'none'} />
            </button>
            <MoreButton gameKey={game.key} />
          </div>
        </div>

        <nav className="gp-links">
          {local ? (
            <>
              <button disabled={!game.install} onClick={() => act(() => window.lodestar.games.openFolder(game.key))}>
                Browse local files
              </button>
              <button onClick={() => s.openProperties(game.key, 'customization')}>Change artwork</button>
              <button onClick={() => s.openProperties(game.key)}>Properties</button>
            </>
          ) : (
            <>
              <button onClick={() => s.navigate({ view: 'store', url: storeUrl(game) })}>Store Page</button>
              <button
                disabled={!game.dlc.length}
                title={game.dlc.length ? undefined : 'This game has no DLC in your library'}
                onClick={() => dlcRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                DLC
              </button>
              <button onClick={() => act(() => window.lodestar.app.openExternal(SUPPORT_URL))}>Support</button>
              <button onClick={() => s.openProperties(game.key)}>Properties</button>
            </>
          )}
        </nav>

        {showInfo && <InfoPanel game={game} onClose={toggleInfo} />}

        <div className="gp-columns">
          <div className="gp-left">
            <Activity game={game} job={job} platform={platform} kind={primary.kind} />
            <MediaSection steam={steam} />
            {!local && <About game={game} extra={steam?.about} />}
            <FeaturesSection steam={steam} />
            <DataSources details={details} />
          </div>
          <aside className="gp-right">
            <HltbCard hltb={details?.hltb} />
            <ReviewsCard steam={steam} />
            {game.dlc.length > 0 && (
              <section className="gp-sec" ref={dlcRef}>
                <h3 className="gp-sec-title">
                  DLC
                  <span>
                    {game.dlc.filter((d) => d.install).length} of {game.dlc.length} installed
                  </span>
                </h3>
                <div className="gp-panel">
                  <DlcList game={game} compact />
                  <button className="gp-panel-link" onClick={() => s.openProperties(game.key, 'dlc')}>
                    Manage DLC
                  </button>
                </div>
              </section>
            )}
            <DetailsCard steam={steam} />
            <InfoCard game={game} />
            <ManageCard game={game} job={job} platform={platform} />
          </aside>
        </div>
      </div>
    </div>
  )
}

/** The ⋯ button toggles the game's context menu (it is excluded from the menu's outside-click close). */
function MoreButton({ gameKey }: { gameKey: string }): React.JSX.Element {
  const open = useStore((s) => s.contextMenu?.gameKey === gameKey)
  return (
    <button
      className={`gp-icon ${open ? 'on' : ''}`}
      title="More"
      data-ctx-trigger
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(e) => {
        if (open) useStore.getState().setContextMenu(null)
        else openMenuAt(e.currentTarget, gameKey, true)
      }}
    >
      <Ellipsis size={18} />
    </button>
  )
}

function HeroTags({ game }: { game: Game }): React.JSX.Element | null {
  const tags: { label: string; page?: string; cls?: string }[] = []
  if (game.prefs.hidden) tags.push({ label: 'Hidden', cls: 'hidden' })
  if (game.prefs.favorite) tags.push({ label: 'Favorites', page: 'collection:Favorites' })
  for (const c of game.prefs.collections ?? []) tags.push({ label: c, page: `collection:${c}` })
  if (game.install && !isLocal(game)) tags.push({ label: 'Installed locally' })
  if (isLocal(game)) tags.push({ label: 'Non-Epic game' })
  if (!tags.length) return null
  return (
    <div className="gp-tags">
      {tags.map((t) =>
        t.page ? (
          <button
            key={t.label}
            className={`gp-tag ${t.cls ?? ''}`}
            onClick={() => {
              const s = useStore.getState()
              s.setLibraryPage(t.page as `collection:${string}`)
              s.navigate({ view: 'library' })
            }}
          >
            {t.label}
          </button>
        ) : (
          <span key={t.label} className={`gp-tag static ${t.cls ?? ''}`}>
            {t.label}
          </span>
        )
      )}
    </div>
  )
}

/** Logo bottom-left; falls back to the title (also when the logo fails to load). */
function GameLogo({ game, sources }: { game: Game; sources: (string | undefined)[] }): React.JSX.Element {
  const [failed, setFailed] = useState<string[]>([])
  // First logo that loads; the title text if none does.
  const logo = sources.find((l): l is string => !!l && !failed.includes(l))
  if (logo) {
    return (
      <img
        key={logo}
        className="gp-logo"
        src={img(logo, 800)}
        alt={game.title}
        draggable={false}
        onError={() => setFailed((f) => [...f, logo])}
      />
    )
  }
  return <h1 className="gp-title">{game.title}</h1>
}

const ICONS: Partial<Record<PrimaryKind, () => React.JSX.Element>> = {
  play: () => <PlayGlyph />,
  resume: () => <PlayGlyph />,
  retry: () => <PlayGlyph />,
  install: () => <DownloadGlyph />,
  update: () => <DownloadGlyph />,
  pause: () => <PauseGlyph />,
  stop: () => <StopGlyph />
}

function PrimaryButton({
  game,
  job,
  kind,
  label
}: {
  game: Game
  job?: DownloadJob
  kind: PrimaryKind
  label: string
}): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const green = kind === 'play' || kind === 'launching'
  const busy = kind === 'launching' || kind === 'moving'
  const Icon = ICONS[kind]

  useEffect(() => {
    if (!menu) return
    const down = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [menu])

  return (
    <div className="gp-play-wrap" ref={wrap}>
      <button
        className={`gp-play ${green ? 'green' : kind === 'unavailable' ? 'grey' : 'blue'} ${busy ? 'busy' : ''} ${kind === 'update' ? 'split' : ''}`}
        disabled={kind === 'unavailable' || busy}
        aria-busy={busy}
        onClick={() => void runPrimary(game, job, kind)}
      >
        {busy ? <LoaderCircle size={20} className="spin" /> : Icon ? <Icon /> : <Monitor size={20} />}
        <span>{label}</span>
      </button>
      {kind === 'update' && (
        <button className="gp-play-split" title="More launch options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <ChevronDown size={16} />
        </button>
      )}
      {menu && (
        <div className="gp-play-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false)
              void launchGame(game)
            }}
          >
            Play without updating
          </button>
        </div>
      )}
    </div>
  )
}

function Stats({ game }: { game: Game }): React.JSX.Element {
  const local = isLocal(game)
  return (
    <div className="gp-stats">
      <Stat
        icon={<Clock size={26} strokeWidth={1.5} />}
        label="Last played"
        value={game.running ? 'Playing now' : lastPlayed(game.lastPlayed)}
        tone={game.running ? 'green' : undefined}
      />
      <Stat icon={<Gamepad2 size={26} strokeWidth={1.5} />} label="Play time" value={playtime(game.playtimeSeconds)} />
      {game.install && game.install.sizeBytes > 0 && (
        <Stat icon={<HardDrive size={26} strokeWidth={1.5} />} label="Size" value={bytes(game.install.sizeBytes)} />
      )}
      {!local && game.install?.version && (
        <Stat
          icon={<Tag size={26} strokeWidth={1.5} />}
          label="Version"
          value={game.updateAvailable && game.latestVersion ? `${game.install.version} → ${game.latestVersion}` : game.install.version}
          tone={game.updateAvailable ? 'blue' : undefined}
        />
      )}
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
  tone
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone?: 'blue' | 'green'
}): React.JSX.Element {
  return (
    <div className={`gp-stat ${tone ?? ''}`}>
      <span className="gp-stat-icon">{icon}</span>
      <span className="gp-stat-text">
        <span className="gp-stat-label">{label}</span>
        <span className="gp-stat-value" title={value}>
          {value}
        </span>
      </span>
    </div>
  )
}

/** Steam's inline download block next to the button (exact bytes; re-renders on each tick). */
function InlineProgress({ gameKey }: { gameKey: string }): React.JSX.Element | null {
  const job = useLiveJob(gameKey)
  if (!job) return null
  const pct = jobProgress(job) * 100
  const active = job.state === 'downloading' && job.speedBps > 0
  let detail = ''
  if (job.state === 'verifying' && job.totalVerifyBytes > 0) detail = `${bytes(job.verifiedBytes)} of ${bytes(job.totalVerifyBytes)}`
  else if (job.totalDownloadBytes > 0) detail = `${bytes(job.downloadedBytes)} of ${bytes(job.totalDownloadBytes)}`
  if (active) detail += ` · ${speed(job.speedBps)} · ${eta(job.totalDownloadBytes - job.downloadedBytes, job.speedBps)}`
  return (
    <button
      className={`gp-dl ${job.state}`}
      onClick={() => useStore.getState().navigate({ view: 'downloads' })}
      title="Open Downloads"
    >
      <span className="gp-dl-label">{jobPhrase(job)}</span>
      <span className="gp-dl-detail">
        {job.state === 'error' ? job.error ?? 'Something went wrong' : job.waitingReason ?? (detail || 'Waiting…')}
      </span>
      <span className="gp-dl-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
    </button>
  )
}

function InfoPanel({ game, onClose }: { game: Game; onClose: () => void }): React.JSX.Element {
  const local = isLocal(game)
  return (
    <section className="gp-infopanel">
      <div className="gp-infopanel-cover">
        {game.images.tall ? <Img src={img(game.images.tall, 300, 400)} title={game.title} /> : <LocalTile game={game} />}
      </div>
      <div className="gp-infopanel-body">
        <h3>{game.title}</h3>
        <p>{local ? `A program on this PC, added to your library.` : game.description?.trim() || 'No description available.'}</p>
        <div className="gp-infopanel-facts">
          {game.developer && (
            <span>
              <b>Developer</b> {game.developer}
            </span>
          )}
          {game.platforms.length > 0 && (
            <span>
              <b>Platforms</b> {game.platforms.join(', ').replace('Mac', 'macOS')}
            </span>
          )}
          {local && game.install && (
            <span>
              <b>Program</b> <span className="mono">{game.install.path}</span>
            </span>
          )}
        </div>
        <div className="gp-infopanel-actions">
          {!local && (
            <button className="lbtn" onClick={() => useStore.getState().navigate({ view: 'store', url: storeUrl(game) })}>
              Store Page
            </button>
          )}
          <button className="lbtn" onClick={onClose}>
            Hide
          </button>
        </div>
      </div>
    </section>
  )
}

interface Event {
  at?: number
  icon: React.ReactNode
  title: React.ReactNode
  sub?: string
}

function Activity({
  game,
  job,
  platform,
  kind
}: {
  game: Game
  job?: DownloadJob
  platform: string
  kind: PrimaryKind
}): React.JSX.Element {
  const local = isLocal(game)
  const inst = game.install
  const events: Event[] = []
  if (game.lastPlayed) {
    events.push({
      at: game.lastPlayed,
      icon: <Gamepad2 size={16} />,
      title: game.running ? `Playing ${game.title}` : `Played ${game.title}`,
      sub: dateTime(game.lastPlayed)
    })
  }
  if (inst?.installedAt) {
    events.push({
      at: inst.installedAt,
      icon: local ? <Link2 size={16} /> : <Package size={16} />,
      title: local
        ? 'Added to your library'
        : inst.source === 'epic-launcher'
          ? `Imported from the Epic Games Launcher${inst.version ? ` (version ${inst.version})` : ''}`
          : inst.version
            ? `Updated to version ${inst.version}`
            : 'Installed',
      sub: dateTime(inst.installedAt)
    })
  }
  events.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))

  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title">Activity</h3>

      <div className="gp-highlight">
        <div className="gp-highlight-icon">
          <Clock size={22} />
        </div>
        <div>
          <b>
            {game.playtimeSeconds
              ? `You've played for ${hoursShort(game.playtimeSeconds)}`
              : `You haven't played ${game.title} yet`}
          </b>
          <span>
            {game.running
              ? 'Playing right now.'
              : game.lastPlayed
                ? `Last played ${relDay(game.lastPlayed)}.`
                : inst
                  ? 'It is installed and ready to play.'
                  : kind === 'unavailable'
                    ? `There is no ${osName(platform)} version of this game.`
                    : 'Install it to start playing.'}
          </span>
        </div>
      </div>

      {inst && game.updateAvailable && !job && !game.running && !local && (
        <div className="gp-note blue">
          <CircleArrowDown size={18} />
          <div>
            <b>Update available</b>
            <span>
              {inst.version && game.latestVersion
                ? `Version ${game.latestVersion} is ready (you have ${inst.version}).`
                : 'A newer version of this game is available.'}
            </span>
          </div>
          <button className="lbtn" onClick={() => void launchGame(game)}>
            Play without updating
          </button>
          <button className="lbtn primary" onClick={() => act(() => window.lodestar.games.update(game.key))}>
            Update now
          </button>
        </div>
      )}
      {job?.state === 'error' && (
        <div className="gp-note red">
          <CircleAlert size={18} />
          <div>
            <b>{job.kind === 'update' ? 'Update' : job.kind === 'repair' ? 'Repair' : 'Download'} failed</b>
            <span>{job.error ?? 'Something went wrong.'}</span>
          </div>
          <button className="lbtn" onClick={() => useStore.getState().navigate({ view: 'downloads' })}>
            Downloads
          </button>
          <button className="lbtn primary" onClick={() => act(() => window.lodestar.downloads.resume(job.id))}>
            Retry
          </button>
        </div>
      )}
      {game.thirdPartyManagedApp && (
        <div className="gp-note">
          <Info size={18} />
          <div>
            <b>Managed by {game.thirdPartyManagedApp}</b>
            <span>
              Lodestar hands this game to the Epic Games Launcher, which installs and starts it through{' '}
              {game.thirdPartyManagedApp}.
            </span>
          </div>
        </div>
      )}
      {game.install?.unavailable && (
        <div className="gp-note"><HardDrive size={18} /><div><b>Drive not connected</b><span>Reconnect the drive containing this installation to play.</span></div></div>
      )}
      {game.install?.prereqsInstalled === false && (
        <div className="gp-note"><CircleAlert size={18} /><div><b>Prerequisites required</b><span>Prerequisite installation failed or timed out. Use Verify &amp; repair to retry.</span></div></div>
      )}
      {kind === 'unavailable' && !game.install?.unavailable && (
        <div className="gp-note">
          <Monitor size={18} />
          <div>
            <b>Not available on {osName(platform)}</b>
            <span>
              {game.title} can only be played on {game.platforms.join(' and ').replace('Mac', 'macOS')}. It stays in your
              library.
            </span>
          </div>
        </div>
      )}
      {!game.canRunOffline && !local && (
        <div className="gp-note subtle">
          <WifiOff size={18} />
          <div>
            <b>Needs an internet connection</b>
            <span>You must be signed in to Epic Games to start this game.</span>
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="gp-feed">
          {events.map((e, i) => (
            <div key={i} className="gp-event">
              <span className="gp-event-icon">{e.icon}</span>
              <span className="gp-event-text">
                <b>{e.title}</b>
                {e.sub && <span>{e.sub}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function About({ game, extra }: { game: Game; extra?: string }): React.JSX.Element {
  const [more, setMore] = useState(false)
  const epic = game.description?.trim() ?? ''
  // Epic's catalog text is often a single line; Steam's store page usually says more.
  const text = (extra && extra.length > epic.length + 40 ? extra : epic) || 'No description available.'
  const long = text.length > 600
  useEffect(() => setMore(false), [game.key])
  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title">About</h3>
      <div className="gp-panel gp-about">
        <p className={long && !more ? 'clamped' : ''}>{text}</p>
        {long && (
          <button className="gp-panel-link" onClick={() => setMore(!more)}>
            {more ? 'Show less' : 'Read more'}
          </button>
        )}
      </div>
    </section>
  )
}

function InfoCard({ game }: { game: Game }): React.JSX.Element {
  const inst = game.install
  const local = isLocal(game)
  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title">Info</h3>
      <div className="gp-panel">
        {local ? (
          <>
            <Row label="Program" value={inst ? baseName(inst.path) : undefined} />
            <Row
              label="Location"
              value={
                inst ? (
                  <button className="gp-path" title="Show in folder" onClick={() => act(() => window.lodestar.games.openFolder(game.key))}>
                    {inst.path}
                  </button>
                ) : undefined
              }
            />
            <Row label="Added" value={inst?.installedAt ? shortDate(inst.installedAt) : undefined} />
            <Row label="Play time" value={playtime(game.playtimeSeconds)} />
          </>
        ) : (
          <>
            <Row label="Developer" value={game.developer} />
            <Row
              label="Platforms"
              value={
                game.platforms.length ? (
                  <span className="gp-plats">
                    {game.platforms.map((p) => (
                      <span key={p} className="gp-plat">
                        {p === 'Mac' ? <Apple size={12} /> : <Monitor size={12} />} {p === 'Mac' ? 'macOS' : p}
                      </span>
                    ))}
                  </span>
                ) : undefined
              }
            />
            <Row label="Installed version" value={inst?.version} mono />
            <Row
              label="Latest version"
              value={
                game.latestVersion ? (
                  <span className={game.updateAvailable && inst ? 'tone-blue' : ''}>{game.latestVersion}</span>
                ) : undefined
              }
              mono
            />
            <Row label="Size on disk" value={inst && inst.sizeBytes > 0 ? bytes(inst.sizeBytes) : undefined} />
            <Row
              label="Location"
              value={
                inst ? (
                  <button className="gp-path" title="Open folder" onClick={() => act(() => window.lodestar.games.openFolder(game.key))}>
                    {inst.path}
                  </button>
                ) : undefined
              }
            />
            <Row
              label="Installed by"
              value={inst ? (inst.source === 'epic-launcher' ? 'Epic Games Launcher (imported)' : 'Lodestar') : undefined}
            />
            <Row label="Offline play" value={game.canRunOffline ? 'Supported' : 'Needs sign-in'} />
            {!inst && <Row label="Status" value="Not installed" />}
          </>
        )}
      </div>
    </section>
  )
}

function ManageCard({ game, job, platform }: { game: Game; job?: DownloadJob; platform: string }): React.JSX.Element {
  const s = useStore.getState()
  const moving = useStore((st) => !!st.moving[game.key])
  const local = isLocal(game)
  const inst = game.install
  return (
    <section className="gp-sec">
      <h3 className="gp-sec-title">Manage</h3>
      <div className="gp-panel gp-links-list">
        {inst && (
          <button disabled={moving} onClick={() => act(() => window.lodestar.games.openFolder(game.key))}>
            <FolderOpen size={15} /> Browse local files
          </button>
        )}
        {inst && !local && !game.thirdPartyManagedApp && (
          <button
            disabled={!canVerify(game, job)}
            title={job ? 'Wait for the current download to finish' : game.running ? 'Close the game first' : undefined}
            onClick={() => act(() => window.lodestar.games.repair(game.key), 'Verification queued')}
          >
            <ShieldCheck size={15} /> Verify integrity of game files
          </button>
        )}
        {canLocate(game, job, platform) && (
          <button onClick={() => locateInstall(game)}>
            <FolderOpen size={15} /> Locate existing install…
          </button>
        )}
        {inst && (
          <button onClick={() => void createShortcut(game)}>
            <Link2 size={15} /> Add desktop shortcut
          </button>
        )}
        <button onClick={() => s.openProperties(game.key, 'customization')}>
          <ImageIcon size={15} /> Set custom artwork…
        </button>
        {inst && !local && managedMove(game) && (
          <button disabled={!canModify(game, job)} onClick={() => s.openProperties(game.key, 'files')}>
            <HardDrive size={15} /> Move install folder…
          </button>
        )}
        <button onClick={() => s.openProperties(game.key)}>
          <Settings size={15} /> Properties…
        </button>
        {local ? (
          <button className="danger" disabled={!!game.running} onClick={() => confirmUninstall(game)}>
            <Trash2 size={15} /> Remove from library…
          </button>
        ) : (
          inst && (
            <button className="danger" disabled={!!game.running || moving || !!job} onClick={() => confirmUninstall(game)}>
              <Trash2 size={15} /> Uninstall…
            </button>
          )
        )}
      </div>
    </section>
  )
}

const managedMove = (g: Game): boolean => !g.thirdPartyManagedApp

function relDay(ts: number): string {
  const d = lastPlayed(ts)
  return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : `on ${d}`
}

function Row({ label, value, mono }: { label: string; value?: React.ReactNode; mono?: boolean }): React.JSX.Element | null {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className="gp-row">
      <span className="gp-row-label">{label}</span>
      <span className={`gp-row-value ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  )
}
