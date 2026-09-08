/**
 * schedule-client.js — Talks to the dashboard's /api/schedules and
 * /api/desktop/accounts/* endpoints from Electron main process.
 *
 * Auth model: uses the same Clerk session cookie the dashboard window
 * has after the user signs in. currentUserSession.sessionToken (set by
 * 'set-user-session' IPC when the dashboard auth completes) is the JWT.
 *
 * No direct Supabase access — keeps RLS + business rules centralized in
 * the dashboard's API layer. Matches every other server-side call in main.js.
 */
'use strict'

const { appAuthFetch } = require('./app-auth-fetch')

// Canonical host — byte-identical to main.js:144 on purpose. The apex
// (shadowphone.io) is 308-redirected to www by vercel.json, and Node 22/undici
// DELETES Authorization + Cookie across that cross-origin hop: every request
// from here arrived at www unauthenticated and came back { error:'Unauthorized' }.
// That is the 2026-07-25 "Create IG → Unauthorized" incident, and the reason
// markFiredLocal below exists as a workaround (see its comment).
const APP_URL = process.env.SHADOWPHONE_APP_URL || 'https://www.shadowphone.io'

// In-memory caches. Cleared on user session change.
const accountIdCache = new Map()       // accountKey (lowercase) → instagram_accounts.id
let lastScheduleFetchAt = 0
const scheduleCache = new Map()        // account_id → { row, fetchedAt }
const SCHED_CACHE_MS = 5000

// Single chokepoint for all 14 endpoints below. appAuthFetch mints a LIVE Clerk
// JWT immediately before the request and retries once on a 401 with a forced
// re-mint — the sessionToken argument is kept in every signature because ~25
// callers use it as a signed-in gate, but it no longer builds the headers.
async function _fetchJson(method, url, sessionToken, body) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
    }
    if (body) opts.body = JSON.stringify(body)
    const res = await appAuthFetch(url, opts, { fallbackToken: sessionToken })
    let parsed = null
    try { parsed = await res.json() } catch (_) {}
    if (!res.ok) {
        const msg = parsed?.error || `HTTP ${res.status}`
        const err = new Error(msg)
        err.status = res.status
        throw err
    }
    return parsed
}

/**
 * Resolve accountKey (folder name = lowercase IG handle) → instagram_accounts.id.
 * Cached for the session. Returns null if account doesn't exist.
 */
async function resolveAccountId(accountKey, sessionToken) {
    if (!accountKey) return null
    const key = String(accountKey).trim().toLowerCase()
    if (accountIdCache.has(key)) return accountIdCache.get(key)
    if (!sessionToken) return null
    try {
        // Existing endpoint at GET /api/accounts returns all of user's IG accounts.
        const json = await _fetchJson('GET', `${APP_URL}/api/accounts`, sessionToken, null)
        const list = json?.data || json?.accounts || []
        for (const acc of list) {
            const u = String(acc.username || '').trim().toLowerCase()
            if (u) accountIdCache.set(u, acc.id)
        }
        return accountIdCache.get(key) || null
    } catch (e) {
        console.warn('[schedule-client] resolveAccountId failed:', e?.message || e)
        return null
    }
}

async function updateAccountUsername(oldUsername, newUsername, sessionToken) {
    if (!sessionToken) {
        return { success: false, skipped: true, error: 'No authenticated desktop session.' }
    }
    const oldKey = String(oldUsername || '').trim().toLowerCase()
    const newKey = String(newUsername || '').trim().toLowerCase()
    const accountId = await resolveAccountId(oldKey, sessionToken)
    if (!accountId) {
        return { success: false, skipped: true, error: `Cloud account @${oldKey} was not found.` }
    }

    try {
        await _fetchJson('PATCH', `${APP_URL}/api/accounts`, sessionToken, {
            accountId,
            username: newKey,
        })
        accountIdCache.delete(oldKey)
        accountIdCache.set(newKey, accountId)
        return { success: true, accountId, username: newKey }
    } catch (error) {
        return { success: false, error: error?.message || String(error) }
    }
}

async function getSchedule(accountId, sessionToken, { forceRefresh = false } = {}) {
    if (!accountId || !sessionToken) return null
    const cached = scheduleCache.get(accountId)
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < SCHED_CACHE_MS) return cached.row
    const json = await _fetchJson('GET', `${APP_URL}/api/schedules`, sessionToken, null)
    const rows = json?.data || []
    const row = rows.find(r => r.account_id === accountId) || null
    scheduleCache.set(accountId, { row, fetchedAt: Date.now() })
    return row
}

async function listAllSchedulesForUser(sessionToken) {
    if (!sessionToken) return []
    const json = await _fetchJson('GET', `${APP_URL}/api/schedules`, sessionToken, null)
    return json?.data || []
}

// LOCAL_ONLY: stamp last_fired_at back into sidebar-schedules.json so the
// engine's cross-fire gate (lastFiredAt >= earliestClaim) actually engages
// offline. Without this the cloud saveSchedule throws Unauthorized, the
// stamp never persists, and the slot re-fires every MIN_FIRE_GAP (~4min) —
// which stacked up multiple draft posts during validation.
function markFiredLocal(userDataPath, row) {
    try {
        const fs = require('fs')
        const path = require('path')
        const p = path.join(userDataPath || '', 'sidebar-schedules.json')
        if (!fs.existsSync(p)) return false
        const store = JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
        const key = `${row.phone_id}::${row.profile_user_id}::${row.platform || 'instagram'}::${String(row.account_id || '').toLowerCase()}`
        if (store[key]) {
            store[key].last_fired_at = new Date().toISOString()
            fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8')
            return true
        }
    } catch (e) {
        console.warn('[schedule-client] markFiredLocal failed:', e?.message || e)
    }
    return false
}

// Inverse of markFiredLocal: write a SPECIFIC last_fired_at (or clear it when
// value is null) so a FAILED post's pre-dispatch claim can be rolled back and the
// slot retried on the next tick (instead of being latched as posted forever).
function restoreFiredLocal(userDataPath, row, value) {
    try {
        const fs = require('fs')
        const path = require('path')
        const p = path.join(userDataPath || '', 'sidebar-schedules.json')
        if (!fs.existsSync(p)) return false
        const store = JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
        const key = `${row.phone_id}::${row.profile_user_id}::${row.platform || 'instagram'}::${String(row.account_id || '').toLowerCase()}`
        if (store[key]) {
            if (value) store[key].last_fired_at = value
            else delete store[key].last_fired_at
            fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8')
            return true
        }
    } catch (e) {
        console.warn('[schedule-client] restoreFiredLocal failed:', e?.message || e)
    }
    return false
}

// LOCAL_ONLY counterpart — reads sidebar-schedules.json directly so the
// auto-fire engine works without a cloud session. The keyed store is
// flattened back into the row-shape the engine expects, with phone_id
// and profile_user_id parsed from the key.
async function listAllSchedulesLocal(userDataPath) {
    try {
        const fs = require('fs')
        const path = require('path')
        const p = path.join(userDataPath || '', 'sidebar-schedules.json')
        if (!fs.existsSync(p)) return []
        const store = JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
        const rows = []
        for (const [key, row] of Object.entries(store)) {
            const parts = key.split('::')
            if (parts.length < 4) {
                console.warn('[schedule-client] dropping malformed schedule key (need >=4 ::-parts):', key)
                continue
            }
            // Bounded split: keep any '::' that lives inside the account segment so a
            // serial/account containing '::' still fires instead of silently vanishing.
            const [phone_id, profile_user_id, platform] = parts
            const account = parts.slice(3).join('::')
            rows.push({
                ...row,
                phone_id,
                profile_user_id,
                platform,
                account_id: row.account_id || account,
            })
        }
        return rows
    } catch (e) {
        console.warn('[schedule-client] listAllSchedulesLocal failed:', e?.message || e)
        return []
    }
}

async function saveSchedule(patch, sessionToken) {
    if (!patch?.account_id) throw new Error('account_id required')
    const json = await _fetchJson('POST', `${APP_URL}/api/schedules`, sessionToken, patch)
    // Invalidate cache so next get pulls fresh.
    scheduleCache.delete(patch.account_id)
    return json?.data || json
}

function clearCaches() {
    accountIdCache.clear()
    scheduleCache.clear()
}

// 2.16.48: sidebar_schedules sync (independent of legacy account_schedules).
// Keyed by (phone_id, profile_user_id, platform, account). Used for cross-VA
// continuity — the local sidebar-schedules.json remains source of truth and
// these calls mirror it to Supabase via the dashboard.

async function pullSidebarSchedule(key, sessionToken) {
    if (!sessionToken) return null
    const qs = new URLSearchParams({
        phone_id: key.phone_id,
        profile_user_id: String(key.profile_user_id),
        platform: key.platform,
        account: String(key.account || '').toLowerCase(),
    }).toString()
    try {
        const json = await _fetchJson('GET', `${APP_URL}/api/sidebar-schedules?${qs}`, sessionToken, null)
        return json?.data || null
    } catch (e) {
        console.warn('[schedule-client] pullSidebarSchedule failed:', e?.message || e)
        return null
    }
}

async function pushSidebarSchedule(row, sessionToken) {
    if (!sessionToken) return null
    try {
        const json = await _fetchJson('POST', `${APP_URL}/api/sidebar-schedules`, sessionToken, row)
        return json?.data || null
    } catch (e) {
        console.warn('[schedule-client] pushSidebarSchedule failed:', e?.message || e)
        return null
    }
}

async function listSidebarSchedules(sessionToken) {
    if (!sessionToken) return []
    try {
        const json = await _fetchJson('GET', `${APP_URL}/api/sidebar-schedules`, sessionToken, null)
        return json?.data || []
    } catch (e) {
        console.warn('[schedule-client] listSidebarSchedules failed:', e?.message || e)
        return []
    }
}

// 2.16.49: sidebar_account_defaults sync (captions, comments, story_captions).
// Cross-VA visibility — when VA on device B opens captions for an account,
// they see what VA on device A typed last.

async function pullSidebarDefault(key, sessionToken) {
    if (!sessionToken) return null
    const qs = new URLSearchParams({
        phone_id: key.phone_id,
        profile_user_id: String(key.profile_user_id),
        platform: key.platform,
        account: String(key.account || '').toLowerCase(),
        file_kind: key.file_kind,
    }).toString()
    try {
        const json = await _fetchJson('GET', `${APP_URL}/api/sidebar-defaults?${qs}`, sessionToken, null)
        return json?.data || null
    } catch (e) {
        console.warn('[schedule-client] pullSidebarDefault failed:', e?.message || e)
        return null
    }
}

async function pushSidebarDefault(row, sessionToken) {
    if (!sessionToken) return null
    try {
        const json = await _fetchJson('POST', `${APP_URL}/api/sidebar-defaults`, sessionToken, row)
        return json?.data || null
    } catch (e) {
        console.warn('[schedule-client] pushSidebarDefault failed:', e?.message || e)
        return null
    }
}

// 2.16.50: sidebar_account_registry sync — which account folders exist
// per (phone, profile, platform). Other VAs see the same list.

async function listSidebarAccounts(key, sessionToken) {
    if (!sessionToken) return []
    const qs = new URLSearchParams({
        phone_id: key.phone_id,
        profile_user_id: String(key.profile_user_id),
        platform: key.platform,
    }).toString()
    try {
        const json = await _fetchJson('GET', `${APP_URL}/api/sidebar-account-registry?${qs}`, sessionToken, null)
        return json?.data || []
    } catch (e) {
        console.warn('[schedule-client] listSidebarAccounts failed:', e?.message || e)
        return []
    }
}

async function registerSidebarAccount(row, sessionToken) {
    if (!sessionToken) return null
    try {
        const json = await _fetchJson('POST', `${APP_URL}/api/sidebar-account-registry`, sessionToken, row)
        return json?.data || null
    } catch (e) {
        console.warn('[schedule-client] registerSidebarAccount failed:', e?.message || e)
        return null
    }
}

// 2.16.52: phone registry + profile state sync (active platform + active
// account per platform). Lets VA B pick up where VA A left off.

async function pullSidebarState({ phone_id, profile_user_id }, sessionToken) {
    if (!sessionToken) return { phones: [], profile: null }
    const params = new URLSearchParams()
    if (phone_id) params.set('phone_id', phone_id)
    if (profile_user_id) params.set('profile_user_id', String(profile_user_id))
    try {
        const json = await _fetchJson('GET', `${APP_URL}/api/sidebar-state?${params.toString()}`, sessionToken, null)
        return json?.data || { phones: [], profile: null }
    } catch (e) {
        console.warn('[schedule-client] pullSidebarState failed:', e?.message || e)
        return { phones: [], profile: null }
    }
}

async function pushSidebarState({ phone, profile }, sessionToken) {
    if (!sessionToken) return null
    try {
        const json = await _fetchJson('POST', `${APP_URL}/api/sidebar-state`, sessionToken, { phone, profile })
        return json?.data || null
    } catch (e) {
        console.warn('[schedule-client] pushSidebarState failed:', e?.message || e)
        return null
    }
}

// 2.16.53: one-shot bulk export — used by "Sync from cloud" to populate
// a fresh VA install with the team's full sidebar dataset.
async function bulkExportSidebar(sessionToken) {
    if (!sessionToken) return null
    try {
        const json = await _fetchJson('GET', `${APP_URL}/api/sidebar-bulk-export`, sessionToken, null)
        return json?.data || null
    } catch (e) {
        console.warn('[schedule-client] bulkExportSidebar failed:', e?.message || e)
        return null
    }
}

module.exports = {
    APP_URL,
    resolveAccountId,
    updateAccountUsername,
    getSchedule,
    listAllSchedulesForUser,
    listAllSchedulesLocal,
    markFiredLocal,
    restoreFiredLocal,
    saveSchedule,
    clearCaches,
    pullSidebarSchedule,
    pushSidebarSchedule,
    listSidebarSchedules,
    pullSidebarDefault,
    pushSidebarDefault,
    listSidebarAccounts,
    registerSidebarAccount,
    pullSidebarState,
    pushSidebarState,
    bulkExportSidebar,
}
