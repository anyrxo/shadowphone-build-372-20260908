/**
 * BulkCreateModal — Phase 5
 *
 * Two panels rendered in sequence:
 *   1) Config panel — shows qualifying/preview, name list, balance floor, cooldown, max-count
 *   2) Progress panel — shows per-profile rows + totals; driven by live
 *      bulk:progress events with bulk:status polling as a fallback/reconcile
 *
 * Progress is tenant-scoped; status polling recovers missed updates.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke, useIpcEvent } from './ipc'
import { setToast } from './toast'
import type { BulkStatusResult, BulkProgressEvent } from './types'

type Panel = 'config' | 'progress' | 'none'

const POLL_MS = 2000

interface ProgressRow {
  userId: string | number
  text: string
}

interface Props {
  serial: string | null
  onClose: () => void
  onDone: () => void
}

// ── Phase label map (mirrors HTML:3989-3998) ────────────────────────────────
function phaseText(p: { phase: string; handle?: string; username?: string; error?: string }): string {
  const { phase, handle, username, error } = p
  if (phase === 'created')         return `✓ created @${handle || ''}`
  if (phase === 'has-account')     return '↷ already has an account — skipped'
  if (phase === 'flagged')         return '⚠ flagged / needs verification — cooled'
  if (phase === 'manual-reconciliation-required') return error || 'Recover this exact profile before retrying'
  if (phase === 'cooled')          return `cooled (${error || ''})`
  if (phase === 'aborted')         return `■ ${error || 'aborted'}`
  if (phase === 'switching')       return '… switching profile'
  if (phase === 'creating')        return `… creating${username ? ' @' + username : ''}`
  return phase
}

// ── Reason label map (mirrors HTML:4001-4010) ───────────────────────────────
function reasonText(reason: string): string {
  const MAP: Record<string, string> = {
    'all-qualifying-done': 'all qualifying profiles done',
    'all-cooling':         'all remaining profiles cooling — resume later',
    'balance-floor':       'SMS provider balance floor reached',
    'balance-unknown':     'SMS provider balance unavailable — paused',
    'account-creation-outcome-uncertain': 'account creation needs recovery before another attempt',
    'legacy-paid-recovery-required': 'an older paid attempt needs manual reconciliation; preserve its recovery record',
    'recovery-status-unavailable': 'recovery status unavailable — sign in and check Create IG Account',
    'session-changed': 'sign-in changed — run stopped',
    'preflight-failed': 'provider or phone preflight failed — check Create IG Account and SMS settings',
    'profile-capacity-unverified': 'empty Instagram profile could not be verified — run stopped',
    'max-count':           'hit max-accounts cap',
    'phone-busy':          'phone busy (scheduled task) — try again',
    'stopped':             'stopped by operator',
  }
  return MAP[reason] || reason
}

export default function BulkCreateModal({ serial, onClose, onDone }: Props) {
  const [panel, setPanel] = useState<Panel>('none')

  // ── Config panel state ────────────────────────────────────────────────────
  const [previewText, setPreviewText] = useState('loading qualifying profiles…')
  const [resumeText, setResumeText] = useState('')
  const [names, setNames] = useState('')
  const [balanceFloor, setBalanceFloor] = useState('0.50')
  const [cooldown, setCooldown] = useState('24')
  const [maxCount, setMaxCount] = useState('')
  const [cfgStatus, setCfgStatus] = useState('')
  const [provider, setProvider] = useState('smspool')
  const [country, setCountry] = useState('US')
  const [maxPrice, setMaxPrice] = useState('0.50')
  const [recoveryUserId, setRecoveryUserId] = useState<number | null>(null)

  // ── Progress panel state ──────────────────────────────────────────────────
  const [rows, setRows] = useState<ProgressRow[]>()
  const [totalsText, setTotalsText] = useState('')
  const [progStatus, setProgStatus] = useState('')
  const [progStatusKind, setProgStatusKind] = useState<'' | 'err'>('')
  const [running, setRunning] = useState(false)

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollGenerationRef = useRef(0)
  const resumeRef = useRef(false)
  const runningRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  // ── Open: fetch status + preview ─────────────────────────────────────────
  useEffect(() => {
    if (!serial) { setPanel('none'); return }
    setPreviewText('loading qualifying profiles…')
    setResumeText('')
    setNames('')
    setBalanceFloor('0.50')
    setCooldown('24')
    setMaxCount('')
    setCfgStatus('')
    setProvider('smspool')
    setCountry('US')
    setMaxPrice('0.50')
    setRecoveryUserId(null)
    runningRef.current = false
    setRunning(false)
    setPanel('config')

    // Check for resumable prior run
    invoke<BulkStatusResult>('bulk:status', { serial })
      .then(st => {
        if (st?.recoveryUserId != null) setRecoveryUserId(st.recoveryUserId)
        if (st?.active) { runningRef.current = true; setRunning(true); setPanel('progress') }
        if (st?.interrupted) {
          const created = st.totals?.created ?? 0
          setResumeText(`A previous run was interrupted — Run will resume it. (Created so far: ${created})`)
          resumeRef.current = true
        } else {
          resumeRef.current = false
        }
      })
      .catch(() => { resumeRef.current = false })

  }, [serial])

  useEffect(() => {
    if (!serial) return
    let cancelled = false
    invoke<{ ok?: boolean; error?: string; estCount?: number; estSpend?: number; cooled?: unknown[] }>('bulk:preview', {
      serial, config: { provider, country, maxPriceUsd: Number(maxPrice) },
    })
      .then(pv => {
        if (cancelled) return
        if (pv?.ok) {
          const cooledCount = (pv.cooled ?? []).length
          setPreviewText(
            `${pv.estCount} qualifying · at most $${pv.estSpend} at this price cap · balance and exact price checked before each attempt` +
            (cooledCount ? ` · ${cooledCount} cooling` : '')
          )
        } else {
          setPreviewText(pv?.error || 'could not load preview')
        }
      })
      .catch(() => { if (!cancelled) setPreviewText('could not load preview') })
    return () => { cancelled = true }
  }, [serial, provider, country, maxPrice])

  // ── Escape key (close config panel; stop if in progress) ─────────────────
  useEffect(() => {
    if (panel === 'none') return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (panel === 'config') handleConfigClose()
        else handleProgressClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel])

  // ── Polling bulk:status while running ────────────────────────────────────
  const poll = useCallback(async () => {
    if (!serial) return
    const generation = pollGenerationRef.current
    const st = await invoke<BulkStatusResult>('bulk:status', { serial }).catch(() => null)
    if (generation !== pollGenerationRef.current) return
    if (!st?.ok) {
      setProgStatus(st?.error || 'Run status is unavailable. Check sign-in and reopen this run before retrying.')
      setProgStatusKind('err')
      pollRef.current = setTimeout(poll, POLL_MS)
      return
    }
    if (st.active) {
      // still running — schedule next poll
      pollRef.current = setTimeout(poll, POLL_MS)
    } else {
      // run ended
      setRunning(false)
      runningRef.current = false
      setRecoveryUserId(st.recoveryUserId ?? null)
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
      if (st.totals) {
        const t = st.totals
        setTotalsText(`Run ended — ${reasonText(st.reason || 'done')} · created ${t.created} · skipped ${t.skipped ?? 0} · cooled ${t.cooled}`)
      }
    }
  }, [serial])

  useEffect(() => {
    if (!running || !serial) return
    pollRef.current = setTimeout(poll, POLL_MS)
    return () => {
      pollGenerationRef.current++
      if (pollRef.current) clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [running, serial, poll])

  // ── Subscribe to bulk:progress (now broadcast to all windows → fires live here) ──
  useIpcEvent('bulk:progress', (...args: unknown[]) => {
    const p = args[0] as BulkProgressEvent
    if (!p || p.serial !== serial) return
    if (p.ev === 'profile') {
      const rowText = `profile ${p.userId}${p.name ? ' · ' + p.name : ''} — ${phaseText(p)}`
      setRows(prev => {
        const updated = [...(prev ?? [])]
        const idx = updated.findIndex(r => String(r.userId) === String(p.userId))
        if (idx >= 0) updated[idx] = { userId: p.userId, text: rowText }
        else updated.push({ userId: p.userId, text: rowText })
        return updated
      })
    } else if (p.ev === 'run-complete') {
      const t = p.totals
      setTotalsText(`Run ended — ${reasonText(p.reason)} · created ${t.created} · skipped ${t.skipped ?? 0} · cooled ${t.cooled}`)
      setRunning(false)
      runningRef.current = false
      setRecoveryUserId(p.recoveryUserId ?? null)
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
    } else if (p.ev === 'run-error') {
      setProgStatus(p.error || 'run error')
      setProgStatusKind('err')
      setRunning(false)
      runningRef.current = false
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
    }
  })

  // Cleanup poll on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearTimeout(pollRef.current) }
  }, [])

  // ── Config panel actions ──────────────────────────────────────────────────
  function handleConfigClose() {
    setPanel('none')
    onClose()
  }

  async function handleRun() {
    if (!serial || runningRef.current) return
    const price = Number(maxPrice)
    if (!Number.isFinite(price) || price < 0.01 || price > 100 || Math.abs(price * 100 - Math.round(price * 100)) >= 1e-8) {
      setCfgStatus('Set a maximum SMS price from $0.01 to $100 with at most two decimals.')
      return
    }
    const mc = maxCount.trim() ? Number(maxCount) : null
    if (mc != null && (!Number.isInteger(mc) || mc < 1 || mc > 1000)) {
      setCfgStatus('Maximum accounts must be a whole number from 1 to 1000, or blank.')
      return
    }
    runningRef.current = true
    const nameList = names.split('\n').map(s => s.trim().replace(/^@/, '')).filter(Boolean)
    const bfVal = Number(balanceFloor)
    const cdVal = Number(cooldown)
    const config: { provider: string; country: string; maxPriceUsd: number; balanceFloor: number; cooldownHours: number; nameList: string[]; maxCount?: number } = {
      provider, country, maxPriceUsd: price,
      balanceFloor: bfVal,
      cooldownHours: cdVal,
      nameList,
    }
    if (mc != null) config.maxCount = mc

    // Re-check status immediately before starting (to pick up latest resume flag)
    const st = await invoke<BulkStatusResult>('bulk:status', { serial }).catch(() => null)
    if (!st?.ok || st.active) {
      runningRef.current = false
      setCfgStatus(st?.error || (st?.active ? 'A run is already active on this phone.' : 'Run status could not be verified. Sign in and retry.'))
      return
    }
    const resume = !!(st?.interrupted)

    // Switch to progress panel
    setRows([])
    setTotalsText('')
    setProgStatus('')
    setProgStatusKind('')
    setRunning(true)
    setPanel('progress')

    // Start (resolves immediately — work is async in the backend)
    type StartResult = { ok?: boolean; error?: string }
    const r: StartResult = await invoke<StartResult>('bulk:start', { serial, config, resume })
      .catch((e: Error) => ({ ok: false, error: e?.message }))

    if (!r?.ok) {
      setProgStatus(r?.error || 'failed to start bulk run')
      setProgStatusKind('err')
      runningRef.current = false
      setRunning(false)
      if (pollRef.current) clearTimeout(pollRef.current)
      return
    }

  }

  // ── Progress panel actions ────────────────────────────────────────────────
  function handleStop() {
    if (serial) invoke('bulk:stop', { serial }).catch(() => {})
  }

  function handleProgressClose() {
    if (running) handleStop()
    setPanel('none')
    if (!running) onDone()
    else onClose()
  }

  function handleDone() {
    setPanel('none')
    onDone()
  }

  async function recover() {
    const result = await invoke<{ ok?: boolean; error?: string }>('account-creation:open', { serial, userId: String(recoveryUserId) })
      .catch(() => ({ ok: false, error: 'Could not open account recovery.' }))
    if (!result?.ok) setToast(result?.error || 'Could not open account recovery.', 'err')
  }

  if (panel === 'none' || !serial) return null

  // ── Config panel ──────────────────────────────────────────────────────────
  if (panel === 'config') {
    return (
      <div ref={overlayRef} className="cfg-overlay show">
        <div className="cfg-card" role="dialog" aria-modal="true" aria-labelledby="bkTitle">
          <div className="cfg-head">
            <div>
              <h2 id="bkTitle">Bulk Create IG accounts</h2>
              <div className="cfg-sub">{serial}</div>
            </div>
            <button className="cfg-x" title="Close" onClick={handleConfigClose}>&times;</button>
          </div>

          <div className="cfg-body">
            {resumeText && <div className="ci-note" style={{ marginBottom: 8 }}>{resumeText}</div>}
            <div className="ci-note" style={{ marginBottom: 14 }}>{previewText}</div>
            {recoveryUserId != null && <button className="cfg-btn" onClick={recover}>{`Recover profile ${recoveryUserId}`}</button>}
            {recoveryUserId != null && <div className="ci-note">After recovery, Run verifies the recorded outcome before resuming.</div>}
            <button className="cfg-btn" onClick={() => invoke('open-settings')}>SMS provider settings</button>
            <label className="ci-label">SMS provider
              <select className="ci-input" value={provider} onChange={e => { setProvider(e.target.value); if (e.target.value === 'textverified') setCountry('US') }}>
                <option value="smspool">SMSPool</option><option value="textverified">TextVerified</option>
              </select>
            </label>
            <label className="ci-label">Country
              <select className="ci-input" value={country} onChange={e => setCountry(e.target.value)}>
                <option value="US">United States</option>{provider === 'smspool' && <option value="GB">United Kingdom</option>}
              </select>
            </label>
            <label className="ci-label">Maximum price per SMS number (USD)
              <input aria-label="Maximum SMS price" type="number" className="ci-input" value={maxPrice} min="0.01" max="100" step="0.01" onChange={e => setMaxPrice(e.target.value)} />
            </label>

            <label className="ci-label">
              Usernames <span className="ci-opt">(optional — one per line; auto-generated when the list runs out)</span>
              <textarea
                className="ci-input"
                style={{ minHeight: 90, resize: 'vertical' }}
                placeholder={'ava.rose\nluna.k'}
                value={names}
                onChange={e => setNames(e.target.value)}
              />
            </label>
            <label className="ci-label">
              Balance floor $ <span className="ci-opt">(stop when the selected provider balance drops below)</span>
              <input type="number" className="ci-input" value={balanceFloor} step="0.01" min="0"
                onChange={e => setBalanceFloor(e.target.value)} />
            </label>
            <label className="ci-label">
              Cooldown hours <span className="ci-opt">(flagged profile rest window)</span>
              <input type="number" className="ci-input" value={cooldown} min="1"
                onChange={e => setCooldown(e.target.value)} />
            </label>
            <label className="ci-label">
              Max accounts <span className="ci-opt">(optional — stop after N created; blank = run to balance floor)</span>
              <input type="number" className="ci-input" value={maxCount} placeholder="(no cap)" min="1"
                onChange={e => setMaxCount(e.target.value)} />
            </label>
          </div>

          <div className="cfg-foot">
            <span className="cfg-status">{cfgStatus}</span>
            <span className="cfg-spacer" />
            <button className="cfg-btn" onClick={handleConfigClose}>Cancel</button>
            <button className="cfg-btn cfg-primary" disabled={running} onClick={handleRun}>Run</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Progress panel ────────────────────────────────────────────────────────
  return (
    <div ref={overlayRef} className="cfg-overlay show">
      <div className="cfg-card" role="dialog" aria-modal="true" aria-labelledby="bpTitle">
        <div className="cfg-head">
          <div>
            <h2 id="bpTitle">Bulk run</h2>
            <div className="cfg-sub">{serial}</div>
          </div>
          <button className="cfg-x" title="Close" onClick={handleProgressClose}>&times;</button>
        </div>

        <div className="cfg-body">
          {totalsText && <div className="ci-note" style={{ marginBottom: 8 }}>{totalsText}</div>}
          {recoveryUserId != null && <button className="cfg-btn" onClick={recover}>{`Recover profile ${recoveryUserId}`}</button>}
          {recoveryUserId != null && <div className="ci-note">After recovery, reopen Bulk Create and press Run to verify the recorded outcome.</div>}
          {running && <div className="ci-note">Stop lets the current protected attempt finish, then prevents the next profile.</div>}
          <div className="cfg-toggles" style={{ flexDirection: 'column', gap: 0 }}>
            {(rows ?? []).map(r => (
              <div key={String(r.userId)} className="ci-note">{r.text}</div>
            ))}
            {running && (rows ?? []).length === 0 && (
              <div className="ci-note">starting run…</div>
            )}
          </div>
        </div>

        <div className="cfg-foot">
          <span className={`cfg-status${progStatusKind ? ' ' + progStatusKind : ''}`}>{progStatus}</span>
          <span className="cfg-spacer" />
          {running && (
            <button className="cfg-btn" onClick={handleStop}>Stop</button>
          )}
          {!running && (
            <button className="cfg-btn cfg-primary" onClick={handleDone}>Done</button>
          )}
        </div>
      </div>
    </div>
  )
}
