// fleet-registry.json device-key reconciliation. The registry is keyed by the
// volatile adb serial, but one physical phone's serial changes over its life
// (USB udid <-> tailnet ip:port, and the tailnet port rotates every reboot).
// _buildRegistry merged over the persisted map and NEVER pruned, so the same
// phone accumulated multiple device keys forever — the "10 phones vs 3 real"
// ghosts the dashboard rendered.
//
// reconcileRegistryDevices collapses every persisted entry that shares a
// hwSerial (ro.serialno) with a live phone into that phone's live canonical
// serial key, drops the stale duplicates, keeps legitimately-offline phones,
// and prunes long-unseen orphans. Pure: caller supplies the live device list
// (each {serial, hwSerial}) and `now`. Idempotent — safe to run every build.

const DEFAULT_STALE_MS = 14 * 86400 * 1000

const TAILNET_RE = /^(\d+\.\d+\.\d+\.\d+):\d+$/

function reconcileRegistryDevices(devicesMap, liveDevices, now, staleMs = DEFAULT_STALE_MS) {
  const persisted = devicesMap || {}
  const entries = Object.entries(persisted)
  const live = liveDevices || []

  const liveByHw = new Map()     // hwSerial   -> canonical (live) serial
  const liveByIp = new Map()     // tailnet IP -> canonical (live) serial
  const liveSerials = new Set()
  for (const d of live) {
    liveSerials.add(d.serial)
    if (d.hwSerial) liveByHw.set(d.hwSerial, d.serial)
    if (d.tailnetIp) liveByIp.set(d.tailnetIp, d.serial)
  }

  // Supplement liveByIp from persisted tailnet-keyed ghosts whose hwSerial maps
  // to a live phone. Handles the case where the tailnet twin was absent from the
  // current poll (e.g. transient relay drop) so d.tailnetIp was never set on the
  // merged record — without this, liveCanonOf() can't match the ghost by IP and
  // it stays as a second device card indefinitely. Read-only: only affects the
  // lookup maps, never touches devicesMap rows directly.
  for (const [k, e] of entries) {
    if (!e || !e.hwSerial) continue
    const m = TAILNET_RE.exec(k)
    if (!m) continue
    if (!liveByIp.has(m[1]) && liveByHw.has(e.hwSerial)) {
      liveByIp.set(m[1], liveByHw.get(e.hwSerial))
    }
  }

  // Which live phone does a persisted entry belong to? Match by exact serial, then
  // hwSerial, then tailnet IP — so an OLD entry that predates hwSerial stamping
  // (a bare '100.x:5555' ghost) still collapses into the live phone by its IP.
  function liveCanonOf(key, entry) {
    if (liveSerials.has(key)) return key
    if (entry && entry.hwSerial && liveByHw.has(entry.hwSerial)) return liveByHw.get(entry.hwSerial)
    const m = TAILNET_RE.exec(key)
    if (m && liveByIp.has(m[1])) return liveByIp.get(m[1])
    return null
  }

  // Fold src's profiles/accounts into dst (dst wins per profileId/handle) so a
  // ghost duplicate's data is never lost when it collapses into the canonical.
  function mergeInto(dst, src) {
    if (!src || !src.profiles) return
    dst.profiles = dst.profiles || {}
    for (const [uid, prof] of Object.entries(src.profiles)) {
      if (!dst.profiles[uid]) { dst.profiles[uid] = prof; continue }
      const acc = dst.profiles[uid].accounts || (dst.profiles[uid].accounts = {})
      for (const [h, a] of Object.entries(prof.accounts || {})) {
        if (!acc[h]) acc[h] = a
      }
    }
  }

  const out = {}

  // 1) Carry forward each LIVE phone under its canonical serial, MERGING every
  //    persisted entry that belongs to it (same phone over USB + tailnet, rotated
  //    ports, pre-hwSerial ghosts) so duplicates collapse losslessly.
  for (const d of live) {
    const canon = d.serial
    const base = persisted[canon] || { serial: canon, profiles: {} }
    for (const [k, e] of entries) {
      if (k !== canon && liveCanonOf(k, e) === canon) mergeInto(base, e)
    }
    base.serial = canon
    if (d.hwSerial) base.hwSerial = d.hwSerial
    base.lastSeen = now
    out[canon] = base
  }

  // 2) Carry forward OFFLINE phones; drop anything that belonged to a live phone
  //    (already merged above) and long-unseen orphans. Legacy entries with no
  //    lastSeen get a one-round grace so a first run never wipes them.
  for (const [k, e] of entries) {
    if (out[k]) continue
    if (!e) continue
    if (liveCanonOf(k, e) !== null) continue       // belonged to a live phone -> merged, drop the dup
    if (typeof e.lastSeen === 'number') {
      if (now - e.lastSeen > staleMs) continue     // long-unseen orphan -> prune
    } else {
      e.lastSeen = now                             // legacy: grandfather this round
    }
    out[k] = e
  }

  return out
}

// Flatten a fleet registry into the list of accounts whose Content folders
// should exist, plus a count of profiles that have no account yet (nothing to
// scaffold — there's no handle). Pure: drives the "Validate Folders" action.
// When `onlySerial` is passed, scope to the launched device only — keep just the
// devices entry whose key OR .serial OR .hwSerial equals it (the same match the
// dashboard renderer uses to narrow _registry.devices). Unset → whole fleet.
function enumerateRegistryAccounts(registry, onlySerial) {
  const out = { accounts: [], emptyProfiles: 0, deviceCount: 0, profileCount: 0 }
  const devices = (registry && registry.devices) || {}
  for (const [serial, dev] of Object.entries(devices)) {
    if (onlySerial && !(serial === onlySerial || (dev && (dev.serial === onlySerial || dev.hwSerial === onlySerial)))) continue
    out.deviceCount++
    const profiles = (dev && dev.profiles) || {}
    for (const [userId, prof] of Object.entries(profiles)) {
      out.profileCount++
      const handles = Object.keys((prof && prof.accounts) || {})
      if (!handles.length) { out.emptyProfiles++; continue }
      for (const handle of handles) {
        out.accounts.push({ serial, userId, handle, profileName: (prof && prof.name) || null })
      }
    }
  }
  return out
}

module.exports = { reconcileRegistryDevices, enumerateRegistryAccounts, DEFAULT_STALE_MS }
