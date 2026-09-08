import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { invoke } from './ipc'
import { setToast } from './toast'
import {
  buildEditProfilePayload,
  describeEditProfileSuccess,
  type EditProfileContext,
  type EditProfileForm,
} from './edit-profile-payload'

interface Props {
  ctx: EditProfileContext | null
  onClose: () => void
  onSaved?: () => void | Promise<void>
}

interface EditProfileResult {
  success?: boolean
  status?: string
  completed?: string[]
  failed?: string
  error?: string
  account?: string
  warnings?: string[]
}

const emptyForm: EditProfileForm = {
  name: '',
  username: '',
  bio: '',
  changePicture: false,
  convertToBusiness: false,
  category: 'Digital creator',
}

const mutationSteps = [
  { key: 'profile_picture', label: 'Photo' },
  { key: 'name', label: 'Name' },
  { key: 'bio', label: 'Bio' },
  { key: 'professional', label: 'Business' },
  { key: 'username', label: 'Username' },
]

export default function EditProfileModal({ ctx, onClose, onSaved }: Props) {
  const [form, setForm] = useState<EditProfileForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('Select only the fields you want to change.')
  const [result, setResult] = useState<EditProfileResult | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!ctx) return
    setForm({ ...emptyForm, username: ctx.account })
    setSaving(false)
    setResult(null)
    setStatus('Select only the fields you want to change.')
  }, [ctx])

  const close = useCallback(() => {
    if (busyRef.current) return
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!ctx) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ctx, close])

  const payload = useMemo(
    () => ctx ? buildEditProfilePayload(ctx, form) : null,
    [ctx, form],
  )
  const requested = useMemo(() => new Set([
    ...(form.changePicture ? ['profile_picture'] : []),
    ...(form.name.trim() ? ['name'] : []),
    ...(form.bio.trim() ? ['bio'] : []),
    ...(form.convertToBusiness ? ['professional'] : []),
    ...(ctx && form.username.trim().replace(/^@+/, '').toLowerCase() !== ctx.account.toLowerCase() ? ['username'] : []),
  ]), [ctx, form])

  async function save() {
    if (!ctx || !payload || saving) return
    const username = form.username.trim().replace(/^@+/, '').toLowerCase()
    if (username && !/^[a-z0-9._]{1,30}$/.test(username)) {
      setStatus('Username can use letters, numbers, periods, and underscores only.')
      setResult({ success: false, status: 'invalid_request', failed: 'username' })
      return
    }
    if (!requested.size) {
      setStatus('Choose at least one profile change.')
      return
    }

    busyRef.current = true
    setSaving(true)
    setResult(null)
    setStatus('Verifying phone, Android profile, and Instagram account…')
    const response: EditProfileResult = await invoke<EditProfileResult>('dashboard:edit-profile', payload)
      .catch((error: Error): EditProfileResult => ({ success: false, status: 'failed', error: error?.message }))
    busyRef.current = false
    setSaving(false)
    setResult(response)

    if (response.success) {
      const nextHandle = response.account || username || ctx.account
      const feedback = describeEditProfileSuccess({ ...response, account: nextHandle }, requested.size)
      setStatus(feedback.status)
      setToast(feedback.toast, feedback.toastKind)
      await onSaved?.()
      if (feedback.autoClose) setTimeout(close, 1100)
      return
    }

    if (response.status === 'checkpoint') {
      setStatus('Instagram needs manual verification on the phone. No remaining changes were attempted.')
    } else if (response.status === 'partial') {
      setStatus(`Some changes saved. ${response.error || 'Retry the failed field after checking the phone.'}`)
      await onSaved?.()
    } else {
      setStatus(response.error || 'Instagram did not confirm the requested changes.')
    }
    setToast((response.error || 'Profile update was not verified.').slice(0, 100), 'err')
  }

  if (!ctx) return null

  return (
    <div
      ref={overlayRef}
      className="cfg-overlay show"
      onClick={(event) => { if (event.target === overlayRef.current) close() }}
    >
      <div className="cfg-card ep-card" role="dialog" aria-modal="true" aria-labelledby="ep-title">
        <div className="cfg-head ep-head">
          <div>
            <div className="ep-kicker">Instagram identity</div>
            <h2 id="ep-title">Edit profile</h2>
            <div className="cfg-sub">Changes execute live on the selected physical phone.</div>
          </div>
          <button className="cfg-x" title="Close" aria-label="Close" onClick={close}>&times;</button>
        </div>

        <div className="ep-locator" aria-label="Selected account">
          <span><b>Phone</b>{ctx.serial}</span>
          <span><b>Android user</b>{ctx.userId}</span>
          <span><b>Instagram</b>@{ctx.account}</span>
        </div>

        <div className="cfg-body ep-body">
          <div className="ep-fields">
            <label className="ci-label">
              Display name <span className="ci-opt">leave blank to keep</span>
              <input
                className="ci-input"
                value={form.name}
                maxLength={64}
                placeholder="New public display name"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>

            <label className="ci-label">
              Username <span className="ci-opt">runs last</span>
              <div className="ep-username-input">
                <span>@</span>
                <input
                  className="ci-input"
                  value={form.username}
                  maxLength={30}
                  spellCheck={false}
                  onChange={(event) => setForm({ ...form, username: event.target.value.replace(/^@+/, '') })}
                />
              </div>
            </label>

            <label className="ci-label">
              Bio <span className="ci-opt">leave blank to keep</span>
              <textarea
                className="ci-input ep-bio"
                value={form.bio}
                maxLength={150}
                placeholder="Updated Instagram bio"
                onChange={(event) => setForm({ ...form, bio: event.target.value })}
              />
              <span className="ep-count">{form.bio.length}/150</span>
            </label>

            <div className="ep-options">
              <label className="ep-option">
                <input
                  type="checkbox"
                  checked={form.changePicture}
                  onChange={(event) => setForm({ ...form, changePicture: event.target.checked })}
                />
                <span><b>Change profile picture</b><small>Choose the image when the run starts.</small></span>
              </label>
              <label className="ep-option">
                <input
                  type="checkbox"
                  checked={form.convertToBusiness}
                  onChange={(event) => setForm({ ...form, convertToBusiness: event.target.checked })}
                />
                <span><b>Activate Business profile</b><small>Success requires a verified Professional Dashboard.</small></span>
              </label>
            </div>

            {form.convertToBusiness && (
              <label className="ci-label ep-category">
                Professional category
                <input
                  className="ci-input"
                  value={form.category}
                  maxLength={40}
                  onChange={(event) => setForm({ ...form, category: event.target.value })}
                />
              </label>
            )}

            {requested.has('username') && (
              <div className="ep-warning">
                Username changes run last. Local schedules, media, and insight history move only after Instagram confirms the new handle.
              </div>
            )}
          </div>

          <aside className="ep-manifest" aria-label="Execution order">
            <div className="ep-manifest-title">Safe execution order</div>
            <ol>
              {mutationSteps.map((step, index) => {
                const complete = result?.completed?.includes(step.key)
                const failed = result?.failed === step.key
                const active = requested.has(step.key)
                return (
                  <li key={step.key} className={`${active ? 'active' : ''}${complete ? ' complete' : ''}${failed ? ' failed' : ''}`}>
                    <span className="ep-step-index">{String(index + 1).padStart(2, '0')}</span>
                    <span>{step.label}</span>
                    <i>{complete ? 'verified' : failed ? 'failed' : active ? 'queued' : 'skip'}</i>
                  </li>
                )
              })}
            </ol>
            <p>Every run verifies the Android user and exact foreground handle before editing.</p>
          </aside>
        </div>

        <div className="cfg-foot ep-foot">
          <span className={`cfg-status ${result?.status === 'partial_sync' ? 'hint' : result?.success ? 'ok' : result && !result.success ? 'err' : 'hint'}`}>{status}</span>
          <span className="cfg-spacer" />
          <button className="cfg-btn" disabled={saving} onClick={close}>Cancel</button>
          <button className={`cfg-btn cfg-primary${saving ? ' busy' : ''}`} disabled={saving} onClick={save}>
            {saving ? 'Running live…' : 'Save verified changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
