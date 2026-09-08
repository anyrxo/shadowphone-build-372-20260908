import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from './ipc'
import { setToast } from './toast'
import { markNewProfile } from './DashContext'

interface Props {
  serial: string | null
  onClose: () => void
  onDone: () => void
}

type StatusKind = '' | 'ok' | 'err'

export default function AddProfileModal({ serial, onClose, onDone }: Props) {
  const visible = !!serial

  const [profileName, setProfileName] = useState('')
  const [status, setStatus] = useState('')
  const [statusKind, setStatusKind] = useState<StatusKind>('')
  const busyRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  function apClose() {
    if (busyRef.current) return
    setProfileName('')
    setStatus('')
    setStatusKind('')
    onClose()
  }

  // Focus input when opening
  useEffect(() => {
    if (!visible) return
    busyRef.current = false
    setProfileName('')
    setStatus('')
    setStatusKind('')
    setTimeout(() => nameInputRef.current?.focus(), 50)
  }, [visible])

  // Escape key
  useEffect(() => {
    if (!visible) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') apClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  function onOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) apClose()
  }

  const handleCreate = useCallback(async () => {
    if (!serial || busyRef.current) return
    const name = profileName.trim()
    if (!name) { setStatus('enter a profile name'); setStatusKind('err'); return }

    busyRef.current = true
    setStatus(`creating profile on ${serial}…`)
    setStatusKind('')

    type CreateResult = { success?: boolean; userId?: number; error?: string }
    const r: CreateResult = await invoke<CreateResult>('create-profile', serial, name, { copyAllApps: true })
      .catch((e: Error) => ({ success: false, error: e?.message }))

    busyRef.current = false

    if (r?.success) {
      setStatus(`created (user ${r.userId}) ✓`)
      setStatusKind('ok')
      setToast(`profile created (user ${r.userId})`, 'ok')
      if (r.userId != null) markNewProfile(serial, r.userId)
      setTimeout(() => {
        setProfileName('')
        setStatus('')
        setStatusKind('')
        onDone()
      }, 900)
    } else {
      setStatus((r?.error || 'create-profile failed').slice(0, 90))
      setStatusKind('err')
      setToast((r?.error || 'create-profile failed').slice(0, 80), 'err')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, profileName])

  if (!visible || !serial) return null

  return (
    <div
      ref={overlayRef}
      className="cfg-overlay show"
      onClick={onOverlayClick}
    >
      <div
        className="cfg-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apTitle"
        style={{ width: 'min(440px, 92vw)' }}
      >
        <div className="cfg-head">
          <div>
            <h2 id="apTitle">Add profile</h2>
            <div className="cfg-sub">{serial}</div>
          </div>
          <button className="cfg-x" title="Close" onClick={apClose}>&times;</button>
        </div>

        <div className="cfg-body">
          <label className="ci-label">
            Profile name
            <input
              ref={nameInputRef}
              type="text"
              className="ci-input"
              placeholder="e.g. ava-rose"
              autoComplete="off"
              spellCheck={false}
              value={profileName}
              onChange={e => setProfileName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreate() } }}
            />
          </label>
          <p className="ci-note">
            Creates a new GrapheneOS profile on <b>{serial}</b> (all apps copied in). Takes a few seconds.
          </p>
        </div>

        <div className="cfg-foot">
          <span className={`cfg-status${statusKind ? ' ' + statusKind : ''}`}>{status}</span>
          <span className="cfg-spacer" />
          <button className="cfg-btn" onClick={apClose}>Cancel</button>
          <button
            className={`cfg-btn cfg-primary${busyRef.current ? ' busy' : ''}`}
            disabled={busyRef.current}
            onClick={handleCreate}
          >
            Create profile
          </button>
        </div>
      </div>
    </div>
  )
}
