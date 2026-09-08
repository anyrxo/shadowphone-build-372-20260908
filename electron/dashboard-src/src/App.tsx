import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { invoke, useIpcEvent } from './ipc'
import type { Registry, ModelGroup as ModelGroupType, ProfMeta, PulseStats, SortKey, LoadState, InsightsAgg, InsightsSeriesPoint } from './types'
import { groupByModel, fmtK, relTime, getSerial, getUniversal, getCreateIgContext, attachAccountKeys, buildAccountKey, aggregateInsights } from './utils'
import FleetPulse from './FleetPulse'
import Findbar from './Findbar'
import ModelGroup from './ModelGroup'
import { Skeleton, FirstRun, NoMatch, ErrorState } from './States'
import { DashContext, type ProfileCtx } from './DashContext'
import { clearStatsCache } from './StatsDrawer'
import Analytics, { type SeriesPoint } from './Analytics'
import ScheduleOverlay from './ScheduleOverlay'
import Topbar from './Topbar'
import CommandPalette from './CommandPalette'
import CreateIgModal from './CreateIgModal'
import AddProfileModal from './AddProfileModal'
import DeleteModal from './DeleteModal'
import BulkCreateModal from './BulkCreateModal'
import LiveCreationLog from './LiveCreationLog'
import BulkBar from './BulkBar'
import CommandCenter from './CommandCenter'
import { setToast } from './toast'

const LOAD_TIMEOUT_MS = 30_000
const REFRESH_INTERVAL_MS = 25_000

// Build profMeta Map from raw registry devices (NOT from groupByModel output)
function buildProfMeta(registry: Registry): Map<string, ProfMeta> {
  const map = new Map<string, ProfMeta>()
  const devices = registry.devices || {}
  for (const serial of Object.keys(devices)) {
    const dev = devices[serial] || {}
    const profiles = dev.profiles || {}
    for (const pid of Object.keys(profiles)) {
      const p = profiles[pid] || {}
      const key = `${dev.serial || serial}::${p.profileId ?? pid}`
      map.set(key, {
        scannedAt: p.scannedAt ?? null,
        switchFailed: !!p.switchFailed,
      })
    }
  }
  return map
}

// Attach profMeta to profiles in each group
function attachMeta(groups: ModelGroupType[], profMeta: Map<string, ProfMeta>): ModelGroupType[] {
  return groups.map(g => ({
    ...g,
    profiles: g.profiles.map(p => {
      const key = `${p.serial}::${p.profileId}`
      const meta = profMeta.get(key)
      return {
        ...p,
        scannedAt: meta?.scannedAt ?? null,
        switchFailed: meta?.switchFailed ?? false,
      }
    }),
  }))
}

// Narrow registry to single serial scope
function scopeRegistry(registry: Registry, serial: string | null): Registry {
  if (!serial || !registry.devices[serial]) return registry
  return { ...registry, devices: { [serial]: registry.devices[serial] } }
}

// Compute fleet-wide pulse stats from ALL groups (always unfiltered)
function computePulse(groups: ModelGroupType[]): PulseStats {
  let live = 0, idle = 0, low = 0, fail = 0, totalReady = 0
  let totalAccounts = 0, profiles = 0, models = groups.length

  for (const g of groups) {
    for (const p of g.profiles) {
      profiles++
      if (p.switchFailed) fail++
      for (const a of p.accounts) {
        totalAccounts++
        if (a.scheduleActive) live++
        else idle++
        // low-content is independent of schedule state (an account can be both
        // scheduled AND low), so count it separately — matches the HTML pulse.
        if (a.counts.lowContent) low++
        totalReady += a.counts.remaining
      }
    }
  }

  return {
    live, idle, low, fail,
    total: totalAccounts,
    models, profiles,
    followers: '—',
    views: '—',
    ready: fmtK(totalReady),
    noDevices: totalAccounts === 0,
  }
}

// Apply findability — filter + sort
function applyFindability(
  groups: ModelGroupType[],
  query: string,
  chips: Record<string, boolean>,
  sort: SortKey,
): ModelGroupType[] {
  const q = query.toLowerCase().trim()
  const activeChips = Object.entries(chips).filter(([, v]) => v).map(([k]) => k)

  let result = groups.map(g => {
    // Filter profiles/accounts
    const filteredProfiles = g.profiles.map(p => {
      let accounts = p.accounts

      // Text filter
      if (q) {
        accounts = accounts.filter(a =>
          a.handle.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.serial.toLowerCase().includes(q) ||
          g.model.toLowerCase().includes(q)
        )
      }

      // Chip filters
      if (chips.scheduled) accounts = accounts.filter(a => a.scheduleActive)
      if (chips.low) accounts = accounts.filter(a => a.counts.lowContent)
      if (chips.switchfailed) {
        // show profile if it has switchFailed, regardless of accounts
        if (!p.switchFailed) accounts = []
      }

      return { ...p, accounts }
    }).filter(p => p.accounts.length > 0 || (chips.switchfailed && p.switchFailed))

    return { ...g, profiles: filteredProfiles, accountCount: filteredProfiles.reduce((n, p) => n + p.accounts.length, 0) }
  }).filter(g => g.profiles.length > 0)

  // Sort
  if (sort === 'model') {
    result.sort((a, b) => a.model.toLowerCase().localeCompare(b.model.toLowerCase()))
  } else if (sort === 'content') {
    result.sort((a, b) => {
      const ta = a.profiles.flatMap(p => p.accounts).reduce((n, ac) => n + ac.counts.remaining, 0)
      const tb = b.profiles.flatMap(p => p.accounts).reduce((n, ac) => n + ac.counts.remaining, 0)
      return tb - ta
    })
  } else if (sort === 'low') {
    result.sort((a, b) => {
      const la = a.profiles.flatMap(p => p.accounts).filter(ac => ac.counts.lowContent).length
      const lb = b.profiles.flatMap(p => p.accounts).filter(ac => ac.counts.lowContent).length
      return lb - la
    })
  } else if (sort === 'scanned') {
    result.sort((a, b) => {
      const latestTs = (g: ModelGroupType) => {
        let t = 0
        for (const p of g.profiles) {
          const ts = p.scannedAt
          if (ts) {
            const n = typeof ts === 'number' ? ts : Date.parse(ts as string)
            if (n > t) t = n
          }
        }
        return t
      }
      return latestTs(b) - latestTs(a)
    })
  }

  return result
}

function freshLabel(loadedAt: number | null, isRefreshing: boolean): string {
  if (isRefreshing) return 'refreshing…'
  if (!loadedAt) return ''
  return `updated ${relTime(loadedAt)}`
}

export default function App() {
  const [createContext] = useState(getCreateIgContext)
  if (createContext) return <CreateIgModal ctx={createContext} onClose={() => window.close()} onDone={() => window.close()} />
  return <Dashboard />
}

function Dashboard() {
  const serial = getSerial()
  const universal = getUniversal() // fleet-wide Command Center (no device scope)

  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [allGroups, setAllGroups] = useState<ModelGroupType[]>([])
  const [pulseStats, setPulseStats] = useState<PulseStats>({
    live: 0, idle: 0, low: 0, fail: 0, total: 0, models: 0, profiles: 0,
    followers: '—', views: '—', ready: '—', noDevices: true,
  })
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isStale, setIsStale] = useState(false)
  // Real fleet insights (followers/views/trend) aggregated from insights:get-all-series.
  const [insightsAgg, setInsightsAgg] = useState<InsightsAgg | null>(null)

  // Findbar state
  const [query, setQuery] = useState('')
  const [chips, setChips] = useState<Record<string, boolean>>({ scheduled: false, low: false, switchfailed: false })
  const [sort, setSort] = useState<SortKey>('model')

  // Collapse state: model -> collapsed boolean
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  // Analytics overlay state
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const analyticsSeries = useRef<Record<string, SeriesPoint[]> | null>(null)

  // Schedule overlay state
  const [scheduleOpen, setScheduleOpen] = useState(false)

  // Multi-select state — keyed by buildAccountKey (unique across fleet)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggleSelect = useCallback((key: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])

  const clearSelect = useCallback(() => setSelected(new Set()), [])

  // Esc clears selection
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') clearSelect() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [clearSelect])

  // Flat key->account lookup for BulkBar (rebuilt when allGroups changes)
  const keyToAcct = useMemo(() => {
    const map = new Map<string, import('./types').NormalizedAccount>()
    for (const g of allGroups)
      for (const p of g.profiles)
        for (const a of p.accounts)
          map.set(buildAccountKey(a.serial, a.userId, a.handle), a)
    return map
  }, [allGroups])

  // Phase 5 modal state
  const [createIgCtx, setCreateIgCtx] = useState<ProfileCtx | null>(null)
  const [deleteCtx, setDeleteCtx] = useState<ProfileCtx | null>(null)
  const [addProfileOpen, setAddProfileOpen] = useState(false)
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false)

  // Command palette open state
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Fleet sweep (Detect Accounts / Fetch Stats) busy lock — prevents concurrent
  // multi-minute sweeps and disables the topbar buttons while one runs.
  const [sweepBusy, setSweepBusy] = useState(false)
  const sweepRef = useRef(false)
  // Bumps on schedule:changed so the Command Center refetches slots only when a
  // schedule actually changes (not on every 25s registry refresh).
  const [scheduleVersion, setScheduleVersion] = useState(0)

  // Scan / Fetch-Stats progress bar (driven by per-profile progress events that
  // the backend sends to event.sender = this window).
  const [scanLabel, setScanLabel] = useState('')
  const [scanPct, setScanPct] = useState(0)
  const [scanShow, setScanShow] = useState(false)
  const scanHideRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadInFlightRef = useRef(false)

  const load = useCallback(async (isRefresh = false) => {
    if (loadInFlightRef.current) return
    loadInFlightRef.current = true
    if (isRefresh) {
      setIsRefreshing(true)
      setIsStale(true)
    } else {
      setLoadState('loading')
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutRef.current = setTimeout(() => reject(new Error('Request timed out after 30 seconds')), LOAD_TIMEOUT_MS)
    })

    try {
      const res = await Promise.race([
        invoke<{ ok: boolean; registry?: Registry; stale?: boolean; loading?: boolean; error?: string }>('fleet:get-registry'),
        timeoutPromise,
      ])

      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }

      if (!res?.ok || !res.registry) {
        throw new Error(res?.error || 'Registry response was not ok')
      }

      const registry = res.registry
      const scoped = scopeRegistry(registry, serial)
      const profMeta = buildProfMeta(scoped)
      const rawGroups = groupByModel(scoped)
      const groups = attachAccountKeys(attachMeta(rawGroups, profMeta))

      // New registry = stale drawer data purged (mirrors _statsDrawerCache.clear() + _analyticsSeries=null in HTML)
      if (!isRefresh) {
        clearStatsCache()
        analyticsSeries.current = null
      }

      setAllGroups(groups)
      // Expose the registry for ScheduleOverlay's serial→profile-name mapping
      // (mirrors the HTML window.__spRegistry contract; without it every phone
      // header in the schedule overlay shows a raw serial instead of the name).
      ;(window as unknown as { __spRegistry?: Registry }).__spRegistry = registry
      setPulseStats(computePulse(groups))

      // Real fleet followers/views/trend — aggregated from the per-account
      // insights series (one bulk fs read, designed for this 25s tick). Fire
      // non-blocking so the roster never waits on it; on any failure the hero
      // simply keeps showing '—'.
      {
        const totalAccounts = groups.reduce((n, g) => n + g.profiles.reduce((m, p) => m + p.accounts.length, 0), 0)
        invoke<{ ok?: boolean; series?: Record<string, InsightsSeriesPoint[]> }>('insights:get-all-series')
          .then(r => {
            if (r?.ok && r.series) setInsightsAgg(aggregateInsights(r.series, totalAccounts, Date.now()))
          })
          .catch(() => { /* keep prior agg / '—' */ })
      }

      setLoadedAt(Date.now())
      setLoadState(res.stale && groups.length === 0 ? 'loading' : 'loaded')
      setIsStale(!!res.stale)
      setIsRefreshing(false)

    } catch (e: unknown) {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
      const msg = e instanceof Error ? e.message : String(e)
      setErrorMsg(msg)

      if (isRefresh) {
        // Don't blow away the list on a background refresh failure
        setIsRefreshing(false)
        setIsStale(true)
        setLoadState(current => current === 'loaded' ? 'loaded' : 'error')
      } else {
        setLoadState('error')
      }
    } finally {
      loadInFlightRef.current = false
      if (refreshRef.current) clearTimeout(refreshRef.current)
      refreshRef.current = setTimeout(() => load(true), REFRESH_INTERVAL_MS)
    }
  }, [serial])

  // Initial load
  useEffect(() => {
    load(false)
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (refreshRef.current) clearTimeout(refreshRef.current)
      if (scanHideRef.current) clearTimeout(scanHideRef.current)
    }
  }, [load])

  // Push: re-load on registry change or schedule change (mirrors HTML _onRegistryPush on both events)
  useIpcEvent('fleet:registry-changed', () => load(false))
  useIpcEvent('schedule:changed', () => { setScheduleVersion(v => v + 1); load(true) })

  // Scan / Fetch-Stats progress → progress bar (auto-hides shortly after the
  // last event; sweeps end without a terminal event).
  const onScanProgress = useCallback((raw: unknown, kind: 'scan' | 'insights') => {
    const e = (raw || {}) as { index?: number; total?: number; name?: string; profileId?: string | number; account?: string }
    const pct = e.total ? Math.round(((e.index ?? 0) / e.total) * 100) : 0
    const who = kind === 'insights'
      ? (e.account ? '@' + e.account : (e.name || String(e.profileId ?? '')))
      : (e.name || String(e.profileId ?? ''))
    setScanLabel(`${kind === 'insights' ? 'fetching stats' : 'scanning'} ${who} (${e.index ?? 0}/${e.total ?? '?'})`)
    setScanPct(pct)
    setScanShow(true)
    if (scanHideRef.current) clearTimeout(scanHideRef.current)
    scanHideRef.current = setTimeout(() => setScanShow(false), 1500)
  }, [])

  useIpcEvent('fleet:scan-progress', (...a: unknown[]) => onScanProgress(a[0], 'scan'))
  useIpcEvent('insights:fetch-progress', (...a: unknown[]) => onScanProgress(a[0], 'insights'))

  // ── Topbar fleet-wide actions ─────────────────────────────────────────────
  const resolveSerial = useCallback(
    () => serial ?? allGroups[0]?.profiles[0]?.serial ?? null,
    [serial, allGroups],
  )

  // Detect Accounts (fleet:scan, no profileIds = all) + Fetch Stats (insights:fetch)
  const runSweep = useCallback(async (
    channel: 'fleet:scan' | 'insights:fetch',
    label: string,
  ) => {
    if (sweepRef.current) return
    sweepRef.current = true
    setSweepBusy(true)
    try {
      if (universal) {
        // Universal Command Center: fleet:scan / insights:fetch are per-phone
        // (serial required, no fleet loop in the handler), so fan out across
        // EVERY unique phone sequentially — a real fleet-wide sweep.
        const serials = [...new Set(allGroups.flatMap(g => g.profiles.map(p => p.serial)))].filter(Boolean)
        if (!serials.length) { setToast('no phones connected', 'err'); return }
        let ok = 0, fail = 0
        for (let i = 0; i < serials.length; i++) {
          setToast(`${label} ${i + 1}/${serials.length}…`, 'warn', { busy: true })
          const r = await invoke<{ ok?: boolean }>(channel, { serial: serials[i] }).catch(() => ({ ok: false }))
          if (r?.ok) ok++; else fail++
        }
        setToast(`${label}: ${ok}/${serials.length} ok${fail ? `, ${fail} failed` : ''}`, fail ? 'warn' : 'ok')
        load(true)
      } else {
        const s = resolveSerial()
        if (!s) { setToast('no phone connected', 'err'); return }
        setToast(`${label}…`)
        const r = await invoke<{ ok?: boolean; error?: string }>(channel, { serial: s })
          .catch((e: Error) => ({ ok: false, error: e?.message }))
        if (r?.ok) { setToast(`${label} done ✓`, 'ok'); load(false) }
        else setToast((r?.error || `${label} failed`).slice(0, 80), 'err')
      }
    } finally {
      sweepRef.current = false
      setSweepBusy(false)
    }
  }, [universal, allGroups, resolveSerial, load])

  const onValidateFolders = useCallback(async () => {
    const s = resolveSerial()
    setToast('setting up content folders…')
    const r = await invoke<{ ok?: boolean; created?: number; error?: string }>('fleet:validate-folders', s ?? undefined)
      .catch((e: Error): { ok?: boolean; created?: number; error?: string } => ({ ok: false, error: e?.message }))
    if (r?.ok) setToast(`content folders ready${typeof r.created === 'number' ? ` (+${r.created})` : ''} ✓`, 'ok')
    else setToast((r?.error || 'folder setup failed').slice(0, 80), 'err')
  }, [resolveSerial])

  // Settings gear → real app settings (smspool API key), not the phones panel.
  const onSettings = useCallback(() => { invoke('open-settings').catch(() => {}) }, [])
  // Onboarding "Add a phone" surface (FirstRun button + command palette) → the
  // fleet panel, which uniquely owns the USB Add-Phone provisioning wizard.
  const onOpenPhones = useCallback(() => { invoke('open-fleet-panel').catch(() => {}) }, [])

  // Ctrl/Cmd+K global shortcut
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Jump-to-model: expand + clear filter + scroll + flash
  const onJumpToModel = useCallback((model: string) => {
    setCollapsed(c => ({ ...c, [model]: false }))
    setQuery('')
    setChips({ scheduled: false, low: false, switchfailed: false })
    // Defer so React has painted the group before we scroll
    setTimeout(() => {
      const escaped = CSS.escape ? CSS.escape(model) : model.replace(/"/g, '\\"')
      const grp = document.querySelector(`.model-group[data-model="${escaped}"]`) as HTMLElement | null
      if (!grp) { setToast(`model "${model}" not found`, 'err'); return }
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      grp.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
      grp.classList.remove('cmdk-flash')
      void grp.offsetWidth
      grp.classList.add('cmdk-flash')
      setToast(`jumped to ${model}`, 'ok')
    }, 60)
  }, [])

  // Filtered groups
  const filteredGroups = applyFindability(allGroups, query, chips, sort)
  const totalAccountCount = allGroups.reduce((n, g) => n + g.accountCount, 0)
  const shownAccountCount = filteredGroups.reduce((n, g) => n + g.accountCount, 0)

  function toggleChip(chip: string) {
    setChips(c => ({ ...c, [chip]: !c[chip] }))
  }

  function toggleCollapse(model: string) {
    setCollapsed(c => ({ ...c, [model]: !c[model] }))
  }

  function expandAll() {
    const next: Record<string, boolean> = {}
    allGroups.forEach(g => { next[g.model] = false })
    setCollapsed(next)
  }

  function collapseAll() {
    const next: Record<string, boolean> = {}
    allGroups.forEach(g => { next[g.model] = true })
    setCollapsed(next)
  }

  const freshText = freshLabel(loadedAt, isRefreshing)

  // Stable context value so AccountRow/modals can call load(true) without prop-drilling
  const dashCtx = useMemo(() => ({
    refresh: () => load(true),
    openCreateIg: (ctx: ProfileCtx) => setCreateIgCtx(ctx),
    openDelete: (ctx: ProfileCtx) => setDeleteCtx(ctx),
    openAddProfile: () => setAddProfileOpen(true),
    openBulkCreate: () => setBulkCreateOpen(true),
    firstSerial: () => {
      if (serial) return serial
      // derive from first profile in allGroups
      const p = allGroups[0]?.profiles[0]
      return p?.serial ?? null
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [load, serial, allGroups])

  return (
    <DashContext.Provider value={dashCtx}>
      <div className={`app${analyticsOpen ? ' analytics' : ''}`}>
        {/* Topbar */}
        <Topbar
          onSchedule={() => setScheduleOpen(true)}
          onAnalytics={() => setAnalyticsOpen(true)}
          onRefresh={() => load(true)}
          onAddProfile={() => setAddProfileOpen(true)}
          onBulkCreate={() => setBulkCreateOpen(true)}
          onSettings={onSettings}
          onFetchStats={() => runSweep('insights:fetch', 'Fetching stats')}
          onDetectAccounts={() => runSweep('fleet:scan', 'Detecting accounts')}
          onValidateFolders={onValidateFolders}
          onOpenPalette={() => setPaletteOpen(true)}
          sweepBusy={sweepBusy}
        />

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          allGroups={allGroups}
          onRefresh={() => load(true)}
          onDetectAccounts={() => runSweep('fleet:scan', 'Detecting accounts')}
          onAddProfile={() => setAddProfileOpen(true)}
          onBulkCreate={() => setBulkCreateOpen(true)}
          onFetchStats={() => runSweep('insights:fetch', 'Fetching stats')}
          onValidateFolders={onValidateFolders}
          onOpenPhones={() => { onOpenPhones(); setPaletteOpen(false) }}
          onOpenSchedule={() => setScheduleOpen(true)}
          onOpenAnalytics={() => setAnalyticsOpen(true)}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          onJumpToModel={onJumpToModel}
        />

        {/* Schedule overlay — fixed position, full-screen, portal-like */}
        {scheduleOpen && (
          <ScheduleOverlay
            onClose={() => {
              setScheduleOpen(false)
              document.getElementById('scheduleBtn')?.focus()
            }}
          />
        )}

        {/* Analytics overlay — rendered when analyticsOpen; CSS hides pulse/findbar/list */}
        {analyticsOpen && (
          <Analytics
            spScope={null}
            onClose={() => setAnalyticsOpen(false)}
            seriesCache={analyticsSeries}
          />
        )}

        {/* Scan / Fetch-Stats progress bar */}
        {scanShow && (
          <div className="scanbar show">
            <span className="scanlabel">{scanLabel}</span>
            <div className="track"><div className="fill" style={{ width: `${scanPct}%` }} /></div>
            <span className="scanpct">{scanPct}%</span>
          </div>
        )}

        {/* Pulse hero — always fleet-wide totals */}
        <FleetPulse stats={pulseStats} insights={insightsAgg} />

        {/* Findbar */}
        <Findbar
          query={query}
          onQuery={setQuery}
          chips={chips}
          onChip={toggleChip}
          sort={sort}
          onSort={setSort}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          shownCount={shownAccountCount}
          totalCount={totalAccountCount}
          freshLabel={freshText}
          updating={isRefreshing}
        />

        {/* List */}
        <div className={`list${isStale ? ' stale' : ''}`} role="region" aria-busy={loadState === 'loading'}>
          {loadState === 'loading' && <Skeleton />}

          {loadState === 'error' && (
            <ErrorState message={errorMsg} onRetry={() => load(false)} />
          )}

          {loadState === 'loaded' && allGroups.length === 0 && (
            <FirstRun onOpenPhones={() => { invoke('sidebar:log-event', 'open-phones', {}); onOpenPhones() }} />
          )}

          {/* Universal Command Center — phone → profile → account (handles its own filter/empty) */}
          {loadState === 'loaded' && allGroups.length > 0 && universal && (
            <CommandCenter
              allGroups={allGroups}
              query={query}
              selected={selected}
              onSelectToggle={toggleSelect}
              onRefresh={() => load(true)}
              scheduleVersion={scheduleVersion}
            />
          )}

          {loadState === 'loaded' && !universal && allGroups.length > 0 && filteredGroups.length === 0 && (
            <NoMatch query={query} />
          )}

          {loadState === 'loaded' && !universal && filteredGroups.map(g => (
            <ModelGroup
              key={g.model}
              group={g}
              collapsed={!!collapsed[g.model]}
              onToggle={() => toggleCollapse(g.model)}
              query={query}
              selected={selected}
              onSelectToggle={toggleSelect}
            />
          ))}
        </div>

        {/* Bulk action bar — slides up from bottom when selection is non-empty */}
        <BulkBar
          selected={selected}
          keyToAcct={keyToAcct}
          sweepBusy={sweepBusy}
          onClear={clearSelect}
          onRefresh={() => load(true)}
        />

        {/* Phase 5 — Profile-level modals */}
        <CreateIgModal
          ctx={createIgCtx}
          onClose={() => setCreateIgCtx(null)}
          onDone={() => { setCreateIgCtx(null); load(false) }}
        />
        <DeleteModal
          ctx={deleteCtx}
          onClose={() => setDeleteCtx(null)}
          onDone={() => { setDeleteCtx(null); load(false) }}
        />
        <AddProfileModal
          serial={addProfileOpen ? (serial ?? (allGroups[0]?.profiles[0]?.serial ?? null)) : null}
          onClose={() => setAddProfileOpen(false)}
          onDone={() => { setAddProfileOpen(false); setTimeout(() => load(false), 900) }}
        />
        <BulkCreateModal
          serial={bulkCreateOpen ? (serial ?? (allGroups[0]?.profiles[0]?.serial ?? null)) : null}
          onClose={() => setBulkCreateOpen(false)}
          onDone={() => { setBulkCreateOpen(false); load(false) }}
        />
        <LiveCreationLog />
      </div>
    </DashContext.Provider>
  )
}
