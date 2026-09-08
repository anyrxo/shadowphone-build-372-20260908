import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke, useIpcEvent } from './ipc'
import { setToast } from './toast'
import { isNewProfile } from './DashContext'
import type { ProfileCtx } from './DashContext'

interface Props {
  ctx: ProfileCtx | null
  onClose: () => void
  onDone: () => void
}

type StatusKind = '' | 'ok' | 'err'

type AccountCreationPreflight = {
  ready?: boolean
  currentUserId?: number | null
  brainReady?: boolean
  phoneBusy?: boolean
  smspoolConfigured?: boolean
  providerConfigured?: boolean
  priceUsd?: number | null
  balance?: number | null
  error?: string | null
}

type AccountCreationResult = {
  success?: boolean
  code?: string
  retryable?: boolean
  manualActionRequired?: boolean
  username?: string
  credentialsPersisted?: boolean
  reconciled?: 'created' | 'released'
  error?: string
}

type AccountCreationStatus = {
  success?: boolean
  code?: string
  pending?: boolean
  userId?: number | null
  credentialsPersisted?: boolean
  running?: boolean
  runningUserId?: number | null
}

type CurrentProfileResult = { success?: boolean; id?: string; error?: string }

export default function CreateIgModal({ ctx, onClose, onDone }: Props) {
  const [visible, setVisible] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [country, setCountry] = useState<'US' | 'GB'>('US')
  const [provider, setProvider] = useState<'smspool' | 'textverified'>('smspool')
  const [maxPrice, setMaxPrice] = useState('0.50')
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [progress, setProgress] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [statusKind, setStatusKind] = useState<StatusKind>('')
  const [busy, setBusy] = useState(false)
  const [preflight, setPreflight] = useState<AccountCreationPreflight | null>(null)
  const [pendingRecovery, setPendingRecovery] = useState(false)
  const [persistedRecovery, setPersistedRecovery] = useState(false)
  const [recoveryProfileId, setRecoveryProfileId] = useState<string | null>(null)
  const [recoveryStatusUnverified, setRecoveryStatusUnverified] = useState(false)
  const knownPaidRecoveryRef = useRef(false)
  const busyRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const userInputRef = useRef<HTMLInputElement>(null)
  const providerName = provider === 'textverified' ? 'TextVerified' : 'SMSPool'
  const maxPriceUsd = Number(maxPrice)
  const validPrice = Number.isFinite(maxPriceUsd) && maxPriceUsd >= 0.01 && maxPriceUsd <= 100
    && Math.abs(maxPriceUsd * 100 - Math.round(maxPriceUsd * 100)) < 1e-8

  function applyRecoveryStatus(recovery: AccountCreationStatus | null, requireRecovery = false) {
    if (requireRecovery || recovery?.pending) knownPaidRecoveryRef.current = true
    const profileId = recovery?.userId ?? recovery?.runningUserId ?? ctx?.userId
    if (profileId != null) setRecoveryProfileId(String(profileId))
    if (recovery?.success !== true || typeof recovery.pending !== 'boolean' || recovery.running === true
      || (knownPaidRecoveryRef.current && !recovery.pending)) {
      setPendingRecovery(true)
      setRecoveryStatusUnverified(true)
      const message = recovery?.code === 'UNAUTHORIZED'
        ? 'Sign in to ShadowPhone, then check recovery status before retrying.'
        : recovery?.running
          ? 'account creation is still running; check recovery status before another action'
          : 'paid attempt status could not be confirmed; check recovery status before retrying'
      setStatus(message)
      setToast(message, 'err')
      setStatusKind('err')
      return true
    }
    setRecoveryStatusUnverified(false)
    setPendingRecovery(recovery.pending)
    setPersistedRecovery(recovery.credentialsPersisted === true)
    if (recovery.pending) {
      const message = recovery.credentialsPersisted
        ? 'credentials are already saved; finish protected local cleanup'
        : 'previous paid attempt needs reconciliation before another purchase'
      setStatus(message)
      setToast(message, 'warn')
      setStatusKind('err')
    }
    return recovery.pending
  }

  async function refreshRecoveryStatus(requireRecovery = false) {
    const recovery = await invoke<AccountCreationStatus>('account-creation:status', { serial: ctx!.serial })
      .catch(() => null)
    return applyRecoveryStatus(recovery, requireRecovery)
  }

  async function handleRecoveryStatusCheck() {
    if (!ctx || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const pending = await refreshRecoveryStatus()
    if (!pending) {
      setStatus('no pending paid attempt; a new account creation can be started')
      setStatusKind('ok')
    }
    busyRef.current = false
    setBusy(false)
  }

  function ciClose() {
    if (busyRef.current) return
    setVisible(false)
    setStatus('')
    setStatusKind('')
    onClose()
  }

  async function openProviderSettings() {
    if (busyRef.current) return
    const result = await invoke<{ success?: boolean; error?: string }>('open-settings').catch(() => null)
    if (!result?.success) {
      setStatus(result?.error || 'Provider settings could not be opened. Try the dashboard Settings button.')
      setStatusKind('err')
    }
  }

  // Open when ctx changes
  useEffect(() => {
    if (!ctx) return
    setUsername('')
    setDisplayName('')
    setPassword('')
    setCountry('US')
    setProvider('smspool')
    setMaxPrice('0.50')
    setProgress([])
    setStatus('')
    setStatusKind('')
    setPreflight(null)
    setPendingRecovery(false)
    setPersistedRecovery(false)
    setRecoveryProfileId(String(ctx.userId))
    setRecoveryStatusUnverified(false)
    knownPaidRecoveryRef.current = false
    setVisible(true)
    const focusTimer = setTimeout(() => userInputRef.current?.focus(), 50)
    return () => clearTimeout(focusTimer)
  }, [ctx])

  useEffect(() => {
    if (!ctx || busyRef.current) return
    let cancelled = false
    if (!validPrice) {
      setPreflight(null)
      setStatus('enter a maximum SMS price from $0.01 to $100 in whole cents')
      setStatusKind('err')
      return
    }
    void Promise.all([
      invoke<AccountCreationPreflight>('account-creation:preflight', {
        serial: ctx.serial,
        userId: ctx.userId,
        checkCapacity: false,
        provider,
        country,
        maxPriceUsd,
      }),
      invoke<AccountCreationStatus>('account-creation:status', { serial: ctx.serial }),
    ]).then(([result, recovery]) => {
      if (cancelled || busyRef.current) return
      setPreflight(result)
      if (applyRecoveryStatus(recovery)) return
      if (result.ready) {
        setStatus(`${providerName} ready${result.balance != null ? ` · $${result.balance.toFixed(2)} available` : ''}`)
        setStatusKind('ok')
      } else if (result.currentUserId != null && String(result.currentUserId) !== String(ctx.userId)) {
        setStatus(`profile ${ctx.userId} will be activated before purchase`)
        setStatusKind('')
      } else {
        setStatus(result.error || 'account-creation preflight is not ready')
        setStatusKind('err')
      }
    }).catch(() => {
      if (cancelled || busyRef.current) return
      applyRecoveryStatus(null)
      setStatus('account-creation preflight is unavailable')
      setStatusKind('err')
    })
    return () => { cancelled = true }
  }, [ctx, provider, providerName, country, maxPriceUsd, validPrice, settingsRevision])

  useIpcEvent('app-setting-changed', (raw) => {
    const payload = raw as { setting?: string }
    if (!ctx || payload?.setting !== 'sms_pool') return
    setSettingsRevision(value => value + 1)
  })

  useIpcEvent('module-progress', (raw) => {
    const payload = raw as {
      moduleId?: string
      deviceId?: string
      profileId?: string | number
      percent?: number
      message?: string
    }
    if (!busyRef.current || !ctx || payload?.moduleId !== 'account_creation_phone') return
    if (payload.deviceId !== ctx.serial || String(payload.profileId) !== String(ctx.userId)) return
    const pct = Number.isFinite(payload.percent) ? `${Math.round(payload.percent as number)}% · ` : ''
    setProgress(lines => [...lines.slice(-19), `${pct}${payload.message || 'working…'}`])
  })

  // Escape key
  useEffect(() => {
    if (!visible) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') ciClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  function onOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) ciClose()
  }

  const handleCreate = useCallback(async () => {
    if (!ctx || busyRef.current) return
    if (pendingRecovery) {
      setStatus('reconcile the previous paid attempt before creating another account')
      setStatusKind('err')
      return
    }
    const { serial, userId } = ctx
    const usernameVal = username.trim().replace(/^@/, '')
    const nameVal = displayName.trim()
    if (!validPrice) {
      setStatus('enter a maximum SMS price from $0.01 to $100 in whole cents')
      setStatusKind('err')
      return
    }
    if (password.length < 8) {
      setStatus('enter a password with at least 8 characters')
      setStatusKind('err')
      return
    }

    busyRef.current = true
    setBusy(true)
    setStatus(`verifying profile ${userId}…`)
    setStatusKind('')

    type SwResult = { success?: boolean; error?: string }
    let current: CurrentProfileResult = await invoke<CurrentProfileResult>('phone:current-profile', { serial })
      .catch((e: Error) => ({ success: false, error: e?.message }))
    if (!current?.success || String(current.id) !== String(userId)) {
      setStatus(`switching once to profile ${userId}…`)
      const sw: SwResult = await invoke<SwResult>('switch-profile', {
        serial,
        profileId: userId,
        completeSetupWizard: true,
        isNewProfile: isNewProfile(serial, userId),
      }).catch((e: Error) => ({ success: false, error: e?.message }))
      if (!sw?.success) {
        busyRef.current = false
        setBusy(false)
        setStatus((sw?.error || 'profile switch failed').slice(0, 90))
        setStatusKind('err')
        return
      }
      current = await invoke<CurrentProfileResult>('phone:current-profile', { serial })
        .catch((e: Error) => ({ success: false, error: e?.message }))
    }
    if (!current?.success || String(current.id) !== String(userId)) {
      busyRef.current = false
      setBusy(false)
      setStatus(`profile ${userId} is not active; account creation stopped`)
      setStatusKind('err')
      return
    }

    setProgress([`Pinned profile ${userId} confirmed`, 'Checking live account capacity under the phone lock'])
    setStatus('creating account — follow the live stages below…')
    setStatusKind('')
    setToast(`starting account creation on profile ${userId}…`, 'warn', { busy: true })

    const result: AccountCreationResult = await invoke<AccountCreationResult>('account-creation:start', {
      serial,
      userId,
      username: usernameVal,
      displayName: nameVal,
      password,
      country,
      provider,
      maxPriceUsd,
    }).catch((): AccountCreationResult => ({ success: false, code: 'IPC_FAILED', retryable: false }))

    if (result.success !== true && result.credentialsPersisted !== true) {
      setProgress(lines => [...lines, result.error || result.code || 'Account creation failed'])
      const requiresRecovery = ['ACCOUNT_CREATION_OUTCOME_UNCERTAIN', 'ACCOUNT_CREATED_UNPERSISTED', 'ACCOUNT_IDENTITY_UNVERIFIED'].includes(result.code || '')
      if (requiresRecovery) setPendingRecovery(true)
      if (result.username && requiresRecovery) setUsername(result.username)
      if (await refreshRecoveryStatus(requiresRecovery)) {
        busyRef.current = false
        setBusy(false)
        return
      }
    }

    // Keep the duplicate-submit guard until the broker reaches a terminal state.
    if (result.success === true && result.credentialsPersisted === true && result.username) {
      setStatus(`created @${result.username} ✓`)
      setStatusKind('ok')
      setToast(`IG account created: @${result.username}`, 'ok')
      setTimeout(() => {
        busyRef.current = false
        setBusy(false)
        setVisible(false)
        setStatus('')
        setStatusKind('')
        onDone()
      }, 1100)
    } else if (result.code === 'ACCOUNT_CREATED_RECOVERY_STATE_WRITE_FAILED' && result.credentialsPersisted === true && result.username) {
      busyRef.current = false
      setBusy(false)
      setUsername(result.username)
      setPendingRecovery(true)
      setPersistedRecovery(false)
      setStatus(`saved @${result.username}; re-enter the exact username and password to reconcile`)
      setStatusKind('err')
      setToast(`@${result.username} is saved, but protected recovery state needs full reconciliation`, 'warn')
      onDone()
    } else if (result.code === 'ACCOUNT_CREATED_STATE_RECONCILIATION_REQUIRED' && result.credentialsPersisted === true && result.username) {
      busyRef.current = false
      setBusy(false)
      setPendingRecovery(true)
      setPersistedRecovery(true)
      setStatus(`saved @${result.username}; finish protected local cleanup`)
      setStatusKind('err')
      setToast(`@${result.username} and its encrypted password are saved; only local cleanup remains`, 'warn')
      onDone()
    } else if (result.manualActionRequired === true && result.credentialsPersisted === true && result.username) {
      busyRef.current = false
      setBusy(false)
      setStatus(`saved @${result.username}; finish verification on the phone`)
      setStatusKind('err')
      setToast(`@${result.username} and its encrypted password were saved — manual Instagram action is required`, 'warn')
      onDone()

    } else {
      busyRef.current = false
      setBusy(false)
      setStatus(result.error || 'account creation failed; review the failed stage below')
      setStatusKind('err')
      setToast((result.error || 'Account creation failed; no credentials were saved').slice(0, 120), 'err')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, username, displayName, password, pendingRecovery, country, provider, maxPriceUsd, validPrice])

  const handleReconcile = useCallback(async (action: 'created' | 'released') => {
    if (!ctx || busyRef.current || !pendingRecovery) return
    const userId = recoveryProfileId || String(ctx.userId)
    const usernameVal = username.trim().replace(/^@+/, '')
    if (action === 'created' && !persistedRecovery && (!usernameVal || password.length < 8)) {
      setStatus('enter the exact on-phone username and its password')
      setStatusKind('err')
      return
    }

    busyRef.current = true
    setBusy(true)
    setStatus(persistedRecovery
      ? `switching to profile ${userId} to finish saved-account cleanup…`
      : `switching to profile ${userId} for recovery…`)
    setStatusKind('')
    const switched = await invoke<{ success?: boolean }>('switch-profile', {
      serial: ctx.serial,
      profileId: userId,
      completeSetupWizard: true,
      isNewProfile: isNewProfile(ctx.serial, userId),
    }).catch(() => ({ success: false }))
    const current: CurrentProfileResult = switched?.success
      ? await invoke<{ success?: boolean; id?: string }>('phone:current-profile', { serial: ctx.serial })
        .catch((): CurrentProfileResult => ({ success: false }))
      : { success: false }
    if (!current?.success || String(current.id) !== String(userId)) {
      busyRef.current = false
      setBusy(false)
      setStatus(`profile ${userId} is not active; recovery stopped`)
      setStatusKind('err')
      return
    }

    const result: AccountCreationResult = await invoke<AccountCreationResult>('account-creation:reconcile', {
      action,
      serial: ctx.serial,
      userId,
      ...(action === 'created' && !persistedRecovery
        ? { username: usernameVal, password }
        : {}),
    }).catch((): AccountCreationResult => ({ success: false, code: 'IPC_FAILED' }))
    setPassword('')
    busyRef.current = false
    setBusy(false)
    if (result.success === true && result.reconciled === 'created' && result.credentialsPersisted && result.username) {
      const finishedSavedCleanup = persistedRecovery
      knownPaidRecoveryRef.current = false
      setPendingRecovery(false)
      setPersistedRecovery(false)
      setStatus(finishedSavedCleanup
        ? `finished saved-account cleanup for @${result.username}`
        : `reconciled and saved @${result.username}`)
      setStatusKind('ok')
      setToast(finishedSavedCleanup
        ? `Saved IG account is ready: @${result.username}`
        : `Recovered IG account: @${result.username}`, 'ok')
      onDone()
    } else if (result.success === true && result.reconciled === 'released') {
      knownPaidRecoveryRef.current = false
      setPendingRecovery(false)
      setPersistedRecovery(false)
      setStatus('refunded SMS attempt released; a new run is now allowed')
      setStatusKind('ok')
      setToast('Refunded account-creation attempt safely released', 'ok')
    } else if (result.code === 'ACCOUNT_IDENTITY_UNVERIFIED') {
      setStatus('that exact username was not observed on this phone profile')
      setStatusKind('err')
    } else if (result.code === 'SMSPOOL_OUTCOME_UNVERIFIED' || result.code === 'SMS_PROVIDER_OUTCOME_UNVERIFIED') {
      setStatus('the SMS provider has not confirmed that order was cancelled or refunded')
      setStatusKind('err')
    } else if (result.code === 'ACCOUNT_CREATED_RECOVERY_STATE_WRITE_FAILED' && result.credentialsPersisted === true) {
      setPersistedRecovery(false)
      setStatus('credentials are saved, but recovery state still needs the exact username and password')
      setStatusKind('err')
    } else {
      setStatus('reconciliation was not confirmed; paid state remains protected')
      setStatusKind('err')
    }
  }, [ctx, password, pendingRecovery, persistedRecovery, recoveryProfileId, username, onDone])

  if (!visible || !ctx) return null

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
        aria-labelledby="ciTitle"
        style={{ width: 'min(460px, 92vw)' }}
      >
        <div className="cfg-head">
          <div>
            <h2 id="ciTitle">Create IG account</h2>
            <div className="cfg-sub">{ctx.serial} · profile {pendingRecovery ? recoveryProfileId || ctx.userId : ctx.userId}</div>
          </div>
          <button className="cfg-x" title="Close" disabled={busy} onClick={ciClose}>&times;</button>
        </div>

        <div className="cfg-body">
          <button className="cfg-btn" disabled={busy} onClick={openProviderSettings}>SMS provider settings</button>
          {!persistedRecovery && <label className="ci-label">
            Username <span className="ci-opt">{pendingRecovery ? '(exact username shown on phone)' : '(optional — auto-generated if blank)'}</span>
            <input
              ref={userInputRef}
              type="text"
              className="ci-input"
              placeholder="e.g. ava.rose"
              autoComplete="off"
              spellCheck={false}
              value={username}
              disabled={busy}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            />
          </label>}
          {!pendingRecovery && <label className="ci-label">
            Display name <span className="ci-opt">(optional)</span>
            <input
              type="text"
              className="ci-input"
              placeholder="e.g. Ava"
              autoComplete="off"
              value={displayName}
              disabled={busy}
              onChange={e => setDisplayName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            />
          </label>}
          {!persistedRecovery && <label className="ci-label">
            Password <span className="ci-opt">(required — saved encrypted)</span>
            <input
              type="password"
              className="ci-input"
              placeholder="Password for the new Instagram account"
              autoComplete="new-password"
              value={password}
              disabled={busy}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            />
          </label>}
          {!pendingRecovery && <label className="ci-label">
            SMS provider
            <select className="ci-input" value={provider} disabled={busy} onChange={e => {
              const selected = e.target.value as 'smspool' | 'textverified'
              setProvider(selected)
              if (selected === 'textverified') setCountry('US')
            }}>
              <option value="smspool">SMSPool</option>
              <option value="textverified">TextVerified</option>
            </select>
          </label>}
          {!pendingRecovery && <label className="ci-label">
            SMS number country
            <select
              className="ci-input"
              value={country}
              disabled={busy}
              onChange={e => setCountry(e.target.value as 'US' | 'GB')}
            >
              <option value="US">United States (+1)</option>
              {provider === 'smspool' && <option value="GB">United Kingdom (+44)</option>}
            </select>
          </label>}
          {!pendingRecovery && <label className="ci-label">
            Maximum SMS price (USD)
            <input type="number" className="ci-input" min="0.01" max="100" step="0.01"
              value={maxPrice} disabled={busy} onChange={e => setMaxPrice(e.target.value)} />
          </label>}
          <p className="ci-note">
            {persistedRecovery
              ? <>The account credentials are already saved encrypted. Finish saved cleanup removes only the protected local recovery marker; it does not purchase another number or save credentials again.</>
              : pendingRecovery
              ? <>No new number will be purchased. Confirm created checks the exact username on the phone before saving. Release refunded checks the original SMS provider before clearing the pending run.</>
              : <>Uses your own {providerName} credentials from App Settings. Pins the phone to <b>profile {ctx.userId}</b>, checks its account capacity, and purchases one {country} number up to {validPrice ? `$${maxPriceUsd.toFixed(2)}` : 'your spending cap'}. Verification may require action on the phone.{preflight?.balance != null ? ` Live balance: $${preflight.balance.toFixed(2)}.` : ''}</>}
          </p>
          {progress.length > 0 && <div className="ci-progress" role="status" aria-live="polite">
            {progress.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
          </div>}
        </div>

        <div className="cfg-foot">
          <span className={`cfg-status${statusKind ? ' ' + statusKind : ''}`}>{status}</span>
          <span className="cfg-spacer" />
          <button className="cfg-btn" disabled={busy} onClick={ciClose}>{busy ? 'In progress…' : 'Cancel'}</button>
          {recoveryStatusUnverified
            ? <button className="cfg-btn cfg-primary" disabled={busy} onClick={handleRecoveryStatusCheck}>Check recovery status</button>
            : persistedRecovery
            ? <button className={`cfg-btn cfg-primary${busy ? ' busy' : ''}`} disabled={busy} onClick={() => handleReconcile('created')}>Finish saved cleanup</button>
            : pendingRecovery ? <>
            <button className="cfg-btn" disabled={busy} onClick={() => handleReconcile('released')}>Release refunded</button>
            <button className={`cfg-btn cfg-primary${busy ? ' busy' : ''}`} disabled={busy} onClick={() => handleReconcile('created')}>Confirm created</button>
          </> : <button
              className={`cfg-btn cfg-primary${busy ? ' busy' : ''}`}
              disabled={busy}
              onClick={handleCreate}
            >
              Create account
            </button>}
        </div>
      </div>
    </div>
  )
}
