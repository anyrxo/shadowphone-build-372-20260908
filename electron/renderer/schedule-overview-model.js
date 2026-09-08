// schedule-overview-model.js — PURE model for the Fleet Schedule Overview.
// No DOM, no Electron: importable by both the renderer AND a node:test file.
//
// Replicates desktop/lib/schedule-engine.js next-fire semantics faithfully so the
// overview shows the SAME fire times the engine will act on:
//   - slot.time parsed as local wall-clock HH:MM (regex, never throws — malformed → skip).
//   - daily by default; weekly only on repeat_days (JS getDay 0=Sun..6=Sat).
//   - deterministic per-(account,time,content_type,day) randomize_minutes jitter,
//     applied as minutes-of-day CLAMPED to [00:00, 23:59] so it never crosses midnight.
// The engine's _slotNextFire only evaluates "today"; here we loop forward up to 7
// days so a weekly slot resolves to its NEXT upcoming fire.

// Same as schedule-engine.js MIN_FIRE_GAP_MS: two fires closer than this on one
// phone collide (the busy lock would serialize them, delaying the second).
export const MIN_FIRE_GAP_MS = 4 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

// Deterministic jitter — byte-for-byte identical to schedule-engine.js _stableJitter.
// Seed is (account_id, slot.time, slot.content_type, calendar day). Must be stable so
// the rendered fire time matches what the 30s-tick engine settles on.
function stableJitter(row, slot, day, maxMin) {
    const seed = `${(row && row.account_id) || ''}|${slot.time || ''}|${slot.content_type || ''}|${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
    let h = 0
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
    const span = maxMin * 2 + 1
    return (((h % span) + span) % span) - maxMin
}

// Parse a slot time as 24h HH:MM (ignoring any trailing :SS). Returns {hh,mm} or
// null — REJECTS out-of-range values ('24:00', '25:30', '12:75') so they skip
// instead of letting Date roll the hour/minute over into the next calendar day.
function parseSlotTime(time) {
    const m = String(time || '').match(/^(\d{1,2}):(\d{2})/)
    if (!m) return null
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10)
    if (hh > 23 || mm > 59) return null
    return { hh, mm }
}

// Compute the fire time for `slot` on the calendar day of `dayDate` (mutating a copy),
// applying the weekly gate + jitter. Returns epoch ms, or null if the slot does not
// fire that day (wrong weekday) or slot.time is malformed.
function fireOnDay(row, slot, dayDate) {
    const t = parseSlotTime(slot && slot.time)
    if (!t) return null
    const d = new Date(dayDate)
    d.setHours(t.hh, t.mm, 0, 0)

    if (row && row.repeat_pattern === 'weekly' && Array.isArray(row.repeat_days) && row.repeat_days.length) {
        if (!row.repeat_days.map(Number).includes(d.getDay())) return null
    }

    const jitterMax = Math.max(0, Math.floor(Number(row && row.randomize_minutes) || 0))
    if (jitterMax > 0) {
        const j = stableJitter(row, slot, d, jitterMax)
        const minutesOfDay = d.getHours() * 60 + d.getMinutes() + j
        const clamped = Math.max(0, Math.min(24 * 60 - 1, minutesOfDay))
        d.setHours(Math.floor(clamped / 60), clamped % 60, 0, 0)
    }
    return d.getTime()
}

// Next fire at or after fromMs, scanning today through the next 7 days (covers any
// weekday for weekly rows). Returns epoch ms or null (malformed slot / never fires).
export function slotNextFire(row, slot, fromMs) {
    const from = Number(fromMs)
    const base = new Date(from)
    for (let i = 0; i <= 7; i++) {
        const fire = fireOnDay(row, slot, new Date(base.getTime() + i * DAY_MS))
        if (fire != null && fire >= from) return fire
    }
    return null
}

// Day-precision midnight ms for a given epoch, in local time.
function startOfDay(ms) {
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}

// Per-slot lifecycle status. Read-only view; mirrors how the engine reasons about a
// slot (is_active gate, last_fired_at latch, next-fire vs now). Never throws.
//   paused   — row inactive.
//   flagged  — row will skip when the account is known-flagged.
//   posted   — already fired today (last_fired_at on this calendar day).
//   next     — the soonest upcoming fire within the next ~10min (the imminent one).
//   missed   — fire time today has passed but it never fired (no last_fired_at today).
//   pending  — has a future fire, not imminent.
//   active   — fallback for an active slot with no resolvable fire (malformed → still labelled).
export function slotStatus(row, slot, nowMs) {
    if (!row || !row.is_active) return 'paused'

    if (row.skip_posting_if_flagged && (row.is_flagged || row.flagged)) return 'flagged'

    const lastFired = row.last_fired_at ? new Date(row.last_fired_at).getTime() : 0
    const firedToday = lastFired && startOfDay(lastFired) === startOfDay(nowMs)
    const todayFire = fireOnDay(row, slot, new Date(nowMs))

    // Posted: this slot's today-fire window passed AND a fire was stamped
    // at-or-after it. last_fired_at is per-ROW (any slot firing stamps it), so
    // gating on lastFired >= this slot's today time attributes the fire to the
    // right slot — otherwise EVERY slot reads 'posted' once the account fires
    // once today (a future 19:00 slot would wrongly show posted at 08:02).
    if (firedToday && todayFire != null && lastFired >= todayFire) return 'posted'

    // Missed: this slot was due today (its today-fire time has passed) but never
    // fired. Checked BEFORE next-fire because a daily slot always has a future
    // fire (tomorrow) — without this, a missed window would read as 'pending'.
    if (todayFire != null && todayFire <= nowMs) return 'missed'

    const next = slotNextFire(row, slot, nowMs)
    if (next == null) return 'active' // active row, slot never resolves a fire (e.g. malformed)
    if (next - nowMs <= 10 * 60 * 1000) return 'next'
    return 'pending'
}

const KNOWN_CONTENT_TYPES = new Set(['reel', 'story', 'image', 'trial_reel'])

// Group rows phone → account and compute fleet totals. Each row = one account
// (key phone::androidUser::instagram::account). Malformed slots are skipped, never thrown.
export function buildOverviewModel(rows, nowMs) {
    const list = Array.isArray(rows) ? rows : []
    const phoneMap = new Map() // serial → { serial, accounts: [] }

    let accounts = 0
    let activeAccounts = 0
    let slotsPerDay = 0
    let flagged = 0
    let nextFire = null // { account, atMs }

    for (const row of list) {
        if (!row) continue
        const serial = row.phone_id || row.device_serial || row.deviceSerial || 'unknown'
        const account = row.account || row.account_id || row.account_username || '(unknown)'
        const user = row.account_username || row.account || account
        const androidUser = String(row.profile_user_id ?? row.androidUser ?? '')
        const key = row._key || ''   // exact store key — the editor targets THIS row, not an aliased twin
        const isActive = !!row.is_active
        const isFlagged = !!(row.skip_posting_if_flagged && (row.is_flagged || row.flagged))

        accounts++
        if (isActive) activeAccounts++
        if (isFlagged) flagged++

        const slots = []
        const rawSlots = Array.isArray(row.slots) ? row.slots : []
        for (const slot of rawSlots) {
            if (!slot || !parseSlotTime(slot.time)) continue // missing/malformed/out-of-range time — skip, keep the rest
            const content_type = KNOWN_CONTENT_TYPES.has(slot.content_type) ? slot.content_type : (slot.content_type || 'reel')

            const nextFireMs = slotNextFire(row, slot, nowMs)
            const jitterMax = Math.max(0, Math.floor(Number(row.randomize_minutes) || 0))
            const status = slotStatus(row, slot, nowMs)

            slots.push({ time: slot.time, content_type, status, nextFireMs, jitterMin: jitterMax })
            slotsPerDay++

            if (isActive && nextFireMs != null && (nextFire == null || nextFireMs < nextFire.atMs)) {
                nextFire = { account: user, atMs: nextFireMs }
            }
        }
        slots.sort((a, b) => a.time.localeCompare(b.time))

        if (!phoneMap.has(serial)) phoneMap.set(serial, { serial, accounts: [] })
        phoneMap.get(serial).accounts.push({ account, user, androidUser, key, isActive, flagged: isFlagged, slots })
    }

    let collisions = 0
    const phones = []
    for (const phone of phoneMap.values()) {
        collisions += detectCollisions(phone.accounts, nowMs)
        phones.push(phone)
    }
    phones.sort((a, b) => String(a.serial).localeCompare(String(b.serial)))

    return {
        phones,
        totals: { accounts, activeAccounts, slotsPerDay, flagged, collisions, nextFire },
    }
}

// Count slot pairs on ONE phone whose next-fire windows overlap (< MIN_FIRE_GAP_MS
// apart). The engine serializes one phone, so two near-simultaneous fires collide —
// the second is delayed behind the first. accountsOnPhone is an array of the account
// objects produced by buildOverviewModel (each with .slots[].nextFireMs), OR raw rows.
export function detectCollisions(accountsOnPhone, nowMs) {
    const list = Array.isArray(accountsOnPhone) ? accountsOnPhone : []
    const fires = []
    for (const acct of list) {
        if (!acct || acct.isActive === false || acct.is_active === false) continue
        const slots = Array.isArray(acct.slots) ? acct.slots : []
        for (const slot of slots) {
            // Built model carries nextFireMs; a raw row needs it computed.
            const ms = slot && slot.nextFireMs != null ? slot.nextFireMs : slotNextFire(acct, slot, nowMs)
            if (ms != null) fires.push(ms)
        }
    }
    fires.sort((a, b) => a - b)
    let collisions = 0
    for (let i = 1; i < fires.length; i++) {
        if (fires[i] - fires[i - 1] < MIN_FIRE_GAP_MS) collisions++
    }
    return collisions
}
