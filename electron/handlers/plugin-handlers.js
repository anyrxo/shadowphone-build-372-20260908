/**
 * Feature 3 — YAML Per-Device Plugin Registry: IPC handlers.
 *
 * Thin ipcMain layer on top of lib/plugin-registry.js. Registers:
 *   - plugins:list        -> { ok, plugins, path, warning }
 *   - plugins:run          ({ pluginId, phone }) -> spawn the resolved command
 *   - plugins:edit-config -> shell.openPath(<userData>/shadowphone/plugins.yaml)
 *
 * Mounted from the Fleet panel's device -> plugin -> command -> Run picker
 * (see fleet-panel.html / fleet-panel-preload.js window.fleet.plugins.*).
 *
 * Initialized from main.js next to the other init*Handlers(...) calls:
 *   initPluginHandlers({ getScrcpyPath, getAdbPath })
 * — getScrcpyPath/getAdbPath mirror the same resolvers already threaded into
 * scrcpy-launcher-handlers.js / device-handlers.js, so the seeded scrcpy
 * plugin resolves the SAME bundled binary the native mirror launcher uses.
 */

const { ipcMain, shell } = require('electron')
const registry = require('../lib/plugin-registry')

// `${pluginId}::${deviceId}` -> live child process, for requires_running
// plugins ONLY. Fire-and-forget plugins (the default scrcpy entry included —
// requires_running: false) are never tracked here; scrcpy manages its own
// window/lifecycle exactly like a manually-launched scrcpy.exe would.
const runningByKey = new Map()

function trackKey(pluginId, deviceId) {
    return `${pluginId}::${deviceId}`
}

function isLive(child) {
    return !!child && child.exitCode === null && child.signalCode === null
}

function initPluginHandlers({ getScrcpyPath, getAdbPath } = {}) {
    const deps = { getScrcpyPath, getAdbPath }

    ipcMain.handle('plugins:list', async () => {
        try {
            const { plugins, path: filePath, error } = registry.load()
            return { ok: true, plugins, path: filePath, warning: error || null }
        } catch (err) {
            return { ok: false, error: err?.message || String(err), plugins: [] }
        }
    })

    ipcMain.handle('plugins:run', async (_evt, { pluginId, phone } = {}) => {
        try {
            const { plugins } = registry.load()
            const plugin = plugins.find(p => p.id === pluginId)
            if (!plugin) return { ok: false, error: `unknown plugin: ${pluginId}` }

            const deviceId = registry.deviceIdFor(phone)
            const key = trackKey(plugin.id, deviceId)

            if (plugin.requires_running) {
                const existing = runningByKey.get(key)
                if (isLive(existing)) {
                    return { ok: true, alreadyRunning: true, pid: existing.pid }
                }
                runningByKey.delete(key)
            }

            const result = registry.run(plugin, phone, deps)
            if (!result.ok) return result

            if (plugin.requires_running && result.child) {
                runningByKey.set(key, result.child)
                result.child.once('exit', () => {
                    if (runningByKey.get(key) === result.child) runningByKey.delete(key)
                })
            }

            return { ok: true, pid: result.pid, command: result.command, args: result.args }
        } catch (err) {
            return { ok: false, error: err?.message || String(err) }
        }
    })

    ipcMain.handle('plugins:edit-config', async () => {
        try {
            // load() ensures the file exists (writes the default-with-scrcpy on
            // first run) before we hand it to the OS to open.
            const { path: filePath } = registry.load()
            const err = await shell.openPath(filePath)
            if (err) return { ok: false, error: err, path: filePath }
            return { ok: true, path: filePath }
        } catch (err) {
            return { ok: false, error: err?.message || String(err) }
        }
    })
}

module.exports = { initPluginHandlers }
