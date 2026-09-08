import { useState, useCallback } from 'react'
import type { NormalizedAccount } from './types'
import { invoke } from './ipc'
import { setToast } from './toast'

interface Props {
  selected: Set<string>
  keyToAcct: Map<string, NormalizedAccount>
  sweepBusy: boolean
  onClear: () => void
  onRefresh: () => void
}

export default function BulkBar({ selected, keyToAcct, sweepBusy, onClear, onRefresh }: Props) {
  const [busy, setBusy] = useState(false)

  const getRows = useCallback(() => {
    const rows: NormalizedAccount[] = []
    selected.forEach(k => {
      const a = keyToAcct.get(k)
      if (a) rows.push(a)
    })
    return rows
  }, [selected, keyToAcct])

  async function guard(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }

  async function bulkToggle(isActive: boolean) {
    const rows = getRows()
    if (!rows.length) return
    let ok = 0, fail = 0
    for (const r of rows) {
      setToast(`bulk ${isActive ? 'ON' : 'OFF'} @${r.handle} (${ok + fail + 1}/${rows.length})…`, 'warn', { busy: true })
      type Res = { ok?: boolean; error?: string }
      const res: Res = await invoke<Res>('schedule:toggle-active', {
        accountKey: r.handle, serial: r.serial, userId: r.userId,
        platform: 'instagram', isActive,
      }).catch((e: Error) => ({ ok: false, error: e?.message }))
      if (res?.ok) ok++; else fail++
    }
    setToast(
      `automation ${isActive ? 'ON' : 'OFF'}: ${ok} ok${fail ? `, ${fail} failed` : ''}`,
      fail ? 'warn' : 'ok',
    )
    onRefresh()
  }

  async function bulkFolder() {
    const rows = getRows()
    if (!rows.length) return
    let ok = 0
    for (const r of rows) {
      type Res = { ok?: boolean; error?: string }
      const res: Res = await invoke<Res>('sidebar:open-folder', {
        serial: r.serial, userId: r.userId, platform: 'instagram', account: r.handle,
      }).catch((e: Error) => ({ ok: false, error: e?.message }))
      if (res?.ok) ok++
    }
    setToast(`opened ${ok} folder${ok === 1 ? '' : 's'}`, ok ? 'ok' : 'err')
  }

  async function bulkScan() {
    if (sweepBusy) { setToast('phone busy — finish the current sweep first', 'warn'); return }
    // group by unique serial::profileId
    const seen = new Set<string>()
    const jobs: { serial: string; profileId: number | string; name: string }[] = []
    selected.forEach(k => {
      const a = keyToAcct.get(k)
      if (!a) return
      const dk = `${a.serial}::${a.userId}`
      if (seen.has(dk)) return
      seen.add(dk)
      const pidVal = /^\d+$/.test(a.userId) ? Number(a.userId) : a.userId
      jobs.push({ serial: a.serial, profileId: pidVal, name: a.handle })
    })
    if (!jobs.length) { setToast('nothing to scan', 'warn'); return }
    let failed = 0
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i]
      setToast(`bulk scan @${j.name} (${i + 1}/${jobs.length})…`, 'warn', { busy: true })
      type Res = { ok?: boolean }
      const r: Res = await invoke<Res>('fleet:scan', {
        serial: j.serial, profileIds: [j.profileId],
      }).catch(() => ({ ok: false }))
      if (!r?.ok) failed++
    }
    const okCount = jobs.length - failed
    setToast(
      `bulk scan done — ${okCount}/${jobs.length} ok${failed ? `, ${failed} failed` : ''}`,
      failed ? 'warn' : 'ok',
    )
    onRefresh()
  }

  // insights:fetch is per-PHONE (scrapes every account on the phone) → dedupe by serial
  async function bulkFetchStats() {
    if (sweepBusy) { setToast('phone busy — finish the current sweep first', 'warn'); return }
    const serials = [...new Set(getRows().map(r => r.serial))].filter(Boolean)
    if (!serials.length) { setToast('nothing to fetch', 'warn'); return }
    let failed = 0
    for (let i = 0; i < serials.length; i++) {
      setToast(`bulk stats ${i + 1}/${serials.length}…`, 'warn', { busy: true })
      const r = await invoke<{ ok?: boolean }>('insights:fetch', { serial: serials[i] }).catch(() => ({ ok: false }))
      if (!r?.ok) failed++
    }
    setToast(`bulk fetch stats — ${serials.length - failed}/${serials.length} phone${serials.length === 1 ? '' : 's'} ok${failed ? `, ${failed} failed` : ''}`, failed ? 'warn' : 'ok')
    onRefresh()
  }

  // fleet:validate-folders is per-PHONE → dedupe by serial
  async function bulkSetupFolders() {
    const serials = [...new Set(getRows().map(r => r.serial))].filter(Boolean)
    if (!serials.length) return
    let ok = 0, created = 0
    for (const s of serials) {
      const r = await invoke<{ ok?: boolean; created?: number }>('fleet:validate-folders', s).catch((): { ok?: boolean; created?: number } => ({ ok: false }))
      if (r?.ok) { ok++; created += r.created || 0 }
    }
    setToast(`content folders set up — ${ok}/${serials.length} phone${serials.length === 1 ? '' : 's'}${created ? ` (+${created})` : ''}`, ok ? 'ok' : 'err')
    onRefresh()
  }

  const count = selected.size

  return (
    <div
      className={`bulkbar${count > 0 ? ' show' : ''}`}
      role="toolbar"
      aria-label="Bulk actions"
      aria-hidden={count > 0 ? 'false' : 'true'}
    >
      <span className="bulk-count"><b>{count}</b> selected</span>
      <span className="bulk-hint">Ctrl/&#8997;-click rows to select</span>
      <span className="bulk-sep" />
      <button
        className="mdbtn yellow sm"
        disabled={busy}
        title="Turn automation ON for all selected"
        onClick={() => guard(() => bulkToggle(true))}
      >Automation ON</button>
      <button
        className="mdbtn sm"
        disabled={busy}
        title="Turn automation OFF for all selected"
        onClick={() => guard(() => bulkToggle(false))}
      >Automation OFF</button>
      <button
        className="mdbtn violet sm"
        disabled={busy}
        title="Rescan every profile in the selection"
        onClick={() => guard(() => bulkScan())}
      >&#8635; Scan</button>
      <button
        className="mdbtn sm"
        disabled={busy}
        title="Scrape IG insights for every phone in the selection"
        onClick={() => guard(() => bulkFetchStats())}
      >&#128202; Fetch Stats</button>
      <button
        className="mdbtn sm"
        disabled={busy}
        title="Open the content folder for each selected account"
        onClick={() => guard(() => bulkFolder())}
      >Open Folders</button>
      <button
        className="mdbtn sm"
        disabled={busy}
        title="Create any missing content folders for every phone in the selection"
        onClick={() => guard(() => bulkSetupFolders())}
      >&#128193; Set Up Folders</button>
      <span className="bulk-sep" />
      <button
        className="mdbtn sm"
        disabled={busy}
        title="Clear selection (Esc)"
        onClick={onClear}
      >Clear</button>
    </div>
  )
}
