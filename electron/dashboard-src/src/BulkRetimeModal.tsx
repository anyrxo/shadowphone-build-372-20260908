// BulkRetimeModal — resolve EVERY collision on the fleet in one preview+confirm.
//
// For each (serial, HH:MM) cluster of colliding accounts it KEEPs the earliest
// (alphabetically-first handle, deterministic) and reassigns the rest to the
// next free jitter-safe minute — tracking a running per-serial "taken" set so
// two reassignments on the same phone never land on the same minute. The
// before→after grid is grouped by phone; Confirm hands the concrete changes up
// to CommandCenter, which rewrites each account's FULL slots array via
// schedule:save (a save replaces slots wholesale, so we must send all of them).

import { useMemo, useState, useEffect } from 'react'
import type { Slot } from './types'
import type { Exception } from './exceptions'
import { parseHm } from './exceptions'
import { proposeRetimes, type RetimePhone, type RetimeProposal } from './retime-util'

export interface BulkRetimeChange {
  key: string
  serial: string
  userId: string
  handle: string
  from: string // 'HH:MM'
  to: string // 'HH:MM'
  content_type: string
}

interface Props {
  collisions: Exception[]
  phones: RetimePhone[]
  slotsByHandle: Record<string, Slot[]>
  phoneNameBySerial?: Record<string, string>
  onApply: (changes: BulkRetimeChange[]) => Promise<void>
  onClose: () => void
}

export default function BulkRetimeModal({ collisions, phones, slotsByHandle, phoneNameBySerial, onApply, onClose }: Props) {
  const [saving, setSaving] = useState(false)

  // Resolve a slot's content_type by (handle key, HH:MM). The Exception itself
  // doesn't carry content_type, so look it up on the loaded slots — match the
  // colliding slot by its zero-padded time. Falls back to 'reel'.
  const handleByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of collisions) m.set(e.key, e.handle)
    return m
  }, [collisions])

  const contentTypeByKeyTime = useMemo(() => (key: string, hm: string): string => {
    const handle = handleByKey.get(key)
    if (!handle) return 'reel'
    for (const s of (slotsByHandle[handle.toLowerCase()] || [])) {
      if ((parseHm(s.time) ?? String(s.time).slice(0, 5)) === hm) return s.content_type
    }
    return 'reel'
  }, [handleByKey, slotsByHandle])

  const proposals = useMemo<RetimeProposal[]>(
    () => proposeRetimes(collisions, phones, slotsByHandle, contentTypeByKeyTime),
    [collisions, phones, slotsByHandle, contentTypeByKeyTime],
  )

  // Group proposals by serial, sorted by serial then time, for the grid.
  const groups = useMemo(() => {
    const m = new Map<string, RetimeProposal[]>()
    for (const p of proposals) {
      const arr = m.get(p.serial)
      if (arr) arr.push(p); else m.set(p.serial, [p])
    }
    for (const arr of m.values()) arr.sort((a, b) => a.from.localeCompare(b.from) || a.handle.localeCompare(b.handle))
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [proposals])

  const changes = useMemo<BulkRetimeChange[]>(
    () => proposals
      .filter(p => !p.kept && p.to)
      .map(p => ({ key: p.key, serial: p.serial, userId: p.userId, handle: p.handle, from: p.from, to: p.to as string, content_type: p.content_type })),
    [proposals],
  )

  // Esc closes (match the inline editor modal). Disabled while saving.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const confirm = async () => {
    if (saving || changes.length === 0) return
    setSaving(true)
    try {
      await onApply(changes)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="cc-bulk-retime-overlay show"
      onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div className="cc-bulk-retime" role="dialog" aria-modal={true} aria-label="Retime all collisions">
        <div className="cc-bulk-retime-bar">
          <span className="cc-bulk-retime-title">&#9889; Retime all collisions</span>
          <button className="mdbtn sm" onClick={onClose} disabled={saving}>Close</button>
        </div>

        <div className="cc-bulk-retime-body">
          {changes.length === 0 ? (
            <div className="cc-bulk-retime-empty">No reassignments needed &mdash; collisions already resolve to kept slots.</div>
          ) : (
            groups.map(([serial, rows]) => (
              <div className="cc-bulk-retime-group" key={serial}>
                <div className="cc-bulk-retime-phone">{phoneNameBySerial?.[serial] || serial}</div>
                {rows.map(p => (
                  <div className={`cc-bulk-retime-row${p.kept ? ' is-kept' : ''}`} key={`${p.key}::${p.from}`}>
                    <span className="cc-br-handle">@{p.handle}</span>
                    <span className="cc-br-type">{p.content_type}</span>
                    <span className="cc-br-from">{p.from} <span className="cc-br-warn" aria-label="Colliding">&#9888;</span></span>
                    {p.kept ? (
                      <span className="cc-br-keep">keep (earliest)</span>
                    ) : (
                      <>
                        <span className="cc-br-arrow" aria-hidden="true">&rarr;</span>
                        <span className="cc-br-to">{p.to}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="cc-bulk-retime-foot">
          <span className="cc-bulk-retime-note">Proposed times are jitter-safe &mdash; padded past each existing slot&rsquo;s jitter window.</span>
          <span className="cc-spacer" />
          <button className="mdbtn ghost sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="mdbtn sm" onClick={confirm} disabled={saving || changes.length === 0}>
            {saving ? 'Saving…' : `Confirm & save ${changes.length}`}
          </button>
        </div>
      </div>
    </div>
  )
}
