/**
 * schedule-engine.js — per-phone-serialized smart scheduler (2.19.4).
 *
 * Replaces the previous dormant stub with a queue-based scheduler that:
 *   1. Treats slots whose time has passed as OVERDUE and fires them
 *      (up to a recovery window — default 4h late).
 *   2. Per phone, only ONE workflow runs at a time. Other due slots on
 *      the same phone queue and fire when the current one completes.
 *   3. Across due slots, oldest scheduled time wins (most-overdue first).
 *   4. Last_fired_at on the schedule row prevents double-fires across
 *      VAs and within the same VA.
 *   5. Slot time is interpreted in the operator's LOCAL clock — matches
 *      what the user sees in the picker.
 *
 * Flag `_engineEnabled` in handlers/schedule-handlers.js gates start().
 * Cloud scheduler co-existence: if the cloud also fires, last_fired_at
 * gates double-fires from either direction.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const TICK_MS = 30_000
const FIRE_LOOKAHEAD_MS = 90_000               // start firing within 90s of slot time
const FIRE_OVERDUE_MAX_MS = 4 * 60 * 60 * 1000 // catch up slots up to 4h overdue
const MIN_FIRE_GAP_MS = 4 * 60 * 1000          // same slot won't fire twice within 4min

let _intervalHandle = null
let _ctx = null

// `${account_id}::${slotIdx}` → epoch ms of last LOCAL fire attempt.
const recentlyFired = new Map()

// Per-phone busy lock. While a workflow is running on a phone, no new
// candidates fire there — they sit in the queue and the NEXT tick picks
// them up after the busy flag clears.
const busyPhones = new Set()

// serial → epoch ms when the phone was marked busy. Read by insights-sweep.js
// and models-dashboard-scan.js to auto-unlock a phone whose run hung past the
// busy ceiling. The engine's own _tick also clears any serial older than
// BUSY_MAX_MS so a crashed/hung run (which never ran its .finally()) can't
// permanently halt posting on that phone.
const busyPhoneTimestamps = new Map()
const BUSY_MAX_MS = 30 * 60 * 1000
// Keepalive cadence for a held lock (see acquirePhoneLock / the engine fire path).
// Must stay well under BUSY_MAX_MS so one missed tick can't expose a healthy run.
const PHONE_LOCK_HEARTBEAT_MS = 60 * 1000
// ...but a keepalive that never stops would make the janitor unable to EVER
// reclaim a lock taken through acquirePhoneLock, re-creating the permanent-strand
// bug the janitor exists to fix. No legitimate single locked operation (one
// account creation, one module run, one companion install) runs for hours, so the
// heartbeat retires itself here and the janitor reclaims BUSY_MAX_MS later.
const PHONE_LOCK_HEARTBEAT_MAX_MS = 4 * 60 * 60 * 1000

// lockKey → unique claim token of the fire that currently owns the busy lock.
// The 30-min auto-unlock can reclaim a phone from a still-running fire (the engine
// fire path has no heartbeat), letting a later tick fire a second workflow on top of
// the first. The heartbeat below keeps a healthy long fire's timestamp fresh so the
// auto-unlock never triggers; the token is the safety net for a genuine >30-min hang:
// a fire only releases the lock if it still owns the token, so a reclaim+re-claim by
// a newer fire isn't clobbered by the stale fire's .finally().
const lockOwners = new Map()

// Independent from busyPhones: this FIFO is the execution safety boundary for
// every module entry point, while busyPhones remains scheduler coordination only.
const moduleRunMutexes = new Map()

function hardwareIdentityError() {
    const error = new Error('Physical phone identity could not be verified')
    error.code = 'HARDWARE_IDENTITY_UNVERIFIED'
    return error
}

function moduleAbortedError() {
    const error = new Error('Module was aborted before execution started')
    error.code = 'MODULE_ABORTED'
    return error
}

function verifiedHardwareKey(hwSerial) {
    const key = String(hwSerial ?? '').trim()
    const lower = key.toLowerCase()
    if (
        !key
        || lower === 'null'
        || lower === 'unknown'
        || lower === 'undefined'
        || !/^[A-Za-z0-9._:-]+$/.test(key)
    ) {
        throw hardwareIdentityError()
    }
    return key
}

function grantNextModuleRun(key, state) {
    if (state.locked || state.quarantined) return
    const ticket = state.waiters.shift()
    if (!ticket) {
        moduleRunMutexes.delete(key)
        return
    }

    state.locked = true
    const ownerToken = Symbol(key)
    state.ownerToken = ownerToken
    ticket.granted = true
    let released = false
    const release = () => {
        if (released) return
        released = true
        if (state.ownerToken !== ownerToken) return
        state.ownerToken = null
        state.locked = false
        grantNextModuleRun(key, state)
    }
    release.hardwareKey = key
    release.quarantine = () => {
        if (released || state.ownerToken !== ownerToken) return false
        state.quarantined = true
        state.quarantineOwner = ownerToken
        release()
        return true
    }
    release.recover = () => {
        if (!state.quarantined || state.quarantineOwner !== ownerToken) return false
        state.quarantined = false
        state.quarantineOwner = null
        grantNextModuleRun(key, state)
        return true
    }
    ticket.resolve(release)
}

function acquireModuleRunMutex(hwSerial) {
    const key = verifiedHardwareKey(hwSerial)
    let state = moduleRunMutexes.get(key)
    if (!state) {
        state = { locked: false, waiters: [], quarantined: false, quarantineOwner: null, ownerToken: null }
        moduleRunMutexes.set(key, state)
    }

    let resolve
    let reject
    const ticket = {
        granted: false,
        wait: new Promise((res, rej) => {
            resolve = res
            reject = rej
        }),
        cancel() {
            if (ticket.granted) return false
            const index = state.waiters.indexOf(ticket)
            if (index === -1) return false
            state.waiters.splice(index, 1)
            reject(moduleAbortedError())
            if (!state.locked) grantNextModuleRun(key, state)
            return true
        },
    }
    ticket.resolve = resolve
    state.waiters.push(ticket)
    grantNextModuleRun(key, state)
    return ticket
}

function createModuleRunAbortState() {
    let currentClient = null
    let currentTicket = null
    const state = {
        aborted: false,
        get client() { return currentClient },
        get ticket() { return currentTicket },
        setClient(client) {
            currentClient = client || null
            if (state.aborted && currentClient) {
                currentClient.abort()
                currentClient = null
                return false
            }
            return !state.aborted
        },
        clearClient(client) {
            if (!client || currentClient === client) currentClient = null
        },
        setTicket(ticket) {
            currentTicket = ticket || null
            if (state.aborted && currentTicket) {
                currentTicket.cancel()
                currentTicket = null
                return false
            }
            return !state.aborted
        },
        clearTicket(ticket) {
            if (!ticket || currentTicket === ticket) currentTicket = null
        },
        abort() {
            const wasActive = !state.aborted
            state.aborted = true
            currentTicket?.cancel()
            currentClient?.abort()
            return wasActive
        },
    }
    return state
}

// ── transport-agnostic phone identity for the busy lock ──────────────────────
// One physical phone appears under DIFFERENT adb serials per transport: the USB
// udid vs a rotating tailnet ip:port. The scan/insights sweeps lock on the
// dashboard/operational serial (often the USB udid) while the schedule-engine
// fire path locks on row.phone_id (often the tailnet serial). Keyed raw, those
// two strings differ for the SAME phone → the locks DON'T mutually exclude, so a
// scan and a scheduled fire could run on one phone at once (dump contention /
// wrong-account post). Normalize BOTH sides to ro.serialno (hwSerial) before
// touching busyPhones.
//
// serial -> hwSerial, populated by registerHwSerial. The sweeps already hold a
// live LocalDevice and read ro.serialno cheaply once per run, registering BOTH
// their raw invocation serial AND the hwSerial. canonicalPhoneKey then collapses
// either transport's serial to the same key; an unregistered serial falls back
// to itself (pre-existing behavior — no regression while cron is OFF and no scan
// has run). Bounded by the live fleet size, so no eviction needed.
const _hwSerialBySerial = new Map()
const _phoneLockTokenKeys = new Map()

function registerHwSerial(serial, hwSerial) {
    if (!serial || !hwSerial) return
    const rawSerial = String(serial)
    const canonicalSerial = String(hwSerial)
    const previousKey = _hwSerialBySerial.get(rawSerial) || rawSerial
    _hwSerialBySerial.set(rawSerial, canonicalSerial)
    // hwSerial maps to itself so canonicalPhoneKey is idempotent on an
    // already-canonical key.
    _hwSerialBySerial.set(canonicalSerial, canonicalSerial)
    if (previousKey !== canonicalSerial && busyPhones.has(previousKey)) {
        busyPhones.delete(previousKey)
        busyPhones.add(canonicalSerial)
        const timestamp = busyPhoneTimestamps.get(previousKey)
        busyPhoneTimestamps.delete(previousKey)
        busyPhoneTimestamps.set(canonicalSerial, timestamp || Date.now())
        for (const [token, key] of _phoneLockTokenKeys.entries()) {
            if (key === previousKey) _phoneLockTokenKeys.set(token, canonicalSerial)
        }
        if (lockOwners.has(previousKey)) {
            lockOwners.set(canonicalSerial, lockOwners.get(previousKey))
            lockOwners.delete(previousKey)
        }
    }
}

function canonicalPhoneKey(serial) {
    return _hwSerialBySerial.get(String(serial)) || String(serial)
}

// Acquire the per-phone busy lock for a NON-scheduled run (account_creation,
// manual module runs, auto-run queue). Returns a release() fn if it took the
// lock, or null if the phone is already locked by someone else (caller proceeds
// WITHOUT owning the lock — never rejects, never frees another owner's lock, so
// this can't break the engine's own fires or deadlock). While held, the engine's
// _tick skips this phone — which stops a scheduled slot from switching the
// Android user mid account-creation. A LIVE run is kept safe by the heartbeat
// below; the >30min stale sweep (startPhoneLockJanitor) only covers a missed
// release. Keyed by canonicalPhoneKey so USB + tailnet serials collapse to one.
function acquirePhoneLock(serial) {
    if (!serial) return null
    const key = canonicalPhoneKey(serial)
    if (busyPhones.has(key)) return null
    busyPhones.add(key)
    busyPhoneTimestamps.set(key, Date.now())
    const ownerToken = Object.freeze({})
    _phoneLockTokenKeys.set(ownerToken, key)
    // Record ownership so a release can NEVER free a lock that the janitor
    // reclaimed and a different owner has since taken. Without this, a stale
    // holder finishing late would unlock the new owner's phone mid-run.
    lockOwners.set(key, ownerToken)
    // Heartbeat — the same keepalive the engine fire path has. Without it this
    // path stamped busyPhoneTimestamps ONCE at acquire, so any create or module
    // run longer than BUSY_MAX_MS had its lock reclaimed by the janitor mid-run:
    // isPhoneBusy then reported idle and a scheduled fire or the companion pass
    // could guardedSwitchUser on top of a live signup. The ownership token only
    // stops a late release from freeing someone else's lock — it does not stop
    // the reclaim. Follows the key through a registerHwSerial re-key, and goes
    // quiet the moment a newer owner holds the lock.
    const acquiredAt = Date.now()
    const heartbeat = setInterval(() => {
        const activeKey = _phoneLockTokenKeys.get(ownerToken)
        if (!activeKey || lockOwners.get(activeKey) !== ownerToken) return
        if (Date.now() - acquiredAt > PHONE_LOCK_HEARTBEAT_MAX_MS) { clearInterval(heartbeat); return }
        busyPhoneTimestamps.set(activeKey, Date.now())
    }, PHONE_LOCK_HEARTBEAT_MS)
    heartbeat.unref?.()
    let released = false
    const releasePhoneLock = function releasePhoneLock() {
        if (released) return
        released = true
        clearInterval(heartbeat)
        const activeKey = _phoneLockTokenKeys.get(ownerToken) || key
        _phoneLockTokenKeys.delete(ownerToken)
        if (lockOwners.get(activeKey) !== ownerToken) return
        busyPhones.delete(activeKey)
        busyPhoneTimestamps.delete(activeKey)
        lockOwners.delete(activeKey)
    }
    releasePhoneLock.ownerToken = ownerToken
    return releasePhoneLock
}

// Auto-unlock phones stuck busy beyond the max (a workflow that crashed or hung
// and never ran its finally). One bad run must not silently block all future
// posting — or the fleet-wide companion pass — on that phone until the process
// restarts. Dropping the owner token makes the reclaim VISIBLE to the stale
// holder's release(), which then declines to free the new owner's lock.
function _sweepStalePhoneLocks(now = Date.now()) {
    let reclaimed = 0
    for (const [serial, addedAt] of busyPhoneTimestamps) {
        if (now - addedAt > BUSY_MAX_MS) {
            busyPhones.delete(serial)
            busyPhoneTimestamps.delete(serial)
            lockOwners.delete(serial)
            reclaimed += 1
            console.warn(`[schedule-engine] auto-unlocked ${serial} (busy >30min — assuming crashed/hung run)`)
        }
    }
    return reclaimed
}

// The sweep above used to live ONLY inside _tick, which is scheduled only by
// engine.start() — gated off in shipped builds behind
// SHADOWPHONE_ENABLE_LEGACY_SCHEDULE_AUTOFIRE. So the documented self-heal never
// ran and a stranded lock was permanent for the process lifetime. Run it on its
// own interval, independent of the legacy autofire engine.
const PHONE_LOCK_JANITOR_MS = 60 * 1000
let _janitorHandle = null

function startPhoneLockJanitor(intervalMs = PHONE_LOCK_JANITOR_MS) {
    if (_janitorHandle) return _janitorHandle
    _janitorHandle = setInterval(() => {
        try { _sweepStalePhoneLocks() } catch (e) { console.warn('[schedule-engine] lock janitor error:', e?.message) }
    }, intervalMs)
    _janitorHandle.unref?.()
    return _janitorHandle
}

function stopPhoneLockJanitor() {
    if (_janitorHandle) { clearInterval(_janitorHandle); _janitorHandle = null }
}

function isPhoneLockOwnerToken(token, serial) {
    if (!token || typeof token !== 'object') return false
    const key = canonicalPhoneKey(serial)
    return _phoneLockTokenKeys.get(token) === key && busyPhones.has(key)
}

// ── guarded foreground-user switching (the owner-flip choke-point) ───────────
// The recurring "phone flips back to Owner mid-run" bug: every autonomous
// switch site (companion installer, Tailscale revival) had its own bare
// capture → `am switch-user 0` → restore block, each with its own TOCTOU
// window and unverified restore. guardedSwitchUser() is the ONE gate:
//   1. A switch to Owner (user 0) executes ONLY with intent:'human' (an
//      explicit operator request threaded from an IPC/portal handler) or
//      intent:'maintenance' while the caller presents this phone's busyPhones
//      ownerToken. There is no autonomous, lock-less, or fallback path to Owner.
//   2. A maintenance Owner switch first verifies the current user is a
//      non-zero secondary (GrapheneOS first-boot init transiently reports 0 —
//      abort rather than capture a bogus restore target), then registers a
//      PERSISTED restore obligation {phone → restoreTo} BEFORE switching, so a
//      crash / adb flake mid-pass can never permanently strand the phone on
//      Owner — the next pass (or next app boot) heals it first.
//   3. Every switch and restore runs start-user → switch-user → get-current-user
//      verification poll with one retry (a stopped user silently no-ops on a
//      bare switch-user). A restore only counts once the phone verifiably
//      lands on restoreTo; an open obligation blocks further maintenance
//      switches on that phone.
//   4. The restore target is never defaulted, never '0', and never re-read
//      after the switch — it is the value captured under the lock.
const restoreObligations = new Map()
let _obligationsLoaded = false
let _obligationsFilePath = null

function _resolveObligationsFile() {
    if (_obligationsFilePath) return _obligationsFilePath
    try {
        const { app } = require('electron')
        _obligationsFilePath = path.join(app.getPath('userData'), 'switch-restore-obligations.json')
    } catch (_) { /* not in electron main (tests) — persistence off until a path is set */ }
    return _obligationsFilePath
}

function _loadObligations() {
    if (_obligationsLoaded) return
    _obligationsLoaded = true
    const file = _resolveObligationsFile()
    if (!file) return
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const [key, obligation] of Object.entries(parsed || {})) {
            // Never load a '0' / non-numeric restore target — restoring to Owner
            // is exactly the defect this machinery exists to prevent.
            if (obligation && /^\d+$/.test(String(obligation.restoreTo)) && String(obligation.restoreTo) !== '0') {
                restoreObligations.set(key, obligation)
            }
        }
    } catch (_) { /* no file yet — start empty */ }
}

function _persistObligations() {
    const file = _resolveObligationsFile()
    if (!file) return
    try { fs.writeFileSync(file, JSON.stringify(Object.fromEntries(restoreObligations), null, 2), 'utf8') }
    catch (e) { console.warn('[schedule-engine] could not persist restore obligations:', e?.message) }
}

// Test seam: point persistence at a file (and reload from it) without electron.
function _setRestoreObligationsFile(filePath) {
    _obligationsFilePath = filePath || null
    _obligationsLoaded = false
    restoreObligations.clear()
    _loadObligations()
}

function hasPendingRestore(serial) {
    _loadObligations()
    return restoreObligations.has(canonicalPhoneKey(serial))
}

function isPhoneBusy(serial) {
    return busyPhones.has(canonicalPhoneKey(serial))
}

// True while ANY phone holds the per-phone busy lock (a create / manual /
// auto-run is driving a device). The device-watchdog consults this before an
// adb-server restart so it never tears the transport out from under an active
// run (the confirmed create-stall + sidebar-vanish trigger).
function hasBusyPhones() {
    return busyPhones.size > 0
}

const SWITCH_VERIFY_ATTEMPTS = 6
const SWITCH_VERIFY_INTERVAL_MS = 1000
const _defaultWait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// start-user → switch-user → verify poll, with one full retry. execAdb takes
// (argsArray, timeoutMs) and resolves to stdout (callers adapt runAdb/executeADB).
async function _verifiedSwitch(execAdb, serial, targetUser, wait) {
    let lastSeen = null
    for (let attempt = 0; attempt < 2; attempt++) {
        // start-user first: a stopped secondary user (State:-1, e.g. after a
        // reboot) silently no-ops on a bare switch-user — the documented trap.
        try { await execAdb(['-s', serial, 'shell', 'am', 'start-user', targetUser], 6000) } catch (_) {}
        try { await execAdb(['-s', serial, 'shell', 'am', 'switch-user', targetUser], 6000) } catch (_) {}
        for (let poll = 0; poll < SWITCH_VERIFY_ATTEMPTS; poll++) {
            try {
                const current = String(await execAdb(['-s', serial, 'shell', 'am', 'get-current-user'], 4000) || '').trim()
                lastSeen = current
                if (current === targetUser) return { verified: true, currentUser: current }
            } catch (_) {}
            await wait(SWITCH_VERIFY_INTERVAL_MS)
        }
    }
    return { verified: false, currentUser: lastSeen }
}

async function guardedSwitchUser({ execAdb, serial, targetUser, intent, ownerToken, wait }) {
    _loadObligations()
    if (typeof execAdb !== 'function' || !serial) {
        return { success: false, code: 'SWITCH_GUARD_MISUSED', error: 'execAdb and serial are required' }
    }
    const target = String(targetUser ?? '').trim()
    // No default target, ever — a missing/garbled target must never become '0'.
    if (!/^\d+$/.test(target)) {
        return { success: false, code: 'INVALID_TARGET_USER', error: `A numeric target user is required (got '${target}')` }
    }
    const sleep = wait || _defaultWait

    if (target !== '0') {
        const result = await _verifiedSwitch(execAdb, serial, target, sleep)
        return result.verified
            ? { success: true, targetUser: target }
            : { success: false, code: 'SWITCH_UNVERIFIED', targetUser: target, currentUser: result.currentUser }
    }

    // Owner (user 0): only an explicit human request, or a maintenance pass
    // that provably owns this phone's busy lock. Anything else is refused
    // WITHOUT touching adb — that refusal IS the mid-run owner-flip fix.
    const maintenance = intent === 'maintenance' && isPhoneLockOwnerToken(ownerToken, serial)
    if (intent !== 'human' && !maintenance) {
        return {
            success: false,
            code: 'OWNER_SWITCH_BLOCKED',
            error: 'Refusing to switch this phone to Owner: not a human request and no valid phone-lock owner token.',
        }
    }

    if (maintenance) {
        const key = canonicalPhoneKey(serial)
        if (restoreObligations.has(key)) {
            return { success: false, code: 'RESTORE_PENDING', error: 'A prior Owner switch has not verifiably restored yet — completeRestore must land first.' }
        }
        let currentUser = null
        try { currentUser = String(await execAdb(['-s', serial, 'shell', 'am', 'get-current-user'], 4000) || '').trim() } catch (_) {}
        // '0' here is ambiguous (first-boot init reports Owner transiently) and
        // must never be captured as a restore target — skip this pass instead.
        if (!/^\d+$/.test(currentUser) || currentUser === '0') {
            return { success: false, code: 'CURRENT_USER_AMBIGUOUS', currentUser }
        }
        // Register the obligation BEFORE switching so a crash between the
        // switch and the restore is healed by the next pass (or next boot).
        restoreObligations.set(key, { serial: String(serial), restoreTo: currentUser, at: Date.now() })
        _persistObligations()
        const result = await _verifiedSwitch(execAdb, serial, '0', sleep)
        return result.verified
            ? { success: true, targetUser: '0', restoreTo: currentUser }
            : { success: false, code: 'SWITCH_UNVERIFIED', targetUser: '0', restoreTo: currentUser, currentUser: result.currentUser }
    }

    const result = await _verifiedSwitch(execAdb, serial, '0', sleep)
    return result.verified
        ? { success: true, targetUser: '0' }
        : { success: false, code: 'SWITCH_UNVERIFIED', targetUser: '0', currentUser: result.currentUser }
}

// Verified restore to the obligation's captured target. Clears the obligation
// ONLY on a verified landing; on failure it stays, blocking further maintenance
// switches on this phone until a later retry lands.
async function completeRestore({ execAdb, serial, wait }) {
    _loadObligations()
    const key = canonicalPhoneKey(serial)
    const obligation = restoreObligations.get(key)
    if (!obligation) return { success: true, code: 'NO_OBLIGATION' }
    const restoreTo = String(obligation.restoreTo ?? '').trim()
    // Non-'0' by construction; belt against a hand-edited obligations file.
    if (!/^\d+$/.test(restoreTo) || restoreTo === '0') {
        restoreObligations.delete(key)
        _persistObligations()
        return { success: false, code: 'INVALID_RESTORE_TARGET', restoreTo }
    }
    const result = await _verifiedSwitch(execAdb, serial, restoreTo, wait || _defaultWait)
    if (!result.verified) {
        return { success: false, code: 'RESTORE_UNVERIFIED', restoreTo, currentUser: result.currentUser }
    }
    restoreObligations.delete(key)
    _persistObligations()
    return { success: true, restoredTo: restoreTo }
}

// Map slot.content_type → module name (from handlers/module-handlers.js).
const CONTENT_TYPE_TO_MODULE = {
    reel: 'post_reel',
    trial_reel: 'post_trial_reel',
    image: 'post_feed',
    story: 'post_story',
}

// Step IDs the engine runs BEFORE the post module (in this order).
const STEP_ORDER = [
    'wake_unlock',
    'airplane_on',
    'switch_profile',
    'airplane_off',
    'vpn_connect',
    'clean_gallery',
    'push_content',
    'ig_switch_account',
]

// Steps whose failure means we'd post to the WRONG account (or with no
// content) — these are HARD preconditions. If one throws or returns a
// falsy / {ok:false} / {success:false} result, abort the whole slot and
// do NOT proceed to modules or the post action. (STEP_ORDER uses
// `ig_switch_account` to match the toolbar's SCHED_STEPS toggle IDs and the
// disabled_steps entries saved by the sidebar; only switch_profile/push_content
// are critical so the IG-switch step stays soft warn-and-continue.)
const CRITICAL_STEPS = new Set(['switch_profile', 'push_content'])

// Post-post IG modules (run AFTER the post if not disabled).
const PRE_FLOW_MODULES = [
    'ig_pre_engage',
    'ig_pre_stories',
    'ig_status_check',
]
const POST_FLOW_MODULES = [
    'ig_post_engage',
    'ig_post_stories',
    'ig_repost',
]

function start(ctx) {
    _ctx = ctx
    if (_intervalHandle) return
    // Clear any stale in-memory locks from a prior engine lifecycle (e.g. a
    // stop()/start() re-init within the same process). A phone left in
    // busyPhones by an interrupted workflow would otherwise silently block
    // ALL future fires on that phone.
    busyPhones.clear()
    busyPhoneTimestamps.clear()
    lockOwners.clear()
    recentlyFired.clear()
    _intervalHandle = setInterval(() => { _tick().catch(e => console.warn('[schedule-engine] tick error:', e?.message)) }, TICK_MS)
    console.log('[schedule-engine] started (30s tick, oldest-overdue-first per-phone serial)')

    // Eagerly seed _hwSerialBySerial before the first tick (fired 1.5s from now)
    // so canonicalPhoneKey() returns the stable ro.serialno for every phone that
    // the fleet registry already knows about. Without this, the first tick fires
    // while _hwSerialBySerial is empty and locks on the raw tailnet ip:port; a
    // concurrent scan sweep locks on the USB UDID — different keys for the same
    // physical phone — and mutual exclusion is absent for that startup window.
    // ctx.getDevices is an optional zero-arg async fn that returns an array of
    // { serial, hwSerial } records (the already-in-memory fleet registry). If not
    // provided (schedule-handlers older than this fix), the seeding is a no-op and
    // behavior falls back to the pre-existing fallback exactly as before.
    if (typeof ctx.getDevices === 'function') {
        Promise.resolve(ctx.getDevices()).then(devices => {
            if (!Array.isArray(devices)) return
            let seeded = 0
            for (const d of devices) {
                if (d && d.serial && d.hwSerial) {
                    registerHwSerial(d.serial, d.hwSerial)
                    seeded++
                }
            }
            if (seeded > 0) {
                console.log(`[schedule-engine] pre-seeded hwSerial map for ${seeded} device(s) before first tick`)
            }
        }).catch(e => {
            // Non-fatal: first tick falls back to raw serials as before.
            console.warn('[schedule-engine] getDevices pre-seed failed (non-fatal):', e?.message)
        })
    }

    // Fire once immediately so a fresh save is picked up without 30s wait.
    setTimeout(() => { _tick().catch(e => console.warn('[schedule-engine] tick error:', e?.message)) }, 1500)
}

function stop() {
    if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null }
}

// Logout reset. The engine keeps NO persistent in-memory schedule list — _tick
// re-pulls every slot from Supabase (scoped to the signed-in userId) each tick —
// so there's nothing user-owned to wipe here. We just stop the cron and drop the
// volatile fire-claim / busy-lock maps so a different user signing in on this same
// install never inherits stale per-account fire latches or phone busy locks.
// _ctx is left intact: its getSessionToken closure reads the live session, so it
// stays correct across the user swap without re-init. Supabase data is untouched.
function reset() {
    stop()
    recentlyFired.clear()
    busyPhones.clear()
    busyPhoneTimestamps.clear()
    lockOwners.clear()
}

// Attach the workflow ctx WITHOUT scheduling the 30s cron tick. Lets
// schedule:fire-now dispatch a manual run (which dereferences _ctx) while
// auto-fire stays OFF. Replicates ONLY the `_ctx = ctx` assignment from start().
function attachCtx(ctx) {
    _ctx = ctx
}

async function _tick() {
    if (!_ctx) return
    const sessionToken = _ctx.getSessionToken()
    if (!sessionToken) return                            // no user signed in

    let schedules = []
    try { schedules = await _ctx.client.listAllSchedulesForUser(sessionToken) }
    catch (e) { console.warn('[schedule-engine] list failed:', e?.message); return }

    const now = new Date()
    const nowMs = now.getTime()

    // Build candidates grouped by phone serial.
    // Each candidate: { slotTime, ageMs, row, slot, slotIdx, serial }
    const perPhone = new Map()

    for (const row of schedules) {
        if (!row.is_active) continue
        if (!Array.isArray(row.slots) || row.slots.length === 0) continue

        // The row owns a (phone_id, profile_user_id) — these are saved at
        // authoring time. Without phone_id we can't queue per phone, so skip.
        const serial = row.phone_id || row.device_serial || row.deviceSerial
        if (!serial) continue

        // The engine + post modules are Instagram-only. A row keyed for another
        // platform must be skipped — never mis-run as Instagram against the wrong app.
        if ((row.platform || 'instagram') !== 'instagram') continue

        const disabled = new Set(row.disabled_steps || [])

        for (let i = 0; i < row.slots.length; i++) {
            const slot = row.slots[i]
            if (!slot?.time || !slot?.content_type) continue
            // Unknown content_type → skip the slot rather than silently defaulting
            // to a reel post (which would post unintended content autonomously).
            if (!CONTENT_TYPE_TO_MODULE[slot.content_type]) continue

            const nextFire = _slotNextFire(row, slot, now)
            if (!nextFire) continue

            const ageMs = nowMs - nextFire.getTime()
            // Too early — slot hasn't reached its lookahead window yet.
            if (ageMs < -FIRE_LOOKAHEAD_MS) continue
            // Too overdue — gave up. Will fire fresh tomorrow.
            if (ageMs > FIRE_OVERDUE_MAX_MS) continue

            // Local dup guard: don't refire same slot within 4 min from
            // this VA. Cross-VA gate happens via last_fired_at below.
            // Key on stable slot identity (time+content_type) instead of array
            // index so deleting/reordering slots can't cause a stale entry to
            // match a different slot (BUG-3 fix).
            const fireKey = `${row.account_id}::${slot.time}::${slot.content_type}`
            const lastLocal = recentlyFired.get(fireKey) || 0
            if (Date.now() - lastLocal < MIN_FIRE_GAP_MS) continue

            // Cross-VA / dedup gate: if last_fired_at on the row is past
            // (nextFire - lookahead) we treat this slot's instance as already
            // fired by someone (us OR another VA OR the cloud). Skip.
            // The window MUST match FIRE_LOOKAHEAD_MS: a slot can fire up to 90s
            // early, stamping last_fired_at before its slot time. A narrower 60s
            // window let those early fires escape the latch and re-fire after
            // MIN_FIRE_GAP — a duplicate post.
            const lastFiredAt = row.last_fired_at ? new Date(row.last_fired_at).getTime() : 0
            const earliestClaim = nextFire.getTime() - FIRE_LOOKAHEAD_MS
            if (lastFiredAt >= earliestClaim) continue

            if (!perPhone.has(serial)) perPhone.set(serial, [])
            perPhone.get(serial).push({
                slotTime: nextFire,
                ageMs,
                row,
                slot,
                slotIdx: i,
                serial,
                disabled,
            })
        }
    }

    _sweepStalePhoneLocks()

    // For each phone: only fire ONE workflow if not already busy. Pick
    // the oldest scheduled time (most overdue) so a 9:15 slot fires before
    // a 9:30 slot even when we're tick'ing at 9:32.
    for (const [serial, candidates] of perPhone.entries()) {
        // Lock on the transport-agnostic key so a sweep that grabbed this same
        // physical phone under its USB udid blocks this tailnet-keyed fire (and
        // vice-versa). Falls back to the raw serial when ro.serialno is unknown.
        const lockKey = canonicalPhoneKey(serial)
        if (busyPhones.has(lockKey)) {
            const overdueCount = candidates.filter(c => c.ageMs > 0).length
            console.log(`[schedule-engine] phone=${serial} busy — ${candidates.length} candidates queued (${overdueCount} overdue)`)
            continue
        }
        candidates.sort((a, b) => a.slotTime - b.slotTime)
        const top = candidates[0]
        const others = candidates.length - 1

        const fireKey = `${top.row.account_id}::${top.slot.time}::${top.slot.content_type}`
        recentlyFired.set(fireKey, Date.now())
        busyPhones.add(lockKey)
        busyPhoneTimestamps.set(lockKey, Date.now())
        // Unique token so this fire's .finally() / heartbeat can tell whether IT
        // still owns the lock after a possible auto-unlock + re-claim by a later tick.
        const claimToken = Symbol()
        lockOwners.set(lockKey, claimToken)

        const ageStr = top.ageMs >= 0
            ? `${Math.round(top.ageMs / 60000)}min overdue`
            : `due in ${Math.round(-top.ageMs / 1000)}s`
        console.log(
            `[schedule-engine] fire phone=${serial} acct=${top.row.account_id} slot=${top.slotIdx} ` +
            `(${top.slot.time} ${top.slot.content_type}, ${ageStr})` +
            (others > 0 ? ` — ${others} more queued on this phone` : '')
        )

        // Heartbeat: while THIS fire owns the lock, keep its busy timestamp fresh so
        // the 30-min auto-unlock never reclaims a healthy long-running fire (the
        // engine fire path otherwise has no keepalive). Stops mattering the moment a
        // newer claim takes the lock — the ownership check makes it a no-op then.
        const hb = setInterval(() => {
            if (lockOwners.get(lockKey) === claimToken) busyPhoneTimestamps.set(lockKey, Date.now())
        }, 60_000)
        if (hb.unref) hb.unref()

        // Mark claim BEFORE async fire — both locally (last_fired_at on
        // Supabase) and via the busyPhones lock — so the next tick won't
        // re-pick this slot.
        _fireWorkflow(top.row, top.slot, top.slotIdx, top.disabled)
            .catch(e => console.warn(`[schedule-engine] fire failed:`, e?.message || e))
            .finally(() => {
                clearInterval(hb)
                // Only release if THIS fire still owns the lock. If the 30-min
                // auto-unlock reclaimed it mid-fire (and possibly handed it to a newer
                // fire), don't free the new holder's lock — that would let a third
                // workflow fire on top of the second.
                if (lockOwners.get(lockKey) === claimToken) {
                    busyPhones.delete(lockKey)
                    busyPhoneTimestamps.delete(lockKey)
                    lockOwners.delete(lockKey)
                    console.log(`[schedule-engine] phone=${serial} idle — next tick will queue any pending`)
                } else {
                    console.warn(`[schedule-engine] phone=${serial} lock reclaimed mid-fire — not releasing (owned by a newer claim)`)
                }
            })
    }
}

// Stable per-(account, slot, calendar-day) jitter offset in [-maxMin, +maxMin].
// MUST be deterministic: the 30s tick recomputes _slotNextFire constantly, so a
// random offset each tick would move the fire time around and break the
// lookahead/last_fired_at window (slot never settles / fires repeatedly).
// Byte-for-byte identical to renderer/schedule-overview-model.js stableJitter so
// the overview display matches what the engine settles on.
function _stableJitter(row, slot, day, maxMin) {
    const seed = `${(row && row.account_id) || ''}|${slot.time || ''}|${slot.content_type || ''}|${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
    let h = 0
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
    const span = maxMin * 2 + 1
    return (((h % span) + span) % span) - maxMin
}

// Convert HH:MM (operator's local time) → today's date at that time, honoring the
// row's repeat cadence + jitter. Returns null when the slot does NOT fire today
// (e.g. a weekly slot on a non-scheduled weekday) so the tick skips it.
function _slotNextFire(row, slot, now) {
    const m = String(slot.time || '').match(/^(\d{1,2}):(\d{2})/)
    if (!m) return null
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10)
    // REJECT out-of-range times ('24:00', '25:30', '12:75') so a malformed slot
    // skips instead of letting Date roll into the next calendar day (which would
    // fire on the wrong day AND desync the weekday gate). Matches the overview
    // model's parseSlotTime so engine + display stay byte-for-byte in agreement.
    if (hh > 23 || mm > 59) return null
    const today = new Date(now)
    today.setHours(hh, mm, 0, 0)

    // Weekly cadence: only fire on the configured weekdays. repeat_days holds JS
    // getDay() indices (0=Sun..6=Sat); empty/absent or a non-weekly pattern → daily.
    if (row && row.repeat_pattern === 'weekly' && Array.isArray(row.repeat_days) && row.repeat_days.length) {
        if (!row.repeat_days.map(Number).includes(today.getDay())) return null
    }

    // Jitter the fire minute by ±randomize_minutes (deterministic per day) so posts
    // don't all land on the exact configured minute (a mild anti-bot signal).
    const jitterMax = Math.max(0, Math.floor(Number(row && row.randomize_minutes) || 0))
    if (jitterMax > 0) {
        // Apply jitter as minutes-of-day CLAMPED to [00:00, 23:59] of `today`, so a
        // near-midnight slot can't roll into an adjacent calendar day — which would
        // fire on the wrong day AND desync the weekday gate evaluated above (it ran
        // on today's getDay()).
        const j = _stableJitter(row, slot, today, jitterMax)
        const minutesOfDay = today.getHours() * 60 + today.getMinutes() + j
        const clamped = Math.max(0, Math.min(24 * 60 - 1, minutesOfDay))
        today.setHours(Math.floor(clamped / 60), clamped % 60, 0, 0)
    }
    return today
}

async function _fireWorkflow(row, slot, slotIndex, disabledSteps) {
    const disabled = disabledSteps ?? new Set(row.disabled_steps || [])
    const accountId = row.account_id
    const prevFiredAt = row.last_fired_at || null   // restore this if the post fails, so the slot retries

    // Mark last_fired_at BEFORE the workflow so other VAs back off. With a cloud
    // session this stamps Supabase; with NO session (LOCAL_ONLY) saveSchedule
    // throws, so we ALSO write the claim into sidebar-schedules.json via
    // markFiredLocal — otherwise the forward stamp never persists and
    // _restoreFiredClaim's local rollback becomes a no-op (restores a value that
    // never changed → no working cross-fire dedup offline).
    const sessionToken = _ctx.getSessionToken()
    if (!sessionToken) {
        // LOCAL_ONLY: persist the claim locally. Done first/unconditionally because
        // the cloud saveSchedule below throws without a session, so a stamp placed
        // after the await would never run.
        if (_ctx.client && _ctx.client.markFiredLocal) {
            _ctx.client.markFiredLocal(_ctx.userDataPath, row)
        }
    }
    try {
        await _ctx.client.saveSchedule(
            { id: row.id, account_id: accountId, last_fired_at: new Date().toISOString() },
            sessionToken
        )
    } catch (e) {
        console.warn('[schedule-engine] claim update failed:', e?.message)
    }

    // Resolve workflow context: serial + userId + folder paths via callback.
    // We pass the row so resolveWorkflowCtx doesn't have to re-fetch from
    // Supabase to find phone_id / profile_user_id — they're right here.
    let ctx
    try {
        ctx = await _ctx.resolveWorkflowCtx(accountId, row) || {
            accountId,
            account_username: accountId,
            serial: row.phone_id,
            phone_id: row.phone_id,
            profile_user_id: row.profile_user_id,
            userId: row.profile_user_id,
        }
    } catch (e) {
        await _restoreFiredClaim(row, accountId, prevFiredAt)
        return { ok: false, code: 'WORKFLOW_CONTEXT_FAILED', error: e?.message || 'Could not resolve the workflow target.' }
    }

    // 1) Steps in order — AWAIT each so we serialize on this phone.
    //    Critical steps (switch_profile, push_content) are HARD: a failure
    //    there means we'd post to the wrong account / with no content, so we
    //    abort the slot. Non-critical steps keep the soft warn-and-continue.
    //    NOTE: in the current desktop wiring runStep is DEFERRED — main.js
    //    runWorkflowStep returns {ok:true,deferred:true} and the real step
    //    execution (incl. the switch_profile/post-switch wrong-account hard-fail)
    //    happens once in the renderer's workflow run kicked by the post module.
    //    So this engine-level abort is a belt-and-braces guard that only bites if
    //    a host ever wires runStep to genuine per-step execution; the live
    //    wrong-account protection lives in the renderer.
    for (const stepId of STEP_ORDER) {
        if (disabled.has(stepId)) continue
        if (CRITICAL_STEPS.has(stepId)) {
            let res
            try {
                res = await _ctx.runStep(stepId, ctx)
            } catch (e) {
                console.warn(`[schedule-engine] ABORT slot: critical step ${stepId} failed — not posting:`, e?.message)
                await _restoreFiredClaim(row, accountId, prevFiredAt)
                return { ok: false, code: 'CRITICAL_STEP_FAILED', step: stepId, error: e?.message || `${stepId} failed` }
            }
            // Treat falsy / {ok:false} / {success:false} as a failure too.
            if (!res || res.ok === false || res.success === false) {
                console.warn(`[schedule-engine] ABORT slot: critical step ${stepId} failed — not posting`)
                await _restoreFiredClaim(row, accountId, prevFiredAt)
                return {
                    ...(res && typeof res === 'object' ? res : {}),
                    ok: false,
                    code: res?.code || 'CRITICAL_STEP_FAILED',
                    step: stepId,
                    error: res?.error || `${stepId} failed`,
                }
            }
            continue
        }
        try {
            await _ctx.runStep(stepId, ctx)
        } catch (e) {
            console.warn(`[schedule-engine] step ${stepId} failed:`, e?.message)
        }
    }

    // 2) Pre-post modules.
    for (const mod of PRE_FLOW_MODULES) {
        if (disabled.has(mod)) continue
        try { await _ctx.runModule(mod, ctx) }
        catch (e) { console.warn(`[schedule-engine] module ${mod} failed:`, e?.message) }
    }

    // 3) Post action — picked by slot content_type. Respects the per-
    //    content-type post toggle (ig_post / ig_post_story / ig_post_trial).
    const POST_TOGGLE_BY_CONTENT = {
        reel: 'ig_post',
        image: 'ig_post',
        story: 'ig_post_story',
        trial_reel: 'ig_post_trial',
    }
    const postToggleId = POST_TOGGLE_BY_CONTENT[slot.content_type] || 'ig_post'
    let postRes = null
    if (!disabled.has(postToggleId)) {
        const postModule = CONTENT_TYPE_TO_MODULE[slot.content_type] || 'post_reel'
        // H7: forward the slot index alongside the slot so the headless toolbar
        // posts the DUE slot's content (not a hardcoded 0) on a multi-slot
        // account. The schedule `row` rides on `ctx` (attached by
        // resolveWorkflowCtx) so the toolbar's no-schedule guard passes.
        try { postRes = await _ctx.runModule(postModule, ctx, { slot, slotIndex }) }
        catch (e) { console.warn(`[schedule-engine] post (${postModule}) failed:`, e?.message); postRes = { ok: false, error: e?.message } }
        // The post is the GOAL. If it failed/refused (incl. the renderer's
        // ban-safety wrong-account abort, surfaced as ok:false), DON'T leave the
        // slot latched as posted — roll the last_fired_at claim back to its prior
        // value so the next tick retries (the 4-min recentlyFired gap throttles it).
        // A flagged-account hard-skip returns ok, so it stays latched (rested).
        if (!postRes || postRes.ok === false || postRes.success === false) {
            console.warn(`[schedule-engine] post (${postModule}) did not succeed — rolling back the fired-claim so the slot retries`)
            await _restoreFiredClaim(row, accountId, prevFiredAt)
            return postRes && typeof postRes === 'object'
                ? { ...postRes, ok: false }
                : { ok: false, code: 'WORKFLOW_NO_RESULT', error: 'The posting workflow ended without a result.' }
        }
    } else {
        postRes = { ok: true, skipped: true, code: 'POST_DISABLED' }
    }

    // 4) Post-post modules.
    for (const mod of POST_FLOW_MODULES) {
        if (disabled.has(mod)) continue
        try { await _ctx.runModule(mod, ctx) }
        catch (e) { console.warn(`[schedule-engine] module ${mod} failed:`, e?.message) }
    }
    return postRes
}

// Roll the last_fired_at claim back to its prior value after a FAILED post, so the
// slot is no longer latched as fired and the next tick retries it (throttled by the
// 4-min recentlyFired gap). Inverse of the pre-dispatch stamp in _fireWorkflow.
async function _restoreFiredClaim(row, accountId, prevFiredAt) {
    try {
        const sessionToken = _ctx.getSessionToken()
        if (sessionToken) {
            await _ctx.client.saveSchedule({ id: row.id, account_id: accountId, last_fired_at: prevFiredAt }, sessionToken)
        } else if (_ctx.client.restoreFiredLocal) {
            _ctx.client.restoreFiredLocal(_ctx.userDataPath, row, prevFiredAt)
        }
        row.last_fired_at = prevFiredAt
    } catch (e) {
        console.warn('[schedule-engine] fired-claim rollback failed:', e?.message)
    }
}

// Public Run Now bypasses the cross-VA claim guard, but never the per-phone
// execution lock. Operator intent must not collide with an in-flight signup.
async function runNow({ row, slot, slotIndex }) {
    const phoneKey = canonicalPhoneKey(row?.phone_id)
    if (row?.phone_id && busyPhones.has(phoneKey)) {
        return { ok: false, code: 'PHONE_BUSY', error: 'This phone is already running another automation.' }
    }
    return _fireWorkflow(
        row,
        slot ?? row.slots?.[slotIndex || 0] ?? { content_type: 'reel' },
        slotIndex || 0,
    )
}

module.exports = {
    start,
    stop,
    reset,
    attachCtx,
    runNow,
    registerHwSerial,
    canonicalPhoneKey,
    acquirePhoneLock,
    isPhoneLockOwnerToken,
    startPhoneLockJanitor,
    stopPhoneLockJanitor,
    _sweepStalePhoneLocks,
    acquireModuleRunMutex,
    createModuleRunAbortState,
    guardedSwitchUser,
    completeRestore,
    hasPendingRestore,
    isPhoneBusy,
    hasBusyPhones,
    _setRestoreObligationsFile,
    _restoreObligations: restoreObligations,
    _STEP_ORDER: STEP_ORDER,
    _CONTENT_TYPE_TO_MODULE: CONTENT_TYPE_TO_MODULE,
    _busyPhones: busyPhones,
    _busyPhoneTimestamps: busyPhoneTimestamps,
    _moduleRunMutexes: moduleRunMutexes,
    _PRE_FLOW_MODULES: PRE_FLOW_MODULES,
    _POST_FLOW_MODULES: POST_FLOW_MODULES,
}
