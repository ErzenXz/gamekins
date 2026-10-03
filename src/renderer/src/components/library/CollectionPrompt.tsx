import { useEffect, useState } from 'react'
import { collectionNameError, createCollection, renameCollection } from '../../lib/gameActions'
import { useStore } from '../../store'
import { Modal } from '../Modal'
import { useCollections } from './libraryData'

/** "New collection…" / "Rename collection…" name prompt, driven by `store.collectionPrompt`. */
export function CollectionPrompt(): React.JSX.Element | null {
  const prompt = useStore((s) => s.collectionPrompt)
  const names = useCollections()
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setName(prompt?.mode === 'rename' ? (prompt.name ?? '') : '')
    setTouched(false)
    setBusy(false)
  }, [prompt])

  if (!prompt) return null
  const close = (): void => {
    if (!busy) useStore.getState().setCollectionPrompt(null)
  }
  const rename = prompt.mode === 'rename'
  const unchanged = rename && name.trim() === prompt.name
  const error = unchanged ? null : collectionNameError(name, names, rename ? prompt.name : undefined)
  const count = prompt.gameKeys?.length ?? 0

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (error || busy) return
    if (unchanged) return close()
    setBusy(true)
    try {
      const succeeded = rename ? await renameCollection(prompt.name!, name) : await createCollection(name, prompt.gameKeys)
      if (succeeded) useStore.getState().setCollectionPrompt(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={rename ? 'Rename collection' : 'Create a new collection'}
      onClose={close}
      width={460}
      footer={
        <>
          <button className="lbtn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="lbtn primary" disabled={busy || (touched && !!error) || !name.trim()} onClick={() => void submit()}>
            {rename ? 'Rename' : 'Create collection'}
          </button>
        </>
      }
    >
      <form
        className="cprompt"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <p className="cprompt-text">
          {rename
            ? `Choose a new name for ${prompt.name}.`
            : count
              ? `Name your collection. ${count === 1 ? 'This game' : `These ${count} games`} will be added to it.`
              : 'Name your collection. You can add games to it by right-clicking them.'}
        </p>
        <label className="ldialog-label" htmlFor="cprompt-name">
          Collection name
        </label>
        <input
          id="cprompt-name"
          className="ltext"
          data-autofocus
          value={name}
          maxLength={80}
          placeholder="e.g. Co-op night"
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value)
            setTouched(true)
          }}
        />
        <div className="cprompt-error" aria-live="polite">
          {touched && error ? error : ''}
        </div>
      </form>
    </Modal>
  )
}
