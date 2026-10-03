import { FolderOpen, HardDrive, Loader2, RefreshCw, Star } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StorageDrive, StorageGame } from '@shared/types'
import { Select } from '../../components/shell/Select'
import { bytes, img } from '../../lib/format'
import { act, errorMessage, jobFor, useStore } from '../../store'

type Sort = 'size' | 'name'

const driveName = (root: string): string => {
  const letter = /^([A-Za-z]):/.exec(root)?.[1]
  return letter ? `Local Drive (${letter.toUpperCase()}:)` : root === '/' ? 'Local Disk' : root
}
const sameDrive = (a: string, b: string): boolean => a.toLowerCase().startsWith(b.toLowerCase())

/** Steam's storage manager: drive picker, usage bar, and the games on that drive. */
export function StorageManager(): React.JSX.Element {
  const installDir = useStore((s) => s.settings?.installDir ?? '')
  // Reload when installs change (install, uninstall, move, size update).
  const installSig = useStore((s) =>
    s.games.reduce((acc, g) => (g.install ? `${acc}|${g.key}:${g.install.path}:${g.install.sizeBytes}` : acc), '')
  )
  const [drives, setDrives] = useState<StorageDrive[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [root, setRoot] = useState<string | null>(null)
  const [sort, setSort] = useState<{ by: Sort; desc: boolean }>({ by: 'size', desc: true })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await window.lodestar.app.storage()
      setDrives(d)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, installSig])

  const defaultRoot = drives?.find((d) => sameDrive(installDir, d.root))?.root
  const drive = drives?.find((d) => d.root === root) ?? drives?.find((d) => d.root === defaultRoot) ?? drives?.[0]

  const games = useMemo(() => {
    const list = [...(drive?.games ?? [])]
    list.sort((a, b) => (sort.by === 'size' ? a.sizeBytes - b.sizeBytes : a.title.localeCompare(b.title)))
    if (sort.desc) list.reverse()
    return list
  }, [drive, sort])

  if (error && !drives)
    return (
      <div className="sm-error">
        <p>Couldn’t read your drives: {error}</p>
        <button className="btn btn-ghost" onClick={() => void load()}>
          Try again
        </button>
      </div>
    )
  if (!drives || !drive)
    return (
      <div className="sm-loading">
        <Loader2 size={18} className="spin" /> Reading drives…
      </div>
    )

  const gameBytes = drive.games.reduce((n, g) => n + g.sizeBytes, 0)
  const used = Math.max(0, drive.totalBytes - drive.freeBytes)
  const other = Math.max(0, used - gameBytes)
  const pct = (n: number): string => `${drive.totalBytes ? (n / drive.totalBytes) * 100 : 0}%`
  const toggleSort = (by: Sort): void =>
    setSort((s) => (s.by === by ? { by, desc: !s.desc } : { by, desc: by === 'size' }))

  return (
    <div className="sm">
      <div className="sm-top">
        <Select
          ariaLabel="Drive"
          value={drive.root}
          minWidth={320}
          onChange={setRoot}
          display={<DriveLabel drive={drive} isDefault={drive.root === defaultRoot} />}
          options={drives.map((d) => ({
            value: d.root,
            label: driveName(d.root),
            render: <DriveLabel drive={d} isDefault={d.root === defaultRoot} />
          }))}
        />
        <div className="sm-top-actions">
          <button
            className="btn btn-ghost"
            title="Choose where new games are installed"
            onClick={async () => {
              const dir = await window.lodestar.app.pickDirectory(drive.root === defaultRoot ? installDir : drive.root)
              if (dir) await act(() => useStore.getState().saveSettings({ installDir: dir }), `New games will install to ${dir}`)
            }}
          >
            <Star size={14} /> Default install folder…
          </button>
          <button className="icon-btn" title="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div className="sm-bar" role="img" aria-label={`${bytes(used)} used of ${bytes(drive.totalBytes)}`}>
        <span className="seg games" style={{ width: pct(gameBytes) }} />
        <span className="seg other" style={{ width: pct(other) }} />
      </div>
      <div className="sm-legend tabular">
        <span>
          <i className="games" /> Games <b>{bytes(gameBytes)}</b>
        </span>
        <span>
          <i className="other" /> Other <b>{bytes(other)}</b>
        </span>
        <span>
          <i className="free" /> Free space <b>{bytes(drive.freeBytes)}</b>
        </span>
      </div>

      <div className="sm-list">
        <div className="sm-head">
          <span className="sm-head-left">
            <span className="sm-count">
              {drive.games.length} Game{drive.games.length === 1 ? '' : 's'}
            </span>
            <button className={`sm-sort ${sort.by === 'name' ? 'on' : ''}`} onClick={() => toggleSort('name')}>
              Name <SortArrow on={sort.by === 'name'} desc={sort.desc} />
            </button>
          </span>
          <button className={`sm-sort size ${sort.by === 'size' ? 'on' : ''}`} onClick={() => toggleSort('size')}>
            Size <SortArrow on={sort.by === 'size'} desc={sort.desc} />
          </button>
          <span className="sm-head-actions" />
        </div>
        {games.length === 0 ? (
          <div className="sm-empty">No games installed on this drive.</div>
        ) : (
          games.map((g) => <StorageRow key={g.key} item={g} onChanged={() => void load()} />)
        )}
      </div>
    </div>
  )
}

function DriveLabel({ drive, isDefault }: { drive: StorageDrive; isDefault: boolean }): React.JSX.Element {
  return (
    <span className="sm-drive">
      <HardDrive size={18} className="sm-drive-icon" />
      <span className="sm-drive-text">
        <span className="sm-drive-name">
          {driveName(drive.root)}
          {isDefault && <Star size={12} className="sm-star" fill="currentColor" aria-label="Default install drive" />}
        </span>
        <span className="sm-drive-free">
          {bytes(drive.freeBytes)} free of {bytes(drive.totalBytes)}
        </span>
      </span>
    </span>
  )
}

function SortArrow({ on, desc }: { on: boolean; desc: boolean }): React.JSX.Element {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" className={`sm-arrow ${on ? 'on' : ''}`} aria-hidden>
      <path d={desc || !on ? 'M0 2h8L4 7z' : 'M0 6h8L4 1z'} fill="currentColor" />
    </svg>
  )
}

function StorageRow({ item, onChanged }: { item: StorageGame; onChanged: () => void }): React.JSX.Element {
  const game = useStore((s) => s.games.find((g) => g.key === item.key))
  const hasJob = useStore((s) => !!jobFor(s.jobs, item.key))
  const moving = useStore((s) => !!s.moving?.[item.key])
  const installDir = useStore((s) => s.settings?.installDir)
  const [failed, setFailed] = useState(false)
  const running = !!game?.running
  const locked = running || hasJob || moving
  const why = running ? 'Close the game first' : hasJob ? 'Wait for its download to finish' : moving ? 'Moving…' : undefined
  const art = game?.images.wide ?? game?.images.tall

  const uninstall = (): void => {
    useStore.getState().setConfirm({
      title: `Uninstall ${item.title}?`,
      message: `This deletes ${bytes(item.sizeBytes)} of game files from\n${item.path}\n\nSaves stored in the cloud or in your user folder are not affected.`,
      confirmLabel: 'Uninstall',
      danger: true,
      onConfirm: async () => {
        await act(() => window.lodestar.games.uninstall(item.key), `${item.title} was uninstalled`)
        onChanged()
      }
    })
  }

  const move = async (): Promise<void> => {
    const dir = await window.lodestar.app.pickDirectory(installDir)
    if (!dir) return
    const s = useStore.getState()
    s.setMoving?.(item.key, true)
    try {
      await act(() => window.lodestar.games.moveInstall(item.key, dir), `${item.title} was moved to ${dir}`)
    } finally {
      useStore.getState().setMoving?.(item.key, false)
      onChanged()
    }
  }

  return (
    <div className={`sm-row ${moving ? 'busy' : ''}`}>
      <span className="sm-art">
        {art && !failed ? <img src={img(art, 200)} alt="" onError={() => setFailed(true)} /> : <span>{item.title}</span>}
      </span>
      <span className="sm-info">
        <span className="sm-name">{item.title}</span>
        <span className="sm-path" title={item.path}>
          {moving ? 'Moving…' : item.path}
        </span>
      </span>
      <span className="sm-size tabular">{bytes(item.sizeBytes)}</span>
      <span className="sm-actions">
        <button className="icon-btn" title="Browse local files" onClick={() => act(() => window.lodestar.games.openFolder(item.key))}>
          <FolderOpen size={15} />
        </button>
        <button className="btn btn-ghost small" disabled={locked} title={why ?? 'Move this game to another folder or drive'} onClick={() => void move()}>
          {moving && <Loader2 size={12} className="spin" />} Move…
        </button>
        <button className="btn btn-ghost small" disabled={locked} title={why ?? 'Uninstall'} onClick={uninstall}>
          Uninstall
        </button>
      </span>
    </div>
  )
}
