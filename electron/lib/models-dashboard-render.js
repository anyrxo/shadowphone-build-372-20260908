'use strict'
/**
 * Pure (DOM-free) helpers for models-dashboard.html. Kept in its own module so
 * they're unit-testable under plain `node` and shared 1:1 with the renderer.
 * modelOf MUST stay byte-identical to model-handlers.modelOf (SHARED CONTRACT).
 */

// modelOf: strip a trailing _<alphanumerics> group if present, else whole name.
// Group is matched case-insensitively but display casing is preserved.
// Belle->Belle, Kayleigh_3->Kayleigh, Lillie_alt->Lillie, Anna_Marie_2->Anna_Marie.
// A capitalized-word suffix (e.g. Marie) is treated as a name token, not a variant
// suffix, so Anna_Marie stays Anna_Marie. MUST stay byte-identical to model-handlers.modelOf.
function modelOf(name) {
  const s = String(name == null ? '' : name)
  const m = s.match(/^(.+)_([A-Za-z0-9]+)$/)
  if (!m) return s
  if (/^[A-Z][a-z]+$/.test(m[2])) return s
  return m[1]
}

// accountKey = `${serial}::${userId}::instagram::${account}` (account lowercased).
function buildAccountKey(serial, userId, account) {
  return `${serial}::${String(userId)}::instagram::${String(account || '').toLowerCase()}`
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

// Flatten the fleet registry into model groups for rendering.
// Returns [{ model, accountCount, profiles:[{ serial, profileId, name, accounts:[{handle,scheduleActive,statsAt,counts,userId,serial}] }] }]
// sorted alphabetically by model (case-insensitive); profiles sorted by name.
// statsAt: ISO string|null — timestamp of last insights fetch for the per-row 'stats Xm ago' sub-line.
// Note: no separate is_active field exists on account registry objects; scheduleActive is the only
// automation flag available here. A future isActive field should be wired separately when available.
function groupByModel(registry) {
  const devices = (registry && registry.devices) || {}
  const byModel = new Map() // lowerModel -> { model, profiles:[] }
  for (const serial of Object.keys(devices)) {
    const dev = devices[serial] || {}
    const profiles = dev.profiles || {}
    for (const pid of Object.keys(profiles)) {
      const p = profiles[pid] || {}
      const model = p.model || modelOf(p.name || '')
      const lk = model.toLowerCase()
      if (!byModel.has(lk)) byModel.set(lk, { model, profiles: [] })
      const accounts = Object.keys(p.accounts || {}).map(h => {
        const a = p.accounts[h] || {}
        return {
          handle: a.handle || h,
          scheduleActive: !!a.scheduleActive,
          statsAt: a.statsAt || null,
          counts: a.counts || { images: 0, videos: 0, reels: 0, stories: 0, remaining: 0, posted: 0, lowContent: true },
          userId: String(p.profileId != null ? p.profileId : pid),
          serial: dev.serial || serial,
          statsError: a.statsError || null,
        }
      })
      byModel.get(lk).profiles.push({
        serial: dev.serial || serial,
        profileId: p.profileId != null ? p.profileId : Number(pid),
        name: p.name || String(pid),
        accounts,
      })
    }
  }
  const groups = Array.from(byModel.values()).map(g => {
    g.profiles.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    g.accountCount = g.profiles.reduce((n, pr) => n + pr.accounts.length, 0)
    return g
  })
  groups.sort((a, b) => a.model.toLowerCase().localeCompare(b.model.toLowerCase()))
  return groups
}

module.exports = { modelOf, buildAccountKey, escapeHtml, groupByModel }
