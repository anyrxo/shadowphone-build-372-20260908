import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from './ipc'
import { setToast } from './toast'
import type { ProfileCtx } from './DashContext'

interface Props {
  ctx: ProfileCtx | null
  onClose: () => void
  onDone: () => void
}

type StatusKind = '' | 'ok' | 'err'

export default function DeleteModal({ ctx, onClose, onDone }: Props) {
  const [visible, setVisible] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const [status, setStatus] = useState('')
  const [statusKind, setStatusKind] = useState<StatusKind>('')
  const [busy, setBusy] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function delClose() {
    if (busy) return
    setVisible(false)
    setConfirmInput('')
    setStatus('')
    setStatusKind('')
    onClose()
  }

  // Open when ctx changes
  useEffect(() => {
    if (!ctx) return
    setBusy(false)
    setConfirmInput('')
    setStatus('')
    setStatusKind('')
    setVisible(true)
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [ctx])

  // Escape key
  useEffect(() => {
    if (!visible) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') delClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, busy])

  function onOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) delClose()
  }

  const target = ctx?.name ?? ''
  const confirmed = confirmInput.trim() === target

  const handleDelete = useCallback(async () => {
    if (!ctx || busy || !confirmed) return
    const { serial, userId, name } = ctx
    setBusy(true)
    setStatus('removing profile + content…')
    setStatusKind('')

    type DeleteResult = { success?: boolean; error?: string }
    const r: DeleteResult = await invoke<DeleteResult>('delete-profile', serial, userId)
      .catch((e: Error) => ({ success: false, error: e?.message }))

    if (r?.success) {
      setStatus('deleted ✓')
      setStatusKind('ok')
      setToast(`profile "${name}" deleted ✓`, 'ok')
      setBusy(false)
      setVisible(false)
      onDone()
    } else {
      setBusy(false)
      setStatus((r?.error || 'delete failed').slice(0, 120))
      setStatusKind('err')
      setToast((r?.error || 'delete failed').slice(0, 80), 'err')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, busy, confirmed])

  if (!visible || !ctx) return null

  const acctTxt = ctx.accountCount === 1 ? '1 IG account' : `${ctx.accountCount} IG accounts`

  return (
    <div
      ref={overlayRef}
      className="cfg-overlay show"
      onClick={onOverlayClick}
    >
      <div
        className="cfg-card del-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delTitle"
        style={{ width: 'min(540px, 92vw)' }}
      >
        <div className="cfg-head">
          <div>
            <h2 id="delTitle" className="del-title">Delete profile</h2>
            <div className="cfg-sub">{ctx.serial} · {ctx.name} (profile {ctx.userId})</div>
          </div>
          <button className="cfg-x" title="Close" onClick={delClose}>&times;</button>
        </div>

        <div className="cfg-body">
          <div className="del-callout">
            <span className="del-icon">&#9888;</span>
            <span className="del-lead">
              This will permanently delete <b>{ctx.name}</b> and its <b>{acctTxt}</b> with all their content.
            </span>
          </div>
          <ul className="del-consequences">
            <li>Permanently removes the GrapheneOS profile <b>and all of its content</b> (images, reels, stories, captions).</li>
            <li>This <b>cannot be undone</b>.</li>
            <li>If the phone is currently on this profile it will switch to owner (airplane-wrapped) first — this can take ~30–60s.</li>
          </ul>
          <label className="del-confirm-label" htmlFor="delConfirmInput">
            Type the profile name <b>{ctx.name}</b> to confirm:
          </label>
          <input
            ref={inputRef}
            id="delConfirmInput"
            className="find-input del-confirm-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="profile name…"
            value={confirmInput}
            disabled={busy}
            onChange={e => setConfirmInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && confirmed && !busy) handleDelete() }}
          />
        </div>

        <div className="cfg-foot">
          <span className={`cfg-status${statusKind ? ' ' + statusKind : ''}`}>{status}</span>
          <span className="cfg-spacer" />
          <button className="cfg-btn" disabled={busy} onClick={delClose}>Cancel</button>
          <button
            className={`cfg-btn cfg-danger${busy ? ' busy' : ''}`}
            disabled={!confirmed || busy}
            onClick={handleDelete}
          >
            {busy ? 'deleting… (can take ~60s)' : 'Delete profile'}
          </button>
        </div>
      </div>
    </div>
  )
}
