/**
 * insights-handlers.js — IPC bridge for the Models Dashboard IG-insights feature.
 *
 * Five handlers, all LOCAL_ONLY (nodeIntegration renderer → ipcRenderer.invoke):
 *   insights:fetch          — drive the phone: per-profile airplane-wrapped switch,
 *                             then per known IG account ig_account_switch +
 *                             account_insights scrape, appending each snapshot to
 *                             the time-series store. Streams 'insights:fetch-progress'
 *                             to the calling webContents. Holds the schedule-engine
 *                             busy lock for the whole sweep (insights-sweep.js).
 *   insights:get            — readSeries(account, sinceTs) compact chart points.
 *   insights:get-latest     — readLatest(account) full demographics blob.
 *   insights:get-all-latest — readAllLatest() latest compact snapshot per account.
 *   insights:get-all-series — readAllSeries() full per-account history (analytics charts).
 *
 * The phone-driving sweep lives in lib/insights-sweep.js (mirrors
 * models-dashboard-scan.js — busy lock + airplane-wrapped am switch-user). This
 * file is the THIN IPC seam: it assembles the sweep deps from what main.js already
 * has in scope and streams progress back to event.sender. Read-only getters go
 * straight to lib/insights-store.js (phone-free, pure fs).
 */
'use strict'

const store = require('../lib/insights-store')
const { runEditProfileBrain } = require('./profile-edit-handlers')

/**
 * registerInsightsHandlers(ipcMain, deps)
 *   deps = { invokeProfiles, userDataPath, getMainWindow, registryPath }
 *   - invokeProfiles:      (serial) -> { success, profiles:[{id,name,...}] }
 *   - userDataPath:        app.getPath('userData') — insights store + registry root
 *   - getMainWindow:       () -> BrowserWindow (parity with model-handlers; unused
 *                          by the per-call stream which targets event.sender)
 *   - registryPath:        %APPDATA%/shadowphone-desktop/fleet-registry.json
 */
function registerInsightsHandlers(ipcMain, deps) {
    const {
        invokeProfiles,
        userDataPath,
        getMainWindow,
        registryPath,
    } = deps || {}

    // ── insights:fetch — phone-driving insights sweep for one device ──────────
    // Mirrors fleet:scan: streams per-account progress to the LOCAL_ONLY window
    // that invoked it, holds the per-phone busy lock for the whole sweep, and
    // airplane-wraps every am switch-user inside insights-sweep.js. Resolves with
    // the sweep result so the renderer can refresh once it's done.
    ipcMain.handle('insights:fetch', async (event, payload) => {
        const serial = payload && payload.serial
        if (!serial) return { ok: false, error: 'serial required' }
        const profileIds = (payload && Array.isArray(payload.profileIds)) ? payload.profileIds : undefined

        // Required at fetch time, not module load, so the read-only getters below
        // stay available even if insights-sweep.js fails to load in some build.
        let fetchDeviceInsights
        try {
            ({ fetchDeviceInsights } = require('../lib/insights-sweep'))
        } catch (e) {
            return { ok: false, error: `insights-sweep unavailable: ${e && e.message ? e.message : String(e)}` }
        }

        const wc = event.sender // the LOCAL_ONLY main window's webContents
        const sweepDeps = {
            registryPath,                                  // fleet-registry.json (known IG accounts per profile)
            userDataPath,                                  // insights-store append target
            getDeviceProfiles: (s) => invokeProfiles(s),   // { success, profiles }
            ensureProfessional: ({ serial: liveSerial, userId, account }) => runEditProfileBrain({
                serial: liveSerial,
                userId,
                account,
                config: { switch_to_professional: true },
                getMainWindow,
            }),
        }

        return fetchDeviceInsights(serial, {
            profileIds,
            ensureProfessional: payload?.ensureProfessional !== false,
            onProgress: (e) => {
                if (wc && !wc.isDestroyed()) {
                    wc.send('insights:fetch-progress', { serial, ...e })
                }
            },
        }, sweepDeps)
    })

    // ── read-only getters (phone-free, straight to the time-series store) ─────
    ipcMain.handle('insights:get', async (_evt, payload) => {
        try {
            const account = payload && payload.account
            if (!account) return { ok: false, error: 'account required' }
            const sinceTs = (payload && Number.isFinite(payload.sinceTs)) ? payload.sinceTs : 0
            return { ok: true, series: await store.readSeries(userDataPath, account, sinceTs) }
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) }
        }
    })

    ipcMain.handle('insights:get-latest', async (_evt, payload) => {
        try {
            const account = payload && payload.account
            if (!account) return { ok: false, error: 'account required' }
            return { ok: true, latest: await store.readLatest(userDataPath, account) }
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) }
        }
    })

    ipcMain.handle('insights:get-all-latest', async () => {
        try {
            return { ok: true, latest: await store.readAllLatest(userDataPath) }
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) }
        }
    })

    ipcMain.handle('insights:get-all-series', async () => {
        try {
            return { ok: true, series: await store.readAllSeries(userDataPath) }
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) }
        }
    })

    // getMainWindow kept in the deps contract for parity with model-handlers and
    // any future broadcast use; referenced here so lint doesn't flag it unused.
    void getMainWindow

    console.log('[insights-handlers] 5 IPC handlers registered')
}

module.exports = { registerInsightsHandlers }
