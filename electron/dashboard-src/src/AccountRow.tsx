import { useState, useRef, useEffect, useCallback } from 'react'
import type { NormalizedAccount } from './types'
import { fmtK, avaHue, relTime, fuelPct, highlight } from './utils'
import { invoke } from './ipc'
import { setToast } from './toast'
import { nextSlotIndex } from './scheduleHelpers'
import StatsDrawer from './StatsDrawer'
import ConfigureModal from './ConfigureModal'
import EditProfileModal from './EditProfileModal'
import { useDash } from './DashContext'

interface Props {
  acct: NormalizedAccount
  query: string
  selected: boolean
  onSelectToggle: (key: string) => void
  // When provided (Command Center), the next-slot label is derived from these
  // instead of a per-row schedule:get IPC — avoids ~N concurrent calls at fleet
  // scale. The per-device dashboard passes nothing → self-fetches as before.
  slots?: { time?: string; content_type?: string }[]
  // Platform badges (Command Center only; per-device dashboard omits).
  // Maps 'instagram' -> 'IG', 'tiktok' -> 'TK'. Defaults to empty (no badges).
  platforms?: string[]
  // Starving marker (Command Center only; per-device dashboard omits).
  starving?: boolean
}

interface ModalCtx {
  serial: string
  userId: string
  account: string
}

const FULL_TANK = 30

export default function AccountRow({ acct, query, selected, onSelectToggle, slots, platforms, starving }: Props) {
  const { refresh: onScheduleChanged } = useDash()
  const { handle, scheduleActive, statsAt, statsError, counts, userId, serial } = acct
  const c = counts

  const total = c.remaining
  const posted = c.posted
  const lowContent = c.lowContent
  const isEmpty = total === 0

  const hue = avaHue(handle)
  const initial = handle[0]?.toUpperCase() ?? '?'
  const pct = fuelPct(total)

  const fuelCls = [
    'fuel',
    isEmpty ? 'empty dry low' : '',
    !isEmpty && lowContent ? 'low' : '',
  ].filter(Boolean).join(' ')

  const fuelUnit = isEmpty ? 'empty' : lowContent ? 'low' : 'ready'

  // ── Toggle state ───────────────────────────────────────────────────────────
  const [swOn, setSwOn] = useState(scheduleActive)
  const [swBusy, setSwBusy] = useState(false)
  const [swPop, setSwPop] = useState(false)

  // Sync from a registry refresh ONLY on a genuine scheduleActive change, and
  // never while a local toggle is in flight — otherwise a mid-IPC refresh reverts
  // the optimistic switch state (showed the pre-click value until the next refresh).
  const lastSchedRef = useRef(scheduleActive)
  useEffect(() => {
    if (scheduleActive === lastSchedRef.current) return
    lastSchedRef.current = scheduleActive
    if (!swBusy) setSwOn(scheduleActive)
  }, [scheduleActive, swBusy])

  const handleToggle = useCallback(async () => {
    if (swBusy) return
    const prev = swOn
    const next = !prev
    setSwOn(next)
    setSwBusy(true)
    setSwPop(false)

    type ToggleResult = { ok?: boolean; error?: string }
    const r: ToggleResult = await invoke<ToggleResult>('schedule:toggle-active', {
      accountKey: handle, serial, userId, platform: 'instagram', isActive: next,
    }).catch((e: Error) => ({ ok: false, error: e?.message } as ToggleResult))

    setSwBusy(false)
    if (r?.ok) {
      setSwPop(true)
      // reset pop class after animation so it can retrigger
      setTimeout(() => setSwPop(false), 400)
      setToast(`@${handle}${next ? ' schedule ON' : ' schedule OFF'}`, 'ok')
    } else {
      // Revert optimistic update
      setSwOn(prev)
      setToast(
        (r?.error || 'toggle failed').slice(0, 80),
        'err',
        { onRetry: handleToggle }
      )
    }
  }, [swBusy, swOn, handle, serial, userId])

  // ── Post Now state ─────────────────────────────────────────────────────────
  const [postLabel, setPostLabel] = useState('Post Now')
  const [postBusy, setPostBusy] = useState(false)
  const [failFlash, setFailFlash] = useState(false)

  // Load the correct next-slot label on mount/update (fire-and-forget, silent)
  useEffect(() => {
    if (isEmpty) return
    // Slots supplied by the Command Center → derive the label synchronously, no IPC.
    if (slots !== undefined) {
      if (slots.length) {
        const idx = nextSlotIndex({ slots } as { slots: { time?: string }[] }, Date.now())
        const ct = slots[idx]?.content_type || 'reel'
        setPostLabel('Post ' + ct.charAt(0).toUpperCase() + ct.slice(1))
      }
      return
    }
    invoke<{ ok?: boolean; row?: { slots?: { time?: string; content_type?: string }[] } }>(
      'schedule:get',
      { accountKey: handle, serial, userId, platform: 'instagram' }
    ).then((r) => {
      if (!r?.ok || !r.row?.slots?.length) return
      const idx = nextSlotIndex(r.row as { slots: { time?: string }[] }, Date.now())
      const ct = (r.row.slots[idx]?.content_type) || 'reel'
      setPostLabel('Post ' + ct.charAt(0).toUpperCase() + ct.slice(1))
    }).catch(() => { /* silent */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, serial, userId, isEmpty, slots])

  const handlePostNow = useCallback(async () => {
    if (postBusy || isEmpty) return
    setPostBusy(true)
    setPostLabel('firing…')

    // Step 2: resolve next-due slot index
    let slotIdx = 0
    try {
      const sc = await invoke<{ ok?: boolean; row?: { slots?: { time?: string; content_type?: string }[] } }>(
        'schedule:get',
        { accountKey: handle, serial, userId, platform: 'instagram' }
      ).catch(() => null)
      if (sc?.ok && sc.row?.slots?.length) {
        slotIdx = nextSlotIndex(sc.row as { slots: { time?: string }[] }, Date.now())
      }
    } catch (_) { /* ignore, fall back to slot 0 */ }

    // Step 3: mark slot as running
    type RunNowResult = { ok?: boolean; slot?: { content_type?: string }; row?: unknown; error?: string }
    const rn: RunNowResult = await invoke<RunNowResult>(
      'schedule:run-now',
      { accountKey: handle, serial, userId, platform: 'instagram', slotIndex: slotIdx }
    ).catch((e: Error) => ({ ok: false, error: e?.message } as RunNowResult))

    if (!rn?.ok) {
      setPostBusy(false)
      setPostLabel('Post Now')
      setToast((rn?.error || 'run-now failed').slice(0, 80), 'err')
      return
    }

    const ct = rn.slot?.content_type || 'reel'
    setToast(`@${handle} posting (${ct})…`, 'warn', { busy: true })

    // Step 4: execute the post
    type PostNowResult = { ok?: boolean; success?: boolean; error?: string }
    const d: PostNowResult = await invoke<PostNowResult>(
      'dashboard:post-now',
      {
        serial, userId, account: handle,
        slot: rn.slot || { content_type: 'reel' },
        row: rn.row || null,
      }
    ).catch((e: Error) => ({ ok: false, error: e?.message } as PostNowResult))

    // Step 5: re-enable button (DOM re-render handles re-acquire)
    setPostBusy(false)

    const ok = d?.ok || d?.success
    if (ok) {
      setPostLabel('Post Now')
      setToast(`@${handle} posted ✓`, 'ok')
    } else {
      setPostLabel('Post Now')
      setFailFlash(true)
      setTimeout(() => setFailFlash(false), 1500)
      setToast(
        (d?.error || 'post failed').slice(0, 80),
        'err',
        { onRetry: handlePostNow }
      )
    }
  }, [postBusy, isEmpty, handle, serial, userId])

  // ── Stats drawer ───────────────────────────────────────────────────────────
  const [statsOpen, setStatsOpen] = useState(false)

  function handleStatsToggle() {
    setStatsOpen((o) => !o)
  }

  // ── Account menu ───────────────────────────────────────────────────────────
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handler(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // ── Configure modal ────────────────────────────────────────────────────────
  const [cfgCtx, setCfgCtx] = useState<ModalCtx | null>(null)

  function openConfigure() {
    setMenuOpen(false)
    setCfgCtx({ serial, userId, account: handle })
  }

  // ── Instagram profile editor ──────────────────────────────────────────────
  const [editProfileCtx, setEditProfileCtx] = useState<ModalCtx | null>(null)

  function openEditProfile() {
    setMenuOpen(false)
    setEditProfileCtx({ serial, userId, account: handle })
  }

  // ── Folder ─────────────────────────────────────────────────────────────────
  const folderBusyRef = useRef(false)

  async function handleFolder() {
    setMenuOpen(false)
    if (folderBusyRef.current) return
    folderBusyRef.current = true
    setToast('opening folder…', 'warn', { busy: true })
    try {
      type FolderResult = { ok?: boolean; error?: string }
      const r: FolderResult = await invoke<FolderResult>('sidebar:open-folder', {
        serial, userId, platform: 'instagram', account: handle,
      }).catch((e: Error) => ({ ok: false, error: e?.message } as FolderResult))
      if (r?.ok) setToast('opened folder', 'ok')
      else setToast((r?.error || 'open failed').slice(0, 80), 'err')
    } finally {
      folderBusyRef.current = false
    }
  }

  // ── Status sub-line ────────────────────────────────────────────────────────
  const statusText = swOn ? 'scheduled' : 'idle'
  const statsLabel = statsError
    ? 'stats unavailable'
    : statsAt ? `stats ${relTime(statsAt)}` : null

  const toolbarTitle = isEmpty ? 'No content remaining' : 'Fire this account\'s next slot now'

  function handleRowClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!(e.ctrlKey || e.metaKey || e.altKey)) return
    const target = e.target as Element
    if (target.closest('button, .sw, input, select, a')) return
    e.preventDefault()
    onSelectToggle(acct.key)
  }

  return (
    <>
      <div
        className={`row4 acct${failFlash ? ' fail-flash' : ''}${selected ? ' sel' : ''}`}
        data-handle={handle}
        data-serial={serial}
        data-userid={userId}
        role="row"
        tabIndex={0}
        onClick={handleRowClick}
        onKeyDown={(e) => { if (e.key === ' ' && e.target === e.currentTarget) { e.preventDefault(); onSelectToggle(acct.key) } }}
      >
        {/* Zone 1: identity */}
        <div className="acct-id">
          <span
            className={`sdot${swOn ? ' on' : ''}${lowContent ? ' low' : ''}`}
            title={swOn ? 'Scheduled' : lowContent ? 'Low content' : 'Idle'}
          />
          <span className="ava" style={{ '--h': hue } as React.CSSProperties}>
            {initial}
          </span>
          <span className="id-stack">
            <span
              className="htext"
              title={`@${handle}`}
              dangerouslySetInnerHTML={{ __html: `@${highlight(handle, query)}` }}
            />
            {(platforms && platforms.length > 0) && (
              <span className="id-platforms">
                {platforms.map((p, i) => {
                  const label = p === 'instagram' ? 'IG' : p === 'tiktok' ? 'TK' : p.toUpperCase().slice(0, 2)
                  return <span key={i} className="cc-badge-plat" title={p}>{label}</span>
                })}
              </span>
            )}
            <span className="id-sub">
              <span className={swOn ? 'st-scheduled' : 'st-idle'}>{statusText}</span>
              {lowContent && (
                <>
                  <span className="dotsep" />
                  <span className="warn">low content</span>
                </>
              )}
              {statsLabel && (
                <>
                  <span className="dotsep" />
                  <span className={statsError ? 'pmeta warn' : 'pmeta'}>{statsLabel}</span>
                </>
              )}
            </span>
          </span>
        </div>

        {/* Zone 2: fuel gauge */}
        <div className={fuelCls}>
          <div className="fuel-top">
            <span className="fuel-n" title={`${total} remaining`}>{fmtK(total)}</span>
            <span className="fuel-u">{fuelUnit}</span>
            <span className="fuel-posted">{fmtK(posted)} posted</span>
            {starving && <span className="cc-mark-starve" title="Starving for content" aria-label="Starving">🟠</span>}
          </div>
          <div
            className="fuel-bar"
            title={`${c.images} image · ${c.videos} video · ${c.reels} reel · ${c.stories} story`}
          >
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>

        {/* Zone 3: automation toggle */}
        <div className="acct-auto">
          <span
            className={`sw${swOn ? ' on' : ''}${swBusy ? ' busy' : ''}${swPop ? ' sw-pop' : ''}`}
            role="switch"
            tabIndex={0}
            aria-label={`Automation schedule for @${handle}`}
            aria-checked={swOn}
            title={swOn ? 'Automation ON' : 'Automation OFF'}
            onClick={handleToggle}
            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handleToggle() } }}
          >
            <span className="lbl off">OFF</span>
            <span className="lbl on">ON</span>
          </span>
        </div>

        {/* Zone 4: actions */}
        <div className="acct-actions">
          <button
            className="act-primary"
            data-act="postnow"
            disabled={isEmpty || postBusy}
            aria-busy={postBusy}
            title={toolbarTitle}
            onClick={handlePostNow}
          >
            {postLabel}
          </button>
          <button
            className={`stats-toggle act-icon${statsOpen ? ' open' : ''}`}
            data-act="stats"
            title="Show insights"
            aria-expanded={statsOpen}
            aria-label={`Toggle insights for @${handle}`}
            onClick={handleStatsToggle}
          >▶</button>
          <span className="amenu-wrap">
            <button
              ref={menuBtnRef}
              className="act-icon"
              data-act="acct-menu"
              aria-label={`Account actions for @${handle}`}
              aria-haspopup="true"
              aria-expanded={menuOpen}
              onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o) }}
            >⋯</button>
            <div ref={menuRef} className={`amenu${menuOpen ? ' show' : ''}`} role="menu">
              <button className="amenu-item" role="menuitem" onClick={openConfigure}>
                <span className="ico">⚙</span>Configure schedule
              </button>
              <button className="amenu-item" role="menuitem" onClick={handleFolder}>
                <span className="ico">📁</span>Open folder
              </button>
              <button className="amenu-item" role="menuitem" onClick={openEditProfile}>
                <span className="ico">✎</span>Edit profile
              </button>
            </div>
          </span>
        </div>
      </div>

      {/* Inline stats drawer */}
      <div
        className={`acct-stats-row${statsOpen ? ' open' : ''}`}
        data-stats-for={handle}
      >
        <StatsDrawer handle={handle} cacheKey={handle} open={statsOpen} />
      </div>

      {/* Modals — rendered inline, portal not needed (cfg-overlay is position:fixed) */}
      <ConfigureModal
        ctx={cfgCtx}
        onClose={() => setCfgCtx(null)}
        onSaved={onScheduleChanged}
      />
      <EditProfileModal
        ctx={editProfileCtx}
        onClose={() => setEditProfileCtx(null)}
        onSaved={onScheduleChanged}
      />
    </>
  )
}
