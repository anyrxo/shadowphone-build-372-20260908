// desktop/lib/models-dashboard-scan.js
/**
 * Scan sweep orchestrator for the Models Dashboard.
 *
 * For a single phone, walks every Android profile and, for each one, runs the
 * airplane-wrapped profile switch + IG launch + account detection sequence
 * LOCALLY (via LOCAL_MODULE_HANDLERS in local-modules.js, driven by a LocalDevice
 * from local-modules-shared.js) — no brain/WS round trip. Discovered IG handles
 * are merged into %APPDATA%/shadowphone-desktop/fleet-registry.json.
 *
 * The whole sweep holds the schedule-engine per-phone busy lock so it can never
 * overlap a scheduled post on the same phone (and vice-versa). If the phone is
 * already busy (a post is mid-flight, or another scan is running), the sweep
 * refuses with {ok:false,error:'phone_busy'}.
 *
 * Depends on the Task 0 fix in modules/profile_switch.js: a stopped GrapheneOS
 * user must start-user before switch-user, else the verify poll here falsely
 * rejects the (eventually-foregrounded) target and the sweep aborts.
 */

'use strict'

const path = require('node:path')
const scheduleEngine = require('./schedule-engine')
const { LOCAL_MODULE_HANDLERS, LocalDevice } = require('./local-modules')
const { recoverPendingIdentityChanges } = require('./account-identity-migration')
const { modelOf, readRegistry, writeRegistry } = require('../handlers/model-handlers')

// ── registry file I/O (path-based, injectable) ───────────────────────────────
// The path-based readRegistry/writeRegistry are owned by model-handlers.js; the
// fleet:scan handler injects them via deps (both land on the same on-disk schema
// { version, scannedAt, devices } with the same atomic tmp+rename write), and the
// phone-free test injects its own stubs. Either way the sweep never reads/writes
// the registry directly, so there is no private copy to drift out of sync.

// Run one LOCAL module against a phone profile. `deps.localHandlers` /
// `deps.makeDevice` let the test inject recording stubs; production passes the
// real registry from local-modules.js + a real LocalDevice.
async function _runModuleLocal(moduleId, serial, profileId, cfg, deps = {}) {
    const handlers = deps.localHandlers || LOCAL_MODULE_HANDLERS
    const handler = handlers[moduleId]
    if (typeof handler !== 'function') {
        return { success: false, error: `local module '${moduleId}' not available` }
    }
    const device = deps.makeDevice
        ? deps.makeDevice(serial, profileId)
        : new LocalDevice(serial)
    return handler(device, cfg || {})
}

// Read ro.serialno once (one cheap getprop) and register serial -> hwSerial with
// the schedule engine so the busy lock is keyed transport-agnostically: the
// sweep's dashboard serial (often the USB udid) and the engine's row.phone_id
// (often the tailnet ip:port) collapse to the SAME hwSerial, so a scan and a
// scheduled fire on one physical phone mutually exclude. Returns the canonical
// lock key (hwSerial, or the raw serial when ro.serialno can't be read — the
// pre-existing behavior). Best-effort: a dump/getprop failure must not abort the
// sweep, it just falls back to keying on the raw serial.
function _resolveLockKey(serial, deps = {}) {
    try {
        const device = deps.makeDevice ? deps.makeDevice(serial, null) : new LocalDevice(serial)
        const hw = String(device.shell('getprop ro.serialno') || '').trim()
        if (hw) {
            scheduleEngine.registerHwSerial(serial, hw)
            return scheduleEngine.canonicalPhoneKey(serial)
        }
    } catch (_) { /* fall back to raw serial */ }
    return scheduleEngine.canonicalPhoneKey(serial)
}

/**
 * Sweep every profile on `serial`, detect IG accounts, merge into the registry.
 * @param {string} serial
 * @param {{onProgress?: (e:{profileId,name,index,total,accounts})=>void,
 *          profileIds?: string[]}} opts
 *        profileIds: when provided, scan ONLY these profile ids (for targeted
 *        battle-testing on 1-2 profiles instead of the whole fleet).
 * @param {object} deps  injectable dependencies (see _runModuleLocal + below)
 * @returns {Promise<{ok:boolean, profiles?:Array, error?:string}>}
 */
async function scanDeviceAccounts(serial, opts = {}, deps = {}) {
    const onProgress = opts.onProgress || (() => {})
    const log = opts.log || ((m) => console.log('[scan] ' + m))
    const busyPhones = scheduleEngine._busyPhones
    const busyPhoneTimestamps = scheduleEngine._busyPhoneTimestamps

    // Key the busy lock on the transport-agnostic hwSerial so it shares a key with
    // the schedule-engine fire path (which locks on row.phone_id under whatever
    // transport authored the row). `serial` is still used for every registry key
    // and module call below — only the lock uses lockKey.
    const lockKey = _resolveLockKey(serial, deps)

    if (busyPhones.has(lockKey)) {
        return { ok: false, error: 'phone_busy' }
    }

    // Acquire the same per-phone lock the 30s scheduler tick checks, so a scan
    // and a scheduled post can never run on one phone at the same time.
    busyPhones.add(lockKey)
    busyPhoneTimestamps.set(lockKey, Date.now())

    const readReg = deps.readRegistry || readRegistry
    const writeReg = deps.writeRegistry || writeRegistry

    // Tracks whether we still own the busy lock (set true if the engine's 30-min
    // auto-unlock reclaimed it mid-sweep). Read in the finally, so it MUST be
    // function-scoped, not declared inside the try block.
    let _lostLock = false
    try {
        const getProfiles = deps.getDeviceProfiles
        const profRes = await getProfiles(serial)
        if (!profRes || !profRes.success || !Array.isArray(profRes.profiles)) {
            return { ok: false, error: profRes && profRes.error ? profRes.error : 'could not list profiles' }
        }

        // Owner (user 0) never hosts IG accounts. Filter it unconditionally so a
        // full fleet scan can never foreground Owner as a sweep stop (the profile
        // list from invokeProfiles includes user 0 labeled 'Owner').
        let profiles = profRes.profiles.filter(p => String(p.id) !== '0')
        if (Array.isArray(opts.profileIds) && opts.profileIds.length) {
            const want = new Set(opts.profileIds.map(String))
            profiles = profiles.filter(p => want.has(String(p.id)))
        }
        const total = profiles.length

        const registryPath = deps.registryPath
        let registry = readReg(registryPath)
        if (!registry.devices[serial]) {
            registry.devices[serial] = { serial, profiles: {} }
        }

        const out = []
        for (let i = 0; i < profiles.length; i++) {
            // Heartbeat the busy lock so a healthy (but long) sweep never looks
            // 'stuck' to the engine's 30-min auto-unlock — which would otherwise
            // reclaim the phone mid-sweep and fire a scheduled post on top of us
            // (dump contention / wrong-account post). If the lock WAS reclaimed
            // (a genuine >30min hang), stop rather than contend, and don't clobber
            // whoever holds it now.
            if (!busyPhones.has(lockKey)) { _lostLock = true; break }
            busyPhoneTimestamps.set(lockKey, Date.now())
            const p = profiles[i]
            const pid = String(p.id)
            const name = p.name || p.displayName || `Profile ${pid}`
            log(`[${i + 1}/${total}] profile ${pid} (${name}) — airplane ON -> switch -> airplane OFF`)

            // Airplane-wrapped switch (steps 2-4): airplane ON, switch, airplane OFF
            // (network must be back ON before reading IG, which needs connectivity).
            // The SWEEP is the sole airplane owner here: pass reset_ip:false so
            // profile_switch does a NAKED start-user/switch-user with no internal
            // radio toggling. Otherwise profile_switch's reset_ip defaults TRUE and
            // double-cycles the radio inside this bracket — widening the window the
            // tailnet adb link is down (a long dead-link can hang a tailnet phone).
            await _runModuleLocal('airplane_toggle', serial, pid, { action: 'ensure_on' }, deps)
            await _runModuleLocal('profile_switch', serial, pid, {
                action: 'switch',
                target_profile: String(pid),
                complete_setup_wizard: true,
                reset_ip: false,
            }, deps)
            await _runModuleLocal('airplane_toggle', serial, pid, { action: 'ensure_off' }, deps)

            // Re-check the foreground user AFTER airplane OFF — Android can revert the
            // active user when connectivity returns, so verifying only at switch time
            // isn't enough. If we're not on the target NOW, skip the IG read so we
            // never log the wrong profile's accounts onto this row. (Task-0's
            // start-user fix makes the switch land on stopped users to begin with.)
            const chk = await _runModuleLocal('profile_switch', serial, pid, { action: 'list' }, deps)
            const landedUser = chk && chk.data ? String(chk.data.current_user) : '?'
            if (landedUser !== pid) {
                log(`     profile ${pid}: NOT on target after airplane-off (current_user=${landedUser}) — skipping IG read, keeping prior accounts`)
                const prev = registry.devices[serial].profiles[pid] || {
                    profileId: parseInt(pid, 10), name, model: modelOf(name), scannedAt: null, accounts: {},
                }
                prev.switchFailed = true
                registry.devices[serial].profiles[pid] = prev
                const kept = Object.keys(prev.accounts || {})
                out.push({ profileId: pid, accounts: kept, switchFailed: true })
                onProgress({ profileId: pid, name, index: i + 1, total, accounts: kept, switchFailed: true })
                continue
            }
            log(`     profile ${pid}: airplane OFF, on user ${landedUser} verified -> launch IG + check accounts`)
            const det = await _runModuleLocal('detect_accounts', serial, pid, {}, deps)

            // detect_accounts failed (stub / dump timeout / module error): do NOT
            // overwrite this profile's accounts with an empty set. Keep the prior
            // accounts, flag the failure, and move on — same shape as switchFailed.
            if (det?.verification_required || det?.data?.verification_required) {
                const prev = registry.devices[serial].profiles[pid] || {
                    profileId: parseInt(pid, 10), name, model: modelOf(name), scannedAt: null, accounts: {},
                }
                const verification = {
                    type: det.data?.verification_type || 'verification',
                    reason: det.data?.reason || 'verification_required',
                    activeAccount: det.data?.active_account || null,
                    observedAt: new Date().toISOString(),
                }
                prev.verificationRequired = verification
                prev.detectFailed = false
                prev.detectUnverified = false
                registry.devices[serial].profiles[pid] = prev
                writeReg(registryPath, registry)
                const kept = Object.keys(prev.accounts || {})
                const blocked = {
                    profileId: pid,
                    accounts: kept,
                    verificationRequired: true,
                    verificationType: verification.type,
                    reason: verification.reason,
                    activeAccount: verification.activeAccount,
                    preserved: kept.length,
                }
                out.push(blocked)
                onProgress({ profileId: pid, name, index: i + 1, total, ...blocked })
                continue
            }

            if (!det || det.success === false) {
                log(`     profile ${pid}: detect_accounts FAILED (${(det && det.error) || 'no result'}) — skipping IG read, keeping prior accounts`)
                const prev = registry.devices[serial].profiles[pid] || {
                    profileId: parseInt(pid, 10), name, model: modelOf(name), scannedAt: null, accounts: {},
                }
                prev.detectFailed = true
                registry.devices[serial].profiles[pid] = prev
                const kept = Object.keys(prev.accounts || {})
                out.push({ profileId: pid, accounts: kept, detectFailed: true })
                onProgress({ profileId: pid, name, index: i + 1, total, accounts: kept, detectFailed: true })
                continue
            }

            if (det.data?.verified !== true) {
                log(`     profile ${pid}: account switcher was not verified — keeping prior accounts`)
                const prev = registry.devices[serial].profiles[pid] || {
                    profileId: parseInt(pid, 10), name, model: modelOf(name), scannedAt: null, accounts: {},
                }
                prev.detectUnverified = true
                registry.devices[serial].profiles[pid] = prev
                const kept = Object.keys(prev.accounts || {})
                out.push({ profileId: pid, accounts: kept, detectUnverified: true, preserved: kept.length })
                onProgress({ profileId: pid, name, index: i + 1, total, accounts: kept, detectUnverified: true, preserved: kept.length })
                continue
            }

            const handles = (det && det.data && Array.isArray(det.data.accounts))
                ? [...new Set(det.data.accounts.map(h => String(h).toLowerCase()))]
                : []

            let recoveredCount = 0
            const recoverIdentity = deps.recoverPendingIdentityChanges || recoverPendingIdentityChanges
            const canRecover = deps.recoverPendingIdentityChanges
                || (deps.userDataPath && typeof deps.resolveContext === 'function')
            if (canRecover) {
                const recovery = await recoverIdentity({
                    registryPath,
                    userDataPath: deps.userDataPath,
                    serial,
                    userId: pid,
                    platform: 'instagram',
                    verifiedHandles: handles,
                    serialAliases: [serial],
                    resolveAccountRoot: async () => {
                        const ctx = await deps.resolveContext(serial, pid)
                        return ctx?.profileFolder ? path.join(ctx.profileFolder, 'instagram') : null
                    },
                })
                if (recovery?.registry) registry = recovery.registry
                recoveredCount = recovery?.recovered?.length || 0
                if (recovery?.failed?.length) {
                    const prev = registry.devices[serial].profiles[pid] || {
                        profileId: parseInt(pid, 10), name, model: modelOf(name), scannedAt: null, accounts: {},
                    }
                    prev.identityRecoveryFailed = recovery.failed
                    registry.devices[serial].profiles[pid] = prev
                    writeReg(registryPath, registry)
                    const kept = Object.keys(prev.accounts || {})
                    out.push({ profileId: pid, accounts: kept, identityRecoveryFailed: recovery.failed, preserved: kept.length })
                    onProgress({ profileId: pid, name, index: i + 1, total, accounts: kept, identityRecoveryFailed: recovery.failed, preserved: kept.length })
                    continue
                }
            }

            const prevEntry = registry.devices[serial].profiles[pid] || {}
            const prevAccts = (prevEntry.accounts && typeof prevEntry.accounts === 'object') ? prevEntry.accounts : {}

            log(`     profile ${pid}: IGs = [${handles.join(', ')}]  (logging ${handles.length} to fleet)`)

            const previousHandles = Object.keys(prevAccts)
            const nextHandleSet = new Set(handles)
            const added = handles.filter(handle => !prevAccts[handle]).length
            const confirmed = handles.length - added
            const removed = previousHandles.filter(handle => !nextHandleSet.has(handle)).length

            // A verified scan is AUTHORITATIVE for which accounts are logged into
            // this profile: build the account set FRESH from what detect_accounts
            // just saw. Surviving handles carry over their scheduleActive + counts
            // (don't lose schedule state on a still-present account); handles no
            // longer reported are DROPPED — not unioned-forever — so a logged-out
            // account stops haunting the dashboard.
            const nextAccts = {}
            for (const handle of handles) {
                nextAccts[handle] = prevAccts[handle] || {
                    handle,
                    scheduleActive: false,
                    counts: { images: 0, videos: 0, reels: 0, stories: 0, remaining: 0, posted: 0, lowContent: true },
                }
                // Scaffold the on-disk content folders for a newly-found handle only.
                if (!prevAccts[handle] && deps.resolveContext && deps.ensureAccountScaffold) {
                    try {
                        // resolveContext is async in production (returns a Promise)
                        // and sync in tests; await tolerates both.
                        const ctx = await deps.resolveContext(serial, pid)
                        if (ctx && ctx.profileFolder) {
                            deps.ensureAccountScaffold(ctx.profileFolder, 'instagram', handle, deps.contentRoot)
                        }
                    } catch (_) { /* scaffold best-effort */ }
                }
            }
            registry.devices[serial].profiles[pid] = {
                profileId: parseInt(pid, 10),
                name,
                model: modelOf(name),
                scannedAt: new Date().toISOString(),
                switchFailed: false,
                detectEmpty: false,
                detectFailed: false,
                detectUnverified: false,
                accounts: nextAccts,
            }

            // F34: persist incrementally after each profile so a later throw in a
            // multi-profile sweep doesn't discard the profiles already processed.
            writeReg(registryPath, registry)

            const reconciliation = { profileId: pid, accounts: handles, added, confirmed, removed }
            if (recoveredCount) reconciliation.recovered = recoveredCount
            out.push(reconciliation)
            onProgress({ profileId: pid, name, index: i + 1, total, accounts: handles, added, confirmed, removed, ...(recoveredCount ? { recovered: recoveredCount } : {}) })
        }

        registry.scannedAt = new Date().toISOString()
        writeReg(registryPath, registry)

        return { ok: true, profiles: out }
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
    } finally {
        // Only release if we still own it — if auto-unlock reclaimed our lock
        // mid-sweep, it now belongs to a scheduled fire; don't free that fire's lock.
        if (!_lostLock) {
            busyPhones.delete(lockKey)
            busyPhoneTimestamps.delete(lockKey)
        }
    }
}

module.exports = {
    scanDeviceAccounts,
    _runModuleLocal,
    _resolveLockKey,
}
