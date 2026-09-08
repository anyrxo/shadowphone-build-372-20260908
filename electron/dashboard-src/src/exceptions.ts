import type { AccountCounts, Slot } from './types'

export type IssueType = 'collision' | 'missed' | 'starving' | 'noSchedule' | 'idle' | 'stale'
export type Severity = 'critical' | 'warn' | 'info'

// Singular IssueType → plural ExceptionSet bucket key.
export const ISSUE_BUCKET: Record<IssueType, 'collisions' | 'missed' | 'starving' | 'noSchedule' | 'idle' | 'stale'> = {
  collision: 'collisions',
  missed: 'missed',
  starving: 'starving',
  noSchedule: 'noSchedule',
  idle: 'idle',
  stale: 'stale',
}

export function getSeverity(t: IssueType): Severity {
  // noSchedule = toggled ON but zero slots → silently never posts; as bad as a missed post.
  if (t === 'collision' || t === 'missed' || t === 'noSchedule') return 'critical'
  if (t === 'starving') return 'warn'
  return 'info' // idle, stale
}

// Slot statuses that participate in collision / missed detection. Future/unknown
// statuses are ignored so new pipeline states don't silently trigger triage.
const COLLISION_STATUSES = new Set(['active', 'pending', 'next'])
const MISSED_STATUSES = new Set(['missed', 'flagged'])

export interface Exception {
  issueType: IssueType
  severity: Severity
  serial: string
  userId: string // the IG user id (acct.userId), NOT the profile number
  handle: string
  key: string // buildAccountKey(serial, userId, handle)
  counts?: AccountCounts
  slotTime?: string // 'HH:MM' (collision / missed)
  collidesWith?: string[] // OTHER handles in the same collision group (collision only)
  detail?: string // e.g. 'reel 09:00 missed'
}

export interface ExceptionSet {
  collisions: Exception[]
  missed: Exception[]
  starving: Exception[]
  noSchedule: Exception[]
  idle: Exception[]
  stale: Exception[]
  summary: {
    active: number
    firingSoon: number
    needYou: number
    collide: number
    miss: number
    starve: number
    noScheduleCount: number
    idleCount: number
    staleCount: number
  }
}

export interface BuildExceptionsOpts {
  staleDays?: number
  firingSoonMin?: number
  lowContentThreshold?: number
}

interface AccountWithKey {
  handle: string
  scheduleActive: boolean
  statsAt: string | null
  statsError?: string
  counts: AccountCounts
  userId: string
  serial: string
  key: string
}

interface ProfileWithKey {
  serial: string
  profileId: number | string
  name: string
  accounts: AccountWithKey[]
}

interface PhoneBucket {
  serial: string
  name: string
  profiles: ProfileWithKey[]
}

// Extract a normalized 'HH:MM' from a slot time, or null if it doesn't parse.
// Exported so CcStrip can compare slot times against collisionTimes using the
// SAME zero-padding logic (e.g. '9:05' → '09:05'), keeping the two in sync.
export function parseHm(time: string): string | null {
  const m = String(time).match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`
}

export function buildExceptions(
  phones: PhoneBucket[],
  slotsByHandle: Record<string, Slot[]>,
  opts?: BuildExceptionsOpts,
): ExceptionSet {
  const {
    staleDays = 7,
    firingSoonMin = 5,
    lowContentThreshold = 4,
  } = opts || {}

  const staleDayMs = staleDays * 864e5 // 24 * 60 * 60 * 1000
  const now = Date.now()

  const result: ExceptionSet = {
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

  const slotsFor = (handle: string): Slot[] => slotsByHandle[handle.toLowerCase()] || []

  // ── Collision detection ─────────────────────────────────────────────────
  // Group accounts by (serial + HH:MM) over active/pending slots; a phone can
  // only run one account at a time, so >=2 distinct handles at the same minute
  // on the same serial is a hard conflict — flag the WHOLE group.
  const collisionGroups = new Map<string, AccountWithKey[]>()

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

  const seenCollisions = new Set<string>()
  for (const [groupKey, accounts] of collisionGroups.entries()) {
    if (accounts.length < 2) continue
    const uniqueHandles = [...new Set(accounts.map(a => a.handle))]
    if (uniqueHandles.length < 2) continue // same account scheduled twice — not a cross-account collision
    const hm = groupKey.split('::')[1]
    for (const acct of accounts) {
      // Dedupe per (account, time) so an account that collides at two different
      // times is emitted once PER time — never twice for the same time. This
      // lets collisionTimesByKey mark the ⚠ on every colliding slot, not just
      // the first. summary.collide thus counts colliding slot-instances.
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

  // ── Per-account passes (phones-first) ───────────────────────────────────
  for (const phone of phones) {
    for (const profile of phone.profiles) {
      for (const acct of profile.accounts) {
        const slots = slotsFor(acct.handle)

        // MISSED: any slot with status missed/flagged.
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

        // STARVING: lowContent flag, or remaining below the threshold.
        if (acct.counts.lowContent === true || acct.counts.remaining < lowContentThreshold) {
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

        // IDLE: schedule off but content available.
        if (!acct.scheduleActive && acct.counts.remaining > 0) {
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

        // NO SCHEDULE: toggled ON but zero slots → silently never posts. A real
        // safety hole distinct from IDLE (which is scheduleActive=false). Critical.
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

        // STALE: stats error, or statsAt older than staleDays. Date.parse is
        // safe-guarded with Number.isFinite so a malformed timestamp never throws
        // and is never treated as stale.
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

        // ACTIVE: scheduleActive accounts.
        if (acct.scheduleActive) result.summary.active++

        // FIRING SOON: any slot firing within firingSoonMin (count once/account).
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

export function keysForFilter(ex: ExceptionSet, active: Set<IssueType>): Set<string> {
  const keys = new Set<string>()
  for (const issueType of active) {
    const bucket = ex[ISSUE_BUCKET[issueType]]
    for (const exc of bucket) keys.add(exc.key)
  }
  return keys
}

// How long the remaining content lasts at the account's posting cadence.
// Cadence = posts/day implied by the slot list length (one slot ≈ one post/day).
// Pure & deterministic: nowMs is passed in but isn't needed for the forecast —
// it's accepted so callers can wire in firing-aware logic later without a churn.
export function computeRunway(
  remaining: number,
  slots: Slot[],
  _nowMs: number,
): { hoursLeft: number | null; label: string } {
  const postsPerDay = slots.length

  if (postsPerDay === 0) return { hoursLeft: null, label: 'no schedule' }
  if (remaining <= 0) return { hoursLeft: 0, label: 'out of content' }

  const hoursLeft = (remaining / postsPerDay) * 24

  if (hoursLeft < 24) {
    return { hoursLeft, label: `~${Math.round(hoursLeft)}h left` }
  }
  const days = Math.round((hoursLeft / 24) * 10) / 10
  // Drop a trailing .0 so 6.0 → '6d', but keep 1.5 → '1.5d'.
  const daysLabel = Number.isInteger(days) ? String(days) : days.toFixed(1)
  return { hoursLeft, label: `~${daysLabel}d left` }
}
