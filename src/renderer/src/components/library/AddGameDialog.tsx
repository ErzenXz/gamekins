import { ArrowDown, ArrowUp, CircleAlert, FileSearch, LoaderCircle, RotateCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { LocalProgram } from '@shared/types'
import { baseName } from '../../lib/format'
import { errorMessage, useStore } from '../../store'
import { Modal } from '../Modal'

type SortCol = 'name' | 'path'

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const pickedPath = (p: LocalProgram): string => p.shortcutPath ?? p.path
const programId = (p: LocalProgram): string => norm(p.path) + '\0' + (p.arguments ?? '')

/** Steam's "Add a Non-Steam Game" dialog, driven by `store.addGameOpen`. */
export function AddGameDialog(): React.JSX.Element | null {
  const open = useStore((s) => s.addGameOpen)
  return open ? <AddGameBody /> : null
}

function AddGameBody(): React.JSX.Element {
  const platform = useStore((s) => s.info?.platform ?? 'win32')
  const games = useStore((s) => s.games)
  const [programs, setPrograms] = useState<LocalProgram[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ col: SortCol; dir: 1 | -1 }>({ col: 'name', dir: 1 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (): void => {
    if (!busy) useStore.getState().setAddGameOpen(false)
  }

  useEffect(() => {
    let alive = true
    setPrograms(null)
    setLoadError(null)
    window.gamekins.app
      .listPrograms()
      .then((list) => alive && setPrograms((prev) => merge(list, prev ?? [])))
      .catch((e) => alive && setLoadError(errorMessage(e)))
    return () => {
      alive = false
    }
  }, [attempt])

  // Programs already in the library can't be added twice.
  const owned = useMemo(() => {
    const set = new Set<string>()
    for (const g of games) if (g.provider === 'local' && g.install?.path) set.add(norm(g.install.path + '/' + g.install.executable) + '\0' + g.install.launchCommand)
    return set
  }, [games])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = (programs ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    return list.sort((a, b) => sort.dir * a[sort.col].localeCompare(b[sort.col], undefined, { sensitivity: 'base', numeric: true }))
  }, [programs, filter, sort])

  const toggle = (path: string, on?: boolean): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (on ?? !next.has(path)) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const browse = async (): Promise<void> => {
    setError(null)
    try {
      const exts = platform === 'darwin' ? ['app'] : ['exe', 'lnk', 'bat', 'cmd', 'url']
      const files = await window.gamekins.app.pickFiles({
        title: 'Choose programs to add',
        filters: [{ name: platform === 'darwin' ? 'Applications' : 'Programs', extensions: exts }],
        multi: true
      })
      if (!files.length) return
      const picked = files.map((p) => ({ name: baseName(p).replace(/\.(exe|lnk|app|bat|cmd|url)$/i, ''), path: p }))
      setPrograms((prev) => merge(prev ?? [], picked))
      setChecked((prev) => {
        const next = new Set(prev)
        for (const f of files) if (!owned.has(norm(f) + '\0')) next.add(f)
        return next
      })
      setFilter('')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const add = async (): Promise<void> => {
    const paths = [...checked].filter((p) => !owned.has(programId(programs?.find((row) => pickedPath(row) === p) ?? { name: '', path: p })))
    if (!paths.length) return
    setBusy(true)
    setError(null)
    try {
      const keys = await window.gamekins.games.addLocal(paths)
      const s = useStore.getState()
      s.toast({
        kind: 'success',
        message: keys.length === 1 ? `Added ${titleFor(paths[0], programs)} to your library` : `Added ${keys.length} programs to your library`
      })
      s.setAddGameOpen(false)
      if (keys[0]) s.navigate({ view: 'library', gameKey: keys[0] })
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const count = [...checked].filter((p) => !owned.has(programId(programs?.find((row) => pickedPath(row) === p) ?? { name: '', path: p }))).length
  const head = (col: SortCol, label: string): React.JSX.Element => (
    <button
      className={`agd-th ${col} ${sort.col === col ? 'sorted' : ''}`}
      onClick={() => setSort((s) => (s.col === col ? { col, dir: (s.dir * -1) as 1 | -1 } : { col, dir: 1 }))}
    >
      {label}
      {sort.col === col && (sort.dir === 1 ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}
    </button>
  )

  return (
    <Modal
      title="Add a non-Epic game"
      onClose={close}
      width={680}
      footer={
        <>
          <button className="lbtn" onClick={() => void browse()} disabled={busy}>
            <FileSearch size={14} /> Browse…
          </button>
          <span className="agd-spacer" />
          <button className="lbtn primary" disabled={!count || busy} onClick={() => void add()}>
            {busy && <LoaderCircle size={14} className="spin" />}
            {count > 1 ? `Add ${count} selected programs` : 'Add selected programs'}
          </button>
          <button className="lbtn" onClick={close} disabled={busy}>
            Cancel
          </button>
        </>
      }
    >
      <div className="agd">
        <p className="agd-text">Select programs to add to your Gamekins library. They show up in the game list with their icon.</p>
        <div className="agd-filter">
          <Search size={14} />
          <input
            data-autofocus
            placeholder="Search list…"
            value={filter}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.stopPropagation()
                setFilter('')
              }
            }}
          />
          {filter && (
            <button title="Clear" onClick={() => setFilter('')}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="agd-table">
          <div className="agd-head">
            <span className="agd-c-check" />
            <span className="agd-c-icon" />
            {head('name', 'Program')}
            {head('path', 'Location')}
          </div>
          <div className="agd-list scroll" role="listbox" aria-multiselectable>
            {loadError ? (
              <div className="agd-state">
                <CircleAlert size={18} />
                <span>Couldn't list the programs on this PC: {loadError}</span>
                <button className="lbtn small" onClick={() => setAttempt((a) => a + 1)}>
                  <RotateCw size={12} /> Retry
                </button>
                <span className="dim">You can still use Browse… to pick a program.</span>
              </div>
            ) : !programs ? (
              <div className="agd-state">
                <LoaderCircle size={20} className="spin" /> Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="agd-state">
                {filter ? `No programs match “${filter}”.` : 'No programs found. Use Browse… to pick one.'}
              </div>
            ) : (
              rows.map((p) => {
                const inLib = owned.has(programId(p))
                const on = inLib || checked.has(pickedPath(p))
                return (
                  <label key={pickedPath(p)} className={`agd-row ${on ? 'on' : ''} ${inLib ? 'owned' : ''}`} title={p.path}>
                    <span className="agd-c-check">
                      <input type="checkbox" checked={on} disabled={inLib} onChange={() => toggle(pickedPath(p))} />
                      <span className="agd-box" aria-hidden>
                        <svg viewBox="0 0 18 18">
                          <path d="M3.5 9.5l3.5 3.5 7.5-8" />
                        </svg>
                      </span>
                    </span>
                    <span className="agd-c-icon">
                      {p.icon ? <img src={p.icon} alt="" draggable={false} /> : <span className="agd-noicon">{p.name.slice(0, 1)}</span>}
                    </span>
                    <span className="agd-name">
                      {p.name}
                      {inLib && <em>In library</em>}
                    </span>
                    <span className="agd-path">{p.path}</span>
                  </label>
                )
              })
            )}
          </div>
        </div>
        <div className="agd-status">
          {error ? (
            <span className="agd-error">
              <CircleAlert size={14} /> {error}
            </span>
          ) : (
            <span>{count ? `${count} selected` : programs ? `${programs.length} programs found` : ''}</span>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Add `extra` entries in front of `list`, skipping paths already present. */
function merge(list: LocalProgram[], extra: LocalProgram[]): LocalProgram[] {
  const seen = new Set(list.map(programId))
  return [...extra.filter((p) => !seen.has(programId(p))), ...list]
}

function titleFor(path: string, programs: LocalProgram[] | null): string {
  return programs?.find((p) => pickedPath(p) === path)?.name ?? baseName(path)
}
