// Shared jitter-aware "next free slot" math for collision resolution.
// Used by CommandCenter's single-slot Retime hint AND BulkRetimeModal's batch
// proposal. Pure: callers pass in the phone roster + loaded slots, so the same
// logic backs both surfaces without either reaching into the other's closure.

import type { Slot } from './types'
import type { Exception } from './exceptions'

// Minimal phone shape this math needs — a serial plus the handles on it. The
// real PhoneBucket satisfies this structurally.
export interface RetimePhone {
  serial: string
  profiles: { accounts: { handle: string }[] }[]
}

const DAY = 24 * 60

function toMin(hm: string): number | null {
  const m = hm.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) % DAY
}

function fmt(min: number): string {
  const m = ((min % DAY) + DAY) % DAY
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

// Build the set of taken minutes-of-day for one serial from the loaded slots.
// A slot at base T with jitter J fires somewhere in [T, T+J], so the WHOLE
// window is unavailable — mirrors CommandCenter.getNextFreeSlot exactly.
export function buildTakenSet(
  serial: string,
  phones: RetimePhone[],
  slotsByHandle: Record<string, Slot[]>,
): Set<number> {
  const taken = new Set<number>()
  for (const ph of phones) {
    if (ph.serial !== serial) continue
    for (const p of ph.profiles) {
      for (const a of p.accounts) {
        for (const s of (slotsByHandle[a.handle.toLowerCase()] || [])) {
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

// Scan forward in 1-min steps from `startHm` for the first minute NOT in `taken`.
// Returns 'HH:MM'. If every minute is taken, returns the original (sane fallback).
export function nextFreeMinute(startHm: string, taken: Set<number>): string {
  const start = toMin(startHm)
  if (start == null) return startHm.slice(0, 5)
  for (let i = 1; i <= DAY; i++) {
    const m = (start + i) % DAY
    if (!taken.has(m)) return fmt(m)
  }
  return fmt(start)
}

export interface RetimeProposal {
  key: string
  serial: string
  userId: string
  handle: string
  content_type: string
  from: string // 'HH:MM' current (colliding) time
  to: string | null // 'HH:MM' proposed time, or null when this row is kept
  kept: boolean // true for the earliest account in a cluster (left in place)
}

// Propose a non-colliding time for every colliding slot on every phone.
//
// For each (serial, HH:MM) cluster of colliding accounts, KEEP the earliest
// (the alphabetically-first handle is a deterministic, stable "earliest") and
// reassign the rest to the next free jitter-safe minute. CRITICAL: a running
// per-serial taken-set is seeded from the loaded schedule and then GROWS as we
// place each reassignment, so two reassignments on the same phone can never be
// proposed onto the same minute.
export function proposeRetimes(
  collisions: Exception[],
  phones: RetimePhone[],
  slotsByHandle: Record<string, Slot[]>,
  contentTypeByKeyTime: (key: string, hm: string) => string,
): RetimeProposal[] {
  // Cluster colliding exceptions by serial::HH:MM.
  const clusters = new Map<string, Exception[]>()
  for (const e of collisions) {
    const hm = String(e.slotTime || '').slice(0, 5)
    if (!/^\d{2}:\d{2}$/.test(hm)) continue
    const ck = `${e.serial}::${hm}`
    const arr = clusters.get(ck)
    if (arr) arr.push(e); else clusters.set(ck, [e])
  }

  // One running taken-set per serial, seeded from the existing schedule.
  const takenBySerial = new Map<string, Set<number>>()
  const takenFor = (serial: string): Set<number> => {
    let t = takenBySerial.get(serial)
    if (!t) { t = buildTakenSet(serial, phones, slotsByHandle); takenBySerial.set(serial, t) }
    return t
  }
  const markTaken = (taken: Set<number>, hm: string) => {
    const m = toMin(hm)
    if (m != null) taken.add(m)
  }

  const out: RetimeProposal[] = []
  // Deterministic order: serial, then time.
  const orderedClusterKeys = [...clusters.keys()].sort((a, b) => a.localeCompare(b))

  for (const ck of orderedClusterKeys) {
    const members = clusters.get(ck)!
    const [serial, hm] = ck.split('::')
    // Sort cluster members by handle so "earliest" is stable.
    const sorted = [...members].sort((a, b) => a.handle.toLowerCase().localeCompare(b.handle.toLowerCase()))
    const taken = takenFor(serial)

    sorted.forEach((e, idx) => {
      const ct = contentTypeByKeyTime(e.key, hm)
      if (idx === 0) {
        // Keep the earliest in place — its minute stays occupied (already in the set).
        out.push({ key: e.key, serial, userId: e.userId, handle: e.handle, content_type: ct, from: hm, to: null, kept: true })
        return
      }
      const to = nextFreeMinute(hm, taken)
      if (to === hm) {
        // Saturated phone — nextFreeMinute fell back to the original minute. That's
        // a no-op, not a fix: mark it kept so it isn't counted as a resolved change.
        out.push({ key: e.key, serial, userId: e.userId, handle: e.handle, content_type: ct, from: hm, to: null, kept: true })
        return
      }
      markTaken(taken, to) // grow the running set so the next reassign avoids it
      out.push({ key: e.key, serial, userId: e.userId, handle: e.handle, content_type: ct, from: hm, to, kept: false })
    })
  }

  return out
}
