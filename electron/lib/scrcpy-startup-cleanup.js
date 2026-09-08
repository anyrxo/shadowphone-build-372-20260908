// electron/lib/scrcpy-startup-cleanup.js
//
// One-shot startup cleanup of port-mode scrcpy.Server processes across
// every connected adb device. Runs once at wizard boot (after the adb
// server has started, before any browser can connect to the dashboard).
//
// Why this exists: Nur's 2026-05-23 diagnostic surfaced a version-
// transition war. When the wizard updates from v2.14.x → v2.14.(x+1),
// the OLD sp_build scrcpy.Server processes are still alive on the
// connected phones. The new wizard's health machine sees them as
// `stale_args` and force-respawns, but on Pixel 6a / Android 16 the
// port-rebind hits TIME_WAIT (~30-60s) and the new spawn fails to
// bind. The health machine sees `not bound` → respawns again → storm.
// At its worst, 27271 had 44 scrcpy.Server processes piled up, all
// failing to bind, and the resource pressure crashed system_server
// (DeadSystemException in DisplayManager).
//
// This module wipes the old build BEFORE the normal flow has a chance
// to start fighting it. The sweep is synchronous (we await it in
// main.js's whenReady) so the dashboard never opens with a stale-
// build server lying around.
//
// Safe to call repeatedly — idempotent. If there's no adb / no
// devices / no scrcpy running, it just exits quickly.
//
// Selective: only kills `port_number=`-mode scrcpy (the wizard's web
// dashboard servers). Leaves the desktop app's scid-mode local mirror
// scrcpy untouched.

const { runAdb } = require('./adb-util')

const SCRCPY_PORT_HEX = '22B6' // 8886 in hex

function run(adbPath, args, timeoutMs = 6000) {
    return runAdb(adbPath, args, timeoutMs).then(result => ({
        ...result,
        code: result.code ?? -1,
    }))
}

async function listDevices(adbPath) {
    const r = await run(adbPath, ['devices'], 4000)
    return (r.stdout || '')
        .split('\n')
        .slice(1)
        .map(line => line.trim().split(/\s+/))
        .filter(parts => parts.length >= 2 && parts[1] === 'device')
        .map(parts => parts[0])
}

async function sweepDevice(adbPath, serial, logger) {
    // Kill every port-mode scrcpy.Server on this device. The shell:
    //   1. List PIDs matching `com.genymobile.scrcpy.Server` AND `port_number=`
    //   2. kill -9 each one
    //   3. Wait up to 30s for the port to drain out of TIME_WAIT (state != 0A/06)
    //   4. Echo a summary
    const portHex = SCRCPY_PORT_HEX
    // 2.14.13: switched from `ps -A -o pid,cmd` to `pgrep -f` because
    // Android's toybox `ps -o cmd` shows just the BINARY name
    // ("app_process"), not the full cmdline — so grep "port_number=" never
    // matched and killed=0 even when stale scrcpy was holding port 8886.
    // pgrep -f matches against the FULL cmdline, catching every variant
    // including legacy 2.12.x leftovers with log_level=DEBUG /
    // key_frame_interval=5 args that survived wizard restarts.
    const cmd = [
        `PIDS=$(pgrep -f "com.genymobile.scrcpy.Server.*port_number=" 2>/dev/null)`,
        `KILLED=$(echo $PIDS | wc -w)`,
        `for pid in $PIDS; do kill -9 "$pid" 2>/dev/null || true; done`,
        // Wait for the listening socket to disappear AND TIME_WAIT to drain.
        // We tolerate state 06 (TIME_WAIT) — that just means kernel hasn't
        // released yet, which is fine since we're going to give it time.
        // We require state 0A (LISTEN) to be gone.
        `j=0; while [ $j -lt 300 ]; do LISTEN=$(awk '$2 ~ /:${portHex}$/ && $4 == "0A"' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l); if [ "$LISTEN" = "0" ]; then break; fi; j=$((j+1)); sleep 0.1; done`,
        // Report final state
        `LISTEN=$(awk '$2 ~ /:${portHex}$/ && $4 == "0A"' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l)`,
        `TIMEWAIT=$(awk '$2 ~ /:${portHex}$/ && $4 == "06"' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l)`,
        `echo "killed=$KILLED listening_after=$LISTEN timewait_after=$TIMEWAIT"`,
    ].join('; ')
    const r = await run(adbPath, ['-s', serial, 'shell', cmd], 45_000)
    const out = (r.stdout || '').trim()
    logger(`${serial}: ${out || '(no output)'}${r.stderr ? ' err=' + r.stderr.trim() : ''}`)
    return out
}

// 2.14.6: detect rival ws-scrcpy stacks on this host. Nur's 2026-05-23
// incident had a parallel custom phone-farm/eucalyz-build/ws-scrcpy
// listening on :8000, kept alive by a Windows scheduled task
// `ws-scrcpy-watchdog`. Both the wizard AND that custom stack bound the
// same device port 8886, fighting for ownership and triggering the
// 30+-process storm. The wizard's own fixes were useless because each
// kill triggered the rival's watchdog to respawn. Detecting and
// surfacing this in the dashboard prevents the same silent-conflict.
async function detectRivalStacks({ logger = () => {} } = {}) {
    const rivals = []
    // (a) Probe port 8000 BUT verify it's an HTTP server, not adb's own forward.
    // 2.14.14: previously we flagged any TCP listener on :8000 as a rival,
    // but Anyro's 2026-05-23 logs showed the wizard's own adb daemon held
    // :8000 (likely an `adb forward tcp:8000` set up by ws-scrcpy). Killing
    // it killed the wizard's adb. Now we HTTP-probe :8000 and only flag if
    // the response looks like an HTTP server (a ws-scrcpy returns either
    // text/html or 426 Upgrade Required for WS handshake; adb forward
    // returns gibberish and closes immediately).
    try {
        const http = require('http')
        await new Promise((resolve) => {
            const req = http.get({ host: '127.0.0.1', port: 8000, path: '/', timeout: 1500 }, (res) => {
                const ctype = (res.headers['content-type'] || '').toLowerCase()
                const looksLikeWsScrcpy = ctype.includes('text/html') || res.statusCode === 426 || res.headers['server']?.toLowerCase().includes('node')
                if (looksLikeWsScrcpy) {
                    rivals.push({ kind: 'http_listener', port: 8000, status: res.statusCode, contentType: ctype, hint: 'Another ws-scrcpy/HTTP server on :8000 — likely a parallel scrcpy dashboard' })
                }
                res.resume()
                resolve()
            })
            req.on('error', () => resolve())  // ECONNRESET from adb forward = not a rival
            req.on('timeout', () => { req.destroy(); resolve() })
        })
    } catch (_) {}
    // (b) Windows scheduled tasks named like *scrcpy*
    if (process.platform === 'win32') {
        try {
            const r = await run('schtasks', ['/Query', '/FO', 'CSV', '/NH'], 5000)
            const lines = (r.stdout || '').split('\n')
            for (const line of lines) {
                if (/scrcpy|phone-farm|eucalyz/i.test(line) && !/shadowphone/i.test(line)) {
                    const taskName = line.split(',')[0]?.replace(/"/g, '').trim()
                    if (taskName) rivals.push({ kind: 'scheduled_task', name: taskName, hint: `Scheduled task likely respawns a rival scrcpy stack — disable with: Disable-ScheduledTask -TaskName "${taskName}"` })
                }
            }
        } catch (_) {}
    }
    if (rivals.length > 0) logger(`detected ${rivals.length} rival scrcpy stack(s): ${JSON.stringify(rivals)}`)
    return rivals
}

async function sweepAllDevices({ adbPath, logger = () => {} } = {}) {
    if (!adbPath) {
        logger('skip — adbPath missing')
        return { swept: 0, rivals: [] }
    }
    const rivals = await detectRivalStacks({ logger })
    let devices = []
    try {
        devices = await listDevices(adbPath)
    } catch (e) {
        logger(`adb devices failed: ${e?.message || e}`)
        return { swept: 0, rivals }
    }
    if (devices.length === 0) {
        logger('no connected devices — nothing to sweep')
        return { swept: 0, rivals }
    }
    logger(`sweeping ${devices.length} device(s): ${devices.join(', ')}`)
    // Run sweeps in parallel so the wizard boot isn't blocked O(N*30s) on
    // a multi-device farm. Each per-device sweep is bounded at 45s.
    const results = await Promise.all(devices.map(s => sweepDevice(adbPath, s, logger).catch(e => `${s}: ERR ${e?.message || e}`)))
    logger(`sweep complete: ${results.length} device(s) processed`)
    return { swept: devices.length, results, rivals }
}

module.exports = { sweepAllDevices, sweepDevice, listDevices, detectRivalStacks, SCRCPY_PORT_HEX }
