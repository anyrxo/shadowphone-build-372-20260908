/**
 * device-watchdog.js — autonomous recovery of mirrored phones (2.19.14).
 *
 * Goal: a phone can power off, reboot, sleep, lose WiFi, swap networks,
 * jiggle USB, suffer Tailscale relay drops — and ShadowPhone notices
 * the moment it's reachable again and silently restores the mirror.
 *
 * Behaviours:
 *   1. In-session intents — startup intentionally does NOT auto-restore
 *      intents (Anyro 2026-06-07). Mirrors open ONLY when the user clicks
 *      one; the watchdog then recovers a mirror that dies DURING the
 *      session. Any intent file from an older installed build is unlinked
 *      on start so it can never resurrect a mirror.
 *   2. Exponential backoff — initial reconnect every ~2s, then 8s, then
 *      30s, then 2min. NEVER fully gives up; a phone returning from being
 *      off overnight reconnects on the next slow tick.
 *   3. Tailscale-aware — reads `tailscale status --json` to skip wasteful
 *      adb-connect attempts when the peer is genuinely offline. The
 *      moment Tailscale flips the peer to Online, we accelerate the
 *      reconnect cadence back to fast.
 *   4. ADB daemon recovery — if `adb devices` returns NO devices while
 *      we have intents pending, restart adb-server (kills + spawns).
 *   5. Active keepalive — every 60s, ping each currently-running mirror
 *      over adb so Tailscale relay NAT doesn't reap the idle TCP socket.
 *   6. Detailed telemetry — every state transition (online -> offline,
 *      offline -> online, reconnect attempted, scrcpy relaunched) goes
 *      to launcher.log + the toolbar live-log so the user can see what
 *      the watchdog is doing in real time.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { runAdb } = require('./adb-util')

const FAST_TICK_MS = 2000
const SLOW_TICK_MS = 30000
const TICK_MS = 5000                 // baseline tick — picks fast/slow per-intent
const KEEPALIVE_INTERVAL_MS = 60000

const RELAUNCH_MIN_GAP_MS = 15 * 1000   // 15s between consecutive relaunch attempts
const CLEAN_CLOSE_GRACE_MS = 5 * 1000   // don't relaunch right after a user-initiated clean close

// Flap guard: a phone whose transport bounces (USB↔tailnet) makes scrcpy die
// within seconds. Relaunching every RELAUNCH_MIN_GAP forever churns the mirror
// open/closed (the "keeps spawning and closing" bug). After FLAP_THRESHOLD quick
// deaths, pause auto-relaunch for FLAP_COOLDOWN_MS; a mirror that survives
// FLAP_STABLE_MS clears the flap state so a later genuine disconnect recovers.
// Fix-2: a "quick death" is now detected via the relaunchedUnhealthy flag (a
// relaunch that dies before the next tick observes it running) rather than a
// fixed time window, so detection no longer breaks on 60s-tick large fleets.
const FLAP_THRESHOLD = 3                 // consecutive quick deaths before backing off
const FLAP_COOLDOWN_MS = 5 * 60 * 1000   // pause auto-relaunch this long when flapping
const FLAP_STABLE_MS = 90 * 1000         // mirror up this long → recovered, reset flap state

// Escalation: after this many relaunch attempts with the mirror never once
// observed running (~3 flap-cooldown cycles, since relaunchAttempts only resets
// on a healthy observation), surface ONE operator-facing error instead of
// silently churning a dead phone. Wired through gaveUpBroadcasted so it fires once.
const GIVE_UP_RELAUNCH_THRESHOLD = 9

// Device-presence flap guard — DISTINCT from the mirror-flap above. A loose/failing
// USB cable or port makes the phone drop off adb and reconnect every ~15-30s; each
// reconnect would otherwise relaunch the mirror (a spawn/die storm — Anyro's
// "keeps opening and closing" report), even when each mirror briefly looks healthy
// so the mirror-quick-death counter keeps resetting. Count reconnects in a sliding
// window; past the threshold, reuse flapCooldownUntil to pause auto-relaunch and
// tell the operator the connection is unstable.
const DEVICE_FLAP_WINDOW_MS = 3 * 60 * 1000   // sliding window for counting reconnects
const DEVICE_FLAP_THRESHOLD = 3               // reconnects within the window → unstable cable
const ADB_TIMEOUT_MS = 4500
// Enumeration gets a more generous budget than the general ADB timeout: a
// momentarily-busy local adb-server shouldn't be misread as dead and trigger a
// transport-killing restart (Fix-1).
const ADB_ENUM_TIMEOUT_MS = 8000
const TAILSCALE_TIMEOUT_MS = 4500

const SHELL_PROBE_TIMEOUT_MS = 2500
const SHELL_PROBE_CADENCE_MS = 30_000
const ZOMBIE_OFFLINE_THRESHOLD_MS = 15_000
const ZOMBIE_REFUSED_THRESHOLD = 3
const COMPANION_DISCOVERY_TIMEOUT_MS = 2500

const { discoverAdbPort, probeCompanion, scanForAdbPort } = require('./companion-discovery')
// H3: shared identity rule so intents collapse the same physical phone across
// transports exactly like device enumeration does.
const { sameDevice } = require('./device-identity')

const PHASE_FAST  = 'fast'   // 0-30s after going offline
const PHASE_SLOW  = 'slow'   // 30s-5min
const PHASE_SLEEP = 'sleep'  // 5min+ — phone is probably off / asleep, check every 2min

let _intervalHandle = null
let _keepaliveHandle = null
let _adbServerLastRestart = 0
// Fix-1: only restart adb-server after >=2 consecutive failed enumerations so a
// lone transient `adb devices` timeout doesn't tear down every live transport.
let _adbProbeFailStreak = 0
const ADB_PROBE_FAIL_THRESHOLD = 2
// v3.6.0 introduced a busy-defer (never kill adb-server while a phone holds the
// busy lock). But a GENUINELY wedged adb-server (queue saturated / circuit open)
// during "busy" is a deadlock: the busy holder is itself stuck on that wedged
// transport and can never finish to clear the lock, so the defer would loop
// forever (observed live: reconciler floods the queue → circuit open → enumerate
// fails → restart deferred every tick, no recovery). Bound the defer: after this
// many consecutive deferrals the busy holder is provably not making progress, so
// restart anyway to un-wedge — a dead transport helps no run.
let _restartDeferStreak = 0
const RESTART_DEFER_MAX = 4
let _ctx = null
let _userDataDir = null
// H3: last merged device list, refreshed each tick. markIntent (sync) reads it
// to collapse same-phone intents; an empty snapshot just disables the merge
// (pre-fix per-serial behavior), never misroutes.
let _lastDevices = []
const intents = new Map()

function _deviceSnapshot() {
    return Array.isArray(_lastDevices) ? _lastDevices : []
}
// intent shape:
// {
//   serial,
//   addedAt,
//   lastSeenOnlineAt,
//   lastReconnectAt,
//   reconnectAttempts,
//   lastRelaunchAt,
//   relaunchAttempts,
//   currentPhase,            // 'fast' | 'slow' | 'sleep'
//   currentState,            // 'device' | 'offline' | 'missing' | 'unauthorized' | null
//   stateChangeAt,
//   gaveUpBroadcasted,
//   downtimeStartedAt,
// }

function isTailnetSerial(s) {
    return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(String(s || ''))
}

async function _exec(adbPath, args, timeoutMs = ADB_TIMEOUT_MS) {
    const result = await runAdb(adbPath, args, timeoutMs)
    const err = result.code === 0 ? null : Object.assign(
        new Error(result.stderr || result.error || `ADB exited with code ${result.code}`),
        {
            code: result.code,
            killed: result.timedOut === true,
            signal: result.timedOut ? 'SIGKILL' : null,
        },
    )
    return { err, stdout: result.stdout, stderr: result.stderr, code: result.code }
}

async function _enumerateAdbState() {
    const adb = _ctx?.getADBPath?.()
    if (!adb) return { ok: false, states: new Map(), timedOut: false }
    const { err, stdout } = await _exec(adb, ['devices'], ADB_ENUM_TIMEOUT_MS)
    if (err) {
        // Fix-1: a killed-by-timeout exec (execFile sends SIGTERM on `timeout`)
        // means the local adb-server was merely busy/slow, NOT dead — treat it
        // as a soft failure that just retries next tick. A genuine spawn/exit
        // error (binary missing, server crashed) is a hard failure.
        const timedOut = !!err.killed || err.signal === 'SIGTERM'
        return { ok: false, states: new Map(), timedOut }
    }
    const lines = String(stdout).split('\n').slice(1)
    const out = new Map()
    for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        const [serial, state] = t.split(/\s+/)
        if (serial && state) out.set(serial, state)
    }
    return { ok: true, states: out, timedOut: false }
}

// Is it worth spending an `adb connect 100.x:*` right now? Daemon-level, TTL-
// cached and single-flight (lib/tailscale-status). Fails OPEN on any error so a
// gate problem can never strand a phone. Lazy-required: tailscale-status pulls
// only node builtins, but keeping it lazy also keeps the test seam trivial.
let _tailnetGateImpl = null // test seam (see _setTailnetGateForTest)
async function _tailnetRoutable() {
    try {
        const impl = _tailnetGateImpl || require('./tailscale-status').isTailnetRoutable
        const verdict = await impl()
        return !(verdict && verdict.ok === false)
    } catch (_) { return true }
}

// SCOPE of the gate above. isTailnetSerial() matches ANY `ip:port` serial, but
// the gate's Tier-0 predicate needs a 100.64/10 (CGNAT) address on this PC — on
// a machine without Tailscale (the default for most SaaS users) it always denies.
// Applying it to a plain LAN-wireless serial (192.168.x:5555, or a rotated
// ephemeral port from companion-discovery) would therefore refuse to reconnect
// those phones forever. Only a CGNAT target actually needs Tailscale up; every
// other ip:port serial keeps the ungated pre-gate path.
function _isCgnatTarget(serial) {
    try {
        const { TAILNET_CGNAT_RE } = require('./tailscale-status')
        return TAILNET_CGNAT_RE.test(String(serial || '').split(':')[0])
    } catch (_) { return false } // require failure => ungated (today's behavior)
}

async function _tailnetRoutableFor(serial) {
    if (!_isCgnatTarget(serial)) return true
    return _tailnetRoutable()
}

async function _tailscalePeerOnlineMap() {
    const bin = _ctx?.getTailscaleBinary?.()
    if (!bin) return null
    // Re-based on the shared TTL cache: this used to spawn its own tailscale.exe
    // every TICK_MS (5s) while any mirror intent existed — ~17k processes/day for
    // data the reconciler gate is already collecting.
    try {
        const { getTailscaleStatusCached } = require('./tailscale-status')
        const status = await getTailscaleStatusCached({ binary: bin, timeoutMs: TAILSCALE_TIMEOUT_MS })
        if (!status || !Array.isArray(status.peers)) return null
        const m = new Map()
        for (const p of status.peers) {
            if (p && p.ip) m.set(String(p.ip), p.online === true)
        }
        return m
    } catch (_) { return null }
}

function _broadcast(level, message, serial) {
    try {
        const mt = require('./mirror-toolbar')
        if (typeof mt.broadcastLiveLog === 'function') {
            mt.broadcastLiveLog({
                t: new Date().toISOString(),
                event: 'device-watchdog',
                level,
                message,
                serial,
            })
        }
    } catch (_) {}
    try {
        require('./launcher-log').write('device-watchdog', { level, message, serial })
    } catch (_) {}
}

// Fix-5: intent persistence was removed (Anyro 2026-06-07: startup does NOT
// auto-restore intents — mirrors open only on user click). _intentsFile is kept
// solely so start() can unlink any intent file written by older installed builds.
function _intentsFile() {
    return _userDataDir ? path.join(_userDataDir, 'watchdog-intents.json') : null
}

function _freshIntentEntry(serial) {
    return {
        serial,
        addedAt: Date.now(),
        lastSeenOnlineAt: 0,
        lastReconnectAt: 0,
        reconnectAttempts: 0,
        lastRelaunchAt: 0,
        relaunchAttempts: 0,
        quickDeathCount: 0,
        flapCooldownUntil: 0,
        // Fix-2: true while a (re)launched mirror has not yet been observed
        // running. Makes quick-death detection cadence-independent (a mirror
        // that dies before the next tick sees it running is a quick death at
        // any tick interval) instead of relying on a fixed time window.
        relaunchedUnhealthy: false,
        mirrorUpSince: 0,
        currentPhase: PHASE_FAST,
        currentState: null,
        stateChangeAt: Date.now(),
        gaveUpBroadcasted: false,
        downtimeStartedAt: 0,
        consecutiveRefused: 0,
        lastShellProbeAt: 0,
        rediscoverAttempts: 0,
    }
}

function _phaseFor(entry, now) {
    if (!entry.downtimeStartedAt) return PHASE_FAST
    const offlineMs = now - entry.downtimeStartedAt
    if (offlineMs < 30_000) return PHASE_FAST
    if (offlineMs < 5 * 60_000) return PHASE_SLOW
    return PHASE_SLEEP
}

function _reconnectIntervalFor(phase) {
    switch (phase) {
        case PHASE_FAST: return 2000
        case PHASE_SLOW: return 8000
        case PHASE_SLEEP: return 120_000  // 2 minutes when phone has been off for >5min
        default: return 10000
    }
}

// H3: collapse a USB udid + a tailnet ip:port for the SAME physical phone to
// ONE intent so two launch surfaces don't drive competing relaunch loops on one
// device. The canonical intent key is the transport scrcpy actually connects on
// (`adbTarget`) — that keeps the adb-state lookup (`states.get(serial)`) and the
// keepalive/shell-probe (M1) pointed at the live socket, not the bookkeeping
// udid. `adbTarget` is passed by launchScrcpyForSerial; absent (legacy callers)
// it falls back to the serial itself, preserving old behavior.
function _findSameDeviceIntentKey(targetSerial) {
    const devices = _deviceSnapshot()
    if (!devices.length) return null
    for (const key of intents.keys()) {
        if (key === targetSerial) continue
        if (sameDevice(key, targetSerial, devices)) return key
    }
    return null
}

// H3: collapse any same-phone intent pairs to one entry. Prefer the tailnet
// (ip:port) key so M1's keepalive/probe target the socket scrcpy streams on.
// The surviving entry keeps the longer downtime/relaunch history so the flap
// guard isn't reset by the merge. Runs each tick; no-op when nothing to merge.
function _reconcileDuplicateIntents() {
    const devices = _deviceSnapshot()
    if (devices.length < 1 || intents.size < 2) return
    const keys = Array.from(intents.keys())
    for (let i = 0; i < keys.length; i++) {
        const a = keys[i]
        if (!intents.has(a)) continue
        for (let j = i + 1; j < keys.length; j++) {
            const b = keys[j]
            if (!intents.has(b)) continue
            if (!sameDevice(a, b, devices)) continue
            // Prefer the entry whose scrcpy transport we already know
            // (adbTarget set); else the tailnet-keyed one; else `a`.
            const ea = intents.get(a)
            const eb = intents.get(b)
            let keepKey = a
            if (ea.adbTarget && !eb.adbTarget) keepKey = a
            else if (eb.adbTarget && !ea.adbTarget) keepKey = b
            else if (isTailnetSerial(b) && !isTailnetSerial(a)) keepKey = b
            const dropKey = keepKey === a ? b : a
            const keep = intents.get(keepKey)
            const drop = intents.get(dropKey)
            keep.adbTarget = keep.adbTarget
                || (isTailnetSerial(keepKey) ? keepKey : null)
                || drop.adbTarget
                || (isTailnetSerial(dropKey) ? dropKey : null)
            intents.delete(dropKey)
            console.log(`[device-watchdog] reconciled duplicate intent ${dropKey} → ${keepKey} (same phone)`)
            // If the outer key `a` was the one dropped, abandon this inner pass —
            // intents.get(a) is now undefined and a further sameDevice(a, b2) match
            // would deref undefined (ea.adbTarget) and throw. Consistent with the
            // outer loop's own has(a) guard.
            if (dropKey === a) break
        }
    }
}

function markIntent(serial, adbTarget) {
    if (!serial) return
    // Canonical key = the transport scrcpy streams on (tailnet ip:port when a
    // USB udid was routed over tailnet); fall back to the serial for plain USB.
    const key = adbTarget || serial
    if (intents.has(key)) {
        // Already tracking this exact transport — just record adbTarget for M1.
        const e = intents.get(key)
        if (adbTarget && adbTarget !== key) e.adbTarget = adbTarget
        return
    }
    // Merge a same-phone twin registered under the OTHER transport instead of
    // inserting a duplicate that would fight this one with its own relaunch loop.
    const twin = _findSameDeviceIntentKey(key)
    if (twin) {
        const e = intents.get(twin)
        intents.delete(twin)
        e.serial = key
        // This is a fresh launch — its transport is authoritative (the twin may
        // have been on the other transport). Don't inherit the twin's adbTarget.
        e.adbTarget = adbTarget || (isTailnetSerial(key) ? key : null)
        intents.set(key, e)
        console.log(`[device-watchdog] intent ${twin} merged into ${key} (same phone)`)
        return
    }
    const entry = _freshIntentEntry(key)
    entry.adbTarget = adbTarget || (isTailnetSerial(key) ? key : null)
    intents.set(key, entry)
    console.log(`[device-watchdog] intent registered for ${key}`)
}

function clearIntent(serial) {
    if (!serial) return
    let deleted = intents.delete(serial)
    // Also clear a same-phone twin keyed under the other transport so Close
    // Window doesn't leave a sibling relaunching the mirror the user just shut.
    const twin = _findSameDeviceIntentKey(serial)
    if (twin && intents.delete(twin)) deleted = true
    if (deleted) {
        console.log(`[device-watchdog] intent cleared for ${serial}`)
    }
}

function getIntents() {
    return Array.from(intents.entries()).map(([s, e]) => ({
        serial: s,
        phase: e.currentPhase,
        state: e.currentState,
        downtimeMs: e.downtimeStartedAt ? Date.now() - e.downtimeStartedAt : 0,
        reconnectAttempts: e.reconnectAttempts,
        relaunchAttempts: e.relaunchAttempts,
        // Read by ws-module-client's device-liveness abort as a VETO only (the
        // watchdog saying the phone is live makes a probe miss inconclusive).
        lastSeenOnlineAt: e.lastSeenOnlineAt,
    }))
}

// Read-only accessor for the last adb-server restart. The device-liveness abort
// treats probe misses inside a grace window of this as INCONCLUSIVE: a tailnet
// ip:port serial does NOT re-enumerate after kill-server without an explicit
// `adb connect`, so without it there is a real feedback loop — restart makes the
// serial vanish, the run aborts, the busy lock clears, the watchdog restarts again.
function getAdbServerRestartAt() {
    return _adbServerLastRestart
}

async function _restartAdbServer() {
    const adb = _ctx?.getADBPath?.()
    if (!adb) return
    // Never kill the whole adb-server while a phone holds the busy lock: an
    // in-flight create/module run is driving that device over this exact
    // transport, and a kill-server tears the USB/TLS socket out from under both
    // the live scrcpy mirror and the brain mid-run — the confirmed create-stall +
    // sidebar-vanish trigger. Skip WITHOUT burning the cooldown so the next tick
    // retries the moment the run clears. Checked before the cooldown gate on
    // purpose (a deferral must not consume the 30s window).
    try {
        const se = require('./schedule-engine')
        if (typeof se.hasBusyPhones === 'function' && se.hasBusyPhones()) {
            _restartDeferStreak += 1
            if (_restartDeferStreak <= RESTART_DEFER_MAX) {
                _broadcast('warn', `adb-server restart deferred (${_restartDeferStreak}/${RESTART_DEFER_MAX}) — a phone is running an automation; will restart anyway if adb stays wedged`, null)
                return
            }
            // Bound exceeded: adb is wedged AND the busy holder isn't clearing —
            // it's stuck on this same dead transport. Restart to break the
            // deadlock; a wedged adb-server helps no in-flight run.
            _broadcast('warn', 'adb wedged through the busy-defer limit — restarting adb-server to recover (the stuck run cannot proceed on a dead transport)', null)
        }
    } catch (_) { /* schedule-engine unavailable (tests) — fall through */ }
    _restartDeferStreak = 0
    if (Date.now() - _adbServerLastRestart < 30_000) return  // 30s cooldown
    _adbServerLastRestart = Date.now()
    _broadcast('warn', 'adb daemon not responding — restarting adb-server', null)
    try {
        // _exec RESOLVES on failure instead of throwing, so the catch below never
        // ran and this logged "adb-server restarted" unconditionally — including
        // when BOTH commands were refused synchronously by the ADB guard (observed
        // live: kill-server → 600ms sleep → start-server → "restarted", all inside
        // 676ms, which cannot spawn two processes on Windows). Report what happened.
        const killed = await _exec(adb, ['kill-server'], 3000)
        await new Promise(r => setTimeout(r, 600))
        const started = await _exec(adb, ['start-server'], 6000)
        if (killed.err || started.err) {
            _broadcast('warn',
                `adb-server restart did NOT run: ${(started.err || killed.err)?.message || 'adb refused the command'}`,
                null)
        } else {
            _broadcast('info', 'adb-server restarted', null)
        }
    } catch (e) {
        _broadcast('error', `adb-server restart failed: ${e?.message || e}`, null)
    }
}

async function _attemptReconnect(serial, entry, tsPeers) {
    const adb = _ctx?.getADBPath?.()
    if (!adb) return false
    entry.lastReconnectAt = Date.now()
    entry.reconnectAttempts += 1

    // Tailnet: gate on Tailscale reachability. The DAEMON-level check must come
    // first — with tailscaled Stopped, `tailscale status --json` still reports
    // the peer Online=true (verified live on the operator's PC), so the
    // peerOnline test below never fires in the real outage scenario and every
    // connect burns its full 5s timeout.
    if (isTailnetSerial(serial)) {
        if (!(await _tailnetRoutableFor(serial))) return false
        const ip = serial.split(':')[0]
        const peerOnline = tsPeers?.get(ip)
        if (peerOnline === false) {
            // Don't burn an adb-connect attempt — phone is genuinely off.
            return false
        }
        // Stale handle: disconnect first
        if (entry.currentState === 'offline') {
            await _exec(adb, ['disconnect', serial], 2500)
        }
        const r = await _exec(adb, ['connect', serial], 5000)
        const ok = /connected to|already connected/i.test(r.stdout + r.stderr)
        return ok
    }

    // USB: kick adb reconnect for transient offline state.
    if (entry.currentState === 'offline') {
        await _exec(adb, ['reconnect'], 5000)
        return true
    }
    // Fix-4: a USB intent adb no longer lists at all ('missing') previously fell
    // through and returned false, so Case B did nothing for a USB phone whose
    // transport silently dropped. Kick `adb reconnect offline` (idempotent) so
    // the dead transport gets a nudge. This path is already cadence-gated by
    // reconnectInterval in Case B, so a genuinely-unplugged phone won't spin.
    if (entry.currentState === 'missing') {
        await _exec(adb, ['reconnect', 'offline'], 5000)
        return true
    }
    return false
}

// Liveness probe — adb-server can report "device" for serials whose
// underlying TLS session is dead. Send `adb shell echo sp_ok` and
// require the literal back within 2.5s.
async function _shellProbe(serial) {
    const adb = _ctx?.getADBPath?.()
    if (!adb) return false
    const { err, stdout } = await _exec(
        adb, ['-s', serial, 'shell', 'echo', 'sp_ok'], SHELL_PROBE_TIMEOUT_MS)
    return !err && String(stdout).trim() === 'sp_ok'
}

// Recover from a zombie cached serial by asking the Companion service
// (Tailnet :8765) for the current adb TLS port, then swapping the intent
// in-place. Returns true on successful swap (caller falls through to
// normal relaunch on next tick).
async function _reconnectViaCompanion(serial, entry) {
    if (!isTailnetSerial(serial)) return false
    const adb = _ctx?.getADBPath?.()
    if (!adb) return false
    // With the tailnet unroutable this whole path is pure waste — and the most
    // expensive waste in the app: probeCompanion plus scanForAdbPort fans up to
    // 200 parallel sockets across 28k ports on a 60s deadline. Gate BEFORE the
    // disconnect and the attempt counter so a down Tailscale costs nothing.
    if (!(await _tailnetRoutableFor(serial))) return false
    const ip = serial.split(':')[0]
    entry.rediscoverAttempts += 1

    await _exec(adb, ['disconnect', serial], 2500)

    // Step 1: try Companion. If reachable + reports a port, use it.
    //         If reachable but adbPort=0, scan the Tailnet.
    //         If unreachable (e.g. user pre-2.20.0 wizard never ran the
    //         Companion install step), fall back to direct port scan —
    //         the scan itself proves Tailnet reachability AND finds the
    //         port in one pass. This is the migration path for SaaS
    //         users who upgrade the desktop but haven't reinstalled
    //         their phones yet.
    let companionAlive = false
    let companionAdbPort = 0
    try {
        const s = await probeCompanion(ip, { timeoutMs: COMPANION_DISCOVERY_TIMEOUT_MS })
        companionAlive = true
        companionAdbPort = s.adbPort
    } catch (e) {
        _broadcast('info',
            `companion not reachable (${e.message}) — falling back to direct port scan`,
            serial)
    }

    // Step 2: pick port. Use Companion's value if known, else scan.
    let newPort = companionAdbPort
    if (!newPort || newPort < 1024) {
        const hintPort = Number(serial.split(':')[1]) || null
        if (companionAlive) {
            _broadcast('info',
                `companion alive but port unknown — scanning Tailnet${hintPort ? ` (hint ${hintPort})` : ''}`,
                serial)
        }
        newPort = await scanForAdbPort(ip, { hintPort })
        if (!newPort) {
            _broadcast('warn', `port scan found no adb listener on ${ip}`, serial)
            return false
        }
        _broadcast('info', `scan found candidate port ${newPort}`, serial)
    }

    if (Number(serial.split(':')[1]) === newPort) {
        _broadcast('info', `discovered same port ${newPort}, no swap`, serial)
        return false
    }

    const newSerial = `${ip}:${newPort}`
    const r = await _exec(adb, ['connect', newSerial], 5000)
    const ok = /connected to|already connected/i.test(r.stdout + r.stderr)
    if (!ok) {
        _broadcast('warn', `connect to discovered port failed: ${r.stdout || r.stderr}`, serial)
        return false
    }

    if (intents.has(serial)) {
        const e = intents.get(serial)
        intents.delete(serial)
        e.serial = newSerial
        e.consecutiveRefused = 0
        e.reconnectAttempts = 0
        e.currentState = 'device'
        e.lastSeenOnlineAt = Date.now()
        intents.set(newSerial, e)
    }
    _broadcast('info', `port rediscovered: ${serial} → ${newSerial}`, newSerial)
    return true
}

async function _attemptRelaunch(serial, entry) {
    const now = Date.now()
    if (now - entry.lastRelaunchAt < RELAUNCH_MIN_GAP_MS) return false
    entry.lastRelaunchAt = now
    entry.relaunchAttempts += 1

    const downtimeMs = entry.downtimeStartedAt ? now - entry.downtimeStartedAt : 0
    _broadcast('info',
        `phone back online${downtimeMs ? ` (was offline ${Math.round(downtimeMs / 1000)}s)` : ''} — relaunching mirror`,
        serial)
    try {
        await _ctx.launchScrcpyForSerial(serial)
        // Successful relaunch — clear downtime tracker, return to fast phase
        entry.downtimeStartedAt = 0
        entry.currentPhase = PHASE_FAST
        entry.reconnectAttempts = 0
        // Fix-2: mark unhealthy-until-observed. Cleared in the healthy branch
        // once the mirror is seen running; if it dies first, Case A counts a
        // quick death regardless of tick cadence.
        entry.relaunchedUnhealthy = true
        return true
    } catch (e) {
        _broadcast('error', `relaunch failed: ${e?.message || e}`, serial)
        return false
    }
}

let _tickInFlight = false
let _tickSkipCount = 0

async function _tick() {
    if (!_ctx || intents.size === 0) return
    // Re-entrancy guard: at scale (100+ phones), a single tick can take
    // longer than the 5s interval, causing pile-up. Skip overlapping
    // ticks; log occasionally so we know we're saturated.
    if (_tickInFlight) {
        _tickSkipCount += 1
        if (_tickSkipCount % 10 === 1) {
            console.warn(`[device-watchdog] tick still in flight — skipped ${_tickSkipCount}x`)
        }
        return
    }
    _tickInFlight = true
    _tickSkipCount = 0
    try {
        await _tickInner()
    } finally {
        _tickInFlight = false
    }
}

async function _tickInner() {
    const adbResult = await _enumerateAdbState()

    // H3: refresh the merged device snapshot so markIntent/clearIntent can
    // collapse same-phone intents. Best-effort — failures keep the last list.
    if (_ctx?.getConnectedDevices) {
        try {
            const snap = await _ctx.getConnectedDevices()
            if (Array.isArray(snap)) _lastDevices = snap
        } catch (_) { /* keep last snapshot */ }
    }
    // H3: reconcile any twin intents that were registered before the snapshot
    // was warm (markIntent ran with an empty device list). Collapse same-phone
    // pairs to ONE intent, keeping the tailnet transport key (so keepalive/probe
    // target the socket scrcpy streams on) when present.
    _reconcileDuplicateIntents()

    // If adb itself isn't responding, restart adb-server (real daemon issue) —
    // but ONLY after the failure is corroborated by a second consecutive bad
    // enumeration. A lone `adb devices` timeout (server momentarily busy under
    // scrcpy+tailnet contention) would otherwise kill EVERY live mirror's
    // transport on a transient spike (Fix-1). The longer ADB_ENUM_TIMEOUT_MS
    // already absorbs most spikes; the streak gate handles the rest.
    if (!adbResult.ok) {
        _adbProbeFailStreak += 1
        if (_adbProbeFailStreak < ADB_PROBE_FAIL_THRESHOLD) {
            _broadcast('warn',
                `adb enumerate failed (${adbResult.timedOut ? 'timeout' : 'error'}) — retrying next tick before restart`,
                null)
            return
        }
        await _restartAdbServer()
        return
    }
    // Healthy enumeration — clear the streaks so a future restart needs its own
    // fresh run of consecutive failures (and the busy-defer bound resets).
    _adbProbeFailStreak = 0
    _restartDeferStreak = 0

    // If adb-server is alive but reports 0 devices, that's normal STATE for
    // a freshly-started server with no `adb connect` calls made yet. For
    // every Tailnet-style intent, fire a connect attempt right now so we
    // populate the device table. This is the post-reboot / post-Electron-
    // restart path: server is fresh, intent is stale, but the cached IP
    // might still be reachable (or rediscovery will swap to a fresh port).
    if (adbResult.states.size === 0) {
        const allKeys = Array.from(intents.keys())
        const tailnetIntents = allKeys.filter(isTailnetSerial)
        const hasUsbIntents = allKeys.some(k => !isTailnetSerial(k))
        // Tailnet gate: this fan-out fires one `connect` per tailnet intent in
        // PARALLEL. Against a down Tailscale each burns its full 4s timeout, and
        // 3 of them inside adb-util's 30s window trip the shared circuit breaker
        // (timeoutThreshold=3) — which then SIGKILLs every ACTIVE adb command,
        // including a healthy USB phone's in-flight run. The USB
        // `reconnect offline` kick below still fires either way.
        // Only CGNAT (100.64/10) intents are gated — a LAN-wireless intent does
        // not need Tailscale and must keep kicking on a PC that has none.
        const cgnatIntents = tailnetIntents.filter(_isCgnatTarget)
        const lanIntents = tailnetIntents.filter(s => !_isCgnatTarget(s))
        const wirelessKicks = cgnatIntents.length > 0 && await _tailnetRoutable()
            ? lanIntents.concat(cgnatIntents)
            : lanIntents
        if (wirelessKicks.length > 0 || hasUsbIntents) {
            const adb = _ctx.getADBPath()
            const kicks = wirelessKicks.map(s => _exec(adb, ['connect', s], 4000))
            // Fix-4: a stale/killed adb-server with only USB intents pending was
            // never recovered (the old branch only reconnected tailnet). Fire a
            // single idempotent `adb reconnect offline` (no-op when nothing is
            // offline) to kick any stale USB transport before re-reading.
            if (hasUsbIntents) kicks.push(_exec(adb, ['reconnect', 'offline'], 4000))
            await Promise.all(kicks)
            // Continue to the for-loop below using fresh enumeration.
            const refresh = await _enumerateAdbState()
            if (refresh.ok) adbResult.states = refresh.states
        }
    }

    const tsPeers = await _tailscalePeerOnlineMap()
    const now = Date.now()

    // Per-intent work in bounded parallel batches. Serial loop took 116s
    // for 100 intents (live-benched); parallel-12 cuts that to ~12s and
    // fits inside the 5s tick budget for fleets up to ~25 phones. Larger
    // fleets still benefit from the re-entrancy guard above.
    const PARALLEL = 12
    const entries = Array.from(intents.entries())
    let cursor = 0

    const workOnIntent = async (serial, entry) => {
        // Fix-1 (intra-tick race): entries were snapshotted at tick start. A user
        // Close Window (clearIntent) during a sibling worker's await can delete
        // this serial before we run — bail so we never resurrect a just-closed
        // mirror. The watchdog's own relaunch re-registers the intent synchronously,
        // so auto-recovery is unaffected.
        if (!intents.has(serial)) return
        const state = adbResult.states.get(serial) || 'missing'
        const running = _ctx.hasRunningScrcpyForSerial(serial)

        // ── State transition tracking ────────────────────────────────────
        if (state !== entry.currentState) {
            const prev = entry.currentState
            entry.currentState = state
            entry.stateChangeAt = now
            // online -> offline transition: start downtime clock
            if (prev === 'device' && state !== 'device') {
                entry.downtimeStartedAt = now
                _broadcast('warn', `phone went ${state} (was device)`, serial)
            }
            // offline -> online transition: phase resets, downtime ends on relaunch
            if (state === 'device' && prev !== 'device' && prev !== null) {
                const downSec = Math.round((now - entry.downtimeStartedAt) / 1000)
                _broadcast('info', `phone reachable again (${downSec}s downtime)`, serial)
                // Device-presence flap detection: a phone that keeps dropping off
                // adb and coming back (loose USB cable/port, failing hub) would
                // otherwise relaunch the mirror on EVERY reconnect → spawn/die storm.
                // Count reconnects in a sliding window; past the threshold, pause
                // auto-relaunch (shared flapCooldownUntil, honored in Case A) and
                // surface a clear "check the cable" warning instead of churning.
                entry.recentReconnects = (entry.recentReconnects || []).filter(t => now - t < DEVICE_FLAP_WINDOW_MS)
                entry.recentReconnects.push(now)
                if (entry.recentReconnects.length >= DEVICE_FLAP_THRESHOLD) {
                    entry.flapCooldownUntil = now + FLAP_COOLDOWN_MS
                    entry.recentReconnects = []
                    _broadcast('warn',
                        `connection unstable — ${DEVICE_FLAP_THRESHOLD}+ adb drops in ${Math.round(DEVICE_FLAP_WINDOW_MS / 60000)}min (check the USB cable/port or switch this phone to Tailscale). Auto-mirror paused ${Math.round(FLAP_COOLDOWN_MS / 60000)}min — reopen manually once the connection is stable.`,
                        serial)
                }
            }
        }

        // Phase classification (drives reconnect cadence)
        entry.currentPhase = _phaseFor(entry, now)

        // ── Case A: device online + no scrcpy → relaunch ─────────────────
        if (state === 'device' && !running) {
            entry.lastSeenOnlineAt = now
            entry.mirrorUpSince = 0
            // Don't relaunch while an equalizer/profile-switch respawn is already
            // in flight for this phone — hasRunningScrcpy briefly reads false
            // between the old window closing and the new one spawning, and racing
            // it here double-spawns the mirror.
            if (_ctx.isRespawning && _ctx.isRespawning(serial)) return
            // Same reasoning for a LAUNCH already in flight: the launch prelude
            // (device enumeration, orphan sweep, kill-and-wait) runs for seconds
            // before a process exists, and relaunching into it double-spawns.
            if (_ctx.isLaunching && _ctx.isLaunching(serial)) return
            // A CLEAN close is a user close. Its teardown clears the intent only
            // after an async adb probe; don't resurrect the window inside that
            // gap. 5s is well under RELAUNCH_MIN_GAP_MS, so genuine
            // offline->online recovery is unaffected.
            const closedAt = _ctx.lastCleanCloseAt && _ctx.lastCleanCloseAt(serial)
            if (closedAt && now - closedAt < CLEAN_CLOSE_GRACE_MS) return
            // Flap guard — don't churn the mirror when the transport bounces.
            if (entry.flapCooldownUntil && now < entry.flapCooldownUntil) return
            // Fix-2: cadence-independent quick-death detection. A relaunch that
            // dies before the next tick observes it running (the healthy branch
            // never cleared relaunchedUnhealthy) is a quick death at 5s, 30s, or
            // 60s tick intervals alike — the old fixed-window check silently
            // missed flaps on 60s-tick fleets. Count a death ONLY once the
            // relaunch backoff has elapsed and we're about to fire a NEW relaunch;
            // otherwise a single dead relaunch — gap-skipped by _attemptRelaunch
            // on every 5s tick — would trip the 5-min cooldown in 3 ticks without
            // a second relaunch ever firing. RELAUNCH_MIN_GAP_MS stays the real backoff.
            if (entry.relaunchedUnhealthy) {
                if (now - entry.lastRelaunchAt >= RELAUNCH_MIN_GAP_MS) {
                    // Prior relaunch fired, was never observed running, and the
                    // backoff has elapsed → it genuinely quick-died.
                    entry.quickDeathCount += 1
                    if (entry.quickDeathCount >= FLAP_THRESHOLD) {
                        entry.flapCooldownUntil = now + FLAP_COOLDOWN_MS
                        entry.quickDeathCount = 0
                        _broadcast('warn',
                            `mirror keeps dropping (transport flap) — pausing auto-relaunch ${Math.round(FLAP_COOLDOWN_MS / 60000)}min; reopen manually to retry`,
                            serial)
                        return
                    }
                }
                // else: still inside the backoff window — the same relaunch is
                // cooling down, not a new death; don't count it, and let
                // _attemptRelaunch gap-skip below.
            } else {
                // Last relaunch survived long enough (or first launch) — not flapping.
                entry.quickDeathCount = 0
            }
            // Fix-1 (intra-tick race): re-check right before relaunching — a user
            // Close Window mid-tick can have cleared this intent after the guards
            // above. Don't relaunch a mirror the user just shut.
            if (!intents.has(serial)) return
            await _attemptRelaunch(serial, entry)
            // Fix-3: persistent-failure escalation. Once a phone has burned
            // GIVE_UP_RELAUNCH_THRESHOLD relaunches without ever being observed
            // running, surface ONE operator-facing error so a dead phone isn't
            // churned silently. gaveUpBroadcasted (reset on the next healthy
            // observation) makes it fire exactly once per failure streak.
            if (!entry.gaveUpBroadcasted && entry.relaunchAttempts >= GIVE_UP_RELAUNCH_THRESHOLD) {
                entry.gaveUpBroadcasted = true
                _broadcast('error',
                    `persistent mirror failure on ${serial} — auto-recovery paused, check the phone (${entry.relaunchAttempts} relaunch attempts, none held)`,
                    serial)
            }
            return
        }

        // Device online + scrcpy running → healthy. Reset attempt counters.
        if (state === 'device' && running) {
            entry.lastSeenOnlineAt = now
            entry.reconnectAttempts = 0
            entry.relaunchAttempts = 0
            entry.gaveUpBroadcasted = false
            // Fix-2: mirror survived to be observed running → not a quick death.
            entry.relaunchedUnhealthy = false
            // Flap recovery: a mirror that survives FLAP_STABLE_MS clears the flap
            // counters so a later genuine disconnect relaunches promptly.
            if (!entry.mirrorUpSince) entry.mirrorUpSince = now
            if (now - entry.mirrorUpSince > FLAP_STABLE_MS) {
                entry.quickDeathCount = 0
                entry.flapCooldownUntil = 0
            }
            // Liveness probe every 30s catches zombie TCP sockets that adb
            // reports as "device" but where the TLS session is dead.
            if (now - entry.lastShellProbeAt > SHELL_PROBE_CADENCE_MS) {
                entry.lastShellProbeAt = now
                // M1: probe the transport scrcpy streams on so a dead tailnet
                // TLS session is detected even when the USB serial reads alive.
                // Double-probe: a single Tailscale relay flap causes one transient
                // 'error: closed' failure but recovers within ~1s. A genuinely
                // dead TLS session fails both attempts. This avoids a spurious
                // Companion round-trip (2.5s+ disconnect/reconnect) on every relay
                // flap during an active session (probe runs every 30s).
                const probeTarget = entry.adbTarget || serial
                let alive = await _shellProbe(probeTarget)
                if (!alive) {
                    await new Promise(r => setTimeout(r, 1000))
                    alive = await _shellProbe(probeTarget)
                }
                if (!alive) {
                    _broadcast('warn', 'shell probe failed (2/2) — marking zombie', serial)
                    entry.currentState = 'offline'
                    entry.downtimeStartedAt = now
                    entry.consecutiveRefused = ZOMBIE_REFUSED_THRESHOLD
                }
            }
            return
        }

        // ── Case B: offline/missing → reconnect at phase-driven cadence ──
        const reconnectInterval = _reconnectIntervalFor(entry.currentPhase)
        if (now - entry.lastReconnectAt < reconnectInterval) return

        // Zombie check: Tailnet serial offline >15s OR 3 consecutive
        // refused connects = stale cached port. Try Companion rediscovery
        // before another reconnect attempt.
        const offlineMs = entry.downtimeStartedAt ? now - entry.downtimeStartedAt : 0
        const looksZombie = isTailnetSerial(serial) && (
            offlineMs > ZOMBIE_OFFLINE_THRESHOLD_MS ||
            entry.consecutiveRefused >= ZOMBIE_REFUSED_THRESHOLD
        )
        if (looksZombie) {
            const rediscovered = await _reconnectViaCompanion(serial, entry)
            if (rediscovered) {
                entry.consecutiveRefused = 0
                entry.currentPhase = PHASE_FAST
                return
            }
        }

        const ok = await _attemptReconnect(serial, entry, tsPeers)
        if (ok) {
            entry.consecutiveRefused = 0
            if (entry.currentPhase !== PHASE_FAST) entry.currentPhase = PHASE_FAST
        } else if (isTailnetSerial(serial)) {
            entry.consecutiveRefused += 1
        }
    }

    const worker = async () => {
        while (true) {
            const idx = cursor++
            if (idx >= entries.length) return
            const [serial, entry] = entries[idx]
            try { await workOnIntent(serial, entry) }
            catch (e) { console.warn(`[device-watchdog] intent worker error ${serial}:`, e?.message || e) }
        }
    }
    const workers = []
    for (let i = 0; i < Math.min(PARALLEL, entries.length); i++) workers.push(worker())
    await Promise.all(workers)
}

async function _keepalive() {
    if (!_ctx || intents.size === 0) return
    const adb = _ctx?.getADBPath?.()
    if (!adb) return
    for (const [serial, entry] of intents) {
        // Fix-3: key the keepalive off the authoritative liveness signal, not
        // entry.currentState (which only refreshes during a tick — at scaled
        // 15-60s ticks it can be stale, skipping a just-registered live mirror
        // or pinging one whose state hasn't caught up). hasRunningScrcpyForSerial
        // is a synchronous OS-process check and is never throttled by the tick.
        if (!_ctx.hasRunningScrcpyForSerial(serial)) continue
        // M1: warm the SOCKET scrcpy actually streams on (the tailnet adbTarget),
        // not the bookkeeping udid — that udid's USB socket isn't the one the
        // relay NAT reaps. Falls back to the intent serial for plain USB.
        const target = entry.adbTarget || serial
        // Fire-and-forget echo. 1.5s timeout so a hanging tunnel doesn't
        // stack-up indefinite pings.
        _exec(adb, ['-s', target, 'shell', 'echo', 'sp_ka'], 1500).catch(() => {})
    }
}

function start(ctx) {
    if (_intervalHandle) return
    _ctx = ctx || {}
    if (!_ctx.getADBPath || !_ctx.hasRunningScrcpyForSerial || !_ctx.launchScrcpyForSerial) {
        console.warn('[device-watchdog] missing required deps — not starting')
        return
    }
    _userDataDir = _ctx.userDataDir || null
    // Anyro 2026-06-07: do NOT auto-restore mirror intents on startup — that was
    // auto-relaunching scrcpy for every previously-open phone the instant the app
    // launched. Mirrors now open ONLY when the user clicks one; the watchdog still
    // recovers a mirror that dies DURING the session (intent registered on launch).
    // Clear any stale persisted intents so they can never resurrect a mirror.
    try { const f = _intentsFile(); if (f && fs.existsSync(f)) fs.unlinkSync(f) } catch (_) { /* best-effort */ }
    // Scale-aware tick interval. At small fleets the 5s tick gives fast
    // recovery; at large fleets a tick can take longer than 5s so the
    // re-entrancy guard would skip every other one anyway. Adapt:
    //   1-10 intents:  5s   (TICK_MS)
    //   11-25 intents: 15s
    //   26-50 intents: 30s
    //   51+ intents:   60s
    // The re-entrancy guard catches any tick that still overruns.
    const pickInterval = () => {
        const n = intents.size
        if (n <= 10) return TICK_MS
        if (n <= 25) return 15_000
        if (n <= 50) return 30_000
        return 60_000
    }
    let currentInterval = pickInterval()
    const scheduleTick = () => {
        if (_intervalHandle) clearInterval(_intervalHandle)
        _intervalHandle = setInterval(() => {
            _tick()
            // After each tick, re-pick interval in case fleet size changed.
            const want = pickInterval()
            if (want !== currentInterval) {
                currentInterval = want
                console.log(`[device-watchdog] re-tuning tick to ${want}ms (fleet=${intents.size})`)
                scheduleTick()
            }
        }, currentInterval)
    }
    scheduleTick()
    _keepaliveHandle = setInterval(_keepalive, KEEPALIVE_INTERVAL_MS)
    console.log(`[device-watchdog] started (tick ${TICK_MS}ms, keepalive ${KEEPALIVE_INTERVAL_MS}ms)`)
    // Kick a tick almost immediately so a fresh boot picks up restored intents fast.
    setTimeout(_tick, 1000)
}

function stop() {
    if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null }
    if (_keepaliveHandle) { clearInterval(_keepaliveHandle); _keepaliveHandle = null }
}

module.exports = {
    start,
    stop,
    markIntent,
    clearIntent,
    getIntents,
    getAdbServerRestartAt,
    _tick,
    _keepalive,
    _restartAdbServer,
    // Test seam: inject the tailnet routability verdict (null restores the real one).
    _setTailnetGateForTest: impl => { _tailnetGateImpl = typeof impl === 'function' ? impl : null },
}
