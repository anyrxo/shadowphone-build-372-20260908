// desktop/lib/analytics-charts.js
// Pure (DOM-free) SVG chart builders + aggregation for the Analytics view.
// No requires, no DOM — unit-testable under plain `node`. Returns SVG strings
// consumed via innerHTML (CSP-safe: no eval, no external resources).
'use strict'

// Compact number format, matches the dashboard's fmtK (kept local to stay pure).
function fmtK(v) {
    const n = Number(v) || 0
    if (Math.abs(n) < 1000) return String(n)
    if (Math.abs(n) < 1e6) { const s = (n / 1000).toFixed(1); return (s.endsWith('.0') ? s.slice(0, -2) : s) + 'k' }
    const s = (n / 1e6).toFixed(1); return (s.endsWith('.0') ? s.slice(0, -2) : s) + 'm'
}

// Cluster every account's snapshots into "sweeps" (a new bucket when the time gap
// to the previous snapshot exceeds gapMs), summing `metric` across the accounts
// that report it in each sweep. One account contributes at most one snapshot per
// sweep, so this is the fleet line: one point per sweep.
// Returns [{ t (median ts), total, accounts }] ordered by time.
function bucketSweeps(seriesByAccount, metric, gapMs = 3600000) {
    const flat = []
    for (const acct in seriesByAccount) {
        for (const s of (seriesByAccount[acct] || [])) {
            flat.push({ ts: s.ts, acct, v: s[metric] })
        }
    }
    if (!flat.length) return []
    flat.sort((a, b) => a.ts - b.ts)
    const buckets = []
    let cur = null
    for (const p of flat) {
        if (!cur || p.ts - cur.lastTs > gapMs) {
            cur = { tsList: [], byAcct: new Map(), lastTs: p.ts }
            buckets.push(cur)
        }
        cur.tsList.push(p.ts)
        cur.lastTs = p.ts
        cur.byAcct.set(p.acct, p.v)   // last snapshot per account within the bucket wins
    }
    return buckets.map(b => {
        const sorted = b.tsList.slice().sort((a, c) => a - c)
        const mid = sorted[Math.floor(sorted.length / 2)]
        let total = 0, accounts = 0
        for (const v of b.byAcct.values()) {
            if (v != null && Number.isFinite(Number(v))) { total += Number(v); accounts++ }
        }
        return { t: mid, total, accounts }
    })
}

function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
}

// Line+area chart from points [{x,y}] (x = epoch ms, y = value). Returns an SVG
// string. Handles 0 points (placeholder) and 1 point (baseline dot) without ever
// emitting NaN. opts: { w, h, pad, ariaLabel, variant ('hero'|'mini') }.
function lineAreaChart(points, opts = {}) {
    const pts = (points || []).map(p => ({ x: Number(p.x), y: Number(p.y) }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    const variant = opts.variant || 'hero'
    const W = opts.w || (variant === 'mini' ? 260 : 720)
    const H = opts.h || (variant === 'mini' ? 70 : 260)
    const pad = opts.pad || (variant === 'mini' ? 6 : 28)
    const aria = _esc(opts.ariaLabel || 'trend')

    if (!pts.length) {
        return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart chart-empty" preserveAspectRatio="none" role="img" aria-label="' + aria + '">'
            + '<text class="chart-nodata" x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle">no data yet</text></svg>'
    }

    const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
    let xlo = Math.min(...xs), xhi = Math.max(...xs)
    let ylo = Math.min(...ys), yhi = Math.max(...ys)
    if (yhi === ylo) { yhi = ylo + Math.max(1, Math.abs(ylo) * 0.1); ylo = ylo - Math.max(1, Math.abs(ylo) * 0.1) }
    const xAt = (xhi === xlo)
        ? () => W / 2
        : x => pad + ((x - xlo) / (xhi - xlo)) * (W - pad * 2)
    const yAt = y => H - pad - ((y - ylo) / (yhi - ylo)) * (H - pad * 2)

    const last = pts[pts.length - 1]
    const lastX = xAt(last.x).toFixed(1), lastY = yAt(last.y).toFixed(1)

    // ONE distinct point → baseline dot + value label, no path.
    if (pts.length === 1 || xhi === xlo) {
        return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart chart-' + variant + '" preserveAspectRatio="none" role="img" aria-label="' + aria + '">'
            + '<line class="chart-baseline" x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '"/>'
            + '<circle class="chart-dot" cx="' + lastX + '" cy="' + lastY + '" r="3.5"/>'
            + '<text class="chart-val" x="' + lastX + '" y="' + Math.max(12, Number(lastY) - 8) + '" text-anchor="middle">' + _esc(fmtK(last.y)) + '</text></svg>'
    }

    let d = ''
    pts.forEach((p, i) => { d += (i === 0 ? 'M' : 'L') + xAt(p.x).toFixed(1) + ' ' + yAt(p.y).toFixed(1) + ' ' })
    const area = 'M' + xAt(pts[0].x).toFixed(1) + ' ' + (H - pad) + ' ' + d.replace(/^M/, 'L') + 'L' + lastX + ' ' + (H - pad) + ' Z'
    // y gridlines (3) for the hero variant only.
    let grid = ''
    if (variant === 'hero') {
        for (let g = 0; g <= 2; g++) {
            const gy = (pad + (g / 2) * (H - pad * 2)).toFixed(1)
            const gv = yhi - (g / 2) * (yhi - ylo)
            grid += '<line class="chart-grid" x1="' + pad + '" y1="' + gy + '" x2="' + (W - pad) + '" y2="' + gy + '"/>'
                + '<text class="chart-axis" x="2" y="' + (Number(gy) + 3).toFixed(1) + '">' + _esc(fmtK(gv)) + '</text>'
        }
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart chart-' + variant + '" preserveAspectRatio="none" role="img" aria-label="' + aria + '">'
        + grid
        + '<path class="chart-fill" d="' + area + '"/>'
        + '<path class="chart-line" d="' + d.trim() + '" vector-effect="non-scaling-stroke"/>'
        + '<circle class="chart-dot" cx="' + lastX + '" cy="' + lastY + '" r="3.5"/></svg>'
}

// Period-over-period change between the latest value and the previous sweep.
// prev null/undefined → "first run". Returns { text, dir: 'up'|'down'|'flat' }.
function deltaBadge(curr, prev) {
    curr = Number(curr) || 0
    if (prev == null || !Number.isFinite(Number(prev))) return { text: 'first run', dir: 'flat' }
    prev = Number(prev)
    const diff = curr - prev
    const pct = prev !== 0 ? (diff / prev) * 100 : 0
    const dir = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat')
    const sign = diff >= 0 ? '+' : ''
    return { text: sign + fmtK(diff) + ' (' + sign + pct.toFixed(1) + '%)', dir }
}

module.exports = { fmtK, bucketSweeps, lineAreaChart, deltaBadge }
