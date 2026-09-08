/**
 * Live Logcat IPC Handlers (Feature 2)
 * Streams `adb -s <serial> logcat` to the REQUESTING window only (the
 * mirror-toolbar LOGCAT tab) — not a broadcast like mirror-toolbar.js's
 * broadcastLiveLog. Logcat is high-volume; fanning it to every open toolbar
 * would be wasted IPC + noise in panes that aren't even showing this phone.
 *
 * Isolated from handlers/system-handlers.js and handlers/device-handlers.js —
 * does not import or mutate their state. Only reads an optionally-injected
 * getConnectedDevices() to resolve a stable hwSerial to whatever adb transport
 * serial is live right now (mirrors resolveAdbTargetLive's intent in
 * system-handlers.js, which isn't exported, so this is a local equivalent).
 */
const { ipcMain } = require('electron')
const logcatStream = require('../lib/logcat-stream')

let adbPathGetter = () => null
let devicesGetter = null // optional: () => Promise<Array<{serial, hwSerial}>>

// requested serial/hwSerial -> adb target actually spawned for it. Keeps
// stop()/clear() targeting the SAME live transport start() resolved to, even
// if the phone's operational serial changes (USB<->WiFi) while streaming.
const activeTargetBySerial = new Map()

function initLogcatHandlers(opts = {}) {
    if (typeof opts.getAdbPath === 'function') adbPathGetter = opts.getAdbPath
    if (typeof opts.getConnectedDevices === 'function') devicesGetter = opts.getConnectedDevices

    registerLogcatHandlers()
}

async function resolveTarget(serialOrHwSerial) {
    if (!devicesGetter) return serialOrHwSerial
    try {
        const devices = await devicesGetter()
        const match = (devices || []).find(d => d.serial === serialOrHwSerial || d.hwSerial === serialOrHwSerial)
        return (match && match.serial) || serialOrHwSerial
    } catch (_) {
        return serialOrHwSerial
    }
}

function registerLogcatHandlers() {
    ipcMain.handle('logcat:start', async (event, args = {}) => {
        const { serial, level } = args || {}
        if (!serial || typeof serial !== 'string') {
            return { success: false, error: 'serial is required' }
        }
        const adbPath = adbPathGetter()
        if (!adbPath) return { success: false, error: 'adb path not resolved' }

        const target = await resolveTarget(serial)
        activeTargetBySerial.set(serial, target)
        const sender = event.sender

        const result = logcatStream.start(target, {
            adbPath,
            level,
            onBatch: (lines) => {
                try { if (!sender.isDestroyed()) sender.send('logcat-data', { serial, lines }) } catch (_) { /* window gone */ }
            },
            onError: (err) => {
                try { if (!sender.isDestroyed()) sender.send('logcat-data', { serial, lines: [], error: err?.message || String(err) }) } catch (_) { /* ignore */ }
            },
            onClose: (code) => {
                if (activeTargetBySerial.get(serial) === target) activeTargetBySerial.delete(serial)
                try { if (!sender.isDestroyed()) sender.send('logcat-closed', { serial, code }) } catch (_) { /* ignore */ }
            },
        })

        if (!result.ok) activeTargetBySerial.delete(serial)
        return { success: !!result.ok, level: result.level, error: result.error }
    })

    ipcMain.handle('logcat:stop', async (event, args = {}) => {
        const { serial } = args || {}
        if (!serial || typeof serial !== 'string') {
            return { success: false, error: 'serial is required' }
        }
        const target = activeTargetBySerial.get(serial) || await resolveTarget(serial)
        const result = await logcatStream.stop(target)
        activeTargetBySerial.delete(serial)
        return { success: true, wasRunning: result.wasRunning }
    })

    ipcMain.handle('logcat:clear', async (event, args = {}) => {
        const { serial } = args || {}
        if (!serial || typeof serial !== 'string') {
            return { success: false, error: 'serial is required' }
        }
        const target = activeTargetBySerial.get(serial) || await resolveTarget(serial)
        logcatStream.clear(target)
        return { success: true }
    })
}

module.exports = { initLogcatHandlers }
