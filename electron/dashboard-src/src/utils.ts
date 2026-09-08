// Runtime helpers — import groupByModel/modelOf/buildAccountKey from the
// existing CommonJS module rather than duplicating. Vite bundles it fine.
declare const require: (mod: string) => any

const renderLib = require('../../lib/models-dashboard-render.js')

export const groupByModel: (registry: unknown) => import('./types').ModelGroup[] = renderLib.groupByModel
export const buildAccountKey: (serial: string, userId: string, handle: string) => string = renderLib.buildAccountKey

// Attach computed .key to every account in groups (called after groupByModel + attachMeta)
export function attachAccountKeys(groups: import('./types').ModelGroup[]): import('./types').ModelGroup[] {
  return groups.map(g => ({
    ...g,
    profiles: g.profiles.map(p => ({
      ...p,
      accounts: p.accounts.map(a => ({
        ...a,
        key: buildAccountKey(a.serial, a.userId, a.handle),
      })),
    })),
  }))
}

/** fmtK — <1000 as-is, 1k+ -> "1.2k", 1m+ -> "1.2m" */
export function fmtK(v: number | null | undefined): string {
  const n = Number(v ?? 0)
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

/** Hue for avatar gradient — hash charCodes mod 360 */
export function avaHue(handle: string): number {
  let h = 0
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) & 0xffffff
  return h % 360
}

/** Relative time — "just now" / "Xm ago" / "Xh ago" / "Xd ago" */
export function relTime(ts: string | number | null | undefined): string {
  if (!ts) return 'never scanned'
  const d = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!d || isNaN(d)) return 'never scanned'
  const diff = Date.now() - d
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

/** Aggregate fleet-wide insights from the per-account series map
 *  (insights:get-all-series → { handleLower: SeriesPoint[] }).
 *  Sums the latest follower/view totals across accounts, computes net follower
 *  movement vs ~24h ago (followers is monotonic and meaningful to sum; views is
 *  a rolling IG metric so we surface only its total, no delta), and tracks
 *  freshness + how many accounts have any insights yet. nowMs is passed for
 *  testability/determinism. */
export function aggregateInsights(
  allSeries: Record<string, import('./types').InsightsSeriesPoint[]>,
  totalAccounts: number,
  nowMs: number,
): import('./types').InsightsAgg {
  const toMs = (ts: number | string | undefined): number | null => {
    if (ts == null) return null
    const n = typeof ts === 'number' ? ts : Date.parse(ts)
    return Number.isFinite(n) ? n : null
  }
  const num = (v: number | null | undefined): number | null =>
    (v != null && Number.isFinite(v)) ? v : null

  let followers = 0, views = 0, fDeltaSum = 0
  let hasFDelta = false, newestTs: number | null = null, fetchedCount = 0
  const cutoff = nowMs - 86_400_000 // 24h

  for (const key of Object.keys(allSeries)) {
    const series = allSeries[key]
    if (!series || !series.length) continue
    fetchedCount++
    const last = series[series.length - 1]
    const lastTs = toMs(last.ts)
    if (lastTs != null && (newestTs == null || lastTs > newestTs)) newestTs = lastTs
    const lf = num(last.followers), lv = num(last.views)
    if (lf != null) followers += lf
    if (lv != null) views += lv
    // Baseline for the day-over-day follower delta: the most recent snapshot at
    // or before the 24h cutoff; if the account has only <24h of history, fall
    // back to its first point so intra-day movement still shows.
    if (lf != null) {
      let baseline: import('./types').InsightsSeriesPoint | null = null
      for (const p of series) { const t = toMs(p.ts); if (t != null && t <= cutoff) baseline = p }
      if (!baseline && series.length > 1) baseline = series[0]
      const bf = baseline ? num(baseline.followers) : null
      if (bf != null) { fDeltaSum += lf - bf; hasFDelta = true }
    }
  }

  return {
    followers, views,
    followersDelta: hasFDelta ? fDeltaSum : null,
    newestTs, fetchedCount, totalCount: totalAccounts,
  }
}

const FULL_TANK = 30

/** Fuel gauge pct — clamp 4..100, 0 when empty */
export function fuelPct(total: number): number {
  if (total === 0) return 0
  return Math.max(4, Math.min(100, Math.round((total / FULL_TANK) * 100)))
}

/** Highlight query matches in text — returns HTML with matched runs wrapped.
 *  Matches on the RAW text and escapes per-segment, so HTML entities in the
 *  source (e.g. & in a renamed profile name) are never split by the regex. */
export function highlight(text: string, q: string): string {
  if (!q) return escHtml(text)
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(safe, 'gi')
  let out = '', last = 0, m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out += escHtml(text.slice(last, m.index))
    out += `<mark class="find-hit">${escHtml(m[0])}</mark>`
    last = m.index + m[0].length
    if (m.index === re.lastIndex) re.lastIndex++ // guard against zero-length match
  }
  return out + escHtml(text.slice(last))
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string))
}

/** Parse --sp-serial= arg from process.argv */
export function getSerial(): string | null {
  if (typeof process === 'undefined') return null
  const arg = (process.argv as string[]).find(a => a.startsWith('--sp-serial='))
  if (!arg) return null
  const val = arg.replace('--sp-serial=', '')
  return val || null
}

/** True when launched as the universal Command Center (--sp-universal=1, no serial) */
export function getUniversal(): boolean {
  if (typeof process === 'undefined') return false
  return (process.argv as string[]).some(a => a === '--sp-universal=1' || a === '--sp-universal')
}

export function getCreateIgContext(): import('./DashContext').ProfileCtx | null {
  if (typeof process === 'undefined') return null
  const arg = process.argv.find(value => value.startsWith('--sp-create-ig='))
  if (!arg) return null
  try {
    const value = JSON.parse(decodeURIComponent(arg.slice('--sp-create-ig='.length)))
    if (typeof value.serial !== 'string' || !value.serial.trim() || !/^\d+$/.test(String(value.userId ?? ''))) return null
    return { serial: value.serial, userId: String(value.userId), name: `Profile ${value.userId}`, accountCount: 0 }
  } catch { return null }
}
