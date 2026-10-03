import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Modal } from './Modal'

/**
 * Steam-style confirmation: [Primary] [Cancel]. Destructive ones get the red focus line and
 * focus Cancel, so a stray Enter can't delete anything. While the action runs the dialog can't
 * be dismissed and shows a throbber.
 */
export function ConfirmDialog(): React.JSX.Element | null {
  const confirm = useStore((s) => s.confirm)
  const setConfirm = useStore((s) => s.setConfirm)
  const [busy, setBusy] = useState(false)
  useEffect(() => setBusy(false), [confirm])
  if (!confirm) return null

  const close = (): void => {
    if (!busy) setConfirm(null)
  }
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      await confirm.onConfirm()
    } finally {
      setBusy(false)
      // Only close the dialog this action belonged to (onConfirm may have opened another).
      if (useStore.getState().confirm === confirm) setConfirm(null)
    }
  }

  return (
    <Modal
      title={confirm.title}
      onClose={close}
      width={confirm.danger ? 600 : 500}
      danger={confirm.danger}
      dismissable={!busy}
      footer={
        <>
          <button
            className="btn btn-blue"
            disabled={busy}
            onClick={() => void run()}
            data-autofocus={confirm.danger ? undefined : true}
          >
            {confirm.confirmLabel}
          </button>
          <button className="btn btn-ghost" onClick={close} disabled={busy} data-autofocus={confirm.danger || undefined}>
            Cancel
          </button>
        </>
      }
    >
      {busy ? (
        <div className="confirm-busy">
          <span className="throbber" />
          <span>Working…</span>
        </div>
      ) : (
        <p className="confirm-text pre">{confirm.message}</p>
      )}
    </Modal>
  )
}
