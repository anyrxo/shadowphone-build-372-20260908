/**
 * Profile Edit IPC Handlers (Models Dashboard "Configure" modal)
 *
 * Makes the dashboard's Edit Bio + Change Pic controls real. Both delegate to
 * the BRAIN module `edit_profile` (brain/lib/ws_modules/edit_profile.py), run
 * as a SINGLE module over the local-brain WebSocket — the same dispatch the
 * `run-module-ws` handler uses (handlers/module-handlers.js). No mirror /
 * headless toolbar window is needed: a single brain module doesn't require the
 * renderer-side 11-step workflow that Post Now drives.
 *
 * The brain module edits whatever IG account is CURRENTLY FOREGROUND on the
 * phone — it opens IG, goes to the profile tab, and edits the current profile.
 * It does NOT switch Android users / IG accounts itself. The caller is
 * responsible for the target account already being foreground (the dashboard's
 * switch flow, or a live operator). We forward the Android userId as the
 * module's profile_id so the brain can verify it is operating on that user.
 *
 * Registered from main.js inside createWindow() next to the other inline
 * dashboard ipcMain.handle blocks (dashboard:post-now etc.).
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const { ModuleWebSocketClient } = require('../lib/ws-module-client')
const { LOCAL_MODULE_HANDLERS, LocalDevice } = require('../lib/local-modules')
const { runProfileEdit } = require('../lib/profile-edit-orchestrator')
const scheduleClient = require('../lib/schedule-client')
const {
    beginIdentityChange,
    commitIdentityChange,
    failIdentityChange,
} = require('../lib/account-identity-migration')

// Resolve the live adb serial for a (possibly stale) row serial. Tailnet
// serials are <ip>:<port> and the adb port rotates per boot, so match by
// tailnet IP (strip the port); USB udids match strictly. Mirrors main.js
// _resolveLiveSerial but self-contained so this module has no createWindow-scope
// dependency.
async function _resolveLiveSerial(getADBPath, executeADBFn, rowSerial) {
    try {
        const out = await executeADBFn(['devices'], 5000)
        const serials = out.split(/\r?\n/).slice(1)
            .filter(l => l.trim() && !/\b(?:offline|unauthorized)\b/.test(l))
            .map(l => l.split(/\s+/)[0])
            .filter(Boolean)
        return require('../lib/device-identity').resolveFromSerialList(rowSerial, serials)
    } catch (_) {
        return null
    }
}

// Acquire the local-brain WS endpoint. Posting-class modules (edit_profile is
// one — it drives the phone via local adb) must run on the local brain; there
// is no safe Railway fallback. Block briefly for the brain to finish its async
// boot rather than failing on the first null endpoint.
async function _acquireLocalBrain() {
    const localBrainMod = require('../lib/local-brain')
    let ep = localBrainMod.getLocalBrainEndpoint()
    if (!ep && typeof localBrainMod.waitForLocalBrain === 'function') {
        ep = await localBrainMod.waitForLocalBrain(45_000)
    }
    if (ep && ep.secret) return ep
    const exitReason = typeof localBrainMod.getBrainExitReason === 'function'
        ? localBrainMod.getBrainExitReason()
        : null
    const hint = exitReason === 'no_python_runtime'
        ? ' No Python 3 runtime was found — install Python 3.11+ and relaunch.'
        : ' Wait a few seconds for the local brain to start, then retry.'
    const err = new Error(`Edit Profile must run on the local brain, which isn't reachable right now.${hint}`)
    err.code = 'LOCAL_BRAIN_UNAVAILABLE'
    throw err
}

// Run one LOCAL module against a phone profile — same dispatch the models-
// dashboard scan uses (_runModuleLocal in models-dashboard-scan.js): pull the
// handler out of LOCAL_MODULE_HANDLERS and call it with a real LocalDevice.
// No brain/WS round trip.
async function _runLocalModule(moduleId, serial, cfg) {
    const handler = LOCAL_MODULE_HANDLERS[moduleId]
    if (typeof handler !== 'function') {
        return { success: false, error: `Local module not available: ${moduleId}` }
    }
    return handler(new LocalDevice(serial), cfg || {})
}

// Ensure the phone is foregrounded into the TARGET account's Android user
// BEFORE edit_profile runs — edit_profile edits whatever IG profile is current,
// so editing account X while the phone sits on profile Y would silently edit the
// wrong account. We do the airplane-wrapped user switch the scan + scheduled
// posting use (airplane ensure_on -> profile_switch -> airplane ensure_off), but
// only when we're not already on the target user (skip the radio dance + setup-
// wizard work on the common case). The Task-0 profile_switch fix lands the
// switch even when the target user is stopped (State:-1).
async function _ensureForegroundUser(serial, userId) {
    const target = String(userId ?? '').trim()
    if (!/^\d+$/.test(target)) {
        return { switched: false, error: `Invalid Android userId for this account: ${JSON.stringify(userId)}` }
    }

    // Current user via the same local module the scan reuses (profile_switch
    // 'list' returns current_user). Cheaper + safer than a raw shell here.
    const listed = await _runLocalModule('profile_switch', serial, { action: 'list' })
    const current = listed && listed.data ? listed.data.current_user : NaN
    if (Number(current) === Number(target)) {
        return { switched: false, alreadyForeground: true, current_user: current }
    }

    await _runLocalModule('airplane_toggle', serial, { action: 'ensure_on' })
    const sw = await _runLocalModule('profile_switch', serial, {
        action: 'switch',
        target_profile: target,
        complete_setup_wizard: true,
    })
    await _runLocalModule('airplane_toggle', serial, { action: 'ensure_off' })

    if (!sw || !sw.success) {
        return { switched: false, error: sw?.error || `Failed to switch phone to Android user ${target}` }
    }
    return { switched: true, current_user: target }
}

// Surface the EXACT Instagram account inside the current Android user. One
// GrapheneOS user can host several IG logins, and edit_profile edits whatever
// account is foreground — so after the user switch we open the in-app account
// switcher (LONG-PRESS the profile tab) and tap the target handle. This is the
// same proven mechanism the scan + insights sweep use (ig_account_switch). It
// also cold-relaunches IG + dismisses popups, which doubles as the post-staging
// IG re-foreground. No-op-safe when the handle is already the only/active login;
// a real miss (handle not in the switcher) is returned as an error so we never
// edit the wrong account.
async function _ensureForegroundAccount(serial, account) {
    const handle = String(account || '').trim()
    if (!handle) return { ok: false, error: 'No Instagram handle for this account.' }
    let r = await _runLocalModule('ig_account_switch', serial, { target_username: handle })
    if (r && r.success) return { ok: true }
    // One retry with a cold relaunch (the module's force path) for a half-open
    // switcher or a missed long-press.
    const r2 = await _runLocalModule('ig_account_switch', serial, { target_username: handle, force: true })
    if (r2 && r2.success) return { ok: true }
    return { ok: false, error: r2?.error || r?.error || `Could not select @${handle} in the account switcher` }
}

function _isTransientProfileEditTransportFailure(failure) {
    if (!failure) return false
    if (failure.transportFailure === true) return true
    const code = String(failure.code || '').toUpperCase()
    if ([
        'CONNECTION_TIMEOUT',
        'WS_CONNECTION_LOST',
        'WS_HEARTBEAT_TIMEOUT',
    ].includes(code)) return true
    const message = String(failure.error || failure.message || failure)
    return /abnormal[_ ]closure|closecode\.abnormal_closure|websocket.*(?:closed|disconnect)|connection.*(?:closed|reset)|dump_screen failed.*1006/i.test(message)
}

async function _runProfileEditWithTransportRetry(runAttempt, options = {}) {
    const onRetry = options.onRetry || (() => {})
    const wait = options.wait || ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let result
        let thrown = null
        try {
            result = await runAttempt(attempt)
        } catch (error) {
            thrown = error
        }
        const failure = thrown || (!result?.success ? result : null)
        if (attempt === 0 && _isTransientProfileEditTransportFailure(failure)) {
            onRetry(failure)
            await wait(1200)
            continue
        }
        if (thrown) throw thrown
        return result
    }
    throw new Error('Profile edit transport retry exhausted without a terminal result.')
}

// Run the edit_profile brain module over the local-brain WS and stream
// progress/log to the dashboard window so the Configure modal can show status.
// A single transient socket loss is replayed on a fresh connection. The Android
// user and exact IG account were already verified immediately before this call,
// so the retry resumes the same idempotent conversion without advancing the fleet.
async function _runEditProfile({ serial, userId, account, config, getMainWindow }) {
    const accountUsername = typeof account === 'string' ? account.trim().replace(/^@/, '').toLowerCase() : ''
    if (!/^[a-z0-9._]{1,30}$/.test(accountUsername)) {
        return { success: false, code: 'INSTAGRAM_ACCOUNT_IDENTITY_UNVERIFIED', error: 'Select one Instagram account before editing its profile.' }
    }
    const runId = `edit-profile-${Date.now()}`
    const send = (payload) => {
        try {
            const w = getMainWindow && getMainWindow()
            if (w && !w.isDestroyed()) w.webContents.send('module-progress', { runId, moduleId: 'edit_profile', ...payload })
        } catch (_) {}
    }
    return _runProfileEditWithTransportRetry(async () => {
        const ep = await _acquireLocalBrain()
        const client = new ModuleWebSocketClient(ep.wsUrl, ep.secret, 'secret')
        const result = await client.runModule(
            'edit_profile',
            serial,
            String(userId || ''),
            { ...config, account_username: accountUsername },
            'local',
            {
                onProgress: (percent, message) => send({ type: 'progress', percent, message, status: 'progress' }),
                onLog: (log) => send({ type: 'log', message: log }),
            },
        )
        return {
            success: !!result.success,
            data: result.data,
            error: result.error || result.message,
            code: result.code,
        }
    }, {
        onRetry: (failure) => send({
            type: 'log',
            status: 'retrying',
            message: `Profile edit transport interrupted for @${account}; reconnecting once before continuing. ${failure?.error || failure?.message || ''}`.trim(),
        }),
    })
}

// Stage a single picked image onto the phone's CURRENT Android user gallery so
// IG's "Edit picture → Choose from library" can see it. Cross-user storage is
// isolated on GrapheneOS, so for any non-owner user we go through the same
// Vanadium-download bridge the post modules use (push_to_profile). The picked
// file is copied into a temp folder (push_to_profile selects from a folder, not
// a single path) which is pushed wholesale.
async function _stageAvatarOntoPhone({ serial, filePath, account }) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-avatar-'))
    const ext = (path.extname(filePath) || '.jpg').toLowerCase()
    const staged = path.join(tmpRoot, `avatar_${Date.now()}${ext}`)
    fs.copyFileSync(filePath, staged)

    // executeCommand runs adb locally (no brain auth needed) — the
    // 'local-quick-upload' label matches main.js's quick-upload client.
    const client = new ModuleWebSocketClient('http://127.0.0.1', 'local-quick-upload')
    const currentUser = (await client.getCurrentAndroidUser(serial)) || '0'
    const extensions = ['.jpg', '.jpeg', '.png', '.webp']

    let result
    if (String(currentUser) !== '0') {
        result = await client.executeCommand(serial, {
            action: 'push_to_profile',
            params: {
                source_folder: tmpRoot,
                target_user: String(currentUser),
                account_username: account || 'avatar',
                max_files: 1,
                extensions,
                port: 18765,
            },
        })
    } else {
        result = await client.executeCommand(serial, {
            action: 'push_files',
            params: {
                source_folder: tmpRoot,
                dest_folder: '/sdcard/ShadowPhone/content',
                account_username: account || 'avatar',
                max_files: 1,
                extensions,
            },
        })
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {}
    return {
        success: !!result?.success && Number(result?.pushed || 0) > 0,
        pushed: Number(result?.pushed || 0),
        targetUser: String(currentUser),
        error: result?.error,
        stagedRemoteFilename: result?.manifest?.[0]?.remote_filename,
        // Phone-side gallery path of the staged image (best-effort; the brain
        // module would re-select it from the gallery, not by absolute path).
        stagedFileName: path.basename(staged),
    }
}

/**
 * @param ipcMain  electron ipcMain
 * @param deps     { dialog, getADBPath, executeADB, getMainWindow }
 */
function registerProfileEditHandlers(ipcMain, deps) {
    const {
        dialog,
        getADBPath,
        executeADB,
        getMainWindow,
        userDataPath,
        resolveContext,
        getSessionToken,
    } = deps
    const orchestrate = deps.runProfileEdit || runProfileEdit

    ipcMain.handle('dashboard:edit-profile', async (_evt, payload = {}) => {
        const serial = String(payload.serial || '').trim()
        const userId = String(payload.userId ?? '').trim()
        const account = String(payload.account || '').trim()
        if (!serial || !/^\d+$/.test(userId) || !account) {
            return {
                success: false,
                status: 'invalid_request',
                error: 'Phone serial, Android user ID, and Instagram account are required.',
            }
        }

        const request = { ...payload, serial, userId, account }
        if (request.change_picture && !request.picturePath) {
            const parentWin = getMainWindow && getMainWindow()
            const pick = await dialog.showOpenDialog(parentWin || undefined, {
                title: 'Choose a profile picture',
                properties: ['openFile'],
                filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
            })
            if (pick.canceled || !pick.filePaths?.[0]) {
                return { success: false, canceled: true, status: 'canceled', error: 'No image selected.' }
            }
            request.picturePath = pick.filePaths[0]
        }
        delete request.change_picture

        if (deps.runProfileEdit) return orchestrate(request)

        let pendingRename = null
        let renameContext = null
        const registryPath = userDataPath ? path.join(userDataPath, 'fleet-registry.json') : null
        try {
            return await orchestrate(request, {
                resolveSerial: async (rowSerial) => _resolveLiveSerial(getADBPath, executeADB, rowSerial),
                ensureUser: async (liveSerial, targetUserId) => {
                    const switched = await _ensureForegroundUser(liveSerial, targetUserId)
                    if (switched?.error) return { ok: false, error: switched.error }
                    const listed = await _runLocalModule('profile_switch', liveSerial, { action: 'list' })
                    const current = listed?.data?.current_user
                    return Number(current) === Number(targetUserId)
                        ? { ok: true, currentUser: String(current) }
                        : { ok: false, error: `Android user verification failed: expected ${targetUserId}, found ${current ?? 'unknown'}.` }
                },
                ensureAccount: async (liveSerial, _targetUserId, handle) => {
                    const selected = await _ensureForegroundAccount(liveSerial, handle)
                    return selected.ok ? { ok: true, handle } : selected
                },
                stagePicture: ({ serial: liveSerial, picturePath, account: handle }) => (
                    _stageAvatarOntoPhone({ serial: liveSerial, filePath: picturePath, account: handle })
                ),
                runBrain: (input) => _runEditProfile({ ...input, getMainWindow }),
                beginRename: async ({ username }) => {
                    if (!registryPath || typeof resolveContext !== 'function') {
                        throw new Error('Local fleet paths are unavailable for a safe username migration.')
                    }
                    renameContext = await resolveContext(serial, userId)
                    if (!renameContext?.profileFolder) {
                        throw new Error('The account content folder could not be resolved before changing its username.')
                    }
                    pendingRename = beginIdentityChange(
                        registryPath,
                        { serial, userId, platform: 'instagram', handle: account },
                        username,
                    )
                    return pendingRename
                },
                verifyHandle: async (liveSerial, _targetUserId, handle) => {
                    const verified = await _ensureForegroundAccount(liveSerial, handle)
                    return verified.ok ? { ok: true, handle } : verified
                },
                commitRename: async ({ verifiedHandle, serial: liveSerial }) => {
                    const local = commitIdentityChange({
                        registryPath,
                        userDataPath,
                        accountRoot: path.join(renameContext.profileFolder, 'instagram'),
                        locator: { serial, userId, platform: 'instagram', handle: account },
                        verifiedHandle,
                        serialAliases: [serial, liveSerial],
                    })
                    const cloud = await scheduleClient.updateAccountUsername(
                        account,
                        verifiedHandle,
                        getSessionToken?.(),
                    )
                    return { ...local, cloud }
                },
                failRename: async ({ error }) => {
                    if (pendingRename && registryPath) failIdentityChange(registryPath, pendingRename.key, error)
                },
            })
        } catch (error) {
            if (pendingRename && registryPath) {
                try { failIdentityChange(registryPath, pendingRename.key, error?.message || String(error)) } catch (_) {}
            }
            return {
                success: false,
                status: 'failed',
                error: error?.message || String(error),
                code: error?.code,
            }
        }
    })

    // Edit Bio → dispatch edit_profile with just the bio text. Single field, so
    // the module's inter-field human-jitter never fires (field_idx stays 0).
    ipcMain.handle('dashboard:edit-bio', async (_evt, { serial, userId, account, bioText }) => {
        try {
            const bio = typeof bioText === 'string' ? bioText : ''
            if (!bio.trim()) return { success: false, error: 'Bio text is empty.' }
            const liveSerial = await _resolveLiveSerial(getADBPath, executeADB, serial) || serial
            if (!liveSerial) return { success: false, error: 'No live device serial resolved for this phone.' }

            // Land on the TARGET account's Android user first — edit_profile
            // edits whatever profile is foreground, so without this it can edit
            // the wrong account. Fail loud rather than editing the wrong one.
            let sw
            try {
                sw = await _ensureForegroundUser(liveSerial, userId)
            } catch (e) {
                return { success: false, error: `Could not switch to the target account before editing bio: ${e?.message || String(e)}` }
            }
            if (sw.error) {
                return { success: false, error: `Could not switch to the target account before editing bio: ${sw.error}` }
            }

            // Land on the exact IG account inside this Android user (multi-login
            // profiles) before editing the bio of "whatever is foreground".
            const acc = await _ensureForegroundAccount(liveSerial, account)
            if (!acc.ok) {
                return { success: false, error: `Could not switch Instagram to @${account} before editing bio: ${acc.error}` }
            }

            return await _runEditProfile({
                serial: liveSerial,
                userId,
                account,
                config: { bio },
                getMainWindow,
            })
        } catch (e) {
            return { success: false, error: e?.message || String(e), code: e?.code }
        }
    })

    // Change Pic → pick an image, stage it onto the phone's gallery (for the
    // target user), then dispatch edit_profile with the picture keys. The brain
    // module (edit_profile.py) reads set_profile_picture/profile_picture/
    // picture_path and runs the real IG flow: Edit picture → New profile photo →
    // pick the newest gallery cell (the just-staged image) → crop → Done.
    // Caveat: the gallery-cell + crop-confirm coords in edit_profile.py are still
    // pending a live-device retune (flagged there), so the on-screen taps may need
    // calibration — but the wiring/keys are complete, NOT a no-op.
    ipcMain.handle('dashboard:change-avatar', async (_evt, { serial, userId, account }) => {
        try {
            const liveSerial = await _resolveLiveSerial(getADBPath, executeADB, serial) || serial
            if (!liveSerial) return { success: false, error: 'No live device serial resolved for this phone.' }

            const parentWin = getMainWindow && getMainWindow()
            const pick = await dialog.showOpenDialog(parentWin || undefined, {
                title: 'Choose a profile picture',
                properties: ['openFile'],
                filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
            })
            if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) {
                return { success: false, canceled: true, error: 'No image selected.' }
            }
            const filePath = pick.filePaths[0]

            // Land on the TARGET account's Android user BEFORE staging + editing.
            // _stageAvatarOntoPhone pushes into the CURRENT user's gallery and
            // edit_profile edits the CURRENT profile, so without this both the
            // staged image and the picture/bio edit hit the wrong account.
            let sw
            try {
                sw = await _ensureForegroundUser(liveSerial, userId)
            } catch (e) {
                return { success: false, error: `Could not switch to the target account before changing the picture: ${e?.message || String(e)}` }
            }
            if (sw.error) {
                return { success: false, error: `Could not switch to the target account before changing the picture: ${sw.error}` }
            }

            const staged = await _stageAvatarOntoPhone({ serial: liveSerial, filePath, account })
            if (!staged.success) {
                return { success: false, error: `Could not stage image onto the phone: ${staged.error || 'push failed'}` }
            }

            // Now land on the exact IG account inside this Android user (handles
            // multi-login profiles) AND re-foreground IG after the staging push.
            const acc = await _ensureForegroundAccount(liveSerial, account)
            if (!acc.ok) {
                return { success: false, error: `Could not switch Instagram to @${account} before changing the picture: ${acc.error}` }
            }

            const result = await _runEditProfile({
                serial: liveSerial,
                userId,
                account,
                // Keys edit_profile.py reads to apply the staged image as the IG
                // profile picture (set_picture = any of these truthy).
                config: {
                    profile_picture: staged.stagedRemoteFilename,
                    picture_path: filePath,
                    set_profile_picture: true,
                },
                getMainWindow,
            })
            // The staged avatar is one-time use. Remove only its exact MediaStore
            // row for this Android user so unrelated gallery media is preserved.
            // Best-effort: never fail the change on a cleanup hiccup.
            let stagedMediaRemoved = false
            try {
                if (!staged.stagedRemoteFilename) throw new Error('Staged avatar filename was not returned')
                const gc = await _runLocalModule('gallery_clean', liveSerial, {
                    mode: 'exact',
                    target_user: staged.targetUser,
                    filenames: [staged.stagedRemoteFilename],
                })
                stagedMediaRemoved = !!(gc && gc.success)
            } catch (_) {}

            return {
                ...result,
                stagedFile: filePath,
                stagedTargetUser: staged.targetUser,
                stagedMediaRemoved,
            }
        } catch (e) {
            return { success: false, error: e?.message || String(e), code: e?.code }
        }
    })
}

module.exports = {
    registerProfileEditHandlers,
    runEditProfileBrain: _runEditProfile,
    _runProfileEditWithTransportRetry,
}
