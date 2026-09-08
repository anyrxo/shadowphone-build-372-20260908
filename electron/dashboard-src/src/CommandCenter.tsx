// CommandCenter — the universal, fleet-wide Schedule surface.
// Re-buckets the (model-grouped) registry by PHONE → profile → account, and for
// each account shows its content-folder breakdown + posting slots inline, on top
// of the full per-account action set (reuses AccountRow: Post Now / Configure /
// toggle / stats / folder / bulk-select). Per-phone Scan / Fetch Stats / Set Up
// Folders live on each phone header; fleet-wide versions stay in the topbar.
// Opened fleet-wide (no --sp-serial) from the Fleet panel's "Schedule" button.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ModelGroup as ModelGroupType, NormalizedProfile, NormalizedAccount, Slot } from './types'
import { invoke } from './ipc'
import { setToast } from './toast'
import AccountRow from './AccountRow'
import PhoneTimeLane from './PhoneTimeLane'
import { buildExceptions, keysForFilter, parseHm, computeRunway, type IssueType, type ExceptionSet, type Exception } from './exceptions'
import HealthBand from './HealthBand'
import BulkRetimeModal, { type BulkRetimeChange } from './BulkRetimeModal'
import { buildTakenSet, nextFreeMinute } from './retime-util'
import { buildOverviewModel } from '../../renderer/schedule-overview-model.js'
import { openScheduleEditor } from '../../renderer/schedule-overview-edit.js'

const EMPTY_SLOTS: Slot[] = [] // stable ref so AccountRow's slots-prop effect doesn't churn

interface PhoneBucket {
  serial: string
  name: string
  profiles: NormalizedProfile[]
  accountCount: number
  liveCount: number
}

interface Props {
  allGroups: ModelGroupType[]
  query: string
  selected: Set<string>
  onSelectToggle: (key: string) => void
  onRefresh: () => void
  scheduleVersion: number // bumps on schedule:changed → refetch slots (not every 25s registry refresh)
}

function fmtRel(ms: number): string {
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60000)
  if (m === 0) return 'in <1m'
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  return `in ${h}h ${m % 60}m`
}

// Build serial → friendly phone label from the registry App stamped on window.
function buildSerialNames(): Record<string, string> {
  const reg = (window as unknown as {
    __spRegistry?: { devices?: Record<string, { serial?: string; hwSerial?: string; name?: string; nickname?: string; profiles?: Record<string, { name?: string }> }> }
  }).__spRegistry
  const out: Record<string, string> = {}
  const devices = reg?.devices || {}
  for (const [key, dev] of Object.entries(devices)) {
    const firstProfile = dev.profiles ? Object.values(dev.profiles).map(p => p && p.name).filter(Boolean)[0] : null
    const label = dev.nickname || dev.name || firstProfile || dev.serial || key
    for (const id of [key, dev.serial, dev.hwSerial].filter(Boolean) as string[]) out[id] = String(label)
  }
  return out
}

export default function CommandCenter({ allGroups, query, selected, onSelectToggle, onRefresh, scheduleVersion }: Props) {
  // slots keyed by lowercased handle — handles are effectively unique per account
  const [slotsByHandle, setSlotsByHandle] = useState<Record<string, Slot[]>>({})
  const [busyPhone, setBusyPhone] = useState<string | null>(null)
  const busyRef = useRef(false) // re-entrancy guard (state read in the callback is stale under rapid clicks)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const fetchingRef = useRef(false)
  const seededRef = useRef(false) // one-shot: collapse large fleets on first populate
  const [localVer, setLocalVer] = useState(0) // bumps after an inline schedule edit → refetch slots
  const [editorOpen, setEditorOpen] = useState(false)
  const editorHostRef = useRef<HTMLDivElement>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // most-recent retime-hint timer (singleton host → clear stale ones)
  const [issueFilter, setIssueFilter] = useState<Set<IssueType>>(new Set())
  const [retimeAll, setRetimeAll] = useState<Exception[] | null>(null) // open BulkRetimeModal with these collisions

  const toggleIssue = useCallback((t: IssueType) => {
    setIssueFilter(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }, [])

  // Load every account's schedule. Refetch only when the schedule actually
  // changes (scheduleVersion), NOT on every 25s registry refresh — and never
  // overlap an in-flight fetch.
  useEffect(() => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    let alive = true
    invoke<{ ok?: boolean; rows?: unknown[] }>('schedule:list-all')
      .then(r => {
        if (!alive || !r?.ok || !Array.isArray(r.rows)) return
        const model = buildOverviewModel(r.rows, Date.now()) as { phones?: { accounts?: { account?: string; slots?: Slot[] }[] }[] }
        const map: Record<string, Slot[]> = {}
        for (const ph of (model.phones || [])) {
          for (const a of (ph.accounts || [])) {
            if (a.account) map[String(a.account).replace(/^@/, '').toLowerCase()] = a.slots || []
          }
        }
        setSlotsByHandle(map)
      })
      .catch(() => { /* schedule overlay still works; strip just shows "no schedule" */ })
      .finally(() => { fetchingRef.current = false })
    return () => { alive = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleVersion, localVer])

  const names = useMemo(buildSerialNames, [allGroups])

  // Re-bucket the model-grouped registry into one bucket per physical phone.
  const phones = useMemo<PhoneBucket[]>(() => {
    const map = new Map<string, PhoneBucket>()
    for (const g of allGroups) {
      for (const p of g.profiles) {
        const s = p.serial
        let b = map.get(s)
        if (!b) { b = { serial: s, name: names[s] || s, profiles: [], accountCount: 0, liveCount: 0 }; map.set(s, b) }
        b.profiles.push(p)
        b.accountCount += p.accounts.length
        b.liveCount += p.accounts.filter(a => a.scheduleActive).length
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [allGroups, names])

  // Triage exceptions (collisions / missed / starving / noSchedule / idle / stale) derived
  // from the same data already on screen. PhoneBucket.profiles is NormalizedProfile[]
  // which already matches buildExceptions' expected profile/account shape, so we
  // just map down to { serial, name, profiles } — no field adaptation needed.
  const ex = useMemo<ExceptionSet>(() => buildExceptions(
    phones.map(ph => ({ serial: ph.serial, name: ph.name, profiles: ph.profiles })),
    slotsByHandle,
    { firingSoonMin: 15 }, // "firing soon" = within 15 minutes (summary count only)
  ), [phones, slotsByHandle])

  // Per-account markers: which accounts are starving, and (for collision badges)
  // the zero-padded HH:MM slot times that collide, grouped by account key.
  const starvingKeys = useMemo(() => new Set(ex.starving.map(e => e.key)), [ex])
  const collisionTimesByKey = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const e of ex.collisions) {
      if (!e.slotTime) continue
      const arr = m.get(e.key)
      if (arr) arr.push(e.slotTime); else m.set(e.key, [e.slotTime])
    }
    return m
  }, [ex])

  // Runway label per starving account key (e.g. '~6h left') for the HealthBand
  // quick-fix tooltip. nowMs is sampled ONCE per recompute (not per render) so
  // computeRunway stays deterministic without churning. Slots come from the same
  // slotsByHandle the band's exceptions were built from.
  const runwayByKey = useMemo(() => {
    const nowMs = Date.now()
    const m = new Map<string, string>()
    for (const e of ex.starving) {
      const slots = slotsByHandle[e.handle.toLowerCase()] || EMPTY_SLOTS
      const { label } = computeRunway(e.counts?.remaining ?? 0, slots, nowMs)
      m.set(e.key, label)
    }
    return m
  }, [ex, slotsByHandle])

  // Virtualization (mount-count): on a LARGE fleet, start every phone collapsed
  // so opening mounts ~N light headers instead of thousands of AccountRows (a
  // collapsed phone renders no rows). Small fleets stay expanded. One-shot.
  useEffect(() => {
    if (seededRef.current || !phones.length) return
    seededRef.current = true
    if (phones.length > 6) setCollapsed(new Set(phones.map(p => p.serial)))
  }, [phones])

  // Fleet-wide "what's firing next" — flatten every account's slots, soonest first.
  // (Past-due filtering + the live countdown live in NextFireStrip so its clock
  // tick doesn't re-render the whole account grid.)
  const nextFiring = useMemo(() => {
    const out: { handle: string; type: string; atMs: number }[] = []
    for (const ph of phones) {
      for (const p of ph.profiles) {
        for (const a of p.accounts) {
          for (const s of (slotsByHandle[a.handle.toLowerCase()] || EMPTY_SLOTS)) {
            if (s.nextFireMs != null) out.push({ handle: a.handle, type: s.content_type, atMs: s.nextFireMs })
          }
        }
      }
    }
    out.sort((x, y) => x.atMs - y.atMs)
    return out.slice(0, 24)
  }, [phones, slotsByHandle])

  const runPhone = useCallback(async (
    serial: string,
    channel: 'fleet:scan' | 'insights:fetch' | 'fleet:validate-folders',
    label: string,
  ) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyPhone(serial)
    setToast(`${label} · ${names[serial] || serial}…`)
    try {
      const r = channel === 'fleet:validate-folders'
        ? await invoke<{ ok?: boolean; error?: string }>(channel, serial).catch((e: Error) => ({ ok: false, error: e?.message }))
        : await invoke<{ ok?: boolean; error?: string }>(channel, { serial }).catch((e: Error) => ({ ok: false, error: e?.message }))
      if (r?.ok) { setToast(`${label} done ✓`, 'ok'); onRefresh() }
      else setToast((r?.error || `${label} failed`).slice(0, 80), 'err')
    } finally {
      busyRef.current = false
      setBusyPhone(null)
    }
  }, [names, onRefresh])

  const toggleCollapse = useCallback((serial: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(serial)) next.delete(serial); else next.add(serial)
      return next
    })
  }, [])

  // ── Inline slot editor (reuses the same DOM editor the schedule overlay uses) ──
  const closeEditor = useCallback(() => {
    if (hintTimerRef.current) { clearTimeout(hintTimerRef.current); hintTimerRef.current = null }
    const host = editorHostRef.current
    if (host) { host.hidden = true; host.textContent = '' }
    setEditorOpen(false)
    setLocalVer(v => v + 1) // pick up any edits made while open
  }, [])

  const openEditor = useCallback((acct: NormalizedAccount) => {
    const host = editorHostRef.current
    if (!host) return
    host.hidden = false
    setEditorOpen(true)
    const idArgs = { accountKey: acct.handle, serial: acct.serial, userId: acct.userId, platform: 'instagram', key: acct.key }
    openScheduleEditor(
      host,
      { serial: acct.serial, account: acct.handle, androidUser: acct.userId, user: acct.handle },
      {
        load: () => invoke('schedule:get', idArgs),
        save: (patch: unknown) => invoke('schedule:save', { ...idArgs, patch }),
        runNow: async (slotIndex: number) => {
          const res = await invoke<{ ok?: boolean; error?: string }>('schedule:fire-now', { ...idArgs, slotIndex })
            .catch((e: Error) => ({ ok: false, error: e?.message }))
          if (res && !res.ok) setToast(res.error || 'fire-now failed', 'err')
          else setToast(`firing @${acct.handle} now…`, 'ok')
        },
        refresh: () => setLocalVer(v => v + 1),
        close: () => closeEditor(),
      },
    )
  }, [closeEditor])

  // Given a collision exception, find the nearest minute on the SAME phone that
  // has no scheduled slot. Build the set of taken HH:MM for that serial from the
  // loaded slots, then scan forward in 1-min steps from the collision's slotTime,
  // wrapping past midnight. Pure; if every minute is somehow taken, returns the
  // original time so the hint still shows something sane.
  const getNextFreeSlot = useCallback((e: Exception): string => {
    const start = String(e.slotTime || '').slice(0, 5)
    if (!/^\d{2}:\d{2}$/.test(start)) return start
    // Shared jitter-aware math (retime-util): build the taken set for this serial
    // (each slot blocks its WHOLE [T, T+jitter] window), then scan forward for the
    // first free minute. The bulk Retime-all modal uses the same two helpers.
    const taken = buildTakenSet(e.serial, phones, slotsByHandle)
    return nextFreeMinute(start, taken)
  }, [phones, slotsByHandle])

  // Esc closes the inline editor
  useEffect(() => {
    if (!editorOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeEditor() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [editorOpen, closeEditor])

  const q = query.toLowerCase().trim()

  // When an issue chip is active, collapse the roster to only the accounts whose
  // key is in that issue bucket (and force-expand their phones).
  const activeFilter = issueFilter.size > 0
  const filterKeys = useMemo(
    () => activeFilter ? keysForFilter(ex, issueFilter) : new Set<string>(),
    [ex, issueFilter], // activeFilter is derived from issueFilter.size — redundant dep
  )

  // Pre-compute which phones render (so we can show a "no matches" message).
  const rendered = useMemo(() => phones.map(ph => {
    const visibleProfiles = ph.profiles.map(p => ({
      ...p,
      accounts: p.accounts.filter(a => {
        if (activeFilter && !filterKeys.has(a.key)) return false
        if (!q) return true
        return (
          a.handle.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          ph.name.toLowerCase().includes(q) ||
          ph.serial.toLowerCase().includes(q)
        )
      }),
    }))
    const phoneMatches = !q || ph.name.toLowerCase().includes(q) || ph.serial.toLowerCase().includes(q)
    const anyAccts = visibleProfiles.some(p => p.accounts.length > 0)
    // While filtering: only show phones that still have visible accounts.
    const show = activeFilter ? anyAccts : (!q || phoneMatches || anyAccts)
    return { ph, visibleProfiles, show }
  }).filter(x => x.show), [phones, q, activeFilter, filterKeys])

  // Quick-fix handlers for the HealthBand. O(1) case-insensitive handle lookup —
  // built once per phones change. (The old O(n) case-sensitive .find() silently
  // no-op'd Retime/Fill when an Exception's handle differed in case.)
  const acctByHandleMap = useMemo(() => {
    const m = new Map<string, NormalizedAccount>()
    for (const ph of phones)
      for (const p of ph.profiles)
        for (const a of p.accounts) m.set(a.handle.toLowerCase(), a)
    return m
  }, [phones])

  const handleRetimeClick = useCallback((e: Exception) => {
    const acct = acctByHandleMap.get(e.handle.toLowerCase())
    if (!acct) {
      setToast('Could not locate @' + e.handle, 'warn')
      return
    }
    openEditor(acct)
    // The editor renders asynchronously into the SINGLETON editorHostRef. After a
    // short tick, prepend a "next free slot" hint into its body. Clear any prior
    // pending timer first so a fast A→B retime can't fire A's stale hint into B's
    // now-shared body. Fully defensive: if the body isn't there yet (or ever), do
    // nothing. De-duped so re-opening never stacks.
    const nextFree = getNextFreeSlot(e)
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    hintTimerRef.current = setTimeout(() => {
      hintTimerRef.current = null
      const body = editorHostRef.current?.querySelector('.sov-ed-body')
      if (!body) return
      body.querySelector('.cc-ed-hint')?.remove()
      const hint = document.createElement('div')
      hint.className = 'cc-ed-hint'
      hint.textContent = `Next free slot on this phone: ${nextFree}`
      body.insertBefore(hint, body.firstChild)
    }, 90)
  }, [acctByHandleMap, openEditor, getNextFreeSlot])

  const handleRetimeAll = useCallback((collisions: Exception[]) => {
    setRetimeAll(collisions)
  }, [])

  // Apply a batch of proposed retimes. A schedule:save patch REPLACES the slots
  // array wholesale ({...existing,...patch} — see schedule-handlers _saveSchedule),
  // so to retime ONE slot we must resend the account's FULL slots array with just
  // the matching slot's time changed (every other slot + field preserved). Read
  // each account's current slots from slotsByHandle, map from→to on the first
  // matching slot, and save the whole array. Guards accounts we can't locate.
  const applyBulkRetime = useCallback(async (changes: BulkRetimeChange[]) => {
    // COALESCE per account: an account with two colliding slots gets two `changes`
    // rows. Issuing a save per row would each rebuild from the SAME stale
    // slotsByHandle, so the 2nd save's full-array replace ({...existing,...patch})
    // would revert the 1st. Instead, apply ALL of an account's rewrites onto its
    // current slots ONCE and save the account a single time.
    const byHandle = new Map<string, BulkRetimeChange[]>()
    for (const ch of changes) {
      const h = ch.handle.toLowerCase()
      const arr = byHandle.get(h); if (arr) arr.push(ch); else byHandle.set(h, [ch])
    }
    let ok = 0
    let fail = 0
    for (const [h, chs] of byHandle) {
      const acct = acctByHandleMap.get(h)
      const current = slotsByHandle[h]
      if (!acct || !current) { fail += chs.length; continue }
      // from HH:MM → to HH:MM. Each from is consumed once (delete on match) so two
      // slots sharing a from-time each get their own rewrite, and `pending.size`
      // after the map = unmatched rewrites.
      const pending = new Map(chs.map(c => [c.from, c.to]))
      const nextSlots = current.map(s => {
        const hm = parseHm(s.time) ?? String(s.time).slice(0, 5)
        const to = pending.get(hm)
        if (to != null) { pending.delete(hm); return { ...s, time: `${to}:00` } }
        return s
      })
      const applied = chs.length - pending.size // rewrites that matched a real slot
      const idArgs = { accountKey: acct.handle, serial: acct.serial, userId: acct.userId, platform: 'instagram', key: acct.key }
      try {
        const r = await invoke<{ ok?: boolean; error?: string }>('schedule:save', { ...idArgs, patch: { slots: nextSlots } })
        if (r?.ok) { ok += applied; fail += chs.length - applied }
        else fail += chs.length
      } catch { fail += chs.length }
    }
    setToast(`retimed ${ok}/${changes.length}${fail ? ` — ${fail} failed` : ' — collisions cleared'}`, fail ? 'warn' : 'ok')
    setLocalVer(v => v + 1) // refetch slots → band recomputes, collisions drop
  }, [acctByHandleMap, slotsByHandle])

  // Timeline tick click → open the same inline editor the slot strip uses. The
  // tick carries (serial, handle, slotTime); we resolve the account by handle and
  // reuse openEditor (slotTime is informational — openEditor opens the full editor).
  const handleTimelinePick = useCallback((_serial: string, handle: string) => {
    const acct = acctByHandleMap.get(handle.toLowerCase())
    if (!acct) { setToast('Could not locate @' + handle, 'warn'); return }
    openEditor(acct)
  }, [acctByHandleMap, openEditor])

  const handleFillClick = useCallback((e: Exception) => {
    const acct = acctByHandleMap.get(e.handle.toLowerCase())
    if (!acct) {
      setToast('Could not locate @' + e.handle, 'warn')
      return
    }
    invoke('sidebar:open-folder', {
      serial: acct.serial, userId: acct.userId, platform: 'instagram', account: acct.handle,
    }).catch(() => { /* silent — folder open is best-effort */ })
  }, [acctByHandleMap])

  // Silent-idle fix: the account is scheduleActive but has zero slots, so it never
  // posts. Blind-save ONE default slot via the SAME schedule:save path the inline
  // editor uses (idArgs + patch:{slots}), matching buildPatch's slot shape exactly
  // ({ time:'HH:MM:SS', content_type }). On success, bump localVer to refetch slots
  // so the band recomputes and the noSchedule chip count drops.
  const handleAddSchedule = useCallback((e: Exception) => {
    const acct = acctByHandleMap.get(e.handle.toLowerCase())
    if (!acct) {
      setToast('Could not locate @' + e.handle, 'warn')
      return
    }
    const idArgs = { accountKey: acct.handle, serial: acct.serial, userId: acct.userId, platform: 'instagram', key: acct.key }
    const patch = { is_active: true, slots: [{ time: '09:00:00', content_type: 'reel' }] }
    invoke<{ ok?: boolean; error?: string }>('schedule:save', { ...idArgs, patch })
      .then(r => {
        if (r?.ok) { setToast(`Added 09:00 reel for @${acct.handle}`, 'ok'); setLocalVer(v => v + 1) }
        else setToast((r?.error || 'Add schedule failed').slice(0, 80), 'warn')
      })
      .catch((err: Error) => setToast((err?.message || 'Add schedule failed').slice(0, 80), 'warn'))
  }, [acctByHandleMap])

  if (!phones.length) {
    return <div className="cc-empty">No phones detected — connect a phone, or run Detect Accounts from a phone header.</div>
  }

  return (
    <div className="cc">
      <HealthBand
        ex={ex}
        active={issueFilter}
        onToggle={toggleIssue}
        onClear={() => setIssueFilter(new Set())}
        onRetimeClick={handleRetimeClick}
        onRetimeAll={handleRetimeAll}
        onFillClick={handleFillClick}
        onAddScheduleClick={handleAddSchedule}
        runwayByKey={runwayByKey}
      />

      <NextFireStrip nextFiring={nextFiring} />

      {phones.length > 1 && (
        <div className="cc-toolbar">
          <span className="cc-toolbar-count">{phones.length} phones</span>
          <span className="cc-spacer" />
          <button className="mdbtn ghost sm" onClick={() => setCollapsed(new Set())}>Expand all</button>
          <button className="mdbtn ghost sm" onClick={() => setCollapsed(new Set(phones.map(p => p.serial)))}>Collapse all</button>
        </div>
      )}

      {(q || issueFilter.size > 0) && rendered.length === 0 && (
        <div className="cc-empty">
          {q ? <>No accounts match &ldquo;{query}&rdquo;.</> : 'No accounts match this filter.'}
        </div>
      )}

      {rendered.map(({ ph, visibleProfiles }) => {
        const busy = busyPhone === ph.serial
        const isCollapsed = collapsed.has(ph.serial) && !q && !activeFilter // a query or active filter always expands matches

        return (
          <div className={`cc-phone${isCollapsed ? ' collapsed' : ''}`} key={ph.serial}>
            <div
              className="cc-phone-head"
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              onClick={() => toggleCollapse(ph.serial)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(ph.serial) } }}
            >
              <span className="cc-chev" aria-hidden="true">&#9660;</span>
              <span className="cc-phone-medal" aria-hidden="true">{(ph.name[0] || '?').toUpperCase()}</span>
              <span className="cc-phone-name">{ph.name}</span>
              <span className="cc-phone-serial">{ph.serial}</span>
              <span className="cc-phone-glance">
                <span className="cc-pg-live">{ph.liveCount} live</span>
                <span className="cc-pg-dot" />
                <span>{ph.accountCount} account{ph.accountCount !== 1 ? 's' : ''}</span>
              </span>
              <span className="cc-spacer" />
              <button className="mdbtn ghost sm" disabled={busy} title="Detect this phone's IG accounts" onClick={e => { e.stopPropagation(); runPhone(ph.serial, 'fleet:scan', 'Scan') }}>&#8635; Scan</button>
              <button className="mdbtn sm" disabled={busy} title="Scrape IG insights for this phone" onClick={e => { e.stopPropagation(); runPhone(ph.serial, 'insights:fetch', 'Fetch Stats') }}>&#128202; Stats</button>
              <button className="mdbtn ghost sm" disabled={busy} title="Create any missing content folders for this phone" onClick={e => { e.stopPropagation(); runPhone(ph.serial, 'fleet:validate-folders', 'Folders') }}>&#128193; Folders</button>
            </div>

            {!isCollapsed && (
              <PhoneTimeLane
                phone={ph}
                slotsByHandle={slotsByHandle}
                collisionTimesByKey={collisionTimesByKey}
                onPick={handleTimelinePick}
              />
            )}

            {!isCollapsed && visibleProfiles.map(p => (
              <div className="cc-profile" key={`${p.serial}::${p.profileId}::${p.name}`}>
                <div className="cc-profile-head">
                  <span className="cc-profile-name">{p.name}</span>
                  <span className="cc-profile-pill">profile {p.profileId}</span>
                  {p.switchFailed && <span className="badge-fail">&#9888; switch failed</span>}
                </div>
                {p.accounts.length === 0
                  ? <div className="cc-noaccts">no IG accounts — Scan this phone</div>
                  : p.accounts.map(acct => {
                    const slots = slotsByHandle[acct.handle.toLowerCase()] || EMPTY_SLOTS
                    const starving = starvingKeys.has(acct.key)
                    const collisionTimes = collisionTimesByKey.get(acct.key)
                    return (
                      <div className="cc-acct" key={acct.handle}>
                        <AccountRow
                          acct={acct}
                          query={query}
                          selected={selected.has(acct.key)}
                          onSelectToggle={onSelectToggle}
                          slots={slots}
                          platforms={['instagram']}
                          starving={starving}
                        />
                        <CcStrip acct={acct} slots={slots} onEdit={openEditor} starving={starving} collisionTimes={collisionTimes} />
                      </div>
                    )
                  })}
              </div>
            ))}
          </div>
        )
      })}

      {/* Inline slot editor overlay — mounts the SAME DOM editor the schedule
          overlay uses, so it's add/remove/retime/change-type/fire-now per slot. */}
      <div
        className={`cc-editor-overlay${editorOpen ? ' show' : ''}`}
        onMouseDown={e => { if (e.target === e.currentTarget) closeEditor() }}
      >
        <div className="cc-editor" role="dialog" aria-modal={true} aria-label="Edit schedule">
          <div className="cc-editor-bar">
            <span className="cc-editor-title">Edit schedule</span>
            <button className="mdbtn sm" onClick={closeEditor}>Close</button>
          </div>
          <div ref={editorHostRef} className="cc-editor-host" hidden />
        </div>
      </div>

      {retimeAll && (
        <BulkRetimeModal
          collisions={retimeAll}
          phones={phones}
          slotsByHandle={slotsByHandle}
          phoneNameBySerial={names}
          onApply={applyBulkRetime}
          onClose={() => setRetimeAll(null)}
        />
      )}
    </div>
  )
}

// Fleet "next firing" header — owns its OWN clock so the per-minute countdown
// tick never re-renders the (potentially huge) account grid above.
function NextFireStrip({ nextFiring }: { nextFiring: { handle: string; type: string; atMs: number }[] }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  // Drop slots that fired more than a minute ago; show the soonest 6.
  const upcoming = nextFiring.filter(nf => nf.atMs > now - 60_000).slice(0, 6)
  if (!upcoming.length) return null
  return (
    <div className="cc-nextfire" role="status" aria-label="Next scheduled posts across the fleet">
      <span className="cc-nf-label">&#9889; Next firing</span>
      {upcoming.map(nf => (
        <span className="cc-nf-item" key={`${nf.handle}-${nf.atMs}`}>
          <b>@{nf.handle}</b>
          <span className="cc-nf-when">{fmtRel(nf.atMs - now)}</span>
          <span className="cc-nf-type">{nf.type}</span>
        </span>
      ))}
    </div>
  )
}

// Per-account strip: content-folder breakdown + the posting slots inline.
// The slots area is a button → opens the inline schedule editor for this account.
function CcStrip({ acct, slots, onEdit, starving, collisionTimes }: { acct: NormalizedAccount; slots: Slot[]; onEdit: (a: NormalizedAccount) => void; starving?: boolean; collisionTimes?: string[] }) {
  const c = acct.counts
  return (
    <div className="cc-strip">
      <span className="cc-folders" title="content folders: images · reels · stories">
        <span className={`cc-fchip${c.images ? '' : ' zero'}`}>&#128247; {c.images}</span>
        <span className={`cc-fchip${c.reels ? '' : ' zero'}`}>&#127909; {c.reels}</span>
        <span className={`cc-fchip${c.stories ? '' : ' zero'}`}>&#128241; {c.stories}</span>
        {starving && <span className="cc-mark-starve" title="Starving for content" aria-label="Starving">🟠</span>}
      </span>
      <span
        className="cc-slots cc-slots--edit"
        role="button"
        tabIndex={0}
        title="Edit this account's posting schedule"
        onClick={() => onEdit(acct)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(acct) } }}
      >
        {slots.length === 0
          ? <span className="cc-noslots">+ add schedule</span>
          : slots.map((s, i) => {
            const slotTime = String(s.time).slice(0, 5)
            // collisionTimes are zero-padded HH:MM (buildExceptions' parseHm), so a
            // single-digit-hour slot like '9:05' must be normalized before compare —
            // otherwise the ⚠ marker never matches. Fall back to slotTime if unparseable.
            const normTime = parseHm(s.time) ?? slotTime
            const isColliding = collisionTimes && collisionTimes.includes(normTime)
            return (
              <span
                className={`cc-slot cc-slot--${s.status}${isColliding ? ' cc-mark-collide' : ''}`}
                key={i}
                title={`${s.content_type} · ${s.status}${isColliding ? ' · COLLIDES' : ''}`}
              >
                <b>{slotTime}</b> {s.content_type} {isColliding && <span className="cc-collision-badge" aria-label="Colliding">⚠</span>}
              </span>
            )
          })}
        <span className="cc-edit-hint" aria-hidden="true">&#9998;</span>
      </span>
    </div>
  )
}
