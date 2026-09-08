import { useState, useCallback, useRef, useEffect } from 'react'
import { invoke } from './ipc'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SeriesPoint {
  ts?: number | string
  account?: string
  is_business?: boolean
  layout?: string
  followers?: number | null
  posts?: number | null
  views?: number | null
  net_followers?: number | null
  interactions?: number | null
  viewers?: number | null
  accounts_reached?: number | null
  profile_visits?: number | null
  reels_views?: number | null
  stories_views?: number | null
  growth_pct?: number | null
  growth_since?: string | null
}

type Metric = 'views' | 'followers' | 'interactions'
type LoadState = 'idle' | 'loading' | 'error' | 'ready'

interface SpScope {
  serial: string
  ids: string[]
  handles: Set<string>
}

interface Props {
  spScope?: SpScope | null
  /** Called when the user clicks ← Back */
  onClose: () => void
  /** Series cache: null forces fresh fetch. Pass a ref so parent can null it on registry refresh. */
  seriesCache: { current: Record<string, SeriesPoint[]> | null }
}

// analytics-charts.js is CJS; import at call-time to avoid Vite ESM bundling it.
// window.require is Node's require under Electron nodeIntegration:true.
// The path is resolved relative to the bundle file in renderer/models-dashboard-app/assets/,
// which is 3 dirs up from electron/lib/. Use __dirname-anchored path for safety.
declare const require: (mod: string) => {
  fmtK: (v: unknown) => string
  bucketSweeps: (
    seriesByAccount: Record<string, SeriesPoint[]>,
    metric: string,
    gapMs?: number,
  ) => Array<{ t: number; total: number; accounts: number }>
  lineAreaChart: (
    points: Array<{ x: number; y: number }>,
    opts?: { w?: number; h?: number; pad?: number; ariaLabel?: string; variant?: string },
  ) => string
  deltaBadge: (
    curr: number,
    prev: number | null | undefined,
  ) => { text: string; dir: 'up' | 'down' | 'flat' }
}
// Path from renderer/models-dashboard-app/assets/ to electron/lib/
const ANALYTICS_CHARTS_PATH = '../../../lib/analytics-charts'

const AN_METRIC_LABEL: Record<Metric, string> = {
  views: 'Views',
  followers: 'Followers',
  interactions: 'Interactions',
}

// ── Analytics component ───────────────────────────────────────────────────────

export default function Analytics({ spScope, onClose, seriesCache }: Props) {
  const [metric, setMetric] = useState<Metric>('views')
  const [focus, setFocus] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  // Tracks whether this open cycle has already loaded series (to avoid double-fetch)
  const fetchedRef = useRef(false)

  // Initialize from cache if available; ready state matches
  const [series, setSeries] = useState<Record<string, SeriesPoint[]> | null>(() => seriesCache.current)
  const [loadState, setLoadState] = useState<LoadState>(() => seriesCache.current !== null ? 'ready' : 'idle')

  const load = useCallback(async () => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    setLoadState('loading')
    try {
      const r = await invoke<{ ok: boolean; series: Record<string, SeriesPoint[]>; error?: string }>('insights:get-all-series')
      if (r && r.ok) {
        seriesCache.current = r.series
        setSeries(r.series)
        setLoadState('ready')
      } else {
        setLoadError(r?.error ?? 'Unknown error')
        setLoadState('error')
      }
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setLoadState('error')
    }
  }, [seriesCache])

  // Kick off load on mount if series not cached yet
  useEffect(() => {
    if (series === null && loadState === 'idle') {
      load()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function retry() {
    fetchedRef.current = false
    seriesCache.current = null
    setSeries(null)
    setLoadState('idle')
    setLoadError('')
    load()
  }

  // Build biz-filtered series (mirrors renderAnalytics in HTML)
  function buildBiz(s: Record<string, SeriesPoint[]>, m: Metric) {
    const biz: Record<string, SeriesPoint[]> = {}
    for (const acct in s) {
      if (spScope && !spScope.handles.has(String(acct).toLowerCase())) continue
      const pts = s[acct]
      if (pts.some(x => x.is_business && x[m] != null)) {
        biz[acct] = pts
      }
    }
    return biz
  }

  function handleMetricChange(m: Metric) {
    setMetric(m)
    setFocus(null)
  }

  function handleTileClick(acct: string) {
    setFocus(acct)
  }

  function handleClearFocus() {
    setFocus(null)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const ready = loadState === 'ready' && series !== null

  // Build biz set early so seed + noBiz can both use it
  const biz = ready && series ? buildBiz(series, metric) : {}

  // Compute maxLen from biz (not raw series) so seed banner tracks real data
  let maxLen = 0
  {
    const vals = Object.values(biz)
    for (const pts of vals) {
      if (pts.length > maxLen) maxLen = pts.length
    }
  }

  const showSeed = ready && Object.keys(biz).length > 0 && maxLen < 2
  const noBiz = ready && series !== null && Object.keys(biz).length === 0

  // Build hero + grid data only when ready
  let heroContent: React.ReactNode = null
  let gridContent: React.ReactNode = null

  if (ready && series && !noBiz) {
    try {
      const AC = require(ANALYTICS_CHARTS_PATH)
      const validFocus = focus && series[focus] ? focus : null

      // Hero data
      let points: Array<{ x: number; y: number }>
      let headVal: number
      let deltaPrev: number | null
      let heroLabel: string

      if (validFocus && series[validFocus]) {
        const s = series[validFocus]
        points = s
          .filter(x => x[metric] != null)
          .map(x => ({ x: Number(x.ts), y: Number(x[metric as keyof SeriesPoint]) }))
        headVal = points.length ? points[points.length - 1].y : 0
        deltaPrev = points.length > 1 ? points[points.length - 2].y : null
        heroLabel = '@' + validFocus + ' · ' + AN_METRIC_LABEL[metric]
      } else {
        const buckets = AC.bucketSweeps(biz, metric)
        points = buckets.map((b: { t: number; total: number }) => ({ x: b.t, y: b.total }))
        headVal = buckets.length ? buckets[buckets.length - 1].total : 0
        deltaPrev = buckets.length > 1 ? buckets[buckets.length - 2].total : null
        heroLabel = 'Fleet ' + AN_METRIC_LABEL[metric] + ' · ' + Object.keys(biz).length + ' accounts'
      }

      const d = AC.deltaBadge(headVal, deltaPrev)
      const chartSvg = AC.lineAreaChart(points, { variant: 'hero', ariaLabel: heroLabel })

      heroContent = (
        <>
          <div className="an-hero-head">
            <span className="an-hero-val">{AC.fmtK(headVal)}</span>
            <span className={'an-delta ' + d.dir}>{d.text}</span>
            <span className="an-hero-sub">
              {heroLabel}
              {validFocus && (
                <>
                  {' — '}
                  <button
                    type="button"
                    id="anClearFocus"
                    style={{
                      background: 'none', border: 'none', color: 'var(--md-yellow-hi)',
                      cursor: 'pointer', font: 'inherit', padding: 0, textDecoration: 'underline',
                    }}
                    onClick={handleClearFocus}
                  >
                    &#8592; fleet
                  </button>
                </>
              )}
            </span>
          </div>
          <div dangerouslySetInnerHTML={{ __html: chartSvg }} />
        </>
      )

      // Grid
      interface TileRow { acct: string; pts: Array<{ x: number; y: number }>; latest: number; growth: number | null }
      const rows: TileRow[] = []
      for (const acct in biz) {
        const s = biz[acct]
        if (!s || !s.length) continue
        const pts = s.filter(x => x[metric] != null).map(x => ({ x: Number(x.ts), y: Number(x[metric as keyof SeriesPoint]) }))
        const latestFull = s[s.length - 1] || null
        rows.push({
          acct,
          pts,
          latest: pts.length ? pts[pts.length - 1].y : 0,
          growth: latestFull?.growth_pct ?? null,
        })
      }
      rows.sort((a, b) => b.latest - a.latest)

      gridContent = rows.map(r => (
        <div
          key={r.acct}
          className="an-tile"
          data-acct={r.acct}
          tabIndex={0}
          role="button"
          onClick={() => handleTileClick(r.acct)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleTileClick(r.acct) }}
        >
          <div className="an-tile-head">
            <span className="an-tile-h">@{r.acct}</span>
            <span className="an-tile-v">{AC.fmtK(r.latest)}</span>
          </div>
          <div dangerouslySetInnerHTML={{ __html: AC.lineAreaChart(r.pts, { variant: 'mini', ariaLabel: r.acct }) }} />
          <div className="an-tile-g">
            {r.growth != null
              ? 'IG growth ' + (r.growth >= 0 ? '+' : '') + String(r.growth) + '%'
              : ' '}
          </div>
        </div>
      ))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      heroContent = (
        <div className="an-loading an-loading--error">
          Analytics failed to render — {msg}{' '}
          <button className="mdbtn sm" onClick={retry}>Retry</button>
        </div>
      )
      gridContent = null
    }
  }

  return (
    <div className="analytics-view" id="analyticsView" aria-hidden="false">
      {/* Header */}
      <div className="an-head">
        <button className="mdbtn sm" id="anBack" title="Back to the fleet" onClick={onClose}>
          &#8592; Back
        </button>
        <span className="an-title">Fleet Analytics</span>
        <span className="an-spacer" />
        <div className="an-metrics" role="group" aria-label="Metric">
          {(['views', 'followers', 'interactions'] as Metric[]).map(m => (
            <button
              key={m}
              className={'an-mbtn' + (metric === m ? ' on' : '')}
              data-metric={m}
              onClick={() => handleMetricChange(m)}
            >
              {AN_METRIC_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Seed banner */}
      {showSeed && (
        <div className="an-seed" id="anSeed">
          Growth lines fill in each time you run Fetch Stats. Showing the latest snapshot + IG-reported growth for now.
        </div>
      )}

      {/* Hero */}
      <div className="an-hero" id="anHero">
        {loadState === 'loading' && (
          <div className="an-loading">Loading analytics…</div>
        )}
        {loadState === 'error' && (
          <div className="an-loading an-loading--error">
            Could not load analytics.{' '}
            <button className="mdbtn sm" onClick={retry}>Retry</button>
          </div>
        )}
        {noBiz && (
          <div className="an-seed">
            No business accounts yet — switch an account to a Professional/Business profile to unlock growth analytics.
          </div>
        )}
        {ready && !noBiz && heroContent}
      </div>

      {/* Per-account tiles */}
      <div className="an-grid" id="anGrid">
        {ready && !noBiz && gridContent}
      </div>
    </div>
  )
}
