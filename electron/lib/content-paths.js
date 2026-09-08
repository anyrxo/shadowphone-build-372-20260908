/**
 * content-paths.js — Single source of truth for the new nested content layout.
 *
 * Layout: Content/phones/<displayName>/profiles/<profileName>/<platform>/<account>/<subfolders>
 *
 * Identity is anchored to stable IDs stored in _meta.json so folder + Tailscale +
 * GrapheneOS renames heal automatically. See:
 *   docs/superpowers/specs/2026-05-24-multi-platform-sidebar-design.md
 */
'use strict'
const fs = require('fs')
const path = require('path')

const SUPPORTED_PLATFORMS = ['instagram', 'tiktok', 'twitter', 'threads', 'reddit']

const PLATFORM_SUBFOLDERS = {
    instagram: ['images', 'videos', 'reels', 'trial_reels', 'stories',
                'used_images', 'used_videos', 'used_reels', 'used_trial_reels', 'used_stories',
                'comments', 'captions', 'story_captions'],
    tiktok:    ['videos', 'used_videos', 'captions', 'comments'],
    twitter:   ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
    threads:   ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
    reddit:    ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
}

// Subfolders that get the global _defaults/<file>.txt copied in on create.
const PLATFORM_DEFAULT_FILES = {
    instagram: { comments: 'comments.txt', captions: 'captions.txt', story_captions: 'story_captions.txt' },
    tiktok:    { comments: 'comments.txt', captions: 'captions.txt' },
    twitter:   { comments: 'comments.txt', captions: 'captions.txt' },
    threads:   { comments: 'comments.txt', captions: 'captions.txt' },
    reddit:    { comments: 'comments.txt', captions: 'captions.txt' },
}

function validTailnetIp(value) {
    return /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/.test(String(value || ''))
}

function sanitizeFolderName(name) {
    return String(name || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80)
}

function readMeta(metaPath) {
    try {
        if (!fs.existsSync(metaPath)) return null
        return JSON.parse(fs.readFileSync(metaPath, 'utf8') || '{}')
    } catch (_) { return null }
}

function writeMeta(metaPath, obj) {
    try {
        fs.mkdirSync(path.dirname(metaPath), { recursive: true })
        fs.writeFileSync(metaPath, JSON.stringify(obj, null, 2), 'utf8')
        return true
    } catch (_) { return false }
}

// Scan Content/phones/*/_meta.json → build { byId, byIp } indexes for O(1) lookup.
function scanPhoneIndex(phonesRoot) {
    const byId = {}
    const byIp = {}
    const byHwSerial = {}
    if (!fs.existsSync(phonesRoot)) return { byId, byIp, byHwSerial }
    for (const entry of fs.readdirSync(phonesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const folderPath = path.join(phonesRoot, entry.name)
        const meta = readMeta(path.join(folderPath, '_meta.json'))
        if (!meta) continue
        if (meta.id) byId[meta.id] = folderPath
        if (meta.tailnetIp) byIp[meta.tailnetIp] = folderPath
        if (meta.hwSerial) byHwSerial[meta.hwSerial] = folderPath
    }
    return { byId, byIp, byHwSerial }
}

/**
 * Resolve (or create) the phone folder under Content/phones/.
 * Lookup order: machine ID → IP → create-new.
 * Heals _meta.json on every call (updates IP/peerName to current values).
 */
function resolvePhoneFolder(phoneInfo, contentRoot) {
    const phonesRoot = path.join(contentRoot, 'phones')
    fs.mkdirSync(phonesRoot, { recursive: true })

    const idx = scanPhoneIndex(phonesRoot)
    let folderPath = null
    let displayName = null
    let meta = null

    // hwSerial (ro.serialno) is the STABLE identity — match it first so a phone
    // reconnecting on a rotated tailnet ip:port reuses its canonical folder
    // instead of minting a duplicate. Fall back to the volatile id/IP, then create.
    if (phoneInfo.hwSerial && idx.byHwSerial[phoneInfo.hwSerial]) {
        folderPath = idx.byHwSerial[phoneInfo.hwSerial]
    } else if (phoneInfo.id && idx.byId[phoneInfo.id]) {
        folderPath = idx.byId[phoneInfo.id]
    } else if (phoneInfo.tailnetIp && idx.byIp[phoneInfo.tailnetIp]) {
        folderPath = idx.byIp[phoneInfo.tailnetIp]
    }

    if (folderPath) {
        displayName = path.basename(folderPath)
        meta = readMeta(path.join(folderPath, '_meta.json'))
    } else {
        displayName = sanitizeFolderName(phoneInfo.hwSerial || phoneInfo.peerName || phoneInfo.id || 'unnamed-phone')
        folderPath = path.join(phonesRoot, displayName)
        // Collision guard: never adopt/overwrite a same-named folder that explicitly
        // belongs to a DIFFERENT phone (its _meta.hwSerial differs) — mint a distinct
        // folder instead of clobbering the other phone's identity + content.
        const clash = readMeta(path.join(folderPath, '_meta.json'))
        if (clash && displayName === 'unnamed-phone' && (
            (phoneInfo.id && clash.id && phoneInfo.id !== clash.id) ||
            (phoneInfo.tailnetIp && clash.tailnetIp && phoneInfo.tailnetIp !== clash.tailnetIp) ||
            (phoneInfo.hwSerial && clash.hwSerial && phoneInfo.hwSerial !== clash.hwSerial)
        )) {
            const tag = String(phoneInfo.id || phoneInfo.hwSerial).replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'x'
            displayName = sanitizeFolderName(displayName + '_' + tag)
            folderPath = path.join(phonesRoot, displayName)
        }
        fs.mkdirSync(folderPath, { recursive: true })
        meta = readMeta(path.join(folderPath, '_meta.json')) || {}
        // Visibility: a brand-new hwSerial folder minted while hwSerial-less folders
        // exist may mean a rotated-away legacy folder couldn't be matched (content
        // could be stranded there). Surface it instead of silently splitting.
        if (phoneInfo.hwSerial) {
            const stranded = fs.readdirSync(phonesRoot, { withFileTypes: true })
                .filter(e => e.isDirectory() && e.name !== displayName)
                .filter(e => { const m = readMeta(path.join(phonesRoot, e.name, '_meta.json')); return m && !m.hwSerial })
                .map(e => e.name)
            if (stranded.length) {
                console.warn(`[content-paths] minted new phone folder "${displayName}" for hwSerial ${phoneInfo.hwSerial} while ${stranded.length} hwSerial-less folder(s) exist — possible content split: ${stranded.join(', ')}`)
            }
        }
    }

    const previousTailnetIp = validTailnetIp(meta?.tailnetIp) ? meta.tailnetIp : null
    const next = {
        id: phoneInfo.id || meta?.id || null,
        tailnetIp: validTailnetIp(phoneInfo.tailnetIp) ? phoneInfo.tailnetIp : previousTailnetIp,
        peerName: phoneInfo.peerName || meta?.peerName || null,
        hwSerial: phoneInfo.hwSerial || meta?.hwSerial || null,   // stamp/heal stable id
        displayName,
        renamedAt: meta?.renamedAt || null,
    }
    writeMeta(path.join(folderPath, '_meta.json'), next)

    // Heal: fold any stale duplicate of this physical phone into the canonical.
    // Opportunistic — must NEVER break resolution, so any failure is swallowed.
    if (phoneInfo.hwSerial) {
        try {
            mergeDuplicatePhoneFolders(phonesRoot, displayName, {
                hwSerial: phoneInfo.hwSerial,
                id: phoneInfo.id || null,
                tailnetIp: phoneInfo.tailnetIp || null,
            })
        } catch (e) {
            console.warn('[content-paths] duplicate-folder heal skipped:', e?.message || e)
        }
    }
    return { folderPath, displayName, meta: next }
}

/**
 * Resolve (or create) the profile folder under <phoneFolder>/profiles/.
 * Keyed by GrapheneOS userId (stable forever). Folder display name is a hint
 * — the operator can rename the folder and we'll still find it via _meta.json.
 */
function resolveProfileFolder(phoneFolder, profileInfo) {
    const profilesRoot = path.join(phoneFolder, 'profiles')
    fs.mkdirSync(profilesRoot, { recursive: true })

    const byProfileId = {}
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const meta = readMeta(path.join(profilesRoot, entry.name, '_meta.json'))
        if (meta && meta.profileId) {
            byProfileId[String(meta.profileId)] = path.join(profilesRoot, entry.name)
        }
    }

    let folderPath = byProfileId[String(profileInfo.profileId)]
    let displayName = folderPath ? path.basename(folderPath) : null
    let meta = folderPath ? readMeta(path.join(folderPath, '_meta.json')) : null

    if (!folderPath) {
        displayName = sanitizeFolderName(profileInfo.profileName || `user_${profileInfo.profileId}`)
        folderPath = path.join(profilesRoot, displayName)
        fs.mkdirSync(folderPath, { recursive: true })
        meta = { profileId: String(profileInfo.profileId), createdAt: new Date().toISOString() }
        writeMeta(path.join(folderPath, '_meta.json'), meta)
    }
    return { folderPath, displayName, meta }
}

/**
 * Create the platform/<account>/ scaffold + copy default templates.
 * Idempotent — skips folders that exist, only copies defaults into newly-
 * created caption/comment folders.
 */
function ensureAccountScaffold(profileFolder, platform, accountName, contentRoot) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
        return { ok: false, error: `unsupported platform: ${platform}` }
    }
    // 2.16.34: lowercase account names. NTFS is case-insensitive so
    // "CaseSensitive" and "casesensitive" land on the same disk folder
    // but my state's accounts[] would list both as separate entries —
    // confusing duplicates in the picker. Plus this matches the legacy
    // dashboard convention (eileenswrld, jiaxzee, etc. all lowercase).
    const accountKey = sanitizeFolderName(accountName).toLowerCase()
    if (!accountKey) return { ok: false, error: 'account name required' }

    const accountPath = path.join(profileFolder, platform, accountKey)
    const defaultsRoot = path.join(contentRoot, '_defaults')

    try {
        let created = false
        for (const sub of (PLATFORM_SUBFOLDERS[platform] || [])) {
            // mkdirSync(recursive) returns the first dir it created, or undefined
            // if the path already existed — lets callers report created-vs-ready.
            if (fs.mkdirSync(path.join(accountPath, sub), { recursive: true })) created = true
        }
        for (const [folder, defaultFile] of Object.entries(PLATFORM_DEFAULT_FILES[platform] || {})) {
            const src = path.join(defaultsRoot, defaultFile)
            const dst = path.join(accountPath, folder, defaultFile)
            if (fs.existsSync(src) && !fs.existsSync(dst)) {
                fs.copyFileSync(src, dst); created = true
            }
        }
        return { ok: true, path: accountPath, created }
    } catch (e) {
        return { ok: false, error: e.message }
    }
}

function listAccountFolders(profileFolder, platform) {
    const root = path.join(profileFolder, platform)
    if (!fs.existsSync(root)) return []
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
}

// Async, non-blocking sibling of listAccountFolders for hot paths (e.g. the
// 25s registry refresh). Folds existsSync+readdirSync into one readdir; a
// missing root maps ENOENT->[] (matching the sync "missing root => []"
// behavior), any other error still throws — behavior-identical.
async function listAccountFoldersAsync(profileFolder, platform) {
    const root = path.join(profileFolder, platform)
    try {
        return (await fs.promises.readdir(root, { withFileTypes: true }))
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort()
    } catch (e) {
        if (e.code === 'ENOENT') return []
        throw e
    }
}

// Recursively MOVE every file from src into dst at the same relative path, but
// only when dst lacks it — never overwrites. Returns count of files moved.
function _moveTreeIfAbsent(src, dst) {
    let moved = 0
    if (!fs.existsSync(src)) return 0
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name)
        const d = path.join(dst, e.name)
        if (e.isDirectory()) {
            if (fs.existsSync(d) && !fs.statSync(d).isDirectory()) continue
            fs.mkdirSync(d, { recursive: true })
            moved += _moveTreeIfAbsent(s, d)
        } else if (!fs.existsSync(d)) {
            fs.mkdirSync(path.dirname(d), { recursive: true })
            fs.renameSync(s, d)
            moved++
        }
    }
    return moved
}

// True if any file other than a _meta.json remains anywhere under dir.
function _hasRealFiles(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (_hasRealFiles(p)) return true }
        else if (e.name !== '_meta.json') return true
    }
    return false
}

// Fold every other phone folder that is the SAME physical phone into the
// canonical folder. match = { hwSerial, id, tailnetIp }. move-if-absent
// (never overwrites); removes a dup only once it holds no real files. Idempotent.
function mergeDuplicatePhoneFolders(phonesRoot, canonicalName, match) {
    const summary = { merged: [], movedFiles: 0 }
    if (!fs.existsSync(phonesRoot)) return summary
    const canonicalProfiles = path.join(phonesRoot, canonicalName, 'profiles')
    for (const entry of fs.readdirSync(phonesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === canonicalName) continue
        const dupPath = path.join(phonesRoot, entry.name)
        const meta = readMeta(path.join(dupPath, '_meta.json')) || {}
        const isDup =
            (match.hwSerial && meta.hwSerial === match.hwSerial) ||
            (!meta.hwSerial && match.id && meta.id === match.id) ||
            (!meta.hwSerial && match.tailnetIp && meta.tailnetIp === match.tailnetIp)
        if (!isDup) continue
        try {
            summary.movedFiles += _moveTreeIfAbsent(path.join(dupPath, 'profiles'), canonicalProfiles)
            if (!_hasRealFiles(dupPath)) fs.rmSync(dupPath, { recursive: true, force: true })
            summary.merged.push(entry.name)
        } catch (e) {
            console.warn(`[content-paths] could not fold duplicate "${entry.name}":`, e?.message || e)
        }
    }
    return summary
}

// Walk the nested layout (Content/phones/*/profiles/*/<platform>/<account>) and
// return every account folder on disk, each with its resolved profileFolder so a
// caller can ensureAccountScaffold() it WITHOUT a phone scan. Pure filesystem read.
// When opts.serial / opts.hwSerial is passed, scope to the LAUNCHED device only:
// resolve its single phones/* folder via scanPhoneIndex (byHwSerial → byId → byIp)
// and walk just that one. Unset → walk every phone (unchanged fleet-wide behavior).
function enumerateDiskAccounts(contentRoot, platform = 'instagram', opts = {}) {
    const out = []
    const phonesRoot = path.join(contentRoot, 'phones')
    if (!fs.existsSync(phonesRoot)) return out

    // Device-scoped: restrict the walk to the one phone folder matching this serial.
    let onlyPhoneFolder = null
    const scopeSerial = opts && (opts.hwSerial || opts.serial)
    if (scopeSerial) {
        const idx = scanPhoneIndex(phonesRoot)
        const bareIp = String(scopeSerial).split(':')[0]   // strip :port for tailnet ip:port serials
        onlyPhoneFolder = idx.byHwSerial[scopeSerial] || idx.byId[scopeSerial] || idx.byIp[scopeSerial] || idx.byIp[bareIp] || null
        if (!onlyPhoneFolder) return out   // no folder for this device yet → nothing on disk to scope
    }

    for (const phoneEntry of fs.readdirSync(phonesRoot, { withFileTypes: true })) {
        if (!phoneEntry.isDirectory()) continue
        if (onlyPhoneFolder && path.join(phonesRoot, phoneEntry.name) !== onlyPhoneFolder) continue
        const phoneMeta = readMeta(path.join(phonesRoot, phoneEntry.name, '_meta.json'))
        const profilesRoot = path.join(phonesRoot, phoneEntry.name, 'profiles')
        if (!fs.existsSync(profilesRoot)) continue
        for (const profEntry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
            if (!profEntry.isDirectory()) continue
            const profileFolder = path.join(profilesRoot, profEntry.name)
            const profMeta = readMeta(path.join(profileFolder, '_meta.json'))
            const acctRoot = path.join(profileFolder, platform)
            if (!fs.existsSync(acctRoot)) continue
            for (const acctEntry of fs.readdirSync(acctRoot, { withFileTypes: true })) {
                if (!acctEntry.isDirectory()) continue
                out.push({
                    phoneFolder: phoneEntry.name,
                    serial: phoneMeta && phoneMeta.id ? phoneMeta.id : null,
                    profileFolder,
                    profileName: profEntry.name,
                    userId: profMeta && profMeta.profileId != null ? String(profMeta.profileId) : null,
                    handle: acctEntry.name,
                    accountPath: path.join(acctRoot, acctEntry.name),
                })
            }
        }
    }
    return out
}

// ===== Sidebar persistent state =====

function readSidebarState(userDataPath) {
    const p = path.join(userDataPath, 'sidebar-state.json')
    try {
        if (!fs.existsSync(p)) return { phones: {} }
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
        if (!parsed.phones || typeof parsed.phones !== 'object') parsed.phones = {}
        return parsed
    } catch (_) { return { phones: {} } }
}

function writeSidebarState(userDataPath, state) {
    const p = path.join(userDataPath, 'sidebar-state.json')
    try { fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8'); return true }
    catch (_) { return false }
}

function ensureProfileState(state, phoneId, profileId) {
    if (!state.phones[phoneId]) {
        state.phones[phoneId] = { lastDisplayName: null, lastTailnetIp: null, profiles: {} }
    }
    const p = state.phones[phoneId]
    if (!p.profiles[profileId]) {
        p.profiles[profileId] = {
            activePlatform: 'instagram',
            platforms: Object.fromEntries(
                SUPPORTED_PLATFORMS.map(plat => [plat, { activeAccount: null, accounts: [] }])
            ),
        }
    }
    // Heal: if state was created before a platform was added, fill in.
    for (const plat of SUPPORTED_PLATFORMS) {
        if (!p.profiles[profileId].platforms[plat]) {
            p.profiles[profileId].platforms[plat] = { activeAccount: null, accounts: [] }
        }
    }
    return p.profiles[profileId]
}

// Scan flat legacy layout (Content/<platform>/<account>/) for back-compat
// surfacing in the sidebar's account picker.
function scanLegacyAccounts(contentRoot) {
    const out = []
    for (const platform of SUPPORTED_PLATFORMS) {
        const root = path.join(contentRoot, platform)
        if (!fs.existsSync(root)) continue
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            if (entry.name.startsWith('_')) continue       // _defaults, _quickupload_*
            out.push({ platform, account: entry.name, path: path.join(root, entry.name) })
        }
    }
    return out
}

module.exports = {
    SUPPORTED_PLATFORMS,
    PLATFORM_SUBFOLDERS,
    PLATFORM_DEFAULT_FILES,
    sanitizeFolderName,
    readMeta,
    writeMeta,
    scanPhoneIndex,
    resolvePhoneFolder,
    resolveProfileFolder,
    renameProfileFolderForId,
    ensureAccountScaffold,
    listAccountFolders,
    listAccountFoldersAsync,
    enumerateDiskAccounts,
    mergeDuplicatePhoneFolders,
    readSidebarState,
    writeSidebarState,
    ensureProfileState,
    scanLegacyAccounts,
}

/**
 * 2.18.6: After a successful Settings-UI profile rename, also rename the
 * local content folder so what the operator sees on disk matches what
 * the sidebar shows. Idempotent + safe — if the target name already
 * exists OR rename fails, returns ok:false without touching anything.
 *
 * Finds the profile folder by scanning Content/phones/<any>/profiles/<any>/
 * for a _meta.json with the given profileId. profileId is the stable key.
 *
 * Returns: { ok, oldPath?, newPath?, reason? }
 */
function renameProfileFolderForId(contentRoot, profileId, newProfileName) {
    if (!profileId || !newProfileName) return { ok: false, reason: 'missing args' }
    const phonesRoot = path.join(contentRoot, 'phones')
    if (!fs.existsSync(phonesRoot)) return { ok: false, reason: 'no phones root' }
    const targetId = String(profileId)
    const targetName = sanitizeFolderName(newProfileName)
    if (!targetName) return { ok: false, reason: 'invalid name after sanitize' }

    for (const phoneEntry of fs.readdirSync(phonesRoot, { withFileTypes: true })) {
        if (!phoneEntry.isDirectory()) continue
        const profilesRoot = path.join(phonesRoot, phoneEntry.name, 'profiles')
        if (!fs.existsSync(profilesRoot)) continue
        for (const profEntry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
            if (!profEntry.isDirectory()) continue
            const oldPath = path.join(profilesRoot, profEntry.name)
            const meta = readMeta(path.join(oldPath, '_meta.json'))
            if (!meta || String(meta.profileId) !== targetId) continue
            if (profEntry.name === targetName) return { ok: true, oldPath, newPath: oldPath, reason: 'name already matches' }
            const newPath = path.join(profilesRoot, targetName)
            if (fs.existsSync(newPath)) return { ok: false, oldPath, reason: 'target name already exists on disk' }
            try {
                fs.renameSync(oldPath, newPath)
                return { ok: true, oldPath, newPath }
            } catch (e) {
                return { ok: false, oldPath, reason: e?.message || String(e) }
            }
        }
    }
    return { ok: false, reason: 'no profile folder with that profileId found' }
}
