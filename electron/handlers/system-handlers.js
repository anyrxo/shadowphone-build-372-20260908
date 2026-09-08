/**
 * System IPC Handlers
 * Handles ADB installation, updates, scrcpy, and system utilities
 */

const { ipcMain, shell, Notification } = require('electron')
const { spawn, spawnSync } = require('child_process')
// Promisified execFile for non-blocking process kills (mirrors the local
// instance inside probeAdbStateForTarget). Used by killScrcpyTree so taskkill
// no longer freezes the UI on every Stop / Stop-All / quality-swap.
const execFileP = require('util').promisify(require('child_process').execFile)
const path = require('path')
const os = require('os')
const fs = require('fs')
const https = require('https')
const { runAdb } = require('../lib/adb-util')

let mainWindow = null
let app = null
let executeADB = null
let startADBServer = null
// 2.16.0: injected by initSystemHandlers so scrcpy can prefer tailnet routing
// when a phone is reachable over both USB and Tailscale.
let getConnectedDevicesFn = null
// H2/M3: last merged device list captured the last time launchScrcpyForSerial
// enumerated. Lets the SYNCHRONOUS hasRunningScrcpyForSerial guard collapse a
// USB udid and a tailnet ip:port to one physical phone (via device-identity
// .sameDevice) WITHOUT injecting an async adb enumeration into the hot guard
// that Mirror-All hammers. A stale snapshot only weakens dedup (worst case:
// the pre-fix behavior), never produces a false "already running".
let _lastDeviceSnapshot = []
// 2.16.1: set inside registerSystemHandlers so external modules (tray) can
// share the same launch path as the auto-mirror + renderer — they all get
// the docked toolbar, tailnet routing, and bookkeeping for free.
let _launchScrcpyForSerial = null
function launchScrcpyForSerialExternal(serial) {
    if (!_launchScrcpyForSerial) return Promise.resolve({ success: false, error: 'system handlers not initialised' })
    return _launchScrcpyForSerial(serial)
}

// Session-bound install record — set by download-update, consumed by install-update.
// install-update rejects any path that doesn't match this record, preventing a
// stale file from a previous session / aborted download from being executed.
let _sessionInstall = null // { path: string, version: string }

// Re-entrancy guard for download-update. Mac users were reporting "multiple
// instances" — the OS Save dialog doesn't pop up on Mac (we install in place
// via bash script) so there's no visible "downloading" state. Users clicked
// Update twice → two concurrent downloads → two concurrent installer scripts
// trying to replace the .app. This rejects a second call while one is in
// flight; the renderer also disables the button via the progress events.
let _downloadInFlight = false

// Store running scrcpy processes
const scrcpyProcesses = new Map()
const scrcpyPortBySerial = new Map()
// Per-serial "pin mirror always-on-top" opt-in. DEFAULT OFF — the mirror spawns
// at normal z-order so it's draggable and doesn't float over everything. Set via
// the scrcpy:set-always-on-top IPC for the rare case an operator wants a mirror
// pinned above other windows. Membership (truthy value) = on.
const scrcpyAlwaysOnTopBySerial = new Map()
// M3: bookkeeping serial -> the adbTarget scrcpy was actually spawned with
// (`-s <tailnet ip:port>` when a USB udid was routed over tailnet). Lets the
// cmdline-fallback in hasRunningScrcpyForSerial match a running tailnet mirror
// even though the maps are keyed by the input udid.
const scrcpyAdbTargetBySerial = new Map()
const scrcpyLaunchInFlight = new Set()
// serial -> the in-flight launch promise. scrcpyLaunchInFlight only covers the
// port/slot/spawn critical section; the ~2.6s prelude before it (device
// enumeration, orphan sweep, kill-and-wait, two possible modals) left a window
// where two callers — e.g. the device-watchdog and a user click — could both
// reach the spawn. Coalescing joins the second caller to the first launch's
// real result instead of fabricating an "already running" answer for a mirror
// that does not exist yet. Cleared the instant the launch settles, so genuine
// watchdog recovery is never delayed.
const scrcpyLaunchPromises = new Map()
// serial -> timestamp of the last CLEAN (code 0, non-fast-fail) scrcpy exit.
// The close teardown only clears the watchdog intent after an async adb probe;
// this lets Case A tell "the user just closed it" from "it crashed" during that
// gap instead of resurrecting the window.
const scrcpyLastCleanCloseAt = new Map()
// Mac TCC Screen Recording prompt is shown at most once per app session
// so Mirror All doesn't fire N dialogs in a row.
let macTccPromptShown = false
// serial -> --window-title we asked scrcpy to use. The layout equalizer
// looks up sibling mirror windows by title via PowerShell to resize them
// when a new mirror joins the grid.
const scrcpyTitleBySerial = new Map()
// Serials currently being killed-and-respawned for layout equalization.
// The scrcpy `close` handler checks this set and SKIPS the teardown
// when a respawn is in flight — otherwise the cleanup would wipe the
// port/title maps that the respawn relies on.
const scrcpyRespawning = new Set()
// Cache whether the local scrcpy binary accepts `--keyboard=uhid` /
// `--mouse=uhid`. Resolved lazily on first spawn: if scrcpy errors out
// with "unknown option" (pre-2.4 builds), we flip this to false and
// every subsequent spawn skips the UHID flags. null = not yet probed.
let scrcpyUhidSupported = null
// Serials we already retried once without UHID flags — guards against
// infinite respawn loops if some unrelated error also matches our
// "unsupported flag" heuristic.
const scrcpyUhidRetried = new Set()
// Serials we've already auto-retried once after a TRANSIENT fast-fail
// (scrcpy died <3s with an adb/transport blip while the phone is still
// present). Bounded to one retry per launch so a genuinely broken mirror
// can't loop; cleared when a mirror survives past the fast-fail window,
// on full teardown, and on explicit stop. The device-watchdog still owns
// recovery for phones that drop off ADB entirely — this only covers the
// spawn-time race the watchdog's offline→online detector never sees.
const scrcpyFastFailRetried = new Set()
// Args we spawned each serial with, so the fast-fail retry can respawn at
// the exact same slot/port/title/transport without re-deriving layout.
const scrcpyLastSpawnArgs = new Map()
// Serials the user explicitly stopped while a fast-fail retry was queued.
// The queued retry timer checks this and bails so an in-flight stop always
// wins over auto-recovery. Cleared at the start of each fresh launch.
const scrcpyRetryCanceled = new Set()
// Serials with a fast-fail auto-retry currently in flight. Dedicated to the
// retry's own teardown-suppression — separate from scrcpyRespawning, which is
// the SHARED, non-refcounted layout/profile-switch marker. Using a private
// flag means the retry's finally can't clobber a concurrent profile-switch's
// scrcpyRespawning marker (profile-handlers.js markRespawning).
const scrcpyFastFailInFlight = new Set()

/**
 * Resolve the per-serial scrcpy stderr log path (Mac diagnostic aid).
 * We can't import the Python persistent_log helper, so this mirrors the
 * intent: one file per serial under <userData>/logs, rotated by truncation
 * when it exceeds ~512KB so the file stays shippable in a bug report.
 */
function getScrcpyLogPathForSerial(serial) {
    try {
        if (!app) return null
        const logsDir = path.join(app.getPath('userData'), 'logs')
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true })
        }
        const safe = String(serial || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
        return path.join(logsDir, `scrcpy-${safe}.log`)
    } catch (_) {
        return null
    }
}

// Per-serial in-memory byte counter for scrcpy logs — avoids a stat() syscall
// on every stderr line. scrcpy stderr is chatty during ADB hiccups (frame
// errors etc.); stat-per-line was 5-15 sync syscalls/sec per active mirror
// on the main thread.
const scrcpyLogBytes = new Map()  // serial -> bytes (-1 = needs stat)
const SCRCPY_LOG_MAX_BYTES = 512 * 1024

function appendScrcpyLog(serial, line) {
    const logPath = getScrcpyLogPathForSerial(serial)
    if (!logPath) return
    try {
        const formatted = `[${new Date().toISOString()}] ${String(line).replace(/\s+$/, '')}\n`
        let bytes = scrcpyLogBytes.has(serial) ? scrcpyLogBytes.get(serial) : -1
        if (bytes < 0) {
            try { bytes = fs.statSync(logPath).size } catch (_) { bytes = 0 }
        }
        if (bytes > SCRCPY_LOG_MAX_BYTES) {
            try { fs.truncateSync(logPath, 0); bytes = 0 } catch (_) { /* concurrent rotate ok */ }
        }
        fs.appendFileSync(logPath, formatted)
        scrcpyLogBytes.set(serial, bytes + Buffer.byteLength(formatted, 'utf8'))
    } catch (_) { /* best-effort */ }
}

/**
 * Best-effort macOS TCC Screen Recording check. Reads the user-level
 * TCC.db directly via sqlite3. Returns { granted, clients, error }.
 * Sandbox/permissions may block the read — callers must treat a falsy
 * `granted` as inconclusive, NOT as a hard "not granted" signal.
 */
function checkMacScreenRecordingPermission() {
    if (os.platform() !== 'darwin') {
        return { granted: null, clients: [], error: 'not-mac' }
    }
    try {
        const tccPath = path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
        if (!fs.existsSync(tccPath)) {
            return { granted: null, clients: [], error: 'tcc-db-missing' }
        }
        const result = spawnSync('sqlite3', [
            tccPath,
            "select client from access where service='kTCCServiceScreenCapture' and auth_value=2",
        ], { encoding: 'utf8', timeout: 3000 })
        if (result.error) {
            return { granted: null, clients: [], error: result.error.message }
        }
        if (result.status !== 0) {
            const stderr = String(result.stderr || '').trim()
            return { granted: null, clients: [], error: stderr || `sqlite3 exit ${result.status}` }
        }
        const clients = String(result.stdout || '')
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(Boolean)
        const granted = clients.some(c => /scrcpy|shadowphone|electron|terminal|iterm/i.test(c))
        return { granted, clients, error: null }
    } catch (e) {
        return { granted: null, clients: [], error: e?.message || String(e) }
    }
}

/**
 * Spawn an scrcpy process at the exact window slot we want. Wires up
 * stdout/stderr/close handlers identical to the original spawn block so
 * existing teardown semantics are preserved. Used both for the first
 * mirror of a device AND for re-spawning siblings when the grid needs
 * uniform sizing (scrcpy enforces aspect ratio internally, so Win32
 * SetWindowPos can't actually resize a running mirror — stop+respawn
 * is the only reliable way).
 *
 * Returns the spawned ChildProcess.
 */

// Tree-kill an scrcpy process so the host-side adb grandchild is reaped too.
// proc.kill() (SIGTERM) signals only the direct scrcpy.exe; on Windows its
// child `adb -s <serial> shell CLASSPATH=…scrcpy-server` is NOT in the same
// process group and survives, holding a tcp:5037 forward open until the next
// app-restart orphan sweep. On a 24/7 farm with frequent Close-Window cycles
// these accumulate. taskkill /T takes down scrcpy.exe AND that adb child.
// NOTE: this targets the LOCAL host-side scrcpy.exe + its adb child only — the
// device-side scrcpy-server (detached via setsid/nohup, not a child of this
// pid) is a separate ws-scrcpy concern and is intentionally untouched.
async function killScrcpyTree(proc) {
    if (!proc || !proc.pid) return
    if (process.platform === 'win32') {
        try {
            await execFileP('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
                windowsHide: true,
                timeout: 4000,
            })
        } catch (_) { /* hung/missing taskkill OR non-zero exit (pid already gone) must not block the handler */ }
    } else {
        try { proc.kill() } catch (_) { /* ignore */ }
    }
}

function spawnScrcpyAtSlot(scrcpyPath, serial, port, x, y, w, h, title, adbTarget) {
    // 2.16.0: `adbTarget` lets the caller route scrcpy through tailnet
    // (`<tailnet-ip>:5555`) while bookkeeping stays keyed on the USB UDID
    // (`serial`). Falls back to `serial` for plain USB mirroring.
    const sArg = adbTarget || serial
    // v3.2: transport-aware adaptive quality. The same regex used at the
    // tailnet-routing decision (the M4 flap fix) classifies sArg as a tailnet
    // ip:port vs a plain USB udid. Over the flakier tailnet relay we stream
    // lighter (smaller frame + lower bitrate) to dodge the documented scrcpy
    // "Device disconnected" flap; over stable USB we stream crisp 60fps/8M.
    const isTailnet = /^(\d+\.\d+\.\d+\.\d+):\d+$/.test(sArg)
    const q = isTailnet
        ? { maxSize: '1024', fps: '30', bitrate: '3M' }
        : { maxSize: '1600', fps: '60', bitrate: '8M' }
    // Default to attempting UHID for the KEYBOARD unless we already
    // learned this scrcpy doesn't support it. `--keyboard=uhid` routes
    // typing through Android's USB HID stack — works with any keyboard
    // layout (QWERTY/AZERTY/Dvorak/intl); the `--keyboard=sdk` default
    // breaks on non-ASCII / non-US layouts.
    //
    // The MOUSE stays on `--mouse=sdk` (click-on-window = tap). The
    // `uhid`/`aoa` mouse modes CAPTURE the host pointer — the phone
    // tracks the physical mouse even when the cursor isn't over the
    // mirror window, and the host pointer is grabbed until you press
    // the scrcpy MOD key. That made stray off-window movement/clicks
    // land on the phone.
    const useUhid = scrcpyUhidSupported !== false
    const args = [
        '-s', sArg,
        '--window-title', title,
        '--stay-awake',
        // 2.16.35: REMOVED --turn-screen-off. It darkened the phone display
        // for privacy, but Android's doze kicker then paused the framebuffer
        // → black mirror until the operator tapped to wake. ShadowPhone is
        // an operator's desk tool — full visibility is wanted, not hidden.
        '--no-audio',
        // v3.2: --max-size / --max-fps / --video-bit-rate are pushed AFTER the
        // array literal (see the `args.push` below) from the transport-adaptive
        // transport-derived `q`, so the values aren't hardcoded here anymore.
        // NOTE: --always-on-top REMOVED (default OFF). Forcing the mirror topmost
        // made it float above every other window and feel "stuck"/un-draggable —
        // Anyro: "I can't move this." At normal z-order the mirror behaves like a
        // regular window (alt-tab, drag, overlap) and the toolbar drag-to-move
        // (win 'moved' → moveWindow) carries it around. Per-device opt-in lives in
        // scrcpyAlwaysOnTopBySerial (defaults OFF) for the rare pin-on-top case.
        '--port', String(port),
        '--window-x', String(x | 0),
        '--window-y', String(y | 0),
        '--window-width', String(w | 0),
        '--window-height', String(h | 0),
        // 2.17.21: native Ctrl+V paste from PC clipboard. scrcpy's default
        // shortcut modifier is LAlt (Win/Linux), so Ctrl+V was passing
        // through as a raw keystroke instead of triggering scrcpy's "paste
        // clipboard" action. With --shortcut-mod=lctrl, Ctrl+V now triggers
        // scrcpy's paste shortcut (sets device clipboard via Android API +
        // emits paste keystroke). Other Ctrl+* shortcuts also become active
        // (Ctrl+C = copy device → host clipboard, Ctrl+Shift+V = type text).
        '--shortcut-mod=lctrl',
        // 2.17.23: --legacy-paste makes Ctrl+V inject the clipboard as a
        // SEQUENCE OF KEY EVENTS instead of relying on the device clipboard
        // API. The API-based approach silently fails on UHID keyboard mode
        // + some app contexts (Anyro repro: "📥 button gave Exception
        // occurred while executing"). With legacy-paste, paste works in
        // ANY EditText regardless of permission or app, because the phone
        // sees raw key events. Per scrcpy docs: "workaround for some
        // devices not behaving as expected when setting the device
        // clipboard programmatically".
        '--legacy-paste',
    ]
    if (useUhid) {
        args.push('--keyboard=uhid', '--mouse=sdk')
    }
    // Transport-adaptive quality keeps remote mirrors lighter than local USB.
    // --video-buffer=0 (stable since scrcpy 2.0; bundled binary is 3.x)
    // minimizes added display latency so taps feel instant on the mirror.
    args.push('--max-size', q.maxSize, '--max-fps', q.fps, '--video-bit-rate', q.bitrate, '--video-buffer=0')
    // Opt-in only: re-add --always-on-top if this serial was explicitly pinned.
    if (scrcpyAlwaysOnTopBySerial.get(serial)) args.push('--always-on-top')

    console.log(`[Scrcpy] Spawning at slot (uhid=${useUhid}, transport=${isTailnet ? 'tailnet' : 'usb'}, quality=auto, ${q.maxSize}/${q.fps}fps/${q.bitrate}): "${scrcpyPath}" ${args.join(' ')}`)

    // 2.17.10: pass our bundled adb to scrcpy via $ADB env var. On Mac,
    // brew-installed scrcpy uses `which adb` → usually nothing → spawns
    // its own server that knows nothing about our connected devices →
    // exits immediately with "ERROR: Device .* not found". scrcpy honors
    // the ADB env override.
    //
    // 2.17.17: ALSO prepend the bundled adb dir to $PATH. The $ADB env
    // alone broke on Mac when the userData path contains a space (the
    // default macOS userData is "Library/Application Support/..."). Some
    // intermediate shell parsing in brew-scrcpy wrappers was splitting
    // the ADB value on whitespace → exec'ing "/Users/x/Library/Application"
    // and failing with "exec: No such file or directory" + "Command not
    // found: [adb], [start-server]". PATH uses ":" as separator on Unix
    // so spaces in path components don't break it.
    //
    // 2.17.19: CRITICAL FIX — 2.17.11 + 2.17.17 BOTH had a silent bug
    // where they called the non-existent `getADBPath()` function (it
    // lives in main.js, not in this file's scope). The try/catch
    // silently swallowed the ReferenceError → _ourAdb was always null →
    // $ADB never set, PATH never prepended. Mac users have been running
    // scrcpy with default env this whole time, which is why every Mac
    // user still hit "Command not found: [adb]". Use the actually-in-
    // scope getADBPathForInstall() now. To a no-space helper symlink
    // path so any shell parsing in brew-scrcpy doesn't split on spaces.
    let _ourAdb = null
    try {
        _ourAdb = getADBPathForInstall()
        if (_ourAdb && !fs.existsSync(_ourAdb)) _ourAdb = null
    } catch (_) {}
    let _adbForEnv = _ourAdb
    let _adbDir = _ourAdb ? path.dirname(_ourAdb) : null
    if (_ourAdb && process.platform !== 'win32' && /\s/.test(_ourAdb)) {
        // Build a no-space symlink at /tmp/shadowphone-adb-<pid>/adb.
        // brew-scrcpy on Mac shells out in some paths and breaks on spaces
        // in $ADB or $PATH components. Symlinking sidesteps that entirely.
        try {
            const tmpDir = path.join(os.tmpdir(), `shadowphone-adb-${process.pid}`)
            const tmpAdb = path.join(tmpDir, 'adb')
            if (!fs.existsSync(tmpAdb)) {
                fs.mkdirSync(tmpDir, { recursive: true })
                try { fs.symlinkSync(_ourAdb, tmpAdb) }
                catch (_) { try { fs.copyFileSync(_ourAdb, tmpAdb); fs.chmodSync(tmpAdb, 0o755) } catch (_) {} }
            }
            if (fs.existsSync(tmpAdb)) {
                _adbForEnv = tmpAdb
                _adbDir = tmpDir
            }
        } catch (_) {}
    }
    const spawnEnv = { ...process.env }
    if (_adbForEnv) spawnEnv.ADB = _adbForEnv
    if (_adbDir) {
        const sep = process.platform === 'win32' ? ';' : ':'
        spawnEnv.PATH = `${_adbDir}${sep}${process.env.PATH || ''}`
    }
    // 2.17.19 diagnostic: log what we actually set so we can verify in launcher.log
    try {
        require('../lib/launcher-log').write('scrcpy:spawn-env', {
            ourAdb: _ourAdb, adbForEnv: _adbForEnv, adbDir: _adbDir,
            adbExists: _adbForEnv ? fs.existsSync(_adbForEnv) : null,
        })
    } catch (_) {}
    // 2.18.1: show loading overlay BEFORE spawning scrcpy. The native scrcpy
    // window takes 1-3s to render its first frame; until then there's just a
    // black void. Overlay draws a phone-shaped skeleton + brand spinner over
    // the target rect, then hides on first frame OR a 3s safety timeout.
    try {
        const loadingOverlay = require('../lib/scrcpy-loading-overlay')
        loadingOverlay.show({
            serial,
            rect: { x, y, w, h },
            mirrorTitle: title,
        })
        // Overlay has its own HARD_TIMEOUT_MS=3000 in scrcpy-loading-overlay.js.
        // No external setTimeout needed — hide() is called from the close handler.
    } catch (e) {
        console.warn('[scrcpy] loading overlay failed (non-fatal):', e?.message || e)
    }

    const scrcpyProcess = spawn(scrcpyPath, args, { windowsHide: false, env: spawnEnv })

    // 2.17.10: track spawn time so we can detect fast-fail (close < 3s)
    // and surface the actual scrcpy stderr instead of silently tearing
    // down the toolbar.
    scrcpyProcess._spawnedAt = Date.now()
    scrcpyProcess._stderrTail = []

    // 2.18.2: REMOVED brand-gradient frame overlay wiring. The frame
    // tracker didn't keep alignment with the scrcpy window across DPI
    // boundaries / window drags — visually broken (Anyro screenshot
    // showed mis-sized gold border floating off the corner). Lib stays
    // in repo for future re-enable if the tracker is fixed.

    // Mirror critical events to launcher.log so diagnose reports show
    // why scrcpy is dying. Without this, scrcpy stderr only goes to the
    // per-serial log file which the diagnostic doesn't read.
    try {
        // 2.17.23: log full args array so we can verify --shortcut-mod=lctrl
        // and --legacy-paste actually land on each spawn (without this,
        // scrcpy:spawn only showed scrcpyPath and Anyro had no way to
        // confirm the paste fix shipped).
        require('../lib/launcher-log').write('scrcpy:spawn', {
            args: args.slice(0, 30),
            serial, port, title, scrcpyPath, adb: spawnEnv.ADB, useUhid,
            transport: isTailnet ? 'tailnet' : 'usb', quality: q, qualityMode: 'automatic',
        })
    } catch (_) {}

    scrcpyProcesses.set(serial, scrcpyProcess)
    scrcpyPortBySerial.set(serial, port)
    scrcpyTitleBySerial.set(serial, title)
    // M3: remember the transport scrcpy actually attached on so the cmdline
    // fallback can match a tailnet-routed mirror keyed under a USB udid.
    if (sArg && sArg !== serial) scrcpyAdbTargetBySerial.set(serial, sArg)
    else scrcpyAdbTargetBySerial.delete(serial)

    // Track the args we used so the "unsupported flag" fallback handler
    // can decide whether a respawn is needed (only if we tried UHID).
    scrcpyProcess._spUsedUhid = useUhid

    // Remember the exact placement args so a transient fast-fail can respawn
    // at the same slot/port/title/transport without re-deriving the layout.
    scrcpyLastSpawnArgs.set(serial, { scrcpyPath, port, x, y, w, h, title, adbTarget })

    // If this mirror survives past the fast-fail window, clear the one-shot
    // retry latch so a LATER genuine death (much later) can earn its own retry.
    setTimeout(() => {
        if (isScrcpyProcessAlive(scrcpyProcess)) scrcpyFastFailRetried.delete(serial)
    }, 4000)

    scrcpyProcess.stdout?.on('data', (data) => {
        console.log(`[Scrcpy stdout] ${data}`)
        try {
            for (const ln of String(data).split('\n')) {
                if (!ln.trim()) continue
                scrcpyProcess._stderrTail.push(ln.slice(0, 240))
                if (scrcpyProcess._stderrTail.length > 30) scrcpyProcess._stderrTail.shift()
            }
        } catch (_) {}
    })
    scrcpyProcess.stderr?.on('data', (data) => {
        const text = String(data)
        console.log(`[Scrcpy stderr] ${text}`)
        // 2.17.10: keep last 30 lines for fast-fail diagnosis
        try {
            for (const ln of text.split('\n')) {
                if (!ln.trim()) continue
                scrcpyProcess._stderrTail.push(ln.slice(0, 240))
                if (scrcpyProcess._stderrTail.length > 30) scrcpyProcess._stderrTail.shift()
            }
        } catch (_) {}
        // Detect pre-2.4 builds that don't accept `--keyboard=uhid` /
        // `--mouse=uhid`. scrcpy emits "Unknown option" / "unrecognized
        // option" / "invalid option" before exiting with a non-zero code.
        // On detection, flip the cache so future spawns skip UHID, and
        // respawn THIS mirror once without the flags so the user still
        // gets a working window.
        if (
            useUhid &&
            scrcpyUhidSupported !== false &&
            !scrcpyUhidRetried.has(serial) &&
            /unknown option|unrecognized option|invalid option/i.test(text) &&
            /keyboard|mouse|uhid/i.test(text)
        ) {
            console.warn('[Scrcpy] UHID flags not supported by this scrcpy build — falling back to default keyboard/mouse mode')
            scrcpyUhidSupported = false
            scrcpyUhidRetried.add(serial)
            scrcpyRespawning.add(serial)
            // Kill the failed proc; close handler skips teardown because
            // of the scrcpyRespawning guard. Respawn once without flags.
            try { scrcpyProcess.kill() } catch (_) { /* ignore */ }
            setTimeout(() => {
                try {
                    spawnScrcpyAtSlot(scrcpyPath, serial, port, x, y, w, h, title, adbTarget)
                } catch (e) {
                    console.error('[Scrcpy] UHID fallback respawn failed:', e?.message || e)
                } finally {
                    scrcpyRespawning.delete(serial)
                }
            }, 250)
        }
    })
    // Mac-only: also tee stderr to a per-serial log file so SaaS users
    // can ship the log when reporting bugs. Extra listener — does NOT
    // touch the console.log listener above, so the existing teardown /
    // layout-equalizer behaviour is unchanged.
    if (process.platform === 'darwin') {
        scrcpyProcess.stderr?.on('data', (data) => {
            const text = String(data)
            for (const line of text.split(/\r?\n/)) {
                if (line.length) appendScrcpyLog(serial, line)
            }
        })
        scrcpyProcess.on('error', (error) => {
            appendScrcpyLog(serial, `spawn-error: ${error?.message || error}`)
        })
        scrcpyProcess.on('close', (code) => {
            appendScrcpyLog(serial, `exit code=${code}`)
        })
    }
    scrcpyProcess.on('error', (error) => {
        console.error(`[Scrcpy] Spawn error:`, error)
        // EINVAL on argv usually means a flag was rejected before scrcpy
        // could even print to stderr. If we tried UHID, retry once
        // without it — same recovery path as the stderr-detected case.
        if (
            useUhid &&
            scrcpyUhidSupported !== false &&
            !scrcpyUhidRetried.has(serial) &&
            (error?.code === 'EINVAL' || /EINVAL/i.test(error?.message || ''))
        ) {
            console.warn('[Scrcpy] EINVAL during spawn with UHID flags — retrying without them')
            scrcpyUhidSupported = false
            scrcpyUhidRetried.add(serial)
            scrcpyRespawning.add(serial)
            setTimeout(() => {
                try {
                    spawnScrcpyAtSlot(scrcpyPath, serial, port, x, y, w, h, title, adbTarget)
                } catch (e) {
                    console.error('[Scrcpy] UHID EINVAL fallback respawn failed:', e?.message || e)
                } finally {
                    scrcpyRespawning.delete(serial)
                }
            }, 250)
            return
        }
        // Non-UHID spawn failure (ENOENT = scrcpy binary missing/moved,
        // EACCES = not executable, EPERM, etc.). The OS never even started
        // scrcpy, so there's no stderr tail and the `close` handler may not
        // run with a useful code — surface a CLEAR reason to the operator
        // instead of a silent console line + a dangling empty toolbar.
        const code = error?.code || 'spawn-failed'
        const friendly = code === 'ENOENT'
            ? `scrcpy could not be launched (binary not found at "${scrcpyPath}"). It may have been moved or removed — reinstall scrcpy.`
            : code === 'EACCES' || code === 'EPERM'
                ? `scrcpy could not be launched (permission denied for "${scrcpyPath}"). Check the file is executable.`
                : `scrcpy failed to launch: ${error?.message || code}`
        try { require('../lib/launcher-log').write('scrcpy:spawn-error', { serial, code, scrcpyPath, message: error?.message || String(error) }) } catch (_) {}
        try {
            const mt = require('../lib/mirror-toolbar')
            if (typeof mt.broadcastLiveLog === 'function') {
                mt.broadcastLiveLog({ t: new Date().toISOString(), event: 'scrcpy-spawn-error', level: 'error', message: friendly, serial })
            }
        } catch (_) {}
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('scrcpy-fast-fail', { serial, code, lifetimeMs: 0, stderrTail: friendly })
            }
        } catch (_) {}
        // A process that never spawned won't reach the `close` teardown via
        // hasRunningScrcpyForSerial (no OS process exists), but be defensive:
        // drop the half-registered bookkeeping so a re-Launch starts clean.
        if (scrcpyProcesses.get(serial) === scrcpyProcess) {
            scrcpyProcesses.delete(serial)
            scrcpyPortBySerial.delete(serial)
            scrcpyTitleBySerial.delete(serial)
            scrcpyAdbTargetBySerial.delete(serial)
            scrcpyLastSpawnArgs.delete(serial)
        }
    })
    scrcpyProcess.on('close', (code) => {
        console.log(`[Scrcpy] Process closed with code ${code}`)
        // Ensure loading overlay is gone whenever scrcpy exits — belt-and-braces
        // against the HARD_TIMEOUT_MS=3000 in scrcpy-loading-overlay.js.
        try { require('../lib/scrcpy-loading-overlay').hide(serial) } catch (_) {}
        const lifetimeMs = Date.now() - (scrcpyProcess._spawnedAt || 0)
        const fastFail = lifetimeMs < 3000  // died within 3s of spawn

        // 2.17.10: surface the death + stderr tail in launcher.log so the
        // diagnostic report shows the actual reason. Without this users
        // saw "sidebar appears then disappears" with zero explanation.
        try {
            require('../lib/launcher-log').write('scrcpy:closed', {
                serial,
                code,
                lifetimeMs,
                fastFail,
                stderrTail: (scrcpyProcess._stderrTail || []).slice(-15),
            })
        } catch (_) {}

        // If this close was triggered by an intentional layout respawn (or a
        // fast-fail auto-retry that owns the maps), skip teardown — the
        // respawn/retry will replace the entries before returning control.
        // Without this guard, the cleanup wipes port/title maps mid-respawn.
        if (scrcpyRespawning.has(serial) || scrcpyFastFailInFlight.has(serial)) {
            return
        }

        // 2.17.10: fast-fail (< 3s) means scrcpy died immediately. Don't
        // tear down the toolbar silently — surface the error to the
        // renderer so the user sees what went wrong. Toolbar stays open
        // showing the error in its live-logs panel.
        if (fastFail) {
            try {
                const tail = (scrcpyProcess._stderrTail || []).join(' | ').slice(0, 600)
                const mt = require('../lib/mirror-toolbar')
                if (typeof mt.broadcastLiveLog === 'function') {
                    mt.broadcastLiveLog({
                        t: new Date().toISOString(),
                        event: 'scrcpy-fast-fail',
                        level: 'error',
                        message: `scrcpy died ${lifetimeMs}ms after spawn (exit ${code}). Last output: ${tail || '(none)'}`,
                        serial,
                    })
                }
            } catch (_) {}
            // Send a one-shot notification to the main window if available
            try {
                const tail = (scrcpyProcess._stderrTail || []).join('\n').slice(0, 600)
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('scrcpy-fast-fail', { serial, code, lifetimeMs, stderrTail: tail })
                }
            } catch (_) {}

            // Transient fast-fail auto-recovery: scrcpy occasionally dies
            // within a second or two of spawn from a momentary adb/transport
            // blip (USB re-enumeration, Tailscale relay flip mid-handshake,
            // adb-server restart) while the phone is otherwise present. The
            // device-watchdog only relaunches on an offline→online ADB
            // transition, so a pure SPAWN-time race left the operator with a
            // mirror that just vanished. Retry ONCE, after a short backoff,
            // when the failure looks transient — bounded by a one-shot latch
            // so a genuinely broken target (bad flag, missing binary, denied
            // permission) can't loop. Skips clean exits (code 0 = window
            // closed normally) and respects in-flight respawn/launch guards.
            const tailText = (scrcpyProcess._stderrTail || []).join(' ')
            const looksTransient = /device disconnected|connection reset|connection refused|could not connect|failed to connect|broken pipe|server connection|read timeout|adb: |timed? ?out/i.test(tailText)
            const looksPermanent = /no such file|unknown option|unrecognized option|invalid option|unauthorized|not found|permission denied|ENOENT/i.test(tailText)
            if (
                code !== 0 &&
                looksTransient &&
                !looksPermanent &&
                !scrcpyFastFailRetried.has(serial) &&
                !scrcpyRespawning.has(serial) &&
                !scrcpyLaunchInFlight.has(serial) &&
                scrcpyLastSpawnArgs.has(serial)
            ) {
                scrcpyFastFailRetried.add(serial)
                scrcpyFastFailInFlight.add(serial)  // suppress the teardown timer below (private flag)
                const a = scrcpyLastSpawnArgs.get(serial)
                try { require('../lib/launcher-log').write('scrcpy:fast-fail-retry', { serial, code, lifetimeMs, tail: tailText.slice(0, 240) }) } catch (_) {}
                try {
                    const mt = require('../lib/mirror-toolbar')
                    if (typeof mt.broadcastLiveLog === 'function') {
                        mt.broadcastLiveLog({ t: new Date().toISOString(), event: 'scrcpy-fast-fail-retry', level: 'warn', message: 'Transient mirror drop — auto-retrying once…', serial })
                    }
                } catch (_) {}
                setTimeout(async () => {
                    try {
                        // Bail if the user stopped this mirror while we waited,
                        // or if something else already brought a mirror back
                        // (user re-Launch, watchdog relaunch).
                        if (scrcpyRetryCanceled.has(serial)) {
                            scrcpyRetryCanceled.delete(serial)
                            return
                        }
                        // A concurrent profile-switch / layout respawn owns this
                        // serial — never spawn underneath it (would duplicate the
                        // mirror the switch is rebuilding).
                        if (scrcpyRespawning.has(serial)) return
                        // A fresh user/watchdog Launch is mid-flight (it clears the
                        // canceled latch); let it own the relaunch instead of racing
                        // it into a second mirror.
                        if (scrcpyLaunchInFlight.has(serial)) return
                        if (!hasRunningScrcpyForSerial(serial)) {
                            // Re-resolve the transport LIVE rather than reusing the
                            // frozen a.adbTarget — a USB<->tailnet move or a tailnet
                            // port rotation since the original spawn could have made
                            // the stored target a dead transport (scrcpy's -s routing)
                            // and would also mis-derive the automatic quality. Same
                            // recipe launchScrcpyForSerial / the equalizer use; falls
                            // back to a.adbTarget on any adb hiccup.
                            const freshTarget = await resolveAdbTargetLive(serial, a.adbTarget)
                            spawnScrcpyAtSlot(a.scrcpyPath, serial, a.port, a.x, a.y, a.w, a.h, a.title, freshTarget)
                        }
                    } catch (e) {
                        console.error('[Scrcpy] transient fast-fail retry failed:', e?.message || e)
                    } finally {
                        scrcpyFastFailInFlight.delete(serial)
                    }
                }, 1200)
                return  // skip the teardown timer; the retry owns the maps now
            }
        }

        // Record a CLEAN exit up-front. The teardown below defers 350ms and only
        // clears the watchdog intent AFTER an async adb probe; the watchdog
        // ticks inside that gap and used to relaunch a window the user had just
        // closed (downtimeMs === 0, "already-running-sidebar-created").
        if (code === 0 && !fastFail) {
            scrcpyLastCleanCloseAt.set(serial, Date.now())
            if (adbTarget && adbTarget !== serial) scrcpyLastCleanCloseAt.set(adbTarget, Date.now())
        }

        // On some Windows installs, a launcher/shim process exits while
        // the real scrcpy window keeps running. Keep mirror state if
        // detected.
        setTimeout(async () => {
            if (hasRunningScrcpyForSerial(serial)) {
                console.log(`[Scrcpy] Wrapper exited but mirror still running for ${serial}`)
                return
            }
            scrcpyProcesses.delete(serial)
            scrcpyPortBySerial.delete(serial)
            scrcpyTitleBySerial.delete(serial)
            scrcpyAdbTargetBySerial.delete(serial)
            scrcpyLastSpawnArgs.delete(serial)
            scrcpyFastFailRetried.delete(serial)
            // Close the toolbar first so the UI reacts immediately — the
            // liveness probe below must never delay this (or leak the maps we
            // just cleared).
            try {
                require('../lib/mirror-toolbar').closeToolbar(serial)
            } catch (_) { /* best-effort */ }
            // USER-CLOSE vs TRANSPORT-DEATH: decide by DEVICE LIVENESS, not exit
            // code. A manual window-close of a TAILNET mirror on Windows commonly
            // exits NON-ZERO (the relay/adb socket tears abnormally), so the old
            // `code === 0` gate wrongly KEPT the watchdog intent and Case A
            // (phone online + no scrcpy → relaunch) resurrected the window the
            // user just closed. Instead probe the transport (serial AND the
            // tailnet adbTarget) with the bundled adb: if the phone still
            // enumerates as 'device' it was a user close (or a scrcpy crash on a
            // healthy phone) → drop the intent so it STAYS closed. Keep the
            // intent ONLY when the probe RELIABLY shows the device offline/missing
            // (a genuine transport death the watchdog should auto-recover). A
            // timed-out / inconclusive probe defaults to the SAFE side (clear) so
            // we never wrongly resurrect a closed window. probeAdbStateForTarget
            // is strictly bounded (execFile timeout) and swallows all errors —
            // it can't wedge this teardown. Programmatic respawns
            // (layout/profile-switch) never reach here (scrcpyRespawning guard).
            let transportDead = false
            try {
                const [sState, tState] = await Promise.all([
                    probeAdbStateForTarget(serial),
                    (adbTarget && adbTarget !== serial)
                        ? probeAdbStateForTarget(adbTarget)
                        : Promise.resolve(null),
                ])
                const isHealthy = s => s === 'device'
                const isDead = s => s === 'offline' || s === 'missing'
                // Only a genuine transport death (nothing healthy AND at least one
                // target reliably offline/missing) keeps the intent.
                transportDead = ![sState, tState].some(isHealthy)
                    && [sState, tState].some(isDead)
            } catch (_) { transportDead = false }
            if (!transportDead) {
                try {
                    const wd = require('../lib/device-watchdog')
                    wd.clearIntent(serial)
                    if (adbTarget && adbTarget !== serial) wd.clearIntent(adbTarget)
                } catch (_) { /* best-effort */ }
            }
        }, 350)
    })

    return scrcpyProcess
}

/**
 * Kill an scrcpy process and wait for its `close` event so the next
 * spawn doesn't race the OS releasing the local TCP --port. Falls back
 * to a timeout if the close event never fires (e.g. wrapper shim
 * already detached) — the timeout floor matches scrcpy's typical
 * shutdown window observed in practice.
 */
function killScrcpyAndWait(proc, timeoutMs = 1200) {
    return new Promise((resolve) => {
        if (!proc) {
            resolve()
            return
        }
        let settled = false
        const finish = () => {
            if (settled) return
            settled = true
            resolve()
        }
        try { proc.once('close', finish) } catch (_) { /* ignore */ }
        try { proc.kill() } catch (_) { /* ignore */ }
        setTimeout(finish, timeoutMs)
    })
}

// v3.2: re-resolve the adb transport target for `serial` at RESPAWN time, using
// the same recipe launchScrcpyForSerial (L~2489) and the layout equalizer
// (L~2367) use. A respawn that reuses a stale stored adbTarget can (a) attach
// scrcpy's `-s` routing to a dead transport after a USB<->tailnet move or a
// tailnet port rotation, and (b) mis-derive transport-adaptive quality.
// Returns the live target, or `fallback` (the stored target) on any adb hiccup
// so a transient enumeration failure never blocks the quality change / retry.
async function resolveAdbTargetLive(serial, fallback) {
    // A TCP serial IS its own target (VA Fleet-panel path) — passthrough.
    if (/^(\d+\.\d+\.\d+\.\d+):(\d+)$/.test(String(serial))) return serial
    try {
        const devices = getConnectedDevicesFn ? await getConnectedDevicesFn() : []
        if (Array.isArray(devices) && devices.length) _lastDeviceSnapshot = devices
        const dev = devices.find(d => d.serial === serial || d.hwSerial === serial)
        const usbLive = devices.some(d => d.serial === serial)
        return (dev && dev.tailnetIp && !usbLive)
            ? `${dev.tailnetIp}:${dev.tailnetPort || 5555}`
            : null
    } catch (_) {
        return fallback
    }
}

// Synchronous, fire-and-forget teardown of EVERY running scrcpy at app quit.
// before-quit / window-all-closed never referenced scrcpyProcesses, so on
// Windows the scrcpy.exe children (each holding an adb `CLASSPATH=…scrcpy-
// server.jar` shell open against the phone-side encoder) survived app exit as
// orphan mirror windows, only reaped by orphan-killer.sweep() at the NEXT
// launch. A bare proc.kill() (SIGTERM) does NOT take down the adb child tree on
// win32 — only taskkill /T does — so we tree-kill per process. Idempotent: both
// quit handlers may fire, and the second pass finds the maps already cleared.
// Must stay synchronous and swallow everything so a hung taskkill can't stall
// app shutdown (per-call timeout caps each tree-kill).
function killAllScrcpy() {
    let killed = 0
    for (const [serial, proc] of scrcpyProcesses.entries()) {
        try { scrcpyRetryCanceled.add(serial) } catch (_) { /* ignore */ }
        try { proc.kill() } catch (_) { /* ignore */ }
        if (process.platform === 'win32' && proc && proc.pid) {
            try {
                spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
                    windowsHide: true,
                    timeout: 1500,
                })
            } catch (_) { /* hung/missing taskkill must not block quit */ }
        }
        killed += 1
    }
    try { scrcpyProcesses.clear() } catch (_) { /* ignore */ }
    try { scrcpyPortBySerial.clear() } catch (_) { /* ignore */ }
    try { scrcpyTitleBySerial.clear() } catch (_) { /* ignore */ }
    try { scrcpyAdbTargetBySerial.clear() } catch (_) { /* ignore */ }
    try { scrcpyLastSpawnArgs.clear() } catch (_) { /* ignore */ }
    try { scrcpyFastFailRetried.clear() } catch (_) { /* ignore */ }
    // Belt-and-suspenders: sweep any orphan scrcpy/adb children our in-memory
    // map didn't know about (e.g. left by a prior crashed session).
    try { require('../lib/scrcpy-orphan-killer').sweep({ logger: () => {} }) } catch (_) { /* ignore */ }
    return killed
}

function normalizeSerial(serial) {
    return String(serial || '').trim()
}

function isScrcpyProcessAlive(proc) {
    if (!proc) return false
    return proc.exitCode === null && proc.signalCode === null && !proc.killed
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function commandLineHasSerial(commandLine, serial) {
    const normalized = normalizeSerial(serial)
    if (!commandLine || !normalized) return false
    const escaped = escapeRegExp(normalized)
    const serialPattern = new RegExp(`(?:^|\\s)(?:-s|--serial)(?:=|\\s+)["']?${escaped}["']?(?:\\s|$)`, 'i')
    if (serialPattern.test(commandLine)) return true
    // Fallback for wrapper launchers where args can be transformed.
    return String(commandLine).toLowerCase().includes(normalized.toLowerCase())
}

// Cache for the cross-process scrcpy enumeration. Get-CimInstance Win32_Process
// reliably takes 200-800ms on Windows and the macOS `ps -ax` is ~50-150ms;
// either one freezes the main thread (the BrowserWindow renders on it) for
// the duration. Mirror-All of 6 devices used to fire 6 sequential queries
// = ~3s of dead UI. We now share one query across a short window.
let scrcpyEnumCache = { at: 0, lines: [] }
const SCRCPY_ENUM_CACHE_MS = 2_000

function enumerateRunningScrcpy() {
    const now = Date.now()
    if (now - scrcpyEnumCache.at < SCRCPY_ENUM_CACHE_MS) return scrcpyEnumCache.lines
    const platform = os.platform()
    let lines = []
    try {
        if (platform === 'win32') {
            // 2.16.17: filter by IMAGE NAME (scrcpy.exe) — was matching ANY
            // process whose cmdline contained "scrcpy", which false-positively
            // caught the adb child `adb -s X shell CLASSPATH=…/scrcpy-server.jar`
            // long after the parent scrcpy died. Result: Launch returned
            // alreadyRunning forever even with no scrcpy window visible. Use
            // Name='scrcpy.exe' so we only see the real GUI process.
            const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
                "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='scrcpy.exe'\" | Select-Object -ExpandProperty CommandLine",
            ], { encoding: 'utf8', windowsHide: true, timeout: 1500 })
            lines = String(result.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
        } else {
            // On unix, ps command= shows argv[0] first. scrcpy's binary is
            // literally "scrcpy" so /^scrcpy\b/ matches it — and excludes
            // `adb shell …scrcpy-server…` which starts with "adb".
            const result = spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', timeout: 1500 })
            lines = String(result.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => /(^|\/)scrcpy(\s|$)/.test(l))
        }
    } catch (_) { /* timeout/spawn error → treat as empty, in-memory map is canonical */ }
    scrcpyEnumCache = { at: now, lines }
    return lines
}

function hasRunningScrcpyForSerial(serial) {
    const normalized = normalizeSerial(serial)
    if (!normalized) return false

    // Fast path: we spawned it ourselves and the child handle is still alive.
    // Skips the OS process query entirely for the common case (the user's
    // currently-open mirrors), which is what "Mirror All" hammers.
    const owned = scrcpyProcesses.get(serial)
    if (owned && !owned.killed && owned.exitCode === null && owned.signalCode === null) {
        return true
    }

    // H2/M3: dual-transport dedup. The dashboard Mirror passes the USB udid
    // while fleet/tray paths pass the tailnet ip:port — SAME phone, different
    // map keys. Treat a live owned mirror under any serial that sameDevice()-
    // matches the incoming one (against the last enumerated snapshot) as
    // already running, so a second transport's launch short-circuits instead
    // of attaching a duplicate scrcpy server to one device. Stays synchronous:
    // uses the cached snapshot, no adb call.
    if (_lastDeviceSnapshot && _lastDeviceSnapshot.length) {
        try {
            const { sameDevice } = require('../lib/device-identity')
            for (const [key, proc] of scrcpyProcesses.entries()) {
                if (key === serial) continue
                if (!(proc && !proc.killed && proc.exitCode === null && proc.signalCode === null)) continue
                if (sameDevice(key, normalized, _lastDeviceSnapshot)) return true
            }
        } catch (_) { /* fall through to OS query */ }
    }

    // Fallback: orphan from a force-killed prior session. Cached across calls.
    // M3: also match the adbTarget a USB-udid launch actually spawned with
    // (scrcpy's running cmdline carries the tailnet serial, not the udid), so
    // the cmdline scan matches either form.
    try {
        const lines = enumerateRunningScrcpy()
        if (lines.some(line => commandLineHasSerial(line, normalized))) return true
        const spawnedTarget = scrcpyAdbTargetBySerial.get(serial)
        if (spawnedTarget && spawnedTarget !== normalized
            && lines.some(line => commandLineHasSerial(line, spawnedTarget))) return true
        return false
    } catch (error) {
        console.warn(`[Scrcpy] Running-process check failed for ${normalized}:`, error?.message || error)
        return false
    }
}

/**
 * Initialize system handlers
 */
function initSystemHandlers(options) {
    mainWindow = options.mainWindow
    app = options.app
    executeADB = options.executeADB
    startADBServer = options.startADBServer
    getConnectedDevicesFn = options.getConnectedDevices || null

    registerSystemHandlers()
}

/**
 * Get path to ADB for installation
 */
function getADBPathForInstall() {
    const platform = os.platform()
    const adbBinary = platform === 'win32' ? 'adb.exe' : 'adb'
    const userDataPath = app.getPath('userData')
    const downloadedPath = path.join(userDataPath, 'adb', adbBinary)

    if (fs.existsSync(downloadedPath)) {
        return downloadedPath
    }

    return adbBinary
}

/**
 * Cheap pre-spawn reachability probe for the EXACT transport scrcpy is about
 * to attach on. Runs `adb -s <target> get-state` with the bundled (pinned)
 * adb so the result matches the adb scrcpy itself will use via $ADB.
 *
 * Returns one of: 'device' (ready), 'unauthorized', 'offline', 'missing'
 * (target not in `adb devices`), or null (probe inconclusive — adb itself
 * failed/timed out; caller should NOT block the launch on null).
 *
 * Why: an unauthorized/offline phone makes scrcpy spawn a window that's just
 * a black void (or fast-fails seconds later with a cryptic stderr). Probing
 * first lets us surface a clear, actionable status instead.
 */
async function probeAdbStateForTarget(target) {
    const t = normalizeSerial(target)
    if (!t) return null
    let adb = null
    try { adb = getADBPathForInstall() } catch (_) { adb = null }
    if (!adb) return null
    // Async probe so the main thread keeps pumping the event loop while adb
    // runs. The old spawnSync(...) + Atomics.wait blocked the renderer's render
    // thread for up to ~5.7s per launch (2×2.5s probe + 0.7s settle), freezing
    // the BrowserWindow — most visible accumulating across Mirror-All.
    const probeOnce = async () => {
        const result = await runAdb(adb, ['-s', t, 'get-state'], 2500)
        const out = String(result.stdout || '').trim().toLowerCase()
        const err = String(result.stderr || result.error || '').trim().toLowerCase()
        if (out === 'device') return 'device'
        if (out === 'unauthorized' || /unauthorized/.test(err)) return 'unauthorized'
        if (out === 'offline' || /offline/.test(err)) return 'offline'
        // adb prints "error: device '<x>' not found" to stderr when the
        // target isn't connected at all.
        if (/not found|no devices|device.*not found/.test(err)) return 'missing'
        // Any other non-empty state string → treat as inconclusive rather
        // than blocking (newer/edge adb states we don't model).
        return null
    }
    const first = await probeOnce()
    // A freshly-plugged phone reports 'offline'/'missing' for ~1s while it
    // enumerates, then settles to 'device'. Don't hard-block on the first
    // non-'device' reading — re-probe ONCE after a short settle window and
    // only then trust it. ('unauthorized' is a real user-action state, but
    // re-probing it is harmless and keeps the messaging path unchanged.)
    if (first === null || first === 'device') return first
    await new Promise(r => setTimeout(r, 700))
    return probeOnce()
}

/**
 * Get path to scrcpy.
 *
 * Detection order:
 *   1. Hard-coded common install locations (fast, no shell spawn).
 *   2. On macOS/Linux: `bash -lc 'command -v scrcpy'` so login shell PATH
 *      (.zshrc/.bash_profile) is honored — Electron's GUI process inherits
 *      a stripped PATH that misses Homebrew + manual installs.
 *   3. On any platform: `which`/`where` against the inherited PATH.
 */
function getScrcpyPath() {
    const platform = os.platform()
    const scrcpyBinary = platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'

    // 1) Fast path: scan known install locations directly.
    // v3.2: the app-managed copies are listed FIRST so the known-good bundled
    // scrcpy 3.x always wins over a stray pre-existing generic 2.x install. The
    // spawn args push v3-only flags (--video-buffer=0, renamed from
    // --display-buffer in 3.0; --max-fps / --video-bit-rate), which a 2.x binary
    // rejects with "Unknown option" → an unrecoverable fast-fail (the UHID and
    // transient-retry recovery paths don't match those flag names). Preferring
    // the bundled binary deterministically avoids that for non-prod users; on the
    // production farm the bundled v3.x resolved either way, so this can't regress
    // the live fleet.
    const possiblePaths = [
        // App-managed copies — preferred so the bundled v3.x wins over a stray 2.x.
        path.join(__dirname, '..', 'scrcpy', scrcpyBinary),
        path.join(app.getPath('userData'), 'scrcpy', scrcpyBinary),
        // macOS — Homebrew + MacPorts + .app bundles + common manual installs.
        '/opt/homebrew/bin/scrcpy',
        '/usr/local/bin/scrcpy',
        '/usr/bin/scrcpy',
        '/opt/local/bin/scrcpy',
        '/Applications/scrcpy.app/Contents/MacOS/scrcpy',
        path.join(os.homedir(), 'Applications', 'scrcpy.app', 'Contents', 'MacOS', 'scrcpy'),
        path.join(os.homedir(), 'scrcpy', 'scrcpy'),
        path.join(os.homedir(), 'bin', 'scrcpy'),
        // Windows — Program Files + Scoop + portable extracts.
        'C:\\Program Files\\scrcpy\\scrcpy.exe',
        'C:\\Program Files (x86)\\scrcpy\\scrcpy.exe',
        path.join(os.homedir(), 'scoop', 'apps', 'scrcpy', 'current', 'scrcpy.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'scrcpy', 'scrcpy.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'scrcpy', 'scrcpy-win64-v3.1', 'scrcpy.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'scrcpy', 'scrcpy-win64-v3.0', 'scrcpy.exe'),
    ]

    for (const candidate of possiblePaths) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate
            }
        } catch (_) { /* continue */ }
    }

    // 2) Login-shell PATH probe — only matters on macOS/Linux. Catches
    //    installs in user-PATH locations Electron's GUI env doesn't see
    //    (e.g. tea, asdf, custom Homebrew prefixes).
    if (platform !== 'win32') {
        try {
            const { execSync } = require('child_process')
            const out = execSync("bash -lc 'command -v scrcpy 2>/dev/null'", {
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 4000,
            }).toString().trim()
            if (out && fs.existsSync(out)) return out
        } catch (_) { /* continue */ }
    }

    // 3) Inherited-PATH probe via which/where (Electron env). Last because
    //    GUI launches on macOS often have a stripped PATH.
    try {
        const { execSync } = require('child_process')
        const whichCommand = platform === 'win32' ? 'where' : 'which'
        const out = execSync(`${whichCommand} ${scrcpyBinary}`, {
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 4000,
        }).toString().trim().split(/\r?\n/)[0]
        if (out && fs.existsSync(out)) return out
    } catch (_) { /* not found in PATH */ }

    return null
}

/**
 * Register all system-related IPC handlers
 */
function registerSystemHandlers() {
    ipcMain.handle('account-creation:open', async (evt, input) => {
        const senderId = evt.sender?.id
        const fromMain = mainWindow && !mainWindow.isDestroyed() && senderId === mainWindow.webContents.id
        const fromDashboard = require('../lib/fleet-dashboard-window').getDashboardWebContentsIds().includes(senderId)
        if (!fromMain && !fromDashboard) {
            return { ok: false, error: 'Open account creation from the desktop dashboard.' }
        }
        const serial = typeof input?.serial === 'string' ? input.serial.trim() : ''
        const userId = String(input?.userId ?? '')
        if (!serial || !/^\d+$/.test(userId)) return { ok: false, error: 'Choose a connected phone and an existing profile.' }
        try {
            return require('../lib/fleet-dashboard-window').openCreateIgAccount({ serial, userId })
        } catch (error) { return { ok: false, error: error?.message || 'Could not open account creation.' } }
    })

    ipcMain.handle('toolbar:open-create-ig', async (evt, input) => {
        try {
            const toolbarWindow = require('electron').BrowserWindow.fromWebContents(evt.sender)
            if (!toolbarWindow || !require('../lib/mirror-toolbar').getToolbarWebContentsIds().includes(evt.sender.id)) {
                return { ok: false, error: 'sender is not a mirror sidebar' }
            }
            const serial = new URL(toolbarWindow.webContents.getURL()).searchParams.get('serial')
            const userId = String(input?.userId ?? '')
            if (!serial || !/^\d+$/.test(userId)) return { ok: false, error: 'Choose an existing phone profile.' }
            const current = String(await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)).trim()
            if (current !== userId) return { ok: false, error: 'The selected profile is no longer active. Refresh the sidebar and try again.' }
            return require('../lib/fleet-dashboard-window').openCreateIgAccount({ serial, userId })
        } catch (e) { return { ok: false, error: e?.message || String(e) } }
    })

    ipcMain.handle('toolbar:set-panel-mode', async (evt, mode) => {
        try {
            const BrowserWindow = require('electron').BrowserWindow
            const toolbarWindow = BrowserWindow.fromWebContents(evt.sender)
            if (!toolbarWindow) return { ok: false, error: 'no window for sender' }
            const mt = require('../lib/mirror-toolbar')
            if (!mt.getToolbarWebContentsIds().includes(evt.sender.id)) {
                return { ok: false, error: 'sender is not a mirror sidebar' }
            }
            const serial = new URL(toolbarWindow.webContents.getURL()).searchParams.get('serial')
            if (!serial) return { ok: false, error: 'sidebar serial is missing' }
            return { ok: mt.setPanelMode(serial, mode) }
        } catch (e) { return { ok: false, error: e?.message || String(e) } }
    })

    // 2.18.1: scheduler drawer expand — widens the toolbar BrowserWindow
    // by SCHED_DRAWER_WIDTH (540px) so the scheduler reflows into a
    // horizontal 3-col layout (STEPS | IG MODULES | POST SLOTS).
    // Triggered by the new expand button on the schedule header in
    // mirror-toolbar.html. Per scheduler-drawer.js proposal — close logs
    // panel first if it's open to avoid overflowing the screen on smaller
    // displays (logs 360 + drawer 540 + base 156 = 1056px).
    ipcMain.handle('toolbar:toggle-scheduler-panel', async (evt, open) => {
        try {
            const toolbarWindow = require('electron').BrowserWindow.fromWebContents(evt.sender)
            if (!toolbarWindow) return { ok: false, error: 'no window for sender' }
            const drawer = require('../lib/scheduler-drawer')
            if (open) {
                // Mutually exclusive with logs panel
                try {
                    const mt = require('../lib/mirror-toolbar')
                    const serial = require('url').parse(toolbarWindow.webContents.getURL(), true).query?.serial
                    if (serial) mt.setLogsExpanded(serial, false)
                } catch (_) {}
            }
            return await drawer.toggleSchedulerPanel(toolbarWindow, !!open)
        } catch (e) {
            return { ok: false, error: e?.message || String(e) }
        }
    })

    // 2.18.8: structured sidebar event logging — renderer-side sidebarLog()
    // calls this. Auto-injects the serial from the toolbar window's URL
    // (?serial=...) so every event is keyed to the right phone without the
    // caller having to pass it. Writes to launcher.log via the existing
    // launcher-log.write() — same jsonl format, same 5MB rotation.
    ipcMain.handle('sidebar:log-event', (evt, event, data) => {
        try {
            let serial = null
            try { serial = new URL(evt.sender.getURL()).searchParams.get('serial') || null } catch (_) {}
            require('../lib/launcher-log').write(String(event || 'sb:unknown'), { ...(data || {}), serial })
        } catch (_) {}
        return { ok: true }
    })

    // 2.17.0: open the launcher-log folder (used by Fleet panel
    // Troubleshoot modal).
    ipcMain.handle('logs:open-folder', async () => {
        try {
            const dir = require('../lib/launcher-log').getLogsDir()
            if (dir) shell.openPath(dir)
            return { ok: true, dir }
        } catch (e) { return { ok: false, error: e.message } }
    })

    // 2.17.8: Mac scrcpy auto-install. Renderer calls this when launchOne
    // returns code:'mac-scrcpy-missing'. Runs `brew install scrcpy` and
    // streams progress to live-log so the user can see what's happening.
    ipcMain.handle('mac:install-scrcpy', async (evt) => {
        if (process.platform !== 'darwin') {
            return { ok: false, error: 'only available on macOS' }
        }
        try {
            const installer = require('../lib/scrcpy-mac-installer')
            const log = require('../lib/launcher-log')
            const sender = evt?.sender
            const send = (line) => {
                try {
                    log.write('mac-scrcpy-install', { line: String(line).slice(0, 240) })
                    sender?.send?.('mac-install-progress', String(line))
                } catch (_) {}
            }
            send('Starting brew install scrcpy …')
            const r = await installer.ensureScrcpyOnMac({ onProgress: send })
            if (r.ok) send(`✓ scrcpy installed at ${r.binary} (source: ${r.source})`)
            else send(`✗ install failed: ${r.error}`)
            return r
        } catch (e) { return { ok: false, error: e?.message || String(e) } }
    })

    // ADB check and installation
    ipcMain.handle('check-adb', async () => {
        try {
            const output = await executeADB(['version'])
            const versionMatch = output.match(/Android Debug Bridge version (\d+\.\d+\.\d+)/)
            return {
                installed: true,
                version: versionMatch ? versionMatch[1] : 'Unknown',
                path: getADBPathForInstall()
            }
        } catch (error) {
            return { installed: false }
        }
    })

    ipcMain.handle('install-adb', async (event) => {
        const platform = os.platform()
        const { createWriteStream } = require('fs')
        const AdmZip = require('adm-zip')

        const downloadUrls = {
            win32: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
            darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
            linux: 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip'
        }

        const url = downloadUrls[platform]
        if (!url) {
            return { success: false, error: 'Unsupported platform' }
        }

        const tempDir = app.getPath('temp')
        const zipPath = path.join(tempDir, 'platform-tools.zip')
        // Extract to userData/adb/ — matches where getADBPathForInstall() looks
        const extractPath = path.join(app.getPath('userData'), 'adb')

        try {
            mainWindow.webContents.send('adb-install-progress', 10)

            // Download using the shared redirect-following helper
            await downloadWithRedirects(url, zipPath)

            mainWindow.webContents.send('adb-install-progress', 70)

            if (!fs.existsSync(extractPath)) {
                fs.mkdirSync(extractPath, { recursive: true })
            }

            const zip = new AdmZip(zipPath)
            zip.extractAllTo(tempDir, true)

            mainWindow.webContents.send('adb-install-progress', 85)

            const platformToolsDir = path.join(tempDir, 'platform-tools')

            // Recursively copy all files and subdirectories
            function copyDirRecursive(src, dest) {
                if (!fs.existsSync(dest)) {
                    fs.mkdirSync(dest, { recursive: true })
                }
                const entries = fs.readdirSync(src, { withFileTypes: true })
                for (const entry of entries) {
                    const srcPath = path.join(src, entry.name)
                    const destPath = path.join(dest, entry.name)
                    if (entry.isDirectory()) {
                        copyDirRecursive(srcPath, destPath)
                    } else {
                        fs.copyFileSync(srcPath, destPath)
                    }
                }
            }
            copyDirRecursive(platformToolsDir, extractPath)

            if (platform !== 'win32') {
                const adbPath = path.join(extractPath, 'adb')
                fs.chmodSync(adbPath, '755')
            }

            mainWindow.webContents.send('adb-install-progress', 95)

            fs.unlinkSync(zipPath)
            fs.rmSync(platformToolsDir, { recursive: true, force: true })

            await startADBServer()

            mainWindow.webContents.send('adb-install-progress', 100)

            const output = await executeADB(['version'])
            const versionMatch = output.match(/Android Debug Bridge version (\d+\.\d+\.\d+)/)

            return {
                success: true,
                version: versionMatch ? versionMatch[1] : 'Unknown'
            }
        } catch (error) {
            console.error('ADB installation failed:', error)
            return { success: false, error: error.message }
        }
    })

    // Update checking and installation
    ipcMain.handle('check-for-updates', async () => {
        try {
            const platform = os.platform() === 'darwin' ? 'mac' : 'windows'
            const version = app.getVersion()
            // Canonical host only. This call carries no credentials, but the
            // apex→www 308 is what silently stripped them on the credentialed
            // paths (2026-07-25 "Create IG → Unauthorized"), so the rule is
            // absolute and guard-tested: no apex literal anywhere under electron/.
            const response = await fetch(`https://www.shadowphone.io/api/updates/check?platform=${platform}&version=${version}&arch=${process.arch}`)
            if (!response.ok) { console.warn('[Update] check failed:', response.status); return { hasUpdate: false } }
            const data = await response.json()

            if (data.hasUpdate && mainWindow) {
                mainWindow.webContents.send('update-available', {
                    currentVersion: version,
                    latestVersion: data.latestVersion,
                    downloadUrl: data.downloadUrl,
                    changelog: data.changelog,
                    fileSize: data.fileSize
                })
            }

            return data
        } catch (error) {
            console.error('Update check failed:', error)
            return { hasUpdate: false }
        }
    })

    ipcMain.handle('download-update', async (event, payload) => {
        // Re-entrancy guard. See _downloadInFlight definition above for why.
        // Renderer also disables the button while progress events fire, but
        // this is the authoritative server-side gate.
        if (_downloadInFlight) {
            const msg = 'An update download is already running — please wait for it to finish.'
            console.warn(`[Update] download-update rejected: ${msg}`)
            try { mainWindow.webContents.send('update-download-error', msg) } catch (_) {}
            return { success: false, error: msg }
        }
        _downloadInFlight = true
        try {
            // Accept either a bare URL string (legacy renderer) or an options
            // object { downloadUrl, fileSize, version }. The API's /updates/check
            // response carries fileSize and latestVersion alongside downloadUrl —
            // when the renderer forwards them we use them to verify the download
            // and stamp the filename so a stale old-version file can never be
            // confused for the current one.
            const downloadUrl = typeof payload === 'string' ? payload : (payload && payload.downloadUrl)
            const expectedSize = typeof payload === 'object' && payload && Number.isFinite(Number(payload.fileSize))
                ? Number(payload.fileSize)
                : null
            const versionTag = (typeof payload === 'object' && payload && payload.version)
                ? String(payload.version).replace(/[^0-9.]/g, '')
                : 'unknown'

            // Clear any previous session install record so a leftover token
            // from an aborted prior download can never authorize the new install.
            _sessionInstall = null

            if (!downloadUrl || String(downloadUrl).trim() === '') {
                mainWindow.webContents.send('update-download-error', 'No download URL available yet. Please check back soon!')
                return { success: false, error: 'No download URL available' }
            }

            // Security: Only allow downloads from trusted sources. Exact host
            // matching (not endsWith suffix-matching, which an attacker could
            // satisfy with e.g. evil-shadowphone.io or shadowphone.io.attacker.com),
            // plus a pinned path prefix on the release bucket so only the public
            // releases storage object can be fetched.
            try {
                const urlObj = new URL(downloadUrl)
                const host = urlObj.hostname
                const isAppHost = host === 'www.shadowphone.io' || host === 'shadowphone.io'
                const isReleaseBucket = host === 'hjdkcejdrnkhycctqegj.supabase.co'
                    && urlObj.pathname.startsWith('/storage/v1/object/public/releases/')
                if (urlObj.protocol !== 'https:' || !(isAppHost || isReleaseBucket)) {
                    console.error(`[Security] Blocked update download from untrusted URL: ${downloadUrl}`)
                    return { success: false, error: 'Download URL not from trusted source' }
                }
            } catch {
                return { success: false, error: 'Invalid download URL' }
            }

            const platform = os.platform()
            const ext = platform === 'darwin' ? '.dmg' : '.exe'
            // Version-stamp the filename so a stale file from a previous version
            // can never be silently used by install-update.
            const downloadPath = path.join(app.getPath('temp'), `ShadowPhone-update-${versionTag}${ext}`)

            // Remove any pre-existing ShadowPhone-update* files in temp to
            // ensure no stale installer from a previous session or aborted
            // download survives to be executed.
            try {
                const tempDir = app.getPath('temp')
                const stalePattern = new RegExp(`^ShadowPhone-update.*\\${ext}$`, 'i')
                for (const entry of fs.readdirSync(tempDir)) {
                    if (stalePattern.test(entry)) {
                        try { fs.unlinkSync(path.join(tempDir, entry)) } catch (_) { /* best-effort */ }
                    }
                }
            } catch (_) { /* best-effort cleanup */ }

            const response = await fetch(downloadUrl)
            if (!response.ok) {
                mainWindow.webContents.send('update-download-error', `Download failed: ${response.statusText}`)
                return { success: false, error: response.statusText }
            }

            // INTEGRITY GUARD 1 — content type. Supabase storage 404s and
            // error pages come back as text/html or application/json. If the
            // server isn't handing us a binary, abort before we write a web
            // page to ShadowPhone-update.exe and Windows rejects it with
            // "This app can't run on your PC".
            const contentType = String(response.headers.get('content-type') || '').toLowerCase()
            if (contentType.includes('text/html') || contentType.includes('application/json')) {
                const msg = `Update server returned an error page (content-type: ${contentType || 'unknown'}), not the installer. Try again shortly.`
                console.error(`[Update] ${msg}`)
                mainWindow.webContents.send('update-download-error', msg)
                return { success: false, error: msg }
            }

            // Stream the body so the renderer can show a real progress bar
            // (the previous response.arrayBuffer() buffered everything silently;
            // on Mac there's no OS-level Save dialog so the user had no idea
            // anything was happening and clicked Update repeatedly → multiple
            // concurrent downloads → install fights → "multiple instances" lag).
            const total = expectedSize || Number(response.headers.get('content-length')) || 0
            const chunks = []
            let downloadedSize = 0
            let lastEmittedPct = -1
            let lastEmittedAt = 0
            const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null
            if (reader) {
                // Fire a zero-progress event immediately so the renderer can
                // flip the button into "Downloading…" state before any bytes
                // arrive (matters for the first few hundred ms on slow links).
                try {
                    mainWindow.webContents.send('update-download-progress', {
                        bytes: 0, total, pct: 0, version: versionTag,
                    })
                } catch (_) { /* renderer gone — keep downloading anyway */ }
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break
                    if (value) {
                        chunks.push(Buffer.from(value))
                        downloadedSize += value.length
                        // Emit progress at most every 200ms OR when crossing
                        // a 1% boundary, whichever is sooner. Keeps the UI
                        // smooth without flooding IPC.
                        const now = Date.now()
                        const pct = total > 0 ? Math.floor((downloadedSize / total) * 100) : -1
                        if (pct !== lastEmittedPct || now - lastEmittedAt > 200) {
                            lastEmittedPct = pct
                            lastEmittedAt = now
                            try {
                                mainWindow.webContents.send('update-download-progress', {
                                    bytes: downloadedSize, total, pct, version: versionTag,
                                })
                            } catch (_) { /* keep going */ }
                        }
                    }
                }
            } else {
                // Fallback for very old fetch impls — single-shot read.
                const ab = await response.arrayBuffer()
                chunks.push(Buffer.from(ab))
                downloadedSize = ab.byteLength
            }
            const buffer = Buffer.concat(chunks, downloadedSize)

            // INTEGRITY GUARD 2 — size sanity. A real ShadowPhone installer
            // is ~140-200MB. Anything tiny is a truncated download or an
            // error body. Reject before writing.
            const MIN_INSTALLER_BYTES = 5 * 1024 * 1024 // 5MB floor
            if (downloadedSize < MIN_INSTALLER_BYTES) {
                const msg = `Downloaded file is only ${(downloadedSize / 1024).toFixed(0)}KB — too small to be a valid installer. The download was incomplete or the server returned an error.`
                console.error(`[Update] ${msg}`)
                mainWindow.webContents.send('update-download-error', msg)
                return { success: false, error: msg }
            }

            // INTEGRITY GUARD 3 — exact size match. The /updates/check API
            // and the app_releases table both record file_size. When the
            // renderer forwards it, the download must match it byte-for-byte;
            // a mismatch means a partial/corrupt/stale file.
            if (expectedSize && expectedSize > 0 && downloadedSize !== expectedSize) {
                const msg = `Downloaded ${downloadedSize} bytes but expected ${expectedSize}. The download is corrupt or incomplete — not running it.`
                console.error(`[Update] ${msg}`)
                mainWindow.webContents.send('update-download-error', msg)
                return { success: false, error: msg }
            }

            // INTEGRITY GUARD 4 — executable format. A valid Windows
            // installer is a PE file starting with the "MZ" magic bytes
            // (0x4D 0x5A); a macOS .dmg starts with a koly/UDIF structure
            // (we sanity-check it isn't HTML/JSON instead). This is the
            // direct check against the exact Windows error in this bug:
            // Windows refuses any .exe that isn't a real PE binary.
            if (platform !== 'darwin') {
                if (buffer.length < 2 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
                    const head = buffer.slice(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
                    const msg = `Downloaded file is not a valid Windows executable (missing MZ header, starts with "${head}"). Refusing to run a corrupt installer.`
                    console.error(`[Update] ${msg}`)
                    mainWindow.webContents.send('update-download-error', msg)
                    return { success: false, error: msg }
                }
            } else {
                // .dmg files must not be HTML/JSON masquerading as a binary.
                const headText = buffer.slice(0, 64).toString('latin1').toLowerCase()
                if (headText.includes('<!doctype') || headText.includes('<html') || headText.trimStart().startsWith('{')) {
                    const msg = 'Downloaded file is not a valid macOS disk image. Refusing to run a corrupt installer.'
                    console.error(`[Update] ${msg}`)
                    mainWindow.webContents.send('update-download-error', msg)
                    return { success: false, error: msg }
                }
            }

            fs.writeFileSync(downloadPath, buffer)

            // Post-write verification — confirm the bytes actually landed.
            const writtenSize = fs.statSync(downloadPath).size
            if (writtenSize !== downloadedSize) {
                const msg = `Installer write incomplete (wrote ${writtenSize} of ${downloadedSize} bytes). Disk may be full.`
                console.error(`[Update] ${msg}`)
                try { fs.unlinkSync(downloadPath) } catch (_) { /* best-effort */ }
                mainWindow.webContents.send('update-download-error', msg)
                return { success: false, error: msg }
            }

            console.log(`[Update] Installer verified (${(downloadedSize / 1024 / 1024).toFixed(1)}MB) → ${downloadPath}`)

            // Record this download as the session-authorised install. install-update
            // will reject any path that doesn't match, preventing a stale or
            // tampered file from ever being executed.
            _sessionInstall = { path: downloadPath, version: versionTag }

            mainWindow.webContents.send('update-downloaded', downloadPath)

            return { success: true, path: downloadPath }
        } catch (error) {
            mainWindow.webContents.send('update-download-error', error.message)
            return { success: false, error: error.message }
        } finally {
            // Release the in-flight gate so a retry after failure (or a
            // post-install second update later in the session) can proceed.
            _downloadInFlight = false
        }
    })

    ipcMain.handle('install-update', async (event, installerPath) => {
        try {
            // Security: Validate installer is in temp dir with expected extension
            const tempDir = app.getPath('temp')
            const resolvedPath = path.resolve(installerPath)
            if (!resolvedPath.startsWith(tempDir)) {
                console.error(`[Security] Blocked installer execution outside temp dir: ${resolvedPath}`)
                return { success: false, error: 'Invalid installer path' }
            }

            const platform = os.platform()
            const expectedExt = platform === 'darwin' ? '.dmg' : '.exe'
            if (!resolvedPath.endsWith(expectedExt)) {
                console.error(`[Security] Blocked installer with unexpected extension: ${resolvedPath}`)
                return { success: false, error: 'Invalid installer file type' }
            }

            // Session-binding guard: install-update may only execute the exact
            // file that download-update produced in this session. If the paths
            // don't match (stale temp file, path from a previous session, or the
            // renderer passed a wrong path) hard-fail before touching disk.
            if (!_sessionInstall || _sessionInstall.path !== resolvedPath) {
                const reason = !_sessionInstall
                    ? 'No update was downloaded in this session'
                    : `Path mismatch: expected ${_sessionInstall.path}, got ${resolvedPath}`
                console.error(`[Security] Blocked install-update — ${reason}`)
                return { success: false, error: 'No valid update download found for this session. Please re-download the update.' }
            }

            // Integrity re-check at execution time. The file may have been
            // written by an older build without download-time verification,
            // or partially overwritten between download and install. On
            // Windows, confirm the PE "MZ" magic before spawning — running
            // a non-PE .exe is exactly the "This app can't run on your PC"
            // failure this guard exists to prevent.
            if (!fs.existsSync(resolvedPath)) {
                _sessionInstall = null
                return { success: false, error: 'Installer file not found' }
            }
            const installerSize = fs.statSync(resolvedPath).size
            if (installerSize < 5 * 1024 * 1024) {
                console.error(`[Security] Blocked undersized installer (${installerSize} bytes): ${resolvedPath}`)
                return { success: false, error: 'Installer file is corrupt or incomplete — please re-download the update.' }
            }
            if (platform === 'win32') {
                const fd = fs.openSync(resolvedPath, 'r')
                const magic = Buffer.alloc(2)
                fs.readSync(fd, magic, 0, 2, 0)
                fs.closeSync(fd)
                if (magic[0] !== 0x4d || magic[1] !== 0x5a) {
                    console.error(`[Security] Blocked non-PE installer (magic=${magic.toString('hex')}): ${resolvedPath}`)
                    return { success: false, error: 'Installer is not a valid Windows executable — please re-download the update.' }
                }
            }

            // Consume the session token — prevents any second install-update
            // call from reusing the same file (e.g. double-click on the button).
            _sessionInstall = null

            if (platform === 'win32') {
                spawn(resolvedPath, [], { detached: true, stdio: 'ignore' }).on('error', e => console.error('[Update] installer spawn error:', e?.message || e)).unref()
                app.quit()
            } else if (platform === 'darwin') {
                // Programmatic in-place replace. shell.openPath alone just
                // mounts the DMG and leaves the user to drag manually — many
                // never did, so they stayed on the old version. This script
                // waits for the current app to quit, mounts the DMG, replaces
                // the installed .app, strips the quarantine xattr, unmounts,
                // and relaunches.
                const exePath = app.getPath('exe')
                const appDir = exePath.replace(/\/Contents\/MacOS\/[^/]+$/, '')
                if (!appDir.endsWith('.app')) {
                    // Can't resolve the installed .app — fall back to Finder.
                    await shell.openPath(resolvedPath)
                    app.quit()
                    return { success: true, fallback: 'finder' }
                }
                const scriptPath = path.join(app.getPath('temp'), 'shadowphone-mac-install.sh')
                const script = [
                    '#!/bin/bash',
                    'set -e',
                    'DMG=' + JSON.stringify(resolvedPath),
                    'APP=' + JSON.stringify(appDir),
                    'sleep 2',
                    'MOUNT=$(hdiutil attach -nobrowse -noverify -noautoopen "$DMG" 2>/dev/null | tail -1 | awk \'{print $NF}\')',
                    'if [ -z "$MOUNT" ] || [ ! -d "$MOUNT/ShadowPhone.app" ]; then',
                    '  open "$DMG"',
                    '  exit 1',
                    'fi',
                    'rm -rf "$APP"',
                    'cp -R "$MOUNT/ShadowPhone.app" "$APP"',
                    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true',
                    'hdiutil detach "$MOUNT" -quiet -force 2>/dev/null || true',
                    'open "$APP"',
                    '',
                ].join('\n')
                fs.writeFileSync(scriptPath, script, { mode: 0o755 })
                spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref()
                app.quit()
            }

            return { success: true }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    // App info
    ipcMain.handle('get-app-info', () => {
        return {
            version: app.getVersion(),
            name: app.getName(),
            platform: os.platform(),
            arch: os.arch()
        }
    })

    ipcMain.handle('get-api-config', () => {
        // SECURITY: Never expose API secrets to the renderer process.
        // The renderer only needs the server URL -- auth is handled by the
        // main process via JWT tokens fetched from the Clerk session.
        return {
            serverUrl: process.env.SHADOWPHONE_MODULES_SERVER || '',
            // apiSecret is intentionally omitted -- secrets stay in main process only
        }
    })

    // --- Scrcpy download helper: follows up to maxRedirects hops ---
    function downloadWithRedirects(url, destPath, maxRedirects = 5) {
        return new Promise((resolve, reject) => {
            const doRequest = (currentUrl, redirectsLeft) => {
                const proto = currentUrl.startsWith('https') ? https : require('http')
                proto.get(currentUrl, (response) => {
                    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                        response.resume() // drain
                        if (redirectsLeft <= 0) {
                            return reject(new Error(`Too many redirects for ${url}`))
                        }
                        const nextUrl = response.headers.location
                        console.log(`[Scrcpy] Redirect ${response.statusCode} → ${nextUrl}`)
                        return doRequest(nextUrl, redirectsLeft - 1)
                    }
                    if (response.statusCode !== 200) {
                        response.resume()
                        return reject(new Error(`HTTP ${response.statusCode} downloading ${currentUrl}`))
                    }
                    const file = fs.createWriteStream(destPath)
                    response.pipe(file)
                    file.on('finish', () => file.close(resolve))
                    file.on('error', (err) => {
                        fs.unlink(destPath, () => {}) // cleanup partial
                        reject(err)
                    })
                }).on('error', reject)
            }
            doRequest(url, maxRedirects)
        })
    }

    // --- Shared install logic (used by both install-scrcpy and launch-scrcpy) ---
    async function installScrcpyInternal() {
        const platform = os.platform()
        try {
            if (platform === 'darwin') {
                const { execSync, spawn } = require('child_process')

                // Stream brew install output to a log file so users hitting
                // a failed install can ship the file with their bug report.
                const logsDir = path.join(app.getPath('userData'), 'logs')
                try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }) } catch (_) {}
                const installLogPath = path.join(logsDir, 'mac-scrcpy-install.log')
                const installLog = (line) => {
                    try {
                        fs.appendFileSync(installLogPath, `[${new Date().toISOString()}] ${String(line).replace(/\s+$/, '')}\n`)
                    } catch (_) { /* best-effort */ }
                }
                try { fs.writeFileSync(installLogPath, '') } catch (_) { /* truncate fresh */ }
                installLog('mac-scrcpy-install: starting')

                const runCommand = (command, args, options = {}) => new Promise((resolve) => {
                    installLog(`exec: ${command} ${(args || []).join(' ')}`)
                    const child = spawn(command, args, {
                        stdio: ['ignore', 'pipe', 'pipe'],
                        ...options,
                    })
                    let stdout = ''
                    let stderr = ''
                    child.stdout?.on('data', (chunk) => {
                        const text = String(chunk)
                        stdout += text
                        for (const line of text.split(/\r?\n/)) {
                            if (line.length) installLog(`stdout: ${line}`)
                        }
                    })
                    child.stderr?.on('data', (chunk) => {
                        const text = String(chunk)
                        stderr += text
                        for (const line of text.split(/\r?\n/)) {
                            if (line.length) installLog(`stderr: ${line}`)
                        }
                    })
                    child.on('close', (code) => {
                        installLog(`exit: code=${code}`)
                        resolve({ code, stdout, stderr })
                    })
                    child.on('error', (error) => {
                        installLog(`spawn-error: ${error?.message || error}`)
                        resolve({ code: 1, stdout, stderr: error.message || stderr })
                    })
                })

                let brewPath = null
                const brewCandidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']
                for (const candidate of brewCandidates) {
                    if (fs.existsSync(candidate)) {
                        brewPath = candidate
                        break
                    }
                }

                if (!brewPath) {
                    try {
                        brewPath = execSync("bash -lc 'command -v brew 2>/dev/null'", {
                            stdio: ['ignore', 'pipe', 'ignore'],
                            timeout: 4000,
                        }).toString().trim() || null
                    } catch (e) {
                        brewPath = null
                    }
                }

                if (!brewPath) {
                    installLog('Homebrew not found')
                    const { dialog } = require('electron')
                    try {
                        await dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            buttons: ['Open brew.sh', 'Cancel'],
                            defaultId: 0,
                            title: 'Homebrew required',
                            message: 'Homebrew is required to install scrcpy on Mac.',
                            detail: 'Install Homebrew first from https://brew.sh, then come back and try Install Now again.\n\nLog: ' + installLogPath,
                        }).then(r => { if (r.response === 0) shell.openExternal('https://brew.sh') })
                    } catch (_) {
                        shell.openExternal('https://brew.sh')
                    }
                    return {
                        success: false,
                        message: 'Homebrew not found. Install Homebrew from https://brew.sh, then retry.',
                        logPath: installLogPath,
                    }
                }
                installLog(`brewPath=${brewPath}`)

                const alreadyInstalled = await runCommand(brewPath, ['list', '--versions', 'scrcpy'])
                if (alreadyInstalled.code === 0 && alreadyInstalled.stdout.trim()) {
                    const existingPath = getScrcpyPath()
                    installLog(`already-installed at ${existingPath || '(not on PATH)'}`)
                    return {
                        success: true,
                        message: 'scrcpy is already installed.',
                        scrcpyPath: existingPath,
                        logPath: installLogPath,
                    }
                }

                console.log('[Scrcpy] Installing on macOS via Homebrew...')
                const installResult = await runCommand(brewPath, ['install', 'scrcpy'], {
                    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
                })

                if (installResult.code !== 0) {
                    const tail = (installResult.stderr || installResult.stdout || '').split(/\r?\n/).filter(Boolean).slice(-6).join(' | ')
                    return {
                        success: false,
                        message: `brew install scrcpy failed (exit ${installResult.code}). Last output: ${tail || 'no output'}. Full log: ${installLogPath}`,
                        logPath: installLogPath,
                    }
                }

                const installedPath = getScrcpyPath()
                installLog(`post-install getScrcpyPath()=${installedPath || '(null)'}`)
                if (!installedPath) {
                    return {
                        success: false,
                        message: `brew install reported success but scrcpy was not found on PATH. Log: ${installLogPath}`,
                        logPath: installLogPath,
                    }
                }

                return {
                    success: true,
                    message: `scrcpy installed successfully at ${installedPath}.`,
                    scrcpyPath: installedPath,
                    logPath: installLogPath,
                }
            }

            if (platform === 'linux') {
                shell.openExternal('https://github.com/Genymobile/scrcpy/blob/master/doc/linux.md')
                return {
                    success: false,
                    message: 'Auto-install is not supported on Linux yet. Install scrcpy with your package manager.',
                }
            }

            const AdmZip = require('adm-zip')
            const scrcpyUrl = 'https://github.com/Genymobile/scrcpy/releases/download/v3.1/scrcpy-win64-v3.1.zip'
            const downloadDir = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'scrcpy')
            const zipPath = path.join(downloadDir, 'scrcpy-win64-v3.1.zip')

            if (!fs.existsSync(downloadDir)) {
                fs.mkdirSync(downloadDir, { recursive: true })
            }

            console.log('[Scrcpy] Downloading scrcpy...')
            await downloadWithRedirects(scrcpyUrl, zipPath)
            console.log('[Scrcpy] Download complete, extracting...')

            const zip = new AdmZip(zipPath)
            zip.extractAllTo(downloadDir, true)
            fs.unlinkSync(zipPath)

            console.log('[Scrcpy] Installation complete!')
            return { success: true, message: 'scrcpy installed successfully!' }
        } catch (error) {
            console.error('[Scrcpy] Install failed:', error)
            shell.openExternal('https://github.com/Genymobile/scrcpy/releases/latest')
            return { success: false, message: `Auto-install failed: ${error.message}. Opening download page...` }
        }
    }

    // Scrcpy handlers
    ipcMain.handle('check-scrcpy', async () => {
        const scrcpyPath = getScrcpyPath()
        return { available: !!scrcpyPath, path: scrcpyPath }
    })

    ipcMain.handle('install-scrcpy', async () => {
        return await installScrcpyInternal()
    })

    // Mac diagnostics — collect everything needed to triage a "scrcpy
    // doesn't work" report without needing a Mac in front of us. Safe to
    // call on any platform (returns notMac=true otherwise).
    ipcMain.handle('mac:diagnose-scrcpy', async (event, inputSerial) => {
        const platform = os.platform()
        if (platform !== 'darwin') {
            return { notMac: true, platform }
        }

        const result = {
            platform,
            arch: os.arch(),
            hasBrew: false,
            brewPath: null,
            scrcpyPath: null,
            scrcpyVersion: null,
            tccGranted: null,
            tccClients: [],
            tccError: null,
            recentStderr: [],
            installLogTail: [],
            logPath: null,
            installLogPath: null,
            errors: [],
        }

        try {
            for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
                if (fs.existsSync(candidate)) {
                    result.brewPath = candidate
                    result.hasBrew = true
                    break
                }
            }
            if (!result.hasBrew) {
                try {
                    const out = spawnSync('bash', ['-lc', 'command -v brew 2>/dev/null'], {
                        encoding: 'utf8',
                        timeout: 3000,
                    })
                    const p = String(out.stdout || '').trim()
                    if (p && fs.existsSync(p)) {
                        result.brewPath = p
                        result.hasBrew = true
                    }
                } catch (e) {
                    result.errors.push(`brew probe: ${e?.message || e}`)
                }
            }
        } catch (e) {
            result.errors.push(`brew check: ${e?.message || e}`)
        }

        try {
            result.scrcpyPath = getScrcpyPath()
        } catch (e) {
            result.errors.push(`scrcpy path: ${e?.message || e}`)
        }

        if (result.scrcpyPath) {
            try {
                const v = spawnSync(result.scrcpyPath, ['--version'], {
                    encoding: 'utf8',
                    timeout: 3000,
                })
                result.scrcpyVersion = String(v.stdout || v.stderr || '').split(/\r?\n/)[0]?.trim() || null
            } catch (e) {
                result.errors.push(`scrcpy --version: ${e?.message || e}`)
            }
        }

        try {
            const tcc = checkMacScreenRecordingPermission()
            result.tccGranted = tcc.granted
            result.tccClients = tcc.clients
            result.tccError = tcc.error
        } catch (e) {
            result.errors.push(`tcc check: ${e?.message || e}`)
        }

        const serial = normalizeSerial(inputSerial)
        const logPath = serial ? getScrcpyLogPathForSerial(serial) : null
        result.logPath = logPath
        if (logPath && fs.existsSync(logPath)) {
            try {
                const text = fs.readFileSync(logPath, 'utf8')
                result.recentStderr = text.split(/\r?\n/).filter(Boolean).slice(-50)
            } catch (e) {
                result.errors.push(`read log: ${e?.message || e}`)
            }
        }

        try {
            const installLogPath = path.join(app.getPath('userData'), 'logs', 'mac-scrcpy-install.log')
            result.installLogPath = installLogPath
            if (fs.existsSync(installLogPath)) {
                const text = fs.readFileSync(installLogPath, 'utf8')
                result.installLogTail = text.split(/\r?\n/).filter(Boolean).slice(-50)
            }
        } catch (e) {
            result.errors.push(`read install log: ${e?.message || e}`)
        }

        return result
    })

    async function getConnectedDeviceSerials() {
        try {
            const output = await executeADB(['devices'])
            const lines = output.split('\n').slice(1)
            return lines
                .map(line => line.trim())
                .filter(line => line && line.includes('\tdevice'))
                .map(line => line.split('\t')[0])
        } catch (error) {
            console.error('[Scrcpy] Failed to list devices:', error)
            return []
        }
    }

    // Public entry point: one launch per serial at a time, every caller gets the
    // SAME resolved result. The transport toggle deliberately passes the OTHER
    // serial form (different key), and the fast-fail retry calls
    // spawnScrcpyAtSlot directly — neither can be swallowed by this.
    async function launchScrcpyForSerial(inputSerial, opts = {}) {
        const serial = normalizeSerial(inputSerial)
        if (!serial) return { success: false, error: 'Missing device serial' }
        const inflight = scrcpyLaunchPromises.get(serial)
        if (inflight) {
            try { require('../lib/launcher-log').write('scrcpy:launch-coalesced', { serial }) } catch (_) {}
            return inflight
        }
        const launch = Promise.resolve(_launchScrcpyForSerialInner(serial, opts))
            .finally(() => { scrcpyLaunchPromises.delete(serial) })
        scrcpyLaunchPromises.set(serial, launch)
        return launch
    }

    async function _launchScrcpyForSerialInner(inputSerial, opts = {}) {
        const serial = normalizeSerial(inputSerial)
        // 2.17.2: trace caller so we can prove who is auto-launching mirrors
        // on app startup. Writes to launcher.log via the existing logger.
        try {
            const callerStack = new Error('launchScrcpyForSerial call site').stack || ''
            const callerLines = callerStack.split('\n').slice(1, 6).map(l => l.trim()).join(' | ')
            require('../lib/launcher-log').write('launchScrcpyForSerial:invoked', {
                serial, inputSerial, caller: callerLines,
            })
        } catch (_) {}
        if (!serial) {
            return { success: false, error: 'Missing device serial' }
        }
        // 2.17.12: every alreadyRunning return MUST also ensure a toolbar
        // exists for the serial — otherwise the user sees a mirror with no
        // sidebar. The original 3 return points just returned success and
        // skipped createToolbar entirely.
        const _ensureSidebarForRunning = (msg) => {
            // Belt for the coalescing above: with NO live mirror for this serial
            // — neither a tracked process nor an enumerated one — there is
            // nothing to attach a sidebar to. Fabricating one (scrcpyPid:null,
            // mirrorTitle = raw serial) and answering {success:true,
            // alreadyRunning:true} left a phantom panel bound to no process.
            // Say so instead, and let the caller retry.
            const _tracked = scrcpyProcesses.get(serial)
            const _liveMirror = (_tracked && isScrcpyProcessAlive(_tracked))
                || hasRunningScrcpyForSerial(serial)
            if (!_liveMirror) {
                return {
                    success: false,
                    retryable: true,
                    error: 'A mirror launch is already in progress for this device',
                }
            }
            try {
                const mt = require('../lib/mirror-toolbar')
                // H6: a leaked headless toolbar (offscreen -10000,-10000, never
                // .show()'d, no docking machinery) from an earlier scheduled run
                // still lives in toolbarWindows, so hasToolbar() reports true for
                // it — and the fast path below would then skip createToolbar,
                // leaving the user with a mirror and no visible sidebar. Prefer
                // hasVisibleToolbar (which excludes headless-backed serials) and
                // fall back to hasToolbar only if the new export is absent.
                const hasVis = (typeof mt.hasVisibleToolbar === 'function')
                    ? mt.hasVisibleToolbar
                    : mt.hasToolbar
                // H2: the live mirror may be running under the phone's OTHER
                // transport serial (USB udid vs tailnet ip:port). If a toolbar
                // already exists for any sameDevice()-matched serial, do NOT
                // create a phantom second sidebar keyed on this serial — the
                // existing one is the real one. Resolve to that serial for the
                // visible-toolbar check.
                let toolbarSerial = serial
                if (typeof hasVis === 'function' && !hasVis(serial)
                    && _lastDeviceSnapshot && _lastDeviceSnapshot.length) {
                    try {
                        const { sameDevice } = require('../lib/device-identity')
                        for (const [key, proc] of scrcpyProcesses.entries()) {
                            if (key === serial) continue
                            if (!isScrcpyProcessAlive(proc)) continue
                            if (sameDevice(key, serial, _lastDeviceSnapshot) && hasVis(key)) {
                                toolbarSerial = key
                                break
                            }
                        }
                    } catch (_) {}
                }
                if (typeof hasVis !== 'function' || !hasVis(toolbarSerial)) {
                    const title = scrcpyTitleBySerial.get(serial) || serial
                    // Pass the live scrcpy PID so docking matches by PID (reliable,
                    // title-agnostic) instead of the title — which for an
                    // `adb connect <ip>:<port>` device drifts to "<peer> · <ip>"
                    // while this path's `title` is the raw "<ip>:<port>", so a
                    // title-only match missed and the sidebar showed undocked.
                    const _runProc = scrcpyProcesses.get(serial)
                    const _runPid = (_runProc && isScrcpyProcessAlive(_runProc)) ? _runProc.pid : null
                    // Best-effort placement — the reposition tracker will pin
                    // it to the right edge of the scrcpy window on the next
                    // tick (1s safety-net loop catches it).
                    mt.createToolbar({
                        serial,
                        x: 800, y: 100, height: 800,
                        mirrorTitle: title,
                        transport: serial.includes(':') ? 'tailscale' : 'usb',
                        tailnetIp: serial.includes(':') ? serial.split(':')[0] : null,
                        scrcpyPid: _runPid,
                    })
                    require('../lib/launcher-log').write('scrcpy:already-running-sidebar-created', { serial, title })
                }
            } catch (e) {
                console.warn('[Scrcpy] ensure sidebar on alreadyRunning failed:', e?.message || e)
            }
            return { success: true, alreadyRunning: true, message: msg }
        }

        if (scrcpyLaunchInFlight.has(serial)) {
            return _ensureSidebarForRunning('scrcpy launch already in progress for this device')
        }
        // NOTE: scrcpyLaunchInFlight.add(serial) is deliberately NOT taken here.
        // It used to span the (possibly unbounded) scrcpy-not-found install
        // dialog / Mac-TCC prompt below, which blocked watchdog recovery for as
        // long as the user left the modal open. We now acquire it just before
        // the port-allocation/spawn critical section (after the install-failed
        // guard) so only the part that actually needs dedup — port pick, layout,
        // spawnScrcpyAtSlot — is covered. The alreadyRunning + transport-switch
        // guards below short-circuit BEFORE the dialog, so they don't need it.
        try {
            // H2: refresh the device snapshot BEFORE the alreadyRunning guard so
            // hasRunningScrcpyForSerial can collapse this serial to a mirror
            // already running under the phone's OTHER transport (USB udid vs
            // tailnet ip:port). Best-effort — a failed/empty enumeration just
            // falls back to exact-key matching (pre-fix behavior).
            try {
                if (getConnectedDevicesFn) {
                    const snap = await getConnectedDevicesFn()
                    if (Array.isArray(snap) && snap.length) _lastDeviceSnapshot = snap
                }
            } catch (_) { /* keep last snapshot */ }

            if (scrcpyProcesses.has(serial)) {
                const existing = scrcpyProcesses.get(serial)
                if (isScrcpyProcessAlive(existing)) {
                    return _ensureSidebarForRunning('scrcpy already running for this device')
                }
                // Stale process entry cleanup — BUT if an equalizer / profile-
                // switch respawn is in flight for this serial, the dead entry is
                // mid-replacement: that respawn's spawnScrcpyAtSlot owns these
                // maps (port/title/adbTarget) and will overwrite the proc entry.
                // Deleting them here would yank the bookkeeping out from under
                // it. Leave them for the in-flight respawn to own.
                if (!scrcpyRespawning.has(serial)) {
                    scrcpyProcesses.delete(serial)
                    scrcpyPortBySerial.delete(serial)
                    scrcpyTitleBySerial.delete(serial)
                    scrcpyAdbTargetBySerial.delete(serial)
                }
            }

            // Transport SWITCH: if a mirror for THIS phone is already running on the
            // OTHER transport form (USB udid vs tailnet ip:port), the caller is
            // switching the connection (the USB/WiFi toggle). Close the stale-transport
            // mirror so we relaunch on the REQUESTED transport — instead of reusing it
            // (toggle never switches) or spawning a duplicate (two mirrors, one phone).
            try {
                const { sameDevice } = require('../lib/device-identity')
                const reqTcp = String(serial).includes(':')
                for (const [key, proc] of [...scrcpyProcesses.entries()]) {
                    if (key === serial) continue
                    if (!isScrcpyProcessAlive(proc)) continue
                    if (String(key).includes(':') === reqTcp) continue        // same transport form → normal dedup
                    if (!sameDevice(key, serial, _lastDeviceSnapshot)) continue // different phone → leave alone
                    // Cancel any pending fast-fail retry for the OLD transport key
                    // (mirror stop-scrcpy) — otherwise a queued retry re-spawns the
                    // just-killed transport ~1s later = ghost second mirror.
                    scrcpyRetryCanceled.add(key); scrcpyFastFailRetried.delete(key)
                    await killScrcpyAndWait(proc)
                    scrcpyProcesses.delete(key); scrcpyPortBySerial.delete(key)
                    scrcpyTitleBySerial.delete(key); scrcpyAdbTargetBySerial.delete(key)
                    try { require('../lib/mirror-toolbar').closeToolbar(key, { force: true }) } catch (_) {}
                    require('../lib/launcher-log').write('scrcpy:transport-switch', { from: key, to: serial })
                }
            } catch (_) { /* best-effort; fall through to normal dedup */ }

            // Also catch mirrors that were opened outside this app session.
            // 2.16.18: before reporting alreadyRunning, sweep local orphan
            // adb-shell-scrcpy-server.jar children that survive a parent
            // scrcpy crash. They're cheap to kill, and if killing them makes
            // the next hasRunningScrcpyForSerial() return false then there
            // wasn't actually a real scrcpy here — proceed with normal launch.
            if (hasRunningScrcpyForSerial(serial)) {
                try {
                    // CRITICAL: this is a MID-SESSION sweep on a live multi-mirror
                    // fleet. The killer also reaps stray scrcpy.exe, so a bare
                    // sweep({}) would taskkill OTHER phones' live, app-managed
                    // mirror windows. Pass the app-owned scrcpy PIDs as an
                    // allowlist so the sweep can only ever reap TRUE orphans +
                    // adb children, never a sibling fleet phone's mirror.
                    const ownedPids = [...scrcpyProcesses.values()].map(p => p && p.pid).filter(Boolean)
                    require('../lib/scrcpy-orphan-killer').sweep({ excludePids: ownedPids })
                    // Invalidate the 2s cache so the next check actually re-queries.
                    scrcpyEnumCache.at = 0
                } catch (_) {}
                if (hasRunningScrcpyForSerial(serial)) {
                    return _ensureSidebarForRunning('scrcpy already running for this device')
                }
            }

            let scrcpyPath = getScrcpyPath()
            const platform = os.platform()

            if (!scrcpyPath) {
                const { dialog } = require('electron')
                const installDetail = platform === 'darwin'
                    ? 'On macOS, Install Now will run: brew install scrcpy'
                    : (platform === 'linux'
                        ? 'On Linux, install scrcpy using your package manager.'
                        : 'Would you like to download and install it automatically? (About 30MB)')
                const result = await dialog.showMessageBox(mainWindow, {
                    type: 'question',
                    buttons: ['Install Now', 'Cancel'],
                    defaultId: 0,
                    title: 'scrcpy Not Found',
                    message: 'Phone mirroring requires scrcpy which is not installed.',
                    detail: installDetail
                })

                if (result.response === 0) {
                    const installResult = await installScrcpyInternal()
                    if (!installResult.success) {
                        return { success: false, error: installResult.message }
                    }
                    scrcpyPath = getScrcpyPath()
                } else {
                    return { success: false, error: 'scrcpy installation cancelled' }
                }
            }

            if (!scrcpyPath) {
                return { success: false, error: 'scrcpy installation failed' }
            }

            // Mac-only: best-effort TCC Screen Recording pre-flight. The
            // sqlite3 read may fail silently under sandboxing — we treat a
            // null `granted` as inconclusive and STILL launch scrcpy. We
            // only block long enough to show the dialog once per session
            // when we're CONFIDENT the permission is missing.
            if (platform === 'darwin' && !macTccPromptShown) {
                try {
                    const tcc = checkMacScreenRecordingPermission()
                    if (tcc && tcc.granted === false) {
                        macTccPromptShown = true
                        const { dialog } = require('electron')
                        dialog.showMessageBox(mainWindow, {
                            type: 'warning',
                            buttons: ['Open Privacy Settings', 'Continue Anyway'],
                            defaultId: 0,
                            title: 'Screen Recording permission required',
                            message: 'Mac requires Screen Recording permission for phone mirroring.',
                            detail: 'Open System Settings → Privacy & Security → Screen Recording, toggle on ShadowPhone, then quit and relaunch the app.\n\nIf scrcpy still fails, check the per-device log at:\n' + (getScrcpyLogPathForSerial(serial) || '<userData>/logs/'),
                        }).then(r => {
                            if (r.response === 0) {
                                shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
                            }
                        }).catch(() => {})
                    }
                } catch (_) { /* best-effort, never block launch */ }
            }

            // Acquire the launch-in-flight latch HERE — just before the port
            // pick / layout / spawn critical section, AFTER the install dialog
            // and Mac-TCC prompt. The earlier install-cancel/fail/already-
            // running returns happen before this, so the latch is never held
            // across a modal (watchdog recovery can proceed) and is never left
            // dangling on those bail-outs. The finally{} below still clears it
            // (delete of an unacquired key is a no-op). Also clear the stale
            // "stop cancelled the retry" + fast-fail latches so this launch is
            // eligible for one transient auto-retry.
            scrcpyLaunchInFlight.add(serial)
            scrcpyRetryCanceled.delete(serial)
            scrcpyFastFailRetried.delete(serial)

            // Pick a unique port per mirrored device so multi-device mirroring can run simultaneously.
            const usedPorts = new Set(Array.from(scrcpyPortBySerial.entries())
                .filter(([key]) => key !== serial)
                .map(([, value]) => value))
            let port = scrcpyPortBySerial.get(serial)
            if (!port || usedPorts.has(port)) {
                port = 28000
                while (usedPorts.has(port) && port < 30000) {   // widen ceiling 29000 -> 30000
                    port += 1
                }
                if (usedPorts.has(port)) {                        // post-loop exhaustion guard
                    // Window fully taken — the old code silently stored 30000 (a
                    // colliding/out-of-window port) and handed it to scrcpy as
                    // --port, black-screening the mirror. Fail loud instead; the
                    // launch's finally{} releases scrcpyLaunchInFlight. Unreachable
                    // on a real fleet (2000-port window).
                    try { require('../lib/launcher-log').write('scrcpy:port-exhausted', { serial, tried: usedPorts.size }) } catch (_) {}
                    throw new Error('scrcpy port window exhausted (28000-30000) — too many simultaneous mirrors')
                }
            }
            scrcpyPortBySerial.set(serial, port)

            // Derive aspect ratio from device's actual display dimensions when
            // available (future-proof for non-9:20 phones). Fall back to 9/20
            // (1080×2400 Pixel 6) when displayInfo isn't populated on this device.
            const _snapDev = (_lastDeviceSnapshot || []).find(d => d.serial === serial || d.hwSerial === serial)
            const _di = _snapDev && _snapDev.displayInfo
            const PHONE_ASPECT = (_di && _di.width && _di.height && _di.height > _di.width)
                ? _di.width / _di.height
                : (_di && _di.width && _di.height && _di.width > _di.height)
                    ? _di.height / _di.width  // landscape device — portrait axis as numerator
                    : 9 / 20
            // Toolbar popup is disabled — no dock reservation needed for now.
            // (Was 56px when the floating toolbar was active.)
            const TOOLBAR_WIDTH = 0
            let windowX = 100
            let windowY = 50
            let windowWidth = 390
            let windowHeight = 844

            // Slot index for this device — drives the auto-tile grid. We use
            // the count of OTHER running mirrors, so the new mirror lands in
            // the next empty cell without overlapping existing windows.
            const existingMirrors = Array.from(scrcpyPortBySerial.keys()).filter(s => s !== serial)
            const slotIndex = existingMirrors.length
            const totalMirrors = slotIndex + 1

            if (mainWindow) {
                const { screen } = require('electron')
                const bounds = mainWindow.getBounds()
                const display = screen.getDisplayMatching(bounds)
                const workArea = display.workArea

                // Auto-layout: arrange mirrors as a single horizontal row
                // to the right of the main app. Each mirror keeps the 9:20
                // phone aspect ratio. If the row would overflow the work
                // area horizontally, every tile shrinks proportionally so
                // they all still fit side-by-side. Users can still drag/
                // resize individual mirrors after the auto-layout — scrcpy
                // doesn't lock window position once spawned.
                //
                // 2.17.15: applies to the SINGLE-mirror case too. Previously
                // the first phone landed at fixed (100, 50) which felt
                // random — Anyro screenshot showed mirrors scattered across
                // the screen. Now every launch lands in a predictable slot
                // right of the dashboard.
                if (totalMirrors >= 1) {
                    const GAP = 6
                    // 2.16.5: reserve space per phone for the docked toolbar
                    // (156 wide + 6 gap between phone and sidebar) so the
                    // sidebar lands ON SCREEN instead of being clipped or
                    // hidden behind the next tiled phone.
                    const SIDEBAR_RESERVE_PX = 156 + 6
                    // 2.18.11: ignore main-app right edge when computing strip
                    // origin. Previously, if the dashboard was near the right
                    // half of the screen, availW was tiny and the mirror got
                    // shrunk to the 160px minimum. Anyro: "phone mirrors
                    // spawn odd locations and tiny". Now the strip uses the
                    // FULL work area (starting 80px from the left), and
                    // overlap with the dashboard is fine — the user can drag
                    // either window if it matters.
                    const stripLeft = workArea.x + 80
                    const availW = (workArea.x + workArea.width) - stripLeft - 20
                    const availH = workArea.height - 20

                    // Step 1: ideal tile = full work-area height minus a small
                    // bottom-clearance budget (10 logical px). windowY already
                    // adds 10 px top margin, so total padding = 20 logical px
                    // = 40 physical px at 200% DPI — enough to clear the
                    // work-area edge without wasting screen space.
                    // scrcpy treats --window-height as logical/CSS px (SDL
                    // per-monitor-DPI-aware), so no further conversion needed.
                    let tileH = Math.max(180, availH - 10)
                    let tileW = Math.round(tileH * PHONE_ASPECT)

                    // Step 2: if N (tile + sidebar) + gaps exceed availW,
                    // shrink the phone tile uniformly so phone+sidebar pairs
                    // fit. Solve: N * (tileW + SIDEBAR_RESERVE_PX) + (N-1)*GAP <= availW
                    const slotW = tileW + SIDEBAR_RESERVE_PX
                    const totalNeeded = (totalMirrors * slotW) + ((totalMirrors - 1) * GAP)
                    if (totalNeeded > availW) {
                        const newSlotW = Math.max(160 + SIDEBAR_RESERVE_PX,
                            Math.floor((availW - (totalMirrors - 1) * GAP) / totalMirrors))
                        tileW = Math.max(160, newSlotW - SIDEBAR_RESERVE_PX)
                        tileH = Math.round(tileW / PHONE_ASPECT)
                    }

                    const slotPitch = tileW + SIDEBAR_RESERVE_PX + GAP
                    windowWidth = tileW
                    windowHeight = tileH
                    windowX = stripLeft + slotIndex * slotPitch
                    windowY = workArea.y + 10

                    // Layout equalizer: each already-running mirror sized
                    // itself for the layout that was current WHEN IT
                    // SPAWNED. With the row layout, mirror #1 (single-mirror
                    // size) is taller than every subsequent mirror. Resize
                    // each existing mirror to its new row slot so the entire
                    // row is uniform once the new one joins.
                    //
                    // scrcpy enforces aspect ratio internally, so Win32
                    // SetWindowPos can't shrink a running mirror — only a
                    // stop+respawn picks up the new --window-width and
                    // --window-height args. Brief flicker on existing
                    // mirrors when a new one joins.
                    for (let i = 0; i < existingMirrors.length; i++) {
                        const sib = existingMirrors[i]
                        if (!sib) continue
                        const sibX = stripLeft + i * slotPitch
                        const sibY = workArea.y + 10
                        const sibPort = scrcpyPortBySerial.get(sib)
                        const sibTitle = scrcpyTitleBySerial.get(sib) || sib
                        const sibProc = scrcpyProcesses.get(sib)
                        if (!sibProc || !sibPort) continue
                        try {
                            // FLICKER-SKIP: only skip the kill/respawn when the
                            // sibling's last-spawn tile is IDENTICAL — same size
                            // AND same slot position. Then respawning produces only
                            // a black-window flash with zero net visual change.
                            // We must check x/y too: a respawn is the only thing
                            // that repositions a running scrcpy window here, so
                            // skipping a sibling whose SLOT MOVED (strip re-centred)
                            // would leave it mis-aligned in the grid. Position
                            // changed -> fall through to respawn (which moves it).
                            const sibLastArgs = scrcpyLastSpawnArgs.get(sib)
                            if (sibLastArgs && sibLastArgs.w === tileW && sibLastArgs.h === tileH
                                && sibLastArgs.x === sibX && sibLastArgs.y === sibY) {
                                continue
                            }
                            scrcpyRespawning.add(sib)
                            // eslint-disable-next-line no-await-in-loop
                            await killScrcpyAndWait(sibProc)
                            const sibDevices = getConnectedDevicesFn ? await getConnectedDevicesFn() : []
                            // Port-rotation tolerant lookup: a tailnet-only-keyed
                            // sibling whose boot port rotated no longer matches its
                            // OLD ip:port by raw equality (so the old find missed it,
                            // sibTarget went null, and the respawn ran -s <dead old
                            // ip:port>). resolveLiveSerial keeps the exact-serial +
                            // hwSerial checks first (no regression for USB phones) and
                            // ADDS the IP-match fallback so the respawn targets the
                            // CURRENT ip:port.
                            let sibDev = sibDevices.find(d => d.serial === sib || d.hwSerial === sib)
                            if (!sibDev) {
                                try {
                                    const { resolveLiveSerial } = require('../lib/device-identity')
                                    const live = resolveLiveSerial(sib, sibDevices)
                                    if (live) sibDev = sibDevices.find(d => d.serial === live)
                                } catch (_) { /* fall back to raw find result */ }
                            }
                            // M4 flap-fix parity: keep a USB-live sibling on the stable
                            // USB cable across this cosmetic re-tile instead of flipping
                            // it onto the flakier tailnet relay. Only prefer tailnet when
                            // the sibling's USB serial is NOT live (e.g. a VA-launched
                            // tailnet-only phone). usbLive matched by .serial only, exactly
                            // like the real launch path's M4 guard.
                            const sibUsbLive = sibDevices.some(d => d.serial === sib)
                            const sibTarget = (sibDev && sibDev.tailnetIp && !sibUsbLive)
                                ? `${sibDev.tailnetIp}:${sibDev.tailnetPort || 5555}`
                                : null
                            spawnScrcpyAtSlot(scrcpyPath, sib, sibPort, sibX, sibY, tileW, tileH, sibTitle, sibTarget)
                        } catch (e) {
                            console.warn(`[Scrcpy] respawn failed for ${sib}:`, e?.message || e)
                        } finally {
                            scrcpyRespawning.delete(sib)
                        }
                    }
                } else {
                    // Single-mirror: original right-of-app placement, but make
                    // room for the toolbar dock so its 56px doesn't get cut.
                    windowHeight = Math.min(844, workArea.height - 80)
                    windowWidth = Math.round(windowHeight * PHONE_ASPECT)
                    windowY = bounds.y
                    const rightX = bounds.x + bounds.width + 10
                    const leftX = bounds.x - windowWidth - TOOLBAR_WIDTH - 10
                    if (rightX + windowWidth + TOOLBAR_WIDTH <= workArea.x + workArea.width) {
                        windowX = rightX
                    } else if (leftX >= workArea.x) {
                        windowX = leftX
                    } else {
                        windowX = Math.round(workArea.x + (workArea.width - windowWidth - TOOLBAR_WIDTH) / 2)
                    }
                    windowY = Math.max(workArea.y, Math.min(windowY, workArea.y + workArea.height - windowHeight))
                }
            }

            // 2.16.6: SAFETY CLAMP — if the calculated coords land outside
            // any visible display (multi-monitor edge case, stale mainWindow
            // bounds, etc.), fall back to the primary display's top-left.
            // Without this scrcpy spawns at coords like (-3000, 0) and the
            // user can't see the window even though the process is alive.
            try {
                const { screen: safeScreen } = require('electron')
                const targetCenter = { x: Math.round(windowX + windowWidth / 2), y: Math.round(windowY + windowHeight / 2) }
                const matchedDisplay = safeScreen.getDisplayMatching({
                    x: windowX, y: windowY, width: windowWidth, height: windowHeight,
                })
                const primary = safeScreen.getPrimaryDisplay()
                const nearestDisplay = safeScreen.getDisplayNearestPoint(targetCenter)
                // If the target rect doesn't intersect ANY display (matchedDisplay
                // returns primary as fallback when nothing intersects), force-place
                // it on the primary display at a known-visible spot.
                const visibleOnSome = safeScreen.getAllDisplays().some(d => {
                    const wa = d.workArea
                    return windowX + windowWidth > wa.x
                        && windowX < wa.x + wa.width
                        && windowY + windowHeight > wa.y
                        && windowY < wa.y + wa.height
                })
                if (!visibleOnSome) {
                    const wa = primary.workArea
                    console.warn(`[Scrcpy] target (${windowX},${windowY},${windowWidth}x${windowHeight}) off-screen — forcing onto primary display work area`)
                    windowX = wa.x + 80
                    windowY = wa.y + 60
                    if (windowWidth > wa.width - 200) windowWidth = wa.width - 200
                    if (windowHeight > wa.height - 100) windowHeight = wa.height - 100
                }
            } catch (e) { console.warn('[Scrcpy] safety clamp failed:', e?.message || e) }
            // Where the toolbar popup will dock (right edge of mirror window)
            const toolbarX = windowX + windowWidth + 4
            const toolbarY = windowY

            // Resolve a friendly window title from the same nickname file
            // device-handlers.js owns. Falls back to the serial so a window
            // always identifies which phone it's mirroring even if no
            // nickname is set. Read on every launch — picks up renames
            // without an app restart.
            let windowTitle = serial
            try {
                if (app) {
                    const nicknamesPath = require('path').join(app.getPath('userData'), 'device-nicknames.json')
                    const fs = require('fs')
                    if (fs.existsSync(nicknamesPath)) {
                        const nicks = JSON.parse(await fs.promises.readFile(nicknamesPath, 'utf8') || '{}')
                        const nick = nicks && typeof nicks === 'object' ? String(nicks[serial] || '').trim() : ''
                        if (nick) windowTitle = `${nick} · ${serial.slice(0, 8)}`
                    }
                }
            } catch (e) {
                // Nickname lookup is best-effort; never block scrcpy on it.
                console.warn('[Scrcpy] nickname lookup failed:', e?.message || e)
            }

            // 2.16.19: for tailnet-launched phones whose serial is a raw IP
            // (no device-nicknames entry), fall back to the Tailscale peer
            // hostname (e.g. "Pixelated3"). The IP is meaningless to the
            // operator — the custom hostname is what they recognize.
            if (windowTitle === serial && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) {
                try {
                    const ip = serial.split(':')[0]
                    const { getTailscaleStatus } = require('../lib/tailscale-status')
                    const ts = await getTailscaleStatus()
                    if (ts?.transportReady) {
                        const peer = (ts.peers || []).find(p => p.ip === ip)
                        if (peer?.name) {
                            windowTitle = `${peer.name} · ${ip}`
                            console.log(`[Scrcpy] resolved tailnet title: ${windowTitle}`)
                        }
                    }
                } catch (e) {
                    console.warn('[Scrcpy] tailnet title lookup failed:', e?.message || e)
                }
            }

            // 2.16.0: prefer the phone's tailnet address if it has one.
            // getConnectedDevices() merges the USB+TCP entries and annotates
            // the canonical USB record with tailnetIp when both transports
            // are connected. When present, route scrcpy over `<ip>:5555`
            // instead of the USB UDID — fixes the auto-mirror so VAs and
            // owners both see the same tailnet-backed window.
            // 2.16.4: serial coming in can be either:
            //   - USB UDID (e.g. "1A121FDF60082H") — owner's auto-mirror flow
            //   - TCP serial (e.g. "100.116.5.79:5555") — Fleet panel Launch from a VA
            //   - hostname (e.g. "pixel-6") — older tray path
            // For TCP serials, the serial IS the adbTarget. For UDIDs/hostnames,
            // resolve via getConnectedDevices() merged dedupe.
            let adbTarget = null
            const tcpSerialMatch = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(serial)
            if (tcpSerialMatch) {
                adbTarget = serial
                console.log(`[Scrcpy] Routing ${serial} through tailnet (TCP serial passed in)`)
            } else {
                try {
                    const devices = getConnectedDevicesFn ? await getConnectedDevicesFn() : []
                    const dev = devices.find(d => d.serial === serial || d.hwSerial === serial)
                    // M4 flap fix: a non-TCP serial that is LIVE in the device list
                    // means the phone is USB-connected to THIS machine — mirror over
                    // the stable USB transport, NOT the flakier tailnet relay (which
                    // dropped scrcpy with "Device disconnected" and triggered watchdog
                    // relaunch churn). Only fall back to tailnet when the USB serial
                    // isn't live. VAs pass TCP serials (handled above) so their tailnet
                    // routing is unchanged.
                    const usbLive = devices.some(d => d.serial === serial)
                    if (dev && dev.tailnetIp && !usbLive) {
                        adbTarget = `${dev.tailnetIp}:${dev.tailnetPort || 5555}`
                        console.log(`[Scrcpy] Routing ${serial} through tailnet ${adbTarget} (USB serial not live)`)
                    } else {
                        console.log(`[Scrcpy] Routing ${serial} through USB (stable transport)`)
                    }
                } catch (_) { /* best-effort; USB fallback below */ }
            }

            // Pre-spawn reachability probe on the EXACT transport scrcpy will
            // attach to. An unauthorized / offline / missing phone otherwise
            // yields a black scrcpy window (or a cryptic fast-fail seconds
            // later). Surfacing it here gives the operator an actionable
            // message and avoids leaving a dead window + dangling toolbar.
            // Inconclusive probes (adb hiccup → null) NEVER block the launch.
            //
            // Happy-path shortcut: the device snapshot was just refreshed
            // (line ~1968 into _lastDeviceSnapshot). If the requested target is
            // already present there with status==='device', it's reachable —
            // skip the adb round-trip entirely. This collapses Mirror-All's
            // accumulated per-launch probe latency to ~0 for healthy phones.
            // We only fall through to the (now-async) probe when the target is
            // absent or non-'device' in the snapshot.
            const probeTarget = adbTarget || serial
            let snapshotSaysReady = false
            try {
                if (_lastDeviceSnapshot && _lastDeviceSnapshot.length) {
                    const { sameDevice } = require('../lib/device-identity')
                    snapshotSaysReady = _lastDeviceSnapshot.some(d =>
                        d && d.status === 'device'
                        && (d.serial === probeTarget || sameDevice(d.serial, probeTarget, _lastDeviceSnapshot)))
                }
            } catch (_) { snapshotSaysReady = false }
            try {
                const probeState = snapshotSaysReady ? 'device' : await probeAdbStateForTarget(probeTarget)
                if (probeState && probeState !== 'device') {
                    const human = probeState === 'unauthorized'
                        ? 'Phone is connected but UNAUTHORIZED — unlock it and accept the "Allow USB debugging" prompt, then Launch again.'
                        : probeState === 'offline'
                            ? 'Phone is OFFLINE to adb (transport stalled) — re-plug USB or toggle the Tailscale connection, then Launch again.'
                            : 'Phone is not reachable over adb right now — check the cable / network, then Launch again.'
                    try { require('../lib/launcher-log').write('scrcpy:precheck-blocked', { serial, adbTarget: adbTarget || serial, state: probeState }) } catch (_) {}
                    try {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('scrcpy-fast-fail', { serial, code: probeState, lifetimeMs: 0, stderrTail: human })
                        }
                    } catch (_) {}
                    // Drop the port reservation we just claimed so the next
                    // attempt re-derives cleanly.
                    scrcpyPortBySerial.delete(serial)
                    return { success: false, error: human, deviceState: probeState }
                }
            } catch (_) { /* probe is best-effort; never block on its own failure */ }

            // Spawn the new mirror via the shared helper — same handler
            // wiring used by the layout-equalizer respawn path above so
            // teardown semantics stay consistent.
            const spawnedProc = spawnScrcpyAtSlot(scrcpyPath, serial, port, windowX, windowY, windowWidth, windowHeight, windowTitle, adbTarget)
            const spawnedPid = spawnedProc?.pid || null

            // 2.16.1: docked floating toolbar with all per-phone actions.
            // 2.18.5: log success/failure to launcher.log so the intermittent
            // "sidebar didn't come with mirror" issue can be diagnosed from
            // a user's log instead of silent console.warn. Plus a 2s safety
            // retry — if the toolbar is missing 2s after spawn, force-create.
            const mt = require('../lib/mirror-toolbar')
            const sidebarOpts = {
                serial,
                x: windowX + windowWidth + 6,
                y: windowY,
                height: windowHeight,
                mirrorTitle: windowTitle,
                scrcpyPid: spawnedPid,
                transport: adbTarget ? 'tailscale' : 'usb',
                tailnetIp: adbTarget ? adbTarget.split(':')[0] : null,
            }
            try {
                mt.createToolbar(sidebarOpts)
                try { require('../lib/launcher-log').write('toolbar:created', { serial, scrcpyPid: spawnedPid }) } catch (_) {}
            } catch (e) {
                console.warn('[Scrcpy] toolbar create failed:', e?.message || e)
                try { require('../lib/launcher-log').write('toolbar:create-error', { serial, error: e?.message || String(e), stack: (e?.stack || '').split('\n').slice(0, 3).join(' | ') }) } catch (_) {}
            }
            // 2.18.5: safety retry — 2s later, if hasToolbar(serial) is false,
            // try once more. Catches race conditions where the first create
            // throws AFTER setting some partial state (Anyro hit "sidebar
            // wont come with it sometimes, have to close and launch again").
            setTimeout(() => {
                try {
                    if (typeof mt.hasToolbar === 'function' && !mt.hasToolbar(serial)) {
                        try { require('../lib/launcher-log').write('toolbar:safety-recreate', { serial, reason: 'no toolbar 2s after spawn' }) } catch (_) {}
                        mt.createToolbar(sidebarOpts)
                    }
                } catch (e) {
                    try { require('../lib/launcher-log').write('toolbar:safety-recreate-error', { serial, error: e?.message || String(e) }) } catch (_) {}
                }
            }, 2000)

            // 2.19.13: register intent with the watchdog so an auto-relaunch
            // fires if the phone drops off ADB later (Tailscale relay flip,
            // USB jiggle, WiFi sleep). Cleared on explicit Close Window.
            // H3/M1: pass the adbTarget scrcpy actually streams on so the
            // watchdog keys ONE intent per physical phone (collapsing the USB
            // udid + tailnet ip:port) and keepalives the live transport socket.
            // opts.watchdog === false → a manual/cockpit mirror the user opened
            // by hand: DON'T register an intent, so closing its window stays
            // closed instead of being auto-relaunched (Case A). Automation and
            // tray/fleet launches keep the default (managed) behavior.
            if (opts.watchdog !== false) {
                try {
                    require('../lib/device-watchdog').markIntent(serial, adbTarget)
                } catch (_) {}
            }

            return { success: true, message: 'scrcpy launched' }
        } finally {
            scrcpyLaunchInFlight.delete(serial)
        }
    }

    // Expose for external callers (tray, future renderer routes) so they
    // share the docked-toolbar + tailnet-routing path instead of spawning
    // their own bare scrcpy.
    _launchScrcpyForSerial = launchScrcpyForSerial

    // 2.17.9: smart auto-fire vs user-click detection. The dashboard's
    // Mirror button uses this IPC too — we can't just no-op it. Instead:
    //   - First 12s after app boot: block (covers all auto-fires on initial
    //     page load + reloads).
    //   - After that: allow user-initiated Mirror clicks through.
    // We log every call so we can see whether the auto-fire pattern persists.
    const _appBootedAt = Date.now()
    const AUTO_FIRE_BLOCK_MS = 12_000
    ipcMain.handle('launch-scrcpy', async (event, serial, managed = true) => {
        const elapsed = Date.now() - _appBootedAt
        const isLikelyAutoFire = elapsed < AUTO_FIRE_BLOCK_MS
        try {
            require('../lib/launcher-log').write('launch-scrcpy:invoked', {
                serial,
                elapsedMs: elapsed,
                blocked: isLikelyAutoFire,
            })
        } catch (_) {}
        if (isLikelyAutoFire) {
            return {
                success: false,
                blocked: true,
                error: 'auto-launch suppressed during app boot — try again in a few seconds',
            }
        }
        try {
            return await launchScrcpyForSerial(serial, { watchdog: managed !== false })
        } catch (error) {
            console.error('[Scrcpy] Launch error:', error)
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('launch-scrcpy-all', async () => {
        try {
            const serials = await getConnectedDeviceSerials()
            if (serials.length === 0) {
                return { success: false, error: 'No connected devices found', results: [] }
            }

            const results = []
            for (const serial of serials) {
                // Launch sequentially to avoid window spawn race conditions.
                // eslint-disable-next-line no-await-in-loop
                const result = await launchScrcpyForSerial(serial)
                results.push({ serial, ...result })
            }

            const successCount = results.filter(r => r.success).length
            return {
                success: successCount > 0,
                total: serials.length,
                launched: successCount,
                results,
            }
        } catch (error) {
            return { success: false, error: error.message, results: [] }
        }
    })

    ipcMain.handle('stop-scrcpy', async (event, inputSerial) => {
        try {
            const serial = normalizeSerial(inputSerial)
            if (!serial) {
                return { success: false, error: 'Missing device serial' }
            }
            // 2.19.13: user-initiated close → drop the watchdog's intent so
            // it doesn't fight the user by auto-relaunching after this. Also
            // clear the tailnet-keyed intent (the adbTarget twin) so an explicit
            // Stop is deterministic regardless of whether the watchdog's device
            // snapshot is warm enough to reconcile the two serial forms itself.
            try {
                const wd = require('../lib/device-watchdog')
                wd.clearIntent(serial)
                const t = scrcpyAdbTargetBySerial.get(serial)
                if (t && t !== serial) wd.clearIntent(t)
            } catch (_) {}
            // Cancel any pending transient fast-fail retry for this serial —
            // the user is explicitly stopping, so a queued respawn must not
            // re-open the window a second later.
            scrcpyRetryCanceled.add(serial)
            // Transport-switch twin: after a USB<->tailnet flip the live mirror
            // is keyed under the OTHER serial form, so the exact-key check below
            // misses and the window orphans. When there's no exact entry, resolve
            // the live twin the same way the transport-switch close + hasRunning
            // do (sameDevice against the cached snapshot) and tear THAT down.
            // Guarded so a snapshot/identity error falls back to current behavior.
            if (!scrcpyProcesses.has(serial)) {
                try {
                    const { sameDevice } = require('../lib/device-identity')
                    let twinKey = null
                    for (const [key, proc] of [...scrcpyProcesses.entries()]) {
                        if (key === serial) continue
                        if (!isScrcpyProcessAlive(proc)) continue
                        if (sameDevice(key, serial, _lastDeviceSnapshot)) { twinKey = key; break }
                    }
                    if (twinKey) {
                        scrcpyRetryCanceled.add(twinKey)
                        // The live mirror is keyed under the twin — clear ITS
                        // intent (and the twin's tailnet adbTarget) before the
                        // maps below are wiped, so Stop deterministically kills
                        // the watchdog intent for the form that was actually
                        // running.
                        try {
                            const wd = require('../lib/device-watchdog')
                            wd.clearIntent(twinKey)
                            const tt = scrcpyAdbTargetBySerial.get(twinKey)
                            if (tt && tt !== twinKey) wd.clearIntent(tt)
                        } catch (_) {}
                        await killScrcpyTree(scrcpyProcesses.get(twinKey))
                        scrcpyProcesses.delete(twinKey)
                        scrcpyPortBySerial.delete(twinKey)
                        scrcpyTitleBySerial.delete(twinKey)
                        scrcpyAdbTargetBySerial.delete(twinKey)
                        scrcpyLastSpawnArgs.delete(twinKey)
                        scrcpyFastFailRetried.delete(twinKey)
                        try { require('../lib/mirror-toolbar').closeToolbar(twinKey, { force: true }) } catch (_) {}
                        // Tear down the (dead) toolbar under the requested serial too.
                        try { require('../lib/mirror-toolbar').closeToolbar(serial, { force: true }) } catch (_) {}
                        try {
                            const ownedPids = [...scrcpyProcesses.values()].map(p => p && p.pid).filter(Boolean)
                            require('../lib/scrcpy-orphan-killer').sweep({ logger: () => {}, excludePids: ownedPids })
                        } catch (_) {}
                        try { require('../lib/launcher-log').write('scrcpy:stop-twin', { requested: serial, killed: twinKey }) } catch (_) {}
                        return { success: true, message: 'scrcpy stopped' }
                    }
                } catch (_) { /* fall through to exact-match + stale-cleanup below */ }
            }
            if (scrcpyProcesses.has(serial)) {
                // Tree-kill so the adb scrcpy-server child is reaped, not left
                // orphaned holding a tcp:5037 forward (Windows: bare .kill()
                // signals only scrcpy.exe).
                await killScrcpyTree(scrcpyProcesses.get(serial))
                scrcpyProcesses.delete(serial)
                scrcpyPortBySerial.delete(serial)
                scrcpyTitleBySerial.delete(serial)
                scrcpyAdbTargetBySerial.delete(serial)
                scrcpyLastSpawnArgs.delete(serial)
                scrcpyFastFailRetried.delete(serial)
                try { require('../lib/mirror-toolbar').closeToolbar(serial, { force: true }) } catch (_) {}
                // Belt-and-suspenders: reap any adb child the tree-kill missed
                // (e.g. pid already reaped). Best-effort, never blocks the stop.
                // excludePids = the OTHER phones still mirroring (this serial's
                // entry was just deleted above) so the sweep can never take down
                // a sibling fleet phone's live, app-managed scrcpy.exe.
                try {
                    const ownedPids = [...scrcpyProcesses.values()].map(p => p && p.pid).filter(Boolean)
                    require('../lib/scrcpy-orphan-killer').sweep({ logger: () => {}, excludePids: ownedPids })
                } catch (_) {}
                return { success: true, message: 'scrcpy stopped' }
            }
            // No live proc tracked — still clear any stale per-serial
            // bookkeeping so a re-Launch starts from a clean slate instead of
            // reusing a dead port/title/args entry.
            scrcpyPortBySerial.delete(serial)
            scrcpyTitleBySerial.delete(serial)
            scrcpyAdbTargetBySerial.delete(serial)
            scrcpyLastSpawnArgs.delete(serial)
            scrcpyFastFailRetried.delete(serial)
            try { require('../lib/mirror-toolbar').closeToolbar(serial, { force: true }) } catch (_) {}
            return { success: true, message: 'No scrcpy running for this device' }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('stop-scrcpy-all', async () => {
        try {
            let stopped = 0
            for (const [serial, proc] of scrcpyProcesses.entries()) {
                // Cancel any queued fast-fail retry so it can't re-open a
                // mirror right after the user stopped everything.
                scrcpyRetryCanceled.add(serial)
                try {
                    // Tree-kill so each scrcpy.exe AND its adb scrcpy-server
                    // child go down (bare .kill() leaves the adb child orphaned
                    // on Windows).
                    // eslint-disable-next-line no-await-in-loop
                    await killScrcpyTree(proc)
                    stopped += 1
                } catch (error) {
                    console.error(`[Scrcpy] Failed to stop ${serial}:`, error)
                }
                try { require('../lib/mirror-toolbar').closeToolbar(serial, { force: true }) } catch (_) {}
            }
            scrcpyProcesses.clear()
            scrcpyPortBySerial.clear()
            scrcpyTitleBySerial.clear()
            scrcpyAdbTargetBySerial.clear()
            scrcpyLastSpawnArgs.clear()
            scrcpyFastFailRetried.clear()
            // Reap any adb child the tree-kills missed. Best-effort.
            try { require('../lib/scrcpy-orphan-killer').sweep({ logger: () => {} }) } catch (_) {}
            return { success: true, stopped }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    // Native notifications
    ipcMain.handle('show-native-notification', async (event, options) => {
        try {
            const { title, body, type, navigateTo } = options || {}
            const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico')

            const notification = new Notification({
                title: title || 'ShadowPhone',
                body: body || '',
                icon: fs.existsSync(iconPath) ? iconPath : undefined,
                silent: false,
                urgency: type === 'error' ? 'critical' : 'normal'
            })

            notification.on('click', () => {
                if (mainWindow) {
                    if (mainWindow.isMinimized()) mainWindow.restore()
                    mainWindow.focus()
                    mainWindow.webContents.send('native-notification-click', {
                        title: title || 'ShadowPhone',
                        body: body || '',
                        type: type || 'info',
                        navigateTo: navigateTo || null,
                        clickedAt: Date.now()
                    })
                }
            })

            notification.show()
            return { success: true }
        } catch (error) {
            console.error('[Notification] Failed to show:', error)
            return { success: false, error: error.message }
        }
    })
}

module.exports = {
    initSystemHandlers,
    // Exposed so the portal mirror server can resolve scrcpy the same way
    // the local-mirror flow does (Homebrew, Scoop, Program Files, etc.).
    getScrcpyPath,
    // 2.16.1: shared launch path (toolbar + tailnet routing + bookkeeping).
    launchScrcpyForSerial: launchScrcpyForSerialExternal,
    // 2.19.13: device-watchdog needs these to detect "scrcpy died but
    // user still wants the mirror" and decide whether to relaunch.
    hasRunningScrcpyForSerial,
    // 2.16.16: profile-handlers uses these to keep the toolbar alive across
    // the airplane-mode gap of a Switch Profile and to position the
    // "switching" curtain over the dying scrcpy window.
    markRespawning: (serial) => { if (serial) scrcpyRespawning.add(serial) },
    unmarkRespawning: (serial) => { if (serial) scrcpyRespawning.delete(serial) },
    // Device-identity-aware "is a respawn in flight for this phone?" predicate.
    // The layout equalizer / profile-switch key scrcpyRespawning by the scrcpy
    // map key `sib` (USB udid OR tailnet ip:port), while the watchdog runs on
    // the canonical intent/adbTarget key — for a dual-transport phone an exact
    // .has() would miss. So we also match any in-flight respawn key that
    // sameDevice()-resolves to the requested serial. Lets the watchdog suppress
    // a Case-A relaunch while an equalizer respawn owns the maps, killing the
    // double-spawned-mirror race. Falls back to exact-match when the snapshot is
    // empty, so it never misroutes.
    isRespawning: (serial) => {
        if (!serial) return false
        if (scrcpyRespawning.has(serial)) return true
        try {
            const { sameDevice } = require('../lib/device-identity')
            if (_lastDeviceSnapshot && _lastDeviceSnapshot.length) {
                for (const k of scrcpyRespawning) {
                    if (sameDevice(k, serial, _lastDeviceSnapshot)) return true
                }
            }
        } catch (_) {}
        return false
    },
    // "Is a launch in flight for this phone?" — same sameDevice() identity
    // fallback as isRespawning, so it works across the USB-udid / ip:port key
    // split. Lets the watchdog stand down instead of racing a launch it can't
    // see (scrcpyLaunchInFlight only covers the spawn critical section).
    isLaunching: (serial) => {
        if (!serial) return false
        if (scrcpyLaunchPromises.has(serial) || scrcpyLaunchInFlight.has(serial)) return true
        try {
            const { sameDevice } = require('../lib/device-identity')
            if (_lastDeviceSnapshot && _lastDeviceSnapshot.length) {
                for (const k of [...scrcpyLaunchPromises.keys(), ...scrcpyLaunchInFlight]) {
                    if (sameDevice(k, serial, _lastDeviceSnapshot)) return true
                }
            }
        } catch (_) {}
        return false
    },
    lastCleanCloseAt: (serial) => scrcpyLastCleanCloseAt.get(serial) || 0,
    getScrcpyTitleForSerial: (serial) => scrcpyTitleBySerial.get(serial) || null,
    getScrcpyPidForSerial: (serial) => {
        const proc = scrcpyProcesses.get(serial)
        return proc?.pid || null
    },
    // Called from main.js before-quit / window-all-closed so app exit doesn't
    // leave orphan scrcpy + adb-child mirror windows alive on the phone farm.
    killAllScrcpy,
    // FIX: allows main.js to inject a fresh device list after a transport-pref
    // toggle so hasRunningScrcpyForSerial / sameDevice() can collapse the new
    // serial alias and relaunchMirror is actually called.
    setLastDeviceSnapshot: (devices) => { if (Array.isArray(devices)) _lastDeviceSnapshot = devices },
}
