import {
  CircleArrowDown,
  CircleCheck,
  FolderInput,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  Plus,
  Puzzle,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ArtworkKind, Game, GamePrefs } from '@shared/types'
import { bytes, img, shortDate } from '../lib/format'
import {
  addToCollection,
  ARTWORK_LABELS,
  canInstall,
  canLocate,
  canModify,
  canVerify,
  confirmUninstall,
  createShortcut,
  inCollection,
  isLocal,
  jobStatus,
  locateInstall,
  pickArtwork,
  removeFromCollection,
  resetArtwork
} from '../lib/gameActions'
import { act, errorMessage, jobFor, type PropertiesTab, useStore } from '../store'
import { libraryIndex } from '../lib/entityIndex'
import { Checkbox, OptionRow, Toggle } from './library/controls'
import { DlcList } from './library/DlcList'
import { Img, TitleCard } from './library/Img'
import { useCollections } from './library/libraryData'
import { LocalTile } from './Capsule'
import { Modal } from './Modal'

const TABS: { id: PropertiesTab; label: string; icon: React.JSX.Element }[] = [
  { id: 'general', label: 'General', icon: <Settings2 size={15} /> },
  { id: 'updates', label: 'Updates', icon: <CircleArrowDown size={15} /> },
  { id: 'files', label: 'Installed Files', icon: <HardDrive size={15} /> },
  { id: 'dlc', label: 'DLC', icon: <Puzzle size={15} /> },
  { id: 'customization', label: 'Customization', icon: <ImageIcon size={15} /> }
]

function tabsFor(game: Game): typeof TABS {
  if (isLocal(game))
    return TABS.filter((t) => t.id === 'general' || t.id === 'files' || t.id === 'customization').map((t) =>
      t.id === 'files' ? { ...t, label: 'Shortcut' } : t
    )
  return TABS.filter((t) => t.id !== 'dlc' || game.dlc.length > 0)
}

/** Steam-style per-game Properties dialog, driven by `store.propertiesKey` (+ `propertiesTab`). */
export function PropertiesDialog(): React.JSX.Element | null {
  const game = useStore((s) => (s.propertiesKey ? libraryIndex(s.games).gamesByKey.get(s.propertiesKey) : undefined))
  return game ? <PropertiesBody key={game.key} game={game} /> : null
}

function PropertiesBody({ game }: { game: Game }): React.JSX.Element {
  const wanted = useStore((s) => s.propertiesTab)
  const [tab, setTab] = useState<PropertiesTab>(() => wanted ?? 'general')

  useEffect(() => {
    if (wanted) {
      setTab(wanted)
      useStore.setState({ propertiesTab: null })
    }
  }, [wanted])

  const close = (): void => useStore.getState().setPropertiesKey(null)
  const tabs = tabsFor(game)
  const current = tabs.some((t) => t.id === tab) ? tab : 'general'

  return (
    <Modal
      title={`Properties - ${game.title}`}
      onClose={close}
      width={850}
      footer={
        <button className="lbtn" onClick={close}>
          Close
        </button>
      }
    >
      <div className="props">
        <nav className="props-nav" role="tablist" aria-orientation="vertical">
          <div className="props-game">
            {game.images.tall ? (
              <Img src={img(game.images.tall, 120, 160)} title={game.title} />
            ) : isLocal(game) ? (
              <LocalTile game={game} />
            ) : (
              <TitleCard title={game.title} className="img" />
            )}
          </div>
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={current === t.id}
              className={`props-tab ${current === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              {t.label}
              {t.id === 'dlc' && <span className="props-tab-count">{game.dlc.length}</span>}
              {t.id === 'updates' && game.install && game.updateAvailable && <span className="props-dot" />}
            </button>
          ))}
        </nav>
        <div className="props-panel scroll" role="tabpanel">
          {current === 'general' && <General key={game.key} game={game} />}
          {current === 'updates' && <Updates game={game} />}
          {current === 'files' && (isLocal(game) ? <Shortcut game={game} /> : <Files game={game} />)}
          {current === 'dlc' && (
            <>
              <h3 className="props-h">DLC</h3>
              <p className="props-sub">Additional content you own for {game.title}.</p>
              <DlcList game={game} compact />
            </>
          )}
          {current === 'customization' && <Customization game={game} />}
        </div>
      </div>
    </Modal>
  )
}

const save = (game: Game, patch: Partial<GamePrefs>): Promise<void> =>
  act(() => window.gamekins.games.setPrefs(game.key, patch))

function General({ game }: { game: Game }): React.JSX.Element {
  const [args, setArgs] = useState(game.prefs.launchArgs ?? '')
  const pending = useRef<number>(0)
  const latest = useRef(args)
  latest.current = args
  const collections = useCollections()
  const local = isLocal(game)
  const globalViaEpic = useStore((s) => s.settings?.launchViaEpicLauncher ?? false)

  // Save launch options shortly after typing stops, and on close.
  useEffect(() => {
    return () => {
      if (pending.current) {
        clearTimeout(pending.current)
        if ((game.prefs.launchArgs ?? '') !== latest.current) void save(game, { launchArgs: latest.current.trim() ? latest.current : undefined })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.key])

  const onArgs = (v: string): void => {
    setArgs(v)
    clearTimeout(pending.current)
    pending.current = window.setTimeout(() => {
      pending.current = 0
      void save(game, { launchArgs: v.trim() ? v : undefined })
    }, 500)
  }

  return (
    <>
      <h3 className="props-h">General</h3>
      <div className="props-field">
        <label className="ldialog-label" htmlFor="launch-args">
          Launch options
        </label>
        <input
          id="launch-args"
          className="ltext mono"
          placeholder="e.g. -windowed -dx11 -skipintro"
          value={args}
          spellCheck={false}
          onChange={(e) => onArgs(e.target.value)}
          onBlur={() => {
            if (pending.current) {
              clearTimeout(pending.current)
              pending.current = 0
              void save(game, { launchArgs: args.trim() ? args : undefined })
            }
          }}
        />
        <p className="props-hint">Added to the end of the {local ? 'program' : "game's"} command line every time it starts.</p>
      </div>

      {!local && (
        <OptionRow
          title="Launch through the Epic Games Launcher"
          hint={
            globalViaEpic
              ? 'Already on for every game in Settings. Turning it on here keeps it on for this game.'
              : 'Use this if the game refuses to start directly (some anti-cheat and online games need it).'
          }
        >
          <Toggle
            label="Launch through the Epic Games Launcher"
            checked={!!game.prefs.launchViaOfficial}
            onChange={(v) => void save(game, { launchViaOfficial: v })}
          />
        </OptionRow>
      )}
      <OptionRow title="Favorite" hint="Shown in the Favorites section of the game list and on Home.">
        <Toggle label="Favorite" checked={!!game.prefs.favorite} onChange={(v) => void save(game, { favorite: v })} />
      </OptionRow>
      <OptionRow title="Hide in library" hint="Hidden games only show up under the Hidden filter.">
        <Toggle label="Hide in library" checked={!!game.prefs.hidden} onChange={(v) => void save(game, { hidden: v })} />
      </OptionRow>

      <div className="props-field">
        <div className="props-row-head">
          <span className="ldialog-label">Collections</span>
          <button
            className="lbtn small"
            onClick={() => useStore.getState().setCollectionPrompt({ mode: 'create', gameKeys: [game.key] })}
          >
            <Plus size={13} /> New collection…
          </button>
        </div>
        {collections.length ? (
          <div className="props-colls">
            {collections.map((c) => (
              <Checkbox
                key={c}
                label={c}
                checked={inCollection(game, c)}
                onChange={(v) => void (v ? addToCollection([game.key], c) : removeFromCollection([game.key], c))}
              />
            ))}
          </div>
        ) : (
          <p className="props-hint">You have no collections yet. Create one to group games on Home and in the game list.</p>
        )}
      </div>
    </>
  )
}

function Updates({ game }: { game: Game }): React.JSX.Element {
  const globalAuto = useStore((s) => s.settings?.autoUpdate ?? true)
  const refreshing = useStore((s) => s.refreshing)
  const job = useStore((s) => jobFor(s.jobs, game.key))
  const inst = game.install
  const upToDate = inst && !game.updateAvailable
  const third = game.thirdPartyManagedApp

  return (
    <>
      <h3 className="props-h">Updates</h3>
      {third && <p className="props-note">Updates for this game are handled by {third} through the Epic Games Launcher.</p>}
      <OptionRow
        title="Automatic updates"
        disabled={!!third}
        hint={
          globalAuto
            ? 'Keep this game up to date automatically when an update is released.'
            : 'Automatic updates are turned off for all games in Settings, so this has no effect right now.'
        }
      >
        <Toggle
          label="Automatic updates"
          disabled={!!third}
          checked={game.prefs.autoUpdate !== false}
          onChange={(v) => void save(game, { autoUpdate: v })}
        />
      </OptionRow>

      <div className="props-versions">
        <div className="props-ver">
          <span>Installed version</span>
          <b className="mono">{inst?.version || '—'}</b>
        </div>
        <div className="props-ver">
          <span>Latest version</span>
          <b className="mono">{game.latestVersion ?? '—'}</b>
        </div>
        <div className="props-ver">
          <span>Status</span>
          {!inst ? (
            <b className="dim">Not installed</b>
          ) : job ? (
            <b className="tone-blue">{jobStatus(job)}</b>
          ) : upToDate ? (
            <b className="tone-green">
              <CircleCheck size={14} /> Up to date
            </b>
          ) : (
            <b className="tone-blue">
              <CircleArrowDown size={14} /> Update available
            </b>
          )}
        </div>
      </div>
      {inst?.installedAt ? <p className="props-foot">Installed content updated: {shortDate(inst.installedAt)}</p> : null}

      <div className="props-actions">
        <button className="lbtn" disabled={refreshing} onClick={() => void useStore.getState().refresh()}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Checking…' : 'Check for updates now'}
        </button>
        {inst && game.updateAvailable && !job && !third && (
          <button
            className="lbtn primary"
            disabled={!canModify(game, job)}
            title={game.running ? 'Close the game first' : undefined}
            onClick={() => act(() => window.gamekins.games.update(game.key), 'Update queued')}
          >
            <CircleArrowDown size={14} /> Update now
          </button>
        )}
      </div>
    </>
  )
}

function Files({ game }: { game: Game }): React.JSX.Element {
  const inst = game.install
  const job = useStore((s) => jobFor(s.jobs, game.key))
  const moving = useStore((s) => !!s.moving[game.key])
  const platform = useStore((s) => s.info?.platform ?? 'win32')
  const third = !!game.thirdPartyManagedApp

  const move = async (): Promise<void> => {
    const s = useStore.getState()
    const dir = await window.gamekins.app.pickDirectory(s.settings?.installDir)
    if (!dir) return
    const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
    const parent = inst ? inst.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') : ''
    if (inst && norm(parent) === norm(dir)) return s.toast({ kind: 'info', message: `${game.title} is already in ${dir}` })
    s.setMoving(game.key, true)
    try {
      await window.gamekins.games.moveInstall(game.key, dir)
      useStore.getState().toast({ kind: 'success', message: `${game.title} was moved to ${dir}` })
    } catch (err) {
      useStore.getState().toast({ kind: 'error', message: errorMessage(err) })
    } finally {
      useStore.getState().setMoving(game.key, false)
    }
  }

  if (!inst) {
    const installable = canInstall(game, job, platform)
    return (
      <>
        <h3 className="props-h">Installed Files</h3>
        <div className="props-empty">
          <HardDrive size={28} />
          <p>{job ? `${game.title} is downloading: ${jobStatus(job)}.` : `${game.title} isn't installed.`}</p>
          {installable && (
            <div className="props-actions center">
              <button className="lbtn primary" onClick={() => useStore.getState().setInstallKey(game.key)}>
                Install…
              </button>
              {canLocate(game, job, platform) && (
                <button className="lbtn" onClick={() => locateInstall(game)}>
                  <FolderOpen size={14} /> Locate existing install…
                </button>
              )}
            </div>
          )}
          {!installable && !job && <p className="dim">This game can't be installed on this computer.</p>}
        </div>
      </>
    )
  }
  const drive = /^[a-z]:/i.test(inst.path) ? inst.path.slice(0, 2).toUpperCase() : null
  return (
    <>
      <h3 className="props-h">Installed Files</h3>
      <div className="props-size">
        <span>
          Size of installation: <b>{inst.sizeBytes > 0 ? bytes(inst.sizeBytes) : 'Unknown'}</b>
          {drive ? ` on ${drive}` : ''}
        </span>
        <button className="lbtn" disabled={moving} onClick={() => act(() => window.gamekins.games.openFolder(game.key))}>
          <FolderOpen size={14} /> Browse…
        </button>
      </div>
      <div className="props-path mono" title={inst.path}>
        {inst.path}
      </div>
      <p className="props-hint">
        {inst.source === 'epic-launcher' ? 'Imported from the Epic Games Launcher' : 'Installed by Gamekins'}
        {inst.installedAt ? ` · ${shortDate(inst.installedAt)}` : ''}
        {inst.version ? ` · version ${inst.version}` : ''}
      </p>
      {moving && (
        <div className="props-moving">
          <LoaderCircle size={13} className="spin" /> Moving files… this can take a few minutes across drives. You can close
          this window.
          <div className="props-moving-bar" />
        </div>
      )}
      {!third && (
        <OptionRow title="Move install folder" hint="Moves the game to another folder or drive. Its folder name stays the same.">
          <button className="lbtn" disabled={moving || !canModify(game, job)} onClick={() => void move()}>
            {moving ? <LoaderCircle size={14} className="spin" /> : <FolderInput size={14} />}
            {moving ? 'Moving…' : 'Move…'}
          </button>
        </OptionRow>
      )}
      {!third && (
        <OptionRow
          title="Verify integrity of game files"
          hint={
            job
              ? 'Available once the current download finishes.'
              : game.running
                ? 'Close the game first.'
                : "Checks every file against Epic's manifest and re-downloads anything missing or damaged."
          }
        >
          <button
            className="lbtn"
            disabled={!canVerify(game, job)}
            onClick={() => act(() => window.gamekins.games.repair(game.key), 'Verification queued')}
          >
            <ShieldCheck size={14} /> Verify
          </button>
        </OptionRow>
      )}
      <OptionRow title="Add desktop shortcut" hint="Puts a shortcut on your desktop that starts the game through Gamekins.">
        <button className="lbtn" onClick={() => void createShortcut(game)}>
          <Link2 size={14} /> Create
        </button>
      </OptionRow>
      <OptionRow title="Uninstall" hint="Deletes the game's files. You keep the game in your library.">
        <button
          className="lbtn danger"
          disabled={moving || !!game.running || !!job}
          title={game.running ? 'Close the game first' : job ? 'Cancel the download first' : undefined}
          onClick={() => confirmUninstall(game)}
        >
          <Trash2 size={14} /> Uninstall…
        </button>
      </OptionRow>
    </>
  )
}

/** Non-Epic games: what the library entry points at. */
function Shortcut({ game }: { game: Game }): React.JSX.Element {
  const inst = game.install
  return (
    <>
      <h3 className="props-h">Shortcut</h3>
      <div className="props-field">
        <span className="ldialog-label">Target</span>
        <div className="props-path mono" title={inst?.path}>
          {inst?.path ?? 'Unknown'}
        </div>
        <p className="props-hint">
          Added {inst?.installedAt ? shortDate(inst.installedAt) : ''}. To point at a different program, remove this entry and
          add the program again.
        </p>
      </div>
      <OptionRow title="Browse local files" hint="Opens the folder that contains the program.">
        <button className="lbtn" disabled={!inst} onClick={() => act(() => window.gamekins.games.openFolder(game.key))}>
          <FolderOpen size={14} /> Browse…
        </button>
      </OptionRow>
      <OptionRow title="Add desktop shortcut" hint="Puts a shortcut on your desktop that starts it through Gamekins.">
        <button className="lbtn" onClick={() => void createShortcut(game)}>
          <Link2 size={14} /> Create
        </button>
      </OptionRow>
      <OptionRow title="Remove from library" hint="Takes it out of Gamekins. The program itself stays on your PC.">
        <button className="lbtn danger" disabled={!!game.running} onClick={() => confirmUninstall(game)}>
          <Trash2 size={14} /> Remove…
        </button>
      </OptionRow>
    </>
  )
}

function Customization({ game }: { game: Game }): React.JSX.Element {
  return (
    <>
      <h3 className="props-h">Customization</h3>
      <p className="props-sub">Use your own images for this game. PNG, JPG or WebP; a transparent PNG works best for the logo.</p>
      <div className="art-grid">
        <ArtTile game={game} kind="tall" />
        <div className="art-col">
          <ArtTile game={game} kind="wide" />
          <ArtTile game={game} kind="logo" />
        </div>
      </div>
    </>
  )
}

function ArtTile({ game, kind }: { game: Game; kind: ArtworkKind }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const src = game.images[kind]
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const hint = kind === 'tall' ? 'Library capsule · 3:4' : kind === 'wide' ? 'Game page hero · wide' : 'Over the hero · transparent PNG'
  return (
    <div className={`art-tile ${kind}`}>
      <div className="art-head">
        <b>{ARTWORK_LABELS[kind]}</b>
        <span>{hint}</span>
      </div>
      <div className="art-preview" style={kind === 'logo' && game.images.wide ? { backgroundImage: `url("${img(game.images.wide, 640)}")` } : undefined}>
        {src ? (
          kind === 'logo' ? (
            <img key={src} src={img(src, 600)} alt="" draggable={false} />
          ) : (
            <Img key={src} src={img(src, kind === 'tall' ? 300 : 960)} title={game.title} eager />
          )
        ) : (
          <span className="art-none">{kind === 'logo' ? 'No logo · the title is shown instead' : 'No image'}</span>
        )}
        {busy && (
          <span className="art-busy">
            <LoaderCircle size={20} className="spin" />
          </span>
        )}
      </div>
      <div className="art-actions">
        <button className="lbtn small" disabled={busy} onClick={() => void run(() => pickArtwork(game, kind))}>
          Change…
        </button>
        <button className="lbtn small" disabled={busy || !src} onClick={() => void run(() => resetArtwork(game, kind))}>
          Reset
        </button>
      </div>
    </div>
  )
}
