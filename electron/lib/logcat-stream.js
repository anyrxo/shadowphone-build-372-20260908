/**
 * Live logcat streaming (Feature 2). Spawns `adb -s <serial> logcat`, batches
 * stdout lines every ~100ms (avoids one-IPC-per-line at logcat's volume), and
 * tree-kills the process on stop — mirrors the scrcpy bookkeeping pattern in
 * handlers/system-handlers.js (Map<serial, state>, win32 `taskkill /F /T /PID`
 * idiom) without importing anything from that module (isolated file — system-
 * handlers.js doesn't export its killScrcpyTree helper, so this is a local
 * clone of the same idiom, not a shared dependency).
 *
 * One stream per serial. Starting a serial that's already streaming stops the
 * old process first (used for level changes — logcat has no live filter
 * reconfig, so a level change means "spawn a new adb logcat with a new *:LEVEL").
 */
'use strict'

const { spawn } = require('child_process')
const execFileP = require('util').promisify(require('child_process').execFile)

// adb logcat's own level letters: Verbose, Debug, Info, Warn, Error, Fatal, Silent.
const VALID_LEVELS = ['V', 'D', 'I', 'W', 'E', 'F', 'S']
const MAX_BUFFER_LINES = 2000
const FLUSH_INTERVAL_MS = 100

// serial -> { proc, remainder, buffer:[], pending:[], flushTimer, onBatch, onError, onClose }
const streams = new Map()

function normalizeLevel(level) {
    const l = String(level || 'V').toUpperCase()
    return VALID_LEVELS.includes(l) ? l : 'V'
}

// Win32: `proc.kill()` (SIGTERM) only signals adb.exe itself — on Windows this
// does not reliably tear down the process the way `taskkill /T` does. Same
// idiom as killScrcpyTree in handlers/system-handlers.js.
async function killLogcatTree(proc) {
    if (!proc || !proc.pid) return
    if (process.platform === 'win32') {
        try {
            await execFileP('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
                windowsHide: true,
                timeout: 4000,
            })
        } catch (_) { /* already gone / hung taskkill must not block the handler */ }
    } else {
        try { proc.kill() } catch (_) { /* ignore */ }
    }
}

function flush(serial) {
    const st = streams.get(serial)
    if (!st || !st.pending.length) return
    const lines = st.pending.splice(0, st.pending.length)
    try { st.onBatch && st.onBatch(lines) } catch (_) { /* best effort */ }
}

function pushLine(serial, line) {
    const st = streams.get(serial)
    if (!st) return
    st.buffer.push(line)
    if (st.buffer.length > MAX_BUFFER_LINES) st.buffer.shift()
    st.pending.push(line)
}

// Tear down `state` for `serial` — but ONLY if it's still the current stream.
// A restart (level change) replaces the map entry while the old process is
// still being killed; when that old process's late `close` fires, its cleanup
// must NOT delete the NEW stream (which would kill its flush timer and orphan
// the live child). Identity check on `state` prevents that race.
function cleanup(serial, state) {
    const st = streams.get(serial)
    if (!st) return
    if (state && st !== state) return
    try { clearInterval(st.flushTimer) } catch (_) { /* ignore */ }
    streams.delete(serial)
}

/**
 * Start streaming `adb -s <serial> logcat -v time *:<level>`. Restarts
 * cleanly if this serial is already streaming (level change / re-Start).
 *
 * opts: { adbPath, level, onBatch(lines), onError(err), onClose(code) }
 * Returns { ok, level, error }.
 */
function start(serial, opts = {}) {
    const { adbPath, level, onBatch, onError, onClose } = opts
    if (!serial || typeof serial !== 'string') return { ok: false, error: 'serial is required' }
    if (!adbPath) return { ok: false, error: 'adbPath is required' }

    if (streams.has(serial)) {
        // Fire-and-forget stop of the old process — start() itself stays sync
        // so callers don't need to await a teardown before the new one spawns.
        stop(serial).catch(() => {})
    }

    const lvl = normalizeLevel(level)
    const args = ['-s', serial, 'logcat', '-v', 'time', '*:' + lvl]

    let proc
    try {
        proc = spawn(adbPath, args, { windowsHide: true })
    } catch (err) {
        try { onError && onError(err) } catch (_) { /* ignore */ }
        return { ok: false, error: err?.message || String(err) }
    }

    const state = {
        proc,
        remainder: '',
        buffer: [],
        pending: [],
        flushTimer: null,
        onBatch, onError, onClose,
    }
    streams.set(serial, state)
    state.flushTimer = setInterval(() => flush(serial), FLUSH_INTERVAL_MS)

    proc.stdout?.on('data', (data) => {
        const text = state.remainder + data.toString('utf8')
        const parts = text.split(/\r?\n/)
        state.remainder = parts.pop() || ''
        for (const line of parts) {
            if (line.length) pushLine(serial, line)
        }
    })
    proc.stderr?.on('data', (data) => {
        for (const line of String(data).split(/\r?\n/)) {
            if (line.trim()) pushLine(serial, '[stderr] ' + line)
        }
    })
    proc.on('error', (err) => {
        try { state.onError && state.onError(err) } catch (_) { /* ignore */ }
        cleanup(serial, state)
    })
    proc.on('close', (code) => {
        // Only flush trailing data if THIS state is still the live stream — a
        // restart may have already replaced it, and flushing would push this
        // (old) process's remainder into the new stream's buffer.
        if (streams.get(serial) === state) {
            if (state.remainder) { pushLine(serial, state.remainder); state.remainder = '' }
            flush(serial)
        }
        try { state.onClose && state.onClose(code) } catch (_) { /* ignore */ }
        cleanup(serial, state)
    })

    return { ok: true, level: lvl }
}

/**
 * Stop streaming for `serial`. Idempotent — a no-op (still ok:true) if
 * nothing is running.
 */
async function stop(serial) {
    const st = streams.get(serial)
    if (!st) return { ok: true, wasRunning: false }
    try { clearInterval(st.flushTimer) } catch (_) { /* ignore */ }
    streams.delete(serial)
    await killLogcatTree(st.proc)
    return { ok: true, wasRunning: true }
}

/** Stop every running stream (app quit sweep). Returns the count stopped. */
async function stopAll() {
    const serials = Array.from(streams.keys())
    for (const serial of serials) {
        try { await stop(serial) } catch (_) { /* best effort — quit must not hang */ }
    }
    return serials.length
}

/** Empty the ring buffer for `serial` without touching the running process. */
function clear(serial) {
    const st = streams.get(serial)
    if (!st) return false
    st.buffer.length = 0
    st.pending.length = 0
    return true
}

function isRunning(serial) {
    return streams.has(serial)
}

module.exports = { start, stop, stopAll, clear, isRunning }
