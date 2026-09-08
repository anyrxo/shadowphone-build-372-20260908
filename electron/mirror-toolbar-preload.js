/**
 * Preload for the per-mirror toolbar popup. Exposes a tiny API the
 * toolbar HTML uses to fire IPC actions against the device this
 * toolbar belongs to.
 */
const { ipcRenderer } = require('electron')

console.log('[toolbar-preload] loaded — injecting window.toolbar directly (no contextIsolation)')

// Common Android app package names — kept centralized so the toolbar
// HTML doesn't need to know them.
const PKG = {
    instagram: 'com.instagram.android',
    tiktok: 'com.zhiliaoapp.musically',
    gmail: 'com.google.android.gm',
    twitter: 'com.twitter.android',
    chrome: 'com.android.chrome',
    settings: 'com.android.settings',
}

// Direct injection — contextIsolation: false in mirror-toolbar.js makes
// window.toolbar available to the page without contextBridge.
window.toolbar = {
    // System / hardware
    screenshot: (serial) => ipcRenderer.invoke('take-screenshot', serial),
    wake: (serial) => ipcRenderer.invoke('device-power', serial, 'wake'),
    sleep: (serial) => ipcRenderer.invoke('device-power', serial, 'sleep'),
    closeMirror: (serial) => ipcRenderer.invoke('stop-scrcpy', serial),

    // 2.16.15: phone power pills
    airplaneToggle: (serial) => ipcRenderer.invoke('phone:airplane-toggle', { serial }),
    // 2.19.0: explicit on/off — fixes airplane_off being a no-op on USB.
    airplaneSet: (serial, state) => ipcRenderer.invoke('phone:airplane-set', { serial, state }),
    // 2.21.14: cheap workflow-check — skip airplane dance when target == current.
    getCurrentUser: (serial) => ipcRenderer.invoke('phone:get-current-user', { serial }),
    reboot: (serial) => ipcRenderer.invoke('phone:reboot', { serial }),
    powerOff: (serial) => ipcRenderer.invoke('phone:power-off', { serial }),
    screenToggle: (serial) => ipcRenderer.invoke('phone:screen-toggle', { serial }),
    // 2.18.11: wake + actually unlock (KEYCODE_WAKEUP + KEYCODE_MENU + swipe-up)
    wakeUnlock: (serial) => ipcRenderer.invoke('phone:wake-unlock', { serial }),

    // 3.2: cheap adb round-trip ping for the live latency chip
    pingLatency: (serial) => ipcRenderer.invoke('phone:ping-latency', { serial }),
    // 2.16.20: gallery + current-profile readout
    openGallery: (serial) => ipcRenderer.invoke('phone:open-gallery', { serial }),
    clearGallery: (serial) => ipcRenderer.invoke('phone:clear-gallery', { serial }),
    getCurrentProfile: (serial) => ipcRenderer.invoke('phone:current-profile', { serial }),

    // 2.16.27: per-profile local content folder (host PC) — LEGACY single-platform IPC
    openContentFolder: (serial) => ipcRenderer.invoke('phone:open-content-folder', { serial }),
    createContentFolder: (serial, accountName) => ipcRenderer.invoke('phone:create-content-folder', { serial, accountName }),

    // 2.16.31: multi-platform sidebar bindings
    sidebarGetState: (serial, userId) => ipcRenderer.invoke('sidebar:get-state', { serial, userId }),
    sidebarSetPlatform: (serial, userId, platform) => ipcRenderer.invoke('sidebar:set-active-platform', { serial, userId, platform }),
    sidebarSetAccount: (serial, userId, platform, account) => ipcRenderer.invoke('sidebar:set-active-account', { serial, userId, platform, account }),
    sidebarCreateAccount: (serial, userId, platform, accountName, password, persistCredentials = false) => ipcRenderer.invoke('sidebar:create-account', {
        serial, userId, platform, accountName, password, persistCredentials,
    }),
    openCreateIg: (input) => ipcRenderer.invoke('toolbar:open-create-ig', input),
    openSettings: () => ipcRenderer.invoke('open-settings'),
    sidebarOpenFolder: (serial, userId, platform, account, legacy) => ipcRenderer.invoke('sidebar:open-folder', { serial, userId, platform, account, legacy }),
    sidebarOpenDefaults: () => ipcRenderer.invoke('sidebar:open-defaults'),

    // 2.16.33: per-account default-files picker
    sidebarListDefaults: (serial, userId, platform, account) => ipcRenderer.invoke('sidebar:list-defaults', { serial, userId, platform, account }),
    // 2.16.49: accepts either a filePath string (legacy) or an object with
    // {filePath, serial, userId, platform, account, file_kind} for sync watcher.
    sidebarOpenDefaultFile: (arg) => {
        const payload = typeof arg === 'string' ? { filePath: arg } : (arg || {})
        return ipcRenderer.invoke('sidebar:open-default-file', payload)
    },

    // 2.16.47: IG scheduler — LOCAL-FIRST, keyed by phone+profile+platform+account.
    // Independent of dashboard's account_schedules (which used legacy flat folder layout).
    scheduleClerkStatus: () => ipcRenderer.invoke('schedule:get-clerk-status'),
    scheduleGet: (accountKey, serial, userId, platform) => ipcRenderer.invoke('schedule:get', { accountKey, serial, userId, platform }),
    scheduleSave: (accountKey, serial, userId, platform, patch) => ipcRenderer.invoke('schedule:save', { accountKey, serial, userId, platform, patch }),
    scheduleToggleActive: (accountKey, serial, userId, platform, isActive) => ipcRenderer.invoke('schedule:toggle-active', { accountKey, serial, userId, platform, isActive }),
    scheduleRunNow: (accountKey, serial, userId, platform, slotIndex) => ipcRenderer.invoke('schedule:run-now', { accountKey, serial, userId, platform, slotIndex }),
    scheduleListAccounts: () => ipcRenderer.invoke('schedule:list-accounts'),

    // 2.16.37: generic module runner — used by sidebar Run Now to fire real modules
    runModuleWs: (config) => ipcRenderer.invoke('run-module-ws', config),

    // 2.16.38: push_content uses REST (adb-push-content-folder), not WS
    pushContentFolder: (opts) => ipcRenderer.invoke('adb-push-content-folder', opts),

    // 2.16.39: subscribe to module progress events emitted by runModuleWs
    onModuleProgress: (callback) => {
        const listener = (_e, data) => callback(data)
        ipcRenderer.on('module-progress', listener)
        return () => ipcRenderer.removeListener('module-progress', listener)
    },
    onAppSettingChanged: (callback) => {
        const listener = (_e, data) => callback(data)
        ipcRenderer.on('app-setting-changed', listener)
        return () => ipcRenderer.removeListener('app-setting-changed', listener)
    },

    // 2.19.4: schedule engine -> renderer bridge. Main process dispatches
    // 'schedule:fire-workflow' when a slot is due (queue-ordered, oldest
    // overdue first, serialized per phone). Renderer wires this into its
    // existing scheduleRunNow path and reports completion back via the
    // returned id so the engine knows when the phone is idle again.
    onScheduleFireWorkflow: (callback) => {
        const listener = (_e, data) => callback(data)
        ipcRenderer.on('schedule:fire-workflow', listener)
        return () => ipcRenderer.removeListener('schedule:fire-workflow', listener)
    },
    scheduleWorkflowResult: (id, result) => ipcRenderer.send('schedule:workflow-result:' + id, result),

    // IG insights (per-account Professional Dashboard scrape) — read-only getters
    // for the live-logs STATS pane. getInsights returns the latest FULL demographics
    // blob ({ok, latest:{ts,account,full}} or latest:null when never scraped);
    // getInsightsSeries returns the compact time-series. Both are phone-free
    // (straight to insights-store via insights:get-latest / insights:get).
    getInsights: (account) => ipcRenderer.invoke('insights:get-latest', { account }),
    getInsightsSeries: (account) => ipcRenderer.invoke('insights:get', { account }),

    // Sender-bound live-log slide-out panel mode.
    setSidebarMode: (mode) => ipcRenderer.invoke('toolbar:set-panel-mode', mode),
    onLiveLog: (callback) => {
        const listener = (_e, data) => callback(data)
        ipcRenderer.on('live-log', listener)
        return () => ipcRenderer.removeListener('live-log', listener)
    },

    // Feature 2: live logcat viewer — per-serial `adb logcat` stream (level
    // filtered server-side, restarts the adb process on level change). Streams
    // only to THIS window (not broadcast) since logcat is high-volume.
    logcatStart: (serial, opts) => ipcRenderer.invoke('logcat:start', { serial, level: opts?.level }),
    logcatStop: (serial) => ipcRenderer.invoke('logcat:stop', { serial }),
    logcatClear: (serial) => ipcRenderer.invoke('logcat:clear', { serial }),
    onLogcat: (callback) => {
        const listener = (_e, data) => callback(data)
        ipcRenderer.on('logcat-data', listener)
        return () => ipcRenderer.removeListener('logcat-data', listener)
    },
    onLogcatClosed: (callback) => {
        const listener = (_e, data) => callback(data)
        ipcRenderer.on('logcat-closed', listener)
        return () => ipcRenderer.removeListener('logcat-closed', listener)
    },

    // App launchers
    launchApp: (serial, pkg) => ipcRenderer.invoke('launch-app', serial, pkg),
    openInstagram: (serial) => ipcRenderer.invoke('open-instagram', serial),
    PKG,

    // Profile management
    getProfiles: (serial) => ipcRenderer.invoke('get-profiles', serial),
    switchProfile: (serial, profileId, opts) => ipcRenderer.invoke('switch-profile', { serial, profileId, completeSetupWizard: true, isNewProfile: opts?.isNewProfile || false }),
    // 2.17.20: match the dashboard's Create Profile behavior — copy ALL
    // apps from owner (not just the 9 essentials) so the new profile is
    // immediately usable. Caller may override with explicit options.
    createProfile: (serial, name, opts) => ipcRenderer.invoke('create-profile', serial, name, opts || { copyAllApps: true }),
    renameProfile: (serial, userId, newName) => ipcRenderer.invoke('rename-profile', serial, userId, newName),
    deleteProfile: (serial, userId) => ipcRenderer.invoke('delete-profile', serial, userId),

    // Content upload
    selectFiles: (opts) => ipcRenderer.invoke('select-files', opts || {}),
    pushFile: (opts) => ipcRenderer.invoke('adb-push-file', opts),
    // 2.16.1: Vanadium HTTP upload — lands in the ACTIVE profile's storage
    // instead of user 0's. Use this for any file the operator picks while a
    // non-owner profile is in front.
    vanadiumUpload: (opts) => ipcRenderer.invoke('vanadium-upload-file', opts),

    // 2.17.21: paste host clipboard text into phone's focused EditText
    // via `adb shell input text`. Reliable on tailnet + UHID where scrcpy's
    // MOD+V clipboard sync flakes.
    hostPaste: (serial) => ipcRenderer.invoke('host-clipboard-paste', { serial }),

    // 2.18.10: read entire launcher.log + return as string. Sidebar's
    // "Copy Diag" button uses this to copy the full log to host clipboard
    // so VAs can paste in a DM when something fails. Per Anyro: "we need
    // entire logs they can copy and dm me so we can debug whatever happens".
    readFullLog: () => ipcRenderer.invoke('logs:read-full', 'launcher.log'),
    // 2.17.21: tail launcher.log for prepopulating the live-logs panel
    tailLog: (name, maxLines) => ipcRenderer.invoke('logs:tail', name, maxLines),

    // 2.18.8: structured sidebar event logging — every meaningful click /
    // state change goes to launcher.log via this IPC. Main process auto-
    // injects the serial from the toolbar window URL so caller doesn't
    // pass it.
    sidebarLog: (event, data) => ipcRenderer.invoke('sidebar:log-event', event, data || {}),

    // 2.18.9: platform pill icons as data URIs. Relative <img src="assets/...">
    // breaks on macOS asar packaging when loadFile() is called with a search
    // string — the URL base shifts and the relative path 404s. Embedding the
    // PNGs as data URIs at preload time sidesteps all path resolution.
    // Anyro: "logos for those platform buttons dont show on mac".
    PLATFORM_ICONS: (() => {
        const fs = require('fs')
        const path = require('path')
        const out = {}
        for (const name of ['instagram', 'tiktok', 'twitter', 'gmail']) {
            try {
                const p = path.join(__dirname, 'assets', 'app-icons', name + '.png')
                const b64 = fs.readFileSync(p).toString('base64')
                out[name] = 'data:image/png;base64,' + b64
            } catch (_) { /* missing icon — leave undefined, HTML keeps fallback */ }
        }
        return out
    })(),

    // 2.18.1: schedule drawer expand. Toolbar HTML's expand-button click
    // handler calls this. Main process widens the toolbar BrowserWindow by
    // SCHED_DRAWER_WIDTH=540px so the scheduler reflows into a horizontal
    // 3-col layout (STEPS | IG MODULES | POST SLOTS).
    toggleSchedulerPanel: (open) => ipcRenderer.invoke('toolbar:toggle-scheduler-panel', !!open),

    // Utility
    openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
    revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
    getUserDataPath: () => ipcRenderer.invoke('get-app-info').then((info) => info?.userDataPath || ''),

    // Public settings and write-only provider configuration status.
    getAppSetting: (key) => ipcRenderer.invoke('app:get-setting', key),
    setAppSetting: (key, value) => ipcRenderer.invoke('app:set-setting', key, value),
}
