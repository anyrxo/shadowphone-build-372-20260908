/**
 * Module Execution IPC Handlers
 * Handles module execution via REST and WebSocket connections
 */

const { ipcMain, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { LOCAL_MODULE_HANDLERS, LocalDevice, getPendingSnapshots, parseStatNumber } = require('../lib/local-modules')
const { appAuthFetch } = require('../lib/app-auth-fetch')

// 2.18.11: fan module-progress to both the dashboard (mainWindow) AND every
// open per-mirror toolbar so the LIVE pane lights up. Previously the toolbar
// LIVE panel was wired but never received events — they only went to mainWindow.
function sendModuleProgress(payload) {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('module-progress', payload)
        }
    } catch (_) {}
    try {
        const mt = require('../lib/mirror-toolbar')
        if (typeof mt.broadcastModuleProgress === 'function') {
            mt.broadcastModuleProgress(payload)
        }
    } catch (_) {}
    // Also fan to the models-dashboard child window (fleet-dashboard-window.js) so
    // its bottom-right creation/basic-op LIVE panel lights up. Creation logs already
    // flow on this channel; they just never reached that window before. Skip
    // mainWindow (already sent) and toolbars (served by broadcastModuleProgress) to
    // avoid duplicating every log line. Mirrors bulk-creation-handlers.js emit().
    try {
        const mt = require('../lib/mirror-toolbar')
        const toolbarIds = typeof mt.getToolbarWebContentsIds === 'function' ? mt.getToolbarWebContentsIds() : []
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w || w.isDestroyed()) continue
            if (mainWindow && w.id === mainWindow.id) continue          // already sent
            if (toolbarIds.includes(w.webContents.id)) continue         // served by broadcastModuleProgress
            try { w.webContents.send('module-progress', payload) } catch (_) {}
        }
    } catch (_) {}
}

// Dependencies injected during initialization
let mainWindow = null
let executeADB = null
let ModuleWebSocketClient = null
let MODULES_SERVER_URL = null
let MODULES_API_SECRET = null
let MODULES_PATH = null
let getModuleToken = null
let getCurrentUserSession = null
let app = null
// Captured inside initModuleHandlers so bulk creation (and any other caller)
// can invoke the run-module-ws logic directly without a renderer IPC round-trip.
let _runModuleWs = null

// Module execution state
const runningModules = new Map()
const activeWsModules = new Map()
const NON_DEVICE_LOCAL_MODULES = new Set(['delay', 'random_delay', 'conditional', 'notification', 'airtable_sync'])
// Wall-clock of the last WS run's true end (set in runModuleWs finally, which
// wraps the whole run incl. retries). main.js's grace-aware busy predicate reads
// this to keep a phone "busy" for a cooldown after a run settles — stops the
// companion/Tailscale owner-swap from firing the instant run counts hit 0 and
// re-throwing IG to the signup screen before its final NUX taps complete.
let lastRunEndedAt = 0

// Rolling "something is actively touching this fleet" marker. Unlike
// lastRunEndedAt (set only when a run SETTLES), this is bumped at the START of a
// run and on every profile switch — so the companion/Tailscale owner-swap is
// suppressed across the WHOLE create sequence: the renderer's switch-profile
// pre-step, the up-to-45s local-brain wait (before activeWsModules is set), and
// the run itself. Without this, a companion tick landing in that pre-run window
// still swapped to the owner profile and threw IG back to the signup screen.
let lastActivityAt = 0
function bumpActivity() { lastActivityAt = Date.now() }

// Modules that MUST run on the local Python brain — they are real device
// automation served by lib/ws_modules/* (post_trial_reel.py etc.) and have
// no JS reimplementation. The Railway WS is treated as down/untrusted for
// these: posting through a stale or 502'ing Railway service can double-post
// or silently lose a scheduled post. If the local brain can't be reached we
// hard-fail with an actionable error instead of falling back.
const BRAIN_REQUIRED_MODULES = new Set([
    // Posting
    'post_reel', 'post_trial_reel', 'post_story', 'post_feed',
    // Engagement / interaction — any module that drives the phone via local ADB.
    // Railway can't reach a local phone's adb socket, so engagement fired via
    // Railway hard-fails with "device_unreachable_via_adb" — they MUST run via
    // the local brain like the posting modules above.
    'engagement',
    'view_stories',
    'follow', 'unfollow',
    'ig_repost',
    'comments', 'comment',
    // Account lifecycle on the phone
    'account_creation', 'account_creation_phone',
    'ig_login', 'edit_profile',
    // Direct messaging
    'dm_automation',
])

const NON_IDEMPOTENT_WS_MODULES = new Set(['account_creation_phone'])
// DO NOT add 'DEVICE_LOST' here. It means the phone stopped answering adb, so an
// automatic replay 1.5s later would fire post_reel/comment/follow into a still-
// dead phone and duplicate the action once it comes back. DEVICE_LOST needs the
// non-retry path: transportFailure + moduleStartSent (and abortRequested false,
// because the liveness abort never calls client.abort()) already routes account
// creation to accountCreationOutcomeUncertain() below, and everything else to a
// plain {success:false, code:'DEVICE_LOST'} the operator can act on.
const TRANSIENT_WS_CODES = new Set([
    'WS_CLOSED', 'WS_ERROR', 'WS_HEARTBEAT_TIMEOUT', 'CONNECTION_TIMEOUT',
])
const TRANSIENT_CLOSE_CODES = new Set([1006, 1011])
const ACCOUNT_CREATION_SECRET_FIELDS = new Set([
    'password', 'ig_password', 'phone', 'phone_number', 'formatted_phone',
    'order_id', 'smspool_order_id', 'code', 'sms_code', 'smspool_api_key',
    'textverified_api_key', 'textverified_api_username',
])

function isTransientWsError(err, client) {
    if (!err || (client && client.abortRequested)) return false
    if (err.code === 'WS_CLOSED') {
        if (err.closeCode === 1000) return false
        return err.closeCode == null || TRANSIENT_CLOSE_CODES.has(err.closeCode)
    }
    return TRANSIENT_WS_CODES.has(err.code)
}

function shouldRetryWsModule(moduleId, err, client, attempt, maxAttempts) {
    return (
        !NON_IDEMPOTENT_WS_MODULES.has(canonicalModuleId(moduleId))
        && attempt < maxAttempts
        && isTransientWsError(err, client)
    )
}

function isUncertainNonIdempotentWsOutcome(moduleId, err, client) {
    return (
        NON_IDEMPOTENT_WS_MODULES.has(canonicalModuleId(moduleId))
        && !(client && client.abortRequested)
        && err?.transportFailure === true
        && err?.moduleStartSent === true
    )
}

function accountCreationOutcomeUncertain() {
    return {
        success: false,
        code: 'ACCOUNT_CREATION_OUTCOME_UNCERTAIN',
        error: 'Connection dropped during account creation. Do not run it again yet. Check the phone and Instagram account switcher, then reconcile the active SMSPool order before retrying.',
        data: {
            retryable: false,
            uncertain_outcome: true,
            manual_action_required: true,
        },
    }
}

function sanitizeAccountCreationPhoneMessage(value, secretValues = []) {
    let message = String(value == null ? '' : value)
    for (const secret of secretValues) {
        if (secret) message = message.split(secret).join('[redacted]')
    }
    return message
        .replace(/(\b(?:order[_\s-]*id|sms[_\s-]*code|phone(?:[_\s-]*(?:number|no))?|(?:ig[_\s-]*)?password|(?:(?:smspool|textverified)[_\s-]*)?api[_\s-]*(?:key|username))\b\s*["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[redacted]')
        .replace(/\+?\d(?:[\s()-]*\d){7,}/g, '[redacted phone]')
        .replace(/(\border(?:\s+id)?\s*[=:]?\s*)[A-Z0-9_-]{5,}/gi, '$1[redacted]')
        .replace(/(\b(?:got|entering|typing)\s+(?:sms\s+)?code\s+)[^\s,)]+/gi, '$1[redacted]')
        .replace(/(\bpassword\s*[=:]\s*)[^\s,;}]+/gi, '$1[redacted]')
}

function parseAccountCreationOrderMarker(value) {
    const encoded = String(value || '').match(/^account-recovery-order-secret:([A-Za-z0-9_-]+)$/)?.[1]
    if (!encoded) return null
    try {
        const decoded = Buffer.from(encoded, 'base64url')
        if (!decoded.length || decoded.length > 256 || decoded.toString('base64url') !== encoded) return null
        const orderId = decoded.toString('utf8')
        if (Buffer.from(orderId, 'utf8').compare(decoded) !== 0 || /[\s\x00-\x1f\x7f]/.test(orderId)) return null
        return orderId
    } catch (_) {
        return null
    }
}

function sanitizeAccountCreationPhoneResult(result) {
    if (!result || typeof result !== 'object') return result
    const secrets = []
    const isStatusCode = (depth, key, value) => (
        depth === 0
        && String(key).toLowerCase() === 'code'
        && typeof value === 'string'
        && /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(value)
    )
    const collect = (value, depth = 0) => {
        if (Array.isArray(value)) {
            for (const item of value) collect(item, depth + 1)
            return
        }
        if (!value || typeof value !== 'object') return
        for (const [key, item] of Object.entries(value)) {
            if (ACCOUNT_CREATION_SECRET_FIELDS.has(String(key).toLowerCase()) && !isStatusCode(depth, key, item)) {
                if (typeof item === 'string' || typeof item === 'number') secrets.push(String(item))
            } else {
                collect(item, depth + 1)
            }
        }
    }
    collect(result)
    const clean = (value, depth = 0) => {
        if (typeof value === 'string') return sanitizeAccountCreationPhoneMessage(value, secrets)
        if (Array.isArray(value)) return value.map(item => clean(item, depth + 1))
        if (!value || typeof value !== 'object') return value
        const output = {}
        for (const [key, item] of Object.entries(value)) {
            if (ACCOUNT_CREATION_SECRET_FIELDS.has(String(key).toLowerCase()) && !isStatusCode(depth, key, item)) continue
            output[key] = clean(item, depth + 1)
        }
        return output
    }
    return clean(result)
}

// Local-brain liveness tracking. Used to make a SILENT fall-through to
// Railway (when the brain we expected at boot, or were just using a
// moment ago, has gone away) LOUD via a one-time IPC event so the
// renderer can show a toast instead of users guessing why latency
// suddenly tripled.
let localBrainEverConnected = false
let brainDisconnectedEmitted = false
let localBrainLastOkAt = 0
let localBrainLastErrorAt = 0

// Complete list of WebSocket-enabled modules
// Keep in sync with server.py WS_MODULE_HANDLERS
const WS_ENABLED_MODULES = [
    // Core Instagram
    'engagement', 'post_feed', 'post_reel', 'post_trial_reel',
    'post_story', 'follow', 'unfollow', 'view_stories', 'ig_repost',
    'comment', 'dm_automation',
    // Engagement variants
    'reels_engagement', 'feed_engagement', 'hashtag_engagement', 'explore_engagement',
    // Account management
    'account_validator', 'validate_current', 'validate_all', 'account_creation', 'account_creation_phone',
    'ig_login',
    'edit_profile',
    // Profile management utilities
    'profile_rename',
    // Gmail
    'gmail_login',
    // Threads
    'threads_post', 'threads_engage',
    // TikTok
    'tiktok_post', 'tiktok_engage',
    // Twitter/X
    'twitter_post', 'twitter_engage',
    // Reddit
    'reddit_post', 'reddit_batch_post', 'reddit_edit_profile',
    // Content & Sync (push_content uses the renderer's local bridge)
    'drive_sync',
    // Droidrun bridge
    'droidrun_shadowphone_bootstrap',
    'droidrun_portal_ping',
    'droidrun_portal_auth_token',
    'droidrun_portal_state',
    'droidrun_portal_configure_reverse',
    'droidrun_portal_enable_local_api',
]

const MODULE_ID_ALIASES = {
    story_viewer: 'view_stories',
    repost: 'ig_repost',
}

function canonicalModuleId(moduleId) {
    return MODULE_ID_ALIASES[moduleId] || moduleId
}

function accountCreationBrokerRequired(moduleId) {
    if (!['account_creation', 'account_creation_phone'].includes(canonicalModuleId(moduleId))) return null
    return {
        success: false,
        code: 'ACCOUNT_CREATION_BROKER_REQUIRED',
        error: 'Open Create Account to choose your SMS provider and spending limit before starting signup.',
    }
}

function validateWsModuleRequest(config) {
    const moduleId = canonicalModuleId(config && config.moduleId)
    if (typeof moduleId === 'string' && WS_ENABLED_MODULES.includes(moduleId)) return null
    return {
        success: false,
        code: 'WS_MODULE_NOT_ALLOWED',
        error: `Module ${String(moduleId || 'unknown')} is not available over WebSocket`,
    }
}

/**
 * Initialize module handlers with dependencies
 */
function initModuleHandlers(options) {
    mainWindow = options.mainWindow
    executeADB = options.executeADB
    ModuleWebSocketClient = options.ModuleWebSocketClient
    MODULES_SERVER_URL = options.serverUrl
    MODULES_API_SECRET = options.apiSecret
    MODULES_PATH = options.modulesPath
    getModuleToken = options.getModuleToken
    getCurrentUserSession = options.getCurrentUserSession
    app = options.app

    registerModuleHandlers()
}

/**
 * Execute a single ADB action from module
 */
async function executeAction(deviceId, action) {
    switch (action.type) {
        case 'tap':
            await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(action.x), String(action.y)])
            break
        case 'swipe':
            await executeADB(['-s', deviceId, 'shell', 'input', 'swipe',
                String(action.x1), String(action.y1), String(action.x2), String(action.y2),
                String(action.duration || 300)])
            break
        case 'input': {
            const escapedText = String(action.text || '').replace(/(["'`\\$!&*()[\]{}|;<>?])/g, '\\$1').replace(/ /g, '%s')
            await executeADB(['-s', deviceId, 'shell', 'input', 'text', escapedText])
            break
        }
        case 'keyevent':
            await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', String(action.keycode)])
            break
        case 'launch':
            await executeADB(['-s', deviceId, 'shell', 'monkey', '-p', action.package, '-c',
                'android.intent.category.LAUNCHER', '1'])
            break
        case 'shell':
            if (!action.command || typeof action.command !== 'string') { console.warn('[Module] shell action missing command:', action); break }
            await executeADB(['-s', deviceId, 'shell', action.command])
            break
        case 'wait':
            await new Promise(resolve => setTimeout(resolve, action.ms))
            break
        case 'screenshot': {
            const timestamp = Date.now()
            const localPath = path.join(app.getPath('temp'), `screenshot_${timestamp}.png`)
            await executeADB(['-s', deviceId, 'shell', 'screencap', '-p', '/sdcard/screenshot.png'])
            await executeADB(['-s', deviceId, 'pull', '/sdcard/screenshot.png', localPath])
            await executeADB(['-s', deviceId, 'shell', 'rm', '/sdcard/screenshot.png'])
            return { path: localPath }
        }
        default:
            break
    }

    if (action.delay && action.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, action.delay))
    }

    return null
}

/**
 * Register all module-related IPC handlers
 */
function registerModuleHandlers() {
    // Get list of available modules
    ipcMain.handle('get-modules', async () => {
        try {
            const modulesPath = path.join(__dirname, '..', '..', 'lib', 'desktop', 'modules.json')
            const modulesJson = require(modulesPath)
            return modulesJson.modules
        } catch (error) {
            console.error('[Module] Error loading modules:', error)
            return []
        }
    })

    // Current Brain dispatch path. Backs the topbar status pill so users can
    // SEE whether the brain is up, starting, or down — and act on it.
    //
    // States:
    //   'local'        — local brain endpoint is up and posting will run there
    //   'starting'     — process is alive but the port hasn't bound yet
    //                    (cold-start window; pill shows amber spinner)
    //   'down'         — local brain was expected to be up and isn't. Brain-
    //                    required modules will hard-fail. Pill shows a
    //                    Restart button and a hint based on exitReason.
    //   'no-python'    — Python runtime missing on the user's machine.
    //                    Pill shows an "Install Python 3.11" external link.
    ipcMain.handle('brain:get-status', () => {
        let endpoint = null
        let exitReason = null
        let snapshot = null
        try {
            const localBrain = require('../lib/local-brain')
            endpoint = localBrain.getLocalBrainEndpoint()
            if (typeof localBrain.getBrainExitReason === 'function') {
                exitReason = localBrain.getBrainExitReason() || null
            }
            if (typeof localBrain.getBrainHealthSnapshot === 'function') {
                snapshot = localBrain.getBrainHealthSnapshot()
            }
        } catch (e) {
            // Module load failure is treated the same as "no endpoint" below.
        }

        if (endpoint && endpoint.host) {
            return {
                state: 'local',
                detail: `Connected to local brain at ${endpoint.httpUrl}`,
                lastOkAt: localBrainLastOkAt || Date.now(),
                lastErrorAt: localBrainLastErrorAt || undefined,
                endpoint: endpoint.httpUrl,
                exitReason,
                snapshot,
                canRestart: true,
            }
        }

        // RECONNECTING: brain was healthy in the last 30s but the current
        // probe came up null. Route through the existing 'starting' state
        // (amber pill + spinner) so the UI doesn't flap red/green every
        // few seconds on transient probe failures. The actual brain may
        // be perfectly alive (mid-respawn, antivirus delaying loopback,
        // load spike); the user just doesn't need to see a red alarm
        // until it's been genuinely gone 30s+. Field-reported issue:
        // operators saw brain status flap "down/online" for users with
        // antivirus or slow loopback on the Brain port.
        const recentlyOk = localBrainLastOkAt && (Date.now() - localBrainLastOkAt) < 30000
        if (recentlyOk) {
            return {
                state: 'starting',
                detail: 'Brain briefly missed a health check — holding the connection. Common during heavy module runs or with antivirus on loopback.',
                lastOkAt: localBrainLastOkAt,
                lastErrorAt: localBrainLastErrorAt || undefined,
                endpoint: undefined,
                exitReason,
                snapshot,
                canRestart: true,
            }
        }

        // STARTING: process is alive (we just haven't seen a healthy probe
        // yet). This is the cold-start window — the pill should show amber
        // and a spinner, not a red DOWN alarm. Without this state, the
        // first 5-15s after launch always looked like a failure.
        if (snapshot && snapshot.hasProcess) {
            return {
                state: 'starting',
                detail: 'Local brain is booting (Python imports + Supabase client). This usually takes 8-20s on a warm cache.',
                lastOkAt: localBrainLastOkAt || undefined,
                lastErrorAt: localBrainLastErrorAt || undefined,
                endpoint: undefined,
                exitReason,
                snapshot,
                canRestart: true,
            }
        }

        if (exitReason === 'no_python_runtime') {
            return {
                state: 'no-python',
                detail: 'Python 3.11+ is not installed on this machine. Posting and other brain-only modules cannot run without it.',
                lastOkAt: undefined,
                lastErrorAt: localBrainLastErrorAt || Date.now(),
                endpoint: undefined,
                exitReason,
                snapshot,
                canRestart: false,
                installLink: process.platform === 'darwin'
                    ? 'https://www.python.org/downloads/macos/'
                    : process.platform === 'win32'
                        ? 'https://www.python.org/downloads/windows/'
                        : 'https://www.python.org/downloads/',
            }
        }

        const exitReasonHint = (() => {
            if (exitReason === 'startup_hang') return ' The brain hung during startup. Click Restart Brain to try again.'
            if (exitReason && typeof exitReason === 'string' && exitReason.startsWith('exit code')) return ` Brain process exited (${exitReason}). Click Restart Brain to retry.`
            return ' Click Restart Brain to try again, or open logs for details.'
        })()

        return {
            state: 'down',
            detail: (localBrainEverConnected
                ? 'Local brain was running this session but is now unreachable.'
                : 'Local brain has not started yet.') + exitReasonHint,
            lastOkAt: localBrainLastOkAt || undefined,
            lastErrorAt: localBrainLastErrorAt || Date.now(),
            endpoint: undefined,
            exitReason,
            snapshot,
            canRestart: true,
        }
    })

    // Run module via REST API
    ipcMain.handle('run-module', async (event, config) => {
        const rejection = accountCreationBrokerRequired(config?.moduleId)
        if (rejection) return {
            id: config.runId, moduleId: config.moduleId, status: 'failed', logs: [], progress: 0, result: rejection,
        }
        const { runId, moduleId, deviceId, profileId, config: moduleConfig } = config
        const userSession = getCurrentUserSession()

        console.log(`[Module] Starting ${moduleId} (${runId}) via server API`)

        if (!userSession.userId) {
            console.warn('[Module] No user session - running as anonymous (limited quota)')
        }

        const runState = {
            aborted: false,
            logs: [],
            startTime: new Date()
        }
        runningModules.set(runId, runState)

        try {
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MODULES_API_SECRET}`,
            }
            if (userSession.sessionToken) {
                headers['X-Clerk-Token'] = userSession.sessionToken
            }

            const response = await fetch(`${MODULES_SERVER_URL}/execute`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    userId: userSession.userId || 'anonymous',
                    email: userSession.email || 'anonymous@local',
                    moduleId,
                    deviceId,
                    profileId,
                    config: moduleConfig,
                    clientVersion: app.getVersion()
                })
            })

            // Handle quota exceeded
            if (response.status === 429) {
                const error = await response.json()
                console.log('[Module] Quota exceeded:', error)

                if (mainWindow) {
                    mainWindow.webContents.send('quota-exceeded', {
                        runsToday: error.runs_today,
                        runsLimit: error.runs_limit,
                        plan: error.plan
                    })
                }

                runningModules.delete(runId)
                return {
                    id: runId,
                    moduleId,
                    status: 'failed',
                    logs: [],
                    progress: 0,
                    result: { success: false, error: `Daily limit reached (${error.runs_today}/${error.runs_limit}). Upgrade your plan for more runs.` }
                }
            }

            // Handle subscription expired
            if (response.status === 403) {
                const error = await response.json()
                console.log('[Module] Subscription expired:', error)

                if (mainWindow) {
                    mainWindow.webContents.send('subscription-expired', {
                        wasTrial: error.was_trial,
                        plan: error.plan,
                        message: error.message
                    })
                }

                runningModules.delete(runId)
                return {
                    id: runId,
                    moduleId,
                    status: 'failed',
                    logs: [],
                    progress: 0,
                    result: { success: false, error: error.was_trial ? 'Your free trial has expired. Please subscribe to continue.' : 'Your subscription has expired. Please renew to continue.' }
                }
            }

            if (!response.ok) {
                const error = await response.json()
                throw new Error(error.error || error.detail || `Server returned ${response.status}`)
            }

            const { actions, metadata, quota } = await response.json()
            console.log(`[Module] Received ${actions.length} actions for ${moduleId}`)

            if (quota) {
                console.log(`[Module] Quota: ${quota.remaining} runs remaining today`)
            }

            let result = null

            for (const action of actions) {
                if (runState.aborted) {
                    console.log(`[Module] Aborted ${runId}`)
                    break
                }

                if (action.type === 'progress') {
                    const progressLog = { type: 'progress', percent: action.percent, message: action.message }
                    runState.logs.push(progressLog)
                    sendModuleProgress({ runId, ...progressLog })
                    continue
                }

                if (action.type === 'complete') {
                    result = action
                    continue
                }

                try {
                    await executeAction(deviceId, action)
                    runState.logs.push({ type: 'action', action: action.type, success: true })
                } catch (actionError) {
                    console.error(`[Module] Action failed:`, actionError)
                    runState.logs.push({ type: 'action', action: action.type, success: false, error: actionError.message })
                }
            }

            const endTime = new Date()
            runningModules.delete(runId)

            return {
                id: runId,
                moduleId,
                status: runState.aborted ? 'aborted' : (result?.success ? 'completed' : 'failed'),
                logs: runState.logs,
                progress: result?.success ? 100 : 0,
                startTime: runState.startTime,
                endTime,
                result: result ? {
                    success: result.success,
                    data: result.data,
                    error: result.error
                } : {
                    success: false,
                    error: 'No result from server'
                }
            }

        } catch (error) {
            console.error(`[Module] Server execution failed for ${moduleId}:`, error)
            runningModules.delete(runId)

            return {
                id: runId,
                moduleId,
                status: 'failed',
                logs: runState.logs,
                progress: 0,
                startTime: runState.startTime,
                endTime: new Date(),
                result: {
                    success: false,
                    error: error.message
                }
            }
        }
    })

    // Abort a running module
    ipcMain.handle('abort-module', async (event, runId) => {
        // If no runId, abort ALL running modules
        if (!runId) {
            let aborted = 0
            for (const [id, state] of runningModules.entries()) {
                console.log(`[Module] Aborting ${id}`)
                state.aborted = true
                if (state.process) state.process.kill('SIGTERM')
                aborted++
            }
            // Also abort all WS modules
            for (const [id, client] of activeWsModules.entries()) {
                console.log(`[WS-Module] Aborting ${id}`)
                client.abort()
                aborted++
            }
            console.log(`[Module] Aborted ${aborted} running modules`)
            return aborted > 0
        }

        const runState = runningModules.get(runId)
        if (!runState) {
            // Try WS modules
            const wsClient = activeWsModules.get(runId)
            if (wsClient) {
                console.log(`[WS-Module] Aborting ${runId}`)
                wsClient.abort()
                return true
            }
            return false
        }

        console.log(`[Module] Aborting ${runId}`)
        runState.aborted = true

        if (runState.process) {
            runState.process.kill('SIGTERM')
        }

        return true
    })

    // Run module via WebSocket
    // Hold the per-phone busy lock for the WHOLE run (incl. retries) so the
    // schedule engine's tick skips this phone — stops a scheduled slot from
    // switching the Android user mid-run (e.g. mid account-creation). Never
    // Paid account creation fails closed if another owner has this phone. Bulk
    // creation passes its already-owned lock through the main-process-only path.
    async function runModuleWs(config, phoneLockOwnerToken = null, internalHooks = {}) {
        const rejection = validateWsModuleRequest(config)
        if (rejection) return rejection

        // Mark the fleet busy the instant a run is requested — BEFORE the
        // up-to-45s brain-ready wait inside _runModuleWsLocked, which is the
        // window the old count-based isBusy() missed.
        bumpActivity()
        const _deviceId = config && config.deviceId
        const _se = (() => { try { return require('../lib/schedule-engine') } catch { return null } })()
        if (!_se) {
            return { success: false, code: 'SCHEDULE_ENGINE_UNAVAILABLE', error: 'Phone execution coordinator is unavailable' }
        }
        const phoneLockAlreadyOwned = Boolean(
            phoneLockOwnerToken
            && typeof _se.isPhoneLockOwnerToken === 'function'
            && _se.isPhoneLockOwnerToken(phoneLockOwnerToken, _deviceId)
        )
        const _releasePhoneLock = (!phoneLockAlreadyOwned && _deviceId) ? _se.acquirePhoneLock(_deviceId) : null
        if (_deviceId && !phoneLockAlreadyOwned && !_releasePhoneLock) {
            return {
                success: false,
                code: 'PHONE_BUSY',
                error: 'This phone is already running another automation. The requested module was not started.',
                ...(canonicalModuleId(config.moduleId) === 'account_creation_phone'
                    ? { data: { credential_reservation_release_safe: true, paid_order_created: false, retryable: true } }
                    : {}),
            }
        }
        const runState = _se.createModuleRunAbortState()
        activeWsModules.set(config.runId, runState)
        try {
            return await _runModuleWsLocked(config, runState, internalHooks)
        } finally {
            if (activeWsModules.get(config.runId) === runState) activeWsModules.delete(config.runId)
            if (_releasePhoneLock) _releasePhoneLock()
            lastRunEndedAt = Date.now()
        }
    }
    async function _runModuleWsLocked(config, runState, internalHooks = {}) {
        const { runId, moduleId, deviceId, profileId, moduleConfig } = config
        const userSession = getCurrentUserSession()
        const abortedResult = () => ({ success: false, code: 'MODULE_ABORTED', error: 'Module was aborted' })

        if (runState.aborted) return abortedResult()

        console.log(`[WS-Module] Starting: ${moduleId} on ${deviceId} (run=${runId})`)

        // Prefer local Python brain on localhost:8090 (zero Railway latency,
        // no per-run cost). Falls back to Railway WS if local brain isn't
        // ready yet or never started (no Python on user's machine + no
        // bundled binary). The brain's auth secret is generated per-app-boot
        // and only lives in main-process memory + the subprocess env.
        let serverUrl = null
        let authToken = null
        let authType = null
        let usingLocalBrain = false
        let localEndpointWasNull = false
        // Posting modules can't run on Railway safely — block briefly for the
        // brain to finish its async boot rather than giving up on the first
        // null endpoint (which a schedule firing during cold-start would hit).
        const brainRequired = BRAIN_REQUIRED_MODULES.has(canonicalModuleId(moduleId))
        try {
            const localBrainMod = require('../lib/local-brain')
            let localBrain = localBrainMod.getLocalBrainEndpoint()
            if (!localBrain && brainRequired && typeof localBrainMod.waitForLocalBrain === 'function') {
                console.log(`[WS-Module] ${moduleId} requires the local brain — waiting for it to come up...`)
                localBrain = await localBrainMod.waitForLocalBrain(45_000)
                if (runState.aborted) return abortedResult()
            }
            if (localBrain && localBrain.secret) {
                serverUrl = localBrain.wsUrl
                authToken = localBrain.secret
                authType = 'secret'
                usingLocalBrain = true
                localBrainEverConnected = true
                localBrainLastOkAt = Date.now()
                console.log(`[WS-Module] Using LOCAL brain at ${serverUrl}`)
            } else {
                localEndpointWasNull = true
                localBrainLastErrorAt = Date.now()
            }
        } catch (e) {
            localEndpointWasNull = true
            localBrainLastErrorAt = Date.now()
            console.warn('[WS-Module] Local brain lookup failed:', e?.message || e)
        }

        if (localEndpointWasNull && !brainDisconnectedEmitted) {
            // Either we were just using the brain and it vanished (disconnect)
            // or it never came up at all (never-connected). Either way the
            // user deserves a visible signal — the actual Railway fallback
            // still runs below, but silently masking 17 versions of broken
            // local exec is exactly the bug class we're killing.
            const reason = localBrainEverConnected ? 'endpoint-null' : 'never-connected'
            const payload = { reason, firstSeenAt: Date.now() }
            console.error('[WS-Module] brain-disconnected', payload)
            if (mainWindow && !mainWindow.isDestroyed()) {
                try {
                    mainWindow.webContents.send('brain-disconnected', payload)
                } catch (_) {}
            }
            brainDisconnectedEmitted = true
        }

        if (!serverUrl && brainRequired) {
            // Posting modules never fall back to Railway. The local brain is
            // the only correct target — relaying a post through a down/stale
            // Railway service is what produced the 502 the user hit. Hard-fail
            // with an actionable error so the schedule surfaces it instead of
            // silently mis-posting.
            const localBrainMod = (() => {
                try { return require('../lib/local-brain') } catch { return null }
            })()
            const exitReason = localBrainMod && typeof localBrainMod.getBrainExitReason === 'function'
                ? localBrainMod.getBrainExitReason()
                : null
            // Surface the port-occupied case with concrete fix-it instructions.
            // Generic "Wait a few seconds" was masking the actual cause for
            // users hitting the orphan-on-8090 crash loop.
            const portMatch = exitReason && exitReason.match(/^port_\d+_in_use:(.*)$/)
            const hint = portMatch
                ? ` Port 8090 is held by a zombie process${portMatch[1] && portMatch[1] !== 'unknown' ? ` (PID ${portMatch[1]})` : ''} that ShadowPhone cannot kill. Fix: open an elevated Command Prompt and run "taskkill /F /PID ${portMatch[1] && portMatch[1] !== 'unknown' ? portMatch[1] : '<the PID from Task Manager → server.exe>'}", or restart your computer.`
                : exitReason === 'no_python_runtime'
                    ? ' No Python 3 runtime was found — install Python 3.11+ and relaunch.'
                    : exitReason === 'startup_hang'
                        ? ' The brain hung during startup — quit the app from the system tray and relaunch.'
                        : ' Wait a few seconds for the local brain to start, then retry.'
            console.error(`[WS-Module] ${moduleId} requires the local brain but it is unavailable (exitReason=${exitReason}).`)
            return {
                success: false,
                code: 'LOCAL_BRAIN_UNAVAILABLE',
                error: `Posting must run on the local brain, which isn't reachable right now.${hint}`,
                ...(canonicalModuleId(moduleId) === 'account_creation_phone'
                    ? { data: { credential_reservation_release_safe: true, paid_order_created: false, retryable: true } }
                    : {}),
            }
        }

        if (!serverUrl) {
            // Fall back to Railway-configured WS server
            if (!MODULES_SERVER_URL) {
                return {
                    success: false,
                    error: 'No module server available (local brain not running, Railway URL not configured).'
                }
            }
            const jwtToken = await getModuleToken()
            if (!jwtToken && !MODULES_API_SECRET) {
                return {
                    success: false,
                    error: 'Not authenticated. Please log in to run modules.'
                }
            }
            serverUrl = MODULES_SERVER_URL
            authToken = jwtToken || MODULES_API_SECRET
            authType = jwtToken ? 'jwt' : 'secret'
            console.log(`[WS-Module] Using RAILWAY fallback at ${serverUrl}`)
        }

        if (runState.aborted) return abortedResult()

        const userId = userSession?.userId || 'anonymous'

        // Up to 2 total attempts: a fresh ModuleWebSocketClient re-opens the WS,
        // so attempt 2 recovers from a transient teardown of attempt 1. Bounded —
        // never loops on a genuine module failure or a clean close.
        const MAX_ATTEMPTS = 2
        const RETRY_BACKOFF_MS = 1500
        let lastError = null

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (runState.aborted) return abortedResult()
            const client = new ModuleWebSocketClient(serverUrl, authToken, authType)
            if (!runState.setClient(client)) return abortedResult()
            // Tag the client so post-run telemetry can attribute timing differences
            // between local-brain and Railway-fallback runs.
            client.__usingLocalBrain = usingLocalBrain

            try {
                const result = await client.runModule(
                    moduleId,
                    deviceId,
                    profileId,
                    moduleConfig || {},
                    userId,
                    {
                        onProgress: (percent, message) => {
                            const accountCreation = canonicalModuleId(moduleId) === 'account_creation_phone'
                            const privateOrderMarker = accountCreation
                                && String(message || '').startsWith('account-recovery-order-secret:')
                            const orderId = privateOrderMarker
                                ? parseAccountCreationOrderMarker(message)
                                : null
                            if (orderId) {
                                try { internalHooks.onAccountCreationOrder?.(orderId) } catch (_) {}
                            }
                            const safeMessage = privateOrderMarker
                                ? 'SMSPool order reserved for protected recovery.'
                                : accountCreation
                                    ? sanitizeAccountCreationPhoneMessage(message)
                                    : message
                            sendModuleProgress({
                                runId,
                                moduleId,
                                deviceId,
                                profileId,
                                type: 'progress',
                                percent,
                                message: safeMessage,
                                status: 'progress',
                            })
                        },
                        onLog: (log) => {
                            const safeLog = canonicalModuleId(moduleId) === 'account_creation_phone'
                                ? sanitizeAccountCreationPhoneMessage(log)
                                : log
                            console.log(`[WS-Module] ${safeLog}`)
                            sendModuleProgress({
                                runId,
                                moduleId,
                                deviceId,
                                profileId,
                                type: 'log',
                                message: safeLog,
                            })
                        }
                    }
                )

                const safeResult = canonicalModuleId(moduleId) === 'account_creation_phone'
                    ? sanitizeAccountCreationPhoneResult(result)
                    : result

                console.log(`[WS-Module] Complete: ${moduleId} success=${safeResult.success}${safeResult.success ? '' : ' error=' + (safeResult.error || safeResult.message || 'unknown')}`)

                // 2.18.14: include error/message/code so the renderer can show a useful
                // toast on failure. Previously this stripped result.error and the
                // sidebar's "create failed: ' + r.error" rendered as "create failed: unknown".
                return {
                    success: safeResult.success,
                    data: safeResult.data,
                    logs: safeResult.logs,
                    error: safeResult.error || safeResult.message,
                    code: safeResult.code,
                }

            } catch (error) {
                lastError = error
                if (runState.aborted) return abortedResult()
                const transient = isTransientWsError(error, client)
                if (isUncertainNonIdempotentWsOutcome(moduleId, error, client)) {
                    console.error(`[WS-Module] Transport ended after non-idempotent ${moduleId} started; automatic replay blocked.`)
                    return accountCreationOutcomeUncertain()
                }
                if (shouldRetryWsModule(moduleId, error, client, attempt, MAX_ATTEMPTS)) {
                    console.warn(`[WS-Module] Transient WS teardown on ${moduleId} (code=${error.code}${error.closeCode != null ? ' close=' + error.closeCode : ''}), retrying ${attempt + 1}/${MAX_ATTEMPTS} after ${RETRY_BACKOFF_MS}ms: ${error.message}`)
                    if (runState.aborted) return abortedResult()
                    await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS))
                    if (runState.aborted) return abortedResult()
                    continue
                }
                const safeError = canonicalModuleId(moduleId) === 'account_creation_phone'
                    ? sanitizeAccountCreationPhoneMessage(error.message)
                    : error.message
                console.error(`[WS-Module] Error: ${moduleId}`, safeError)
                if (canonicalModuleId(moduleId) === 'account_creation_phone') {
                    const details = error.details && typeof error.details === 'object'
                        ? { ...error.details }
                        : {}
                    if (error.transportFailure === true && error.moduleStartSent === false) {
                        details.credential_reservation_release_safe = true
                        details.paid_order_created = false
                        details.retryable = true
                    }
                    return sanitizeAccountCreationPhoneResult({
                        success: false,
                        error: safeError,
                        code: error.code,
                        data: Object.keys(details).length ? details : null,
                    })
                }
                return {
                    success: false,
                    error: safeError,
                    code: error.code,
                    data: error.details || null,
                }
            } finally {
                runState.clearClient(client)
            }
        }

        // Exhausted retries on a transient failure — surface the last error.
        return {
            success: false,
            error: lastError ? lastError.message : 'Module failed after retries',
            code: lastError ? lastError.code : undefined,
        }
    }
    _runModuleWs = runModuleWs
    ipcMain.handle('run-module-ws', async (event, config) => {
        const rejection = accountCreationBrokerRequired(config?.moduleId)
        return rejection || runModuleWs(config)
    })

    // Abort a running WebSocket module
    ipcMain.handle('abort-module-ws', async (event, runId) => {
        const client = activeWsModules.get(runId)
        if (client) {
            console.log(`[WS-Module] Aborting: ${runId}`)
            client.abort()
            return { success: true }
        }
        return { success: false, error: 'Module not found or already completed' }
    })

    // Check if a module supports WebSocket execution + report which brain
    // (local vs Railway) the WS call will actually land on so the renderer
    // can label the log line honestly.
    ipcMain.handle('check-module-ws-support', async (event, moduleId) => {
        let usingLocalBrain = false
        try {
            const { getLocalBrainEndpoint } = require('../lib/local-brain')
            const localBrain = getLocalBrainEndpoint()
            usingLocalBrain = !!(localBrain && localBrain.secret)
        } catch (_) { /* local brain not available */ }
        return {
            supported: WS_ENABLED_MODULES.includes(canonicalModuleId(moduleId)),
            availableModules: WS_ENABLED_MODULES,
            usingLocalBrain,
        }
    })

    // Run module locally (no Railway, no WebSocket — direct ADB)
    ipcMain.handle('run-module-local', async (event, config) => {
        const { runId, moduleId, deviceId, profileId, moduleConfig } = config

        console.log(`[Local-Module] Starting: ${moduleId} on ${deviceId} (run=${runId})`)

        const handler = LOCAL_MODULE_HANDLERS[moduleId]
        if (!handler) {
            return {
                success: false,
                error: `Module ${moduleId} is not available for local execution`
            }
        }

        const progressFn = (percent, message) => {
            sendModuleProgress({ runId, moduleId, type: 'progress', status: 'progress', percent, message })
        }

        const logFn = (message, level = 'INFO') => {
            console.log(`[Local-Module] [${level}] ${message}`)
            sendModuleProgress({ runId, moduleId, type: 'log', message, level })
        }

        const device = new LocalDevice(deviceId, progressFn, logFn)

        // Inject the IPC-supplied profileId into moduleConfig so handlers can tag
        // outputs (stats snapshots, Airtable rows) with the active desktop profile.
        // Handler-supplied profile_id wins if the scheduler already set it.
        const enrichedConfig = {
            ...(moduleConfig || {}),
            profile_id: (moduleConfig && moduleConfig.profile_id != null) ? moduleConfig.profile_id : profileId,
            run_id: (moduleConfig && moduleConfig.run_id != null) ? moduleConfig.run_id : runId,
            module_id: (moduleConfig && moduleConfig.module_id != null) ? moduleConfig.module_id : moduleId,
        }

        const scheduleEngine = require('../lib/schedule-engine')
        const runState = scheduleEngine.createModuleRunAbortState()
        activeWsModules.set(runId, runState)
        let hardwareRelease = null
        let hardwareTicket = null
        try {
            if (!NON_DEVICE_LOCAL_MODULES.has(moduleId)) {
                const hardwareId = String(device.shell('getprop ro.serialno') || '').trim()
                hardwareTicket = scheduleEngine.acquireModuleRunMutex(hardwareId)
                if (!runState.setTicket(hardwareTicket)) throw Object.assign(new Error('Module was aborted'), { code: 'MODULE_ABORTED' })
                hardwareRelease = await hardwareTicket.wait
                runState.clearTicket(hardwareTicket)
                if (runState.aborted) throw Object.assign(new Error('Module was aborted'), { code: 'MODULE_ABORTED' })
            }

            const result = await handler(device, enrichedConfig)

            console.log(`[Local-Module] Complete: ${moduleId} success=${result.success}`)

            // Auto-flush any queued stats snapshots to Supabase
            const pending = getPendingSnapshots()
            if (pending.length > 0) {
                const userSession = getCurrentUserSession()
                if (userSession?.userId) {
                    // Fire-and-forget — don't block module completion
                    const snapPayload = pending.map(s => ({
                        username: s.username,
                        followers: s.followers,
                        following: s.following,
                        posts: s.posts,
                        source: s.source,
                        profile_id: s.profile_id,
                        run_id: s.run_id,
                        module_id: s.module_id,
                    }))
                    // Upsert, safe to retry. appAuthFetch mints a live token per
                    // request; a persistent 401 throws and is swallowed by the
                    // .catch() below, so this stays fire-and-forget.
                    appAuthFetch('https://www.shadowphone.io/api/analytics/snapshot', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_id: userSession.userId, snapshots: snapPayload }),
                    }, { fallbackToken: userSession.sessionToken || MODULES_API_SECRET || null })
                    .then(r => r.json())
                    .then(r => console.log(`[Stats] Flushed ${r.upserted || 0}/${pending.length} snapshots to Supabase`))
                    .catch(e => console.warn(`[Stats] Flush failed (non-blocking):`, e.message))
                } else {
                    for (const snap of pending) {
                        console.log(`[Stats] @${snap.username}: ${snap.followers}/${snap.following}/${snap.posts} (no user session — skipped flush)`)
                    }
                }
            }

            return {
                success: result.success,
                data: result.data,
                error: result.error,
            }
        } catch (error) {
            console.error(`[Local-Module] Error: ${moduleId}`, error.message)
            return {
                success: false,
                error: error.message,
            }
        } finally {
            hardwareRelease?.()
            if (activeWsModules.get(runId) === runState) activeWsModules.delete(runId)
        }
    })

    // Check if a module supports local execution
    ipcMain.handle('check-module-local-support', async (event, moduleId) => {
        return {
            supported: moduleId in LOCAL_MODULE_HANDLERS,
            availableModules: Object.keys(LOCAL_MODULE_HANDLERS),
        }
    })

    // Detect Instagram accounts on device. Runs the pure-JS LOCAL detect_accounts
    // module against the device — no system Python required (a packaged build with
    // no Python on PATH used to silently return zero accounts here).
    ipcMain.handle('detect-accounts', async (event, deviceId) => {
        let releasePhoneLock = null
        let releaseModuleMutex = null
        try {
            const handler = LOCAL_MODULE_HANDLERS['detect_accounts']
            if (!handler) return []
            const device = new LocalDevice(
                deviceId,
                () => {},
                (message, level = 'INFO') => console.log(`[Detect] [${level}] ${message}`),
            )
            const scheduleEngine = require('../lib/schedule-engine')
            const hardwareId = String(device.shell('getprop ro.serialno') || '').trim()
            scheduleEngine.registerHwSerial(deviceId, hardwareId)
            releasePhoneLock = scheduleEngine.acquirePhoneLock(hardwareId)
            if (!releasePhoneLock) {
                throw Object.assign(
                    new Error('PHONE_BUSY: This phone is already running another automation. Account detection was not started.'),
                    { code: 'PHONE_BUSY' },
                )
            }
            const mutexTicket = scheduleEngine.acquireModuleRunMutex(hardwareId)
            releaseModuleMutex = await mutexTicket.wait
            const result = await handler(device, {})
            if (result && result.success) {
                return result.data?.accounts || []
            }
            console.error('[Detect] Detection failed:', result?.error)
            return []
        } catch (error) {
            if (error?.code === 'PHONE_BUSY') throw error
            console.error('[Detect] Error:', error)
            return []
        } finally {
            releaseModuleMutex?.()
            releasePhoneLock?.()
        }
    })
}

module.exports = {
    initModuleHandlers,
    WS_ENABLED_MODULES,
    LOCAL_MODULE_HANDLERS,
    validateWsModuleRequest,
    shouldRetryWsModule,
    isUncertainNonIdempotentWsOutcome,
    accountCreationOutcomeUncertain,
    sanitizeAccountCreationPhoneMessage,
    sanitizeAccountCreationPhoneResult,
    parseAccountCreationOrderMarker,
    runModuleWs: (config) => validateWsModuleRequest(config) || _runModuleWs(config, null),
    runModuleWsWithExistingPhoneLock: (config, phoneLockOwnerToken, internalHooks) => (
        validateWsModuleRequest(config) || _runModuleWs(config, phoneLockOwnerToken, internalHooks)
    ),
    // Active-run count across this module's OWN registries (run-module REST +
    // run-module-ws). main.js's pollRuntimeQueue idle-check must OR this in,
    // because these maps are invisible to main.js's own runningModules/
    // activeWsModules — otherwise a live WS run can be double-launched.
    getActiveModuleCount: () => runningModules.size + activeWsModules.size,
    // Wall-clock (ms) of the last WS run's true end. main.js's busy predicate
    // applies a post-run grace window off this so no owner-swap fires while IG
    // finishes its final NUX taps.
    getLastRunEndedAt: () => lastRunEndedAt,
    // Wall-clock (ms) of the last fleet activity (run START or profile switch).
    // Covers the pre-run window (switch-profile + brain-ready wait) the
    // count-based busy check misses. bumpActivity is called by profile switches.
    getLastActivityAt: () => lastActivityAt,
    bumpActivity,
}
