/**
 * schedule-handlers.js — IPC for the IG sidebar scheduler.
 *
 * 6 handlers: schedule:get, :save, :toggle-active, :run-now, :get-clerk-status,
 * :list-accounts. Also boots the cron engine in tick-and-log mode (real
 * auto-fire starts only for an authenticated desktop session.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { ipcMain, BrowserWindow } = require('electron')
const client = require('../lib/schedule-client')
const engine = require('../lib/schedule-engine')

let _ctx = null
// account_schedules does not carry a physical phone/profile binding, so the
// old main-process slot scanner cannot safely dispatch cloud schedules. The
// durable scheduled_runs dispatcher in DesktopDashboard is the default cron
// owner. Keep this only as an explicit compatibility switch for old sidebar
// schedules that still include phone_id/profile_user_id.
const _engineEnabled = process.env.SHADOWPHONE_ENABLE_LEGACY_SCHEDULE_AUTOFIRE === '1'
let _engineRunning = false

// 2.16.47: LOCAL schedule store — keyed by phoneId::userId::platform::account.
// Independent of dashboard's account_schedules (which is keyed by Supabase
// instagram_accounts.id and uses the legacy flat folder layout). Lets the
// sidebar's nested-layout accounts own their own schedules without needing
// a Supabase row first.
function _localPath() { return path.join(_ctx?.userDataPath || '', 'sidebar-schedules.json') }
function _readLocal() {
    const p = _localPath()
    try {
        if (!fs.existsSync(p)) return {}
        return JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
    } catch (err) {
        // Write a sidecar so corruption is visible and the original is recoverable
        try { fs.copyFileSync(p, p + '.corrupt') } catch (_) {}
        return {}
    }
}
function _writeLocal(obj) {
    try {
        const dest = _localPath()
        const tmp = dest + '.tmp-' + process.pid
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
        fs.renameSync(tmp, dest)
        return true
    } catch (_) { return false }
}
function _localKey(serial, userId, platform, account) {
    return `${serial}::${userId}::${platform}::${(account || '').toLowerCase()}`
}
function _matchesScheduleKey(key, serial, userId, platform, account) {
    const suffix = _localKey('', userId, platform, account)
    if (!key.endsWith(suffix)) return false
    const candidateSerial = key.slice(0, -suffix.length)
    return candidateSerial === String(serial) ||
        engine.canonicalPhoneKey(candidateSerial) === engine.canonicalPhoneKey(serial)
}
// A matching profile/account is not evidence that two serials name one phone.
// Only the hardware identity map can authorize a USB/tailnet alias.
function resolveScheduleKey(store, serial, userId, platform, account) {
    const exact = _localKey(serial, userId, platform, account)
    if (store && Object.prototype.hasOwnProperty.call(store, exact)) return exact
    const matches = Object.keys(store || {}).filter(k => _matchesScheduleKey(k, serial, userId, platform, account))
    if (!matches.length) return exact
    const tailnet = matches.find(k => k.split('::')[0].includes(':'))
    if (tailnet) return tailnet
    return matches[0]
}
function _keyFor(store, { key, serial, userId, platform, accountKey }) {
    const plat = platform || 'instagram'
    const exact = _localKey(serial, userId, plat, accountKey)
    if (store && Object.prototype.hasOwnProperty.call(store, exact)) return exact
    if (key && store && Object.prototype.hasOwnProperty.call(store, key) &&
        _matchesScheduleKey(key, serial, userId, plat, accountKey)) return key
    return resolveScheduleKey(store, serial, userId, plat, accountKey)
}
// 2.19.3: per Anyro 2026-05-26 the safer defaults for a new account's
// schedule are: VPN off (most accounts don't need a VPN), Post-Engagement
// off (engagement after posting is opt-in), Post-Engagement Stories off,
// Cascade Repost off (advanced/opt-in). Everything else stays on so a
// fresh account that just gets slots added will wake/airplane/switch/
// push/post by default.
const DEFAULT_DISABLED_STEPS = [
    'vpn_connect',
    'ig_post_engage',
    'ig_post_stories',
    'ig_repost',
]
function _emptySchedule(account) {
    return {
        id: null,
        account_id: account,
        is_active: false,
        slots: [],
        disabled_steps: [...DEFAULT_DISABLED_STEPS],
        randomize_minutes: 0,
        repeat_pattern: 'daily',
        repeat_days: [],
        content_mode: 'sequential',
        skip_posting_if_flagged: true,
    }
}

function init({ getSessionToken, getSessionInfo, getDevices, runWorkflowStep, runWorkflowModule, resolveWorkflowCtx, userDataPath }) {
    const engineCtx = {
        getSessionToken,
        client,
        getDevices,
        resolveWorkflowCtx,
        runStep: runWorkflowStep,
        runModule: runWorkflowModule,
        userDataPath,
    }
    _ctx = { getSessionToken, getSessionInfo, getDevices, runWorkflowStep, runWorkflowModule, resolveWorkflowCtx, userDataPath, engineCtx }

    ipcMain.handle('schedule:get-clerk-status', _getClerkStatus)
    ipcMain.handle('schedule:get', _getSchedule)
    ipcMain.handle('schedule:save', _saveSchedule)
    ipcMain.handle('schedule:toggle-active', _toggleActive)
    ipcMain.handle('schedule:run-now', _runNow)
    ipcMain.handle('schedule:list-accounts', _listAccounts)
    ipcMain.handle('schedule:list-all', _listAll)
    ipcMain.handle('schedule:fire-now', _fireNow)

    // Manual fire always needs the workflow context, even while cron is stopped.
    // Cron itself starts only after authentication and is resumed by set-user-session.
    engine.attachCtx(engineCtx)
    if (!resumeUserScopedState()) console.log('[schedule-handlers] cron waiting for authenticated session')
    console.log('[schedule-handlers] 8 IPC handlers registered')
}

function resumeUserScopedState() {
    if (!_engineEnabled || !_ctx?.engineCtx || !_ctx.getSessionToken?.()) return false
    if (_engineRunning) return true
    try {
        engine.start(_ctx.engineCtx)
        _engineRunning = true
        return true
    } catch (e) {
        console.warn('[schedule-handlers] cron resume failed:', e?.message || e)
        return false
    }
}

async function _getClerkStatus() {
    const token = _ctx?.getSessionToken()
    const session = _ctx?.getSessionInfo?.() || {}
    return {
        ok: true,
        signedIn: !!token,
        userId: session.userId || null,
        email: session.email || null,
    }
}

async function _resolveAccountId(accountKey) {
    const token = _ctx?.getSessionToken()
    if (!token) return null
    return client.resolveAccountId(accountKey, token)
}

async function _getSchedule(_evt, { accountKey, serial, userId, platform, key: explicitKey }) {
    // 2.16.49+: SUPABASE-FIRST when signed in, but NON-DESTRUCTIVE.
    // - remote exists → use remote, mirror to local
    // - remote null + local has data → keep local, push it up (backfill)
    // - remote null + local empty → return empty fresh shape
    // - not signed in → local cache
    try {
        const plat = platform || 'instagram'
        const localStore = _readLocal()
        const key = _keyFor(localStore, { key: explicitKey, serial, userId, platform: plat, accountKey })
        const localRow = localStore[key]

        const token = _ctx?.getSessionToken?.()
        if (token) {
            const remote = await client.pullSidebarSchedule({
                phone_id: serial, profile_user_id: userId, platform: plat, account: accountKey,
            }, token).catch(() => null)
            if (remote) {
                const row = _normalizeRemote(remote, accountKey)
                row._key = key
                localStore[key] = row
                _writeLocal(localStore)
                return { ok: true, row, accountId: accountKey, source: 'supabase' }
            }
            // Remote empty — backfill from local if local has anything meaningful
            if (localRow && _hasMeaningfulData(localRow)) {
                client.pushSidebarSchedule({
                    phone_id: serial,
                    profile_user_id: String(userId),
                    platform: plat,
                    account: String(accountKey).toLowerCase(),
                    is_active: localRow.is_active,
                    slots: localRow.slots,
                    disabled_steps: localRow.disabled_steps,
                    randomize_minutes: localRow.randomize_minutes,
                    repeat_pattern: localRow.repeat_pattern,
                    repeat_days: localRow.repeat_days,
                    content_mode: localRow.content_mode,
                    skip_posting_if_flagged: localRow.skip_posting_if_flagged,
                }, token).catch(() => {})
                localRow._key = key
                return { ok: true, row: localRow, accountId: accountKey, source: 'local-backfilling' }
            }
            const empty = _emptySchedule(accountKey)
            empty._key = key
            return { ok: true, row: empty, accountId: accountKey, source: 'supabase-empty' }
        }

        // No Clerk token → offline mode, use local cache.
        const row = localRow || _emptySchedule(accountKey)
        row._key = key
        return { ok: true, row, accountId: accountKey, source: 'local-cache', offline: true }
    } catch (e) { return { ok: false, error: e.message } }
}

function _hasMeaningfulData(row) {
    return !!(row.slots?.length || row.disabled_steps?.length || row.is_active)
}

function _normalizeRemote(remote, accountKey) {
    // Shape remote rows back into the local schedule shape the UI expects.
    return {
        id: remote.id || null,
        account_id: accountKey,
        is_active: !!remote.is_active,
        slots: Array.isArray(remote.slots) ? remote.slots : [],
        disabled_steps: Array.isArray(remote.disabled_steps) ? remote.disabled_steps : [],
        randomize_minutes: remote.randomize_minutes || 0,
        repeat_pattern: remote.repeat_pattern || 'daily',
        repeat_days: Array.isArray(remote.repeat_days) ? remote.repeat_days : [],
        content_mode: remote.content_mode || 'sequential',
        skip_posting_if_flagged: remote.skip_posting_if_flagged !== false,
        updated_at: remote.updated_at,
    }
}

function _defaultScheduleShape(accountId) {
    return {
        id: null,
        account_id: accountId,
        is_active: false,
        slots: [],
        disabled_steps: [...DEFAULT_DISABLED_STEPS],
        randomize_minutes: 0,
        repeat_pattern: 'daily',
        repeat_days: [],
        content_mode: 'sequential',
        skip_posting_if_flagged: true,
        last_fired_at: null,
    }
}

async function _saveSchedule(_evt, { accountKey, serial, userId, platform, patch, key: explicitKey }) {
    // 2.16.49: SUPABASE-FIRST save. Push to remote, await confirmation, then
    // mirror locally as offline cache. Local-only writes only when offline.
    try {
        const plat = platform || 'instagram'
        const store = _readLocal()
        const key = _keyFor(store, { key: explicitKey, serial, userId, platform: plat, accountKey })
        // Consolidate only proven transport aliases of this phone and account.
        for (const k of Object.keys(store)) {
            if (k !== key && _matchesScheduleKey(k, serial, userId, plat, accountKey)) delete store[k]
        }
        const existing = store[key] || _emptySchedule(accountKey)
        const merged = { ...existing, ...patch, account_id: accountKey, updated_at: new Date().toISOString() }

        const token = _ctx?.getSessionToken?.()
        if (token) {
            const remote = await client.pushSidebarSchedule({
                phone_id: serial,
                profile_user_id: String(userId),
                platform: plat,
                account: String(accountKey).toLowerCase(),
                is_active: merged.is_active,
                slots: merged.slots,
                disabled_steps: merged.disabled_steps,
                randomize_minutes: merged.randomize_minutes,
                repeat_pattern: merged.repeat_pattern,
                repeat_days: merged.repeat_days,
                content_mode: merged.content_mode,
                skip_posting_if_flagged: merged.skip_posting_if_flagged,
            }, token)
            if (remote) {
                const canonical = _normalizeRemote(remote, accountKey)
                canonical._key = key
                store[key] = canonical
                _writeLocal(store)
                for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('schedule:changed') } catch (_) {} }
                return { ok: true, row: canonical, source: 'supabase' }
            }
            // Remote returned null (push failed). Fall through to local-only.
        }

        // Offline / push failed → keep local copy, flag it so the UI can warn.
        store[key] = merged
        _writeLocal(store)
        for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('schedule:changed') } catch (_) {} }
        return { ok: true, row: merged, source: 'local-only', warning: 'changes saved locally — will sync when you sign in' }
    } catch (e) { return { ok: false, error: e.message } }
}

async function _toggleActive(_evt, { accountKey, serial, userId, platform, isActive }) {
    return _saveSchedule(_evt, { accountKey, serial, userId, platform, patch: { is_active: !!isActive } })
}

async function _runNow(_evt, { accountKey, serial, userId, platform, slotIndex }) {
    try {
        const plat = platform || 'instagram'
        const store = _readLocal()
        const key = resolveScheduleKey(store, serial, userId, plat, accountKey)
        const row = store[key] || _emptySchedule(accountKey)
        const slot = row.slots?.[slotIndex || 0] || { content_type: 'reel', time: '12:00' }
        // Engine kept around for v2 cron; for now Run Now in toolbar handles its own workflow.
        return { ok: true, slot, row }
    } catch (e) { return { ok: false, error: e.message } }
}

async function _fireNow(_evt, { accountKey, serial, userId, platform, slotIndex }) {
    try {
        const plat = platform || 'instagram'
        const token = _ctx?.getSessionToken?.()
        if (!token) return { ok: false, code: 'UNAUTHORIZED', error: 'Sign in before firing a schedule.' }
        if (!accountKey || !serial || userId === null || userId === undefined || String(userId).trim() === '') {
            return { ok: false, code: 'INVALID_TARGET', error: 'Account, phone, and Android profile are required.' }
        }

        // The Schedule tab owns account_schedules in Supabase. Never execute the
        // similarly-shaped sidebar-schedules.json row here: it can be stale or
        // belong to a different scheduling surface. Resolve the handle through
        // the authenticated account endpoint, then force-fetch the tenant-scoped
        // cloud row so Fire Now runs exactly what the operator is looking at.
        const accountId = await client.resolveAccountId(accountKey, token)
        if (!accountId) return { ok: false, code: 'ACCOUNT_NOT_FOUND', error: 'Account not found for this signed-in user.' }
        const rawRow = await client.getSchedule(accountId, token, { forceRefresh: true })
        if (!rawRow) return { ok: false, code: 'SCHEDULE_NOT_FOUND', error: 'No cloud schedule exists for this account.' }
        const idx = Number.isInteger(slotIndex) ? slotIndex : 0
        const slot = rawRow.slots && rawRow.slots[idx]
        if (!slot) return { ok: false, code: 'SLOT_NOT_FOUND', error: 'That slot no longer exists.' }
        const row = {
            ...rawRow,
            phone_id: serial,
            profile_user_id: String(userId),
            platform: plat,
            account: accountKey,
            account_username: accountKey,
        }
        const workflowResult = await engine.runNow({ row, slot, slotIndex: idx })
        if (!workflowResult || workflowResult.ok === false || workflowResult.success === false) {
            const failure = workflowResult && typeof workflowResult === 'object'
                ? workflowResult
                : { code: 'WORKFLOW_NO_RESULT', error: 'The scheduled workflow ended without a result.' }
            return { ...failure, ok: false, fired: false, slot }
        }
        return { ...workflowResult, ok: true, fired: true, slot }
    } catch (e) { return { ok: false, error: e.message } }
}

async function _listAccounts() {
    try {
        const token = _ctx?.getSessionToken()
        if (!token) return { ok: false, error: 'not-signed-in' }
        // Reuse the cache the resolver fills.
        const list = await client.listAllSchedulesForUser(token)
        return { ok: true, schedules: list }
    } catch (e) { return { ok: false, error: e.message } }
}

async function _listAll() {
    try {
        const store = _readLocal()
        const rows = Object.entries(store || {}).map(([key, row]) => {
            const parts = String(key).split('::')
            const account = (row && row.account) || (row && row.account_id) || parts.slice(3).join('::')
            return {
                ...row, _key: key,
                phone_id: (row && row.phone_id) || parts[0] || 'unknown',
                profile_user_id: (row && row.profile_user_id) || parts[1] || '',
                platform: (row && row.platform) || parts[2] || 'instagram',
                account,
                account_username: (row && row.account_username) || account,
            }
        })
        return { ok: true, rows }
    } catch (e) { return { ok: false, error: e.message } }
}

// Logout: stop the cron engine and clear its volatile fire/busy state so a new
// user on this same install doesn't inherit the prior user's latches. Schedules
// themselves are Supabase-first (re-pulled per userId on sign-in) — nothing user-
// owned is deleted here. The local sidebar-schedules.json cache is left as-is; it
// is re-synced from Supabase on the next schedule:get.
function resetUserScopedState() {
    engine.reset()
    _engineRunning = false
}

module.exports = { init, resolveScheduleKey, resetUserScopedState, resumeUserScopedState }
