/**
 * model-handlers.js — Models Dashboard registry, content counts, and model
 * grouping for the LOCAL_ONLY models-dashboard.html window.
 *
 * Registry build reconciles four sources of truth into one persisted file:
 *   1. live GrapheneOS profiles      (get-device-profiles via deps.invokeProfiles)
 *   2. on-disk account folders       (content-paths.listAccountFolders)
 *   3. per-account content counts    (lib/content-counter)
 *   4. schedule is_active            (sidebar-schedules.json, accountKey)
 *
 * Persisted to %APPDATA%/shadowphone-desktop/fleet-registry.json (atomic write).
 * See: docs/superpowers/specs/2026-05-30-models-dashboard-design.md
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { BrowserWindow } = require('electron')
const cp = require('../lib/content-paths')
const counter = require('../lib/content-counter')
const { reconcileRegistryDevices, enumerateRegistryAccounts } = require('../lib/registry-reconcile')

/**
 * modelOf(profileName) — group display key for a profile.
 * Strip a single trailing _<alphanumerics> group if present (case-insensitive
 * on the separator), else return the whole name. Original casing is preserved
 * for display. Belle->Belle, Kayleigh_3->Kayleigh, Lillie_alt->Lillie.
 */
function modelOf(name) {
    const s = String(name == null ? '' : name)
    // \w includes underscore, so [A-Za-z0-9] keeps the group "alphanumeric only".
    // Anchored at end; greedy prefix consumes earlier underscores so only the
    // LAST group is stripped (Anna_Marie_2 -> Anna_Marie). A trailing group that
    // is a Capitalized word ([A-Z][a-z]+, e.g. Marie/Jane) reads as a second
    // name token, not a variant suffix, so it is KEPT (Anna_Marie -> Anna_Marie),
    // while variant suffixes (_3/_alt/_ALT/_v2/_backup) are stripped.
    const m = s.match(/^(.+)_([A-Za-z0-9]+)$/)
    if (!m) return s
    if (/^[A-Z][a-z]+$/.test(m[2])) return s
    return m[1]
}

// ── registry persistence (atomic, UTF-8 no BOM) ──────────────────────────────

let _lastKnownRegistry = null
let _userDataPath = null
let _contentRoot = null
let _resolveContext = null
let _getConnectedDevices = null
let _invokeProfiles = null
let _getMainWindow = null
let _registryBuild = null

function _registryPath() {
    return path.join(_userDataPath, 'fleet-registry.json')
}

function _readRegistry() {
    const p = _registryPath()
    if (!fs.existsSync(p)) return { version: 1, scannedAt: null, devices: {} }

    const ATTEMPTS = 3
    const DELAYS   = [0, 150, 300]
    let lastRaw = null
    let lastErr = null

    for (let i = 0; i < ATTEMPTS; i++) {
        if (DELAYS[i] > 0) {
            const end = Date.now() + DELAYS[i]
            while (Date.now() < end) {}   // busy-wait max 300 ms total across all retries
        }
        try {
            lastRaw = fs.readFileSync(p, 'utf8')
            if (!lastRaw || lastRaw.trim() === '') {
                lastErr = new Error('empty file')
                lastRaw = null
                continue
            }
            const parsed = JSON.parse(lastRaw)
            if (!parsed.devices || typeof parsed.devices !== 'object') parsed.devices = {}
            if (parsed.version == null) parsed.version = 1
            if (parsed.scannedAt === undefined) parsed.scannedAt = null
            _lastKnownRegistry = parsed
            return parsed
        } catch (e) {
            lastErr = e
            if (lastRaw !== null) break   // readFileSync succeeded, JSON.parse threw — genuine corruption, no point retrying
        }
    }

    // All retries failed.
    if (lastRaw && lastRaw.trim().length > 0) {
        // Non-empty, unparseable — genuine corruption; copy for forensics, preserve original
        const sidecar = `${p}.corrupt-${Date.now()}.json`
        console.error('[model-handlers] fleet-registry.json is corrupt after retries — copying to sidecar (original preserved):', lastErr && lastErr.message)
        try { fs.copyFileSync(p, sidecar) } catch (_) {}
    } else {
        // Transient I/O failure or empty file — do NOT quarantine
        console.warn('[model-handlers] fleet-registry.json could not be read (transient I/O) — using in-memory fallback:', lastErr && lastErr.message)
    }

    return _lastKnownRegistry || { version: 1, scannedAt: null, devices: {} }
}

// Atomic write: tmp + rename. JSON is ASCII-safe so fs.writeFileSync utf8 emits
// no BOM. The tmp lives in the same dir so the rename stays on one filesystem.
function _writeRegistry(reg) {
    const p = _registryPath()
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    _lastKnownRegistry = reg
    return true
}

// Path-accepting variants used by the scan sweep (models-dashboard-scan.js) and
// its phone-free test, which point the registry at an OS temp file. Same shape +
// atomic write as the module-level pair above, but with an explicit path so the
// sweep doesn't depend on registerModelHandlers having run.
function readRegistry(p) {
    if (!fs.existsSync(p)) return { version: 1, scannedAt: null, devices: {} }

    const ATTEMPTS = 3
    const DELAYS   = [0, 150, 300]
    let lastRaw = null
    let lastErr = null

    for (let i = 0; i < ATTEMPTS; i++) {
        if (DELAYS[i] > 0) {
            const end = Date.now() + DELAYS[i]
            while (Date.now() < end) {}
        }
        try {
            lastRaw = fs.readFileSync(p, 'utf8')
            if (!lastRaw || lastRaw.trim() === '') {
                lastErr = new Error('empty file')
                lastRaw = null
                continue
            }
            const parsed = JSON.parse(lastRaw)
            if (!parsed.devices || typeof parsed.devices !== 'object') parsed.devices = {}
            if (parsed.version == null) parsed.version = 1
            if (parsed.scannedAt === undefined) parsed.scannedAt = null
            return parsed
        } catch (e) {
            lastErr = e
            if (lastRaw !== null) break   // readFileSync succeeded, JSON.parse threw — genuine corruption, no point retrying
        }
    }

    // All retries failed.
    if (lastRaw && lastRaw.trim().length > 0) {
        const sidecar = `${p}.corrupt-${Date.now()}.json`
        console.error('[model-handlers] registry at', p, 'is corrupt after retries — copying to sidecar (original preserved):', lastErr && lastErr.message)
        try { fs.copyFileSync(p, sidecar) } catch (_) {}
    } else {
        console.warn('[model-handlers] registry at', p, 'could not be read (transient I/O):', lastErr && lastErr.message)
    }

    return { version: 1, scannedAt: null, devices: {} }
}

function writeRegistry(p, reg) {
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    return true
}

// Read sidebar-schedules.json once per registry build and index is_active by
// accountKey (SHARED CONTRACT: serial::userId::instagram::account, lowercased).
function _readScheduleActiveMap() {
    const map = {}
    try {
        const p = path.join(_userDataPath, 'sidebar-schedules.json')
        if (!fs.existsSync(p)) return map
        const store = JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
        for (const [key, row] of Object.entries(store)) {
            map[key] = !!(row && row.is_active)
        }
    } catch (_) {}
    return map
}

function _accountKey(serial, userId, account) {
    return `${serial}::${userId}::instagram::${String(account || '').toLowerCase()}`
}

// Serial-agnostic schedule lookup. The dashboard builds the registry under the
// phone's USB serial, but sidebar-schedules.json rows were authored under the
// phone's tailnet serial — same physical phone, two identities. Match the
// is_active row by userId+account regardless of the serial prefix (account
// handles are globally unique so this can't collide across phones). Mirrors
// resolveScheduleKey in schedule-handlers.js: prefer a tailnet-prefixed row.
function _scheduleActiveFor(map, serial, userId, account) {
    const suffix = `::${userId}::instagram::${String(account || '').toLowerCase()}`
    const matches = Object.keys(map).filter(k => k.endsWith(suffix))
    if (!matches.length) return false
    const tailnet = matches.find(k => k.split('::')[0].includes(':'))
    const exact = _accountKey(serial, userId, account)
    const key = tailnet || (matches.includes(exact) ? exact : matches[0])
    return !!map[key]
}

/**
 * Build the live registry by reconciling profiles + folders + counts + schedule
 * for every connected device, merge OVER the persisted registry (so devices that
 * are offline this scan keep their last-known data), persist atomically, return.
 */
async function _buildRegistry() {
    const persisted = _readRegistry()
    const schedActive = _readScheduleActiveMap()
    const devices = await _getConnectedDevices()
    if (!Array.isArray(devices)) throw new Error('Phone connection discovery is unavailable. Retry when ADB is ready.')
    let profilesUnavailable = false

    // Collapse any persisted device keys that share a hwSerial with a live
    // phone into that phone's canonical serial, drop stale duplicate/rotated-
    // port keys, and prune long-unseen orphans — kills the "one phone shows as
    // several" ghosts (see lib/registry-reconcile). Idempotent each build.
    persisted.devices = reconcileRegistryDevices(persisted.devices || {}, devices, Date.now())

    for (const dev of (devices || [])) {
        const serial = dev.serial
        if (!serial || dev.status === 'unauthorized') continue

        const profRes = await _invokeProfiles(serial).catch(() => null)
        if (!profRes?.success || !Array.isArray(profRes.profiles) || profRes.profiles.length === 0) profilesUnavailable = true
        const profiles = (profRes && profRes.success && Array.isArray(profRes.profiles))
            ? profRes.profiles : []

        const devEntry = persisted.devices[serial] || { serial, profiles: {} }
        devEntry.serial = serial
        if (!devEntry.profiles || typeof devEntry.profiles !== 'object') devEntry.profiles = {}

        for (const prof of profiles) {
            const userId = String(prof.id)
            // Friendly label the dashboard groups by. get-device-profiles already
            // folds nickname → displayName; modelOf strips the _<n> account suffix.
            const profileName = prof.displayName || prof.name || prof.originalName || `user_${userId}`

            // Start from whatever was already persisted for this profile — e.g.
            // the IG accounts the scan sweep discovered — so a rebuild MERGES
            // rather than wipes, then layers on-disk folder accounts + fresh counts.
            const prevProfile = devEntry.profiles[userId] || {}
            const accounts = { ...(prevProfile.accounts || {}) }
            let ctx = null
            try {
                ctx = await _resolveContext(serial, userId)
                // Discover on-disk nested-layout accounts (counts computed below,
                // uniformly for scanned + on-disk handles).
                for (const handle of await cp.listAccountFoldersAsync(ctx.profileFolder, 'instagram')) {
                    if (!accounts[handle]) accounts[handle] = { handle, scheduleActive: false, counts: null }
                }
            } catch (_) {
                // Folder/context resolution failed — the persisted (scanned)
                // accounts are already in `accounts`, so nothing is lost; counts
                // fall back to the flat layout below.
            }
            // Refresh schedule state + counts for every account (scanned + on-disk).
            // Counts use the best-of resolver: the nested layout when it has media,
            // else the flat legacy Content/instagram/<handle> layout — so flat-only
            // accounts (e.g. eileenswrld) show real numbers instead of 0.
            // scheduleActive matches the engine's row by userId+account regardless
            // of which serial (USB vs tailnet) prefixed it.
            await Promise.all(Object.keys(accounts).map(async (handle) => {
                const a = accounts[handle]
                a.handle = a.handle || handle
                a.scheduleActive = _scheduleActiveFor(schedActive, serial, userId, handle)
                const nestedDir = ctx && ctx.profileFolder ? path.join(ctx.profileFolder, 'instagram', handle) : null
                a.counts = await counter.countBest(_contentRoot, nestedDir, handle)
            }))

            devEntry.profiles[userId] = {
                profileId: parseInt(userId, 10),
                name: profileName,
                model: modelOf(profileName),
                scannedAt: prevProfile.scannedAt || null,   // last SCAN time, not last build
                switchFailed: prevProfile.switchFailed || false,  // scan-authored; preserve across rebuilds
                accounts,
            }
        }

        persisted.devices[serial] = devEntry
    }

    if (profilesUnavailable && !Object.values(persisted.devices).some(device => Object.keys(device.profiles || {}).length)) {
        throw new Error('Phone profiles are unavailable. Retry when the phone connection is ready.')
    }
    persisted.version = 1
    persisted.scannedAt = new Date().toISOString()
    _writeRegistry(persisted)
    return persisted
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

async function _getRegistry() {
    const FALLBACK_MS = 10000
    const cached = () => {
        const registry = _readRegistry()
        const loading = !Object.values(registry.devices || {}).some(device => Object.keys(device.profiles || {}).length)
        return { ok: true, registry, stale: true, loading }
    }
    if (!_registryBuild) {
        const build = { promise: null, background: false }
        _registryBuild = build
        build.promise = _buildRegistry()
            .then(registry => {
                // A cold dashboard may already have received an empty fallback.
                // Notify it when the shared scan actually discovers the fleet.
                if (build.background) {
                    for (const win of BrowserWindow.getAllWindows()) {
                        if (!win.isDestroyed()) win.webContents.send('fleet:registry-changed')
                    }
                }
                return { ok: true, registry }
            })
            .catch(e => {
                const prior = cached()
                return prior.loading ? { ok: false, error: e && e.message } : prior
            })
            .finally(() => { if (_registryBuild === build) _registryBuild = null })
    }
    const build = _registryBuild
    let timer = null
    const fallback = new Promise(resolve => {
        timer = setTimeout(() => { build.background = true; resolve(cached()) }, FALLBACK_MS)
    })
    try {
        return await Promise.race([build.promise, fallback])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

// Validate Folders: ensure the {images,reels,trial_reels,stories,…} scaffold
// exists for EVERY account, so the operator can drop content in. Idempotent +
// offline. Covers the UNION of two sources so nothing is missed:
//   1. persisted-registry accounts — may not have a folder yet; resolved via the
//      SAME resolveContext the scan uses (so folders land at identical paths) and
//      created if absent.
//   2. on-disk nested accounts (content-paths.enumerateDiskAccounts) — every
//      account that already has a folder, even if the persisted registry is stale
//      and doesn't list it yet. Pure filesystem, no phone scan.
// Dedup is by resolved account path, so an account in both sources counts once.
// Profiles with no account yet are reported (nothing to scaffold — no handle).
// When `serial` is passed (the dashboard launched for ONE phone), both the
// registry pass and the disk pass are scoped to that device so the operator only
// scaffolds the launched phone's accounts. Absent/empty → unchanged fleet-wide.
async function _validateFolders(serial) {
    try {
        const scope = serial || null
        const plan = enumerateRegistryAccounts(_readRegistry(), scope)
        const result = {
            ok: true, total: 0, created: 0, ready: 0, failed: 0,
            emptyProfiles: plan.emptyProfiles, deviceCount: plan.deviceCount,
            profileCount: plan.profileCount, details: [],
        }
        // Dedup by lowercase IG handle: a handle is globally unique to one account,
        // so if it already has a folder on disk we must NOT scaffold it a second
        // time. Keying on the handle (not serial::userId) is what lets the disk
        // pass shield the registry pass even when a disk profile folder lacks
        // _meta.json (userId would be null there) — without it, pass 2 would write
        // a phantom user_<id> folder and double-count.
        const done = new Set()

        const record = (a, r) => {
            result.total++
            if (!r || !r.ok) { result.failed++; result.details.push({ ...a, status: 'error', error: r && r.error }) }
            else if (r.created) { result.created++; result.details.push({ ...a, status: 'created', path: r.path }) }
            else { result.ready++; result.details.push({ ...a, status: 'ready', path: r.path }) }
        }

        // 1) On-disk accounts FIRST — path already known, pure filesystem, no
        //    resolveContext (no adb/Tailscale, no folder fabrication). This is the
        //    authoritative scaffold; it seeds `done` so the registry pass skips
        //    anything already on disk.
        for (const d of cp.enumerateDiskAccounts(_contentRoot, 'instagram', scope ? { serial: scope } : {})) {
            const h = String(d.handle || '').toLowerCase()
            if (!h || done.has(h)) continue
            done.add(h)
            record({ serial: d.serial, userId: d.userId, handle: d.handle, profileName: d.profileName, source: 'disk' },
                   cp.ensureAccountScaffold(d.profileFolder, 'instagram', d.handle, _contentRoot))
        }

        // 2) Registry accounts the disk walk didn't already cover — these may have
        //    no folder yet, so resolve their context (once per profile) and create.
        const ctxCache = new Map()   // serial::userId -> ctx
        for (const a of plan.accounts) {
            const h = String(a.handle || '').toLowerCase()
            if (!h || done.has(h)) continue
            done.add(h)
            const key = a.serial + '::' + a.userId
            if (!ctxCache.has(key)) {
                let ctx = null
                try { ctx = await _resolveContext(a.serial, a.userId) } catch (_) {}
                ctxCache.set(key, ctx)
            }
            const ctx = ctxCache.get(key)
            if (!ctx || !ctx.profileFolder) {
                result.total++; result.failed++; result.details.push({ ...a, status: 'no-folder' })
                continue
            }
            record(a, cp.ensureAccountScaffold(ctx.profileFolder, 'instagram', a.handle, _contentRoot))
        }

        for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('fleet:registry-changed') } catch (_) {} }
        return result
    } catch (e) {
        return { ok: false, error: e.message }
    }
}

/**
 * registerModelHandlers(ipcMain, deps)
 *   deps = { getConnectedDevices, contentRoot, resolveContext, invokeProfiles,
 *            userDataPath, getMainWindow }
 *   - getConnectedDevices: device-handlers.getConnectedDevices
 *   - resolveContext:      sidebar-content-handlers _resolveContext(serial,userId)
 *   - invokeProfiles:      (serial) -> get-device-profiles result {success,profiles}
 *   - getMainWindow:       () -> BrowserWindow (used by Task 5 fleet:scan stream)
 */
function registerModelHandlers(ipcMain, deps) {
    _getConnectedDevices = deps.getConnectedDevices
    _contentRoot = deps.contentRoot
    _resolveContext = deps.resolveContext
    _invokeProfiles = deps.invokeProfiles
    _userDataPath = deps.userDataPath
    _getMainWindow = deps.getMainWindow

    ipcMain.handle('fleet:get-registry', _getRegistry)
    // Renderer passes the launched device serial as the sole arg (or nothing for
    // the legacy fleet-wide sweep). Coerce a non-string payload to empty = no scope.
    ipcMain.handle('fleet:validate-folders', (_evt, serial) => _validateFolders(typeof serial === 'string' ? serial : ''))

    // ── fleet:scan — full account-discovery sweep for one phone ──────────────
    // Streams 'fleet:scan-progress' per profile to the LOCAL_ONLY main window,
    // then resolves with the merged profile list. Holds the schedule-engine
    // per-phone busy lock for the whole sweep (refuses if the phone is busy).
    // An optional payload.profileIds limits the sweep to specific profile ids
    // (lets the operator battle-test 1-2 profiles instead of all of them).
    const { scanDeviceAccounts } = require('../lib/models-dashboard-scan')

    ipcMain.handle('fleet:scan', async (event, payload) => {
        const serial = payload && payload.serial
        if (!serial) return { ok: false, error: 'serial required' }
        const profileIds = (payload && Array.isArray(payload.profileIds)) ? payload.profileIds : undefined

        const wc = event.sender // the LOCAL_ONLY main window's webContents
        const scanDeps = {
            registryPath: _registryPath(),                            // fleet-registry.json
            getDeviceProfiles: (s) => _invokeProfiles(s),             // {success,profiles}
            resolveContext: _resolveContext,                          // async (serial,userId) -> {profileFolder,...}
            ensureAccountScaffold: cp.ensureAccountScaffold,
            contentRoot: _contentRoot,
            userDataPath: _userDataPath,
            readRegistry,                                             // path-based reader (shared with the sweep)
            writeRegistry,                                            // path-based atomic writer
        }

        const scanResult = await scanDeviceAccounts(serial, {
            profileIds,
            onProgress: (e) => {
                if (wc && !wc.isDestroyed()) {
                    wc.send('fleet:scan-progress', { serial, ...e })
                }
            },
        }, scanDeps)
        if (scanResult && scanResult.ok) {
            for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('fleet:registry-changed') } catch (_) {} }
        }
        return scanResult
    })

    console.log('[model-handlers] 3 IPC handlers registered')
}

module.exports = {
    registerModelHandlers,
    modelOf,
    _buildRegistry,
    _validateFolders,
    _scheduleActiveFor,
    _readRegistry,
    _writeRegistry,
    readRegistry,
    writeRegistry,
    _getRegistry,
}
