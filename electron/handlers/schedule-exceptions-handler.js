/**
 * schedule-exceptions-handler.js — schedule:build-exceptions + schedule:propose-retimes
 *
 * Ports the proven, pure logic from electron/dashboard-src/src/exceptions.ts
 * (buildExceptions / parseHm) and electron/dashboard-src/src/retime-util.ts
 * (proposeRetimes / buildTakenSet / nextFreeMinute / toMin / fmt) into plain JS
 * so the main process can run it without the dashboard-src build step.
 *
 * The renderer passes in the already-loaded fleet roster (PhoneBucket[]) and the
 * loaded slots (Record<handle, Slot[]>) from schedule:list-all — this handler is
 * pure, deterministic, and never drives a phone or touches Supabase.
 */
'use strict'

const { ipcMain } = require('electron')

// ── ported from exceptions.ts ───────────────────────────────────────────────

const COLLISION_STATUSES = new Set(['active', 'pending', 'next'])
const MISSED_STATUSES = new Set(['missed', 'flagged'])

function getSeverity(t) {
  if (t === 'collision' || t === 'missed' || t === 'noSchedule') return 'critical'
  if (t === 'starving') return 'warn'
  return 'info'
}

// Extract a normalized 'HH:MM' from a slot time, or null if it doesn't parse.
function parseHm(time) {
  const m = String(time).match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`
}

function buildExceptions(phones, slotsByHandle, opts) {
  const {
    staleDays = 7,
    firingSoonMin = 5,
    lowContentThreshold = 4,
  } = opts || {}

  const staleDayMs = staleDays * 864e5
  const now = Date.now()

  const result = {
    collisions: [],
    missed: [],
    starving: [],
    noSchedule: [],
    idle: [],
    stale: [],
    summary: {
      active: 0,
      firingSoon: 0,
      needYou: 0,
      collide: 0,
      miss: 0,
      starve: 0,
      noScheduleCount: 0,
      idleCount: 0,
      staleCount: 0,
    },
  }

  const slotsFor = (handle) => slotsByHandle[String(handle).toLowerCase()] || []

  // ── Collision detection ───────────────────────────────────────────────────
  const collisionGroups = new Map()

  for (const phone of phones) {
    for (const profile of phone.profiles) {
      for (const acct of profile.accounts) {
        for (const slot of slotsFor(acct.handle)) {
          if (!COLLISION_STATUSES.has(slot.status)) continue
          const hm = parseHm(slot.time)
          if (!hm) continue
          const groupKey = `${acct.serial}::${hm}`
          let group = collisionGroups.get(groupKey)
          if (!group) { group = []; collisionGroups.set(groupKey, group) }
          group.push(acct)
        }
      }
    }
  }

  const seenCollisions = new Set()
  for (const [groupKey, accounts] of collisionGroups.entries()) {
    if (accounts.length < 2) continue
    const uniqueHandles = [...new Set(accounts.map(a => a.handle))]
    if (uniqueHandles.length < 2) continue
    const hm = groupKey.split('::')[1]
    for (const acct of accounts) {
      const dedupeKey = `${acct.key}::${hm}`
      if (seenCollisions.has(dedupeKey)) continue
      seenCollisions.add(dedupeKey)
      result.collisions.push({
        issueType: 'collision',
        severity: getSeverity('collision'),
        serial: acct.serial,
        userId: acct.userId,
        handle: acct.handle,
        key: acct.key,
        counts: acct.counts,
        slotTime: hm,
        collidesWith: uniqueHandles.filter(h => h !== acct.handle),
      })
      result.summary.collide++
    }
  }

  // ── Per-account passes ────────────────────────────────────────────────────
  for (const phone of phones) {
    for (const profile of phone.profiles) {
      for (const acct of profile.accounts) {
        const slots = slotsFor(acct.handle)
        const counts = acct.counts || {}

        for (const slot of slots) {
          if (!MISSED_STATUSES.has(slot.status)) continue
          const hm = parseHm(slot.time) ?? slot.time
          result.missed.push({
            issueType: 'missed',
            severity: getSeverity('missed'),
            serial: acct.serial,
            userId: acct.userId,
            handle: acct.handle,
            key: acct.key,
            counts: acct.counts,
            slotTime: hm,
            detail: `${slot.content_type} ${hm} missed`,
          })
          result.summary.miss++
        }

        if (counts.lowContent === true || (counts.remaining || 0) < lowContentThreshold) {
          result.starving.push({
            issueType: 'starving',
            severity: getSeverity('starving'),
            serial: acct.serial,
            userId: acct.userId,
            handle: acct.handle,
            key: acct.key,
            counts: acct.counts,
          })
          result.summary.starve++
        }

        if (!acct.scheduleActive && (counts.remaining || 0) > 0) {
          result.idle.push({
            issueType: 'idle',
            severity: getSeverity('idle'),
            serial: acct.serial,
            userId: acct.userId,
            handle: acct.handle,
            key: acct.key,
            counts: acct.counts,
          })
          result.summary.idleCount++
        }

        if (acct.scheduleActive && slots.length === 0) {
          result.noSchedule.push({
            issueType: 'noSchedule',
            severity: getSeverity('noSchedule'),
            serial: acct.serial,
            userId: acct.userId,
            handle: acct.handle,
            key: acct.key,
            counts: acct.counts,
            detail: 'active · no slots',
          })
          result.summary.noScheduleCount++
        }

        const staleMs = acct.statsAt ? Date.parse(acct.statsAt) : NaN
        const isStale =
          !!acct.statsError ||
          (Number.isFinite(staleMs) && now - staleMs > staleDayMs)

        if (isStale) {
          result.stale.push({
            issueType: 'stale',
            severity: getSeverity('stale'),
            serial: acct.serial,
            userId: acct.userId,
            handle: acct.handle,
            key: acct.key,
            counts: acct.counts,
          })
          result.summary.staleCount++
        }

        if (acct.scheduleActive) result.summary.active++

        for (const slot of slots) {
          if (
            slot.nextFireMs != null &&
            slot.nextFireMs > now &&
            slot.nextFireMs - now <= firingSoonMin * 60 * 1000
          ) {
            result.summary.firingSoon++
            break
          }
        }
      }
    }
  }

  result.summary.needYou =
    result.summary.collide +
    result.summary.miss +
    result.summary.starve +
    result.summary.noScheduleCount

  return result
}

// ── ported from retime-util.ts ──────────────────────────────────────────────

const DAY = 24 * 60

function toMin(hm) {
  const m = String(hm).match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) % DAY
}

function fmt(min) {
  const m = ((min % DAY) + DAY) % DAY
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function buildTakenSet(serial, phones, slotsByHandle) {
  const taken = new Set()
  for (const ph of phones) {
    if (ph.serial !== serial) continue
    for (const p of ph.profiles) {
      for (const a of p.accounts) {
        for (const s of (slotsByHandle[String(a.handle).toLowerCase()] || [])) {
          const base = toMin(String(s.time).slice(0, 5))
          if (base == null) continue
          const j = Math.max(0, Math.floor(s.jitterMin || 0))
          for (let k = 0; k <= j; k++) taken.add((base + k) % DAY)
        }
      }
    }
  }
  return taken
}

function nextFreeMinute(startHm, taken) {
  const start = toMin(startHm)
  if (start == null) return String(startHm).slice(0, 5)
  for (let i = 1; i <= DAY; i++) {
    const m = (start + i) % DAY
    if (!taken.has(m)) return fmt(m)
  }
  return fmt(start)
}

function proposeRetimes(collisions, phones, slotsByHandle, contentTypeByKeyTime) {
  const clusters = new Map()
  for (const e of collisions) {
    const hm = String(e.slotTime || '').slice(0, 5)
    if (!/^\d{2}:\d{2}$/.test(hm)) continue
    const ck = `${e.serial}::${hm}`
    const arr = clusters.get(ck)
    if (arr) arr.push(e); else clusters.set(ck, [e])
  }

  const takenBySerial = new Map()
  const takenFor = (serial) => {
    let t = takenBySerial.get(serial)
    if (!t) { t = buildTakenSet(serial, phones, slotsByHandle); takenBySerial.set(serial, t) }
    return t
  }
  const markTaken = (taken, hm) => {
    const m = toMin(hm)
    if (m != null) taken.add(m)
  }

  const out = []
  const orderedClusterKeys = [...clusters.keys()].sort((a, b) => a.localeCompare(b))

  for (const ck of orderedClusterKeys) {
    const members = clusters.get(ck)
    const [serial, hm] = ck.split('::')
    const sorted = [...members].sort((a, b) => a.handle.toLowerCase().localeCompare(b.handle.toLowerCase()))
    const taken = takenFor(serial)

    sorted.forEach((e, idx) => {
      const ct = contentTypeByKeyTime(e.key, hm)
      if (idx === 0) {
        out.push({ key: e.key, serial, userId: e.userId, handle: e.handle, content_type: ct, from: hm, to: null, kept: true })
        return
      }
      const to = nextFreeMinute(hm, taken)
      if (to === hm) {
        out.push({ key: e.key, serial, userId: e.userId, handle: e.handle, content_type: ct, from: hm, to: null, kept: true })
        return
      }
      markTaken(taken, to)
      out.push({ key: e.key, serial, userId: e.userId, handle: e.handle, content_type: ct, from: hm, to, kept: false })
    })
  }

  return out
}

// ── IPC handlers ────────────────────────────────────────────────────────────

// Build a (key, hm) → content_type lookup from the loaded slots so the retime
// proposal can echo back the content type of each colliding slot. Falls back to
// the first slot at that minute if the caller passed slots keyed by handle.
function makeContentTypeResolver(collisions, slotsByHandle) {
  const byKeyTime = new Map()
  const handleByKey = new Map()
  for (const e of collisions) handleByKey.set(e.key, e.handle)
  for (const e of collisions) {
    const slots = slotsByHandle[String(e.handle).toLowerCase()] || []
    for (const s of slots) {
      const hm = parseHm(s.time)
      if (!hm) continue
      byKeyTime.set(`${e.key}::${hm}`, s.content_type || 'reel')
    }
  }
  return (key, hm) => byKeyTime.get(`${key}::${hm}`) || 'reel'
}

function registerScheduleExceptionsHandlers(_ipcMain) {
  const ipc = _ipcMain || ipcMain

  // schedule:build-exceptions — (phones, slotsByHandle, opts?) → { ok, exceptionSet }
  ipc.handle('schedule:build-exceptions', async (_e, phones, slotsByHandle, opts) => {
    try {
      let list = Array.isArray(phones) ? phones : []
      if (opts && opts.serial) list = list.filter(p => p.serial === opts.serial)
      const exceptionSet = buildExceptions(list, slotsByHandle || {}, opts)
      return { ok: true, exceptionSet }
    } catch (err) {
      return { ok: false, error: err && err.message }
    }
  })

  // schedule:propose-retimes — ({ collisions, phones, slotsByHandle }) → { ok, proposals }
  ipc.handle('schedule:propose-retimes', async (_e, args) => {
    try {
      const { collisions = [], phones = [], slotsByHandle = {} } = args || {}
      const resolver = makeContentTypeResolver(collisions, slotsByHandle)
      const proposals = proposeRetimes(collisions, phones, slotsByHandle, resolver)
      return { ok: true, proposals }
    } catch (err) {
      return { ok: false, error: err && err.message }
    }
  })

  console.log('[schedule-exceptions-handler] 2 IPC handlers registered')
}

module.exports = {
  registerScheduleExceptionsHandlers,
  // exported for tests / reuse
  buildExceptions,
  parseHm,
  proposeRetimes,
  buildTakenSet,
  nextFreeMinute,
}
