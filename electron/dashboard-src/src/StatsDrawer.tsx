import { useEffect, useRef } from 'react'
import { invoke } from './ipc'
import { fmtK, relTime } from './utils'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SeriesPoint {
  ts?: number | string
  followers?: number
  views?: number
  net_followers?: number
  interactions?: number
  is_business?: boolean
  growth_pct?: number
}

interface LatestFull {
  is_business?: boolean
  layout?: string
  legacy?: {
    views?: number
    accounts_reached?: number
    profile_visits?: number
    external_link_taps?: number
    top_cities?: Record<string, number>
  } | boolean
  audience?: {
    followers?: number
    gender?: Record<string, number>
    age?: Record<string, number>
    countries?: Record<string, number>
  }
  overview?: {
    metrics?: {
      Views?: number
      'Net followers'?: number
      Interactions?: number
    }
  }
}

interface LatestInsights {
  ts?: number | string
  is_business?: boolean
  layout?: string
  legacy?: boolean
  full?: LatestFull
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  )
}

function sparklineSvg(series: SeriesPoint[], key: 'followers'): string {
  const pts = (series || [])
    .map((s) => ({ ts: s.ts, v: Number((s as Record<string, unknown>)[key]) }))
    .filter((p) => Number.isFinite(p.v))
  if (pts.length < 2) {
    return `<svg viewBox="0 0 300 56" preserveAspectRatio="none" aria-hidden="true"><text class="spark-flat" x="4" y="32">not enough history yet — fetch stats again later</text></svg>`
  }
  const W = 300, H = 56, pad = 4
  const vs = pts.map((p) => p.v)
  let lo = Math.min(...vs), hi = Math.max(...vs)
  if (hi === lo) { hi = lo + 1; lo = lo - 1 }
  const n = pts.length
  const x = (i: number) => pad + (i / (n - 1)) * (W - pad * 2)
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2)
  let d = ''
  pts.forEach((p, i) => { d += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1) + ' ' })
  const area = 'M' + x(0).toFixed(1) + ' ' + (H - pad) + ' ' + d.replace(/^M/, 'L') + 'L' + x(n - 1).toFixed(1) + ' ' + (H - pad) + ' Z'
  const lastX = x(n - 1).toFixed(1)
  const lastY = y(pts[n - 1].v).toFixed(1)
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escHtml(key)} trend"><path class="spark-fill" d="${area}"/><path class="spark-line" d="${d.trim()}" vector-effect="non-scaling-stroke"/><circle class="spark-dot" cx="${lastX}" cy="${lastY}" r="2.5"/></svg>`
}

function miniBarsHtml(obj: Record<string, number> | null | undefined, opts: { pct?: boolean; limit?: number; unit?: string } = {}): string {
  const entries = Object.entries(obj || {})
    .map(([name, v]) => [name, Number(v)] as [string, number])
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
  const rows = opts.limit ? entries.slice(0, opts.limit) : entries
  if (!rows.length) return '<div class="aud-empty">—</div>'
  const max = opts.pct ? 100 : Math.max(1, ...rows.map((r) => r[1]))
  const unit = opts.pct ? '%' : (opts.unit || '')
  let html = '<div class="mini-bars">'
  for (const [name, v] of rows) {
    const w = Math.max(2, Math.min(100, Math.round((v / max) * 100)))
    html += `<div class="mini-bar"><span class="mb-name" title="${escHtml(name)}">${escHtml(name)}</span><span class="mb-track"><span class="mb-fill" style="width:${w}%"></span></span><span class="mb-pct">${escHtml(fmtK(v) + unit)}</span></div>`
  }
  return html + '</div>'
}

function renderStatsHtml(handle: string, latest: LatestInsights | null, series: SeriesPoint[] | null): string {
  const full = latest && latest.full ? latest.full : null
  const compact = series && series.length ? series[series.length - 1] : null

  if (!full && !compact) {
    return `<div class="stats-empty">no insights yet — click 📊 Fetch Stats to scrape @${escHtml(handle)}</div>`
  }

  const isBusiness = full
    ? full.is_business !== false
    : compact ? compact.is_business !== false : true
  const when = latest && latest.ts
    ? relTime(latest.ts)
    : compact && compact.ts ? relTime(compact.ts) : 'unknown'

  // ── Legacy layout ──────────────────────────────────────────────────────
  if (full && (full.layout === 'legacy' || full.legacy)) {
    const lg = typeof full.legacy === 'object' && full.legacy ? full.legacy : {}
    const lViews = lg.views ?? (compact && compact.views) ?? null
    const lReached = lg.accounts_reached ?? (compact && (compact as unknown as { accounts_reached?: number }).accounts_reached) ?? null
    const lVisits = lg.profile_visits ?? (compact && (compact as unknown as { profile_visits?: number }).profile_visits) ?? null
    const lTaps = lg.external_link_taps ?? null
    const numCell = (label: string, v: number | null): string => {
      const has = v != null && Number.isFinite(Number(v))
      return `<div class="stats-num"><div class="sl">${escHtml(label)}</div><div class="sn">${escHtml(has ? fmtK(Number(v)) : '—')}</div></div>`
    }
    let html = `<div class="stats-head"><span class="stats-h">@${escHtml(handle)}</span><span class="badge-legacy" title="legacy Views insights — IG shows this account a simpler insights screen">LEGACY INSIGHTS</span><span class="stats-when">scraped ${escHtml(when)}</span></div>`
    html += `<div class="stats-nums">${numCell('Views', lViews)}${numCell('Accounts reached', lReached)}${numCell('Profile visits', lVisits)}${numCell('Ext. link taps', lTaps)}</div>`
    html += `<div class="stats-aud" style="grid-template-columns:1fr"><div class="aud-col"><div class="ac-label">Top cities</div>${miniBarsHtml(lg.top_cities, { pct: true, limit: 6 })}</div></div>`
    return html
  }

  const badge = isBusiness
    ? `<span class="badge-business" title="professional/business account">PROFESSIONAL</span>`
    : `<span class="badge-personal" title="personal account — no professional dashboard, rich metrics skipped">PERSONAL ACCOUNT</span>`

  let html = `<div class="stats-head"><span class="stats-h">@${escHtml(handle)}</span>${badge}<span class="stats-when">scraped ${escHtml(when)}</span></div>`

  // ── Personal account ───────────────────────────────────────────────────
  if (!isBusiness) {
    html += `<div class="stats-empty">personal account — IG only exposes audience &amp; reach insights for professional accounts. Switch this account to a Professional/Business account in IG to collect metrics.</div>`
    return html
  }

  // ── Business layout ────────────────────────────────────────────────────
  html += `<div class="stats-spark"><div class="spark-label">Followers over time</div>${sparklineSvg(series || [], 'followers')}</div>`

  const followers = compact && compact.followers != null ? compact.followers : (full && full.audience ? full.audience.followers : null)
  const views = compact && compact.views != null ? compact.views : (full && full.overview && full.overview.metrics ? full.overview.metrics.Views : null)
  const net = compact && compact.net_followers != null ? compact.net_followers : (full && full.overview && full.overview.metrics ? full.overview.metrics['Net followers'] : null)
  const inter = compact && compact.interactions != null ? compact.interactions : (full && full.overview && full.overview.metrics ? full.overview.metrics.Interactions : null)

  const numCell = (label: string, v: number | null | undefined, signed = false): string => {
    const has = v != null && Number.isFinite(Number(v))
    const nn = Number(v)
    const cls = signed && has ? (nn > 0 ? ' pos' : nn < 0 ? ' neg' : '') : ''
    const disp = has ? ((signed && nn > 0 ? '+' : '') + fmtK(nn)) : '—'
    return `<div class="stats-num"><div class="sl">${escHtml(label)}</div><div class="sn${cls}">${escHtml(disp)}</div></div>`
  }

  html += `<div class="stats-nums">${numCell('Followers', followers)}${numCell('Views', views)}${numCell('Net followers', net, true)}${numCell('Interactions', inter)}</div>`

  const aud = full && full.audience ? full.audience : {}
  html += `<div class="stats-aud"><div class="aud-col"><div class="ac-label">Gender</div>${miniBarsHtml(aud.gender, { pct: true })}</div><div class="aud-col"><div class="ac-label">Age</div>${miniBarsHtml(aud.age, { pct: true })}</div><div class="aud-col"><div class="ac-label">Top countries</div>${miniBarsHtml(aud.countries, { pct: true, limit: 5 })}</div></div>`

  return html
}

// ── Module-level cache mirrors _statsDrawerCache in the HTML ──────────────────
// Key: account handle (the data-stats-for value used by React AccountRow)
const statsDrawerCache = new Map<string, string>()

export function clearStatsCache(): void {
  statsDrawerCache.clear()
}

export function evictStatsCache(key: string): void {
  statsDrawerCache.delete(key)
}

export function getStatsCacheHtml(key: string): string | undefined {
  return statsDrawerCache.get(key)
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  handle: string
  cacheKey: string   // data-stats-for value (same as handle for now)
  open: boolean
}

export default function StatsDrawer({ handle, cacheKey, open }: Props) {
  const drawerRef = useRef<HTMLDivElement>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      // On close: evict cache + reset loaded flag (re-fetches next open)
      evictStatsCache(cacheKey)
      loadedRef.current = false
      return
    }

    const el = drawerRef.current
    if (!el) return

    // Guard: prevent concurrent double-fetch (mirrors rowEl.dataset.loaded)
    if (loadedRef.current) return
    loadedRef.current = true

    // Restore from cache inline if available
    const cached = statsDrawerCache.get(cacheKey)
    if (cached) {
      el.innerHTML = cached
      return
    }

    // Show loading state
    el.innerHTML = `<div class="stats-loading">loading @${handle} insights…</div>`

    Promise.all([
      invoke<{ ok?: boolean; latest?: LatestInsights | null }>('insights:get-latest', { account: handle })
        .then((r) => (r && r.ok ? r.latest ?? null : null))
        .catch(() => null),
      invoke<{ ok?: boolean; series?: SeriesPoint[] | null }>('insights:get', { account: handle })
        .then((r) => (r && r.ok ? r.series ?? null : null))
        .catch(() => null),
    ]).then(([latest, series]) => {
      if (!drawerRef.current) return
      const html = renderStatsHtml(handle, latest as LatestInsights | null, series as SeriesPoint[] | null)
      drawerRef.current.innerHTML = html
      statsDrawerCache.set(cacheKey, html)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, handle, cacheKey])

  return <div className="stats-drawer" ref={drawerRef} />
}
