// electron/lib/local-modules.js
/**
 * Local Module Execution — runs trivial modules directly in Electron
 * instead of relaying through Railway WebSocket.
 *
 * Security: Only contains modules with zero IP value (shell commands,
 * taps, timers). All complex modules stay on Railway.
 *
 * This file is the registry only. Each handler lives in ./modules/<name>.js.
 *
 * Per-module fault tolerance
 * --------------------------
 * Every require() below is wrapped in `_safeRequire()`. Before this, a single
 * throw at module load (a missing transitive dep on Mac vs Windows, a syntax
 * error in a recently-edited handler, a bad relative path) would propagate
 * through `require('./local-modules')` in module-handlers.js — taking down
 * ALL 21 local handlers in one go. Every locally-executable module then
 * silently routed to Railway WS instead, which doesn't have most of them
 * either, surfacing as confusing "module not available" runs.
 *
 * Now each failed require gets a stub handler that returns an actionable
 * error result with the original failure message. The other 20 keep working.
 * Failed loads are recorded in LOCAL_MODULE_LOAD_FAILURES (logged at load time)
 * for diagnostics. The actionable failure detail itself is carried per-invocation
 * in the stub's `error`/`logs` fields, which flow back through the normal module
 * result path — module-handlers.js needs no special handling.
 */

const { LocalDevice, getADBPath, adb, shell, parseStatsFromXml, parseStatNumber, queueStatsSnapshot, getPendingSnapshots } = require('./local-modules-shared')

const LOCAL_MODULE_LOAD_FAILURES = {}

function _safeRequire(rel, name) {
    try {
        return require(rel)
    } catch (err) {
        const msg = `${err.code || err.name || 'Error'}: ${err.message || String(err)}`
        LOCAL_MODULE_LOAD_FAILURES[name] = msg
        console.warn(`[local-modules] FAILED to load handler '${name}' from ${rel}: ${msg}`)
        // Returning an async function with the same call shape as a real
        // handler means existing dispatch code in module-handlers.js doesn't
        // need any changes — invocations just return a clean failure result
        // instead of throwing TypeError because the entry was undefined.
        const stub = async function () {
            return {
                success: false,
                error: `Local module '${name}' failed to load in this build: ${msg}`,
                logs: [`[local-modules] handler '${name}' is unavailable (${msg})`],
            }
        }
        // Tag the stub so callers can distinguish it from a real handler if
        // they want to surface a packaging-bug notification.
        stub.__spStubLoadError = msg
        stub.__spStubFor = name
        return stub
    }
}

const LOCAL_MODULE_HANDLERS = {
    airplane_toggle:   _safeRequire('./modules/airplane_toggle', 'airplane_toggle'),
    wake_unlock:       _safeRequire('./modules/wake_unlock', 'wake_unlock'),
    gallery_clean:     _safeRequire('./modules/gallery_clean', 'gallery_clean'),
    delay:             _safeRequire('./modules/delay', 'delay'),
    random_delay:      _safeRequire('./modules/random_delay', 'random_delay'),
    conditional:       _safeRequire('./modules/conditional', 'conditional'),
    notification:      _safeRequire('./modules/notification', 'notification'),
    profile_switch:    _safeRequire('./modules/profile_switch', 'profile_switch'),
    list_profiles:     _safeRequire('./modules/list_profiles', 'list_profiles'),
    profile_create:    _safeRequire('./modules/profile_create', 'profile_create'),
    profile_delete:    _safeRequire('./modules/profile_delete', 'profile_delete'),
    ig_launcher:       _safeRequire('./modules/ig_launcher', 'ig_launcher'),
    ig_verification_recovery: _safeRequire('./modules/ig_verification_recovery', 'ig_verification_recovery'),
    ig_account_switch: _safeRequire('./modules/ig_account_switch', 'ig_account_switch'),
    detect_accounts:   _safeRequire('./modules/detect_accounts', 'detect_accounts'),
    content_manager:   _safeRequire('./modules/content_manager', 'content_manager'),
    airtable_sync:     _safeRequire('./modules/airtable_sync', 'airtable_sync'),
    gmail_logout:      _safeRequire('./modules/gmail_logout', 'gmail_logout'),
    ig_logout:         _safeRequire('./modules/ig_logout', 'ig_logout'),
    vpn_connect:       _safeRequire('./modules/vpn_connect', 'vpn_connect'),
    stats_scraper:     _safeRequire('./modules/stats_scraper', 'stats_scraper'),
    ig_status_check:   _safeRequire('./modules/ig_status_check', 'ig_status_check'),
    account_insights:  _safeRequire('./modules/account_insights', 'account_insights'),
}

// Preserve the alias from the old file
LOCAL_MODULE_HANDLERS.switch_account = LOCAL_MODULE_HANDLERS.ig_account_switch

if (Object.keys(LOCAL_MODULE_LOAD_FAILURES).length > 0) {
    console.warn(`[local-modules] LOADED WITH ${Object.keys(LOCAL_MODULE_LOAD_FAILURES).length} failure(s): ${Object.keys(LOCAL_MODULE_LOAD_FAILURES).join(', ')}`)
}

module.exports = {
    LOCAL_MODULE_HANDLERS,
    LOCAL_MODULE_LOAD_FAILURES,
    LocalDevice,
    getADBPath,
    adb,
    shell,
    parseStatsFromXml,
    parseStatNumber,
    queueStatsSnapshot,
    getPendingSnapshots,
}
