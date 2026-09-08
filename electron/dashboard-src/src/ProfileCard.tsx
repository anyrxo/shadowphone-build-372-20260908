import { useState, useRef, useEffect, useCallback } from 'react'
import type { NormalizedProfile } from './types'
import { relTime, highlight } from './utils'
import { invoke } from './ipc'
import { setToast } from './toast'
import { useDash } from './DashContext'
import AccountRow from './AccountRow'

interface Props {
  profile: NormalizedProfile
  query: string
  selected: Set<string>
  onSelectToggle: (key: string) => void
}

export default function ProfileCard({ profile, query, selected, onSelectToggle }: Props) {
  const { serial, profileId, name, accounts, scannedAt, switchFailed } = profile
  const { refresh, openCreateIg, openDelete } = useDash()

  const liveCount = accounts.filter(a => a.scheduleActive).length
  const lowCount  = accounts.filter(a => a.counts.lowContent).length

  const scannedLabel = scannedAt ? `scanned ${relTime(scannedAt)}` : 'never scanned'
  const isNeverScanned = !scannedAt

  // count visibility by query
  const visibleAccounts = accounts.filter(a => {
    if (!query) return true
    const q = query.toLowerCase()
    return (
      a.handle.toLowerCase().includes(q) ||
      name.toLowerCase().includes(q) ||
      serial.toLowerCase().includes(q)
    )
  })

  // hide entire pcard if no matches and query is set
  const hidden = query.length > 0 && visibleAccounts.length === 0 &&
    !name.toLowerCase().includes(query.toLowerCase()) &&
    !serial.toLowerCase().includes(query.toLowerCase())

  // ── Per-profile scan ────────────────────────────────────────────────────
  const [scanning, setScanning] = useState(false)
  // Guard post-await state/toast if the card unmounts (profile deleted from the
  // registry mid-scan/rename).
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const handleScan = useCallback(async () => {
    if (scanning) return
    setScanning(true)
    const profileIdVal = /^\d+$/.test(String(profileId)) ? Number(profileId) : String(profileId)
    type ScanResult = { ok?: boolean; error?: string }
    const r: ScanResult = await invoke<ScanResult>('fleet:scan', {
      serial,
      profileIds: [profileIdVal],
    }).catch((e: Error) => ({ ok: false, error: e?.message }))
    setScanning(false)
    if (!mountedRef.current) return
    if (r?.ok) {
      setToast(`@${name} rescanned ✓`, 'ok')
      refresh()
    } else {
      const msg = r?.error === 'phone_busy'
        ? 'phone busy — a run is in progress'
        : (r?.error || 'scan failed').slice(0, 80)
      setToast(msg, 'err')
    }
  }, [scanning, serial, profileId, name, refresh])

  // ── Profile ⋯ menu ──────────────────────────────────────────────────────
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handler(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  function closeMenu() { setMenuOpen(false) }

  // ── Inline rename ────────────────────────────────────────────────────────
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const renameBusyRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  function startRename() {
    closeMenu()
    setRenameVal(name)
    setRenaming(true)
    setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select() }, 20)
  }

  function cancelRename() {
    if (renameBusy) return
    setRenaming(false)
    setRenameVal('')
  }

  const commitRename = useCallback(async () => {
    const next = renameVal.trim()
    if (!next || next === name) { cancelRename(); return }
    setRenameBusy(true)
    renameBusyRef.current = true
    setToast(`renaming "${name}" → "${next}"…`)
    type RenameResult = { success?: boolean; local?: boolean; name?: string; error?: string }
    const r: RenameResult = await invoke<RenameResult>('rename-profile', serial, String(profileId), next)
      .catch((e: Error) => ({ success: false, error: e?.message }))
    setRenameBusy(false)
    renameBusyRef.current = false
    if (!mountedRef.current) return
    if (r?.success) {
      setToast(`renamed → "${r.name || next}" ✓`, 'ok')
      setRenaming(false)
      refresh()
    } else if (r?.local) {
      setToast(`saved "${r.name || next}" (on-device rename pending)`, 'warn')
      setRenaming(false)
      refresh()
    } else {
      setToast((r?.error || 'rename failed').slice(0, 80), 'err')
      setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select() }, 20)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameVal, name, serial, profileId, refresh])

  if (hidden) return null

  return (
    <div className="pcard">
      {/* Profile header — data attrs match HTML contract for IPC routing */}
      <div
        className="profile-head"
        data-serial={serial}
        data-profileid={String(profileId)}
        data-name={name}
        data-acctcount={accounts.length}
      >
        <span className="ph-serial">{serial}</span>
        <span className="pname">
          {renaming ? (
            <>
              <input
                ref={renameInputRef}
                className="pname-edit"
                type="text"
                value={renameVal}
                spellCheck={false}
                disabled={renameBusy}
                onChange={e => setRenameVal(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename() }
                }}
                onBlur={() => { setTimeout(() => { if (!renameBusyRef.current) cancelRename() }, 120) }}
              />
              <button
                className="pname-edit-btn ok"
                title="Save (Enter)"
                disabled={renameBusy}
                onClick={commitRename}
              >&#10003;</button>
              <button
                className="pname-edit-btn cancel"
                title="Cancel (Esc)"
                disabled={renameBusy}
                onClick={e => { e.preventDefault(); cancelRename() }}
              >&times;</button>
            </>
          ) : (
            <span
              className="pname-text"
              dangerouslySetInnerHTML={{ __html: highlight(name, query) }}
            />
          )}
          <span className="pill">profile {profileId}</span>
        </span>
        {switchFailed && <span className="badge-fail">&#9888; switch failed</span>}
        <span className="pspacer" />
        {accounts.length > 0 && (
          <span className="pglance">
            <span className="pg-live">{liveCount} live</span>
            <span className="pg-dot" />
            <span>{accounts.length} account{accounts.length !== 1 ? 's' : ''}</span>
            {lowCount > 0 && (
              <>
                <span className="pg-dot" />
                <span className="pg-low">{lowCount} low</span>
              </>
            )}
          </span>
        )}
        <span className={`pmeta${isNeverScanned ? ' never' : ''}`}>
          {scannedLabel}
        </span>
        <button
          className="mdbtn violet sm"
          disabled={scanning}
          onClick={handleScan}
          title="Scan this profile's IG accounts"
        >
          {scanning ? <>&#8635; scanning…</> : <>&#8635; Scan</>}
        </button>
        <button
          className="mdbtn yellow sm"
          disabled={accounts.length > 0}
          onClick={() => { openCreateIg({ serial, userId: String(profileId), name, accountCount: accounts.length }) }}
          title="Create an IG account on this profile via smspool"
        >
          + Create IG
        </button>
        <span className="pkebab-wrap">
          <button
            ref={menuBtnRef}
            className="mdbtn sm kebab"
            aria-label={`Profile options for ${name}`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={e => { e.stopPropagation(); setMenuOpen(o => !o) }}
          >&#8943;</button>
          <div ref={menuRef} className={`pmenu${menuOpen ? ' show' : ''}`} role="menu">
            <button className="pmenu-item" role="menuitem" onClick={startRename}>
              <span className="ico">&#9998;</span>Rename
            </button>
            <div className="pmenu-sep" />
            <button
              className="pmenu-item danger"
              role="menuitem"
              onClick={() => { closeMenu(); openDelete({ serial, userId: String(profileId), name, accountCount: accounts.length }) }}
            >
              <span className="ico">&#128465;</span>Delete profile
            </button>
          </div>
        </span>
      </div>

      {/* Account rows */}
      {accounts.length > 0 ? (
        <>
          {/* Column header */}
          <div className="row4 acct-head">
            <div title="IG account handle, status, and stats age">Account</div>
            <div title="Content ready to post">Content ready</div>
            <div style={{ textAlign: 'center' }} title="Automation schedule on/off">Auto</div>
            <div className="h-actions" title="Post Now, insights, and more actions">Actions</div>
          </div>
          {/* Account rows — filtered by query if set */}
          {(query ? visibleAccounts : accounts).map(acct => (
            <AccountRow
              key={acct.handle}
              acct={acct}
              query={query}
              selected={selected.has(acct.key)}
              onSelectToggle={onSelectToggle}
            />
          ))}
        </>
      ) : (
        <div className="noaccts">no IG accounts — run Scan</div>
      )}
    </div>
  )
}
