/**
 * sidebar-content-handlers.js — IPC for the multi-platform sidebar.
 *
 * Each handler operates on the phone+profile identified by (serial, userId).
 * Phone identity → stable Tailscale machine ID (with serial fallback).
 * Profile identity → GrapheneOS userId (always stable).
 *
 * See: docs/superpowers/specs/2026-05-24-multi-platform-sidebar-design.md
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { ipcMain, shell } = require('electron')
const cp = require('../lib/content-paths')
const client = require('../lib/schedule-client')
const { appAuthFetch, SESSION_EXPIRED_MESSAGE } = require('../lib/app-auth-fetch')

let _executeADB = null
let _getTailscaleStatus = null
let _userDataPath = null
let _contentRoot = null
let _getSessionToken = null

// 2.16.49: file_kind maps to the on-disk folder + filename templates.
// Used by Supabase sync to know which default file we're talking about.
const FILE_KIND_MAP = {
    captions:       { folder: 'captions',       file: 'captions.txt' },
    comments:       { folder: 'comments',       file: 'comments.txt' },
    story_captions: { folder: 'story_captions', file: 'story_captions.txt' },
}

// Active file watchers — keyed by absolute filePath. Push to Supabase on
// debounced 'change' events so VAs on other devices see the latest content.
const _watchers = new Map()
const _watchContext = new Map()
const _pushTimers = new Map()

function init({ executeADB, getTailscaleStatus, userDataPath, contentRoot, getSessionToken }) {
    _executeADB = executeADB
    _getTailscaleStatus = getTailscaleStatus
    _userDataPath = userDataPath
    _contentRoot = contentRoot
    _getSessionToken = getSessionToken || (() => null)

    ipcMain.handle('sidebar:get-state', getStateHandler)
    ipcMain.handle('sidebar:set-active-platform', setActivePlatformHandler)
    ipcMain.handle('sidebar:set-active-account', setActiveAccountHandler)
    ipcMain.handle('sidebar:create-account', createAccountHandler)
    ipcMain.handle('sidebar:open-folder', openFolderHandler)
    ipcMain.handle('sidebar:open-defaults', openDefaultsHandler)
    // 2.16.33: per-account defaults picker
    ipcMain.handle('sidebar:list-defaults', listDefaultsHandler)
    ipcMain.handle('sidebar:open-default-file', openDefaultFileHandler)
    // 2.16.53: one-shot bulk pull-from-cloud
    ipcMain.handle('sidebar:bulk-sync-from-cloud', bulkSyncFromCloudHandler)
    ipcMain.handle('sidebar:bulk-sync-preview', bulkSyncPreviewHandler)
    console.log('[sidebar-content] 10 IPC handlers registered')
}

// Human labels for each default file. Falls back to filename if missing.
const DEFAULT_LABELS = {
    'captions.txt':       'Post Captions',
    'comments.txt':       'Comments Pool',
    'story_captions.txt': 'Story Captions',
}

// 2.16.55: cache resolved contexts for 30s. Most IPCs in a session keep
// hitting the same (serial,userId) — no need to re-shell adb + tailscale
// for every single click. Cuts platform-pill switches from ~2s to <50ms.
const _ctxCache = new Map() // key: serial::userId → { ctx, expiresAt }
const CTX_TTL_MS = 30_000
const TAILNET_IPV4_RE = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/

// Resolve a (serial, userId) → { phoneId, phoneFolder, profileFolder, profileName }.
// phoneId is the canonical key for sidebar-state.json.
async function _resolveContext(serial, userId) {
    const k = `${serial}::${userId}`
    const hit = _ctxCache.get(k)
    if (hit && hit.expiresAt > Date.now()) return hit.ctx

    const ip = String(serial || '').split(':')[0]
    const tailnetIp = TAILNET_IPV4_RE.test(ip) ? ip : null
    let machineId = null
    let peerName = null
    try {
        const ts = await _getTailscaleStatus()
        const peer = (ts?.peers || []).find(p => p.ip === ip)
        if (peer) { machineId = peer.id || null; peerName = peer.name || null }
    } catch (_) {}

    const phoneId = machineId || serial

    // ro.serialno is the phone's STABLE identity across USB/tailnet + rotated
    // ports; pass it so the Content folder is keyed by it (not the volatile
    // machineId/ip:port), preventing duplicate phone folders on reconnect.
    let hwSerial = null
    try {
        const out = await _executeADB(['-s', serial, 'shell', 'getprop', 'ro.serialno'], 4000)
        const v = String(out || '').trim()
        if (v && v.toLowerCase() !== 'null') hwSerial = v
    } catch (_) {}

    let profileName = null
    try {
        const raw = await _executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'], 4000)
        const m = String(raw || '').match(new RegExp(`UserInfo\\{${userId}:([^:]+):`))
        if (m) profileName = m[1].trim()
    } catch (_) {}
    if (!profileName || profileName.toLowerCase() === 'null') {
        profileName = userId === '0' ? 'Owner' : `user_${userId}`
    }

    const phone = cp.resolvePhoneFolder({ id: phoneId, tailnetIp, peerName, hwSerial }, _contentRoot)
    const prof = cp.resolveProfileFolder(phone.folderPath, { profileId: userId, profileName })
    const ctx = { phoneId, phoneFolder: phone.folderPath, profileFolder: prof.folderPath, profileName, hwSerial }
    _ctxCache.set(k, { ctx, expiresAt: Date.now() + CTX_TTL_MS })
    return ctx
}

function _credentialPersistenceError(message, secrets) {
    let safe = String(message || 'secure credential save failed')
    for (const secret of secrets) {
        if (secret) safe = safe.split(String(secret)).join('[redacted]')
    }
    // Defence in depth for the 2026-07-25 incident: a raw 401 body from the
    // Next.js API is the single word "Unauthorized", which reached the operator
    // verbatim and killed a paid run with no idea what to do. appAuthFetch now
    // throws an actionable AuthExpiredError instead, but a future direct fetch
    // must not be able to regress the bare word back into the toolbar.
    if (/^\s*unauthorized\s*$/i.test(safe)) safe = SESSION_EXPIRED_MESSAGE
    return safe.slice(0, 180)
}

async function _persistCreatedInstagramAccount({
    token,
    serial,
    hwSerial,
    userId,
    profileName,
    accountName,
    password,
    credentialReservationId,
    preflightOnly = false,
    fetchImpl = globalThis.fetch,
    appUrl = client.APP_URL,
}) {
    const secrets = [password, token]
    const fail = (message) => ({
        ok: false,
        ...(preflightOnly
            ? { credentialPersistenceReady: false }
            : { credentialsPersisted: false }),
        error: _credentialPersistenceError(message, secrets),
    })

    if (!token) return fail('Sign in before saving account credentials')
    if (!preflightOnly && (!accountName || !String(accountName).trim())) return fail('Account username is required')
    if (!password || typeof password !== 'string') return fail('Account password is required')
    if (typeof fetchImpl !== 'function') return fail('Secure credential service is unavailable')

    const baseUrl = String(appUrl || '').replace(/\/$/, '')
    const headers = { 'Content-Type': 'application/json' }
    // appAuthFetch mints a LIVE Clerk JWT per request and retries once on a 401.
    // `token` stays as the signed-out gate above and as the uninitialized
    // fallback (unit tests / handler loaded outside the main process).
    const authFetch = (url, init) => appAuthFetch(url, init, { fetchImpl, fallbackToken: token })

    try {
        const devicesResponse = await authFetch(`${baseUrl}/api/accounts`, { method: 'GET', headers })
        let devicesJson = null
        try { devicesJson = await devicesResponse.json() } catch (_) {}
        if (!devicesResponse.ok) return fail(devicesJson?.error || `Device lookup failed (HTTP ${devicesResponse.status})`)

        const identities = new Set([serial, hwSerial].filter(Boolean).map(value => String(value)))
        const device = (devicesJson?.devices || []).find(row =>
            identities.has(String(row?.serial || '')) || identities.has(String(row?.hw_serial || ''))
        )
        if (!device) return fail('Connected phone is not registered to this account')

        let profile = (device.profiles || []).find(row => String(row?.profile_id) === String(userId))
        if (!profile && preflightOnly && /^\d+$/.test(String(userId))) {
            const registrationResponse = await authFetch(`${baseUrl}/api/devices/profiles`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    device_id: device.id,
                    profile_id: String(userId),
                    name: profileName || `Profile ${userId}`,
                    is_current: true,
                }),
            })
            let registration = null
            try { registration = await registrationResponse.json() } catch (_) {}
            if (!registrationResponse.ok) {
                return fail(registration?.error || `Profile registration failed (HTTP ${registrationResponse.status})`)
            }
            const registered = registration?.data
            if (!registered?.id || registered.device_id !== device.id || String(registered.profile_id) !== String(userId)) {
                return fail('Exact phone profile registration was not confirmed')
            }
            profile = registered
        }
        if (!profile) return fail(`Android profile ${userId} is not registered on the connected phone`)

        const resolvedProfileName = profileName || profile.name || `Profile ${userId}`
        const body = {
            password,
            profile_name: resolvedProfileName,
            phone_profile_id: String(userId),
            phone_profile_name: resolvedProfileName,
            device_id: device.id,
            profile_id: profile.id,
            ig_enabled: true,
        }
        if (preflightOnly) body.credential_persistence_preflight = true
        else {
            body.username = String(accountName).trim().replace(/^@/, '')
            if (credentialReservationId) body.credential_reservation_id = credentialReservationId
        }
        const saveResponse = await authFetch(`${baseUrl}/api/accounts`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        })
        let saveJson = null
        try { saveJson = await saveResponse.json() } catch (_) {}
        if (!saveResponse.ok || saveJson?.success === false) {
            return fail(saveJson?.error || `Credential save failed (HTTP ${saveResponse.status})`)
        }
        if (preflightOnly) {
            if (
                saveJson?.credentialPersistenceReady !== true
                || typeof saveJson?.credentialReservationId !== 'string'
                || !saveJson.credentialReservationId
            ) {
                return fail('Secure credential service did not confirm durable reservation')
            }
            return {
                ok: true,
                credentialPersistenceReady: true,
                credentialReservationId: saveJson.credentialReservationId,
            }
        }
        if (saveJson?.success !== true || !saveJson?.data?.id) {
            return fail('Secure credential service did not confirm the inserted account')
        }
        return { ok: true, credentialsPersisted: true, accountId: saveJson.data.id }
    } catch (e) {
        return fail(e?.message || e)
    }
}

async function _preflightInstagramCredentialPersistence({ serial, userId, password }) {
    try {
        const ctx = await _resolveContext(serial, String(userId))
        return _persistCreatedInstagramAccount({
            token: _getSessionToken?.(),
            serial,
            hwSerial: ctx.hwSerial,
            userId: String(userId),
            profileName: ctx.profileName,
            password,
            preflightOnly: true,
        })
    } catch (e) {
        return {
            ok: false,
            credentialPersistenceReady: false,
            error: _credentialPersistenceError(e?.message, [password]),
        }
    }
}

async function _releaseInstagramCredentialReservation(credentialReservationId, { fetchImpl = globalThis.fetch } = {}) {
    const token = _getSessionToken?.()
    if (!token || !credentialReservationId) {
        return { ok: false, credentialReservationReleased: false, error: 'Credential reservation release is unavailable' }
    }
    try {
        const response = await appAuthFetch(`${String(client.APP_URL || '').replace(/\/$/, '')}/api/accounts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                credential_persistence_release: true,
                credential_reservation_id: credentialReservationId,
            }),
        }, { fetchImpl, fallbackToken: token })
        let payload = null
        try { payload = await response.json() } catch (_) {}
        if (!response.ok || payload?.credentialReservationReleased !== true) {
            return { ok: false, credentialReservationReleased: false, error: payload?.error || 'Credential reservation release was not confirmed' }
        }
        return { ok: true, credentialReservationReleased: true }
    } catch (e) {
        return { ok: false, credentialReservationReleased: false, error: String(e?.message || e).slice(0, 160) }
    }
}

// Invalidate the cache when something that changes the resolved context
// happens (profile rename, switch user, etc).
function _invalidateContextCache(serial, userId) {
    if (serial && userId) _ctxCache.delete(`${serial}::${userId}`)
    else _ctxCache.clear()
}

async function getStateHandler(_evt, { serial, userId }) {
    try {
        const uid = String(userId)
        const ctx = await _resolveContext(serial, uid)
        const state = cp.readSidebarState(_userDataPath)
        const profState = cp.ensureProfileState(state, ctx.phoneId, uid)

        // Update phone-level meta breadcrumbs.
        state.phones[ctx.phoneId].lastDisplayName = path.basename(ctx.phoneFolder)
        const ip = String(serial).split(':')[0]
        const tailnetIp = TAILNET_IPV4_RE.test(ip) ? ip : null
        if (tailnetIp) state.phones[ctx.phoneId].lastTailnetIp = tailnetIp

        // 2.16.52: pull remote phone + profile state. Apply active selection
        // from remote so VA B picks up where VA A left off. Push current
        // local state up so the other side can do the same.
        const tokenForState = _getSessionToken?.()
        if (tokenForState) {
            const remote = await client.pullSidebarState({
                phone_id: ctx.phoneId, profile_user_id: uid,
            }, tokenForState)
            if (remote?.profile) {
                if (remote.profile.active_platform) {
                    profState.activePlatform = remote.profile.active_platform
                }
                if (remote.profile.active_accounts && typeof remote.profile.active_accounts === 'object') {
                    for (const [plat, acc] of Object.entries(remote.profile.active_accounts)) {
                        if (profState.platforms[plat]) {
                            profState.platforms[plat].activeAccount = acc || null
                        }
                    }
                }
            }
            // Push current snapshot back (fire-and-forget)
            client.pushSidebarState({
                phone: {
                    phone_id: ctx.phoneId,
                    display_name: path.basename(ctx.phoneFolder),
                    tailnet_ip: tailnetIp,
                },
                profile: {
                    phone_id: ctx.phoneId,
                    profile_user_id: uid,
                    profile_name: ctx.profileName,
                    active_platform: profState.activePlatform,
                    active_accounts: _activeAccountsSnapshot(profState),
                },
            }, tokenForState).catch(() => {})
        }

        // 2.16.50: SUPABASE merge for the account list per platform.
        // Disk has what THIS device knows; Supabase has what ALL VAs know.
        // Scaffold any remote-only accounts locally so they appear in the
        // picker; push any local-only accounts up so other VAs see them.
        const token = _getSessionToken?.()
        for (const platform of cp.SUPPORTED_PLATFORMS) {
            const disk = cp.listAccountFolders(ctx.profileFolder, platform)
            const diskSet = new Set(disk.map(a => a.toLowerCase()))
            let merged = [...disk]

            if (token) {
                const remote = await client.listSidebarAccounts({
                    phone_id: ctx.phoneId, profile_user_id: uid, platform,
                }, token)
                // Scaffold local folders for remote-only accounts
                for (const rRow of remote) {
                    const acc = String(rRow.account || '').toLowerCase()
                    if (!acc) continue
                    if (!diskSet.has(acc)) {
                        try {
                            cp.ensureAccountScaffold(ctx.profileFolder, platform, acc, _contentRoot)
                            merged.push(acc)
                            diskSet.add(acc)
                        } catch (_) {}
                    }
                }
                // Push local-only accounts up so other devices see them
                const remoteSet = new Set(remote.map(r => String(r.account || '').toLowerCase()))
                for (const acc of disk) {
                    if (!remoteSet.has(acc.toLowerCase())) {
                        client.registerSidebarAccount({
                            phone_id: ctx.phoneId,
                            profile_user_id: uid,
                            platform,
                            account: acc,
                            display_name: acc,
                        }, token).catch(() => {})
                    }
                }
            }

            // Re-list disk after scaffold + dedupe
            merged = Array.from(new Set(merged.map(a => a.toLowerCase()))).sort()
            profState.platforms[platform].accounts = merged
            const active = profState.platforms[platform].activeAccount
            if (active && !merged.includes(active)) profState.platforms[platform].activeAccount = null
            if (!profState.platforms[platform].activeAccount && merged.length) {
                profState.platforms[platform].activeAccount = merged[0]
            }
        }

        cp.writeSidebarState(_userDataPath, state)

        return {
            ok: true,
            phoneId: ctx.phoneId,
            phoneDisplayName: path.basename(ctx.phoneFolder),
            profileName: ctx.profileName,
            activePlatform: profState.activePlatform,
            platforms: profState.platforms,
            legacyAccounts: cp.scanLegacyAccounts(_contentRoot),
        }
    } catch (e) { return { ok: false, error: e.message } }
}

async function setActivePlatformHandler(_evt, { serial, userId, platform }) {
    if (!cp.SUPPORTED_PLATFORMS.includes(platform)) return { ok: false, error: `bad platform: ${platform}` }
    // 2.16.55: return ok IMMEDIATELY, do all I/O async. The toolbar already
    // updated its UI optimistically — we just need to persist.
    setImmediate(async () => {
        try {
            const uid = String(userId)
            const ctx = await _resolveContext(serial, uid)
            const state = cp.readSidebarState(_userDataPath)
            const ps = cp.ensureProfileState(state, ctx.phoneId, uid)
            ps.activePlatform = platform
            cp.writeSidebarState(_userDataPath, state)
            const token = _getSessionToken?.()
            if (token) {
                client.pushSidebarState({
                    phone: null,
                    profile: {
                        phone_id: ctx.phoneId, profile_user_id: uid, profile_name: ctx.profileName,
                        active_platform: platform, active_accounts: _activeAccountsSnapshot(ps),
                    },
                }, token).catch(() => {})
            }
        } catch (e) { console.warn('[setActivePlatform] persist failed:', e?.message || e) }
    })
    return { ok: true }
}

async function setActiveAccountHandler(_evt, { serial, userId, platform, account }) {
    if (!cp.SUPPORTED_PLATFORMS.includes(platform)) return { ok: false, error: `bad platform: ${platform}` }
    try {
        const uid = String(userId)
        const ctx = await _resolveContext(serial, uid)
        const state = cp.readSidebarState(_userDataPath)
        const ps = cp.ensureProfileState(state, ctx.phoneId, uid)
        ps.platforms[platform].activeAccount = account || null
        cp.writeSidebarState(_userDataPath, state)
        // 2.16.52: mirror to Supabase
        const token = _getSessionToken?.()
        if (token) {
            client.pushSidebarState({
                phone: null,
                profile: {
                    phone_id: ctx.phoneId, profile_user_id: uid, profile_name: ctx.profileName,
                    active_platform: ps.activePlatform, active_accounts: _activeAccountsSnapshot(ps),
                },
            }, token).catch(() => {})
        }
        return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
}

function _activeAccountsSnapshot(profState) {
    const out = {}
    for (const [plat, p] of Object.entries(profState.platforms || {})) {
        out[plat] = p?.activeAccount || null
    }
    return out
}

async function createAccountHandler(_evt, {
    serial,
    userId,
    platform,
    accountName,
    openFolder = true,
    password,
    credentialReservationId,
    persistCredentials = false,
}) {
    console.log(`[sidebar:create-account] CALL serial=${serial} userId=${userId} platform=${platform} accountName=${accountName}`)
    if (!cp.SUPPORTED_PLATFORMS.includes(platform)) {
        console.warn('[sidebar:create-account] REJECT bad platform:', platform)
        return { ok: false, error: `bad platform: ${platform}` }
    }
    let credentialsPersisted = false
    try {
        const ctx = await _resolveContext(serial, String(userId))
        console.log(`[sidebar:create-account] ctx ok phoneId=${ctx.phoneId} profileFolder=${ctx.profileFolder}`)
        if (persistCredentials) {
            if (platform !== 'instagram') {
                return { ok: false, accountCreated: true, credentialsPersisted: false, error: 'Credential persistence is only available for Instagram accounts' }
            }
            const persisted = await _persistCreatedInstagramAccount({
                token: _getSessionToken?.(),
                serial,
                hwSerial: ctx.hwSerial,
                userId: String(userId),
                profileName: ctx.profileName,
                accountName,
                password,
                credentialReservationId,
            })
            if (!persisted.ok) return { ...persisted, accountCreated: true }
            credentialsPersisted = true
        }
        const res = cp.ensureAccountScaffold(ctx.profileFolder, platform, accountName, _contentRoot)
        console.log(`[sidebar:create-account] scaffold result:`, JSON.stringify(res))
        if (!res.ok) {
            return persistCredentials
                ? { ...res, accountCreated: true, credentialsPersisted: true }
                : res
        }
        const key = path.basename(res.path)
        const state = cp.readSidebarState(_userDataPath)
        const profState = cp.ensureProfileState(state, ctx.phoneId, String(userId))
        const list = profState.platforms[platform].accounts
        if (!list.includes(key)) list.push(key)
        profState.platforms[platform].activeAccount = key
        cp.writeSidebarState(_userDataPath, state)

        // 2.16.50: register with Supabase so other VAs see this account
        const token = _getSessionToken?.()
        if (token) {
            client.registerSidebarAccount({
                phone_id: ctx.phoneId,
                profile_user_id: String(userId),
                platform,
                account: key,
                display_name: accountName,
            }, token).catch(() => {})
        }

        if (openFolder) shell.openPath(res.path)   // bulk passes openFolder:false to avoid N popups
        console.log(`[sidebar:create-account] SUCCESS path=${res.path}`)
        return {
            ok: true,
            path: res.path,
            account: key,
            ...(persistCredentials ? { accountCreated: true, credentialsPersisted: true } : {}),
        }
    } catch (e) {
        const error = persistCredentials
            ? _credentialPersistenceError(e?.message, [password])
            : String(e?.message || e)
        console.error('[sidebar:create-account] THROW:', error)
        return {
            ok: false,
            error,
            ...(persistCredentials ? { accountCreated: true, credentialsPersisted } : {}),
        }
    }
}

function resolveAccountFolder(root, account) {
    const name = String(account || '').trim()
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return null
    const resolvedRoot = path.resolve(root)
    const resolved = path.resolve(resolvedRoot, name)
    return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null
}

async function openFolderHandler(_evt, { serial, userId, platform, account, legacy }) {
    try {
        if (!cp.SUPPORTED_PLATFORMS.includes(platform)) return { ok: false, error: `bad platform: ${platform}` }
        if (legacy) {
            const flat = resolveAccountFolder(path.resolve(_contentRoot, platform), account)
            if (!flat) return { ok: false, error: 'invalid account folder' }
            if (!fs.existsSync(flat)) return { ok: false, error: 'legacy folder gone' }
            shell.openPath(flat)
            return { ok: true, path: flat, legacy: true }
        }
        const ctx = await _resolveContext(serial, String(userId))
        const state = cp.readSidebarState(_userDataPath)
        const profState = cp.ensureProfileState(state, ctx.phoneId, String(userId))
        const acc = account || profState.platforms[platform]?.activeAccount
        if (!acc) return { ok: false, error: 'no account selected — create one first' }
        // Prefer the nested folder when it already exists; else fall back to the
        // flat legacy layout (Content/<platform>/<account>) when THAT has a real
        // dir — so accounts whose content lives flat (e.g. eileenswrld) open their
        // actual content instead of a freshly-created empty nested folder. Only
        // create+open the nested folder when neither layout exists yet (brand-new).
        const nested = resolveAccountFolder(path.resolve(ctx.profileFolder, platform), acc)
        if (!nested) return { ok: false, error: 'invalid account folder' }
        if (fs.existsSync(nested)) {
            shell.openPath(nested)
            return { ok: true, path: nested, account: acc }
        }
        const flat = resolveAccountFolder(path.resolve(_contentRoot, platform), String(acc).toLowerCase())
        if (!flat) return { ok: false, error: 'invalid account folder' }
        if (fs.existsSync(flat)) {
            shell.openPath(flat)
            return { ok: true, path: flat, account: acc, legacy: true }
        }
        fs.mkdirSync(nested, { recursive: true })
        shell.openPath(nested)
        return { ok: true, path: nested, account: acc }
    } catch (e) { return { ok: false, error: e.message } }
}

async function openDefaultsHandler() {
    try {
        const folder = path.join(_contentRoot, '_defaults')
        fs.mkdirSync(folder, { recursive: true })
        shell.openPath(folder)
        return { ok: true, path: folder }
    } catch (e) { return { ok: false, error: e.message } }
}

// 2.16.33: list editable per-account defaults for the active platform.
// 2.16.49: SUPABASE-FIRST sync — pull remote, write to local file if remote
// is newer; if local file is newer (or remote missing), push local up.
async function listDefaultsHandler(_evt, { serial, userId, platform, account }) {
    if (!cp.SUPPORTED_PLATFORMS.includes(platform)) return { ok: false, error: `bad platform: ${platform}` }
    try {
        const ctx = await _resolveContext(serial, String(userId))
        const state = cp.readSidebarState(_userDataPath)
        const profState = cp.ensureProfileState(state, ctx.phoneId, String(userId))
        const acc = account || profState.platforms[platform]?.activeAccount
        if (!acc) return { ok: false, error: 'no-account' }

        const accountPath = path.join(ctx.profileFolder, platform, acc)
        if (!fs.existsSync(accountPath)) return { ok: false, error: 'account folder missing — create it first' }

        const templates = cp.PLATFORM_DEFAULT_FILES[platform] || {}
        const token = _getSessionToken?.()
        const items = []
        for (const [folder, file] of Object.entries(templates)) {
            const filePath = path.join(accountPath, folder, file)
            // file_kind = folder name (captions/comments/story_captions)
            const file_kind = folder
            await _syncDefaultFile({
                ctx, serial, userId: String(userId), platform, account: acc,
                file_kind, filePath, token,
            })
            items.push({
                key: folder,
                label: DEFAULT_LABELS[file] || file,
                file,
                folder,
                filePath,
                exists: fs.existsSync(filePath),
                synced: !!token,
            })
        }
        return { ok: true, account: acc, accountPath, items, synced: !!token }
    } catch (e) { return { ok: false, error: e.message } }
}

// Two-way reconcile for a single default file. Local file = cache; Supabase = truth
// when newer. Writes one direction or the other based on timestamps.
async function _syncDefaultFile({ ctx, serial, userId, platform, account, file_kind, filePath, token }) {
    if (!token) return
    if (!FILE_KIND_MAP[file_kind]) return
    try {
        const remote = await client.pullSidebarDefault({
            phone_id: ctx.phoneId, profile_user_id: userId, platform, account, file_kind,
        }, token)
        const localExists = fs.existsSync(filePath)
        const localMtime = localExists ? fs.statSync(filePath).mtime : null
        const localContent = localExists ? fs.readFileSync(filePath, 'utf8') : ''
        const remoteTime = remote?.updated_at ? new Date(remote.updated_at) : null

        if (remote && remoteTime && (!localMtime || remoteTime > localMtime)) {
            // Remote is newer → write to local file
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, remote.content || '', 'utf8')
            return { direction: 'pulled' }
        }
        if (localExists && (!remote || (localMtime && remoteTime && localMtime > remoteTime))) {
            // Local is newer → push to Supabase
            await client.pushSidebarDefault({
                phone_id: ctx.phoneId, profile_user_id: userId, platform, account, file_kind,
                content: localContent,
            }, token)
            return { direction: 'pushed' }
        }
    } catch (e) {
        console.warn('[sidebar:defaults sync] failed:', e?.message || e)
    }
}

async function openDefaultFileHandler(_evt, { filePath, serial, userId, platform, account, file_kind }) {
    try {
        if (!filePath) return { ok: false, error: 'no path' }
        const resolved = path.resolve(filePath)
        if (!resolved.startsWith(path.resolve(_contentRoot) + path.sep)) {
            return { ok: false, error: 'path outside content root' }
        }
        // Make sure the file exists before opening (sync may have just created it).
        if (!fs.existsSync(resolved)) {
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            fs.writeFileSync(resolved, '', 'utf8')
        }
        shell.openPath(resolved)

        // 2.16.49: install a debounced watcher that pushes content to
        // Supabase whenever Notepad/editor saves the file. Cleared 5min after
        // open so we don't leak watchers forever.
        if (serial && userId && platform && account && file_kind) {
            _installDefaultsWatcher({ resolved, serial, userId: String(userId), platform, account, file_kind })
        }
        return { ok: true, path: resolved }
    } catch (e) { return { ok: false, error: e.message } }
}

function _installDefaultsWatcher({ resolved, serial, userId, platform, account, file_kind }) {
    // Close existing watcher for this file
    if (_watchers.has(resolved)) {
        try { _watchers.get(resolved).close() } catch (_) {}
        _watchers.delete(resolved)
        if (_pushTimers.has(resolved)) { clearTimeout(_pushTimers.get(resolved)); _pushTimers.delete(resolved) }
    }
    _watchContext.set(resolved, { serial, userId, platform, account, file_kind })
    try {
        const w = fs.watch(resolved, { persistent: false }, () => {
            // Debounce — Notepad emits multiple events on save
            if (_pushTimers.has(resolved)) clearTimeout(_pushTimers.get(resolved))
            _pushTimers.set(resolved, setTimeout(() => _pushWatchedFile(resolved), 1200))
        })
        _watchers.set(resolved, w)

        // Auto-cleanup after 5 minutes of being open
        setTimeout(() => {
            if (_watchers.has(resolved)) {
                try { _watchers.get(resolved).close() } catch (_) {}
                _watchers.delete(resolved)
                _watchContext.delete(resolved)
            }
        }, 5 * 60 * 1000)
    } catch (e) {
        console.warn('[sidebar:defaults watch] failed:', e?.message || e)
    }
}

async function _pushWatchedFile(resolved) {
    const wctx = _watchContext.get(resolved)
    const token = _getSessionToken?.()
    if (!wctx || !token) return
    try {
        if (!fs.existsSync(resolved)) return
        const content = fs.readFileSync(resolved, 'utf8')
        const ctx = await _resolveContext(wctx.serial, wctx.userId)
        await client.pushSidebarDefault({
            phone_id: ctx.phoneId,
            profile_user_id: wctx.userId,
            platform: wctx.platform,
            account: wctx.account,
            file_kind: wctx.file_kind,
            content,
        }, token)
        console.log(`[sidebar:defaults] pushed ${wctx.file_kind} for ${wctx.account} (${content.length}b)`)
    } catch (e) {
        console.warn('[sidebar:defaults push] failed:', e?.message || e)
    }
}

// 2.16.53: preview what cloud has so we can prompt with concrete numbers
// before doing anything destructive.
async function bulkSyncPreviewHandler() {
    const token = _getSessionToken?.()
    if (!token) return { ok: false, error: 'not-signed-in' }
    try {
        const data = await client.bulkExportSidebar(token)
        if (!data) return { ok: false, error: 'cloud fetch failed' }
        return {
            ok: true,
            counts: {
                phones: data.phones.length,
                profiles: data.profiles.length,
                accounts: data.accounts.length,
                defaults: data.defaults.length,
                schedules: data.schedules.length,
            },
        }
    } catch (e) { return { ok: false, error: e.message } }
}

// One-shot: pull everything from cloud and scaffold local folders +
// defaults files + cached schedules. Idempotent — won't overwrite local
// content, just creates missing skeleton.
async function bulkSyncFromCloudHandler() {
    const token = _getSessionToken?.()
    if (!token) return { ok: false, error: 'not-signed-in' }
    try {
        const data = await client.bulkExportSidebar(token)
        if (!data) return { ok: false, error: 'cloud fetch failed' }

        // Build phoneId → phone meta map for quick lookup
        const phonesById = {}
        for (const ph of data.phones) phonesById[ph.phone_id] = ph

        // Group profiles by phone
        const profilesByPhone = {}
        for (const pr of data.profiles) {
            (profilesByPhone[pr.phone_id] ||= []).push(pr)
        }

        // Scaffold phones + profiles. We use the existing content-paths helpers
        // which write _meta.json with stable IDs so future Tailscale ID resolves.
        for (const ph of data.phones) {
            try {
                cp.resolvePhoneFolder({
                    id: ph.phone_id,
                    tailnetIp: ph.tailnet_ip || null,
                    peerName: ph.display_name || null,
                }, _contentRoot)
            } catch (e) {
                console.warn('[bulk-sync] scaffold phone failed', ph.phone_id, e?.message)
            }
        }

        // Scaffold profiles per phone
        for (const [phoneId, profs] of Object.entries(profilesByPhone)) {
            const ph = phonesById[phoneId]
            if (!ph) continue
            const phoneFolder = cp.resolvePhoneFolder({
                id: phoneId, tailnetIp: ph.tailnet_ip, peerName: ph.display_name,
            }, _contentRoot).folderPath
            for (const pr of profs) {
                try {
                    cp.resolveProfileFolder(phoneFolder, {
                        profileId: pr.profile_user_id,
                        profileName: pr.profile_name || `user_${pr.profile_user_id}`,
                    })
                } catch (e) {
                    console.warn('[bulk-sync] scaffold profile failed', pr.profile_user_id, e?.message)
                }
            }
        }

        // Scaffold account folders per (phone, profile, platform, account)
        const accountKey = (a) => `${a.phone_id}::${a.profile_user_id}::${a.platform}::${a.account}`
        const seenAccounts = new Set()
        for (const a of data.accounts) {
            const key = accountKey(a)
            if (seenAccounts.has(key)) continue
            seenAccounts.add(key)
            try {
                const ph = phonesById[a.phone_id]
                if (!ph) continue
                const phoneFolder = cp.resolvePhoneFolder({
                    id: a.phone_id, tailnetIp: ph.tailnet_ip, peerName: ph.display_name,
                }, _contentRoot).folderPath
                const profMatch = (profilesByPhone[a.phone_id] || []).find(
                    p => String(p.profile_user_id) === String(a.profile_user_id)
                )
                const profFolder = cp.resolveProfileFolder(phoneFolder, {
                    profileId: a.profile_user_id,
                    profileName: profMatch?.profile_name || `user_${a.profile_user_id}`,
                }).folderPath
                cp.ensureAccountScaffold(profFolder, a.platform, a.account, _contentRoot)
            } catch (e) {
                console.warn('[bulk-sync] scaffold account failed', key, e?.message)
            }
        }

        // Write defaults content to local files
        let defaultsWritten = 0
        for (const d of data.defaults) {
            try {
                const ph = phonesById[d.phone_id]
                if (!ph) continue
                const phoneFolder = cp.resolvePhoneFolder({
                    id: d.phone_id, tailnetIp: ph.tailnet_ip, peerName: ph.display_name,
                }, _contentRoot).folderPath
                const profMatch = (profilesByPhone[d.phone_id] || []).find(
                    p => String(p.profile_user_id) === String(d.profile_user_id)
                )
                const profFolder = cp.resolveProfileFolder(phoneFolder, {
                    profileId: d.profile_user_id,
                    profileName: profMatch?.profile_name || `user_${d.profile_user_id}`,
                }).folderPath
                const fileKindMap = {
                    captions: 'captions.txt',
                    comments: 'comments.txt',
                    story_captions: 'story_captions.txt',
                }
                const fileName = fileKindMap[d.file_kind]
                if (!fileName) continue
                const targetDir = path.join(profFolder, d.platform, d.account, d.file_kind)
                fs.mkdirSync(targetDir, { recursive: true })
                const targetFile = path.join(targetDir, fileName)
                // Only write if local file is missing or older
                const localMtime = fs.existsSync(targetFile) ? fs.statSync(targetFile).mtime : null
                const remoteMtime = d.updated_at ? new Date(d.updated_at) : null
                if (!localMtime || (remoteMtime && remoteMtime > localMtime)) {
                    fs.writeFileSync(targetFile, d.content || '', 'utf8')
                    defaultsWritten++
                }
            } catch (e) {
                console.warn('[bulk-sync] defaults write failed', d.file_kind, e?.message)
            }
        }

        // Cache schedules locally so the toolbar shows them immediately
        const localStore = (() => {
            try {
                const p = path.join(_userDataPath, 'sidebar-schedules.json')
                if (!fs.existsSync(p)) return {}
                return JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
            } catch (_) { return {} }
        })()
        let schedCached = 0
        for (const s of data.schedules) {
            const k = `${s.phone_id}::${s.profile_user_id}::${s.platform}::${String(s.account).toLowerCase()}`
            localStore[k] = {
                id: s.id, account_id: s.account, is_active: s.is_active,
                slots: s.slots, disabled_steps: s.disabled_steps,
                randomize_minutes: s.randomize_minutes, repeat_pattern: s.repeat_pattern,
                repeat_days: s.repeat_days, content_mode: s.content_mode,
                skip_posting_if_flagged: s.skip_posting_if_flagged,
                updated_at: s.updated_at,
            }
            schedCached++
        }
        try {
            fs.writeFileSync(
                path.join(_userDataPath, 'sidebar-schedules.json'),
                JSON.stringify(localStore, null, 2), 'utf8'
            )
        } catch (e) { console.warn('[bulk-sync] schedule cache write failed:', e?.message) }

        return {
            ok: true,
            counts: {
                phones: data.phones.length,
                profiles: data.profiles.length,
                accounts: data.accounts.length,
                defaultsWritten,
                schedules: schedCached,
            },
        }
    } catch (e) {
        console.error('[bulk-sync] FATAL:', e?.message || e, e?.stack || '')
        return { ok: false, error: e.message }
    }
}

// 2.16.53: expose bulk handlers directly so the tray menu can invoke them
// in-process (no fake IPC event needed).
module.exports = {
    init,
    _bulkSyncPreview: () => bulkSyncPreviewHandler(),
    _bulkSyncFromCloud: () => bulkSyncFromCloudHandler(),
    // exported for model-handlers' registerModelHandlers({ resolveContext }) wiring
    _resolveContext,
    _openFolder: input => openFolderHandler(null, input),
    // exported so bulk account creation can scaffold a created account's on-disk
    // folder (openFolder:false) without going through a renderer IPC round-trip.
    createAccountHandler,
    _persistCreatedInstagramAccount,
    _preflightInstagramCredentialPersistence,
    _releaseInstagramCredentialReservation,
}
