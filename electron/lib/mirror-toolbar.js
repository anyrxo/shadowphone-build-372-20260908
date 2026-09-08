/**
 * Per-mirror floating toolbar.
 *
 * One small frameless always-on-top BrowserWindow per running scrcpy
 * mirror. Tracks the real scrcpy window position (via Win32 GetWindowRect
 * on Windows / AppleScript on macOS) so it stays glued to the right edge
 * even after the user drags the mirror, and survives DPI-scaling shifts
 * where scrcpy's --window-x/y end up clamped or rescaled.
 *
 * Closes automatically when its mirror process exits.
 */

const { BrowserWindow, screen, shell } = require('electron')
const { execFile } = require('child_process')
const pexecFile = require('util').promisify(execFile)
const path = require('path')
const os = require('os')
// 2.17.16: persistent diagnostic log for sidebar HWND re-find events.
// Without this, the "sidebar drifted off mirror → I re-found it" path
// only wrote to stdout, which VAs can't capture. Now goes to launcher.log
// next to every other launch event so triage is one file.
let _log = null;
try { _log = require('./launcher-log'); } catch (_) {}
function logEvt(event, data) { try { _log && _log.write(event, data); } catch (_) {} }

const toolbarWindows = new Map()      // serial -> BrowserWindow
// H6: parallel marker Set for headless (offscreen, non-focusable, never-shown)
// toolbar windows. A bare boolean keyed by serial avoids re-typing the
// toolbarWindows Map's value (which a dozen call sites read as a raw
// BrowserWindow). createToolbar consults this to refuse adopting a leaked
// headless window for a real mirror; createHeadlessToolbar may still reuse a
// VISIBLE toolbar. Cleared in every close/closed path that deletes the serial.
const headlessSerials = new Set()     // serial -> isHeadless (membership = headless)
const trackIntervals = new Map()      // serial -> interval handle
const lastBoundsBySerial = new Map()  // serial -> {x, y, w, h} (last applied)
// serial -> unsubscribe fn for the scrcpy foreground-follow win-event hook
const foregroundUnsubs = new Map()
// Serials whose mirror the operator explicitly pinned always-on-top
// (scrcpy:set-always-on-top IPC) — the rail must ride the same topmost band.
const pinnedSerials = new Set()
// Serials with an in-flight run (Create-IG / module run). While busy, the
// sidebar must NEVER be torn down: its live logs/progress render inside this
// window and losing it mid-run reads as a total stall. closeToolbar defers to
// pendingCloseSerials instead of destroying, and setToolbarBusy(serial,false)
// performs the deferred close only if the mirror is still gone by then.
//
// A REFCOUNT, not a flag: two Creates can target one serial (dashboard modal +
// mirror sidebar). Since v3.6.9 the claim is taken BEFORE the 45s lock wait, so
// the loser of that race also calls setToolbarBusy(serial,false) on its
// PHONE_BUSY bail-out. With a plain Set that release cleared the flag belonging
// to the FIRST, still-running, already-PAID create and stamped lastRunEndedAt —
// starting the post-run protection countdown mid-run, after which a transport
// flap destroyed the sidebar with the live create inside it. Only the LAST
// holder releases.
const busyRunCounts = new Map()  // serial -> in-flight run count
const pendingCloseSerials = new Set()
// serial -> live scrcpy pid the tracker is currently bound to. Lets the
// createToolbar reuse branch detect a respawn (new pid) and rebind tracking +
// the foreground hook instead of chasing the dead pid forever.
const trackedPidBySerial = new Map()
let win32Dock = null
try { win32Dock = require('./win32-dock') } catch (_) {}

const POLL_INTERVAL_MS = 300
// Orphan reaper threshold: consecutive PS-tracker ticks where no scrcpy window
// is found before we conclude the mirror is gone and self-close the toolbar.
// 10 * POLL_INTERVAL_MS (~3s) tolerates the normal miss burst during scrcpy
// startup/respawn (window found within ~600ms) while still reaping a truly
// orphaned toolbar quickly. Any tracker hit resets the streak.
const ORPHAN_MISS_LIMIT = 10
const TOOLBAR_WIDTH = 156
// 2.16.57: width of the live-logs slide-out panel when toggled open.
const LOG_PANEL_WIDTH = 360
const ACCOUNT_PANEL_WIDTH = 420
const TOOLBAR_GAP_PX = 6
const panelModeBySerial = new Map()
const customWidthBySerial = new Map()
function clampCompactWidth(width) {
    return Math.max(TOOLBAR_WIDTH, Math.min(TOOLBAR_WIDTH * 4, Math.round(Number(width) || TOOLBAR_WIDTH)))
}
function getCurrentToolbarWidth(serial) {
    const mode = panelModeBySerial.get(serial) || 'compact'
    const compactWidth = customWidthBySerial.get(serial) || TOOLBAR_WIDTH
    if (mode === 'logs') return compactWidth + LOG_PANEL_WIDTH
    if (mode === 'account') return ACCOUNT_PANEL_WIDTH
    return compactWidth
}
function setPanelMode(serial, mode) {
    if (!['compact', 'logs', 'account'].includes(mode)) return false
    const win = toolbarWindows.get(serial)
    if (!win || win.isDestroyed()) return false
    const previousMode = panelModeBySerial.get(serial)
    panelModeBySerial.set(serial, mode)
    // Invalidate the tracker's last-applied bounds so the next PS-tracker tick
    // re-applies the new width even if the mirror is stationary. The x/y/h
    // dedup in applyBoundsFromMirror would otherwise early-return on a still
    // mirror and let the panel state desync from the window width after a toggle.
    lastBoundsBySerial.delete(serial)
    try {
        const cur = win.getBounds()
        win.setBounds({ x: cur.x, y: cur.y, width: getCurrentToolbarWidth(serial), height: cur.height })
        return true
    } catch (_) {
        if (previousMode) panelModeBySerial.set(serial, previousMode)
        else panelModeBySerial.delete(serial)
        return false
    }
}
function broadcastLiveLog(line) {
    for (const w of toolbarWindows.values()) {
        if (w && !w.isDestroyed()) {
            try { w.webContents.send('live-log', line) } catch (_) {}
        }
    }
}
// 2.18.11: module-progress events were going to mainWindow ONLY (dashboard),
// so the per-toolbar LIVE pane never received them. Anyro: "live logs broken
// still also … hit run now and its just a black screen". This fans the same
// event to every open toolbar so the LIVE pane lights up when Run Now fires.
function broadcastModuleProgress(payload) {
    for (const w of toolbarWindows.values()) {
        if (w && !w.isDestroyed()) {
            try { w.webContents.send('module-progress', payload) } catch (_) {}
        }
    }
}
// webContents ids of every open toolbar, so sendModuleProgress can skip them when
// fanning module-progress to the models-dashboard window — they're already served
// by broadcastModuleProgress above, and double-sending would duplicate every log.
function getToolbarWebContentsIds() {
    const ids = []
    for (const w of toolbarWindows.values()) if (w && !w.isDestroyed()) ids.push(w.webContents.id)
    return ids
}
// No height floor — the toolbar matches scrcpy's height exactly. Content
// scrolls inside .col if needed; phones are tall enough (~400-800 CSS px)
// that the full pill stack fits without scrolling in practice.
const MIN_TOOLBAR_HEIGHT = 200
const DEBUG_TRACK = process.env.SP_TOOLBAR_DEBUG === '1' || false

/**
 * Find the actual screen rect (in DEVICE pixels) of the scrcpy window.
 * Win32 prefers the process PID and falls back to the requested title.
 * Returns null if not found, or a presence marker while minimized/hidden.
 */
async function getScrcpyWindowBoundsDevicePx(scrcpyPid, title) {
    if (!scrcpyPid && !title) return null
    const platform = os.platform()
    try {
        if (platform === 'win32') {
            // Find scrcpy process whose MainWindowTitle matches (exact or
            // suffix containing serial prefix — handles unicode mangling on
            // titles like "Pixelated3 · 1A121FDF" where the middle-dot can
            // get encoded differently). Then GetWindowRect on its handle.
            const safePid = Number.isInteger(Number(scrcpyPid)) && Number(scrcpyPid) > 0
                ? Number(scrcpyPid)
                : 0
            const safeTitle = String(title).replace(/'/g, "''")
            const psScript = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
# CRITICAL (HiDPI fix): powershell.exe is DPI-UNAWARE by default, so GetWindowRect
# returns DPI-VIRTUALIZED (logical) coords on scaled displays. The caller
# (deviceToCssPixels) divides by scaleFactor expecting PHYSICAL/device px — without
# this, on a 2x display the mirror rect is HALVED, making the toolbar half-height
# (compressed) AND positioned at half-X (overlapping the mirror instead of docking
# beside it). Become per-monitor-DPI-aware (v2 = -4) so GetWindowRect returns true
# physical px; fall back to system-aware (SetProcessDPIAware) on pre-1703 builds.
try { [void][W]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][W]::SetProcessDPIAware() } catch {} }
$wantedPid = ${safePid}
$wanted = '${safeTitle}'
$procs = Get-Process -Name scrcpy -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output 'NO_SCRCPY'; return }
$match = $null
if ($wantedPid -gt 0) {
    $match = Get-Process -Id $wantedPid -ErrorAction SilentlyContinue
    if ($match -and $match.ProcessName -ne 'scrcpy') { $match = $null }
}
if (-not $match) {
    foreach ($p in $procs) {
        if (-not $p.MainWindowHandle -or $p.MainWindowHandle -eq 0) { continue }
        if ($p.MainWindowTitle -eq $wanted) { $match = $p; break }
    }
}
if (-not $match) {
    # Suffix-match: scrcpy titles end with "<nick> · <serialPrefix>".
    # Compare the trailing serial-prefix token (last 8 chars before space-fold).
    $tail = ($wanted -split ' ')[ -1 ]
    if ($tail) {
        foreach ($p in $procs) {
            if (-not $p.MainWindowHandle -or $p.MainWindowHandle -eq 0) { continue }
            if ($p.MainWindowTitle -like ('*' + $tail + '*')) { $match = $p; break }
        }
    }
}
if (-not $match -and $wantedPid -le 0 -and $procs.Count -eq 1) { $match = $procs[0] }
if (-not $match) { Write-Output 'NO_SCRCPY'; return }
$h = $match.MainWindowHandle
if (-not $h -or $h -eq 0 -or -not [W]::IsWindowVisible($h) -or [W]::IsIconic($h)) {
    Write-Output "PRESENT"
    return
}
$r = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref] $r)
Write-Output ("{0},{1},{2},{3}" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
`
            const result = await pexecFile('powershell.exe',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
                { encoding: 'utf8', windowsHide: true, timeout: 2500 }
            ).catch(e => ({ stdout: e?.stdout || '' }))
            const line = String(result.stdout || '').trim().split(/\r?\n/).pop() || ''
            // Confirmed absence — the probe ran to completion and scrcpy is
            // genuinely gone for this mirror. This is the ONLY reapable signal.
            if (line === 'NO_SCRCPY') return null
            if (line === 'PRESENT') return { present: true }
            const parts = line.split(',').map(s => parseInt(s, 10))
            // Anything else — blank stdout from a 2.5s PowerShell timeout (the
            // .catch path above), a partial line, or an unparseable rect — is a
            // PROBE ERROR, not proof the mirror died. Signal it distinctly so the
            // reaper never counts a slow probe as an orphan miss: 10 consecutive
            // timeouts under create-flow system thrash (adb-server restart,
            // companion installer, VPN) used to false-reap a live rail + its logs.
            if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return { probeError: true }
            const [L, T, R, B] = parts
            if (R - L < 100 || B - T < 100) return { probeError: true }
            return { x: L, y: T, w: R - L, h: B - T }
        }

        if (platform === 'darwin') {
            // Use AppleScript via osascript. Requires Accessibility permission
            // for Electron — first call will surface the system prompt.
            const safeTitle = String(title).replace(/"/g, '\\"')
            const script = `
tell application "System Events"
    if exists (process "scrcpy") then
        tell process "scrcpy"
            repeat with w in windows
                if (name of w) is "${safeTitle}" then
                    set p to position of w
                    set s to size of w
                    return (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of s) & "," & (item 2 of s)
                end if
            end repeat
        end tell
    end if
end tell
`
            const result = await pexecFile('osascript', ['-e', script], {
                encoding: 'utf8', timeout: 2000
            }).catch(e => ({ stdout: e?.stdout || '' }))
            const line = String(result.stdout || '').trim()
            const parts = line.split(',').map(s => parseInt(String(s).trim(), 10))
            if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null
            // AppleScript returns position+size in points (already logical px on macOS).
            return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
        }
    } catch (e) {
        // Polling failure is best-effort — never let it bubble.
    }
    return null
}

/**
 * Convert device pixels (Win32 returns these) to Electron CSS pixels.
 * On macOS we already get points, so this is a no-op there.
 */
function deviceToCssPixels(rectDevicePx) {
    if (!rectDevicePx) return null
    if (os.platform() === 'darwin') return { ...rectDevicePx }
    try {
        // screen.getDisplayNearestPoint expects LOGICAL (CSS) pixels, but
        // GetWindowRect returns device pixels. On a 150% display the raw center is
        // 1.5x too large and can resolve the WRONG neighbouring monitor.
        // Instead, iterate all displays and find the one whose device-pixel rect
        // contains the GetWindowRect center — no chicken-and-egg issue.
        const cx = rectDevicePx.x + rectDevicePx.w / 2
        const cy = rectDevicePx.y + rectDevicePx.h / 2
        const displays = screen.getAllDisplays()
        let display = displays.find(d => {
            const sf = d.scaleFactor || 1
            const dx = d.bounds.x * sf, dy = d.bounds.y * sf
            const dw = d.bounds.width * sf, dh = d.bounds.height * sf
            return cx >= dx && cx < dx + dw && cy >= dy && cy < dy + dh
        }) || screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) })
        const scale = display?.scaleFactor || 1
        return {
            x: Math.round(rectDevicePx.x / scale),
            y: Math.round(rectDevicePx.y / scale),
            w: Math.round(rectDevicePx.w / scale),
            h: Math.round(rectDevicePx.h / scale),
        }
    } catch (_) {
        return { ...rectDevicePx }
    }
}

function computeToolbarBounds(mirrorRectCss, workArea, toolbarWidth) {
    const targetH = Math.max(mirrorRectCss.h, MIN_TOOLBAR_HEIGHT)
    let targetX = mirrorRectCss.x + mirrorRectCss.w + TOOLBAR_GAP_PX
    if (targetX + toolbarWidth > workArea.x + workArea.width) {
        const leftX = mirrorRectCss.x - TOOLBAR_GAP_PX - toolbarWidth
        targetX = leftX >= workArea.x
            ? leftX
            : Math.max(workArea.x, workArea.x + workArea.width - toolbarWidth)
    }
    targetX = Math.min(
        Math.max(targetX, workArea.x),
        Math.max(workArea.x, workArea.x + workArea.width - toolbarWidth),
    )
    const targetY = Math.max(
        workArea.y,
        Math.min(mirrorRectCss.y, workArea.y + workArea.height - Math.min(targetH, workArea.height)),
    )
    return { x: targetX, y: targetY, width: toolbarWidth, height: targetH }
}

function applyBoundsFromMirror(serial, mirrorRectCss) {
    const win = toolbarWindows.get(serial)
    if (!win || win.isDestroyed()) return false
    // Reject only obvious garbage — zero-size, way off-screen. Real scrcpy
    // windows can be as narrow as ~120 CSS px on high-DPI displays, and Y
    // can go slightly negative when Windows places near the top edge.
    if (!mirrorRectCss) return false
    if (mirrorRectCss.w < 80 || mirrorRectCss.h < 80) return false
    if (mirrorRectCss.x < -2000 || mirrorRectCss.y < -2000) return false
    // Clamp y to display work-area top so the toolbar isn't above the screen.
    const display = screen.getDisplayNearestPoint({
        x: Math.round(mirrorRectCss.x + mirrorRectCss.w / 2),
        y: Math.round(mirrorRectCss.y + mirrorRectCss.h / 2),
    })
    const wa = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 }
    const targetW = getCurrentToolbarWidth(serial)
    const target = computeToolbarBounds(mirrorRectCss, wa, targetW)
    const last = lastBoundsBySerial.get(serial)
    if (last && last.x === target.x && last.y === target.y && last.h === target.height && last.w === target.width) return true
    lastBoundsBySerial.set(serial, { x: target.x, y: target.y, h: target.height, w: target.width })
    try {
        win.setBounds(target)
        return true
    } catch (_) { return false }
}
function setLogsExpanded(serial, on) {
    return setPanelMode(serial, on ? 'logs' : 'compact')
}

function startTracking(serial, scrcpyPid, mirrorTitle, onPositioned) {
    if (trackIntervals.has(serial)) return false
    // Remember which pid this tracker is bound to so a respawn (new pid) on a
    // toolbar-reuse can rebind instead of chasing the dead pid (spurious reap).
    trackedPidBySerial.set(serial, scrcpyPid)
    let logged = 0
    let positionReported = false
    // Per-serial in-flight guard. The probe is now async (promisified
    // execFile) and a slow PowerShell call can outlast the 300ms interval;
    // without this, ticks would pile up and overlap. Skipping a tick while
    // one is in flight preserves the old sync "one probe at a time, never
    // overlapping" semantic that spawnSync gave for free.
    const inFlight = { busy: false }
    // Consecutive misses are the live orphan signal. A sustained miss run closes
    // the sibling sidebar so no tracker or always-on-top window is left behind.
    let missStreak = 0
    const tick = async () => {
        if (inFlight.busy) return
        const win = toolbarWindows.get(serial)
        if (!win || win.isDestroyed()) {
            stopTracking(serial)
            return
        }
        inFlight.busy = true
        try {
            const deviceRect = await getScrcpyWindowBoundsDevicePx(scrcpyPid, mirrorTitle)
            if (deviceRect && deviceRect.probeError) {
                // Probe timed out / errored (PowerShell starved under adb-server
                // restart, companion installer, or VPN thrash) — NOT proof the
                // mirror is gone. Never advance the orphan streak, or 10 slow
                // probes would reap a live sidebar mid-run (with all its logs).
                if (logged < 3) { console.log(`[toolbar] tick probe error for "${mirrorTitle}" — not counting as an orphan miss`); logged++ }
                return
            }
            if (!deviceRect) {
                if (logged < 3) { console.log(`[toolbar] tick miss for "${mirrorTitle}" — no scrcpy window found yet`); logged++ }
                missStreak += 1
                if (missStreak >= ORPHAN_MISS_LIMIT) {
                    console.warn(`[toolbar] scrcpy gone for "${mirrorTitle}" (${missStreak} misses) — reaping orphan toolbar ${serial}`)
                    logEvt('mirror-toolbar:orphan-reaped', { serial, mirrorTitle, missStreak })
                    closeToolbar(serial)  // stops tracking (clears this interval) + closes the window
                }
                return
            }
            if (deviceRect.present) {
                missStreak = 0
                return
            }
            missStreak = 0
            // Re-check destroyed AFTER the await — the mirror may have closed
            // during the PowerShell call.
            const win2 = toolbarWindows.get(serial)
            if (!win2 || win2.isDestroyed()) return
            const cssRect = deviceToCssPixels(deviceRect)
            if (!cssRect) return
            if (logged < 3) { console.log(`[toolbar] tick hit for "${mirrorTitle}" device=${JSON.stringify(deviceRect)} css=${JSON.stringify(cssRect)}`); logged++ }
            if (applyBoundsFromMirror(serial, cssRect) && !positionReported) {
                positionReported = true
                if (typeof onPositioned === 'function') onPositioned()
            }
        } finally {
            inFlight.busy = false
        }
    }
    // First poll quickly — scrcpy window usually shows up within ~600ms.
    setTimeout(tick, 250)
    setTimeout(tick, 700)
    setTimeout(tick, 1500)
    const handle = setInterval(tick, POLL_INTERVAL_MS)
    trackIntervals.set(serial, handle)
    return true
}

function stopTracking(serial) {
    const h = trackIntervals.get(serial)
    if (h) clearInterval(h)
    trackIntervals.delete(serial)
    trackedPidBySerial.delete(serial)
    lastBoundsBySerial.delete(serial)
    try { foregroundUnsubs.get(serial)?.() } catch (_) {}
    foregroundUnsubs.delete(serial)
    // Free the panel-width state when a toolbar goes away. stopTracking is called
    // from BOTH teardown paths (closeToolbar + the visible win.on('closed')
    // guard), so this single delete covers both without touching create paths
    // (createToolbar wipes the flag before any width read; createHeadlessToolbar
    // never reads it). The headless 'closed' handler never sets the flag.
    panelModeBySerial.delete(serial)
    customWidthBySerial.delete(serial)
}

function createToolbar({ serial, x, y, height, mirrorTitle, scrcpyPid, transport, tailnetIp }) {
    // A fresh toolbar always starts compact. Only an accepted main-process
    // mode request can widen it after creation.
    panelModeBySerial.delete(serial)

    if (toolbarWindows.has(serial)) {
        const existing = toolbarWindows.get(serial)
        if (existing && !existing.isDestroyed()) {
            // H6: never adopt a headless (offscreen, never-shown) window as a
            // real mirror sidebar — it stays hidden (only setBounds, no .show())
            // and lacks the docking/hoist machinery, producing the long-reported
            // "sidebar didn't come with the mirror" symptom. Close the leaked
            // headless window and fall through to build a proper visible one.
            if (headlessSerials.has(serial)) {
                headlessSerials.delete(serial)
                toolbarWindows.delete(serial)
                try { existing.destroy() } catch (_) {}
            } else {
                try { existing.setBounds({ x, y, width: getCurrentToolbarWidth(serial), height: Math.max(height, MIN_TOOLBAR_HEIGHT) }) } catch (_) {}
                // The mirror is back for this serial — cancel any close that was
                // deferred while a run held the panel open, so setToolbarBusy
                // (and its grace timer) won't later tear down this now-healthy,
                // re-docked window.
                pendingCloseSerials.delete(serial)
                const _pt = pendingCloseTimers.get(serial)
                if (_pt) { clearTimeout(_pt); pendingCloseTimers.delete(serial) }
                // Respawn-rebind: if scrcpy was relaunched with a NEW pid, the
                // tracker + foreground hook are still bound to the DEAD pid and
                // would miss forever (spurious reap). Rebind both to the live pid.
                const boundPid = trackedPidBySerial.get(serial)
                if (scrcpyPid && boundPid !== scrcpyPid) {
                    stopTracking(serial)
                    const canFollow = process.platform === 'win32' && !!scrcpyPid && !!(win32Dock && win32Dock.available())
                    if (canFollow) {
                        try { foregroundUnsubs.get(serial)?.() } catch (_) {}
                        foregroundUnsubs.set(serial, win32Dock.subscribeForeground(scrcpyPid, () => {
                            const w = toolbarWindows.get(serial)
                            if (w && !w.isDestroyed() && !pinnedSerials.has(serial)) {
                                try { w.moveTop() } catch (_) {}
                            }
                        }))
                    }
                    startTracking(serial, scrcpyPid, mirrorTitle || serial)
                }
                return existing
            }
        }
    }

    const win = new BrowserWindow({
        width: getCurrentToolbarWidth(serial),
        height: Math.max(height, MIN_TOOLBAR_HEIGHT),
        x,
        y,
        frame: false,
        // 2.19.15: resizable so the user can drag the right edge wider when
        // long content (account names, schedule labels) overflows the
        // default 156px column. Anyro: "allow ability to widen the sidebar
        // if needed/resize if we want to". Min/max enforced via setMinimumSize
        // below so the window can't collapse below TOOLBAR_WIDTH.
        resizable: true,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        // 2.19.20: constructor alwaysOnTop:false — let setAlwaysOnTop() below own
        // the z-band. Setting it true here plus 'screen-saver' post-construction on
        // a hidden window caused DWM to defer compositor surface allocation, producing
        // a window whose HWND was visible but had no swap-chain to present (black).
        alwaysOnTop: false,
        skipTaskbar: true,
        focusable: true,
        backgroundColor: '#0a0a0a',
        // 2.19.6: start HIDDEN. Anyro hit "collapsed sidebar behind the phone"
        // on launch 2026-05-26: the toolbar window was shown immediately,
        // then scrcpy spawned alwaysOnTop and z-ordered itself ABOVE the
        // toolbar before the dock-as-owner logic could establish the
        // owner relationship. Result: toolbar visible but stuck behind
        // the mirror until user closes+relaunches. By starting hidden
        // and only showing AFTER dock + alwaysOnTop are confirmed, the
        // toolbar pops in already correctly z-ordered.
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', 'mirror-toolbar-preload.js'),
            // Direct window.toolbar injection (preload sets it) — works in any
            // Electron version without contextBridge edge cases that left the
            // 2.16.1 first attempt with 'API missing — preload failed'.
            contextIsolation: false,
            nodeIntegration: true,
            sandbox: false,
            // Keep timers full-speed even when the toolbar is backgrounded, so the
            // workflow runner's per-step timeout fires reliably during a run the
            // operator clicked away from.
            backgroundThrottling: false,
        },
    })
    // 2.19.15: clamp width range so user-drag-resize can widen up to 4x the
    // base column but never collapse below 156. Height stays elastic to scrcpy.
    try {
        win.setMinimumSize(TOOLBAR_WIDTH, MIN_TOOLBAR_HEIGHT)
        win.setMaximumSize((TOOLBAR_WIDTH * 4) + LOG_PANEL_WIDTH, 30000)
    } catch (_) {}
    win.on('resize', () => {
        if (!win || win.isDestroyed()) return
        const mode = panelModeBySerial.get(serial) || 'compact'
        if (mode === 'account') return
        const width = win.getBounds().width - (mode === 'logs' ? LOG_PANEL_WIDTH : 0)
        const next = clampCompactWidth(width)
        if (customWidthBySerial.get(serial) === next) return
        customWidthBySerial.set(serial, next)
        lastBoundsBySerial.delete(serial)
    })

    // 2.17.4 / 2.19.20: 'pop-up-menu' (HWND_TOPMOST only) replaces 'screen-saver'.
    // 'screen-saver' applied an extra SWP z-band flag to a never-shown window,
    // causing DWM to defer compositor surface allocation — Chromium rendered frames
    // (capturePage returned valid pixels) but DWM had no swap-chain to present
    // (black window on screen). 'pop-up-menu' is pure HWND_TOPMOST — same effective
    // position above scrcpy without triggering the DWM surface-allocation deferral.
    //
    // z-band policy (Anyro: "why does the sidebar prio over the top of every
    // screen and item, but not the scrcpy window?"): the rail rides WITH its
    // mirror instead of floating topmost over the whole desktop. Normal z-band
    // + a foreground-follow hook (below) lifts it back above scrcpy whenever
    // the mirror is focused, so the pair z-orders as one unit. Topmost is kept
    // only when the operator pinned this mirror on top, or when we cannot
    // follow scrcpy's focus (no pid / koffi unavailable / non-win32) — owner-
    // docking is NOT an option: the reparent black-screens the rail (3a58749e).
    const canFollowMirror = process.platform === 'win32' && !!scrcpyPid && !!(win32Dock && win32Dock.available())
    const applyZBand = () => {
        if (!win || win.isDestroyed()) return
        if (pinnedSerials.has(serial) || !canFollowMirror) {
            try { win.setAlwaysOnTop(true, 'pop-up-menu') } catch (_) {
                try { win.setAlwaysOnTop(true, 'floating') } catch (_) {}
            }
        } else {
            try { win.setAlwaysOnTop(false) } catch (_) {}
        }
        try { win.moveTop() } catch (_) {}
    }
    applyZBand()
    // DWM surface allocation: show() at construction (cloaked at opacity 0) forces
    // DWM to allocate the swap-chain surface immediately — exactly like the working
    // scrcpy-loading-overlay which has no show:false and renders at construction.
    // Without this, a show:false window defers surface allocation until the first
    // ShowWindow call; if that fires after the renderer has already painted, DWM
    // presents black (Chromium back-buffer has content, but the swap-chain wasn't
    // ready). Opacity 0 keeps the window visually invisible until positioned,
    // preserving the no-premature-flash behavior that show:false originally provided.
    try { win.setOpacity(0) } catch (_) {}
    try { win.show() } catch (_) {}
    try { win.moveTop() } catch (_) {}
    // Keep the window transparent until both Chromium's first frame and the
    // sibling tracker have produced a real, non-overlapping position.
    let firstFrameReady = false
    let firstPositionReady = false
    let revealed = false
    const revealWhenReady = (force = false) => {
        if (revealed || !win || win.isDestroyed()) return
        if (!force && !(firstFrameReady && firstPositionReady)) return
        revealed = true
        try { win.setOpacity(1) } catch (_) {}
        applyZBand()
    }
    const _hoistToolbar = () => {
        if (!win || win.isDestroyed()) return
        applyZBand()
    }
    setTimeout(_hoistToolbar, 100)
    setTimeout(_hoistToolbar, 400)
    setTimeout(_hoistToolbar, 1000)
    setTimeout(_hoistToolbar, 2000)
    setTimeout(_hoistToolbar, 3500)

    // Safety: a restricted PowerShell environment must not leave the rail hidden.
    setTimeout(() => {
        revealWhenReady(true)
    }, 4000);

    const html = path.join(__dirname, '..', 'mirror-toolbar.html')
    const params = new URLSearchParams({
        serial,
        mirrorTitle: mirrorTitle || serial,
        transport: transport || 'usb',
        tailnetIp: tailnetIp || '',
    })
    win.loadFile(html, { search: params.toString() })

    // BLACK-SIDEBAR self-heal + diagnostics. If the page fails to load or the
    // renderer crashes, the window shows only its #0a0a0a backgroundColor with
    // no content (the "black sidebar" the operator hit). Log the cause to
    // launcher.log and retry the load so a transient failure recovers instead
    // of leaving a dead black panel.
    //
    // 2.19.20: show on 'ready-to-show' instead of 'did-finish-load'.
    // did-finish-load fires when the document is parsed / JS has run — BEFORE
    // Chromium produces a composited frame. Calling win.show() at that point gives
    // DWM a WM_SHOWWINDOW with no first-frame in its swap-chain, so the window
    // presents as black even though capturePage() returns valid pixels (Chromium's
    // offscreen back-buffer has content but DWM hasn't composited it yet).
    // ready-to-show fires after the first frame is composited — DWM gets
    // WM_SHOWWINDOW with a live swap-chain, so the window presents with content.
    // The 1px setBounds nudge is removed: it was compensating for the wrong show
    // timing and is unnecessary once show() fires after the first composite.
    let _reloadTries = 0
    let _loaded = false
    const _revealWhenPainted = () => {
        firstFrameReady = true
        revealWhenReady()
    }
    // ready-to-show: first composited frame is ready — safe to show with content.
    win.once('ready-to-show', _revealWhenPainted)
    // did-finish-load: page parsed/JS run — mark loaded for watchdog, but do NOT show here.
    win.webContents.on('did-finish-load', () => { _loaded = true })
    // DEFINITIVE DIAGNOSTIC: capturePage() reads what Chromium actually RENDERED
    // (independent of window presentation). A large PNG => the page rendered real
    // content but the WINDOW won't present it (GPU compositing bug → disable-gpu-
    // compositing is the fix). A tiny PNG => the page itself rendered black (CSS).
    win.webContents.on('did-finish-load', () => {
        setTimeout(() => {
            try {
                win.webContents.capturePage().then(img => {
                    try { logEvt('mirror-toolbar:capture', { serial, pngBytes: img.toPNG().length, size: img.getSize() }) } catch (_) {}
                }).catch(e => logEvt('mirror-toolbar:capture-fail', { serial, err: String(e && e.message || e) }))
            } catch (_) {}
        }, 1500)
    })
    // Load WATCHDOG: covers the case where loadFile never fires did-finish-load
    // NOR did-fail-load (a silent hang — the remaining black-sidebar mode). If the
    // page hasn't loaded in 3.5s, force one reload. Logged so we can see if it hit.
    setTimeout(() => {
        if (_loaded || !win || win.isDestroyed() || _reloadTries >= 2) return
        _reloadTries++
        logEvt('mirror-toolbar:load-watchdog-reload', { serial })
        console.warn('[mirror-toolbar] load watchdog — page never finished loading, reloading')
        try { win.loadFile(html, { search: params.toString() }) } catch (_) {}
    }, 3500)
    win.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
        if (code === -3) return // ERR_ABORTED — normal on rapid reload, ignore
        logEvt('mirror-toolbar:did-fail-load', { serial, code, desc, validatedURL })
        console.warn('[mirror-toolbar] did-fail-load', code, desc)
        if (_reloadTries < 2 && win && !win.isDestroyed()) {
            _reloadTries++
            setTimeout(() => { try { win.loadFile(html, { search: params.toString() }) } catch (_) {} }, 250)
        }
    })
    win.webContents.on('render-process-gone', (_e, d) => {
        logEvt('mirror-toolbar:render-gone', { serial, reason: d && d.reason })
        console.warn('[mirror-toolbar] render-gone', d && d.reason)
        if (_reloadTries < 2 && win && !win.isDestroyed()) {
            _reloadTries++
            setTimeout(() => { try { win.reload() } catch (_) {} }, 250)
        }
    })
    // Electron >= 37 emits ONE `details` object; the old (event, level, message)
    // signature left `level` undefined, so `level >= 2` was always false and
    // EVERY renderer error was dropped — 0 `mirror-toolbar:console` events across
    // 60 sidebar loads in 28,844 log lines. That silence is why a renderer-side
    // failure in the Create modal could not be seen at all. Accept both shapes.
    win.webContents.on('console-message', (...args) => {
        const d = args[0] && typeof args[0] === 'object' && 'level' in args[0] ? args[0] : null
        const level = d ? d.level : args[1]
        const message = d ? d.message : args[2]
        const isProblem = level === 'error' || level === 'warning' || (typeof level === 'number' && level >= 2)
        if (isProblem) logEvt('mirror-toolbar:console', { serial, level, message: String(message ?? '').slice(0, 300) })
    })

    // Navigation/window-open allowlist. The toolbar only ever loads the local
    // mirror-toolbar.html, so deny ALL window.open() popups (route http/https
    // to the system browser) and block any navigation away from file://.
    // Mirrors the deny-all guard the main window already applies (main.js:680/703)
    // — closes the gap that this nodeIntegration+contextIsolation:false window
    // had none. Purely additive: no legitimate toolbar flow navigates or opens
    // a window, so nothing breaks.
    win.webContents.setWindowOpenHandler(({ url }) => {
        try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url) } catch (_) {}
        return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault()
    })

    win.on('closed', () => {
        // Guard: a stale (already-superseded) window must only tear down the
        // serial slot if it still owns it. Electron emits 'closed'
        // asynchronously, so an OLD window's handler can otherwise clobber the
        // NEW window's tracking after toolbarWindows.set(serial, win) ran.
        if (toolbarWindows.get(serial) === win) {
            stopTracking(serial)
            toolbarWindows.delete(serial)
            headlessSerials.delete(serial)
        }
    })

    // H6: this is a real visible toolbar — make sure the serial is NOT marked
    // headless (e.g. after evicting a leaked headless window above).
    headlessSerials.delete(serial)
    toolbarWindows.set(serial, win)

    // Foreground-follow: when the mirror is focused, lift the rail directly
    // back above it (still in the normal z-band). Every other window the
    // operator raises covers BOTH — the behavior the topmost pin broke.
    if (canFollowMirror) {
        try { foregroundUnsubs.get(serial)?.() } catch (_) {}
        foregroundUnsubs.set(serial, win32Dock.subscribeForeground(scrcpyPid, () => {
            const w = toolbarWindows.get(serial)
            if (w && !w.isDestroyed() && !pinnedSerials.has(serial)) {
                try { w.moveTop() } catch (_) {}
            }
        }))
    }

    startTracking(serial, scrcpyPid, mirrorTitle || serial, () => {
        firstPositionReady = true
        revealWhenReady()
    })

    return win
}

// `force` = the operator (or the app) deliberately tore this mirror down:
// stop-scrcpy, stop-all, a transport switch, a headless window we created. Those
// must close NOW — the post-run protection below exists only to survive an
// UNREQUESTED transport death, and making an explicit Close linger 15s would
// read as its own bug. force never overrides the v3.6.0 in-flight-run guard.
function closeToolbar(serial, { force = false } = {}) {
    // HARD GUARANTEE: never destroy the sidebar while a run is in-flight on this
    // phone. Its live logs/progress render inside this window, so tearing it down
    // mid-run (from the orphan reaper OR the scrcpy-exit teardown) reads as a
    // total stall — the operator loses everything. Defer the close instead: stop
    // the tracker so it stops chasing a possibly-dead pid, remember the request,
    // and honor it in setToolbarBusy(serial,false) only if the mirror is still
    // gone by then. This is the single choke-point covering EVERY teardown caller.
    if (busyRunCounts.has(serial)) {
        pendingCloseSerials.add(serial)
        stopTracking(serial)
        logEvt('mirror-toolbar:close-deferred', { serial, reason: 'run-in-flight' })
        try { broadcastLiveLog('Mirror lost mid-run — keeping this panel open so logs survive; it will re-dock or close when the run ends.') } catch (_) {}
        return
    }
    // v3.6.9: the busy check above NEVER fired in the field (zero
    // `mirror-toolbar:close-deferred` in 28,844 launcher.log lines) because the
    // real ordering is the reverse of the one it guards: one adb collapse
    // fast-fails the create FIRST (the operator sees the capacity error), the
    // finally clears busy with no close pending — so no grace timer is armed —
    // and the mirror dies a few seconds LATER onto an unprotected sidebar, which
    // was then destroyed together with the operator's open Create modal. Keep
    // the panel for a short window after a run ends too, and honour the close
    // through the same grace machinery.
    if (!force && _withinPostRunWindow(serial)) {
        pendingCloseSerials.add(serial)
        stopTracking(serial)
        logEvt('mirror-toolbar:close-deferred', { serial, reason: 'post-run-window' })
        try { broadcastLiveLog('Mirror dropped right after a run — keeping this panel open; it will re-dock or close shortly.') } catch (_) {}
        _schedulePendingClose(serial)
        return
    }
    _executeClose(serial)
}

// The unguarded teardown. Only closeToolbar (after its defer checks) and the
// grace timer may call this — the timer must NOT re-enter closeToolbar or the
// post-run window would keep re-deferring its own honoured close forever.
function _executeClose(serial) {
    stopTracking(serial)
    const _pt = pendingCloseTimers.get(serial)
    if (_pt) { clearTimeout(_pt); pendingCloseTimers.delete(serial) }
    pendingCloseSerials.delete(serial)
    const win = toolbarWindows.get(serial)
    if (win && !win.isDestroyed()) {
        try { win.close() } catch (_) {}
    }
    toolbarWindows.delete(serial)
    headlessSerials.delete(serial)
    lastRunEndedAt.delete(serial)
}

// Grace window after a run ends before honoring a deferred close. A transport
// flap that closes the mirror mid-run (the exact "live profile could not be
// verified" case: the detector fails on the flap, the run fast-fails, busy
// clears) usually REOPENS the mirror a beat later via the fast-fail retry /
// watchdog relaunch. createToolbar's reuse branch cancels the pending close
// when that happens. Destroying immediately on busy-clear raced the reopen and
// vanished the sidebar right before the mirror came back. Wait this long for
// the mirror to return; only close if it's still gone after it.
const MIRROR_RETURN_GRACE_MS = 15_000
const pendingCloseTimers = new Map() // serial -> grace timer handle
// How long after a run ends the sidebar still refuses to be destroyed. Covers
// the observed lag between a create fast-failing and the transport death that
// caused it actually killing scrcpy (18.1s from submit, ~2s after the run
// returned). Must stay >= MIRROR_RETURN_GRACE_MS so the deferred close is always
// honoured by the grace timer rather than by a second bare closeToolbar.
const POST_RUN_SIDEBAR_PROTECT_MS = 20_000
const lastRunEndedAt = new Map()     // serial -> ts of the last run end

function _withinPostRunWindow(serial) {
    const endedAt = lastRunEndedAt.get(serial)
    return typeof endedAt === 'number' && (Date.now() - endedAt) < POST_RUN_SIDEBAR_PROTECT_MS
}

// Arm (once) the window in which a mirror that comes back cancels the pending
// close. createToolbar's reuse branch clears pendingCloseSerials + this timer.
function _schedulePendingClose(serial) {
    if (!pendingCloseSerials.has(serial)) return
    if (pendingCloseTimers.has(serial)) return // grace already scheduled
    const timer = setTimeout(() => {
        pendingCloseTimers.delete(serial)
        // Mirror returned (createToolbar reuse cleared the pending close) or a
        // new run started — keep the sidebar.
        if (!pendingCloseSerials.has(serial) || busyRunCounts.has(serial)) return
        pendingCloseSerials.delete(serial)
        _executeClose(serial)
    }, MIRROR_RETURN_GRACE_MS)
    try { timer.unref?.() } catch (_) {}
    pendingCloseTimers.set(serial, timer)
}

// Mark/clear an in-flight run for a phone so closeToolbar keeps its sidebar
// (and logs) alive for the duration. Clearing busy schedules any deferred close
// behind a grace window instead of firing it immediately — so a mirror that
// reopens right after the run (transport flap recovery) keeps its sidebar.
function setToolbarBusy(serial, busy) {
    if (!serial) return
    if (busy) {
        busyRunCounts.set(serial, (busyRunCounts.get(serial) || 0) + 1)
        // A fresh run supersedes any pending deferred-close grace timer.
        const t = pendingCloseTimers.get(serial)
        if (t) { clearTimeout(t); pendingCloseTimers.delete(serial) }
        return
    }
    const remaining = (busyRunCounts.get(serial) || 0) - 1
    if (remaining > 0) {
        // Another create still owns this phone (typically the one that WON the
        // lock race and is already paying for a number). Releasing here would
        // hand its sidebar to the reaper.
        busyRunCounts.set(serial, remaining)
        return
    }
    // An unmatched release (never claimed) must not arm the post-run window.
    if (!busyRunCounts.delete(serial)) return
    // Stamp the run end BEFORE anything can act on the cleared flag: a transport
    // death that arrives moments later must still find this sidebar protected.
    lastRunEndedAt.set(serial, Date.now())
    _schedulePendingClose(serial)
}

function getOpenSerials() {
    return Array.from(toolbarWindows.keys())
}

// 2.17.12: lookup helper for the "alreadyRunning" path in system-handlers
// so it can create a sidebar if scrcpy was spawned without one.
function hasToolbar(serial) {
    const w = toolbarWindows.get(serial)
    return !!(w && !w.isDestroyed())
}

// H6: like hasToolbar but excludes headless-backed serials, so the
// "alreadyRunning" path in system-handlers can tell a real docked sidebar apart
// from a leaked offscreen headless window and build a visible one when needed.
function hasVisibleToolbar(serial) {
    const w = toolbarWindows.get(serial)
    return !!(w && !w.isDestroyed() && !headlessSerials.has(serial))
}

// Headless variant for scheduled dispatch when no visible mirror is open.
// Creates a HIDDEN, offscreen, non-focusable, non-docked toolbar window bound
// to `serial` so the schedule engine's _dispatchWorkflow can run the workflow
// without the operator having a mirror up. The renderer registers its
// onScheduleFireWorkflow IPC listener at script-eval time, so resolving on
// did-finish-load (+ a short settle) is enough before the caller dispatches.
// Reuses an existing toolbar window for the serial if one is already open.
function createHeadlessToolbar({ serial, transport, tailnetIp }) {
    const existing = toolbarWindows.get(serial)
    if (existing && !existing.isDestroyed()) return Promise.resolve(existing)

    const win = new BrowserWindow({
        width: TOOLBAR_WIDTH,
        height: MIN_TOOLBAR_HEIGHT,
        x: -10000, y: -10000,   // offscreen — never visible, never steals foreground
        show: false,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, '..', 'mirror-toolbar-preload.js'),
            contextIsolation: false,
            nodeIntegration: true,
            sandbox: false,
            // Offscreen/hidden windows have their timers throttled by Electron, which
            // defeats the workflow runner's per-step setTimeout deadline (a hung
            // switch/post on a scheduled headless run would never fail-fast). Keep
            // timers full-speed so withTimeout fires and the slot releases the phone.
            backgroundThrottling: false,
        },
    })
    win.on('closed', () => { if (toolbarWindows.get(serial) === win) { toolbarWindows.delete(serial); headlessSerials.delete(serial) } })
    toolbarWindows.set(serial, win)
    // H6: flag this serial as backed by a headless window so createToolbar
    // refuses to adopt it as a visible mirror sidebar later.
    headlessSerials.add(serial)

    // Headless windows have no visible devtools — forward renderer console +
    // load/crash failures to the main process so scheduled-dispatch issues are
    // diagnosable from launcher.log / stdout.
    win.webContents.on('console-message', (_e, _lvl, message) => {
        try { console.log('[headless-toolbar]', String(message).slice(0, 300)) } catch (_) {}
    })
    win.webContents.on('did-fail-load', (_e, code, desc) => console.warn('[headless-toolbar] did-fail-load', code, desc))
    win.webContents.on('render-process-gone', (_e, d) => console.warn('[headless-toolbar] render-gone', d && d.reason))

    // Navigation/window-open allowlist — same deny-all guard as the visible
    // toolbar. The headless window only ever loads the local mirror-toolbar.html;
    // deny every popup (route http/https to the system browser) and block any
    // navigation off file://. Additive: nothing in the headless flow navigates.
    win.webContents.setWindowOpenHandler(({ url }) => {
        try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url) } catch (_) {}
        return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault()
    })

    const html = path.join(__dirname, '..', 'mirror-toolbar.html')
    const params = new URLSearchParams({
        serial,
        mirrorTitle: serial,
        transport: transport || 'usb',
        tailnetIp: tailnetIp || '',
        headless: '1',
    })
    return new Promise((resolve, reject) => {
        // M2: on a load failure/timeout, tear the half-loaded window down and
        // free the serial BEFORE rejecting. Otherwise the orphan stays in
        // toolbarWindows and _createHeadlessToolbarFor's retry early-returns the
        // SAME never-loaded window (whose renderer never registered the fire
        // IPC listener) — attempt 2 sends into the void and the serial stays
        // wedged until app restart. destroy() is synchronous and safe on an
        // offscreen, never-shown window. The 'closed' handler above also clears
        // the maps, so the explicit delete is belt-and-braces.
        const reap = () => {
            try { if (win && !win.isDestroyed()) win.destroy() } catch (_) {}
            toolbarWindows.delete(serial)
            headlessSerials.delete(serial)
        }
        const fail = setTimeout(() => { reap(); reject(new Error('headless toolbar load timeout')) }, 20000)
        win.webContents.once('did-finish-load', () => {
            setTimeout(() => { clearTimeout(fail); resolve(win) }, 800)
        })
        win.loadFile(html, { search: params.toString() }).catch((e) => { clearTimeout(fail); reap(); reject(e) })
    })
}

// Operator pinned/unpinned this mirror always-on-top: keep the rail in the
// same z-band as its scrcpy window (topmost when pinned, normal otherwise).
function setMirrorPinned(serial, on) {
    if (on) pinnedSerials.add(serial)
    else pinnedSerials.delete(serial)
    const win = toolbarWindows.get(serial)
    if (!win || win.isDestroyed()) return
    try {
        if (on) win.setAlwaysOnTop(true, 'pop-up-menu')
        else win.setAlwaysOnTop(false)
        win.moveTop()
    } catch (_) {}
}

module.exports = { createToolbar, createHeadlessToolbar, closeToolbar, setToolbarBusy, getOpenSerials, setLogsExpanded, setPanelMode, broadcastLiveLog, broadcastModuleProgress, getToolbarWebContentsIds, hasToolbar, hasVisibleToolbar, computeToolbarBounds, clampCompactWidth, setMirrorPinned, _busyRunCounts: busyRunCounts, _pendingCloseSerials: pendingCloseSerials, _trackedPidBySerial: trackedPidBySerial, _lastRunEndedAt: lastRunEndedAt, POST_RUN_SIDEBAR_PROTECT_MS }
