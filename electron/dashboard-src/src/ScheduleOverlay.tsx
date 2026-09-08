// ScheduleOverlay — Phase 4: Fleet Schedule Calendar Overview
// Ports the v3.2.13 sov-overlay DOM structure to React.
// IPC channels: schedule:list-all / schedule:get / schedule:save / schedule:fire-now
// Pure model is imported from schedule-overview-model.js (ESM, no DOM).
// Inline editor mounts into a ref div via openScheduleEditor() (DOM only, unchanged).

import {
  useState, useEffect, useRef, useCallback,
  type ReactNode,
} from 'react'
import { invoke } from './ipc'

// Pure ESM helpers (electron/renderer/schedule-overview-*.js). Imported as real
// ES modules so Vite/Rollup BUNDLES them into the chunk at build time. A runtime
// require() of these (the previous approach) hit Electron's CJS loader and threw
// SyntaxError on their `export` syntax — crashing the overlay on open and the
// slot editor on click. Types come from schedule-modules.d.ts (the .js have none).
import { buildOverviewModel } from '../../renderer/schedule-overview-model.js'
import { openScheduleEditor } from '../../renderer/schedule-overview-edit.js'

// ── Types (mirrors schedule-overview-model.js output) ─────────────────────

interface Slot {
  time: string
  content_type: string
  status: string
  nextFireMs: number | null
  jitterMin: number
}

interface Account {
  account: string
  user: string
  androidUser: string
  key: string
  isActive: boolean
  flagged: boolean
  slots: Slot[]
}

interface Phone {
  serial: string
  accounts: Account[]
}

interface Totals {
  accounts: number
  activeAccounts: number
  slotsPerDay: number
  flagged: number
  collisions: number
  nextFire: { account: string; atMs: number } | null
}

interface OverviewModel {
  phones: Phone[]
  totals: Totals
}

// ── Helper pure functions (ported from schedule-overview.js) ───────────────

const DAY_MS = 24 * 60 * 60 * 1000

function dayFraction(ms: number): number {
  const start = new Date(ms)
  start.setHours(0, 0, 0, 0)
  return (ms - start.getTime()) / DAY_MS
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `in ${h}h ${m}m`
  return `in ${m}m`
}

function fmtHHMM(ms: number): string {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function slotDayLeft(slot: Slot, nowMs: number): number {
  if (slot.nextFireMs != null) {
    const sameDay = new Date(slot.nextFireMs).toDateString() === new Date(nowMs).toDateString()
    if (sameDay) return dayFraction(slot.nextFireMs) * 100
  }
  const m = String(slot.time || '').match(/^(\d{1,2}):(\d{2})/)
  if (!m) return 0
  return ((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 1440) * 100
}

function recomputeNextFire(model: OverviewModel, nowMs: number): { account: string; atMs: number } | null {
  let best: { account: string; atMs: number } | null = null
  for (const phone of model.phones) {
    for (const acct of phone.accounts) {
      if (!acct.isActive) continue
      for (const slot of acct.slots) {
        if (slot.nextFireMs == null) continue
        if (best == null || slot.nextFireMs < best.atMs) {
          best = { account: acct.user, atMs: slot.nextFireMs }
        }
      }
    }
  }
  return best
}

const CONTENT_MOD: Record<string, string> = {
  reel: 'reel', story: 'story', image: 'image', trial_reel: 'trial',
}

// ── SpScope from window ────────────────────────────────────────────────────

interface SpScope {
  serial?: string
  ids: string[]
  handles: Set<string>
}

function getSpScope(): SpScope | null {
  const w = window as unknown as Record<string, unknown>
  const sc = w['__spScope'] as SpScope | undefined | null
  return sc ?? null
}

function getSpRegistry(): Record<string, unknown> | null {
  const w = window as unknown as Record<string, unknown>
  return (w['__spRegistry'] as { devices?: Record<string, unknown> } | undefined)?.devices
    ? (w['__spRegistry'] as { devices: Record<string, unknown> }).devices
    : null
}

function buildSerialToName(devices: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, devRaw] of Object.entries(devices)) {
    const dev = devRaw as {
      serial?: string
      hwSerial?: string
      profiles?: Record<string, { name?: string }>
    }
    const profiles = dev.profiles || {}
    const firstName = Object.values(profiles).map(p => p.name).filter(Boolean)[0]
    const label = firstName || dev.serial || key
    for (const id of [key, dev.serial, dev.hwSerial].filter(Boolean) as string[]) {
      out[id] = label as string
    }
  }
  return out
}

// ── Sub-components ─────────────────────────────────────────────────────────

function KpiBar({ totals, nowMs }: { totals: Totals; nowMs: number }) {
  const nf = totals.nextFire
  // Self-tick the next-fire countdown ONLY. nowMs is no longer ticked globally
  // (that re-rendered every slot in the grid each second); seed from nowMs so it
  // stays in sync with the last model refresh, then advance locally per second.
  const [liveNow, setLiveNow] = useState(nowMs)
  useEffect(() => {
    setLiveNow(nowMs)
    const id = window.setInterval(() => setLiveNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [nowMs])
  return (
    <div className="sov-kpis">
      <div className="sov-kpi">
        <div className="sov-kpi-val">{totals.activeAccounts} / {totals.accounts}</div>
        <div className="sov-kpi-label">active accounts</div>
      </div>
      <div className="sov-kpi">
        <div className="sov-kpi-val">{totals.slotsPerDay}</div>
        <div className="sov-kpi-label">slots / day</div>
      </div>
      <div className="sov-kpi sov-kpi--next">
        <div className="sov-kpi-val" id="sovNextFireVal">
          {nf ? fmtCountdown(nf.atMs - liveNow) : '—'}
        </div>
        <div className="sov-kpi-label" id="sovNextFireLabel">
          {nf ? `next: ${nf.account}` : 'next fire'}
        </div>
      </div>
      <div className={'sov-kpi' + (totals.flagged ? ' sov-kpi--alert' : '')}>
        <div className="sov-kpi-val">{totals.flagged}</div>
        <div className="sov-kpi-label">flagged</div>
      </div>
      <div className={'sov-kpi' + (totals.collisions ? ' sov-kpi--alert' : '')}>
        <div className="sov-kpi-val">{totals.collisions}</div>
        <div className="sov-kpi-label">collisions</div>
      </div>
    </div>
  )
}

function SlotChip({ slot, slotIndex, nowMs }: { slot: Slot; slotIndex: number; nowMs: number }) {
  const kindMod = CONTENT_MOD[slot.content_type] || 'reel'
  const cls = `sov-slot sov-slot--${kindMod} sov-slot--${slot.status}`
  const leftPct = slotDayLeft(slot, nowMs).toFixed(3) + '%'

  const bits = [slot.content_type, slot.status]
  if (slot.nextFireMs != null) bits.push('next ' + fmtHHMM(slot.nextFireMs))
  if (slot.jitterMin > 0) bits.push('±' + slot.jitterMin + 'm')
  const title = bits.join(' · ')

  return (
    <div
      className={cls}
      data-idx={slotIndex}
      style={{ left: leftPct }}
      title={title}
    >
      <span className="sov-slot-time">{String(slot.time || '').slice(0, 5)}</span>
      <span className="sov-slot-kind">{slot.content_type}</span>
    </div>
  )
}

function AccountRow({
  serial, acct, nowMs, onAccountClick,
}: {
  serial: string
  acct: Account
  nowMs: number
  onAccountClick: (serial: string, acct: Account) => void
}) {
  let rowCls = 'sov-row'
  if (!acct.isActive) rowCls += ' sov-row--paused'
  if (acct.flagged) rowCls += ' sov-row--flagged'

  const labelTitle = acct.account
    + (!acct.isActive ? ' · paused' : '')
    + (acct.flagged ? ' · flagged' : '')

  return (
    <div className={rowCls}>
      <button
        type="button"
        className="sov-acct sov-acct--editable"
        title={labelTitle}
        onClick={() => onAccountClick(serial, acct)}
      >
        {acct.user}
      </button>
      <div className="sov-track">
        {acct.slots.map((slot, i) => (
          <SlotChip key={i} slot={slot} slotIndex={i} nowMs={nowMs} />
        ))}
      </div>
    </div>
  )
}

function DayView({
  model, nowMs, serialToName, onAccountClick,
}: {
  model: OverviewModel
  nowMs: number
  serialToName: Record<string, string>
  onAccountClick: (serial: string, acct: Account) => void
}) {
  const nowLinePct = (dayFraction(nowMs) * 100).toFixed(3) + '%'

  return (
    <div className="sov-day">
      {/* Hour axis */}
      <div className="sov-axis">
        {Array.from({ length: 9 }, (_, i) => i * 3).map(h => (
          <span
            key={h}
            className="sov-axis-tick"
            style={{ left: ((h / 24) * 100).toFixed(3) + '%' }}
          >
            {String(h).padStart(2, '0')}:00
          </span>
        ))}
      </div>

      {/* Grid */}
      <div className="sov-grid">
        {/* Now line */}
        <div className="sov-nowline" id="sovNowLine" style={{ left: nowLinePct }} />

        {model.phones.map(phone => {
          const label = serialToName[phone.serial] || phone.serial
          return (
            <div key={phone.serial} className="sov-phone">
              <div
                className="sov-phone-head"
                title={label !== phone.serial ? phone.serial : undefined}
              >
                {label}
              </div>
              {phone.accounts.map(acct => (
                <AccountRow
                  key={acct.key || acct.account}
                  serial={phone.serial}
                  acct={acct}
                  nowMs={nowMs}
                  onAccountClick={onAccountClick}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main overlay component ─────────────────────────────────────────────────

interface Props {
  onClose: () => void
}

export default function ScheduleOverlay({ onClose }: Props) {
  const [model, setModel] = useState<OverviewModel | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [serialToName, setSerialToName] = useState<Record<string, string>>({})
  const [editorOpen, setEditorOpen] = useState(false)

  const overlayRef = useRef<HTMLDivElement>(null)
  const editorHostRef = useRef<HTMLDivElement>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  // ── Build serialToName from registry ──────────────────────────────────
  const rebuildSerialToName = useCallback(() => {
    const devices = getSpRegistry()
    if (devices) {
      setSerialToName(buildSerialToName(devices))
    }
  }, [])

  // ── Refresh data from IPC ──────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const res = await invoke<{ ok: boolean; rows: unknown[] }>('schedule:list-all')
      // Guard: overlay may have been unmounted while IPC was in-flight
      if (!mountedRef.current) return

      const allRows = (res && res.ok && Array.isArray(res.rows)) ? res.rows : []

      // __spScope filtering (mirrors models-dashboard.html)
      const sc = getSpScope()
      const rows = allRows.filter((r: unknown) => {
        if (!sc) return true
        const row = r as Record<string, unknown>
        return (
          sc.ids.includes(row['phone_id'] as string)
          || sc.ids.includes(row['device_serial'] as string)
          || sc.ids.includes(row['serial'] as string)
          || (row['account'] && sc.handles.has(String(row['account']).replace(/^@/, '').toLowerCase()))
        )
      })

      // Build model via the pure module (statically imported → bundled)
      const built: OverviewModel = buildOverviewModel(rows, Date.now())
      setModel(built)
      setLoadError(null)
      setNowMs(Date.now())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // Guard again after async
      if (!mountedRef.current) return
      setLoadError(msg)
    }
  }, [])

  // ── Clock tick (1s) ───────────────────────────────────────────────────
  const startClock = useCallback(() => {
    if (clockRef.current) return
    clockRef.current = setInterval(() => {
      const now = Date.now()
      // DOM-only now-line update. We intentionally do NOT setNowMs() here:
      // nowMs threads through DayView→AccountRow→SlotChip unmemoized, so a 1s
      // state tick re-rendered the entire grid every second. The next-fire
      // countdown self-ticks inside KpiBar; slot positions refresh on refresh().
      const line = document.getElementById('sovNowLine')
      if (line) line.style.left = (dayFraction(now) * 100).toFixed(3) + '%'
    }, 1000)
  }, [])

  const stopClock = useCallback(() => {
    if (clockRef.current) { clearInterval(clockRef.current); clockRef.current = null }
  }, [])

  // ── Open editor ───────────────────────────────────────────────────────
  const openEditor = useCallback((serial: string, acct: Account) => {
    const host = editorHostRef.current
    if (!host) return

    host.hidden = false
    setEditorOpen(true)

    const idArgs = {
      accountKey: acct.account,
      serial,
      userId: acct.androidUser,
      platform: 'instagram',
      key: acct.key,
    }

    openScheduleEditor(
      host,
      { serial, account: acct.account, androidUser: acct.androidUser, user: acct.user },
      {
        load: () => invoke('schedule:get', idArgs),
        save: (patch: unknown) => invoke('schedule:save', { ...idArgs, patch }),
        runNow: async (slotIndex: number) => {
          try {
            const res = await invoke<{ ok: boolean; error?: string }>('schedule:fire-now', { ...idArgs, slotIndex })
            if (res && !res.ok) {
              setLoadError(res.error || 'fire-now failed')
            }
          } catch (e: unknown) {
            setLoadError(e instanceof Error ? e.message : String(e))
          }
        },
        refresh: () => { void refresh() },
        close: () => closeEditor(),
      }
    )
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeEditor = useCallback(() => {
    const host = editorHostRef.current
    if (!host) return
    host.hidden = true
    host.textContent = ''
    setEditorOpen(false)
  }, [])

  // ── Mount / unmount ───────────────────────────────────────────────────
  useEffect(() => {
    rebuildSerialToName()
    void refresh()

    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    refreshTimerRef.current = setInterval(refresh, 30_000)

    startClock()

    // Focus close button on open (matches HTML: scheduleOverviewClose?.focus())
    const closeBtn = document.getElementById('scheduleOverviewClose')
    closeBtn?.focus()

    return () => {
      mountedRef.current = false
      stopClock()
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [refresh, rebuildSerialToName, startClock, stopClock])

  // ── Keyboard handling (Escape + Tab trap) ─────────────────────────────
  useEffect(() => {
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (editorOpen) { closeEditor(); return }
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const overlay = overlayRef.current
      if (!overlay) return
      const editorHost = editorHostRef.current
      const scope = (editorHost && !editorHost.hidden) ? editorHost : overlay
      const focusable = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(el => el.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editorOpen, closeEditor, onClose])

  // ── Backdrop click ────────────────────────────────────────────────────
  function onOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current) onClose()
  }

  function onEditorHostClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === editorHostRef.current) closeEditor()
  }

  // ── Render body content ───────────────────────────────────────────────
  let bodyContent: ReactNode = null

  if (loadError !== null) {
    bodyContent = (
      <div className="sov-error" onClick={() => void refresh()}>
        Could not load schedules{loadError ? ` — ${loadError}` : ''}. Click to retry.
      </div>
    )
  } else if (model !== null) {
    const empty = model.phones.length === 0 || model.totals.slotsPerDay === 0
    const allPaused = !empty && model.totals.activeAccounts === 0

    bodyContent = (
      <div className="sov-root">
        <div className="sov-bar">
          <KpiBar totals={model.totals} nowMs={nowMs} />
        </div>

        {empty && (
          <div className="sov-empty">
            No schedules yet — add slots from a phone&apos;s Schedule panel.
          </div>
        )}

        {!empty && (
          <>
            {allPaused && (
              <div
                className="sov-banner"
                style={{ padding: '8px 16px', color: 'var(--md-tert)', fontSize: '0.85rem', textAlign: 'center' }}
              >
                All accounts paused — activate one to resume auto-posting.
              </div>
            )}
            <DayView
              model={model}
              nowMs={nowMs}
              serialToName={serialToName}
              onAccountClick={openEditor}
            />
          </>
        )}
      </div>
    )
  } else {
    // Loading state — show nothing in the container (matches HTML initial load)
    bodyContent = null
  }

  return (
    <div
      className="sov-overlay"
      ref={overlayRef}
      onClick={onOverlayClick}
    >
      <div className="sov-overlay-head">
        <div>
          <h2>
            <span className="gl">&#128197;</span> Fleet Schedule
          </h2>
          <p
            className="sov-overlay-sub"
            title="This overlay edits the per-phone schedule saved locally on this PC (sidebar-schedules.json). It is separate from the Cloud Schedules tab."
          >
            Per-phone schedule stored on this PC — separate from the Cloud Schedules tab.
          </p>
        </div>
        <button
          className="mdbtn icon"
          id="scheduleOverviewClose"
          title="Close (Esc)"
          aria-label="Close"
          onClick={onClose}
        >
          &#10005;
        </button>
      </div>

      <div className="sov-overlay-body">
        <div id="scheduleOverview">{bodyContent}</div>
      </div>

      {/* Inline slot editor host — DOM-managed by openScheduleEditor() */}
      <div
        className="sov-ed-host"
        id="scheduleEditorHost"
        ref={editorHostRef}
        hidden
        onClick={onEditorHostClick}
      />
    </div>
  )
}
