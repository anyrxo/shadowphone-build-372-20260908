/**
 * IPC Handlers Index
 * Central export for all modular IPC handlers
 */

const { initDeviceHandlers, startADBMonitoring, stopADBMonitoring, startADBServer, stopADBServer, executeADB, clearDeviceState, getConnectedDevices, checkForNewDevices, seedDeviceSerials, savedDevicesReady } = require('./device-handlers')
const { initProfileHandlers } = require('./profile-handlers')
const { initModuleHandlers, WS_ENABLED_MODULES } = require('./module-handlers')
const { initContentHandlers } = require('./content-handlers')
const { initSystemHandlers } = require('./system-handlers')
const { initPortalHandlers, shutdownPortal } = require('./portal-handlers')
const { initPairingHandlers } = require('./pairing-handlers')
const { initLogcatHandlers } = require('./logcat-handlers')
const { initPluginHandlers } = require('./plugin-handlers')

module.exports = {
    // Device handlers
    initDeviceHandlers,
    startADBMonitoring,
    stopADBMonitoring,
    startADBServer,
    stopADBServer,
    executeADB,
    getConnectedDevices,
    clearDeviceState,
    checkForNewDevices,
    seedDeviceSerials,
    savedDevicesReady,

    // Profile handlers
    initProfileHandlers,

    // Module handlers
    initModuleHandlers,
    WS_ENABLED_MODULES,

    // Content handlers
    initContentHandlers,

    // System handlers
    initSystemHandlers,

    // Portal (web-mirror) handlers
    initPortalHandlers,
    shutdownPortal,

    // Wireless Add-Phone wizard (Feature 1)
    initPairingHandlers,

    // Live logcat viewer (Feature 2)
    initLogcatHandlers,

    // YAML per-device plugin registry (Feature 3)
    initPluginHandlers,
}
