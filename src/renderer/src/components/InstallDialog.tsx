import { CircleAlert, ExternalLink, FolderOpen, HardDrive, LoaderCircle, Monitor, RotateCw, Star, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Game, InstallPlan } from '@shared/types'
import { bytes, img } from '../lib/format'
import { availableHere, canLocate, isLocal, locateInstall, osName } from '../lib/gameActions'
import { errorMessage, jobFor, useStore } from '../store'
import { Img } from './library/Img'
import { Checkbox } from './library/controls'
import { Modal } from './Modal'

const SHORTCUT_KEY = 'lodestar.install.shortcut'

function readShortcut(): boolean {
  try {
    return localStorage.getItem(SHORTCUT_KEY) !== '0'
  } catch {
    return true
  }
}

/** Steam's install dialog, driven by `store.installKey`. */
export function InstallDialog(): React.JSX.Element | null {
  const installKey = useStore((s) => s.installKey)
  const game = useStore((s) => (s.installKey ? s.games.find((g) => g.key === s.installKey) : undefined))
  if (!installKey || !game) return null
  return <InstallDialogBody key={installKey} game={game} />
}

function InstallDialogBody({ game }: { game: Game }): React.JSX.Element {
  const defaultDir = useStore((s) => s.settings?.installDir)
  const platform = useStore((s) => s.info?.platform ?? 'win32')
  const job = useStore((s) => jobFor(s.jobs, game.key))
  const [baseDir, setBaseDir] = useState<string | undefined>(defaultDir)
  const [plan, setPlan] = useState<InstallPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [shortcut, setShortcut] = useState(readShortcut)

  const thirdParty = game.thirdPartyManagedApp
  const unavailable = !availableHere(game, platform)
  // While our own install request is in flight the new job must not flip the dialog to "already downloading".
  const blocked = !!game.install || (!!job && !busy) || isLocal(game) || unavailable
  const close = (): void => {
    if (!busy) useStore.getState().setInstallKey(null)
  }

  useEffect(() => {
    if (!baseDir && defaultDir) setBaseDir(defaultDir)
  }, [defaultDir, baseDir])

  // Plan the install (size, free space, final folder). EA/Ubisoft games skip this: Epic installs them.
  useEffect(() => {
    if (thirdParty || blocked || !baseDir) return
    let alive = true
    setPlan(null)
    setPlanError(null)
    window.lodestar.games
      .plan(game.key, baseDir)
      .then((p) => alive && setPlan(p))
      .catch((e) => alive && setPlanError(errorMessage(e)))
    return () => {
      alive = false
    }
  }, [game.key, baseDir, thirdParty, blocked, attempt])

  const notEnough = !!plan && plan.freeBytes > 0 && plan.freeBytes < plan.installBytes

  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.lodestar.games.install(game.key, thirdParty ? undefined : baseDir)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
      return
    }
    const s = useStore.getState()
    if (thirdParty) {
      s.toast({ kind: 'info', message: `Opening the Epic Games Launcher to install ${game.title}…` })
    } else {
      s.toast({ kind: 'success', message: `${game.title} was added to your downloads` })
      if (shortcut) {
        // The shortcut launches through Lodestar, so it works once the download finishes.
        window.lodestar.games.createShortcut(game.key).catch((e) => s.toast({ kind: 'error', message: `Couldn't create a desktop shortcut: ${errorMessage(e)}` }))
      }
    }
    s.setInstallKey(null)
  }

  const header = (
    <div className="idlg-app">
      <div className="idlg-app-art">
        <Img src={img(game.images.wide ?? game.images.tall, 240)} title={game.title} eager />
      </div>
      <span className="idlg-app-name">{game.title}</span>
      <span className="idlg-app-size">{thirdParty || blocked ? '' : plan ? bytes(plan.installBytes) : planError ? '—' : <span className="idlg-skel" />}</span>
    </div>
  )

  let body: React.JSX.Element
  let footer: React.JSX.Element
  const cancel = (
    <button className="lbtn" onClick={close} disabled={busy}>
      Cancel
    </button>
  )

  if (game.install || (job && !busy) || isLocal(game)) {
    body = (
      <>
        {header}
        <p className="idlg-msg">
          {job
            ? `${game.title} is already in your downloads.`
            : `${game.title} is already installed${game.install?.path ? ` in ${game.install.path}` : ''}.`}
        </p>
      </>
    )
    footer = (
      <>
        {job && (
          <button
            className="lbtn"
            onClick={() => {
              close()
              useStore.getState().navigate({ view: 'downloads' })
            }}
          >
            View downloads
          </button>
        )}
        <button className="lbtn primary" onClick={close}>
          Close
        </button>
      </>
    )
  } else if (unavailable) {
    body = (
      <>
        {header}
        <div className="idlg-note">
          <Monitor size={18} />
          <span>
            {game.title} isn't available on {osName(platform)}. It can only be played on{' '}
            {game.platforms.join(' and ').replace('Mac', 'macOS')}.
          </span>
        </div>
      </>
    )
    footer = (
      <button className="lbtn primary" onClick={close}>
        Close
      </button>
    )
  } else if (thirdParty) {
    body = (
      <>
        {header}
        <div className="idlg-thirdparty">
          <ExternalLink size={20} />
          <div>
            <b>Installs through the Epic Games Launcher</b>
            <p>
              {game.title} is managed by {thirdParty}. Lodestar can't download it directly: it opens the Epic Games Launcher,
              which installs the game with {thirdParty}. Both need to be installed on this PC.
            </p>
            <p className="dim">Once it is installed, Lodestar picks it up and you can play it from here.</p>
          </div>
        </div>
        {error && (
          <div className="idlg-error">
            <CircleAlert size={15} /> {error}
          </div>
        )}
      </>
    )
    footer = (
      <>
        {cancel}
        <button className="lbtn primary" disabled={busy} onClick={() => void install()}>
          {busy && <LoaderCircle size={14} className="spin" />} Open Epic Games Launcher
        </button>
      </>
    )
  } else {
    body = (
      <>
        {header}
        <div className="idlg-space">
          <span>
            Disk space required: <b>{plan ? bytes(plan.installBytes) : '…'}</b>
          </span>
          <span>
            Disk space available: <b className={notEnough ? 'bad' : ''}>{plan ? (plan.freeBytes ? bytes(plan.freeBytes) : 'Unknown') : '…'}</b>
          </span>
          {plan && plan.downloadBytes > 0 && plan.downloadBytes !== plan.installBytes && (
            <span>
              Download size: <b>{bytes(plan.downloadBytes)}</b>
            </span>
          )}
        </div>

        <div className="idlg-label">Install to:</div>
        <div className={`idlg-folder ${notEnough ? 'bad' : ''}`}>
          <span className="idlg-folder-flag">{baseDir === defaultDir ? <Star size={14} fill="currentColor" /> : <HardDrive size={14} />}</span>
          <span className="idlg-folder-path" title={baseDir}>
            {baseDir ?? 'Choose a folder…'}
          </span>
          <span className="idlg-folder-free">
            {notEnough ? (
              <span className="idlg-nospace">
                <TriangleAlert size={13} /> Not enough space
              </span>
            ) : plan?.freeBytes ? (
              `${bytes(plan.freeBytes)} free`
            ) : (
              ''
            )}
          </span>
          <button
            className="lbtn small"
            disabled={busy}
            onClick={async () => {
              const dir = await window.lodestar.app.pickDirectory(baseDir)
              if (dir) setBaseDir(dir)
            }}
          >
            <FolderOpen size={13} /> Change…
          </button>
        </div>
        {plan && (
          <div className="idlg-final mono" title={plan.installPath}>
            {plan.installPath}
          </div>
        )}
        {plan && plan.freeBytes > 0 && <DiskBar plan={plan} notEnough={notEnough} />}

        {planError && (
          <div className="idlg-error">
            <CircleAlert size={15} />
            <span>Couldn't read the game's size: {planError}</span>
            <button className="lbtn small" onClick={() => setAttempt((a) => a + 1)}>
              <RotateCw size={12} /> Retry
            </button>
          </div>
        )}
        {!plan && !planError && (
          <p className="idlg-reading">
            <LoaderCircle className="spin" size={14} /> Reading the build manifest…
          </p>
        )}
        {notEnough && (
          <p className="idlg-warn">
            <TriangleAlert size={14} /> Free up {bytes(plan!.installBytes - plan!.freeBytes)} or choose another drive.
          </p>
        )}

        <div className="idlg-shortcuts">
          <Checkbox
            checked={shortcut}
            onChange={(v) => {
              setShortcut(v)
              try {
                localStorage.setItem(SHORTCUT_KEY, v ? '1' : '0')
              } catch {
                /* ignore */
              }
            }}
            label="Create desktop shortcut"
          />
        </div>
        {error && (
          <div className="idlg-error">
            <CircleAlert size={15} /> <span>{error}</span>
          </div>
        )}
      </>
    )
    footer = (
      <>
        {canLocate(game, job, platform) && (
          <button
            className="idlg-locate"
            disabled={busy}
            onClick={() => {
              close()
              locateInstall(game)
            }}
            title="Already have the game on disk? Point Lodestar at it instead of downloading it again."
          >
            Locate existing install…
          </button>
        )}
        <span className="idlg-spacer" />
        {cancel}
        <button className="lbtn primary idlg-go" disabled={!plan || notEnough || busy} onClick={() => void install()}>
          {busy && <LoaderCircle size={14} className="spin" />} Install
        </button>
      </>
    )
  }

  return (
    <Modal title={`Install ${game.title}`} onClose={close} width={560} footer={footer}>
      <div className="idlg">{body}</div>
    </Modal>
  )
}

/** Free space on the target drive and how much this install takes. */
function DiskBar({ plan, notEnough }: { plan: InstallPlan; notEnough: boolean }): React.JSX.Element {
  const share = Math.min(1, plan.installBytes / plan.freeBytes)
  return (
    <div className={`idlg-disk ${notEnough ? 'bad' : ''}`} title={`${bytes(plan.installBytes)} of ${bytes(plan.freeBytes)} free`}>
      <div style={{ width: `${Math.max(share * 100, 1.5)}%` }} />
    </div>
  )
}
