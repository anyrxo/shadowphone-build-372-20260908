import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from './ipc'
import { setToast } from './toast'
import {
  SCHED_STEPS, SCHED_MODULES, SLOT_KINDS,
  buildConfigurePatch, type SlotDraft,
} from './scheduleHelpers'

interface ModalCtx {
  serial: string
  userId: string
  account: string
}

interface Props {
  ctx: ModalCtx | null
  onClose: () => void
  onSaved: () => void  // trigger quiet registry refresh
}

type StatusKind = '' | 'ok' | 'err'

export default function ConfigureModal({ ctx, onClose, onSaved }: Props) {
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState('')
  const [statusKind, setStatusKind] = useState<StatusKind>('')
  const [slots, setSlots] = useState<SlotDraft[]>([])
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [isActive, setIsActive] = useState(false)
  const [existingDisabled, setExistingDisabled] = useState<string[]>([])

  const [saveBusy, setSaveBusy] = useState(false)
  const busyRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const closedRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  const cfgClose = useCallback(() => {
    if (busyRef.current) return
    setVisible(false)
    setStatus('')
    setStatusKind('')
    onClose()
  }, [onClose])

  // Open + fetch when ctx changes
  useEffect(() => {
    if (!ctx) return
    closedRef.current = false
    busyRef.current = false
    setStatus('loading…')
    setStatusKind('')
    setSlots([])
    setEnabled(new Set())
    setIsActive(false)
    setExistingDisabled([])

    type GetResult = { ok?: boolean; row?: { is_active?: boolean; slots?: { time?: string; content_type?: string }[]; disabled_steps?: string[] }; error?: string }
    invoke<GetResult>('schedule:get', {
      accountKey: ctx.account, serial: ctx.serial, userId: ctx.userId, platform: 'instagram',
    }).catch((e: Error) => ({ ok: false, error: e?.message } as GetResult))
      .then((r) => {
        if (closedRef.current) return
        if (!r?.ok) {
          onClose()
          setToast(r?.error || 'could not load schedule', 'err')
          return
        }
        const row = r.row || {}
        const rawDisabled = row.disabled_steps || []
        const disabledSet = new Set(rawDisabled)
        const allIds = [...SCHED_STEPS, ...SCHED_MODULES].map((x) => x.id)
        setSlots((row.slots || []).map((s: { time?: string; content_type?: string }) => ({
          time: String(s.time || '12:00:00').slice(0, 5),
          content_type: s.content_type || 'reel',
        })))
        setEnabled(new Set(allIds.filter((id) => !disabledSet.has(id))))
        setIsActive(!!row.is_active)
        setExistingDisabled(rawDisabled as string[])
        setStatus('')
        setVisible(true)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx])

  // Escape key close
  useEffect(() => {
    if (!visible) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') cfgClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, cfgClose])

  // Backdrop click
  function onOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) cfgClose()
  }

  function addSlot() {
    setSlots((prev) => [...prev, { time: '12:00', content_type: 'reel' }])
  }

  function deleteSlot(idx: number) {
    setSlots((prev) => prev.filter((_, i) => i !== idx))
  }

  function updateSlotTime(idx: number, time: string) {
    setSlots((prev) => prev.map((s, i) => i === idx ? { ...s, time } : s))
  }

  function updateSlotKind(idx: number, content_type: string) {
    setSlots((prev) => prev.map((s, i) => i === idx ? { ...s, content_type } : s))
  }

  function toggleEnabled(id: string, checked: boolean) {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id); else next.delete(id)
      return next
    })
  }

  async function onSave() {
    if (!ctx || busyRef.current) return
    busyRef.current = true
    setSaveBusy(true)
    setStatus('saving…')
    setStatusKind('')

    const patch = buildConfigurePatch({
      isActive,
      slots,
      enabledIds: enabled,
      existingDisabled,
    })

    type SaveResult = { ok?: boolean; error?: string }
    const r: SaveResult = await invoke<SaveResult>('schedule:save', {
      accountKey: ctx.account, serial: ctx.serial, userId: ctx.userId,
      platform: 'instagram', patch,
    }).catch((e: Error) => ({ ok: false, error: e?.message } as SaveResult))

    if (!mountedRef.current) return
    if (!r?.ok) {
      setStatus(r?.error || 'save failed')
      setStatusKind('err')
      busyRef.current = false
      setSaveBusy(false)
      return
    }

    // Round-trip verify
    const back = await invoke<{ ok?: boolean; row?: { slots?: unknown[] } }>('schedule:get', {
      accountKey: ctx.account, serial: ctx.serial, userId: ctx.userId, platform: 'instagram',
    }).catch(() => null)

    if (!mountedRef.current) return
    if (back?.ok) {
      const count = back.row?.slots?.length || 0
      setStatus(`saved ✓ (${count} slot${count !== 1 ? 's' : ''})`)
    } else {
      setStatus('saved ✓')
    }
    setStatusKind('ok')
    busyRef.current = false
    setSaveBusy(false)
    setToast(`@${ctx.account} schedule saved`, 'ok')
    onSaved()
    setTimeout(() => {
      closedRef.current = true
      setVisible(false)
      setStatus('')
      setStatusKind('')
      onClose()
    }, 1100)
  }

  if (!visible) return null

  return (
    <div
      ref={overlayRef}
      className="cfg-overlay show"
      onClick={onOverlayClick}
    >
      <div className="cfg-card" role="dialog" aria-modal="true" aria-label="Configure schedule">
        <div className="cfg-head">
          <div>
            <h2>Configure schedule</h2>
            <div className="cfg-sub">{ctx ? `@${ctx.account}` : ''}</div>
          </div>
          <button className="cfg-x" title="Close" onClick={cfgClose}>&times;</button>
        </div>

        <div className="cfg-body">
          {/* Active toggle */}
          <div className="cfg-section">
            <div className="cfg-section-head">
              <h3>Schedule status</h3>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                id="cfgActiveSw"
                className={`sw${isActive ? ' on' : ''}`}
                role="switch"
                tabIndex={0}
                aria-label="Schedule active"
                aria-checked={isActive}
                onClick={() => setIsActive((a) => !a)}
                onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setIsActive((a) => !a) } }}
              >
                <span className="lbl off">OFF</span>
                <span className="lbl on">ON</span>
              </span>
              <span id="cfgActiveLabel" style={{ fontSize: 12, color: 'var(--dim)' }}>
                {isActive ? 'active' : 'paused'}
              </span>
            </div>
          </div>

          {/* Slot editor */}
          <div className="cfg-section">
            <div className="cfg-section-head">
              <h3>Post slots</h3>
              <button className="cfg-btn" onClick={addSlot}>+ Add slot</button>
            </div>
            <div className="cfg-slots">
              {slots.map((slot, i) => (
                <div className="cfg-slot" key={i}>
                  <input
                    type="time"
                    value={slot.time}
                    onChange={(e) => updateSlotTime(i, e.target.value)}
                  />
                  <select
                    value={slot.content_type}
                    onChange={(e) => updateSlotKind(i, e.target.value)}
                  >
                    {SLOT_KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <button className="cfg-del" title="Delete slot" onClick={() => deleteSlot(i)}>×</button>
                </div>
              ))}
            </div>
            {slots.length === 0 && (
              <div className="cfg-empty">no slots — this account won&apos;t post</div>
            )}
          </div>

          {/* Step toggles */}
          <div className="cfg-section">
            <h3>Steps</h3>
            <div className="cfg-toggles">
              {SCHED_STEPS.map((it) => (
                <label key={it.id} className="cfg-toggle">
                  <input
                    type="checkbox"
                    checked={enabled.has(it.id)}
                    onChange={(e) => toggleEnabled(it.id, e.target.checked)}
                  />
                  <span>{it.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Module toggles */}
          <div className="cfg-section">
            <h3>Modules</h3>
            <div className="cfg-toggles">
              {SCHED_MODULES.map((it) => (
                <label key={it.id} className="cfg-toggle">
                  <input
                    type="checkbox"
                    checked={enabled.has(it.id)}
                    onChange={(e) => toggleEnabled(it.id, e.target.checked)}
                  />
                  <span>{it.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="cfg-foot">
          <span className={`cfg-status${statusKind ? ' ' + statusKind : ''}`}>{status}</span>
          <span className="cfg-spacer" />
          <button className="cfg-btn" onClick={cfgClose}>Cancel</button>
          <button
            className="cfg-btn cfg-primary"
            disabled={saveBusy}
            onClick={onSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
