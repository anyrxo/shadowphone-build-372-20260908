/**
 * scrcpy-orphan-killer.js — Reap stale local-side adb children left behind
 * after a scrcpy parent died (force-kill, crash, parent ShadowPhone killed
 * with adb spawn still in flight, etc.).
 *
 * Concrete bug this fixes: the previous scrcpy left
 *   `adb -s <serial> shell CLASSPATH=…/scrcpy-server.jar …`
 * alive locally on the host PC. Our launcher's dedupe enumerates
 * Win32_Process for the literal word "scrcpy" anywhere in the cmdline, so
 * that orphan was matched → Launch returned alreadyRunning forever, even
 * though no real scrcpy.exe was visible.
 *
 * Tightening the matcher (already done in 2.16.17) prevents the false
 * positive, but the orphans themselves still pile up and waste a tcp:5037
 * connection per phone — they were forwarding the phone-side server's
 * frame stream into a now-dead pipe. This module proactively kills them.
 */

const { execFile, spawnSync } = require('child_process')
const os = require('os')

// Pure selector so the exclusion rules are testable without a process table.
//   adbChildren: [{ pid, parentPid }] — adb.exe with scrcpy-server.jar in cmdline
//   scrcpyPids:  [pid]                — every scrcpy.exe on the box
//   excludePids: [pid]                — scrcpy.exe windows this app owns and runs
// An adb child whose PARENT is an owned, live scrcpy is that mirror's on-device
// server shell, NOT an orphan — killing it tears a healthy mirror down with exit
// code 2. Only genuinely parentless children are reaped.
function _selectOrphanPids({ adbChildren = [], scrcpyPids = [], excludePids = [] } = {}) {
    const excludeSet = new Set((excludePids || []).map(Number))
    const adbPids = adbChildren
        .filter((child) => !excludeSet.has(Number(child && child.parentPid)))
        .map((child) => Number(child && child.pid))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    const strayScrcpyPids = excludeSet.size
        ? scrcpyPids.filter((p) => !excludeSet.has(Number(p)))
        : [...scrcpyPids]
    return { adbPids, scrcpyPids: strayScrcpyPids }
}

function killWindowsOrphans({ logger, excludePids } = {}) {
    const log = logger || (() => {})
    try {
        // Match BOTH conditions:
        //  - adb.exe image
        //  - cmdline contains "scrcpy-server.jar" (the only legit reason
        //    adb shell would have CLASSPATH=…/scrcpy-server.jar set)
        // Filter by Name first (cheap) before regexing CommandLine (expensive).
        // ParentProcessId comes along so an owned mirror's own child is spared.
        const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
            "$ErrorActionPreference='SilentlyContinue';" +
            " Get-CimInstance Win32_Process -Filter \"Name='adb.exe'\"" +
            " | Where-Object { $_.CommandLine -match 'scrcpy-server\\.jar' }" +
            " | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
        ], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
        const adbChildren = String(result.stdout || '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .map((s) => s.match(/^(\d+)\s+(\d+)$/))
            .filter(Boolean)
            .map((m) => ({ pid: parseInt(m[1], 10), parentPid: parseInt(m[2], 10) }))

        // 2.17.1: ALSO sweep scrcpy.exe windows themselves. Without this,
        // mirrors left open when Electron was closed appear "auto-opened"
        // on next boot with NO sidebar attached (the parent-child
        // bookkeeping for them is lost). Killing them on startup means
        // launching ShadowPhone is always a clean slate.
        let allScrcpyPids = []
        try {
            const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
                "$ErrorActionPreference='SilentlyContinue';" +
                " Get-CimInstance Win32_Process -Filter \"Name='scrcpy.exe'\"" +
                " | Select-Object -ExpandProperty ProcessId",
            ], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
            allScrcpyPids = String(r.stdout || '')
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => /^\d+$/.test(s))
                .map((s) => parseInt(s, 10))
        } catch (_) {}

        // Never kill an app-managed, live mirror's scrcpy.exe (caller passes the
        // PIDs of the scrcpy windows it currently owns) — nor that mirror's own
        // adb scrcpy-server.jar child. The old code excluded only the scrcpy.exe
        // list and force-killed every matching adb child, so a Stop on ONE phone
        // tore the on-device server out from under every other live mirror
        // (observed: live scrcpy 79716 still owning live adb child 10008).
        const { adbPids: pids, scrcpyPids } = _selectOrphanPids({
            adbChildren,
            scrcpyPids: allScrcpyPids,
            excludePids,
        })

        const allPids = [...pids, ...scrcpyPids]
        if (allPids.length === 0) return { killed: 0, pids: [] }
        for (const pid of allPids) {
            try {
                spawnSync('taskkill.exe', ['/F', '/PID', String(pid)], { windowsHide: true, timeout: 2000 })
            } catch (_) {}
        }
        log(`[scrcpy-orphan-killer] killed ${pids.length} adb-scrcpy-server child(ren) + ${scrcpyPids.length} scrcpy.exe orphan(s)`)
        return { killed: allPids.length, pids: allPids }
    } catch (e) {
        log(`[scrcpy-orphan-killer] win sweep failed: ${e?.message || e}`)
        return { killed: 0, pids: [], error: e?.message || String(e) }
    }
}

function killUnixOrphans({ logger } = {}) {
    const log = logger || (() => {})
    try {
        const result = spawnSync('pgrep', ['-f', 'scrcpy-server.jar'], { encoding: 'utf8', timeout: 3000 })
        const pids = String(result.stdout || '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => /^\d+$/.test(s))
            .map((s) => parseInt(s, 10))
        if (pids.length === 0) return { killed: 0, pids: [] }
        for (const pid of pids) {
            try { process.kill(pid, 'SIGKILL') } catch (_) {}
        }
        log(`[scrcpy-orphan-killer] killed ${pids.length} orphan(s): ${pids.join(',')}`)
        return { killed: pids.length, pids }
    } catch (e) {
        log(`[scrcpy-orphan-killer] unix sweep failed: ${e?.message || e}`)
        return { killed: 0, pids: [], error: e?.message || String(e) }
    }
}

function sweep({ logger, excludePids } = {}) {
    if (os.platform() === 'win32') return killWindowsOrphans({ logger, excludePids })
    return killUnixOrphans({ logger, excludePids })
}

module.exports = { sweep, _selectOrphanPids }
