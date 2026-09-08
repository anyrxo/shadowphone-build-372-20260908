// desktop/lib/insights-store.js
// Time-series store for per-account IG insights (powers the dashboard "stats over
// time" charts). Each fetch appends a COMPACT scalar snapshot to <account>.jsonl
// (cheap to read for charts) and overwrites <account>.latest.json with the FULL
// blob (rich audience demographics, viewed on demand). Phone-free, pure fs.
'use strict'
const fs = require('fs')
const path = require('path')

function _dir(userDataPath) { return path.join(userDataPath, 'insights') }
function _safe(account) { return String(account || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_') }

// Pull the chartable scalars out of a full account_insights result.
function compactSnapshot(account, full, ts) {
    const ov = (full && full.overview) || {}
    const m = ov.metrics || {}
    const vbt = ov.views_by_type || {}
    const aud = (full && full.audience) || {}
    const isLegacy = !!(full && (full.layout === 'legacy' || full.legacy))
    const lg = (full && full.legacy) || {}
    return {
        ts,
        account: String(account || '').toLowerCase(),
        is_business: full ? !!full.is_business : false,
        layout: isLegacy ? 'legacy' : 'tabbed',
        followers: isLegacy ? ((full && full.profileFollowers) ?? null) : (aud.followers ?? null),
        posts: (full && full.content && full.content.post_count) ?? null,
        views: isLegacy ? (lg.views ?? null) : (m.Views ?? null),
        net_followers: isLegacy ? null : (m['Net followers'] ?? null),
        interactions: isLegacy ? null : (m.Interactions ?? null),
        viewers: isLegacy ? null : (m.Viewers ?? null),
        accounts_reached: isLegacy ? (lg.accounts_reached ?? null) : null,
        profile_visits: isLegacy ? (lg.profile_visits ?? null) : null,
        reels_views: isLegacy ? null : (vbt.Reels ?? null),
        stories_views: isLegacy ? null : (vbt.Stories ?? null),
        growth_pct: aud.growth_pct ?? null,
        growth_since: aud.growth_since ?? null,
    }
}

// Append one snapshot (compact -> jsonl, full -> latest.json). ts injected by the
// caller (Date.now()) so this stays pure/testable. Returns the compact snapshot.
function appendSnapshot(userDataPath, account, full, ts) {
    const dir = _dir(userDataPath)
    fs.mkdirSync(dir, { recursive: true })
    const compact = compactSnapshot(account, full, ts)
    fs.appendFileSync(path.join(dir, _safe(account) + '.jsonl'), JSON.stringify(compact) + '\n', 'utf8')
    fs.writeFileSync(path.join(dir, _safe(account) + '.latest.json'),
        JSON.stringify({ ts, account: compact.account, full }, null, 2), 'utf8')
    return compact
}

// Read the compact time-series for one account (oldest→newest). Optional sinceTs filter.
// Async: this is on the 25s dashboard-tick hot path; sync readFile blocked the main thread.
async function readSeries(userDataPath, account, sinceTs = 0) {
    const p = path.join(_dir(userDataPath), _safe(account) + '.jsonl')
    let raw
    try { raw = await fs.promises.readFile(p, 'utf8') } catch (_) { return [] }
    const out = []
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try { const o = JSON.parse(line); if (o.ts >= sinceTs) out.push(o) } catch (_) {}
    }
    return out
}

// Read the latest FULL blob (rich demographics) for one account, or null.
async function readLatest(userDataPath, account) {
    const p = path.join(_dir(userDataPath), _safe(account) + '.latest.json')
    try { return JSON.parse(await fs.promises.readFile(p, 'utf8')) } catch (_) { return null }
}

// Latest compact snapshot for every account that has a series (for dashboard badges).
// Async + parallel: was readdirSync + N synchronous readFileSync blocking the 25s tick.
async function readAllLatest(userDataPath) {
    const dir = _dir(userDataPath)
    let files
    try { files = await fs.promises.readdir(dir) } catch (_) { return {} }
    const out = {}
    await Promise.all(files.filter(f => f.endsWith('.jsonl')).map(async f => {
        const series = await readSeries(userDataPath, f.slice(0, -6))
        if (series.length) out[series[series.length - 1].account] = series[series.length - 1]
    }))
    return out
}

// Full time-series (oldest→newest) for every account that has a series. Sibling of
// readAllLatest but returns the whole history, for the analytics growth charts.
async function readAllSeries(userDataPath) {
    const dir = _dir(userDataPath)
    let files
    try { files = await fs.promises.readdir(dir) } catch (_) { return {} }
    const out = {}
    await Promise.all(files.filter(f => f.endsWith('.jsonl')).map(async f => {
        const series = await readSeries(userDataPath, f.slice(0, -6))
        if (series.length) out[series[series.length - 1].account] = series
    }))
    return out
}

module.exports = { compactSnapshot, appendSnapshot, readSeries, readLatest, readAllLatest, readAllSeries, _safe }
