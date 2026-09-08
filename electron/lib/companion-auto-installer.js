'use strict'
/**
 * Auto-installs / heals the ShadowPhone Companion APK on every connected
 * phone at desktop boot. Migration path for users who upgraded past 2.20.0
 * without re-running the Add Phone wizard (their phones never got the
 * Companion bundled with the desktop).
 *
 * Run pattern: fire-and-forget at app startup, second pass 30s later
 * (catches phones plugged in shortly after boot). All output goes to
 * launcher.log under namespace 'companion-auto-installer'.
 *
 * Failure modes are non-fatal — a failed install just logs + skips so
 * the desktop boots clean.
 */
const path = require('path')
const fs = require('fs')
const {
    acquireModuleRunMutex,
    acquirePhoneLock,
    registerHwSerial,
    canonicalPhoneKey,
    guardedSwitchUser,
    completeRestore,
    hasPendingRestore,
    _busyPhones,
} = require('./schedule-engine')
const { runAdb } = require('./adb-util')

const PKG = 'io.shadowphone.companion'
const COMPANION_HTTP_PORT = 8765
const COMPANION_PARALLEL_LIMIT = 2

function _log(level, message, data) {
    try { require('./launcher-log').write('companion-auto-installer', { level, message, ...data }) }
    catch (_) {}
    const stamped = `[companion-auto-installer] ${message}` + (data ? ' ' + JSON.stringify(data) : '')
    if (level === 'error') console.warn(stamped)
    else console.log(stamped)
}

async function _exec(adbPath, args, timeoutMs = 8000) {
    const result = await runAdb(adbPath, args, timeoutMs)
    const err = result.code === 0 ? null : Object.assign(
        new Error(result.stderr || result.error || `ADB exited with code ${result.code}`),
        { code: result.code },
    )
    return { err, stdout: result.stdout, stderr: result.stderr, code: result.code }
}

// Adapter for guardedSwitchUser/completeRestore: (args, timeoutMs) -> stdout.
function _guardExec(adbPath) {
    return async (args, timeoutMs) => {
        const r = await _exec(adbPath, args, timeoutMs)
        if (r.err) throw r.err
        return r.stdout
    }
}

/**
 * Enumerate ALL ADB devices in 'device' state (both USB and TCP/IP).
 * Auto-installer covers both: USB phones get install + grant, Tailnet-only
 * phones can also get install (shell uid is same over tcp), so AJ's
 * scenario (phone only reachable over Tailnet, Companion missing) is
 * recoverable on first boot of the upgraded desktop.
 */
async function _listAllDevices(adbPath) {
    const r = await _exec(adbPath, ['devices'])
    if (r.err) return []
    const out = []
    for (const line of r.stdout.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 2 || parts[1] !== 'device') continue
        const serial = parts[0]
        if (!serial) continue
        out.push(serial)
    }
    return out
}

/**
 * Check installation + functional status of Companion on user 0.
 *   installed: pm list packages --user 0 finds io.shadowphone.companion
 *   granted:   pm path / dumpsys says WRITE_SECURE_SETTINGS granted for user 0
 *   running:   port-broadcast HTTP service is listening on :8765 (proves the
 *              service started, BootHelperActivity ran, NetworkCallback armed)
 */
async function _checkCompanionStatus(adbPath, udid) {
    const status = { udid, installed: false, granted: false, running: false, enabled: false }

    const pmList = await _exec(adbPath, ['-s', udid, 'shell', 'pm', 'list', 'packages', '--user', '0', PKG])
    status.installed = pmList.stdout.includes(`package:${PKG}`)
    if (!status.installed) return status

    const dump = await _exec(adbPath, ['-s', udid, 'shell', 'dumpsys', 'package', PKG])
    status.granted = /WRITE_SECURE_SETTINGS: granted=true/.test(dump.stdout)
    // enabled=0 → DEFAULT (effectively enabled), enabled=1 → ENABLED.
    // enabled=2 → USER_DISABLED, enabled=3 → DISABLED_USER, enabled=4 → DISABLED_UNTIL_USED.
    // We treat 0/1 as enabled, anything else as disabled.
    const enabledMatch = dump.stdout.match(/User 0:.*?enabled=(\d)/s)
    status.enabled = enabledMatch ? (enabledMatch[1] === '0' || enabledMatch[1] === '1') : true

    // Listening port + enabled state. ss can show a stale socket from a
    // recently-killed process for a few seconds — combine with enabled
    // check to avoid the false-positive AJ saw when pm disable-user was
    // applied but adbd hadn't yet reaped the socket.
    const ss = await _exec(adbPath, ['-s', udid, 'shell', 'ss', '-tln'])
    const portListening = new RegExp(`\\*:${COMPANION_HTTP_PORT}\\s`).test(ss.stdout)
    status.running = portListening && status.enabled

    return status
}

/**
 * Run a full Companion install. Needs user 0 foregrounded so the
 * BootHelperActivity launch can resume (Android refuses to resume an
 * Activity on a non-current user, which silently breaks the Companion's
 * one-time un-stick from stopped state). The Owner swap goes through
 * guardedSwitchUser with this pass's phone-lock ownerToken: the guard
 * registers a persisted restore obligation BEFORE switching, and
 * completeRestore only clears it once the phone verifiably lands back
 * on the original secondary user.
 */
async function _installCompanionOn(adbPath, udid, ownerToken) {
    const provision = require('./phone-provision')
    const execAdb = _guardExec(adbPath)

    const u0 = (await _exec(adbPath, ['-s', udid, 'shell', 'am', 'get-current-user'])).stdout.trim()
    let switched = false
    if (u0 !== '0') {
        // Final busy re-check immediately before the disruptive swap — the
        // status checks above took real time and a run may have started.
        if (_busyNow()) return { ok: false, code: 'SKIPPED_BUSY' }
        const sw = await guardedSwitchUser({ execAdb, serial: udid, targetUser: '0', intent: 'maintenance', ownerToken })
        if (!sw.success) {
            _log('warn', 'owner swap for Companion install refused', { udid, code: sw.code })
            // The switch may have half-landed after registering its obligation.
            if (sw.restoreTo) await completeRestore({ execAdb, serial: udid })
            return { ok: false, code: sw.code }
        }
        _log('info', 'switched to user 0 for Companion install', { udid, restoreTo: sw.restoreTo })
        // 4s settle — owner profile takes a few seconds to become foreground
        await new Promise(r => setTimeout(r, 4000))
        switched = true
    }

    try {
        return await provision.installCompanion(adbPath, udid)
    } finally {
        if (switched) {
            const restored = await completeRestore({ execAdb, serial: udid })
            _log(restored.success ? 'info' : 'error',
                restored.success ? `restored user ${restored.restoredTo}` : `restore unverified (${restored.code}) — obligation kept for next pass`,
                { udid })
        }
    }
}

/**
 * Heal: un-stick the Companion from stopped state + restart the
 * port-broadcast service. Non-disruptive first: start the Companion's own
 * foreground service on user 0 — no user switch, so no Owner exposure at
 * all when it works. Only if :8765 still isn't up, fall back to the
 * guarded Owner swap + BootHelperActivity launch (Android refuses to
 * resume an Activity on a non-current user). Returns true if the
 * post-launch status check shows running=true.
 */
async function _wakeCompanion(adbPath, udid, ownerToken) {
    const execAdb = _guardExec(adbPath)

    await _exec(adbPath, ['-s', udid, 'shell', 'am', 'start-foreground-service', '--user', '0',
        '-n', `${PKG}/.PortBroadcastService`])
    await new Promise(r => setTimeout(r, 3000))
    const softVerify = await _checkCompanionStatus(adbPath, udid)
    if (softVerify.running) return true

    const u0 = (await _exec(adbPath, ['-s', udid, 'shell', 'am', 'get-current-user'])).stdout.trim()
    let switched = false
    if (u0 !== '0') {
        // Final busy re-check immediately before the disruptive swap.
        if (_busyNow()) return false
        const sw = await guardedSwitchUser({ execAdb, serial: udid, targetUser: '0', intent: 'maintenance', ownerToken })
        if (!sw.success) {
            _log('warn', 'owner swap for Companion wake refused', { udid, code: sw.code })
            if (sw.restoreTo) await completeRestore({ execAdb, serial: udid })
            return false
        }
        await new Promise(r => setTimeout(r, 4000))
        switched = true
    }
    try {
        await _exec(adbPath, ['-s', udid, 'shell', 'am', 'start-activity', '--user', '0',
            '-n', `${PKG}/.BootHelperActivity`])
        await new Promise(r => setTimeout(r, 3000))
        const verify = await _checkCompanionStatus(adbPath, udid)
        return verify.running
    } finally {
        if (switched) {
            const restored = await completeRestore({ execAdb, serial: udid })
            if (!restored.success) {
                _log('error', `restore unverified after wake (${restored.code}) — obligation kept for next pass`, { udid })
            }
        }
    }
}

/**
 * Process one phone: check status, decide action, execute.
 */
// Per-phone throttle: only allow the disruptive transient-switch
// revival path once every 5 minutes. Recurring checks for "is alive"
// are cheap and unthrottled.
const _lastTailscaleRevivalAt = new Map()
const TAILSCALE_REVIVAL_THROTTLE_MS = 5 * 60 * 1000

// Busy predicate hoisted to module scope so EVERY switch site — which all funnel
// through _processPhone — can re-check busy immediately before switching, not just
// at pass start. Closes the pass-started-while-idle, ensureForDevice-bypass, and
// fire-and-forget Tailscale-revival holes that let an owner-swap fire mid-run.
let _isBusyRef = null
function _busyNow() { try { return typeof _isBusyRef === 'function' && _isBusyRef() } catch { return false } }

async function _ensureTailscaleAllUsers(adbPath, udid, ownerToken) {
    try {
        const provision = require('./phone-provision')

        // 2.21.13: cheap liveness check first. Only fire the revival
        // (which may transiently switch users) if Tailscale is actually
        // dead AND we haven't tried recently. Throttle keyed by the
        // transport-agnostic hardware id so a phone's USB and tailnet rows
        // share ONE 5-min window instead of doubling the exposure.
        const throttleKey = canonicalPhoneKey(udid)
        const lastTry = _lastTailscaleRevivalAt.get(throttleKey) || 0
        const canDisrupt = Date.now() - lastTry > TAILSCALE_REVIVAL_THROTTLE_MS
        const revival = await provision.ensureTailscaleRunning(adbPath, udid,
            { allowTransientSwitch: canDisrupt, ownerToken })
        if (revival.action && revival.action !== 'already-running') {
            _log('info', `Tailscale revival: ${revival.action}`, { udid, ok: revival.ok })
            if (revival.action.includes('transient-switch')) {
                _lastTailscaleRevivalAt.set(throttleKey, Date.now())
            }
        }

        // Then: per-user provisioning (install + appops + always-on).
        // These are idempotent — running on healthy phone is a no-op.
        const r = await provision.provisionTailscaleAllUsers(adbPath, udid, {
            authKey: process.env.TAILSCALE_AUTH_KEY || ''
        })
        const provisioned = (r.users || []).filter(u => u.installed && u.alwaysOn).length
        // Only log when something interesting happened (not on healthy passes)
        if (provisioned > 0 && !r.ok) {
            _log('info', `Tailscale provisioned on ${provisioned}/${r.users.length} user profiles`, { udid })
        }
        return r
    } catch (e) {
        _log('warn', `Tailscale ensure failed (non-fatal)`, { udid, error: e?.message || String(e) })
        return { ok: false }
    }
}

// _ensureTailscaleAllUsers walks every Android profile and can stall for
// minutes when the tailnet is unreachable — far too heavy to re-run every
// ~3min pass just to re-confirm an already-healthy phone. Tailscale state does
// not churn that fast, so ensure it on its own slow cadence. Keyed by hardware
// id so a phone's USB and tailnet spellings share one timer.
const TAILSCALE_ENSURE_INTERVAL_MS = 30 * 60_000
const _tailscaleProvisioning = new Map()
let _tailscaleStateLoaded = false
const _hwByUdid = new Map()
function _hwKeyFor(udid) { return _hwByUdid.get(udid) || udid }
function _tailscaleStatePath() {
    return path.join(require('electron').app.getPath('userData'), 'companion-provisioning.json')
}
function _profileIds(values) {
    if (!Array.isArray(values) || !values.length || values.some(id => !/^\d+$/.test(String(id)))) return null
    const ids = [...new Set(values.map(String))].sort((a, b) => Number(a) - Number(b))
    return ids.includes('0') ? ids : null
}
function _loadTailscaleState() {
    if (_tailscaleStateLoaded) return
    _tailscaleStateLoaded = true
    try {
        const saved = JSON.parse(fs.readFileSync(_tailscaleStatePath(), 'utf8'))
        if (saved?.version !== 1 || !saved.devices || typeof saved.devices !== 'object') return
        for (const [hardwareId, record] of Object.entries(saved.devices)) {
            const userIds = _profileIds(record?.userIds)
            if (userIds && Number.isFinite(record.ensuredAt)) _tailscaleProvisioning.set(hardwareId, { ensuredAt: record.ensuredAt, userIds })
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') _log('warn', 'saved provisioning state unavailable')
    }
}
function _tailscaleEnsureDue(hardwareId) {
    _loadTailscaleState()
    const last = _tailscaleProvisioning.get(hardwareId)?.ensuredAt
    return !Number.isFinite(last) || last > Date.now() || Date.now() - last >= TAILSCALE_ENSURE_INTERVAL_MS
}
function _saveTailscaleState() {
    try {
        const statePath = _tailscaleStatePath()
        fs.mkdirSync(path.dirname(statePath), { recursive: true })
        fs.writeFileSync(`${statePath}.tmp`, JSON.stringify({ version: 1, devices: Object.fromEntries(_tailscaleProvisioning) }), 'utf8')
        fs.renameSync(`${statePath}.tmp`, statePath)
    } catch (_) { _log('warn', 'provisioning completion could not be saved') }
}
function _markTailscaleEnsured(hardwareId, values) {
    const userIds = _profileIds(values)
    if (!userIds) return
    _loadTailscaleState()
    _tailscaleProvisioning.set(hardwareId, { ensuredAt: Date.now(), userIds })
    _saveTailscaleState()
}

async function _processPhone(adbPath, udid) {
    if (_busyNow()) return { udid, action: 'skipped-busy' }
    const identity = await _exec(adbPath, ['-s', udid, 'shell', 'getprop', 'ro.serialno'], 5000)
    const hardwareId = identity.stdout.trim()
    if (identity.err || !/^[A-Za-z0-9._:-]+$/.test(hardwareId) || /^(null|unknown|undefined)$/i.test(hardwareId)) {
        return { udid, action: 'identity-unverified', ok: false, code: 'HARDWARE_IDENTITY_UNVERIFIED' }
    }

    // ── LOCK-FREE FAST PATH ────────────────────────────────────────────────
    // _checkCompanionStatus is three READ-ONLY adb reads (pm list / dumpsys /
    // ss) — it never needed the per-phone lock. But v3.5.36 took that lock for
    // the WHOLE pass, and the pass also ran _ensureTailscaleAllUsers, which
    // walks every Android profile and stalls for minutes when the tailnet is
    // unreachable. Measured from launcher.log: a HEALTHY phone was locked ~118s
    // out of every ~180s — a 66% duty cycle — so two out of three operator
    // Creates died instantly with "This phone is running another action."
    // Confirm health WITHOUT the lock and only lock when there is real work.
    _hwByUdid.set(udid, hardwareId)
    if (!hasPendingRestore(udid)) {
        let quick = null
        try { quick = await _checkCompanionStatus(adbPath, udid) } catch (_) { quick = null }
        if (quick && quick.installed && quick.granted && quick.running && !_tailscaleEnsureDue(hardwareId)) {
            const profiles = await _exec(adbPath, ['-s', udid, 'shell', 'pm', 'list', 'users'], 5000)
            const userIds = _profileIds([...String(profiles.stdout || '').matchAll(/UserInfo\{(\d+):/g)].map(match => match[1]))
            if (profiles.err || !userIds) return { udid, action: 'profiles-unverified', ok: false }
            if (!_tailscaleEnsureDue(hardwareId) && JSON.stringify(userIds) === JSON.stringify(_tailscaleProvisioning.get(hardwareId)?.userIds)) {
                _log('info', 'status', { udid, ...quick })
                return { udid, action: 'healthy', lockHeld: false }
            }
            // A newly created profile has never received the recorded provisioning.
            _tailscaleProvisioning.delete(hardwareId)
        }
    }

    // The shared per-phone busy lock (busyPhones) is what runs, sweeps,
    // switch-profile, and account creation actually coordinate on — the
    // module-run mutex above is invisible to them. Register both serial
    // spellings so the lock keys transport-agnostically, then take the lock
    // or leave: NEVER wait, NEVER proceed unlocked. This closes the TOCTOU
    // where a run started during the pass's 20-90s of status checks and got
    // yanked to Owner mid-flight.
    const ticket = acquireModuleRunMutex(hardwareId)
    const release = await ticket.wait
    let releasePhoneLock = null
    try {
        registerHwSerial(udid, hardwareId)
        releasePhoneLock = acquirePhoneLock(hardwareId)
        if (!releasePhoneLock) return { udid, action: 'skipped-phone-locked' }
        if (_busyNow()) return { udid, action: 'skipped-busy-after-lock' }
        return await _processPhoneLocked(adbPath, udid, release, releasePhoneLock.ownerToken)
    } finally {
        if (releasePhoneLock) releasePhoneLock()
        release()
    }
}

async function _processPhoneLocked(adbPath, udid, hardwareLease, ownerToken) {
    // A prior maintenance pass switched this phone to Owner and never verified
    // the way back (adb flake / app exit mid-pass). Heal that FIRST — no
    // disruptive work until the phone verifiably sits on its original
    // secondary user again.
    if (hasPendingRestore(udid)) {
        const restored = await completeRestore({ execAdb: _guardExec(adbPath), serial: udid })
        _log(restored.success ? 'info' : 'error',
            restored.success ? `pending owner-restore healed to user ${restored.restoredTo}` : `pending owner-restore still unverified (${restored.code})`,
            { udid })
        if (!restored.success) return { udid, action: 'restore-pending', ok: false }
    }
    let keyboardReady = false
    try {
        const provision = require('./phone-provision')
        const helper = await provision.ensureAdbKeyboard(adbPath, udid, { hardwareLease })
        keyboardReady = helper?.ok === true
        if (!helper.ok) {
            _log('warn', 'ADBKeyboard ensure failed (Unicode input unavailable)', {
                udid,
                code: helper.code,
                rollback_ok: helper.rollback_ok,
            })
        } else if (!['already-compatible', 'cached-compatible'].includes(helper.action)) {
            _log('info', `ADBKeyboard ${helper.action}`, { udid, profiles: helper.profiles })
        }
    } catch (e) {
        _log('warn', 'ADBKeyboard ensure crashed (non-fatal)', { udid, error: e?.message || String(e) })
    }
    if (!keyboardReady) {
        _loadTailscaleState()
        if (_tailscaleProvisioning.delete(_hwKeyFor(udid))) _saveTailscaleState()
    }
    if (_busyNow()) return { udid, action: 'skipped-busy-after-helper-check' }
    let status
    try {
        status = await _checkCompanionStatus(adbPath, udid)
    } catch (e) {
        _log('error', 'status check failed', { udid, error: e?.message || String(e) })
        return { udid, action: 'check-failed', error: e?.message || String(e) }
    }

    // Keep all profile-switching/network mutations inside the hardware lease.
    // Cadence-gated: this walks EVERY Android profile and stalls for minutes
    // when the tailnet is unreachable, so running it on every ~3min pass was
    // what actually held the phone lock for ~118s at a time. Tailscale state
    // does not churn minute to minute — re-ensure on a slow interval instead.
    if (_tailscaleEnsureDue(_hwKeyFor(udid))) {
        const provisioned = await _ensureTailscaleAllUsers(adbPath, udid, ownerToken)
        if (keyboardReady && provisioned?.ok) _markTailscaleEnsured(_hwKeyFor(udid), (provisioned.users || []).map(user => user.userId))
    }

    _log('info', 'status', { udid, ...status })

    if (status.installed && status.granted && status.running) {
        return { udid, action: 'healthy' }
    }

    // Companion was disabled via Settings (or `pm disable-user`) — re-enable
    // it, then fall through to the wake path so the service binds.
    if (status.installed && !status.enabled) {
        _log('info', 'companion disabled — re-enabling', { udid })
        await _exec(adbPath, ['-s', udid, 'shell', 'pm', 'enable', '--user', '0', PKG])
        await new Promise(r => setTimeout(r, 1500))
        await _wakeCompanion(adbPath, udid, ownerToken).catch(() => {})
        return { udid, action: 're-enabled', ok: true }
    }

    if (!status.installed) {
        _log('info', 'installing companion', { udid })
        const r = await _installCompanionOn(adbPath, udid, ownerToken).catch(e => ({ ok: false, error: e?.message || String(e) }))
        _log(r.ok ? 'info' : 'error', 'install result', { udid, ...r })
        return { udid, action: 'installed', ok: r.ok, detail: r }
    }

    if (status.installed && !status.granted) {
        // Need to re-grant the secure-settings permission. Same path as
        // installCompanion handles this idempotently.
        _log('info', 'companion installed but ungranted — re-running install', { udid })
        const r = await _installCompanionOn(adbPath, udid, ownerToken).catch(e => ({ ok: false, error: e?.message || String(e) }))
        _log(r.ok ? 'info' : 'error', 'regrant result', { udid, ...r })
        return { udid, action: 're-granted', ok: r.ok, detail: r }
    }

    // installed + granted + not running → wake it. If wake doesn't take,
    // escalate to full reinstall (covers cases where the APK on disk is
    // bad / corrupted, or where adb shell am can't reach the right user
    // for some reason).
    _log('info', 'companion installed but service not listening — launching Activity', { udid })
    const woke = await _wakeCompanion(adbPath, udid, ownerToken).catch(() => false)
    if (woke) return { udid, action: 'woken', ok: true }

    _log('info', 'wake failed — escalating to full reinstall', { udid })
    const r = await _installCompanionOn(adbPath, udid, ownerToken).catch(e => ({ ok: false, error: e?.message || String(e) }))
    _log(r.ok ? 'info' : 'error', 'escalated reinstall result', { udid, ...r })
    return { udid, action: 'escalated-reinstall', ok: r.ok, detail: r }
}

/**
 * Public API. Pass the resolved adb path + an optional list of pre-known
 * serials (skip enumerating). If no serials given, calls _listUsbDevices.
 */
async function ensureCompanionOnAllDevices(adbPath, opts = {}) {
    if (!adbPath || !fs.existsSync(adbPath)) {
        _log('error', 'adb path missing', { adbPath })
        return { ok: false, processed: 0, error: 'adb not found' }
    }
    const udids = Array.isArray(opts.udids) && opts.udids.length
        ? opts.udids
        : await _listAllDevices(adbPath)

    if (udids.length === 0) {
        _log('info', 'no devices — nothing to check')
        return { ok: true, processed: 0, results: [] }
    }

    _log('info', `processing ${udids.length} device(s)`, { udids })
    // This background maintenance shares the global ADB process pool with
    // mirroring, watchdog checks, and operator actions. Keep most slots free
    // so a fleet-wide companion pass cannot starve foreground work.
    const PARALLEL = Math.min(COMPANION_PARALLEL_LIMIT, udids.length)
    const results = new Array(udids.length)
    let cursor = 0
    const worker = async () => {
        while (true) {
            const idx = cursor++
            if (idx >= udids.length) return
            try { results[idx] = await _processPhone(adbPath, udids[idx]) }
            catch (e) {
                results[idx] = { udid: udids[idx], action: 'crash', error: e?.message || String(e) }
            }
        }
    }
    await Promise.all(Array.from({ length: PARALLEL }, () => worker()))
    return { ok: true, processed: results.length, results }
}

/**
 * Schedule the auto-installer for the lifetime of the desktop app.
 *
 * Three-stage cadence:
 *   1. Initial bursts at 3s + 30s post-boot — catch phones present at
 *      startup AND phones plugged in within ~30s of launch.
 *   2. Forever loop at every 3 min — covers users who plug a phone in
 *      hours into a session, OR reboot their phone while desktop runs.
 *      Healthy phones see a 4-command status check + nothing else
 *      (~250ms total), so the recurring cost is negligible.
 *   3. Re-entrancy guard so a slow install pass doesn't pile up parallel
 *      passes (concurrent installs are safe per the adversarial suite,
 *      but skipping is cheaper).
 *
 * Returns a stop() function for clean shutdown.
 */
function startAutoInstaller(getAdbPath, isBusy) {
    _isBusyRef = isBusy
    let inFlight = false
    let intervalHandle = null
    let stopped = false

    const run = async (tag) => {
        if (stopped) return
        if (inFlight) {
            _log('info', 'pass skipped — previous still running', { tag })
            return
        }
        // Never switch a phone's Android user while an automation run is active — the
        // install path does `am switch-user 0`, which was interrupting in-flight account
        // creation (yanking the phone to the owner profile mid-walk, e.g. at the birthday
        // step). Defer the pass; it retries every 3 min and on the next device event.
        if (typeof isBusy === 'function') {
            try {
                if (isBusy()) {
                    _log('info', 'pass skipped — automation run active (avoid mid-run user switch)', { tag })
                    return
                }
            } catch (_) { /* if the busy check throws, fall through and run */ }
        }
        // Belt to the per-phone lock: if ANY phone's shared busy lock is held
        // (engine fire, fleet scan, insights sweep, switch-profile, account
        // creation), defer the whole pass. The per-phone acquirePhoneLock in
        // _processPhone is the precise gate; this just keeps the pass from
        // churning a fleet that is mid-automation. Checked here (before any
        // lock is taken) because mid-pass we hold our own phone lock.
        if (_busyPhones.size > 0) {
            _log('info', 'pass skipped — a phone busy lock is held (avoid mid-run user switch)', { tag })
            return
        }
        inFlight = true
        try {
            const adb = typeof getAdbPath === 'function' ? getAdbPath() : getAdbPath
            const r = await ensureCompanionOnAllDevices(adb)
            // Only log if something interesting happened — avoids cluttering
            // launcher.log with "healthy" no-ops every 3 minutes forever.
            const interesting = (r.results || []).some(x => x.action && x.action !== 'healthy')
            if (interesting || r.processed === 0 && tag !== 'recurring') {
                _log('info', `pass complete`, { tag, processed: r.processed })
            }
        } catch (e) {
            _log('error', 'pass crashed', { tag, error: e?.message || String(e) })
        } finally {
            inFlight = false
        }
    }

    setTimeout(() => run('initial'), 3_000)         // post-boot
    setTimeout(() => run('catchup'), 30_000)        // catches early plug-ins
    intervalHandle = setInterval(() => run('recurring'), 3 * 60_000)  // every 3min forever

    return {
        stop() { stopped = true; if (intervalHandle) clearInterval(intervalHandle) },
        runNow: (tag = 'manual') => run(tag),
        ensureForDevice: async (udid) => {
            // Single-device fast path — used by launchOne preflight + similar
            // hot paths where we know exactly which phone needs checking.
            try {
                const adb = typeof getAdbPath === 'function' ? getAdbPath() : getAdbPath
                return await ensureCompanionOnAllDevices(adb, { udids: [udid] })
            } catch (e) {
                _log('error', 'ensureForDevice crashed', { udid, error: e?.message })
                return { ok: false, processed: 0, error: e?.message }
            }
        },
    }
}

module.exports = {
    ensureCompanionOnAllDevices,
    startAutoInstaller,
    _checkCompanionStatus,  // exported for testing
    _processPhone,
}
