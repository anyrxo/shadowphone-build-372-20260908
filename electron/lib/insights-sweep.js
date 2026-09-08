// desktop/lib/insights-sweep.js
/**
 * Insights fetch sweep for the Models Dashboard.
 *
 * Sibling to models-dashboard-scan.js. Where the SCAN sweep discovers WHICH IG
 * accounts are logged into each Android profile, this sweep walks the accounts
 * the scan already found and pulls per-account IG Professional Dashboard insights
 * (account_insights LOCAL module) into the time-series store (insights-store.js).
 *
 * For one phone it walks every Android profile and, per profile, runs the same
 * airplane-wrapped profile switch the scan uses (airplane ON -> profile_switch
 * switch -> airplane OFF -> re-verify current_user), then for EACH known IG
 * account on that profile:
 *   ig_account_switch {target_username} (best-effort) -> account_insights ->
 *   business?  insights-store.appendSnapshot(...) + stamp isBusiness=true/statsAt
 *   personal?  flag account.isBusiness=false and skip the professional store.
 *
 * The whole sweep holds the schedule-engine per-phone busy lock so it can never
 * overlap a scheduled post (or a scan) on the same phone. If the phone is already
 * busy it refuses with {ok:false,error:'phone_busy'}.
 *
 * Depends on the same Task 0 fix in modules/profile_switch.js as the scan: a
 * stopped GrapheneOS user must start-user before switch-user, else the verify
 * poll here falsely rejects the (eventually-foregrounded) target.
 */

'use strict'

const path = require('path')
const scheduleEngine = require('./schedule-engine')
const insightsStore = require('./insights-store')
// Reuse the LOCAL-module invoker the scan sweep already defines (same
// deps.localHandlers / deps.makeDevice injection points) plus the path-based
// registry read/write helpers from model-handlers, so both sweeps land on the
// exact same on-disk schema + atomic-write behaviour.
const { _runModuleLocal, _resolveLockKey } = require('./models-dashboard-scan')
const { readRegistry: _readRegistry, writeRegistry: _writeRegistry, modelOf } = require('../handlers/model-handlers')

/**
 * Fetch IG insights for every known account on `serial`, one Android profile at a
 * time, and append each result to the time-series store.
 *
 * @param {string} serial
 * @param {{ onProgress?: (e:{profileId,name,index,total,account,isBusiness?,note?,switchFailed?})=>void,
 *           profileIds?: string[], log?: (m:string)=>void }} opts
 *        profileIds: when provided, sweep ONLY these profile ids.
 *        onProgress: streams ONE event per (profile,account) — plus one per
 *                    skipped/switch-failed profile.
 * @param {object} deps  injectable dependencies:
 *        registryPath        path to fleet-registry.json (required)
 *        userDataPath        where insights-store writes its series (defaults to
 *                            dirname(registryPath) — fleet-registry.json lives in
 *                            the userData dir, so the insights/ subdir lands beside it)
 *        getDeviceProfiles   (serial) -> {success, profiles:[{id,name}]}
 *        localHandlers       LOCAL_MODULE_HANDLERS override (test stub)
 *        makeDevice          (serial,profileId) -> LocalDevice override (test stub)
 *        readRegistry        path-based registry reader override
 *        writeRegistry       path-based registry writer override
 *        appendSnapshot      (userDataPath,account,full,ts) override (test spy)
 *        now                 () -> epoch-ms injector (defaults to Date.now)
 * @returns {Promise<{ok:boolean, profiles?:Array, error?:string}>}
 */
async function fetchDeviceInsights(serial, opts = {}, deps = {}) {
    const onProgress = opts.onProgress || (() => {})
    const log = opts.log || ((m) => console.log('[insights] ' + m))
    const busyPhones = scheduleEngine._busyPhones
    const busyPhoneTimestamps = scheduleEngine._busyPhoneTimestamps

    // Key the busy lock on the transport-agnostic hwSerial (shared with the scan
    // sweep + the schedule-engine fire path) so one physical phone can't be swept
    // and fired at the same time across transports. `serial` still keys every
    // registry/module op below; only the lock uses lockKey.
    const lockKey = _resolveLockKey(serial, deps)

    if (busyPhones.has(lockKey)) {
        return { ok: false, error: 'phone_busy' }
    }

    // Acquire the same per-phone lock the 30s scheduler tick checks, so an
    // insights fetch and a scheduled post can never run on one phone at once.
    busyPhones.add(lockKey)
    busyPhoneTimestamps.set(lockKey, Date.now())

    const readRegistry = deps.readRegistry || _readRegistry
    const writeRegistry = deps.writeRegistry || _writeRegistry
    const appendSnapshot = deps.appendSnapshot || insightsStore.appendSnapshot
    const now = deps.now || Date.now
    const wait = deps.wait || ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
    const registryPath = deps.registryPath
    // insights-store keys its series off userDataPath/insights/. The registry
    // file lives in the userData dir, so default the store there too.
    const userDataPath = deps.userDataPath || (registryPath ? path.dirname(registryPath) : '')

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

        // Owner (user 0) never hosts IG accounts — hard guarantee (not just the
        // 0-accounts heuristic below) that the sweep never switches INTO Owner.
        let profiles = profRes.profiles.filter(p => String(p.id) !== '0')
        if (Array.isArray(opts.profileIds) && opts.profileIds.length) {
            const want = new Set(opts.profileIds.map(String))
            profiles = profiles.filter(p => want.has(String(p.id)))
        }
        const total = profiles.length

        const registry = readRegistry(registryPath)
        if (!registry.devices[serial]) {
            registry.devices[serial] = { serial, profiles: {} }
        }

        const out = []
        for (let i = 0; i < profiles.length; i++) {
            // Heartbeat the busy lock so a healthy (but long) sweep never looks
            // 'stuck' to the engine's 30-min auto-unlock — which would otherwise
            // reclaim the phone mid-sweep and fire a scheduled post on top of us.
            // If the lock WAS reclaimed (a genuine >30min hang), stop rather than
            // contend, and don't clobber whoever holds it now.
            if (!busyPhones.has(lockKey)) { _lostLock = true; break }
            busyPhoneTimestamps.set(lockKey, Date.now())
            const p = profiles[i]
            const pid = String(p.id)
            const name = p.name || p.displayName || `Profile ${pid}`

            // Which IG accounts does the scan know live on this profile? Insights
            // only runs against accounts already discovered — we never log into
            // anything here, just read existing sessions.
            const profEntry = registry.devices[serial].profiles[pid] || {
                profileId: parseInt(pid, 10), name, model: modelOf(name), scannedAt: null, accounts: {},
            }
            if (!profEntry.accounts || typeof profEntry.accounts !== 'object') profEntry.accounts = {}
            registry.devices[serial].profiles[pid] = profEntry
            const handles = Object.keys(profEntry.accounts)

            if (!handles.length) {
                log(`[${i + 1}/${total}] profile ${pid} (${name}) — 0 accounts — skipping switch`)
                out.push({ profileId: pid, accounts: [], skipped: 'no-accounts' })
                onProgress({ profileId: pid, name, index: i + 1, total, account: null, note: 'no accounts' })
                continue
            }

            log(`[${i + 1}/${total}] profile ${pid} (${name}) — ${handles.length} account(s) — airplane ON -> switch -> airplane OFF`)

            // Airplane-wrapped switch (network must be back ON before reading IG).
            // The SWEEP is the sole airplane owner: reset_ip:false makes
            // profile_switch do a NAKED start-user/switch-user with no internal
            // radio toggling — without it profile_switch double-cycles the radio
            // inside this bracket, widening the tailnet adb dead-link window.
            await _runModuleLocal('airplane_toggle', serial, pid, { action: 'ensure_on' }, deps)
            await _runModuleLocal('profile_switch', serial, pid, {
                action: 'switch',
                target_profile: String(pid),
                complete_setup_wizard: true,
                reset_ip: false,
            }, deps)
            await _runModuleLocal('airplane_toggle', serial, pid, { action: 'ensure_off' }, deps)

            // Re-verify the foreground user AFTER airplane OFF (Android can revert
            // the active user when connectivity returns). If we're not on the
            // target NOW, skip the IG reads so we never scrape the wrong profile's
            // accounts onto these rows.
            const chk = await _runModuleLocal('profile_switch', serial, pid, { action: 'list' }, deps)
            const landedUser = chk && chk.data ? String(chk.data.current_user) : '?'
            if (landedUser !== pid) {
                log(`     profile ${pid}: NOT on target after airplane-off (current_user=${landedUser}) — skipping insights, keeping prior stats`)
                profEntry.switchFailed = true
                out.push({ profileId: pid, accounts: handles, switchFailed: true })
                onProgress({ profileId: pid, name, index: i + 1, total, account: null, switchFailed: true })
                continue
            }
            profEntry.switchFailed = false
            log(`     profile ${pid}: airplane OFF, on user ${landedUser} verified -> fetch insights for [${handles.join(', ')}]`)

            const accountResults = []
            for (const handle of handles) {
                const acct = profEntry.accounts[handle]
                acct.handle = acct.handle || handle

                // Surface the target IG account via the in-app account switcher,
                // then VERIFY: account_insights checks the foreground @handle against
                // expect_account and refuses to scrape a different account onto this
                // handle's row (a silent switch failure once stored two accounts'
                // stats identically). One retry of the switch on mismatch.
                await _runModuleLocal('ig_account_switch', serial, pid, { target_username: handle }, deps)

                const insightConfig = { expect_account: handle }
                if (Array.isArray(opts.tabs)) insightConfig.tabs = opts.tabs
                let res = await _runModuleLocal('account_insights', serial, pid, insightConfig, deps)
                let data = (res && res.data) || {}
                if (data.account_mismatch) {
                    log(`     ${handle}: foreground was @${data.foreground} — retrying account switch`)
                    await _runModuleLocal('ig_account_switch', serial, pid, { target_username: handle, force: true }, deps)
                    res = await _runModuleLocal('account_insights', serial, pid, insightConfig, deps)
                    data = (res && res.data) || {}
                }
                // A successful account switch can still land on Instagram's
                // partially rendered profile shell for a few seconds. Do not
                // advance to another account on that transient screen. Wait,
                // cold-relaunch through the switch helper (which also dismisses
                // late popups), and re-confirm the exact same handle twice.
                for (const delayMs of [1500, 3000]) {
                    if (!(res?.success && data.insights_unavailable && data.reason === 'profile_not_ready')) break
                    log(`     ${handle}: profile still loading — waiting before same-account recheck`)
                    await wait(delayMs)
                    await _runModuleLocal('ig_account_switch', serial, pid, { target_username: handle, force: true }, deps)
                    res = await _runModuleLocal('account_insights', serial, pid, insightConfig, deps)
                    data = (res && res.data) || {}
                }
                const personalFollowers = data.profileFollowers
                let professionalEnabled = false
                let conversionError = null
                if (
                    res?.success
                    && !data.account_mismatch
                    && !data.verification_required
                    && !data.insights_unavailable
                    && data.is_business === false
                    && opts.ensureProfessional !== false
                    && typeof deps.ensureProfessional === 'function'
                ) {
                    log(`     ${handle}: personal account confirmed — enabling Professional Dashboard before continuing`)
                    let converted
                    try {
                        converted = await deps.ensureProfessional({ serial, userId: pid, account: handle })
                    } catch (error) {
                        converted = { success: false, error: error?.message || String(error) }
                    }
                    if (!converted?.success) {
                        conversionError = converted?.error || 'Professional conversion failed.'
                    } else {
                        // edit_profile must not be treated as success on its own.
                        // Re-scrape the same foreground handle and require the
                        // Professional Dashboard to be visible before advancing.
                        res = await _runModuleLocal('account_insights', serial, pid, insightConfig, deps)
                        data = (res && res.data) || {}
                        if (!res?.success) {
                            conversionError = res?.error || 'Professional state could not be confirmed after conversion.'
                        } else if (
                            !data.account_mismatch
                            && !data.verification_required
                            && !data.insights_unavailable
                            && data.is_business === false
                        ) {
                            conversionError = 'Professional Dashboard was not confirmed after conversion.'
                        } else if (data.is_business === true) {
                            professionalEnabled = true
                        }
                    }
                }
                const ts = now()

                if (data.account_mismatch) {
                    // Still on the wrong account after a retry — DON'T store anything
                    // under this handle (better a gap than wrong-attributed data).
                    // statsAt is intentionally NOT updated so the dashboard freshness
                    // badge reflects the last real snapshot, not this failed attempt.
                    acct.statsError = 'identity_mismatch'
                    log(`     ${handle}: SKIPPED — couldn't switch to it (foreground @${data.foreground})`)
                    accountResults.push({ account: handle, skipped: true, status: 'identity_mismatch', reason: 'ig_switch_failed', foreground: data.foreground })
                    onProgress({ profileId: pid, name, index: i + 1, total, account: handle, note: 'switch failed, skipped' })
                } else if (data.verification_required) {
                    acct.statsError = 'verification_required'
                    log(`     ${handle}: SKIPPED â€” Instagram ${data.verification_type || 'verification'} blocks profile access`)
                    accountResults.push({
                        account: handle,
                        skipped: true,
                        status: 'verification_required',
                        reason: data.reason || 'verification_required',
                        verificationType: data.verification_type || null,
                    })
                    onProgress({ profileId: pid, name, index: i + 1, total, account: handle, note: 'verification required, skipped' })
                } else if (conversionError) {
                    acct.isBusiness = false
                    acct.statsAt = ts
                    acct.statsError = 'professional_conversion_failed'
                    if (personalFollowers !== undefined && personalFollowers !== null) acct.followers = personalFollowers
                    log(`     ${handle}: STOPPED — Professional Dashboard conversion was not confirmed (${conversionError})`)
                    accountResults.push({
                        account: handle,
                        isBusiness: false,
                        status: 'professional_conversion_failed',
                        reason: conversionError,
                        followers: personalFollowers ?? null,
                    })
                    onProgress({ profileId: pid, name, index: i + 1, total, account: handle, isBusiness: false, note: 'professional conversion failed' })
                } else if (!res?.success) {
                    acct.statsError = 'insights_failed'
                    log(`     ${handle}: SKIPPED — insights module failed (${res?.error || 'unknown error'})`)
                    accountResults.push({ account: handle, skipped: true, status: 'failed', reason: res?.error || 'insights_failed' })
                    onProgress({ profileId: pid, name, index: i + 1, total, account: handle, note: 'insights failed, skipped' })
                } else if (data.insights_unavailable) {
                    // Drilled in but not on a recognized insights screen — skip, don't store.
                    // statsAt intentionally NOT updated; see ig_switch_failed comment above.
                    acct.statsError = 'nav_unrecognized'
                    log(`     ${handle}: SKIPPED — no insights screen (${data.reason})`)
                    accountResults.push({ account: handle, skipped: true, status: 'failed', reason: 'nav_unrecognized' })
                    onProgress({ profileId: pid, name, index: i + 1, total, account: handle, note: 'no insights screen' })
                } else if (data.is_business === false) {
                    // Personal account: no rich metrics exist. Flag it on the
                    // registry, but don't append a Professional Dashboard snapshot.
                    acct.isBusiness = false
                    acct.statsAt = ts
                    acct.statsError = null
                    const followers = data.profileFollowers
                    if (followers !== undefined && followers !== null) acct.followers = followers
                    log(`     ${handle}: personal account, skipped rich insights`)
                    accountResults.push({ account: handle, isBusiness: false, status: 'not_professional', followers: followers ?? null })
                    onProgress({ profileId: pid, name, index: i + 1, total, account: handle, isBusiness: false, note: 'personal, skipped' })
                } else {
                    acct.isBusiness = true
                    acct.statsAt = ts
                    acct.statsError = null
                    const followers = data.audience?.followers ?? data.profileFollowers
                    if (followers !== undefined && followers !== null) acct.followers = followers
                    appendSnapshot(userDataPath, handle, data, ts)
                    log(`     ${handle}: business insights stored (followers=${data.audience?.followers ?? '?'})`)
                    accountResults.push({ account: handle, isBusiness: true, status: 'success', followers: followers ?? null, professionalEnabled })
                    onProgress({ profileId: pid, name, index: i + 1, total, account: handle, isBusiness: true })
                }
            }

            profEntry.statsAt = now()
            out.push({ profileId: pid, accounts: handles, results: accountResults })
            // Persist incrementally so partial progress survives a mid-sweep throw.
            writeRegistry(registryPath, registry)
        }

        writeRegistry(registryPath, registry)

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
    fetchDeviceInsights,
}
