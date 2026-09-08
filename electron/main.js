const { app, BrowserWindow, ipcMain, shell, dialog, net, autoUpdater, Notification, session, Menu } = require('electron')
const path = require('path')
const { powerSaveBlocker, safeStorage } = require('electron')
const { spawn } = require('child_process')
const os = require('os')
const fs = require('fs')
const { resolveUpstreamAdbPort } = require('./lib/usb-vps-bridge')

// 3.2.3: pin ShadowPhone's adb to a DEDICATED server port so a different adb
// build elsewhere on the machine (e.g. a system adb in PATH) can NEVER fight ours
// over the default 5037 — that version war ("server version 40 vs client 41")
// made scrcpy mirrors flap open/closed for users who have another adb installed.
// Set BEFORE any adb/scrcpy spawn; every child inherits process.env, so all of
// the app's adb + scrcpy use this port. The VPS bridge still LISTENS on 5037
// (what the remote VPS dials) and forwards to this port. Overridable via env.
process.env.ANDROID_ADB_SERVER_PORT = String(resolveUpstreamAdbPort(process.env.ANDROID_ADB_SERVER_PORT))

// Single-instance lock — a 2nd launch (double-click, auto-updater relaunch)
// would spawn a 2nd brain that collides on :8090 ([Errno 10048] crash-loop).
// Quit the duplicate and just focus the existing window instead.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    try {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    } catch (_) {}
  })
}

// Local content scraper modules
const { DependencyManager } = require('./lib/dependency-manager')
const { LocalDownloader } = require('./lib/local-downloader')
const { LocalFingerprinter } = require('./lib/local-fingerprinter')
const { TikTokTrendFinder } = require('./lib/tiktok-trend-finder-v2')
const { InstagramTrendFinder } = require('./lib/instagram-trend-finder')

// Modular IPC handlers
const { initSystemHandlers, initDeviceHandlers, initProfileHandlers, initModuleHandlers, initContentHandlers, initPortalHandlers, shutdownPortal, initLogcatHandlers } = require('./handlers')
const { runAdb, getAdbProcessStats, shutdownAdbProcesses, reapStaleAdbProcesses } = require('./lib/adb-util')
const { mediaMimeType } = require('./lib/media-mime')

// Canonical device list: richer dedup (mergeByHwSerial + tailnet cache + nicknames/displayName).
const { getConnectedDevices } = require('./handlers/device-handlers')

// WebSocket module client for real-time execution
const { ModuleWebSocketClient } = require('./lib/ws-module-client')

// Initialize local content tools
const dependencyManager = new DependencyManager()
const localDownloader = new LocalDownloader()
const localFingerprinter = new LocalFingerprinter()
const tiktokTrendFinder = new TikTokTrendFinder({ dependencyManager, app })
const instagramTrendFinder = new InstagramTrendFinder({ dependencyManager, app })


// Load environment variables from .env file (development only)
// In production, env vars should be set by the OS/installer, NOT bundled in the app
const envPath = path.join(__dirname, '.env')
if (require('fs').existsSync(envPath)) {
  require('dotenv').config({ path: envPath })
}

let mainWindow
let adbProcess = null
const isDev = process.env.NODE_ENV === 'development'
let schedulePowerSaveBlockerId = null
// Reference-counted "active run" tracking. Start the powerSaveBlocker only
// while at least one module run is in flight; release it the moment the count
// drops back to zero. Keeps the laptop free to sleep / throttle while idle.
let activeRunCount = 0

function acquireActiveRun() {
  activeRunCount += 1
  if (activeRunCount === 1) {
    try {
      if (schedulePowerSaveBlockerId === null) {
        schedulePowerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
        console.log('[PowerSave] Acquired — powerSaveBlocker started')
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.setBackgroundThrottling(false)
      }
    } catch (err) {
      console.warn('[PowerSave] Failed to acquire:', err?.message || err)
    }
  }
  return activeRunCount
}

function releaseActiveRun() {
  if (activeRunCount > 0) activeRunCount -= 1
  if (activeRunCount === 0) {
    try {
      if (schedulePowerSaveBlockerId !== null && powerSaveBlocker.isStarted(schedulePowerSaveBlockerId)) {
        powerSaveBlocker.stop(schedulePowerSaveBlockerId)
      }
      schedulePowerSaveBlockerId = null
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.setBackgroundThrottling(true)
      }
      console.log('[PowerSave] Released — powerSaveBlocker stopped')
    } catch (err) {
      console.warn('[PowerSave] Failed to release:', err?.message || err)
    }
  }
  return activeRunCount
}

// ==================== CLERK AUTH: THIRD-PARTY COOKIE FIX ====================
// Electron 40+ (Chromium 130+) blocks third-party cookies by default.
// Clerk's auth SDK needs cookies from clerk.accounts.dev / clerk.{domain},
// which are "third-party" relative to the loaded shadowphone.io origin.
// Without this flag, Clerk's isLoaded never becomes true and SignIn renders empty.
app.commandLine.appendSwitch('disable-features', 'ThirdPartyCookiePhaseout,TrackingProtection3pcd,CalculateNativeWinOcclusion')
// ↑ CalculateNativeWinOcclusion: Chromium's native window-occlusion detector wrongly
// marks the frameless, always-on-top, OWNED (docked-to-scrcpy) mirror toolbar +
// loading overlay as "occluded" and SUPPRESSES their paint — the window exists and
// the page finishes loading, but Chromium never composites it, so it renders solid
// BLACK (the "black sidebar"). Disabling occlusion calc forces these child windows
// to always paint. Chromium honors only ONE --disable-features value, so this is
// appended to the SAME list above (a second appendSwitch would overwrite it).

// (NOTE: disable-gpu-compositing was tried for the black sidebar and did NOT fix
// it — capturePage proved the page renders full content but the OWNED window never
// presents. The real fix is in mirror-toolbar.js: stop owner-docking the toolbar to
// scrcpy. So no whole-app GPU-compositing penalty is needed.)

// Module execution state
const runningModules = new Map() // runId -> { process, aborted }
// Planned-run relay state (claims MCP planned runs and executes locally).
const RUNTIME_QUEUE_POLL_INTERVAL_MS = 5000
let runtimeQueueInterval = null
let runtimeQueuePollInFlight = false
let runtimeQueueExecutingRunId = null
// Use bundled modules path (relative to Electron main.js)
const MODULES_PATH = process.env.SHADOWPHONE_MODULES_PATH ||
  path.join(__dirname, 'python')

// Production app URL (canonical host, avoids redirect cookie stripping in main-process fetches)
const APP_URL = process.env.SHADOWPHONE_APP_URL || 'https://www.shadowphone.io'

function buildDesktopAppUrl(url = `${APP_URL}/desktop`) {
  try {
    const parsed = new URL(url)
    const appParsed = new URL(APP_URL)
    if (parsed.origin === appParsed.origin &&
        (parsed.pathname === '/dashboard' || parsed.pathname.startsWith('/dashboard/') ||
         parsed.pathname === '/desktop' || parsed.pathname.startsWith('/desktop/'))) {
      parsed.searchParams.set('_desktop_app_ts', String(Date.now()))
    }
    return parsed.toString()
  } catch {
    return url
  }
}


// Python module server URL (Railway) - Production fallback baked in for distribution
// NOTE: No API secret is baked in! Users must log in via Clerk to get a JWT token.
const MODULES_SERVER_URL = process.env.SHADOWPHONE_MODULES_SERVER || 'https://shadowphone2-production.up.railway.app'

if (isDev) {
  console.log(`[Config] MODULES_SERVER_URL = ${MODULES_SERVER_URL}`)
}

// ==================== USER SESSION STATE ====================
// Stores authenticated user info from Clerk (including session token for API auth)
let currentUserSession = {
  userId: null,
  email: null,
  sessionToken: null,  // Clerk JWT for server-side verification
  authenticatedAt: null
}

// Clerk JWTs live ~60s. Until 2026-07-25 this was a 45s keep-alive that minted
// WITHOUT { skipCache: true } and wrote into a snapshot every handler then read
// synchronously — so the cached token was routinely already expired, and a
// Create IG run died on the raw 401 body ("Unauthorized"). Now the keep-alive
// only warms the snapshot for the remaining synchronous readers; every API call
// mints through getFreshSessionToken() immediately before use.
const { createSessionTokenMinter, _expiresInMs, MINT_TIMEOUT_MS } = require('./lib/session-token-minter')
const { initAppAuth, appAuthFetch } = require('./lib/app-auth-fetch')

const { getFreshSessionToken: mintFreshSessionToken } = createSessionTokenMinter({
  getSession: () => currentUserSession,
  // Same spread merge as the 'set-user-session' IPC — never widen or clear.
  setSession: (token) => {
    currentUserSession = { ...currentUserSession, sessionToken: token }
  },
  mintFromRenderer: async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const tenantId = String(currentUserSession?.userId || '')
    if (!tenantId) return null
    // skipCache:true is the fix for cause B — without it Clerk returns a cached
    // token that can have ~10s of life left, which is shorter than our own
    // freshness window and defeats the whole point of minting.
    return mainWindow.webContents.executeJavaScript(
      `(async () => {
        try {
          const session = window.Clerk?.session
          const userId = window.Clerk?.user?.id
          if (!session || userId !== ${JSON.stringify(tenantId)}) return null
          const token = (await window.Clerk?.session?.getToken?.({ skipCache: true })) || null
          if (window.Clerk?.session?.id !== session.id || window.Clerk?.user?.id !== userId) return null
          return token
        } catch (_) { return null }
      })()`,
      true
    )
  },
})

async function getFreshSessionToken(options) {
  if (!currentUserSession?.userId) await recoverVerifiedSession()
  return mintFreshSessionToken(options)
}

// Warm keep-alive for the synchronous snapshot readers. It rides the minter's
// single-flight now, so a wedged renderer can no longer stack one
// executeJavaScript call per tick forever.
setInterval(() => { void getFreshSessionToken() }, 45_000)

// Install the process-wide authenticated fetch before any handler registers.
initAppAuth({ getFreshSessionToken })

// 2.16.54: expose session + adb helpers on a global so the tray menu's
// "Diagnose phone access" entry can pull them in without circular requires.
global.__sp_mainExports = {
  getCurrentSession: () => currentUserSession,
  // getADBPath isn't declared yet at this point — late-bind via require lookup.
  getAdbPath: () => {
    try { return typeof getADBPath === 'function' ? getADBPath() : null } catch (_) { return null }
  },
}

// ==================== ADMIN ACCESS CONTROL ====================
// Only these emails can access DevTools / inspect element
const ADMIN_EMAILS = [
  'matmannan0010@gmail.com',
  'mannan0010@gmail.com',
  '0mannan0@gmail.com',
  'anyro@shadowphone.io',
  'admin@shadowphone.io'
]

function isAdminUser() {
  return currentUserSession.email &&
    ADMIN_EMAILS.includes(currentUserSession.email.toLowerCase())
}

// ==================== JWT MODULE TOKEN ====================
// Short-lived token for Railway module server authentication
// Fetched from Next.js API, not stored in app code
let moduleToken = {
  token: null,
  expiresAt: 0,
  fetchingPromise: null  // Prevent concurrent fetches
}

// 2.16.18: Crisp removed entirely. Anyro doesn't want the chat widget in
// the desktop app anymore. The block runs unconditionally below in
// createWindow() — every crisp.chat (sub)domain request is cancelled at
// the network layer, so the widget can never render even if the dashboard
// tries to load it.
function blockCrispRequests() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.session.webRequest.onBeforeRequest(
      { urls: ['*://*.crisp.chat/*', '*://crisp.chat/*'] },
      (_details, callback) => callback({ cancel: true })
    )
    console.log('[crisp] all crisp.chat requests blocked at network layer')
  } catch (e) {
    console.warn('[crisp] block install failed:', e?.message || e)
  }
}

/**
 * Get a valid module token for Railway server authentication.
 * Tokens are cached and refreshed 5 minutes before expiry.
 * 
 * @returns {Promise<string|null>} JWT token or null if not authenticated
 */
async function getModuleToken(forceRefresh = false) {
  // Check cached token (refresh 5 min before expiry)
  const now = Math.floor(Date.now() / 1000)
  if (!forceRefresh && moduleToken.token && moduleToken.expiresAt > now + 300) {
    return moduleToken.token
  }

  // Need Clerk session to fetch module token
  if (!currentUserSession.sessionToken) {
    console.log('[JWT] No session token - user not authenticated')
    return null
  }

  // Prevent concurrent fetches
  if (moduleToken.fetchingPromise) {
    return moduleToken.fetchingPromise
  }

  moduleToken.fetchingPromise = (async () => {
    try {
      // appAuthFetch mints a live Clerk JWT here instead of reusing the snapshot,
      // and retries once on a 401 — a stale token used to silently degrade this
      // into the sessionToken fallbacks below.
      const response = await appAuthFetch(`${APP_URL}/api/module-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!response.ok) {
        console.log(`[JWT] Module token fetch failed: ${response.status}`)
        // Fallback to Clerk session token
        return currentUserSession.sessionToken
      }

      const data = await response.json()
      moduleToken.token = data.token
      moduleToken.expiresAt = data.expiresAt
      console.log(`[JWT] Module token fetched (expires in ${data.expiresIn}s)`)
      return data.token
    } catch (error) {
      console.error('[JWT] Module token fetch error:', error.message)
      // Fallback to Clerk session token
      return currentUserSession.sessionToken
    } finally {
      moduleToken.fetchingPromise = null
    }
  })()

  return moduleToken.fetchingPromise
}

// Clear module token on logout
function clearModuleToken() {
  moduleToken.token = null
  moduleToken.expiresAt = 0
  moduleToken.fetchingPromise = null
}

/**
 * Returns connected/authorized device serials from the latest ADB scan.
 */
function getConnectedDeviceSerials() {
  return connectedDevices
    .filter((device) => device?.status === 'device' && device?.serial)
    .map((device) => String(device.serial))
}

/**
 * Builds the non-auth headers for Next.js API requests. appAuthFetch adds the
 * live __session cookie (and a Bearer only when the caller has no Authorization
 * of its own — the ModuleJWT header below is the authority for queue routes).
 */
function buildAppApiHeaders(extraHeaders = {}) {
  return {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }
}

/**
 * Finalizes a claimed queue run back to the app API.
 */
async function finalizeRuntimeQueueRun(runId, success, result = null, error = null, runtimeToken = null) {
  if (!runId) return
  try {
    await appAuthFetch(`${APP_URL}/api/runtime/queue/complete`, {
      method: 'POST',
      headers: buildAppApiHeaders(
        runtimeToken ? { Authorization: `ModuleJWT ${runtimeToken}` } : {}
      ),
      body: JSON.stringify({ runId, success, result, error }),
    })
  } catch (finalizeError) {
    console.error('[RuntimeQueue] Failed to finalize run:', finalizeError?.message || finalizeError)
  }
}

/**
 * Polls and executes one planned queue run when local runtime is idle.
 */
async function pollRuntimeQueue() {
  if (runtimeQueuePollInFlight || runtimeQueueExecutingRunId) return
  if (!currentUserSession?.userId) return
  if (runningModules.size > 0 || activeWsModules.size > 0) return
  // module-handlers.js keeps its OWN run registries (run-module-ws/REST IPC path)
  // that are invisible to the maps above; gate on them too so a live WS run isn't
  // double-launched as a concurrent run on the same phone (account-ban hazard).
  try {
    if (require('./handlers/module-handlers').getActiveModuleCount() > 0) return
  } catch (_) {}

  const connectedSerials = getConnectedDeviceSerials()

  runtimeQueuePollInFlight = true
  try {
    const runtimeToken = await getModuleToken()
    const claimAttempts = []

    if (connectedSerials.length > 0) {
      claimAttempts.push({
        mode: 'desktop',
        body: { connectedSerials, executionMode: 'desktop' },
      })
    }

    claimAttempts.push({
      mode: 'cloud_worker',
      body: {
        executionMode: 'cloud_worker',
        workerId: `desktop-cloud:${currentUserSession.userId}:${os.hostname()}`,
        leaseSeconds: 120,
      },
    })

    let queuedRun = null
    for (const attempt of claimAttempts) {
      // Non-idempotent claim: appAuthFetch retries ONLY on a 401, which the
      // route returns before it touches the queue, so a retry cannot
      // double-claim a run. Nothing is retried on 5xx/timeout.
      // v3.6.8 made appAuthFetch THROW on a persistent 401 where it previously
      // returned the response, which turned the `continue` below into dead code:
      // one 401 on the desktop claim aborted the whole poll and the cloud_worker
      // attempt was never made. Keep a failed attempt local to that attempt.
      let claimResponse
      try {
        claimResponse = await appAuthFetch(`${APP_URL}/api/runtime/queue/next`, {
          method: 'POST',
          headers: buildAppApiHeaders(
            runtimeToken ? { Authorization: `ModuleJWT ${runtimeToken}` } : {}
          ),
          body: JSON.stringify(attempt.body),
        })
      } catch (error) {
        console.warn(`[RuntimeQueue] ${attempt.mode} claim failed:`, error?.message || error)
        continue
      }

      if (!claimResponse.ok) {
        if (claimResponse.status >= 400) {
          console.warn(`[RuntimeQueue] ${attempt.mode} claim failed with status ${claimResponse.status}`)
        }
        continue
      }

      const claimPayload = await claimResponse.json().catch(() => null)
      if (claimPayload?.run?.runId) {
        queuedRun = claimPayload.run
        break
      }
    }

    if (!queuedRun?.runId || !queuedRun?.moduleId) return

    const runTarget = queuedRun.deviceSerial || queuedRun?.cloud?.connectionUri
    if (!runTarget) {
      await finalizeRuntimeQueueRun(
        queuedRun.runId,
        false,
        null,
        'Queued run has no executable device target',
        runtimeToken
      )
      return
    }

    runtimeQueueExecutingRunId = queuedRun.runId
    console.log(`[RuntimeQueue] Executing ${queuedRun.moduleId} (${queuedRun.runId}) on ${runTarget}`)

    try {
      const executionResult = await executeModuleRun({
        runId: queuedRun.runId,
        moduleId: queuedRun.moduleId,
        deviceId: runTarget,
        profileId: queuedRun.profileId || undefined,
        config: queuedRun.config || {},
      })

      // Fail-closed lock denial: the phone is mid-automation. Leave the run
      // claimed (the server lease expires and a later poll re-claims it once
      // the phone frees up) instead of finalizing it as permanently failed.
      if (executionResult?.result?.code === 'PHONE_BUSY' && executionResult?.result?.retryable) {
        console.log(`[RuntimeQueue] ${queuedRun.runId} deferred — phone busy (lock held by another automation)`)
        return
      }

      const success =
        executionResult?.status === 'completed' ||
        executionResult?.result?.success === true
      const errorMessage = success
        ? null
        : (executionResult?.result?.error || `Run ended with status=${executionResult?.status || 'unknown'}`)

      await finalizeRuntimeQueueRun(
        queuedRun.runId,
        success,
        success ? (executionResult?.result?.data || null) : null,
        errorMessage,
        runtimeToken
      )
    } catch (executionError) {
      await finalizeRuntimeQueueRun(
        queuedRun.runId,
        false,
        null,
        executionError?.message || 'Queued run execution failed',
        runtimeToken
      )
    } finally {
      runtimeQueueExecutingRunId = null
    }
  } catch (error) {
    console.error('[RuntimeQueue] Poll error:', error?.message || error)
  } finally {
    runtimeQueuePollInFlight = false
  }
}

/**
 * Starts background polling for planned runtime queue jobs.
 */
function startRuntimeQueueRelay() {
  if (runtimeQueueInterval) return
  runtimeQueueInterval = setInterval(() => {
    void pollRuntimeQueue()
  }, RUNTIME_QUEUE_POLL_INTERVAL_MS)
  void pollRuntimeQueue()
}

/**
 * Stops background polling for planned runtime queue jobs.
 */
function stopRuntimeQueueRelay() {
  if (runtimeQueueInterval) {
    clearInterval(runtimeQueueInterval)
    runtimeQueueInterval = null
  }
  runtimeQueuePollInFlight = false
  runtimeQueueExecutingRunId = null
}

// Current app version (lazily evaluated after app is ready)
let APP_VERSION = null
function getAppVersion() {
  if (!APP_VERSION) APP_VERSION = app.getVersion()
  return APP_VERSION
}

// Check for updates from our API
async function checkForUpdates() {
  try {
    const platform = os.platform() === 'darwin' ? 'mac' : 'windows'
    const version = getAppVersion()
    const url = `${APP_URL}/api/updates/check?platform=${platform}&version=${version}&arch=${process.arch}`
    const response = await fetch(url, { redirect: 'follow' })

    // Guard against HTML redirect pages (non-JSON responses)
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      console.warn('[Update] Non-JSON response, skipping:', contentType)
      return { hasUpdate: false }
    }

    const data = await response.json()

    if (data.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
      console.log(`[Update] New version available: ${data.latestVersion} (current: ${version})`)
      mainWindow.webContents.send('update-available', {
        currentVersion: version,
        latestVersion: data.latestVersion,
        downloadUrl: data.downloadUrl,
        changelog: data.changelog,
        fileSize: data.fileSize
      })
    }

    return data
  } catch (error) {
    console.error('[Update] Check failed:', error?.message || error)
    return { hasUpdate: false }
  }
}

// Store for connected devices
let connectedDevices = []

// ==================== DEVICE SCAN FAILURE TRACKING ====================
// New-device detection (saved list, alerted set, previousDeviceSerials, sync
// gate) is owned entirely by electron/handlers/device-handlers.js; main.js's
// monitor below delegates to handlers.{seedDeviceSerials, savedDevicesReady,
// checkForNewDevices}. The old local copies here were orphaned by that move.
//
// Consecutive adb-enumeration failures. getConnectedDevices() returns a `null`
// sentinel on a transient adb error (vs [] for a genuinely empty fleet). We
// keep the last-good list on screen until N back-to-back failures, so a single
// flaky `adb devices` poll doesn't flash the whole fleet offline (and doesn't
// reset the seeded serials, which would re-fire new-device popups fleet-wide
// on the next good poll).
let consecutiveDeviceScanFailures = 0
const DEVICE_SCAN_FAILURE_LIMIT = 3

function createWindow() {
  const _cwSentinel = (tag, extra) => {
    try {
      const fs = require('fs'); const path = require('path')
      const dir = path.join(app.getPath('userData'), 'logs')
      try { fs.mkdirSync(dir, { recursive: true }) } catch { /* */ }
      fs.appendFileSync(path.join(dir, 'brain.log'),
        `[${new Date().toISOString()}] createWindow step: ${tag}${extra ? ' :: ' + extra : ''}\n`)
    } catch { /* swallow */ }
  }
  _cwSentinel('cw-entry')
  // Lock the window title to a desktop-only string so users can never
  // confuse the Electron app with a browser tab pointing at shadowphone.io.
  // The web page's <title> can't override this once page-title-updated is
  // prevent-defaulted below.
  const APP_VERSION = require('./package.json').version
  const FIXED_TITLE = `ShadowPhone Desktop · v${APP_VERSION}`
  _cwSentinel('cw-before-BrowserWindow', `version=${APP_VERSION}`)

  mainWindow = new BrowserWindow({
    title: FIXED_TITLE,
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    show: false, // Don't show until ready
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // backgroundThrottling defaults to true (Chromium default) so the OS can
      // throttle render loops / timers when the window is backgrounded or idle.
      // acquireActiveRun() flips it OFF while a module is in flight; the
      // matching releaseActiveRun() restores throttling on completion.
      backgroundThrottling: true,
      // Security settings
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  })
  _cwSentinel('cw-after-BrowserWindow')

  // Show window when ready to prevent flicker. Power-save / background-throttle
  // guards are now started on demand when a module run begins (see
  // acquire-active-run IPC below), so the OS is free to throttle and sleep
  // the app whenever it's idle.
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    // Check for updates once on launch
    setTimeout(() => checkForUpdates(), 3000)
    // Re-check every 15 min so a long-running session picks up new builds
    // without needing a restart. The renderer already throttles toasts so
    // multiple "available" events for the same version don't spam.
    setInterval(() => { checkForUpdates().catch(() => {}) }, 15 * 60 * 1000)
  })
  // Also re-check whenever the window regains focus — operators who tab away
  // and come back expect a fresh check, not a stale "no update" decision.
  mainWindow.on('focus', () => { checkForUpdates().catch(() => {}) })

  // Deny permission prompts by default (camera/mic/notifications/etc),
  // but allow clipboard-write so Copy Log / Copy Serial buttons work.
  // Native notifications are handled via IPC, not via web permissions.
  const CLIPBOARD_PERMS = new Set(['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
  try {
    const ses = mainWindow.webContents.session
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(CLIPBOARD_PERMS.has(permission))
    })
    ses.setPermissionCheckHandler((_wc, permission) => CLIPBOARD_PERMS.has(permission))
  } catch { /* permissions API not available in older Electron */ }

  _cwSentinel('cw-before-power-ipc')
  // ==================== POWER SAVE / BACKGROUND THROTTLING ====================
  // Reference-counted gate for the powerSaveBlocker + Chromium background
  // throttling. Renderer calls acquire on run start, release on run end.
  try {
    ipcMain.handle('acquire-active-run', async () => ({ count: acquireActiveRun() }))
    ipcMain.handle('release-active-run', async () => ({ count: releaseActiveRun() }))
  } catch (e) {
    _cwSentinel('cw-power-ipc-error', e?.message || String(e))
  }
  _cwSentinel('cw-after-power-ipc')

  // Diagnostic wrapper — captures whatever throws between here and end of
  // createWindow so brain.log shows the actual error message instead of a
  // silent abort that breaks the rest of whenReady.
  try {

  // ==================== SESSION RECOVERY ====================
  // Clear all auth cookies/cache and reload â€” fixes stuck Clerk auth
  ipcMain.handle('clear-session', async () => {
    try {
      const ses = mainWindow.webContents.session
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'sessionstorage', 'cachestorage'] })
      await ses.clearCache()
      mainWindow.loadURL(buildDesktopAppUrl(`${APP_URL}/desktop`))
      return { success: true }
    } catch (err) {
      console.error('[Session] Failed to clear session:', err)
      return { success: false, error: err.message }
    }
  })

  // Load the desktop route with a cache-busting query so web deploys don't leave
  // the desktop app pinned to a stale client bundle between restarts.
  mainWindow.webContents.session.clearCache()
    .catch((err) => {
      console.warn('[Desktop] Failed to clear HTTP cache before load:', err?.message || err)
    })
    .finally(() => {
      mainWindow.loadURL(buildDesktopAppUrl(`${APP_URL}/desktop`))
    })

  // 2.16.18: kill the Crisp chat widget at the network layer. Block must
  // be installed BEFORE the dashboard URL loads or the widget script fires
  // first and renders the bubble briefly.
  blockCrispRequests()

  // 3.1.1: floating "Phones" pill REMOVED. The sidebar Phones tab now launches
  // the per-phone Models Dashboard directly via window.electronAPI.launchDashboard
  // -> fleet:launch-dashboard. No more overlay painted over the dashboard.

  // ==================== WINDOW OPEN HANDLER ====================
  // Prevent window.open() from creating popup windows.
  // Internal routes: navigate the main window instead.
  // External URLs: open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      const appParsed = new URL(APP_URL)
      if (parsed.origin === appParsed.origin) {
        // Internal route â€” navigate main window instead of opening popup
        mainWindow.loadURL(buildDesktopAppUrl(url))
      } else {
        // External URL â€” open in system browser
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          shell.openExternal(url)
        }
      }
    } catch {
      // Malformed URL â€” ignore
    }
    return { action: 'deny' } // Always deny popup creation
  })

  // ==================== NAVIGATION GUARD ====================
  // Keep the webview inside the desktop app shell (/dashboard, legacy /desktop).
  // This catches window.location.href, router.push, <a href>, etc.
  // Unknown internal routes redirect to /dashboard; external URLs open in browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url)
      const appParsed = new URL(APP_URL)
      const dashboardUrl = buildDesktopAppUrl(`${APP_URL}/dashboard`)

      // Allow navigation within the desktop app shell (new /dashboard tree and
      // legacy /desktop tree) â€” covers initial load, reload, and all in-app
      // router.push navigation between dashboard sections.
      if (parsed.pathname === '/dashboard' || parsed.pathname.startsWith('/dashboard/') ||
          parsed.pathname === '/desktop' || parsed.pathname.startsWith('/desktop/')) {
        return // Allow
      }

      // Allow Clerk's real auth hosts (exact-suffix, not substring) and the
      // app's own sign-in/onboarding routes (gated to the APP_URL origin so a
      // foreign host with a /sign-in path can't be allowed through).
      const host = parsed.hostname
      // The app's own registrable domain — covers Clerk CUSTOM domains
      // (clerk.<app> / accounts.<app>, e.g. clerk.shadowphone.io) plus any
      // first-party subdomain. Without this the substring->suffix tightening
      // would block the real Clerk auth host and break desktop sign-in.
      const appRoot = appParsed.hostname.split('.').slice(-2).join('.')
      const isClerkHost =
        host === 'clerk.com' || host.endsWith('.clerk.com') ||
        host.endsWith('.clerk.accounts.dev') || host.endsWith('.accounts.dev') ||
        host === appRoot || host.endsWith('.' + appRoot)
      const isAppAuthPath = parsed.origin === appParsed.origin && (
        parsed.pathname.startsWith('/sign-in') || parsed.pathname.startsWith('/sign-up') ||
        parsed.pathname.startsWith('/login') || parsed.pathname.startsWith('/signup') ||
        parsed.pathname.startsWith('/onboarding'))
      if (isClerkHost || isAppAuthPath) {
        return // Allow auth flow
      }

      if (parsed.origin === appParsed.origin) {
        // Internal route outside the app shell â€” block and redirect to /dashboard
        event.preventDefault()
        console.log(`[NavGuard] Blocked internal navigation to ${url}, staying on /dashboard`)
        mainWindow.loadURL(dashboardUrl)
      } else {
        // External URL â€” open in system browser
        event.preventDefault()
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          shell.openExternal(url)
        }
      }
    } catch {
      // Malformed URL â€” block
      event.preventDefault()
    }
  })

  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  // 2.16.8: persistent application menu so Fleet panel + Phones controls
  // are reachable without hunting in the system tray. Visible in both dev
  // and prod (replaces the previous prod-strip behaviour). DevTools entry
  // is gated to admins via webContents.on('before-input-event') below.
  const buildAppMenu = () => {
    const isMac = process.platform === 'darwin'
    const phoneTemplate = [{
      label: 'Phones',
      submenu: [
        {
          label: 'Add a phone…',
          click: () => {
            try { require('./lib/fleet-panel').openFleetPanel() }
            catch (e) { console.warn('[menu] add-phone open failed:', e?.message || e) }
          },
        },
        {
          label: 'Tile All Tailnet Phones',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: async () => {
            try {
              const phones = await phoneListProvider()
              const tailnet = phones.filter(p => p.tailnetIp)
              const { tileAll } = require('./lib/scrcpy-tray')
              if (tileAll) await tileAll({ phones: tailnet, getAdbPath: () => getADBPath() })
            } catch (e) { console.warn('[menu] tile all failed:', e?.message || e) }
          },
        },
        { type: 'separator' },
        {
          label: 'Open Logs Folder',
          click: () => {
            try {
              const dir = require('./lib/launcher-log').getLogsDir()
              if (dir) shell.openPath(dir)
            } catch (_) {}
          },
        },
      ],
    }]
    return Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      ...phoneTemplate,
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'About ShadowPhone', click: () => shell.openExternal('https://www.shadowphone.io') }] },
    ])
  }
  try { Menu.setApplicationMenu(buildAppMenu()) }
  catch (e) { console.warn('[menu] setApplicationMenu failed:', e?.message || e); if (!isDev) Menu.setApplicationMenu(null) }

  // Block DevTools keyboard shortcuts for non-admin users
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (isAdminUser()) return // Admins get full access

    const ctrl = input.control || input.meta // Ctrl on Windows, Cmd on Mac
    const shift = input.shift
    const key = input.key.toLowerCase()

    // Block: F12
    if (key === 'f12') {
      event.preventDefault()
      return
    }
    // Block: Ctrl+Shift+I (DevTools)
    if (ctrl && shift && key === 'i') {
      event.preventDefault()
      return
    }
    // Block: Ctrl+Shift+J (Console)
    if (ctrl && shift && key === 'j') {
      event.preventDefault()
      return
    }
    // Block: Ctrl+Shift+C (Inspect Element)
    if (ctrl && shift && key === 'c') {
      event.preventDefault()
      return
    }
    // Block: Ctrl+U (View Source)
    if (ctrl && !shift && key === 'u') {
      event.preventDefault()
      return
    }
  })

  // Block right-click context menu for non-admin users
  mainWindow.webContents.on('context-menu', (event) => {
    if (!isAdminUser()) {
      event.preventDefault()
    }
  })

  // Prevent DevTools from being opened programmatically
  mainWindow.webContents.on('devtools-opened', () => {
    if (!isAdminUser() && !isDev) {
      mainWindow.webContents.closeDevTools()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    try {
      if (schedulePowerSaveBlockerId !== null && powerSaveBlocker.isStarted(schedulePowerSaveBlockerId)) {
        powerSaveBlocker.stop(schedulePowerSaveBlockerId)
      }
    } catch { /* noop */ }
    schedulePowerSaveBlockerId = null
    stopRuntimeQueueRelay()
    stopADBMonitoring()
    stopADBServer()
  })

  // Initialize modular IPC handlers
  initSystemHandlers({
    mainWindow,
    app,
    executeADB,
    startADBServer,
    // 2.16.0: lets system-handlers route scrcpy through tailnet when available.
    getConnectedDevices,
  })

  // 2.19.13: device-watchdog auto-recovers mirrors that died because the
  // phone dropped off adb (Tailscale relay flip, USB jiggle, WiFi sleep).
  // Tracks per-serial "mirror intent" registered by launchScrcpyForSerial;
  // ticks every 5s and: relaunches scrcpy when the phone comes back,
  // kicks `adb connect` for offline tailnet handles, throttles aggressively
  // so a thrashing phone doesn't get hammered. See lib/device-watchdog.js.
  const sysHandlers = require('./handlers/system-handlers')
  try {
    const watchdog = require('./lib/device-watchdog')
    const diagnostics = require('./lib/diagnostics')
    watchdog.start({
      userDataDir: app.getPath('userData'),
      getADBPath: () => getADBPath(),
      getTailscaleBinary: () => diagnostics.findTailscaleBin(),
      hasRunningScrcpyForSerial: sysHandlers.hasRunningScrcpyForSerial,
      launchScrcpyForSerial: sysHandlers.launchScrcpyForSerial,
      // Lets the watchdog skip a relaunch while an equalizer/profile-switch
      // respawn is mid-flight for this phone — without it the watchdog races the
      // respawn and double-spawns the mirror.
      isRespawning: sysHandlers.isRespawning,
      // Case A must also stand down while a LAUNCH is in flight, and for a few
      // seconds after a CLEAN close — the close teardown clears the watchdog
      // intent only after an async adb probe, and the watchdog used to fire in
      // that gap and resurrect a window the user had just closed.
      isLaunching: sysHandlers.isLaunching,
      lastCleanCloseAt: sysHandlers.lastCleanCloseAt,
      // H3: lets the watchdog collapse a USB udid and a tailnet ip:port for the
      // same physical phone into ONE intent (keyed by hwSerial) so two launch
      // surfaces don't spawn competing relaunch loops on one device.
      getConnectedDevices,
    })
  } catch (e) { console.warn('[device-watchdog] start failed (non-fatal):', e?.message || e) }

  // The >30min busy-lock self-heal used to run only inside the legacy autofire
  // engine's tick, which is off in shipped builds — so a lock stranded by a
  // crashed run blocked that phone (and the fleet-wide companion pass) forever.
  // Its own 60s interval, independent of that engine.
  try { require('./lib/schedule-engine').startPhoneLockJanitor() } catch (e) {
    console.warn('[schedule-engine] lock janitor start failed (non-fatal):', e?.message || e)
  }

  // 2.21.4: auto-install Companion APK on every connected phone.
  // 2.21.7: persistent — bursts at 3s/30s, then every 3min for the
  // lifetime of the app, so phones plugged in hours after launch (or
  // rebooted mid-session) are covered. Also exposes ensureForDevice
  // for hot paths like launchOne where we want immediate per-phone
  // health check before spawning scrcpy.
  try {
    const autoInstaller = require('./lib/companion-auto-installer')
    global.companionAutoInstaller = autoInstaller.startAutoInstaller(
      () => getADBPath(),
      // Busy predicate: the recurring companion pass does `am switch-user 0`, which
      // was yanking a phone to the owner profile mid account-creation. Skip the pass
      // whenever ANY automation run is active.
      () => {
        try {
          const mh = require('./handlers/module-handlers')
          if (runningModules.size > 0 || activeWsModules.size > 0) return true
          if (mh.getActiveModuleCount() > 0) return true
          // Post-run grace: keep the phone "busy" for one full pass-interval after
          // the last run settles so no owner-swap fires while IG's final NUX taps /
          // device settle — the swap-back that lands IG on the "enter your mobile
          // number" screen. 3 min == the recurring pass interval, so the pass
          // immediately following any run is always skipped. Tunable.
          if (Date.now() - mh.getLastRunEndedAt() < 3 * 60_000) return true
          // Pre-run grace: a run START or a profile switch bumps lastActivityAt.
          // This covers the create sequence's pre-brain window — switch-profile
          // + the up-to-45s brain-ready wait — that the count checks above miss,
          // where a companion tick was still swapping to the owner profile and
          // throwing IG back to "enter your mobile number".
          if (typeof mh.getLastActivityAt === 'function' && Date.now() - mh.getLastActivityAt() < 3 * 60_000) return true
          return false
        } catch (_) {
          return runningModules.size > 0 || activeWsModules.size > 0
        }
      }
    )
  } catch (e) { console.warn('[companion-auto-installer] start failed (non-fatal):', e?.message || e) }

  initDeviceHandlers(app, mainWindow, {
    appUrl: APP_URL,
    getSessionToken: () => currentUserSession?.sessionToken || null,
    // Connection toggle: when a device's transport pref changes AND a mirror is
    // open, restart it on the chosen transport (launchScrcpyForSerial closes the
    // old-transport mirror first, so there's no duplicate / stale-transport reuse).
    isMirrorOpen: (serial) => { try { return sysHandlers.hasRunningScrcpyForSerial(serial) } catch (_) { return false } },
    relaunchMirror: (serial) => { try { return sysHandlers.launchScrcpyForSerial(serial) } catch (_) {} },
    // FIX: feed the fresh device list into system-handlers so sameDevice() can
    // collapse the new transport alias (USB udid ↔ tailnet ip:port) and
    // hasRunningScrcpyForSerial returns true, allowing relaunchMirror to fire.
    setDeviceSnapshot: (devs) => { try { sysHandlers.setLastDeviceSnapshot(devs) } catch (_) {} },
  })

  // The first scan must run after initDeviceHandlers resolves adbPath.
  startADBMonitoring()

  initProfileHandlers(mainWindow, executeADB, app)

  initModuleHandlers({
    mainWindow,
    app,
    executeADB,
    ModuleWebSocketClient,
    serverUrl: MODULES_SERVER_URL,
    apiSecret: null,
    modulesPath: MODULES_PATH,
    getModuleToken,
    getCurrentUserSession: () => currentUserSession
  })

  initContentHandlers({
    mainWindow,
    app,
    dependencyManager,
    localDownloader,
    localFingerprinter
  })

  // Web-mirror portal — one ws-scrcpy server for the whole fleet, behind a
  // token auth-proxy + cloudflared tunnel.
  initPortalHandlers({
    getAdbPath: () => getADBPath(),
    getCurrentUserSession: () => currentUserSession,
    getLiveDevices: () => getConnectedDevices(),
    appUrl: APP_URL,
    fetchImpl: fetch,
  })

  // 2.16.0: native scrcpy launcher (replaces broken web-stream tile).
  // [Launch] per-device + [Tile all] master view + Tailscale status badge.
  const { initScrcpyLauncherHandlers } = require('./handlers/scrcpy-launcher-handlers')
  const { getTailscaleDeniedReason, getTailscaleStatus } = require('./lib/tailscale-status')
  const { initScrcpyTray } = require('./lib/scrcpy-tray')

  // Use device-handlers' getConnectedDevices (richer than main.js's local one:
  // it carries nickname, displayName, hwSerial, and tailnetIp/tailnetPort
  // from the USB+TCP merge).
  const deviceHandlers = require('./handlers/device-handlers')

  const phoneListProvider = async () => {
    // 2.16.4: VAs have NO USB phones connected — listing only from
    // getConnectedDevices() showed them an empty fleet. Now we list every
    // Android peer on the tailnet (regardless of whether the local ADB
    // server has seen them yet), and ENRICH with USB info when available.
    const ts = await getTailscaleStatus()
    const tailscaleDeniedReason = getTailscaleDeniedReason(ts)
    const tsAndroidPeers = (tailscaleDeniedReason ? [] : ts.peers).filter(p => p.os === 'android' && p.online)
    const devices = await deviceHandlers.getConnectedDevices().then(d => d || []).catch(() => [])

    const phones = []
    const claimedByHwSerial = new Set()
    const claimedByTailnetIp = new Set()

    // First: every tailnet Android phone (the primary source of truth)
    for (const peer of tsAndroidPeers) {
      // Match against a local ADB device by tailnet IP (TCP entry serial)
      // or by hostname → nickname.
      const peerKey = peer.name.toLowerCase()
      const match = devices.find(d => {
        if (d.tailnetIp === peer.ip) return true
        const nick = (d.nickname || d.displayName || d.model || '').toLowerCase().replace(/\s/g, '-')
        return nick === peerKey
      })
      const udid = match?.serial || peer.name
      const nickname = match?.nickname || match?.displayName || peer.name
      phones.push({
        udid,
        hwSerial: match?.hwSerial || null,
        nickname,
        tailnetIp: peer.ip,
        // FIX: use live port from merged device record; fall back to 5555 when
        // no ADB match yet (pre-connect). Fixes mirror launch after adbd port
        // rotates off 5555 on reboot.
        port: match?.tailnetPort || 5555,
        transport: 'tailscale',
      })
      claimedByTailnetIp.add(peer.ip)
      if (match?.hwSerial) claimedByHwSerial.add(match.hwSerial)
      if (match?.serial) claimedByHwSerial.add(match.serial)
    }

    // Second: USB-only phones (connected via ADB but NOT on tailnet) so the
    // owner can still see them in the Fleet panel to launch + provision.
    for (const d of devices) {
      if (tailscaleDeniedReason && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(d.serial || '')) continue
      const key = d.hwSerial || d.serial
      if (claimedByHwSerial.has(key)) continue
      if (d.tailnetIp && claimedByTailnetIp.has(d.tailnetIp)) continue
      const tailnetIp = tailscaleDeniedReason ? null : d.tailnetIp || null
      phones.push({
        udid: d.serial,
        hwSerial: d.hwSerial || d.serial,
        nickname: d.nickname || d.displayName || d.model,
        tailnetIp,
        port: d.tailnetPort || 5555,
        transport: tailnetIp ? 'tailscale' : 'usb',
      })
    }

    // F4: tag each phone with live mirror status so the Fleet panel can show a
    // "mirroring" pip distinct from the online/offline dot. Best-effort — never
    // throws, never blocks the phone list on a require failure.
    try {
      const sysHandlers = require('./handlers/system-handlers')
      for (const p of phones) p.mirroring = !!sysHandlers.hasRunningScrcpyForSerial(p.udid)
    } catch (_) { for (const p of phones) p.mirroring = false }

    return phones
  }

  initScrcpyLauncherHandlers({
    getAdbPath: () => getADBPath(),
    getPhones: phoneListProvider,
  })

  // 2.16.7: launcher diagnostic log — VAs DM this when "Launch did nothing".
  const launcherLog = require('./lib/launcher-log')
  launcherLog.init(app)
  ipcMain.handle('launcher-log:path', () => launcherLog.getLogPath())

  // Feature 1: Wireless Add-Phone wizard — adb pair+connect IPC (pair:*).
  // broadcastDevices requires a monotonic seq (passing none poisons
  // lastBroadcastSeq) so we wrap it to inject ++sweepSeq for the post-pair
  // fleet refresh. Non-fatal so a pairing init failure never blocks boot.
  try {
    require('./handlers/pairing-handlers').initPairingHandlers({
      getAdbPath: () => getADBPath(),
      mainWindow,
      getConnectedDevices,
      broadcastDevices: (devices) => broadcastDevices(devices, ++sweepSeq),
    })
  } catch (e) {
    console.error('[pairing] init failed (non-fatal):', e?.message || e)
  }

  // Feature 2: Live logcat viewer — per-serial `adb logcat` stream, isolated
  // from the scrcpy launcher above; wrapped non-fatally so a logcat init
  // failure never blocks device mirroring.
  try {
    initLogcatHandlers({
      getAdbPath: () => getADBPath(),
      getConnectedDevices: deviceHandlers.getConnectedDevices,
    })
  } catch (e) {
    console.warn('[logcat-handlers] init failed (non-fatal):', e?.message || e)
  }

  // Feature 3: YAML per-device plugin registry (Fleet panel "Plugins" picker).
  try {
    const { initPluginHandlers } = require('./handlers/plugin-handlers')
    const { getScrcpyPath } = require('./handlers/system-handlers')
    initPluginHandlers({ getScrcpyPath, getAdbPath: () => getADBPath() })
  } catch (e) { console.warn('[plugin-handlers] init failed (non-fatal):', e?.message || e) }

  // 2.16.11: boot diagnostic + on-demand self-report. Captures baseline
  // state at every launch so triage starts with full context.
  const diagnostics = require('./lib/diagnostics')
  diagnostics.collect({
    adbPath: getADBPath(),
    appVersion: app.getVersion(),
    launcherLogPath: launcherLog.getLogPath(),
  }).then(r => {
    launcherLog.write('boot-diagnostic', {
      version: r.shadowphone.version,
      platform: `${r.system.platform} ${r.system.release}`,
      tailnetIp: r.network.tailnetIp,
      tailscaleBin: r.tailscale.binary,
      tailscaleJsonState: r.tailscale.statusJsonState,
      androidPeersOnline: r.tailscale.peerCountAndroidOnline,
      scrcpyProcs: r.processes.scrcpy.length,
      tailscaledProcs: r.processes.tailscaled.length,
      protonvpnRunning: r.processes.protonvpn.length > 0,
      hints: r.hints,
    })
  }).catch(() => {})

  ipcMain.handle('diagnostics:collect', async (e, opts = {}) => {
    try {
      const r = await diagnostics.collect({
        adbPath: getADBPath(),
        appVersion: app.getVersion(),
        launcherLogPath: launcherLog.getLogPath(),
      })
      const raw = diagnostics.formatReport(r)
      // 2.16.12: default to masked output so VAs can paste into chat
      // safely. Caller can pass { raw: true } if they explicitly need
      // unredacted (e.g. shadowphone dev troubleshooting their own box).
      const masked = diagnostics.maskReport(raw)
      return { ok: true, report: r, formatted: masked, formattedRaw: opts?.raw ? raw : null }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // 2.16.10: Fleet panel Launch → routes through scrcpy-tray.launchOne so
  // tailnet phones get adb-connect-first + toolbar docking. Direct
  // launch-scrcpy IPC was failing silently for tailnet-only phones (it
  // received the hostname like "Pixel 6" which isn't an adb serial).
  ipcMain.handle('fleet:launch-one', async (e, phone) => {
    try {
      const { launchOne } = require('./lib/scrcpy-tray')
      launcherLog.write('fleet:launch-one:invoked', { phone })
      const r = await launchOne({ phone, getAdbPath: () => getADBPath() })
      launcherLog.write('fleet:launch-one:result', { phone, result: r })
      return r
    } catch (err) {
      launcherLog.write('fleet:launch-one:error', { phone, error: err?.message || String(err), stack: (err?.stack || '').split('\n').slice(0, 4).join(' | ') })
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Per-device Models Dashboard — opens models-dashboard.html scoped to this phone.
  ipcMain.handle('fleet:launch-dashboard', async (e, phone) => {
    try {
      const { openModelsDashboard } = require('./lib/fleet-dashboard-window')
      const serial = phone?.udid || phone?.serial || phone
      launcherLog.write('fleet:launch-dashboard:invoked', { serial })
      openModelsDashboard({ serial })
      return { success: true }
    } catch (err) {
      launcherLog.write('fleet:launch-dashboard:error', { error: err?.message || String(err) })
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Universal Command Center — fleet-wide schedule + accounts + folders + actions
  // across ALL phones (no device scope). Separate window from the per-device one.
  ipcMain.handle('fleet:launch-schedule', async () => {
    try {
      const { openUniversalDashboard } = require('./lib/fleet-dashboard-window')
      launcherLog.write('fleet:launch-schedule:invoked', {})
      openUniversalDashboard()
      return { success: true }
    } catch (err) {
      launcherLog.write('fleet:launch-schedule:error', { error: err?.message || String(err) })
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Dashboard "Phones" button bridge — open the native Fleet panel.
  // Kept because the on-demand "Add a phone…" menu item routes through it.
  ipcMain.handle('open-fleet-panel', async () => {
    try {
      require('./lib/fleet-panel').openFleetPanel()
      return { success: true }
    } catch (err) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Dashboard Settings gear bridge — the real app settings (smspool API key)
  // live in the fleet panel's Settings modal, which the remote web app can't
  // reach. Open the panel pre-navigated straight to that Settings view.
  ipcMain.handle('open-settings', async () => {
    try {
      require('./lib/fleet-panel').openFleetPanel({ openSettings: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  // 2.16.1: Fleet panel — native in-app phone list. Lighter than the remote
  // shadowphone.io/desktop dashboard and works offline.
  ipcMain.handle('fleet:get-phones', async () => {
    try {
      const phones = await phoneListProvider()
      launcherLog.write('fleet:get-phones', { count: phones.length, phones: phones.map(p => ({ udid: p.udid, nickname: p.nickname, tailnetIp: p.tailnetIp, transport: p.transport })) })
      return phones
    } catch (e) {
      launcherLog.write('fleet:get-phones-error', { error: e?.message || String(e) })
      return []
    }
  })

  // 2.16.2: in-app phone provisioning wizard. Each step is its own IPC
  // so the Fleet panel modal can walk through them with UI feedback.
  const provision = require('./lib/phone-provision')
  ipcMain.handle('provision:detect-usb',         async ()                => { try { return await provision.detectUsbPhones(getADBPath()) } catch (err) { return { ok: false, error: err?.message || String(err) } } })
  ipcMain.handle('provision:install-tailscale',  async (e, { udid })     => { try { return await provision.installTailscale(getADBPath(), udid) } catch (err) { return { ok: false, error: err?.message || String(err) } } })
  ipcMain.handle('provision:open-tailscale',     async (e, { udid })     => { try { return await provision.openTailscaleApp(getADBPath(), udid) } catch (err) { return { ok: false, error: err?.message || String(err) } } })
  ipcMain.handle('provision:wait-tailnet',       async (e, { udid })     => { try { return await provision.waitForTailnetIp(getADBPath(), udid) } catch (err) { return { ok: false, error: err?.message || String(err) } } })
  ipcMain.handle('provision:enable-wifi-adb',    async (e, { udid, ip }) => { try { return await provision.enableWifiAdb(getADBPath(), udid, ip) } catch (err) { return { ok: false, error: err?.message || String(err) } } })
  ipcMain.handle('provision:exempt-battery',     async (e, { udid })     => { try { return await provision.exemptBattery(getADBPath(), udid) } catch (err) { return { ok: false, error: err?.message || String(err) } } })
  ipcMain.handle('provision:install-companion',  async (e, { udid })     => { try { return await provision.installCompanion(getADBPath(), udid) } catch (err) { return { ok: false, error: err?.message || String(err) } } })

  // 2.21.x: keep wireless ADB armed on USB-attached phones. Android wipes
  // service.adb.tcp.port on every reboot, so a rebooted phone falls off
  // :5555 and VPS/operator instances (no USB) can't re-arm it. This periodic
  // reconciler runs on the USB host: any USB phone whose port != 5555 gets
  // `adb tcpip 5555` re-fired and reconnected, then its live tailnet IP is
  // logged so it can be picked back up. State-based + per-serial cooldown so
  // healthy phones are never disturbed mid-session.
  try {
    const wirelessAdbReconciler = require('./lib/wireless-adb-reconciler')
    wirelessAdbReconciler.start({
      getAdbPath: () => getADBPath(),
      // Skip any phone with a live mirror — the re-arm flow forces a USB
      // re-enumeration that would tear the running scrcpy transport mid-session.
      hasRunningScrcpyForSerial: (serial) => { try { return sysHandlers.hasRunningScrcpyForSerial(serial) } catch (_) { return false } },
      // Skip any phone with an active automation run — its tcpip/disconnect/connect
      // re-arm would tear the transport mid-run (headless runs have no mirror, so
      // the scrcpy filter misses them). Per-phone via the shared busy lock.
      isPhoneBusy: (serial) => { try { const se = require('./lib/schedule-engine'); return se._busyPhones.has(se.canonicalPhoneKey(serial)) } catch (_) { return false } },
      log: (event, data) => { try { launcherLog.write(event, data) } catch (_) {} },
      onRearm: ({ serial, tailnetIp }) => {
        // Re-armed a phone that had dropped off :5555 after a reboot. The
        // tailnet IP is logged (and surfaced to any open live-log panel via
        // launcher-log) so operators know it's reachable again. Hook point
        // for a future push to VPS operator instances.
        try { launcherLog.write('wireless-adb:available', { serial, tailnetIp }) } catch (_) {}
      },
    })
  } catch (e) {
    console.error('[wireless-adb-reconciler] init failed:', e.message)
  }

  // USB-to-VPS bridge — start it now if the operator has enabled it (Settings).
  // Relays USB phones onto the PC's Tailscale so a VPS can drive them with no
  // Tailscale on the phone. Off by default (it exposes phones on the tailnet).
  try { if (_usbVpsBridgeEnabled()) void startUsbVpsBridge() } catch (e) { console.error('[usb-vps-bridge] boot start failed:', e.message) }

  // System tray with [Tile All] + per-phone [Launch] — primary in-app surface
  // for 2.16.0 since the main window's renderer is the remote shadowphone.io/desktop SPA.
  try {
    initScrcpyTray({
      getAdbPath: () => getADBPath(),
      getPhones: phoneListProvider,
      iconPath: require('node:path').join(__dirname, 'assets', 'icon.png'),
      getMainWindow: () => mainWindow,
      onShowApp: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
      },
    })
  } catch (e) {
    console.error('[scrcpy-tray] init failed:', e.message)
  }
  _cwSentinel('cw-end')

  } catch (e) {
    _cwSentinel('cw-ERROR', `${e?.name || ''}: ${e?.message || String(e)} :: stack=${(e?.stack || '').split('\n').slice(0, 3).join(' | ')}`)
  }
}

// ADB Functions
let cachedAdbPath = null
function getADBPath() {
  const platform = os.platform()
  const adbBinary = platform === 'win32' ? 'adb.exe' : 'adb'
  const fs = require('fs')
  const { execSync } = require('child_process')

  // 1. Check our app data folder first (where we install ADB)
  const userDataPath = app.getPath('userData')
  const downloadedPath = path.join(userDataPath, 'adb', adbBinary)
  if (fs.existsSync(downloadedPath)) {
    return downloadedPath
  }

  // 2. Check common installation paths on Windows
  if (platform === 'win32') {
    const commonPaths = [
      path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
      'C:\\Program Files\\Android\\platform-tools\\adb.exe',
      'C:\\Android\\platform-tools\\adb.exe',
    ]
    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        console.log('[ADB] Found at:', p)
        return p
      }
    }
  }

  // Check installations first so a newly downloaded binary supersedes the PATH cache.
  const searchPath = process.env.PATH || ''
  if (cachedAdbPath && cachedAdbPath.searchPath === searchPath && fs.existsSync(cachedAdbPath.path)) {
    return cachedAdbPath.path
  }
  cachedAdbPath = null

  // 3. Try to find ADB in system PATH
  try {
    const whereCmd = platform === 'win32' ? 'where adb' : 'which adb'
    const result = execSync(whereCmd, { encoding: 'utf8', timeout: 5000 }).trim()
    if (result) {
      const firstPath = result.split('\n')[0].trim()
      if (fs.existsSync(firstPath)) {
        if (path.isAbsolute(firstPath)) cachedAdbPath = { path: firstPath, searchPath }
        console.log('[ADB] Found in PATH:', firstPath)
        return firstPath
      }
    }
  } catch (e) {
    // ADB not in PATH
  }

  // Fallback to just the binary name (will fail if not in PATH)
  return adbBinary
}

// FIX: mirrors device-handlers.js transient-retry so airplane-toggle, profile-switch
// polls and content-push ADB calls survive a single tailnet transport blip.
const _ADB_TRANSIENT_PATTERNS = [
  'error: closed', 'error: device offline', 'error: device not found',
  'error: protocol fault', 'error: connection reset', 'cannot connect to daemon',
]
function _isTransientADBError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return _ADB_TRANSIENT_PATTERNS.some(p => msg.includes(p))
}
async function _spawnADB(args, timeout) {
  const result = await runAdb(getADBPath(), args, timeout)
  if (result.code === 0) return result.stdout.trim()
  const error = new Error(result.stderr || result.error || `ADB exited with code ${result.code}`)
  error.code = result.code
  throw error
}
async function executeADB(args, timeout = 30000) {
  const backoffs = [300, 600] // up to 3 total attempts (matches device-handlers.js)
  let attempt = 0
  for (;;) {
    try {
      return await _spawnADB(args, timeout)
    } catch (err) {
      if (attempt >= backoffs.length || !_isTransientADBError(err)) throw err
      await new Promise(r => setTimeout(r, backoffs[attempt]))
      attempt++
    }
  }
}

// Quick push files from PC to phone via ADB (pushes to current profile's DCIM)
// 2.16.1: Vanadium HTTP upload — uses the phone's Vanadium browser as the
// active Android user to download a file from a local HTTP server we spin
// up here. Lands in the active profile's Downloads/Gallery (unlike `adb
// push /sdcard/DCIM/` which always lands in user 0's media store).
async function uploadFileToVanadium({ serial, localPath }) {
  try {
    const { uploadFile } = require('./lib/vanadium-upload')
    const adbPath = getADBPath()
    return await uploadFile({ adbPath, serial, localPath })
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
}
ipcMain.handle('vanadium-upload-file', (_event, input) => uploadFileToVanadium(input))

// 2.17.21: paste-from-host-clipboard — sidebar Paste pill calls this to push
// the host clipboard text into the currently focused EditText on the phone.
// scrcpy's MOD+V clipboard sync is flaky on tailnet + UHID keyboard mode, so
// this is the reliable fallback: read host clipboard via Electron → escape
// for `adb shell input text` → fire. The `%s` is the only safe space escape
// (per memory feedback_adb_input_text_spaces). Special shell chars escape
// with backslash.
// 3.2: reveal a file (e.g. a saved screenshot) in the host file manager,
// selecting it. Used by the toolbar screenshot button — openFolder rejects
// non-directories + paths outside the content allow-list (screenshots live in
// os temp), so showItemInFolder is the right primitive.
async function revealFile(filePath) {
  try {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath)
    return { ok: true }
  } catch (e) { return { ok: false, error: e?.message || String(e) } }
}
ipcMain.handle('reveal-file', (_event, filePath) => revealFile(filePath))

ipcMain.handle('host-clipboard-paste', async (event, { serial }) => {
  try {
    if (!serial) return { success: false, error: 'serial required' }
    const { clipboard } = require('electron')
    const raw = clipboard.readText() || ''
    if (!raw) return { success: false, error: 'host clipboard is empty' }
    // adb input text escaping: spaces become %s, then escape shell-special chars
    const escaped = raw
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/&/g, '\\&')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/</g, '\\<')
      .replace(/>/g, '\\>')
      .replace(/\|/g, '\\|')
      .replace(/;/g, '\\;')
      .replace(/\*/g, '\\*')
      .replace(/\?/g, '\\?')
      .replace(/\n/g, ' ') // newlines → space, can't multi-line via input text
      .replace(/ /g, '%s')
    const adbPath = getADBPath()
    const result = await runAdb(adbPath, ['-s', serial, 'shell', 'input', 'text', escaped], 10_000)
    if (result.code !== 0) {
      return { success: false, error: (result.stderr || result.error || 'adb failed').slice(0, 200) }
    }
    return { success: true, length: raw.length }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

// 3.2: ping-latency — cheap read-only adb round-trip backing the toolbar latency
// chip. `adb shell true` is the lightest possible command (no output, instant
// return), so the ms delta is dominated by transport (USB vs tailnet) RTT. No
// schema/state change, ~1 call/10s per open toolbar.
ipcMain.handle('phone:ping-latency', async (_evt, { serial }) => {
  if (!serial) return { ok: false, error: 'serial required' }
  const adbPath = getADBPath()
  const t = Date.now()
  const result = await runAdb(adbPath, ['-s', serial, 'shell', 'true'], 4000)
  if (result.code !== 0) {
    return { ok: false, ms: Date.now() - t, error: (result.error || result.stderr || 'adb failed').slice(0, 120) }
  }
  return { ok: true, ms: Date.now() - t }
})

ipcMain.handle('adb-process-stats', () => getAdbProcessStats())

ipcMain.handle('adb-push-file', async (event, { serial, localPath, remotePath }) => {
  try {
    const dest = remotePath || '/sdcard/DCIM/'
    const fileName = require('path').basename(localPath)
    const ext = require('path').extname(localPath).toLowerCase()
    const s = serial ? ['-s', serial] : []

    // Push file
    await executeADB([...s, 'push', localPath, dest], 60000)

    // Register in MediaStore so Gallery sees it immediately
    const fullPath = dest.endsWith('/') ? dest + fileName : dest
    const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)
    // Shared map: this used to insert every video as video/mp4, so a .mov row
    // carried a mime the brain's video posting guard reads as a mislabeled mp4.
    const mime = mediaMimeType(localPath)
    const uri = isVideo ? 'content://media/external/video/media' : 'content://media/external/images/media'
    await executeADB([...s, 'shell', 'content', 'insert', '--uri', uri,
      '--bind', `_data:s:${fullPath}`, '--bind', `mime_type:s:${mime}`], 5000).catch(() => {})

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// Quick Upload transfer for the selected Android profile.
// Owner profile uses ADB push; secondary GrapheneOS profiles use the existing
// Vanadium download bridge so media lands in that profile's MediaStore.
ipcMain.handle('adb-push-content-folder', async (event, { serial, sourceFolder, sourceFile = '', source_file = '', maxFiles = 10, clearExisting = false, accountUsername = '', contentType = '', targetUser = '', target_user = '', transferId = '', transfer_id = '', allowOwnerProfileStaging = false }) => {
  try {
    if (!sourceFolder) {
      return { success: false, error: 'sourceFolder is required', pushed: 0 }
    }

    // Prefer the CANONICAL NESTED layout: Content/phones/<phone>/profiles/<profile>/
    // instagram/<acc>. The renderer still passes a flat 'instagram/<acc>' sourceFolder
    // (legacy — what the old Schedule tab read), but content now lives nested per
    // phone+profile, so a nested-only account pushes nothing → empty gallery → the post
    // fails "no video in device gallery". Resolve the nested folder from serial +
    // targetUser + accountUsername and use it WHEN IT HAS MEDIA; otherwise fall through
    // to the flat resolution below (accounts still on the flat layout are unaffected).
    const selectedSourceFile = String(sourceFile || source_file || '').trim()
    const _pushTargetUser = String(targetUser || target_user || '').trim()
    if (!selectedSourceFile && accountUsername && /^\d+$/.test(_pushTargetUser)) {
      try {
        const cp = require('./lib/content-paths')
        const _s0 = serial ? ['-s', serial] : []
        const _hw = (await executeADB([..._s0, 'shell', 'getprop', 'ro.serialno'], 5000) || '').trim()
        const _tip = String(serial || '').includes(':') ? String(serial).split(':')[0] : null
        const _phone = cp.resolvePhoneFolder({ hwSerial: (_hw && _hw.toLowerCase() !== 'null') ? _hw : null, id: serial || null, tailnetIp: _tip }, CONTENT_ROOT)
        const _prof = cp.resolveProfileFolder(_phone.folderPath, { profileId: _pushTargetUser })
        const _nested = path.join(_prof.folderPath, 'instagram', String(accountUsername).toLowerCase())
        const _hasMedia = (d) => {
          try {
            if (!fs.existsSync(d)) return false
            if (fs.readdirSync(d).some(f => /\.(jpg|jpeg|png|mp4|mov|webp)$/i.test(f))) return true
            for (const sub of ['images', 'videos', 'reels', 'trial_reels', 'stories']) {
              try { const sd = path.join(d, sub); if (fs.existsSync(sd) && fs.readdirSync(sd).some(f => /\.(jpg|jpeg|png|mp4|mov|webp)$/i.test(f))) return true } catch (_) {}
            }
            return false
          } catch (_) { return false }
        }
        if (_hasMedia(_nested)) {
          // Bug 2: defensive check — nested folder's basename must match the account we intend to push.
          // Catches symlink/resolution drift where the resolved path points to a different account folder.
          const _nestedBase = path.basename(_nested).toLowerCase()
          const _expectedBase = String(accountUsername).toLowerCase()
          if (_nestedBase !== _expectedBase) {
            console.error(`[adb-push-content-folder] nested folder basename mismatch: got '${_nestedBase}' expected '${_expectedBase}' — aborting to prevent wrong-account push`)
            throw new Error(`nested content folder basename mismatch: '${_nestedBase}' !== '${_expectedBase}'`)
          }
          console.log(`[adb-push-content-folder] using nested content folder: ${_nested}`)
          sourceFolder = _nested
        } else {
          // Bug 1: this phone's nested folder has no media. The flat folder is SHARED across
          // all phones, so for a same-handle account that exists under MORE THAN ONE phone in
          // the nested tree, the flat fallback is genuinely ambiguous and could push the wrong
          // phone's content — refuse only in that case. Single-phone or pure-flat accounts
          // (resolvePhoneFolder/resolveProfileFolder CREATE an empty nested dir, so flat-content
          // accounts always have an empty nested folder here) fall through to flat as before.
          const phonesRoot = path.join(CONTENT_ROOT, 'phones')
          let handlePhoneCountWithMedia = 0
          try {
            for (const phone of fs.readdirSync(phonesRoot, { withFileTypes: true })) {
              if (!phone.isDirectory()) continue
              const profilesDir = path.join(phonesRoot, phone.name, 'profiles')
              if (!fs.existsSync(profilesDir)) continue
              for (const prof of fs.readdirSync(profilesDir, { withFileTypes: true })) {
                if (!prof.isDirectory()) continue
                const acctPath = path.join(profilesDir, prof.name, 'instagram', String(accountUsername).toLowerCase())
                // Only count if the folder exists AND has media (not just an empty created folder)
                if (_hasMedia(acctPath)) {
                  handlePhoneCountWithMedia++
                  break
                }
              }
            }
          } catch (_) {}
          if (handlePhoneCountWithMedia > 1) {
            return { success: false, error: `Account '${accountUsername}' has no nested content for this phone/profile and the same handle has nested content on ${handlePhoneCountWithMedia} other phones — flat fallback is ambiguous; add content to this phone's nested layout`, pushed: 0 }
          }
          // else: fall through to flat (single-phone or pure-flat account — unchanged behavior)
        }
      } catch (e) {
        if (e?.message?.includes('nested content folder basename mismatch')) throw e
        console.warn('[adb-push-content-folder] nested resolve failed, using flat path:', e?.message || e)
      }
    }

    // Guard: after nested resolution, ensure the sourceFolder we're about to use actually has media.
    // If nested was empty (or resolution failed), we fell back to the flat path. The flat path is
    // shared across all phones/profiles; we must not silently push from it if it's empty or
    // contains content from a different account context.
    const _finalHasMedia = (d) => {
      try {
        if (!fs.existsSync(d)) return false
        if (fs.readdirSync(d).some(f => /\.(jpg|jpeg|png|mp4|mov|webp)$/i.test(f))) return true
        for (const sub of ['images', 'videos', 'reels', 'trial_reels', 'stories']) {
          try { const sd = path.join(d, sub); if (fs.existsSync(sd) && fs.readdirSync(sd).some(f => /\.(jpg|jpeg|png|mp4|mov|webp)$/i.test(f))) return true } catch (_) {}
        }
        return false
      } catch (_) { return false }
    }
    // Resolve flat path to absolute first (using same logic as guard below) to check it
    const _flatCheck = path.isAbsolute(sourceFolder) ? sourceFolder : path.resolve(path.resolve(CONTENT_ROOT), sourceFolder)
    if (!_finalHasMedia(_flatCheck)) {
      return { success: false, error: `sourceFolder has no media files: ${sourceFolder}`, pushed: 0 }
    }

    // Path-traversal + scope guard: sourceFolder must live under the
    // CONTENT_ROOT we manage. Without this, a compromised renderer could
    // pivot to reading any file on the host PC by passing e.g.
    // "C:\\Users\\manna\\.ssh" and watching the device receive the dump.
    //
    // Relative paths (e.g. "Instagram/eileenswrld/reels") are resolved
    // UNDER CONTENT_ROOT before the check. Absolute paths must already
    // sit inside CONTENT_ROOT — otherwise the guard fires.
    const resolvedRoot = path.resolve(CONTENT_ROOT)
    const rawSrc = String(sourceFolder)
    const resolvedSrc = path.isAbsolute(rawSrc)
      ? path.resolve(rawSrc)
      : path.resolve(resolvedRoot, rawSrc)
    if (!resolvedSrc.startsWith(resolvedRoot + path.sep) && resolvedSrc !== resolvedRoot) {
      return {
        success: false,
        error: `Refusing to push from outside the managed content root. sourceFolder=${sourceFolder} (resolved=${resolvedSrc}, root=${resolvedRoot})`,
        pushed: 0,
      }
    }
    // Replace sourceFolder downstream so the rest of the handler uses the
    // fully-resolved absolute path. (Avoids double-resolving against cwd.)
    sourceFolder = resolvedSrc

    const s = serial ? ['-s', serial] : []
    const currentUser = (await executeADB([...s, 'shell', 'am', 'get-current-user'], 10000) || '0').trim() || '0'
    // am switch-user takes a numeric user id. Validate before injecting.
    const requestedTargetUserRaw = String(targetUser || target_user || '').trim()
    if (requestedTargetUserRaw && !/^\d+$/.test(requestedTargetUserRaw)) {
      return {
        success: false,
        error: `Invalid targetUser (must be a non-negative integer): ${requestedTargetUserRaw}`,
        pushed: 0,
      }
    }
    const requestedTargetUser = requestedTargetUserRaw
    let activeUser = requestedTargetUser || currentUser

    if (requestedTargetUser && requestedTargetUser !== currentUser) {
      await executeADB([...s, 'shell', 'am', 'switch-user', requestedTargetUser], 20000)
      // Poll at 400ms cadence (vs 1000ms) with the same ~10s ceiling.
      // user-switch on Graphene settles in 4-8s — catching it sooner cuts
      // wall-clock by up to 600ms in the typical case.
      let switched = false
      let lastUser = currentUser
      for (let attempt = 0; attempt < 25; attempt++) {
        await sleep(400)
        lastUser = (await executeADB([...s, 'shell', 'am', 'get-current-user'], 10000) || '').trim()
        if (lastUser === requestedTargetUser) {
          activeUser = lastUser
          switched = true
          break
        }
      }
      if (!switched) {
        return {
          success: false,
          error: `Could not switch to Android user ${requestedTargetUser} before pushing media. Current user is ${lastUser || currentUser}.`,
          pushed: 0,
          targetUser: requestedTargetUser,
        }
      }
    }

    const client = new ModuleWebSocketClient('http://127.0.0.1', 'local-quick-upload')
    const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.avi', '.mkv', '.webm']
    const manualTransferOnly = String(accountUsername || '').trim() === ''

    if (activeUser !== '0') {
      const result = await client.executeCommand(serial, {
          action: 'push_to_profile',
        params: {
          source_folder: sourceFolder,
          target_user: activeUser,
          account_username: accountUsername,
          allow_owner_profile_staging: allowOwnerProfileStaging === true,
          ...(manualTransferOnly ? { manual_transfer_only: true } : {}),
          content_type: contentType || undefined,
          source_file: selectedSourceFile || undefined,
          transfer_id: transferId || transfer_id || undefined,
          max_files: maxFiles,
          extensions,
          port: 18765,
        },
      })
      const pushed = Number(result?.pushed || 0)

      return {
        success: !!result?.success,
        partial: !!result?.partial,
        pushed,
        total: Number(result?.total ?? maxFiles),
        transferId: result?.transfer_id,
        transfer_id: result?.transfer_id,
        manualTransferOnly: result?.manual_transfer_only === true,
        manual_transfer_only: result?.manual_transfer_only === true,
        manifest: result?.manifest || [],
        failures: result?.failures || [],
        method: result?.method || 'browser_download',
        targetUser: activeUser,
        error: result?.error,
      }
    }

    if (clearExisting) {
      await executeADB([...s, 'shell', 'rm', '-rf', '/sdcard/ShadowPhone/content/*'], 15000).catch(() => null)
    }

    const result = await client.executeCommand(serial, {
      action: 'push_files',
      params: {
        source_folder: sourceFolder,
        dest_folder: '/sdcard/ShadowPhone/content',
        account_username: accountUsername,
        ...(manualTransferOnly ? { manual_transfer_only: true } : {}),
        content_type: contentType || undefined,
        source_file: selectedSourceFile || undefined,
        transfer_id: transferId || transfer_id || undefined,
        max_files: maxFiles,
        extensions,
      },
    })
    const pushed = Number(result?.pushed || 0)

    return {
      success: !!result?.success,
      partial: !!result?.partial,
      pushed,
      total: Number(result?.total ?? maxFiles),
      transferId: result?.transfer_id,
      transfer_id: result?.transfer_id,
      manualTransferOnly: result?.manual_transfer_only === true,
      manual_transfer_only: result?.manual_transfer_only === true,
      manifest: result?.manifest || [],
      failures: result?.failures || [],
      method: 'adb_push',
      targetUser: activeUser,
      error: result?.error,
    }
  } catch (err) {
    return { success: false, error: err?.message || String(err), pushed: 0 }
  }
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// NOTE: the old renameProfileViaSettingsUi flow (and its XML/rename helpers)
// was deleted — it had zero call sites and contained an unlocked, unguarded
// `am switch-user` path. Profile renames live in handlers/profile-handlers.js.

function normalizeAdbTarget(target) {
  const raw = String(target || '').trim()
  if (!raw) return null

  if (raw.startsWith('adb://')) return raw.slice('adb://'.length).trim()
  if (raw.startsWith('tcp://')) return raw.slice('tcp://'.length).trim()

  // We only support direct ADB endpoints/serials here, not HTTP/WS URLs.
  if (/^https?:\/\//i.test(raw) || /^wss?:\/\//i.test(raw)) return null
  return raw
}

async function getDeviceProperty(serial, property) {
  try {
    const output = await executeADB(['-s', serial, 'shell', 'getprop', property])
    return output.trim()
  } catch {
    return null
  }
}

async function getBatteryLevel(serial) {
  try {
    const output = await executeADB(['-s', serial, 'shell', 'dumpsys', 'battery'])
    const levelMatch = output.match(/level:\s*(\d+)/)
    return levelMatch ? parseInt(levelMatch[1]) : null
  } catch {
    return null
  }
}

async function startADBServer() {
  try {
    await executeADB(['start-server'])
    return true
  } catch (error) {
    console.error('Failed to start ADB server:', error)
    return false
  }
}

async function stopADBServer() {
  try {
    await executeADB(['kill-server'])
  } catch (error) {
    console.error('Failed to stop ADB server:', error)
  }
}

// Device monitoring
let monitoringInterval = null

// Re-entrancy guard + ordering for the device sweep (F11/F12). A slow tailnet
// enumeration can exceed the 5s interval; without these, ticks stack adb
// processes and an older scan can resolve after a newer one and push stale
// state. `sweeping` drops overlapping ticks; the seq counter drops
// out-of-order broadcasts. `lastDevicesJson` suppresses no-diff re-renders.
let sweeping = false
let sweepSeq = 0
let lastBroadcastSeq = 0
let lastDevicesJson = null

function broadcastDevices(devices, seq) {
  // F12: drop stale out-of-order resolutions (an older slow scan resolving
  // after a newer one). Only send when the payload actually changed so
  // an idle fleet doesn't re-render the whole renderer tree every 5s.
  if (seq <= lastBroadcastSeq) return
  const json = JSON.stringify(devices)
  if (json === lastDevicesJson) {
    lastBroadcastSeq = seq
    return
  }
  lastDevicesJson = json
  lastBroadcastSeq = seq
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('devices-updated', devices)
  }
}

function startADBMonitoring() {
  const handlers = require('./handlers')

  // Idempotent: clear any prior interval first so a re-entry (e.g. macOS window
  // reactivation re-running createWindow) doesn't stack 5s ADB-poll intervals.
  if (monitoringInterval) { clearInterval(monitoringInterval); monitoringInterval = null }
  // Initial scan — only seed previousDeviceSerials, don't show popup yet
  // (saved devices haven't been synced from Supabase yet). `devices` may be the
  // null sentinel if this first scan lands during an adb restart — guard it.
  getConnectedDevices().then(devices => {
    if (devices == null) {
      console.warn('[Device] Initial scan: adb enumeration failed, skipping seed')
      return
    }
    // Delegate to device-handlers' seedDeviceSerials (F1) — keys on hwSerial
    // so a tailnet port rotation doesn't re-fire the new-device popup.
    handlers.seedDeviceSerials(devices)
    console.log('[Device] Initial scan seeded', devices.length, 'device serials')
    broadcastDevices(devices, ++sweepSeq)
  })

  // Poll every 5 seconds (balances responsiveness vs ADB call volume).
  monitoringInterval = setInterval(async () => {
    if (sweeping) return // F11: don't stack overlapping slow tailnet sweeps
    sweeping = true
    const mySeq = ++sweepSeq
    try {
      const devices = await getConnectedDevices()

      // Transient adb failure (null sentinel): keep the last-good fleet on
      // screen and DON'T touch previousDeviceSerials. Only after N back-to-back
      // failures do we fall through to the real empty-fleet path so a genuine
      // unplug-all still clears the UI.
      if (devices == null) {
        consecutiveDeviceScanFailures++
        if (consecutiveDeviceScanFailures < DEVICE_SCAN_FAILURE_LIMIT) {
          // Re-broadcast the cached last-good list (renderer keeps its current
          // fleet); skip checkForNewDevices so we don't corrupt previousDeviceSerials.
          broadcastDevices(connectedDevices, mySeq)
          return
        }
        // N consecutive failures: treat as a real empty fleet.
        const empty = []
        if (handlers.savedDevicesReady()) {
          handlers.checkForNewDevices(empty)
        } else {
          handlers.seedDeviceSerials(empty)
        }
        broadcastDevices(empty, mySeq)
        return
      }

      // Successful enumeration — reset the failure counter.
      consecutiveDeviceScanFailures = 0
      connectedDevices = devices   // mirror for null-sentinel re-broadcast below
      if (handlers.savedDevicesReady()) {
        // Gate is open: flag genuinely-new phones (F1).
        handlers.checkForNewDevices(devices)
      } else {
        // Keep previousDeviceSerials fresh even before the gate opens (F1).
        handlers.seedDeviceSerials(devices)
      }
      broadcastDevices(devices, mySeq)
    } catch (err) {
      // Never let a teardown-window send (or other tick error) bubble to the
      // global handler.
      console.warn('[Device] monitor tick error:', err?.message || err)
    } finally {
      sweeping = false
    }
  }, 5000)
}

function stopADBMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval)
    monitoringInterval = null
  }
}

// IPC Handlers
ipcMain.handle('adb-connect', async (_event, target) => {
  const normalizedTarget = normalizeAdbTarget(target)
  if (!normalizedTarget) {
    return {
      success: false,
      error: 'Invalid ADB target. Use host:port, serial, adb://host:port, or tcp://host:port.',
    }
  }

  try {
    const output = await executeADB(['connect', normalizedTarget])
    const success = /connected to|already connected to/i.test(output || '')
    // null sentinel = transient enumeration failure right after connect: fall
    // back to the cached last-good list rather than pushing [] (which would
    // flash the fleet offline).
    const devices = await getConnectedDevices() ?? connectedDevices
    broadcastDevices(devices, ++sweepSeq)
    if (!success) {
      return { success: false, target: normalizedTarget, error: output || 'ADB connect failed' }
    }
    return { success: true, target: normalizedTarget, output }
  } catch (error) {
    return {
      success: false,
      target: normalizedTarget,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

ipcMain.handle('adb-disconnect', async (_event, target) => {
  const normalizedTarget = normalizeAdbTarget(target)
  if (!normalizedTarget) {
    return {
      success: false,
      error: 'Invalid ADB target. Use host:port, serial, adb://host:port, or tcp://host:port.',
    }
  }

  try {
    const output = await executeADB(['disconnect', normalizedTarget])
    const success = /disconnected|no such device|no devices\/emulators found/i.test(output || '')
    const devices = await getConnectedDevices() ?? connectedDevices
    broadcastDevices(devices, ++sweepSeq)
    if (!success) {
      return { success: false, target: normalizedTarget, error: output || 'ADB disconnect failed' }
    }
    return { success: true, target: normalizedTarget, output }
  } catch (error) {
    return {
      success: false,
      target: normalizedTarget,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

// ==================== DEVICE MANAGEMENT IPC ====================

// Set user's saved devices (called from renderer after Supabase fetch)
// Add a new device to saved list (called after user confirms popup)
// Remove a device from saved list
// Get currently connected devices with saved status
// Dismiss new device alert (user clicked "Not Now")
ipcMain.handle('device-power', async (event, serial, action) => {
  // Audit every reboot/power-off. A phone that restarts shows bootreason
  // `shutdown,shell` — i.e. SOMETHING over adb told it to. This handler is the
  // only code path in the app that issues `adb reboot`, and it's only wired to
  // the two manual buttons (bulk "Restart" + Utilities reboot). Logging who/
  // when/which-serial here makes the next "my phone randomly rebooted" report
  // answerable from launcher.log instead of guesswork. Lazy-require so a load
  // failure of the logger never blocks the power action.
  const auditLog = (() => { try { return require('./lib/launcher-log') } catch (_) { return { write: () => {} } } })()
  try {
    if (action === 'reboot') {
      auditLog.write('device-power:reboot', { serial })
      await executeADB(['-s', serial, 'reboot'])
    } else if (action === 'power-off') {
      auditLog.write('device-power:power-off', { serial })
      await executeADB(['-s', serial, 'shell', 'reboot', '-p'])
    } else {
      return { success: false, error: `Unknown power action: ${action}` }
    }
    return { success: true }
  } catch (error) {
    auditLog.write('device-power:error', { serial, action, error: error?.message || String(error) })
    return { success: false, error: error.message }
  }
})

// 2.16.15: sidebar power-pill handlers. Tailnet phones need a bundled
// script for airplane-toggle because the moment airplane goes on, the
// tailnet adb session dies — same pattern as profile-handlers' switch.
function _isTailnetSerial(s) { return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(String(s || '')) }

// 2.21.14: cheap helper so the workflow can skip airplane_on/switch/off
// when target profile == current profile (avoids pointless IP cycling).
ipcMain.handle('phone:get-current-user', async (event, { serial }) => {
  try {
    const raw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
    const userId = String(raw || '').trim()
    return { success: true, userId }
  } catch (e) {
    return { success: false, error: e?.message || String(e) }
  }
})

async function togglePhoneAirplaneMode(serial) {
  try {
    if (_isTailnetSerial(serial)) {
      // Tailnet: blip airplane on for ~6s then auto-disable so we don't
      // strand the phone unreachable. 2.21.14: use setsid + safety-net
      // pattern (same as profile-handlers.js) so the disable step
      // survives even if the parent adb shell exits early.
      const logFile = '/data/local/tmp/sp-airplane.log'
      const scriptFile = '/data/local/tmp/sp-airplane.sh'
      const script = [
        // Safety net — force disable after 25s if main script dies
        `( sleep 25 ; cmd connectivity airplane-mode disable ; echo SAFETY_NET_FIRED >> ${logFile} ) &`,
        `date +%s.%3N > ${logFile}`,
        `echo START >> ${logFile}`,
        `cmd connectivity airplane-mode enable 2>> ${logFile}`,
        'sleep 6',
        `cmd connectivity airplane-mode disable 2>> ${logFile}`,
        `echo DONE >> ${logFile}`,
      ].join(' ; ')
      const encoded = Buffer.from(script).toString('base64')
      // Two-step: file-write (synchronous, can use `&&`) then detached spawn
      // (uses `&` so no `&&` after it — Android sh syntax limitation).
      await executeADB(['-s', serial, 'shell',
        `echo ${encoded} | base64 -d > ${scriptFile} && chmod 755 ${scriptFile}`
      ], 6000)
      await executeADB(['-s', serial, 'shell',
        `setsid sh ${scriptFile} </dev/null >/dev/null 2>&1 &`
      ], 6000)
      return { success: true, mode: 'tailnet-blip-setsid', note: 'airplane on for ~6s then off (setsid + 25s safety net)' }
    }
    // USB: read current state, flip it.
    const raw = await executeADB(['-s', serial, 'shell', 'settings', 'get', 'global', 'airplane_mode_on'], 4000)
    const on = String(raw || '').trim() === '1'
    const next = on ? 'disable' : 'enable'
    await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', next], 6000)
    return { success: true, mode: 'usb', wasOn: on, nowOn: !on }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
ipcMain.handle('phone:airplane-toggle', (_event, { serial }) => togglePhoneAirplaneMode(serial))

// 2.19.0: explicit-state airplane setter. The legacy `phone:airplane-toggle`
// is an idempotent flip (and on tailnet, an auto-blip ON→OFF in 6s). The
// workflow's `airplane_off` step was previously a no-op because the
// renderer comment expected airplane_on to "bracket" the off — but on USB
// transports, airplane_on just leaves the phone in airplane mode and the
// flow never recovers. switch_profile, push_content, posting all fail
// because the network is down.
//
// This handler is idempotent on intent: callers say "on" or "off" and
// only see an adb call if the state actually needs to change. The
// returned `wasOn`/`nowOn` tells the caller whether anything moved.
ipcMain.handle('phone:airplane-set', async (event, { serial, state }) => {
  try {
    const want = String(state || '').toLowerCase()
    if (want !== 'on' && want !== 'off') {
      return { success: false, error: `invalid state "${state}" — expected "on" or "off"` }
    }
    const raw = await executeADB(['-s', serial, 'shell', 'settings', 'get', 'global', 'airplane_mode_on'], 4000)
    const isOn = String(raw || '').trim() === '1'
    const wantOn = want === 'on'
    if (isOn === wantOn) {
      return { success: true, wasOn: isOn, nowOn: isOn, noop: true }
    }
    const cmd = wantOn ? 'enable' : 'disable'
    await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', cmd], 6000)
    return { success: true, wasOn: isOn, nowOn: wantOn, noop: false }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('phone:reboot', async (event, { serial }) => {
  try {
    await executeADB(['-s', serial, 'reboot'], 6000)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('phone:power-off', async (event, { serial }) => {
  try {
    await executeADB(['-s', serial, 'shell', 'reboot', '-p'], 6000)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

async function togglePhoneScreen(serial) {
  try {
    // KEYCODE_POWER (26) toggles screen on/off regardless of current state.
    await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '26'], 4000)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
ipcMain.handle('phone:screen-toggle', (_event, { serial }) => togglePhoneScreen(serial))

function isPhoneAwake(powerState) {
  const state = String(powerState || '')
  if (/mWakefulness=(Awake|Dreaming)/i.test(state)) return true
  if (/mWakefulness=(Asleep|Dozing)/i.test(state)) return false
  return /Display Power:\s*state=ON|mScreenOn=true|Display.*\bON\b/i.test(state)
}

async function lockPhoneScreen(serial) {
  try {
    const before = await executeADB(['-s', serial, 'shell', 'dumpsys', 'power'], 5000)
    if (!isPhoneAwake(before)) return { success: true, state: 'already_locked' }
    await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '223'], 4000)
    await new Promise(r => setTimeout(r, 300))
    const after = await executeADB(['-s', serial, 'shell', 'dumpsys', 'power'], 5000)
    if (isPhoneAwake(after)) return { success: false, error: 'Android still reports the screen as awake' }
    return { success: true, state: 'locked' }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
ipcMain.handle('phone:lock', (_event, { serial }) => lockPhoneScreen(serial))

// 2.18.11: wake + actually unlock — power on the screen, wait, swipe up to
// dismiss lockscreen. Workflow's wake_unlock step was only toggling power
// before. Anyro: "had to unlock my phone after hitting run now". Works on
// no-PIN profiles (most VA-managed profiles).
async function wakeAndUnlockPhone(serial) {
  try {
    // KEYCODE_WAKEUP (224) — pure wake, no toggle, safe to call even if screen is already on
    await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '224'], 4000)
    await new Promise(r => setTimeout(r, 500))
    // KEYCODE_MENU (82) dismisses lockscreen on most GrapheneOS / AOSP builds
    await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '82'], 4000).catch(() => {})
    // Swipe up — covers slide-to-unlock UIs (Pixel default).
    // Coords are device-pixel based; 540,1800 → 540,600 is bottom-half upward.
    await executeADB(['-s', serial, 'shell', 'input', 'swipe', '540', '1800', '540', '600', '200'], 4000).catch(() => {})
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
ipcMain.handle('phone:wake-unlock', (_event, { serial }) => wakeAndUnlockPhone(serial))

// 2.16.20: gallery + current-profile readout. All operate on the current
// foreground user (so VAs don't need to think about user IDs — whichever
// profile the phone is on is what gets opened / wiped).
async function openPhoneGallery(serial) {
  try {
    // GrapheneOS ships com.android.gallery3d (validated on Anyro's pixel-6).
    // Try the package launch first; if that 404s (e.g. user removed it),
    // fall back to the generic VIEW image/* intent which any installed
    // gallery handler will catch.
    try {
      await executeADB(['-s', serial, 'shell', 'am', 'start', '--user', 'current',
        '-n', 'com.android.gallery3d/.app.GalleryActivity'], 6000)
      return { success: true, via: 'gallery3d' }
    } catch (_) {
      await executeADB(['-s', serial, 'shell', 'am', 'start', '--user', 'current',
        '-a', 'android.intent.action.VIEW', '-t', 'image/*'], 6000)
      return { success: true, via: 'intent' }
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
ipcMain.handle('phone:open-gallery', (_event, { serial }) => openPhoneGallery(serial))

async function clearPhoneGallery(serial) {
  try {
    // Resolve current foreground user — that's whose gallery we're wiping.
    const userRaw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
    const userId = String(userRaw || '').trim()
    if (!/^\d+$/.test(userId)) return { success: false, error: `couldn't read current user (got "${userId}")` }

    // MediaStore URIs are per-user on Android. content delete with WHERE 1=1
    // removes every row that the MediaStore tracks for that user. The
    // backing files are unlinked by MediaProvider's onDelete hook.
    const wipe = async (uri) => {
      try {
        await executeADB(['-s', serial, 'shell', 'content', 'delete',
          '--user', userId, '--uri', uri, '--where', '"1=1"'], 8000)
        return true
      } catch (_) { return false }
    }
    const imgOk = await wipe('content://media/external/images/media')
    const vidOk = await wipe('content://media/external/video/media')
    return { success: true, userId, images: imgOk, videos: vidOk }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
ipcMain.handle('phone:clear-gallery', (_event, { serial }) => clearPhoneGallery(serial))

// 2.16.27: per-serial+profile → content folder name mapping. Stored as
// JSON in userData so VAs don't have to re-type the name every session.
function _profileFolderMapPath() {
  return require('path').join(app.getPath('userData'), 'profile-content-folders.json')
}
function _readProfileFolderMap() {
  try {
    const p = _profileFolderMapPath()
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
  } catch (_) { return {} }
}
function _writeProfileFolderMap(obj) {
  try {
    fs.writeFileSync(_profileFolderMapPath(), JSON.stringify(obj, null, 2), 'utf8')
  } catch (e) { console.warn('[content-folder] write map failed:', e?.message || e) }
}
async function _currentUserOf(serial) {
  try {
    const raw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
    return String(raw || '').trim()
  } catch (_) { return null }
}

// 2.16.45: sidebar-content + schedule handler inits MOVED to after CONTENT_ROOT
// declaration. Were here originally (line ~1957) but CONTENT_ROOT is declared
// at ~3474 — referencing it before declaration hit TDZ ReferenceError, caught
// by the surrounding try/catch and silently logged. Result: IPC handlers were
// never registered, every sidebar:create-account call failed with
// "No handler registered". See 3474+ for the real init.

ipcMain.handle('phone:open-content-folder', async (event, { serial }) => {
  try {
    const userId = await _currentUserOf(serial)
    if (!userId || !/^\d+$/.test(userId)) return { success: false, error: 'could not read current user' }
    const path = require('path')
    const platformLower = 'instagram'
    const map = _readProfileFolderMap()
    const key = `${serial}::${userId}`
    let accountKey = map[key]

    // 2.16.28: if no cached mapping, AUTO-DISCOVER the folder by matching
    // the current profile name to an existing Content/instagram/<name>/
    // directory. The dashboard's Schedule tab already creates these folders
    // (e.g. "eileenswrld") and the profile name matches case-insensitive.
    if (!accountKey) {
      try {
        const listRaw = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'], 4000)
        const m = String(listRaw || '').match(new RegExp(`UserInfo\\{${userId}:([^:]+):`))
        const profileName = m ? m[1].trim() : ''
        if (profileName && profileName.toLowerCase() !== 'null') {
          const platformRoot = path.join(CONTENT_ROOT, platformLower)
          if (fs.existsSync(platformRoot)) {
            const entries = fs.readdirSync(platformRoot, { withFileTypes: true })
              .filter(d => d.isDirectory())
              .map(d => d.name)
            // 2.16.30: EXACT case-insensitive match only. Substring matching
            // produced bad pairings — e.g. "TestFresh"/"testprofile88"/
            // "test6"/"v2proftest" all collided onto a folder called "test".
            // Cleaner UX: if no exact match, prompt the operator instead
            // of silently picking the wrong folder.
            const hit = entries.find(n => n.toLowerCase() === profileName.toLowerCase())
            if (hit) {
              accountKey = hit
              map[key] = hit
              _writeProfileFolderMap(map)
              console.log(`[content-folder] auto-mapped ${serial}::${userId} (${profileName}) → ${hit}`)
            }
          }
        }
      } catch (e) {
        console.warn('[content-folder] auto-discover failed:', e?.message || e)
      }
    }

    if (!accountKey) return { success: false, error: 'no-mapping' }
    const accountPath = path.join(CONTENT_ROOT, platformLower, accountKey)
    if (!fs.existsSync(accountPath)) fs.mkdirSync(accountPath, { recursive: true })
    shell.openPath(accountPath)
    return { success: true, path: accountPath, accountKey }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('phone:create-content-folder', async (event, { serial, accountName }) => {
  try {
    const userId = await _currentUserOf(serial)
    if (!userId || !/^\d+$/.test(userId)) return { success: false, error: 'could not read current user' }
    const accountKey = normalizeContentAccountKey(accountName)
    if (!accountKey) return { success: false, error: 'account name required' }
    // Create with default templates pre-loaded.
    const created = createAccountFolders('instagram', accountKey)
    if (!created.success) return { success: false, error: created.error || 'create failed' }
    // Persist mapping so Open Folder works next time without prompting.
    const map = _readProfileFolderMap()
    map[`${serial}::${userId}`] = accountKey
    _writeProfileFolderMap(map)
    shell.openPath(created.path)
    return { success: true, path: created.path, accountKey }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('phone:current-profile', async (event, { serial }) => {
  try {
    const userRaw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
    const userId = String(userRaw || '').trim()
    if (!/^\d+$/.test(userId)) return { success: false, error: 'no user id' }
    // pm list users → "UserInfo{12:Smoke262:410} running"
    // 2.16.23: Owner profile's name field literally reads "null" on
    // GrapheneOS — display "Owner" instead. Empty / missing match falls
    // back to "user N" so the header never shows the word "null".
    const listRaw = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'], 4000)
    const m = String(listRaw || '').match(new RegExp(`UserInfo\\{${userId}:([^:]+):`))
    let name = m ? m[1].trim() : ''
    if (!name || name.toLowerCase() === 'null') {
      name = userId === '0' ? 'Owner' : `user ${userId}`
    }
    return { success: true, id: userId, name }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// Get GrapheneOS profiles for a device
// Get current active profile on a device

// Create a new profile on the device
// Delete a profile from the device
// Rename a profile on the device (GrapheneOS)
// ==================== SYSTEM HANDLERS ====================
// ADB, update, app-info, and api-config handlers are registered in system-handlers.js â€” do NOT duplicate here

// ==================== SERVER-SIDE MODULE EXECUTION ====================
// Modules run on server, Electron executes returned ADB actions

// Execute a single ADB action (REST API mode)
async function executeAction(deviceId, action) {
  const type = action.type || action.action

  switch (type) {
    // Basic input
    case 'tap':
      await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(action.x), String(action.y)])
      break
    case 'double_tap':
      await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(action.x), String(action.y)])
      await new Promise(r => setTimeout(r, 50))
      await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(action.x), String(action.y)])
      break
    case 'long_tap':
    case 'long_press':
      await executeADB(['-s', deviceId, 'shell', 'input', 'swipe',
        String(action.x), String(action.y), String(action.x), String(action.y),
        String(action.duration || 1000)])
      break
    case 'swipe':
      await executeADB(['-s', deviceId, 'shell', 'input', 'swipe',
        String(action.x1 || action.startX), String(action.y1 || action.startY),
        String(action.x2 || action.endX), String(action.y2 || action.endY),
        String(action.duration || 300)])
      break
    case 'swipe_up':
      await executeADB(['-s', deviceId, 'shell', 'input', 'swipe', '540', '1500', '540', '500', '300'])
      break
    case 'swipe_down':
      await executeADB(['-s', deviceId, 'shell', 'input', 'swipe', '540', '500', '540', '1500', '300'])
      break
    case 'scroll':
      const dir = action.direction || 'down'
      if (dir === 'down') {
        await executeADB(['-s', deviceId, 'shell', 'input', 'swipe', '540', '1200', '540', '700', '300'])
      } else if (dir === 'up') {
        await executeADB(['-s', deviceId, 'shell', 'input', 'swipe', '540', '700', '540', '1200', '300'])
      }
      break

    // Text input
    case 'input':
    case 'input_text':
    case 'text':
    case 'type':
      let text = action.text || action.value || ''
      if (action.clear_first || action.clear) {
        await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '67']) // Delete key
      }
      const encodeAdbText = (value) => String(value)
        .replace(/(["'`\\$!&*()[\]{}|;<>?])/g, '\\$1')
        .replace(/ /g, '%s')

      const normalizedText = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      if (normalizedText.includes('\n')) {
        const parts = normalizedText.split('\n')
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]
          if (part) {
            await executeADB(['-s', deviceId, 'shell', 'input', 'text', encodeAdbText(part)])
          }
          if (i < parts.length - 1) {
            // Insert newline between segments for multiline inputs (e.g., bio).
            await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '66'])
          }
        }
      } else {
        const escapedText = encodeAdbText(normalizedText)
        await executeADB(['-s', deviceId, 'shell', 'input', 'text', escapedText])
      }
      break

    // Key events
    case 'keyevent':
    case 'key':
      await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', String(action.keycode || action.key)])
      break
    case 'back':
      await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '4'])
      break
    case 'home':
      await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '3'])
      break
    case 'enter':
      await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '66'])
      break

    // App management
    case 'launch':
    case 'launch_app':
    case 'open_app':
      await executeADB(['-s', deviceId, 'shell', 'monkey', '-p', action.package || action.packageName, '-c',
        'android.intent.category.LAUNCHER', '1'])
      break
    case 'force_stop':
    case 'kill_app':
      await executeADB(['-s', deviceId, 'shell', 'am', 'force-stop', action.package || action.packageName])
      break

    // System settings
    case 'airplane_on':
      await executeADB(['-s', deviceId, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'])
      break
    case 'airplane_off':
      await executeADB(['-s', deviceId, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'])
      break
    case 'airplane_toggle':
      const state = await executeADB(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'airplane_mode_on'])
      await executeADB(['-s', deviceId, 'shell', 'cmd', 'connectivity', 'airplane-mode', state.trim() === '1' ? 'disable' : 'enable'])
      break

    // Shell and timing
    case 'shell':
    case 'exec':
      const result = await executeADB(['-s', deviceId, 'shell', action.command || action.cmd])
      return { output: result }
    case 'wait':
    case 'sleep':
    case 'delay':
      await new Promise(resolve => setTimeout(resolve, action.ms || action.duration || 1000))
      break

    // Screen operations
    case 'screenshot':
      const timestamp = Date.now()
      const localPath = path.join(app.getPath('temp'), `screenshot_${timestamp}.png`)
      await executeADB(['-s', deviceId, 'shell', 'screencap', '-p', '/sdcard/screenshot.png'])
      await executeADB(['-s', deviceId, 'pull', '/sdcard/screenshot.png', localPath])
      await executeADB(['-s', deviceId, 'shell', 'rm', '/sdcard/screenshot.png'])
      return { path: localPath }
    case 'screen_on':
    case 'wake':
      await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '224'])
      break
    case 'unlock':
      await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '224'])
      await new Promise(r => setTimeout(r, 300))
      await executeADB(['-s', deviceId, 'shell', 'input', 'swipe', '540', '1800', '540', '800', '300'])
      break

    // Instagram specific
    case 'open_instagram':
      await executeADB(['-s', deviceId, 'shell', 'monkey', '-p', 'com.instagram.android', '-c',
        'android.intent.category.LAUNCHER', '1'])
      break

    // ==================== ELEMENT-BASED COMMANDS ====================
    // Server sends pre-resolved coordinates OR bounds strings
    case 'tap_element':
    case 'click_element':
      if (action.x && action.y) {
        await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(action.x), String(action.y)])
      } else if (action.bounds) {
        const bounds = action.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
        if (bounds) {
          const cx = Math.floor((parseInt(bounds[1]) + parseInt(bounds[3])) / 2)
          const cy = Math.floor((parseInt(bounds[2]) + parseInt(bounds[4])) / 2)
          await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(cx), String(cy)])
        }
      }
      break

    case 'input_text_element':
    case 'type_in_element':
      // Tap first if coordinates provided
      if (action.x && action.y) {
        await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(action.x), String(action.y)])
        await new Promise(r => setTimeout(r, 300))
      }
      if (action.clear_first || action.clear) {
        await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '67'])
      }
      const elemText = action.text || action.value || ''
      const escapedElemText = elemText.replace(/(["'`\\$!&*()[\]{}|;<>?])/g, '\\$1').replace(/ /g, '%s')
      await executeADB(['-s', deviceId, 'shell', 'input', 'text', escapedElemText])
      break

    case 'long_press_element':
      if (action.x && action.y) {
        await executeADB(['-s', deviceId, 'shell', 'input', 'swipe',
          String(action.x), String(action.y), String(action.x), String(action.y),
          String(action.duration || 1000)])
      }
      break

    case 'swipe_element':
      if (action.x && action.y) {
        const endX = action.x + (action.dx || 0)
        const endY = action.y + (action.dy || 0)
        await executeADB(['-s', deviceId, 'shell', 'input', 'swipe',
          String(action.x), String(action.y), String(endX), String(endY),
          String(action.duration || 300)])
      }
      break

    // ==================== APPIUM-STYLE COMMANDS ====================
    // For modules using Appium-like syntax
    case 'click':
      if (action.element && action.element.x && action.element.y) {
        await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(action.element.x), String(action.element.y)])
      } else if (action.x && action.y) {
        await executeADB(['-s', deviceId, 'shell', 'input', 'tap', String(action.x), String(action.y)])
      }
      break

    case 'send_keys':
      const keys = action.keys || action.text || action.value || ''
      const escapedKeys = keys.replace(/(["'`\\$!&*()[\]{}|;<>?])/g, '\\$1').replace(/ /g, '%s')
      await executeADB(['-s', deviceId, 'shell', 'input', 'text', escapedKeys])
      break

    case 'clear':
      // Clear text field - Ctrl+A then delete
      await executeADB(['-s', deviceId, 'shell', 'input', 'keyevent', '67'])
      break

    // ==================== SCREEN DUMP FOR ELEMENT FINDING ====================
    case 'dump_screen':
    case 'get_screen':
    case 'get_ui':
      try {
        await executeADB(['-s', deviceId, 'shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'])
        const xml = await executeADB(['-s', deviceId, 'shell', 'cat', '/sdcard/window_dump.xml'])
        return { xml, success: true }
      } catch (e) {
        return { xml: null, success: false, error: e.message }
      }

    default:
      // progress, complete, etc. are handled by caller
      console.log(`[Action] Unhandled type: ${type}`)
      break
  }

  // Apply delay if specified
  if (action.delay && action.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, action.delay))
  }

  return null
}

// Run module via server API
async function executeModuleRun(config) {
  // Hold the per-phone busy lock for the whole auto-run so the schedule engine's
  // tick skips this phone (prevents a scheduled slot colliding with a queued run).
  // FAIL CLOSED: when something else holds the lock (engine fire, sweep,
  // switch-profile, companion pass), do NOT run unlocked on a busy phone —
  // report PHONE_BUSY so pollRuntimeQueue defers instead of colliding.
  const _devId = config && config.deviceId
  let _releasePhoneLock = null
  try {
    const _se = require('./lib/schedule-engine')
    if (_se && _devId) {
      _releasePhoneLock = _se.acquirePhoneLock(_devId)
      if (!_releasePhoneLock) {
        return {
          id: config?.runId,
          moduleId: config?.moduleId,
          status: 'failed',
          logs: [],
          progress: 0,
          result: {
            success: false,
            code: 'PHONE_BUSY',
            retryable: true,
            error: 'This phone is already running another automation. The queued run was not started.',
          },
        }
      }
    }
  } catch (_) {}
  try {
    return await _executeModuleRunLocked(config)
  } finally {
    if (_releasePhoneLock) _releasePhoneLock()
    // Guarantee the run-state entry is cleared on EVERY exit. _executeModuleRunLocked
    // only deletes on success/catch — its 429-quota and 403-subscription early returns
    // leaked a phantom entry that wedged pollRuntimeQueue (size>0) forever until restart.
    try { if (config && config.runId) runningModules.delete(config.runId) } catch (_) {}
  }
}

async function _executeModuleRunLocked(config) {
  const { runId, moduleId, deviceId, profileId, config: moduleConfig } = config

  console.log(`[Module] Starting ${moduleId} (${runId}) via server API`)

  // Public-launch hardening: do not allow anonymous module execution.
  const jwtToken = await getModuleToken()
  if (!jwtToken || !currentUserSession.userId) {
    return {
      id: runId,
      moduleId,
      status: 'failed',
      logs: [],
      progress: 0,
      startTime: new Date(),
      endTime: new Date(),
      result: { success: false, error: 'Not authenticated. Please log in to run modules.' }
    }
  }

  // Preflight: make sure the selected device is still connected.
  if (deviceId) {
    try {
      const devices = await getConnectedDevices()
      const isConnected = Array.isArray(devices) && devices.some(d => d.serial === deviceId && d.connected)
      if (!isConnected) {
        return {
          id: runId,
          moduleId,
          status: 'failed',
          logs: [],
          progress: 0,
          startTime: new Date(),
          endTime: new Date(),
          result: { success: false, error: `Device ${deviceId} is not connected. Reconnect the phone and try again.` }
        }
      }
    } catch (deviceCheckError) {
      console.warn('[Module] Device preflight check failed:', deviceCheckError?.message || deviceCheckError)
    }
  }

  const runState = {
    aborted: false,
    logs: [],
    startTime: new Date()
  }
  runningModules.set(runId, runState)

  try {
    // Fetch actions from Python module server (Railway)
    // Include userId for quota tracking
    // Build headers with Clerk token for server-side verification
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `ModuleJWT ${jwtToken}`,
    }

    const response = await fetch(`${MODULES_SERVER_URL}/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: currentUserSession.userId,
        email: currentUserSession.email || null,
        moduleId,
        deviceId,
        profileId,
        config: moduleConfig,
        clientVersion: APP_VERSION
      })
    })

    // Handle quota exceeded
    if (response.status === 429) {
      const error = await response.json()
      console.log('[Module] Quota exceeded:', error)

      // Notify renderer about quota exceeded
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('quota-exceeded', {
          runsToday: error.runs_today,
          runsLimit: error.runs_limit,
          plan: error.plan
        })
      }

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

      // Notify renderer about expired subscription
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('subscription-expired', {
          wasTrial: error.was_trial,
          plan: error.plan,
          message: error.message
        })
      }

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

    // Log remaining quota
    if (quota) {
      console.log(`[Module] Quota: ${quota.remaining} runs remaining today`)
    }

    let result = null

    // Execute each action sequentially
    for (const action of actions) {
      // Check if aborted
      if (runState.aborted) {
        console.log(`[Module] Aborted ${runId}`)
        break
      }

      // Handle progress updates
      if (action.type === 'progress') {
        const progressLog = { type: 'progress', percent: action.percent, message: action.message }
        runState.logs.push(progressLog)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('module-progress', { runId, ...progressLog })
        }
        continue
      }

      // Handle completion
      if (action.type === 'complete') {
        result = action
        continue
      }

      // Execute ADB action
      try {
        await executeAction(deviceId, action)
        runState.logs.push({ type: 'action', action: action.type, success: true })
      } catch (actionError) {
        console.error(`[Module] Action failed:`, actionError)
        runState.logs.push({ type: 'action', action: action.type, success: false, error: actionError.message })
        // Continue execution unless critical
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
}

// Abort a running module
// Get list of available modules
// ==================== USER SESSION HANDLERS ====================

// Set user session when Clerk auth completes
let _sessionSetGeneration = 0
let _pendingSessionCandidate = null
let _sessionVerificationExpiryTimer = null
let _sessionRecoveryPromise = null
let _sessionRecoveryBlocked = false
async function setUserSession(event, { userId, email, sessionToken }) {
  if (userId) _sessionRecoveryBlocked = false
  console.log(`[Session] Setting user session: ${userId} (${email}) [Token: ${sessionToken ? 'present' : 'missing'}]`)
  const previousSession = currentUserSession?.userId ? currentUserSession : _pendingSessionCandidate
  const previousUserId = previousSession?.userId || null
  // Drop any cached module JWT before switching identity — an account switch can
  // fire set-user-session without an intervening clear-user-session, which would
  // otherwise leak the prior tenant's token until it expired.
  // Merge, don't overwrite: renderer sync points pass `token || undefined`,
  // so a blank incoming token for the SAME user must not wipe a token we
  // already hold (that wipe is what armed the "Sign in to ShadowPhone"
  // gate on account creation for signed-in users).
  const incomingToken = String(sessionToken || '').trim() || null
  const sameUser = previousUserId && previousUserId === String(userId || '')
  const effectiveToken = incomingToken || (sameUser ? previousSession?.sessionToken || null : null)
  const generation = ++_sessionSetGeneration
  _pendingSessionCandidate = { userId: String(userId || ''), sessionToken: effectiveToken }
  if (!sameUser) {
    clearModuleToken()
    currentUserSession = { userId: null, email: null, sessionToken: null }
    stopRuntimeQueueRelay()
  }
  let verified = false
  let unavailable = null
  try {
    verified = await require('./lib/app-auth-fetch').verifySessionIdentity(
      String(userId || ''), effectiveToken, {
        apiBaseUrl: APP_URL,
        onFailure: diagnostic => console.warn('[Session] Verification failed:', diagnostic),
      },
    )
  } catch (error) {
    if (error?.code === 'SESSION_VERIFICATION_UNAVAILABLE') unavailable = error
    else console.warn('[Session] Verification failed:', { failureClass: 'unknown' })
  }
  if (generation !== _sessionSetGeneration) return { success: false, code: 'SESSION_CHANGED' }
  _pendingSessionCandidate = null
  if (_sessionVerificationExpiryTimer) { clearTimeout(_sessionVerificationExpiryTimer); _sessionVerificationExpiryTimer = null }
  if (unavailable) {
    const verifiedUntil = Number(currentUserSession?.verifiedUntil) || 0
    const retainedSession = Boolean(sameUser && currentUserSession?.userId === userId && currentUserSession?.sessionToken && verifiedUntil > Date.now())
    if (retainedSession) {
      _sessionVerificationExpiryTimer = setTimeout(() => {
        _sessionVerificationExpiryTimer = null
        if (currentUserSession?.userId !== userId || currentUserSession?.verifiedUntil !== verifiedUntil) return
        clearModuleToken()
        currentUserSession = { userId: null, email: null, sessionToken: null }
        stopRuntimeQueueRelay()
        console.warn('[Session] Retained verification expired')
      }, verifiedUntil - Date.now())
      _sessionVerificationExpiryTimer.unref?.()
    } else {
      clearModuleToken()
      currentUserSession = { userId: null, email: null, sessionToken: null }
      stopRuntimeQueueRelay()
    }
    console.warn('[Session] Verification deferred:', { failureClass: unavailable.failureClass, status: unavailable.status || null, retainedSession })
    return { success: false, code: 'SESSION_VERIFICATION_UNAVAILABLE', retryable: true, retainedSession, error: 'ShadowPhone could not reach sign-in verification. It will retry automatically.' }
  }
  if (!verified) {
    clearModuleToken()
    currentUserSession = { userId: null, email: null, sessionToken: null }
    stopRuntimeQueueRelay()
    return { success: false, code: 'SESSION_UNVERIFIED', error: 'ShadowPhone could not verify this sign-in. Sign in again and retry.' }
  }
  currentUserSession = {
    userId,
    email: typeof verified.email === 'string' ? verified.email : null,
    sessionToken: effectiveToken,  // Clerk JWT for server-side verification
    authenticatedAt: new Date().toISOString(),
    verifiedUntil: Date.now() + Math.max(0, _expiresInMs(effectiveToken, Date.now())),
  }
  // Notify renderer of admin status (for future UI gating)
  const admin = isAdminUser()
  console.log(`[Session] Admin status: ${admin}`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('admin-status', { isAdmin: admin })
  }

  // 2.16.18: Crisp removed — no admin bypass, no widget. Network block is
  // installed unconditionally in createWindow().

  // Start queued-run relay once a valid authenticated session exists.
  if (userId && effectiveToken) {
    startRuntimeQueueRelay()
    try {
      const scheduleHandlers = require('./handlers/schedule-handlers')
      if (previousUserId && previousUserId !== userId) scheduleHandlers.resetUserScopedState()
      scheduleHandlers.resumeUserScopedState()
    } catch (e) {
      console.warn('[Session] schedule resume failed:', e?.message || e)
    }
  }

  return { success: true, isAdmin: admin }
}
ipcMain.handle('set-user-session', setUserSession)

async function recoverVerifiedSession() {
  if (_sessionRecoveryBlocked || currentUserSession?.userId || !mainWindow || mainWindow.isDestroyed()) return
  if (_sessionRecoveryPromise) return _sessionRecoveryPromise
  const generation = _sessionSetGeneration
  _sessionRecoveryPromise = (async () => {
    let timer
    try {
      const candidate = await Promise.race([
        mainWindow.webContents.executeJavaScript(`(async () => {
          try {
            const session = window.Clerk?.session
            const userId = window.Clerk?.user?.id
            if (!session || !userId) return null
            const sessionToken = await session.getToken({ skipCache: true })
            if (window.Clerk?.session?.id !== session.id || window.Clerk?.user?.id !== userId) return null
            return sessionToken ? { userId, sessionToken } : null
          } catch (_) { return null }
        })()`, true),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), MINT_TIMEOUT_MS); timer.unref?.() }),
      ])
      if (!candidate || generation !== _sessionSetGeneration || _sessionRecoveryBlocked || currentUserSession?.userId) return
      return await setUserSession(null, candidate)
    } catch (_) {
      console.warn('[Session] Recovery unavailable:', { failureClass: 'renderer' })
    } finally {
      if (timer) clearTimeout(timer)
      _sessionRecoveryPromise = null
    }
  })()
  return _sessionRecoveryPromise
}

// Get current user session
ipcMain.handle('get-user-session', async () => {
  return currentUserSession
})

// Clear session on logout
ipcMain.handle('clear-user-session', async () => {
  ++_sessionSetGeneration
  _sessionRecoveryBlocked = true
  if (_sessionVerificationExpiryTimer) { clearTimeout(_sessionVerificationExpiryTimer); _sessionVerificationExpiryTimer = null }
  _pendingSessionCandidate = null
  console.log('[Session] Clearing user session and device cache')
  stopRuntimeQueueRelay()
  // Drop the cached module JWT so the next user can't inherit this tenant's token.
  clearModuleToken()
  currentUserSession = {
    userId: null,
    email: null,
    sessionToken: null,
    authenticatedAt: null
  }
  // Reset device-handlers' module-level singletons (saved/alerted device sets,
  // previousDeviceSerials + sync gate, the live device list, tailnet endpoints,
  // account handles) so a reassigned machine's next user gets fresh device
  // detection and doesn't inherit the prior fleet.
  try { require('./handlers/device-handlers').resetUserScopedState() } catch (e) { console.warn('[Session] device reset failed:', e?.message) }
  // Stop the schedule engine + drop its in-memory fire/busy latches. Schedules are
  // Supabase-first (re-pulled per userId on sign-in) so no user data is lost.
  try { require('./handlers/schedule-handlers').resetUserScopedState() } catch (e) { console.warn('[Session] schedule reset failed:', e?.message) }
  console.log('[Session] Device cache cleared - new devices will trigger popup')
  return { success: true }
})

// ==================== DIRECT DEVICE ACTIONS ====================
// These execute immediately via ADB without needing the Railway server

// Open Instagram app
ipcMain.handle('open-instagram', async (event, serial) => {
  try {
    console.log(`[Instagram] Opening Instagram on device: ${serial}`)
    await executeADB(['-s', serial, 'shell', 'monkey', '-p', 'com.instagram.android', '-c', 'android.intent.category.LAUNCHER', '1'])
    return { success: true }
  } catch (error) {
    console.error('[Instagram] Error opening app:', error)
    return { success: false, error: error.message }
  }
})

// Open Instagram DMs
ipcMain.handle('open-instagram-dm', async (event, serial) => {
  try {
    await executeADB(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'instagram://direct_inbox'])
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// Open a specific Instagram profile
ipcMain.handle('open-instagram-profile', async (event, serial, username) => {
  try {
    await executeADB(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `instagram://user?username=${username}`])
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// Toggle airplane mode (IP reset)
ipcMain.handle('toggle-airplane', async (event, serial) => {
  try {
    console.log(`[Airplane] Toggling airplane mode on device: ${serial}`)

    // Get current state
    const state = await executeADB(['-s', serial, 'shell', 'settings', 'get', 'global', 'airplane_mode_on'])
    const isOn = state.trim() === '1'

    // Toggle
    await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', isOn ? 'disable' : 'enable'])

    // Wait for network change
    await new Promise(resolve => setTimeout(resolve, 2000))

    return { success: true, newState: !isOn }
  } catch (error) {
    console.error('[Airplane] Error toggling:', error)
    return { success: false, error: error.message }
  }
})

// Full IP reset cycle (airplane on -> wait -> airplane off)
ipcMain.handle('reset-ip', async (event, serial, waitMs = 5000) => {
  try {
    console.log(`[IP Reset] Starting IP reset on device: ${serial}`)

    // Notify frontend
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('module-progress', { type: 'progress', message: 'Enabling airplane mode...' })
    }

    // Enable airplane
    await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'])

    // Wait
    await new Promise(resolve => setTimeout(resolve, waitMs))

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('module-progress', { type: 'progress', message: 'Disabling airplane mode...' })
    }

    // Disable airplane
    await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'])

    // Wait for network to reconnect
    await new Promise(resolve => setTimeout(resolve, 3000))

    console.log('[IP Reset] Complete')
    return { success: true }
  } catch (error) {
    console.error('[IP Reset] Error:', error)
    return { success: false, error: error.message }
  }
})

// Get device screen state (for debugging)
ipcMain.handle('get-screen-state', async (event, serial) => {
  try {
    // Get UI dump
    await executeADB(['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'])
    const xml = await executeADB(['-s', serial, 'shell', 'cat', '/sdcard/window_dump.xml'])

    // Get current app
    const activityOutput = await executeADB(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities', '|', 'grep', 'mResumedActivity'])
    let currentApp = null
    const appMatch = activityOutput.match(/u0 ([a-zA-Z0-9_.]+)\//)
    if (appMatch) currentApp = appMatch[1]

    return { success: true, xml, currentApp }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// Clear Instagram app data (logout)
ipcMain.handle('clear-instagram-data', async (event, serial) => {
  try {
    console.log(`[Instagram] Clearing app data on device: ${serial}`)
    await executeADB(['-s', serial, 'shell', 'pm', 'clear', 'com.instagram.android'])
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// Force stop Instagram
ipcMain.handle('force-stop-instagram', async (event, serial) => {
  try {
    await executeADB(['-s', serial, 'shell', 'am', 'force-stop', 'com.instagram.android'])
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// ==================== PROFILE MANAGEMENT ====================

// Get list of GrapheneOS profiles from device
// Switch profile with optional airplane cycle and fast setup-wizard bypass
// ==================== SCRCPY ====================
// Scrcpy handlers are registered in system-handlers.js â€” do NOT duplicate here


// ==================== VIDEO TOOLKIT / CONTENT TOOLS ====================
// Bulk video scraping with yt-dlp and fingerprint breaking

// Get path to yt-dlp (bundled or system)
function getYtdlpPath() {
  const platform = os.platform()
  const binary = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'

  // Check if bundled in app
  const bundledPath = path.join(__dirname, 'tools', binary)
  if (fs.existsSync(bundledPath)) {
    return bundledPath
  }

  // Fallback to system PATH
  return binary
}

// Get path to FFmpeg (bundled or system)
function getFFmpegPath() {
  const platform = os.platform()
  const binary = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

  // Check if bundled in app
  const bundledPath = path.join(__dirname, 'tools', binary)
  if (fs.existsSync(bundledPath)) {
    return bundledPath
  }

  // Fallback to system PATH
  return binary
}

// Run video scraper with yt-dlp
// Open folder in file explorer
// Get app path for default output folder
// Create content folder structure for an account
// Default: Uses ShadowPhone folder in user's home directory (works on any drive)
// Or uses custom path if provided
ipcMain.handle('create-content-folders', async (event, { platform, accountName, customPath }) => {
  const fs = require('fs')
  const homedir = require('os').homedir()

  try {
    // Use custom path if provided, otherwise use home directory
    let basePath
    if (customPath) {
      // Custom path - use it directly (user is responsible for folder structure)
      basePath = customPath
      console.log('[Content] Using custom path:', basePath)
    } else {
      // Default: ~/ShadowPhone/content/{platform}/{account}
      basePath = path.join(homedir, 'ShadowPhone', 'content', platform || 'instagram', accountName)
    }

    // Include legacy videos plus reels/stories so every posting route has a folder.
    const folders = ['images', 'videos', 'reels', 'trial_reels', 'stories', 'used_images', 'used_videos', 'used_reels', 'used_trial_reels', 'used_stories']

    for (const folder of folders) {
      const folderPath = path.join(basePath, folder)
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true })
      }
    }

    console.log('[Content] Created folders at ' + basePath)
    return { success: true, path: basePath, folders }
  } catch (error) {
    console.error('[Content] Failed to create folders:', error)
    return { success: false, error: error.message }
  }
})

// Get content folder path for an account
ipcMain.handle('get-content-folder-path', async (event, { platform, accountName }) => {
  const homedir = require('os').homedir()
  return path.join(homedir, 'ShadowPhone', 'content', platform || 'instagram', accountName)
})

// extract-browser-cookies handler moved to handlers/

// ==================== LOCAL CONTENT TOOLS ====================

// Check and install dependencies (yt-dlp, ffmpeg, exiftool)
// Install missing dependencies
// Get dependency paths
// Local content download (runs yt-dlp on user's machine)
// Apply fingerprinting to videos (local ffmpeg)
// Fingerprint a single video
// Originality score — check how "authentic" a file looks as iPhone output
// Compare before vs after spoof scores
// Browse for folder (for templates, outputs, etc.)
// Create folder in specified path
// List files in folder -- restricted to safe directories
// Get default folders (Downloads, Desktop, etc.)
// ==================== PATH SAFETY VALIDATION ====================
// Prevent renderer from accessing arbitrary filesystem paths.
// Only allow operations within known safe directories.
function getSafeDirectories() {
  return [
    app.getPath('downloads'),
    app.getPath('desktop'),
    app.getPath('documents'),
    app.getPath('userData'),
    app.getPath('temp'),
    path.join(app.getPath('userData'), 'content'),
  ]
}

function isPathSafe(targetPath) {
  const resolved = path.resolve(targetPath)
  const safeDirs = getSafeDirectories()
  return safeDirs.some(dir => resolved.startsWith(path.resolve(dir)))
}

function getPythonCommand() {
  return process.platform === 'win32' ? 'python' : 'python3'
}

function getReelsMaxRunnerPath() {
  return path.join(__dirname, 'python', 'reelsmax_runner.py')
}

function parseJsonPayload(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function shouldSuppressReelsMaxLog(line) {
  const trimmed = String(line || '').trim()
  return trimmed.startsWith('frame_index:') || trimmed.startsWith('chunk:')
}

function streamProcessLines(stream, onLine) {
  let buffer = ''
  stream.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.trim()) onLine(line)
    }
  })
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer.trim())
  })
}

async function runReelsMaxCommand(args, { streamEvents = false } = {}) {
  return new Promise((resolve) => {
    const pythonCmd = getPythonCommand()
    const runnerPath = getReelsMaxRunnerPath()
    const child = spawn(pythonCmd, [runnerPath, ...args], {
      cwd: path.dirname(runnerPath),
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    streamProcessLines(child.stdout, (line) => {
      stdout += `${line}\n`
      if (!streamEvents) return

      if (line.startsWith('__REELSMAX_JSON__')) {
        const payload = parseJsonPayload(line.replace('__REELSMAX_JSON__', ''))
        if (payload && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('reelsmax-progress', payload)
        }
        return
      }

      if (shouldSuppressReelsMaxLog(line)) {
        return
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('reelsmax-log', { level: 'info', message: line })
      }
    })

    streamProcessLines(child.stderr, (line) => {
      stderr += `${line}\n`
      if (shouldSuppressReelsMaxLog(line)) {
        return
      }
      if (streamEvents && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('reelsmax-log', { level: 'error', message: line })
      }
    })

    child.on('error', (error) => {
      resolve({ success: false, error: error.message, stdout, stderr })
    })

    child.on('close', (code) => {
      const stdoutLines = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !line.startsWith('__REELSMAX_JSON__'))
      const lastJsonLine = [...stdoutLines].reverse().find(line => line.startsWith('{') || line.startsWith('['))
      const data = lastJsonLine ? parseJsonPayload(lastJsonLine) : null
      const success = code === 0
      resolve({
        success,
        code,
        data,
        error: success ? null : (data?.error || stderr.trim() || stdout.trim() || 'ReelsMax command failed'),
        stdout,
        stderr,
      })
    })
  })
}

// ==================== AI BATCH GENERATOR FILE OPS ====================

// Select folder dialog (simple wrapper returning path string)
ipcMain.handle('reelsmax:inspect', async (event, projectDir) => {
  try {
    if (!projectDir || !isPathSafe(projectDir)) {
      return { success: false, error: 'Project folder is not in an allowed local directory.' }
    }
    return await runReelsMaxCommand(['inspect', '--project-dir', projectDir])
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('reelsmax:clearOutput', async (event, projectDir) => {
  try {
    if (!projectDir || !isPathSafe(projectDir)) {
      return { success: false, error: 'Project folder is not in an allowed local directory.' }
    }
    return await runReelsMaxCommand(['clear', '--project-dir', projectDir])
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('reelsmax:run', async (event, options = {}) => {
  try {
    const { projectDir, mode = 'single', count = 1 } = options
    if (!projectDir || !isPathSafe(projectDir)) {
      return { success: false, error: 'Project folder is not in an allowed local directory.' }
    }

    return await runReelsMaxCommand(
      ['run', '--project-dir', projectDir, '--mode', mode, '--count', String(Math.max(1, Number(count) || 1))],
      { streamEvents: true },
    )
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('reelsmax:openFolder', async (event, folderPath) => {
  try {
    if (!folderPath || !isPathSafe(folderPath)) {
      return { success: false, error: 'Folder is not in an allowed local directory.' }
    }
    await shell.openPath(folderPath)
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('tiktok-trends:run', async (event, config = {}) => {
  try {
    const result = await tiktokTrendFinder.run(config, {
      onProgress: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tiktok-trends-progress', data)
        }
      },
      onLog: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tiktok-trends-log', data)
        }
      },
    })

    return { success: true, data: result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TikTok trend scan failed.'
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tiktok-trends-log', { level: 'error', message })
      mainWindow.webContents.send('tiktok-trends-progress', { type: 'error', message })
    }
    return { success: false, error: message }
  }
})

ipcMain.handle('tiktok-trends:listSnapshots', async () => {
  try {
    const snapshots = await tiktokTrendFinder.listSnapshots()
    return { success: true, data: snapshots }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('tiktok-trends:readLatestSnapshot', async () => {
  try {
    const snapshot = await tiktokTrendFinder.readLatestSnapshot()
    return { success: true, data: snapshot }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('tiktok-trends:clearSnapshots', async () => {
  try {
    const result = await tiktokTrendFinder.clearSnapshots()
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('tiktok-trends:openSnapshots', async () => {
  try {
    const folderPath = tiktokTrendFinder.getSnapshotsDir()
    fs.mkdirSync(folderPath, { recursive: true })
    await shell.openPath(folderPath)
    return { success: true, data: { folderPath } }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('instagram-trends:run', async (event, config = {}) => {
  try {
    const result = await instagramTrendFinder.run(config, {
      onProgress: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('instagram-trends-progress', data)
        }
      },
      onLog: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('instagram-trends-log', data)
        }
      },
    })

    return { success: true, data: result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Instagram trend scan failed.'
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('instagram-trends-log', { level: 'error', message })
      mainWindow.webContents.send('instagram-trends-progress', { type: 'error', message })
    }
    return { success: false, error: message }
  }
})

ipcMain.handle('instagram-trends:listSnapshots', async () => {
  try {
    const snapshots = await instagramTrendFinder.listSnapshots()
    return { success: true, data: snapshots }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('instagram-trends:readLatestSnapshot', async () => {
  try {
    const snapshot = await instagramTrendFinder.readLatestSnapshot()
    return { success: true, data: snapshot }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('instagram-trends:clearSnapshots', async () => {
  try {
    const result = await instagramTrendFinder.clearSnapshots()
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('instagram-trends:openSnapshots', async () => {
  try {
    const folderPath = instagramTrendFinder.getSnapshotsDir()
    fs.mkdirSync(folderPath, { recursive: true })
    await shell.openPath(folderPath)
    return { success: true, data: { folderPath } }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// List files in folder with extension filter -- restricted to safe directories
// Read file as base64 (for sending to API) -- restricted to safe directories
// Move file to another location -- restricted to safe directories
// Download file from URL to local path -- restricted to safe directories

// ==================== WEBSOCKET MODULE EXECUTION ====================
// Real-time module execution via WebSocket - server controls all logic,
// client just executes ADB commands and streams screen state back.

// Track active WebSocket module clients
const activeWsModules = new Map() // runId -> ModuleWebSocketClient
const pendingPromptResponders = new Map() // runId -> respond(action) function

// Check if any module execution is currently active (REST or WebSocket).
ipcMain.handle('is-module-execution-active', async () => {
  // Also gate on module-handlers' own run registries (run-module-ws/REST), invisible
  // to the maps above — mirrors pollRuntimeQueue so a live run isn't reported idle
  // (else pollAndExecute double-launches a concurrent run on the same phone).
  let mh = 0
  try { mh = require('./handlers/module-handlers').getActiveModuleCount() } catch (_) {}
  return {
    active: runningModules.size > 0 || activeWsModules.size > 0 || mh > 0
  }
})

// Abort a running WebSocket module
// Respond to a user prompt from a running WebSocket module
ipcMain.handle('respond-to-module-prompt', async (event, runId, promptId, action) => {
  const respond = pendingPromptResponders.get(runId)
  if (respond) {
    console.log(`[WS-Module] Relaying user response: runId=${runId} promptId=${promptId} action=${action}`)
    respond(action)
    pendingPromptResponders.delete(runId)
    return { success: true }
  }
  console.warn(`[WS-Module] No pending prompt for runId=${runId}`)
  return { success: false, error: 'No pending prompt for this run' }
})

// Batch create accounts
// The CSV/Gmail-based batch importer (module 'account_creation') is DISBANDED —
// smspool (account_creation_phone) is the sole default creation path now. The
// whole handler + the brain Gmail flow are kept intact for reference; flip
// CSV_GMAIL_BATCH_ENABLED to true to revive it.
const CSV_GMAIL_BATCH_ENABLED = false

ipcMain.handle('batch-create-account', async (event, config) => {
  if (!CSV_GMAIL_BATCH_ENABLED) {
    return {
      success: false,
      code: 'CSV_GMAIL_RETIRED',
      error: 'CSV / Gmail account creation is retired — use "+ Create IG Account" or Bulk Create (smspool).'
    }
  }
  const {
    accountId,
    username,
    email,
    password,
    recovery_email: recoveryEmail,
    birthday,
    phone_serial: phoneSerial,
    phone_profile_id: phoneProfileId,
    authToken: rendererAuthToken
  } = config

  console.log(`[Batch-Create] Starting account creation for ${username}`)

  // Check if we have server URL
  if (!MODULES_SERVER_URL) {
    return {
      success: false,
      error: 'Module server not configured (SHADOWPHONE_MODULES_SERVER)'
    }
  }

  // Parse birthday string "YYYY-MM-DD" into month/day/year integers
  let month = null, day = null, year = null
  if (birthday && typeof birthday === 'string') {
    const parts = birthday.split('-')
    if (parts.length === 3) {
      year = parseInt(parts[0], 10)
      month = parseInt(parts[1], 10)
      day = parseInt(parts[2], 10)
    }
  }

  // Check device connectivity if provided
  if (phoneSerial) {
    try {
      const devices = await getConnectedDevices()
      const isConnected = Array.isArray(devices) && devices.some(d => d.serial === phoneSerial && d.connected)
      if (!isConnected) {
        return {
          success: false,
          code: 'DEVICE_NOT_CONNECTED',
          error: `Device not connected: ${phoneSerial}. Reconnect the phone and try again.`
        }
      }
    } catch (deviceCheckError) {
      console.warn('[Batch-Create] Device preflight check failed:', deviceCheckError?.message || deviceCheckError)
    }
  }

  const suppliedToken = (typeof rendererAuthToken === 'string' && rendererAuthToken.trim())
    ? rendererAuthToken.trim()
    : null

  // Prefer fresh renderer token; fallback to main-process token cache
  const jwtToken = suppliedToken || await getModuleToken()
  if (!jwtToken || !currentUserSession?.userId) {
    return { success: false, error: 'Not authenticated. Please log in to create accounts.' }
  }

  const userId = currentUserSession?.userId || 'anonymous'

  const callbacks = {
    onProgress: (percent, message) => {
      // Send progress to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('batch-create-progress', {
          accountId,
          username,
          percent,
          message
        })
      }
    },
    onLog: (log) => {
      console.log(`[Batch-Create] ${log}`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('batch-create-progress', {
          accountId,
          username,
          message: log
        })
      }
    }
  }

  const runModuleWithToken = async (token) => {
    const client = new ModuleWebSocketClient(MODULES_SERVER_URL, token, 'jwt')
    const runId = `batch-${accountId}-${Date.now()}`
    activeWsModules.set(runId, client)

    try {
      const moduleConfig = {
        email,
        password,
        recovery_email: recoveryEmail,
        month,
        day,
        year,
        ig_name: username
      }

      return await client.runModule(
        'account_creation',
        phoneSerial || undefined,
        phoneProfileId || undefined,
        moduleConfig,
        userId,
        callbacks
      )
    } finally {
      activeWsModules.delete(runId)
    }
  }

  const isTokenExpiredError = (err) => {
    const message = String(err?.message || '').toLowerCase()
    const details = JSON.stringify(err?.details || '').toLowerCase()
    return (
      message.includes('token expired') ||
      message.includes('jwt authentication failed') && message.includes('expired') ||
      details.includes('token expired')
    )
  }

  try {
    let result
    try {
      result = await runModuleWithToken(jwtToken)
    } catch (firstError) {
      if (isTokenExpiredError(firstError)) {
        console.warn('[Batch-Create] Token expired during auth. Retrying with fresh token...')
        clearModuleToken()
        const refreshedToken = await getModuleToken(true)
        if (refreshedToken && refreshedToken !== jwtToken) {
          result = await runModuleWithToken(refreshedToken)
        } else {
          throw firstError
        }
      } else {
        throw firstError
      }
    }

    console.log(`[Batch-Create] Complete: ${username} success=${result.success}`)

    return {
      success: result.success,
      data: result.data,
      logs: result.logs
    }

  } catch (error) {
    console.error(`[Batch-Create] Error for ${username}:`, error.message, error.code)

    const errorMessage = String(error?.message || '')
    const lowerErrorMessage = errorMessage.toLowerCase()

    let userMessage = error.message
    if (error.code === 'CONNECTION_TIMEOUT') {
      userMessage = 'Could not connect to module server. Check your internet connection.'
    } else if (error.code === 'WS_HEARTBEAT_TIMEOUT') {
      userMessage = 'Connection to automation server became unstable. Keep internet/USB stable and try again.'
    } else if (error.code === 'EXECUTION_TIMEOUT') {
      userMessage = 'Module execution timed out. The server may be overloaded.'
    } else if (error.code === 'DEVICE_NOT_CONNECTED') {
      userMessage = errorMessage || 'Device not connected. Reconnect and retry.'
    } else if (error.code === 'WS_ERROR' || error.code === 'WS_CLOSED') {
      const wsCode = error.closeCode ? ` (WS ${error.closeCode})` : ''
      userMessage = `Lost connection to ShadowPhone automation server${wsCode}. Retry the run.`
    }

    return {
      success: false,
      error: userMessage,
      code: error.code
    }
  }
})

// Check if a module supports WebSocket execution
// Check server health and available modules
ipcMain.handle('check-server-health', async () => {
  if (!MODULES_SERVER_URL) {
    return {
      healthy: false,
      error: 'SHADOWPHONE_MODULES_SERVER not configured',
      serverUrl: null
    }
  }

  try {
    const jwtToken = await getModuleToken()
    if (!jwtToken) {
      return {
        healthy: false,
        error: 'Not authenticated. Please log in to check server health.',
        serverUrl: MODULES_SERVER_URL
      }
    }
    const response = await fetch(`${MODULES_SERVER_URL}/health`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${jwtToken}`
      },
      timeout: 5000
    })

    if (!response.ok) {
      return {
        healthy: false,
        error: `Server returned ${response.status}`,
        serverUrl: MODULES_SERVER_URL
      }
    }

    const data = await response.json()
    console.log('[Server] Health check:', data)

    return {
      healthy: true,
      serverUrl: MODULES_SERVER_URL,
      availableModules: data.available_modules || [],
      wsEnabled: data.ws_enabled || false,
      version: data.version || 'unknown'
    }
  } catch (error) {
    console.error('[Server] Health check failed:', error.message)
    return {
      healthy: false,
      error: error.message,
      serverUrl: MODULES_SERVER_URL
    }
  }
})


// ==================== NATIVE OS NOTIFICATIONS ====================
// Handled in system-handlers.js — do not register duplicate here

// Content folders now live in userData (%APPDATA%/shadowphone-desktop/Content)
// This persists across NSIS updates (install dir gets replaced, wiping content)
const CONTENT_ROOT = path.join(app.getPath('userData'), 'Content')

// 2.16.45: NOW register sidebar-content + schedule handlers, after CONTENT_ROOT exists.
try {
  require('./handlers/sidebar-content-handlers').init({
    executeADB,
    getTailscaleStatus: () => require('./lib/tailscale-status').getTailscaleStatus(),
    userDataPath: app.getPath('userData'),
    contentRoot: CONTENT_ROOT,
    getSessionToken: () => currentUserSession?.sessionToken || null,
  })
} catch (e) { console.warn('[sidebar-content] init failed (non-fatal):', e?.message || e) }

// ==================== MODELS DASHBOARD registry handlers (sp-core port) ====================
// fleet:get-registry / get-content-counts / validate-folders / scan — back the
// per-device models-dashboard.html window. Additive + non-fatal.
// These three deps are SHARED by both the model-handlers and insights-handlers
// registration try-blocks below, so they're hoisted to this scope. Previously
// they were declared const INSIDE the model-handlers try-block, which left them
// out of scope in the sibling insights try-block — evaluating its deps object
// threw ReferenceError and the entire Insights feature silently never registered.
let _resolveContext = null
let dhGetConnectedDevices = null
let invokeProfiles = null
try {
  const { registerModelHandlers } = require('./handlers/model-handlers')
  ;({ _resolveContext } = require('./handlers/sidebar-content-handlers'))
  ;({ getConnectedDevices: dhGetConnectedDevices } = require('./handlers/device-handlers'))

  // invokeProfiles(serial) -> {success, profiles:[{id,name,displayName,isCurrent,...}]}
  // (pm list users + am get-current-user + profile-nicknames.json). Verbatim from sp-core main.js.
  const _profileNicknamesPath = path.join(app.getPath('userData'), 'profile-nicknames.json')
  const _readProfileNickname = (serial, profileId) => {
    try {
      if (!fs.existsSync(_profileNicknamesPath)) return null
      const store = JSON.parse(fs.readFileSync(_profileNicknamesPath, 'utf8') || '{}')
      const v = store?.[serial]?.[String(profileId)]
      return (v && typeof v === 'string' && v.trim()) ? v.trim() : null
    } catch (_) { return null }
  }
  invokeProfiles = async (serial) => {
    try {
      const output = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'])
      const currentOutput = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'])
      const currentUserId = String(currentOutput || '').trim()
      const profiles = []
      for (const line of String(output || '').split('\n')) {
        if (!line.includes('UserInfo{')) continue
        const match = line.match(/UserInfo\{(\d+):([^:]+):/)
        if (!match) continue
        const profileId = match[1]
        const rawName = match[2].trim()
        const originalName = (rawName === 'null' && profileId === '0') ? 'Owner' : rawName
        const nickname = _readProfileNickname(serial, profileId)
        const displayName = nickname
          || (originalName && originalName.trim() && originalName !== 'null' ? originalName : `Profile ${profileId}`)
        profiles.push({ id: profileId, name: displayName, originalName, nickname, displayName, isCurrent: profileId === currentUserId })
      }
      return { success: true, profiles, currentUserId, count: profiles.length }
    } catch (error) {
      return { success: false, error: error.message, profiles: [] }
    }
  }

  registerModelHandlers(ipcMain, {
    getConnectedDevices: dhGetConnectedDevices,
    contentRoot: CONTENT_ROOT,
    resolveContext: _resolveContext,
    invokeProfiles,
    userDataPath: app.getPath('userData'),
    getMainWindow: () => mainWindow,
  })
  console.log('[model-handlers] registered (fleet:get-registry/scan/validate-folders)')
} catch (e) { console.warn('[model-handlers] register failed (non-fatal):', e?.message || e) }

try {
  const { registerInsightsHandlers } = require('./handlers/insights-handlers')
  registerInsightsHandlers(ipcMain, {
    getConnectedDevices: dhGetConnectedDevices,
    invokeProfiles,
    resolveContext: _resolveContext,
    userDataPath: app.getPath('userData'),
    getMainWindow: () => mainWindow,
    registryPath: path.join(app.getPath('userData'), 'fleet-registry.json'),
  })
  console.log('[insights-handlers] registered (insights:fetch/get/get-latest/get-all-latest/get-all-series)')
} catch (e) { console.warn('[insights-handlers] register failed (non-fatal):', e?.message || e) }

try {
  const { registerProfileEditHandlers } = require('./handlers/profile-edit-handlers')
  registerProfileEditHandlers(ipcMain, {
    dialog,
    getADBPath: () => getADBPath(),
    executeADB,
    getMainWindow: () => mainWindow,
    userDataPath: app.getPath('userData'),
    resolveContext: _resolveContext,
    getSessionToken: () => currentUserSession?.sessionToken || null,
  })
  console.log('[profile-edit-handlers] registered (dashboard:edit-bio/change-avatar)')
} catch (e) { console.warn('[profile-edit-handlers] register failed (non-fatal):', e?.message || e) }

try {
  // 2.19.4: real runners that delegate to the toolbar renderer's existing
  // Run Now path (mirror-toolbar.html owns the full step+module dispatch
  // and is the only place worth implementing it). Engine -> main process
  // -> 'schedule:fire-workflow' IPC -> renderer -> existing scheduleRunNow.
  //
  // The renderer must have the toolbar window open and active for a given
  // serial; if no window is found we log + return a clear failure so the
  // engine's cross-VA last_fired_at gate doesn't permanently mark the slot
  // fired (next tick will re-attempt with the same window check).
  const { BrowserWindow } = require('electron')
  // Tailnet serials are <ip>:<port> and the ADB port rotates per boot, so
  // compare by tailnet IP (strip the port); non-tailnet serials (USB udids)
  // compare strictly.
  const _stripPortMain = (s) => {
    const m = /^(100\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/.exec(s || '')
    return m ? m[1] : (s || '')
  }
  function _findToolbarWindowFor(serial) {
    const want = _stripPortMain(serial)
    // 1) Match a mirror-toolbar window by its URL ?serial= param, tailnet-IP
    //    aware. This is the RELIABLE match: there can be MORE THAN ONE toolbar
    //    window for the same physical phone (one per transport entry — a USB
    //    udid + a tailnet <ip>:5555), and their TITLES use the nickname (e.g.
    //    "Pixelated3 · 1A121FDF") which does NOT contain the schedule row's
    //    "<ip>:5555" serial. A title `includes` match therefore misses and the
    //    old "any toolbar window" fallback returned an ARBITRARY toolbar —
    //    often the USB-serial one, whose SERIAL then fails the renderer's
    //    serial-mismatch guard (mirror-toolbar.html), silently dropping the
    //    scheduled fire (no sb:engine-fire, phone idle). Matching the URL
    //    serial by tailnet IP picks the right toolbar so the guard passes.
    if (want) {
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          const url = w.webContents.getURL() || ''
          if (!url.includes('mirror-toolbar')) continue
          const m = /[?&]serial=([^&]+)/.exec(url)
          const wserial = m ? decodeURIComponent(m[1]) : ''
          if (_stripPortMain(wserial) === want) return w
        } catch (_) {}
      }
    }
    // 2) Legacy: title includes the serial verbatim.
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        const title = w.getTitle() || ''
        if (serial && title.includes(serial)) return w
      } catch (_) {}
    }
    // No match: deliberately DO NOT fall back to an arbitrary toolbar window.
    // On a multi-phone fleet that returned some other phone's window, whose
    // renderer serial-guard then dropped the fire (phone idle) or — worse, for
    // a USB-udid window the guard didn't strip — could execute on the WRONG
    // phone. Returning null routes the caller to its headless-toolbar recovery
    // path, which binds a fresh toolbar to the correctly-resolved serial.
    return null
  }
  // Schedule rows store phone_id as <tailnetIp>:5555, but the live adb serial
  // uses a rotating tailnet port (<tailnetIp>:44301) or a USB udid. Map the
  // row's serial to the actual connected device so a headless dispatch targets
  // the right phone.
  async function _resolveLiveSerial(rowSerial) {
    try {
      const out = await executeADB(['devices'], 5000)
      const serials = out.split(/\r?\n/).slice(1)
        // Filter OFFLINE/UNAUTHORIZED on each device's own status LINE. The old
        // `.test(out)` tested the WHOLE adb output, so a single offline phone
        // dropped EVERY serial (resolution returned null for the entire fleet).
        .filter(l => l.trim() && !/\b(?:offline|unauthorized)\b/.test(l))
        .map(l => l.split(/\s+/)[0])
        .filter(Boolean)
      // Resolve via the shared rule: tailnet rows match by IP (rotated-port
      // tolerant); exact otherwise; the single-phone fallback fires ONLY for a
      // non-tailnet row, so a tailnet row whose IP matches no live phone no
      // longer misroutes to the lone live phone on a multi-phone fleet.
      return require('./lib/device-identity').resolveFromSerialList(rowSerial, serials)
    } catch (_) { return null }
  }
  function _sendFireToWindow(win, payload, timeoutMs) {
    return new Promise((resolve) => {
      // Guard against a window that died between find/create and send — sending
      // to destroyed webContents throws. Resolve as a RETRYABLE failure so the
      // caller falls back to a fresh headless toolbar instead of the throw
      // escaping into a warn (and the slot silently not running).
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        resolve({ ok: false, error: 'window-destroyed-before-send' })
        return
      }
      const id = 'sched-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      const timer = setTimeout(() => {
        ipcMain.removeAllListeners('schedule:workflow-result:' + id)
        resolve({ ok: false, error: 'workflow-timeout' })
      }, timeoutMs)
      ipcMain.once('schedule:workflow-result:' + id, (_evt, result) => {
        clearTimeout(timer)
        resolve(result || { ok: true })
      })
      try {
        win.webContents.send('schedule:fire-workflow', { id, ...payload })
      } catch (e) {
        clearTimeout(timer)
        ipcMain.removeAllListeners('schedule:workflow-result:' + id)
        resolve({ ok: false, error: 'window-destroyed-before-send' })
      }
    })
  }
  // Spin up a HIDDEN headless toolbar so scheduled posts dispatch unattended
  // (the renderer bootstraps account/row from the payload). Two attempts.
  // H5: returns { win, liveSerial, created } so the caller can reap a window we
  // freshly created (vs one we reused from an open visible mirror), preventing
  // an offscreen BrowserWindow leak per rotated tailnet port. `created` is true
  // only when NO toolbar existed for the resolved serial before this call — in
  // which case there is no visible mirror to preserve and the window is ours to
  // close after the fire.
  async function _createHeadlessToolbarFor(payload) {
    let createHeadlessError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { createHeadlessToolbar, hasToolbar } = require('./lib/mirror-toolbar')
        const liveSerial = await _resolveLiveSerial(payload?.serial) || payload?.serial
        const isTailnet = /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(liveSerial || '')
        const preExisting = hasToolbar(liveSerial)
        const w = await createHeadlessToolbar({
          serial: liveSerial,
          transport: isTailnet ? 'tailnet' : 'usb',
          tailnetIp: isTailnet ? String(liveSerial).split(':')[0] : '',
        })
        console.warn('[schedule] dispatching via headless toolbar for', liveSerial)
        return { win: w, liveSerial, created: !preExisting }
      } catch (e) {
        createHeadlessError = e
        if (attempt === 0) {
          console.warn('[schedule] headless toolbar creation failed (attempt 1), retrying in 1s:', e?.message || e)
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
    console.warn('[schedule] headless dispatch failed (attempt 2):', createHeadlessError?.message || createHeadlessError)
    return null
  }
  async function _dispatchWorkflow(payload, timeoutMs = 15 * 60 * 1000) {
    // SCHEDULED fires NEVER reuse a visible (scrcpy-attached) mirror window.
    // If that window was launched with the USB udid, the executor's read-routing
    // is a no-op on a USB serial, so the post module's uiautomator dumps share
    // the transport scrcpy is streaming on and balloon to ~25s → "reel picker
    // did not load". A headless toolbar spawns NO scrcpy, so dump/screencap
    // reads are contention-free. Attended "Post Now" (no `scheduled` flag) keeps
    // the fast windowed-reuse path.
    //
    // A visible mirror for this phone — use it (attended only). But
    // _findToolbarWindowFor's match can return a toolbar bound to a DIFFERENT
    // transport of this phone; the renderer then rejects it with serial-mismatch
    // and the fire is silently dropped (phone idle). If that happens, recover by
    // creating a headless toolbar for the resolved live serial — which DOES
    // match — so the fire actually runs.
    const win = payload?.scheduled ? null : _findToolbarWindowFor(payload?.serial)
    if (win) {
      const r = await _sendFireToWindow(win, payload, timeoutMs)
      // Fall back to headless for failures a FRESH window would fix: a toolbar
      // bound to a different transport (serial-mismatch) or one that died before
      // the send. Anything else (real workflow result, timeout) is returned.
      const retryViaHeadless = r && (r.error === 'serial-mismatch' || r.error === 'window-destroyed-before-send')
      if (!retryViaHeadless) return r
      console.warn('[schedule] windowed dispatch failed (' + r.error + ') — falling back to headless for', payload?.serial)
    }
    const headless = await _createHeadlessToolbarFor(payload)
    if (!headless || !headless.win) {
      return { ok: false, error: 'headless-toolbar-failed' }
    }
    try {
      return await _sendFireToWindow(headless.win, payload, timeoutMs)
    } finally {
      // H5: reap a headless window WE created so it doesn't leak (one offscreen
      // BrowserWindow + ipcMain.once listener per rotated tailnet port over a
      // 24/7 fleet). Only close when `created` is true — that means no toolbar
      // existed for this serial before, so there is no visible mirror to
      // preserve. If we reused an open (visible) mirror's window, leave it.
      if (headless.created && headless.liveSerial) {
        try {
          const { closeToolbar } = require('./lib/mirror-toolbar')
          closeToolbar(headless.liveSerial, { force: true })
        } catch (e) {
          console.warn('[schedule] headless toolbar reap failed for', headless.liveSerial, e?.message || e)
        }
      }
    }
  }

  // Dashboard "Post Now" → fire ONE workflow via the same headless-toolbar
  // dispatch the schedule engine uses. The renderer already called
  // schedule:run-now to resolve {slot,row}; we forward them straight to
  // _dispatchWorkflow so a mirror window is NOT required.
  ipcMain.handle('dashboard:post-now', async (_evt, { serial, userId, account, slot, row }) => {
    // Per-phone busy lock (F5). The engine's runNow() documents bypassing this
    // lock for operator intent — but that consent covers the cross-VA claim, not
    // two airplane-wrapped user-switches physically interleaving on ONE phone the
    // operator can't see is mid-run. So: reject with a clear reason when the
    // phone is actively busy, and HOLD the lock for the manual run so the
    // engine's tick skips this phone meanwhile. Same add/timestamp/delete
    // protocol as the engine; its >30min stale auto-unlock covers a hung manual
    // run too. Engine-initiated dispatches don't pass here — no double-locking.
    // Keyed on canonicalPhoneKey (matching the engine's _tick lock) so a tailnet
    // ip:port manual run and a USB-keyed scheduled fire on the same physical phone
    // mutually exclude.
    const _se = require('./lib/schedule-engine')
    // Bug 5: register hwSerial before checking the lock so canonicalPhoneKey
    // collapses both USB and tailnet transports to the same stable key.
    // Without this, an unscanned phone's tailnet serial and USB serial produce
    // different keys and can bypass the mutual-exclusion check.
    try {
      const _pnS = serial ? ['-s', serial] : []
      const _pnHw = (await executeADB([..._pnS, 'shell', 'getprop', 'ro.serialno'], 5000) || '').trim()
      if (_pnHw && _pnHw.toLowerCase() !== 'null') _se.registerHwSerial(serial, _pnHw)
    } catch (_pnErr) { /* non-fatal — falls back to raw serial as key */ }
    const lockKey = _se.canonicalPhoneKey(serial)
    if (_se._busyPhones && _se._busyPhones.has(lockKey)) {
      return { ok: false, error: 'phone busy — scheduled run in progress; retry when it finishes' }
    }
    _se._busyPhones.add(lockKey)
    _se._busyPhoneTimestamps.set(lockKey, Date.now())
    try {
      const postModule = ({
        reel: 'post_reel', trial_reel: 'post_trial_reel',
        image: 'post_feed', story: 'post_story',
      })[(slot && slot.content_type) || 'reel'] || 'post_reel'
      return await _dispatchWorkflow({ serial, userId, account, slot, postModule, row: row || null })
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    } finally {
      _se._busyPhones.delete(lockKey)
      _se._busyPhoneTimestamps.delete(lockKey)
    }
  })

  require('./handlers/schedule-handlers').init({
    userDataPath: app.getPath('userData'),
    getSessionToken: () => currentUserSession?.sessionToken || null,
    getSessionInfo: () => ({ userId: currentUserSession?.userId, email: currentUserSession?.email }),
    getDevices: getConnectedDevices,
    runWorkflowStep: async (stepId, ctx) => {
      // Each step still goes through the renderer's full workflow run so
      // ordering/ctx stay consistent. We don't dispatch one-step-at-a-time
      // because the renderer's scheduleRunNow is workflow-level, not
      // step-level. The engine's per-step calls become no-ops; the actual
      // execution happens once per workflow via runWorkflowModule below
      // when the post action fires (the last "module" the engine runs is
      // the entry point that triggers a single renderer workflow run).
      // This means individual step disabling is honored INSIDE the
      // renderer's workflow code which already reads disabled_steps.
      return { ok: true, deferred: true }
    },
    runWorkflowModule: async (moduleId, ctx, extra) => {
      // The engine calls runWorkflowModule once per pre/post/post-post item.
      // To avoid N renderer dispatches per workflow, we ONLY fire when the
      // moduleId is one of the post action modules (post_reel / post_story /
      // post_trial_reel / post_feed) — at that point we kick a single
      // renderer-side workflow run that handles all enabled toggles in order.
      const POST_MODULES = new Set(['post_reel', 'post_story', 'post_trial_reel', 'post_feed'])
      if (!POST_MODULES.has(moduleId)) {
        return { ok: true, deferred: true }
      }
      const slot = extra?.slot || ctx?.slot
      const serial = ctx?.serial || ctx?.device_serial || ctx?.phone_id
      const userId = ctx?.profile_user_id || ctx?.userId
      const account = ctx?.account_username || ctx?.accountId
      // H7: forward the schedule `row` (rides on ctx from resolveWorkflowCtx) and
      // `slotIndex` (from the engine's extra). Without `row`, the headless
      // toolbar's bootstrap never sets scheduleRow and _runWorkflowInner aborts
      // at `if (!scheduleRow)` → sb:run-now-blocked(no-schedule) → the scheduled
      // / fire-now post silently runs nothing. The renderer destructures both
      // from the fire payload (mirror-toolbar.html: row→scheduleRow, slotIndex→
      // runWorkflow(slotIndex)).
      const row = ctx?.row || null
      const slotIndex = (extra && Number.isInteger(extra.slotIndex)) ? extra.slotIndex : undefined
      return await _dispatchWorkflow({
        serial, userId, account,
        slot, postModule: moduleId,
        row, slotIndex,
        scheduled: true,
      })
    },
    resolveWorkflowCtx: async (accountId, row) => {
      // Engine passes the row in directly so we don't need a Supabase lookup.
      if (!row) return { accountId, account_username: accountId }
      return {
        accountId,
        account_username: row.account_id || accountId,
        serial: row.phone_id,
        phone_id: row.phone_id,
        profile_user_id: row.profile_user_id,
        userId: row.profile_user_id,
        // H7: carry the raw schedule row so runWorkflowModule can forward it to
        // the headless toolbar (the toolbar's no-schedule guard needs it).
        row,
      }
    },
  })
} catch (e) { console.warn('[schedule] init failed (non-fatal):', e?.message || e) }

try {
  const { registerScheduleExceptionsHandlers } = require('./handlers/schedule-exceptions-handler')
  registerScheduleExceptionsHandlers(ipcMain)
} catch (e) { console.warn('[schedule-exceptions] register failed (non-fatal):', e?.message || e) }

try {
  const { registerBulkCreationHandlers } = require('./handlers/bulk-creation-handlers')
  const _bulkModuleHandlers = require('./handlers/module-handlers')
  const _bulkProfileHandlers = require('./handlers/profile-handlers')
  const _bulkModelHandlers = require('./handlers/model-handlers')
  const _bulkScheduleEngine = require('./lib/schedule-engine')
  const _bulkSidebarContent = require('./handlers/sidebar-content-handlers')
  const {
    fetchBalance: _fetchSmspoolBalance,
    fetchBalanceOnce: _fetchSmspoolBalanceOnce,
    getOrderStatus: _getSmspoolOrderStatus,
  } = require('./lib/smspool-balance')
  const _readSmspoolKey = ({ optional = false } = {}) => {
    const tenantId = String(currentUserSession?.userId || '').trim()
    const key = tenantId && currentUserSession?.sessionToken
      ? _appSettingsStore.getSecret('smspool_api_key', tenantId).trim() : ''
    if (!key && !optional) {
      throw new Error('No SMSPool API key — set it in Fleet → Settings (get one at smspool.net → Dashboard → API).')
    }
    return key
  }
  const _bulkScaffoldAccount = (serial, userId, accountName, password, credentialReservationId) =>
    _bulkSidebarContent.createAccountHandler(null, {
      serial,
      userId: String(userId),
      platform: 'instagram',
      accountName,
      password,
      credentialReservationId,
      persistCredentials: true,
      openFolder: false,
    })
  _bulkScaffoldAccount.supportsCredentialPersistence = true
  _bulkScaffoldAccount.preflightCredentialPersistence = (serial, userId, password) =>
    _bulkSidebarContent._preflightInstagramCredentialPersistence({
      serial,
      userId: String(userId),
      password,
    })
  _bulkScaffoldAccount.releaseCredentialReservation = (credentialReservationId) =>
    _bulkSidebarContent._releaseInstagramCredentialReservation(credentialReservationId)

  const { registerAccountCreationHandlers } = require('./handlers/account-creation-handlers')
  const _accountCreationDeps = {
    minimumBalance: 0.42,
    getCurrentUserSession: () => currentUserSession,
    resolveHardwareId: async (serial, sessionSnapshot) => {
      const sameTenant = () => sessionSnapshot?.tenantId === String(currentUserSession?.userId || '') && Boolean(currentUserSession?.sessionToken)
      if (!sameTenant()) throw new Error('Sign-in changed before phone identification')
      const hardwareId = String(await executeADB(['-s', serial, 'shell', 'getprop', 'ro.serialno'], 5_000) || '').trim()
      if (!sameTenant() || !/^[A-Za-z0-9._-]+$/.test(hardwareId) || /^(null|unknown|undefined)$/i.test(hardwareId)) {
        throw new Error('The phone hardware identity could not be verified')
      }
      _bulkScheduleEngine.registerHwSerial(serial, hardwareId)
      return hardwareId
    },
    getSmsProvider: (provider, tenantId, storedCredentials) => {
      if (tenantId !== String(currentUserSession?.userId || '') || !currentUserSession?.sessionToken) {
        throw new Error('Sign in before using SMS provider credentials')
      }
      const credentials = storedCredentials || {
        apiKey: _appSettingsStore.getSecret(provider === 'textverified' ? 'textverified_api_key' : 'smspool_api_key', tenantId),
        ...(provider === 'textverified' ? { apiUsername: _appSettingsStore.getSecret('textverified_api_username', tenantId) } : {}),
      }
      return require('./lib/sms-provider').createSmsProvider({ provider, credentials })
    },
    isTrustedIpcSender: (event, input) => {
      const senderId = Number(event?.sender?.id)
      if (!Number.isInteger(senderId)) return false
      const trustedIds = []
      if (mainWindow && !mainWindow.isDestroyed()) trustedIds.push(mainWindow.webContents.id)
      trustedIds.push(...require('./lib/mirror-toolbar').getToolbarWebContentsIds())
      trustedIds.push(...require('./lib/fleet-dashboard-window').getDashboardWebContentsIds())
      return trustedIds.includes(senderId)
    },
    isPhoneProfileAuthorized: async (serial, userId, sessionSnapshot) => {
      if (
        !sessionSnapshot?.tenantId
        || sessionSnapshot.tenantId !== String(currentUserSession?.userId || '')
        || !currentUserSession?.sessionToken
      ) return false
      let state, users
      try {
        [state, users] = await Promise.all([
          executeADB(['-s', serial, 'get-state'], 5_000),
          executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'], 5_000),
        ])
        if (String(state || '').trim() !== 'device' || !/UserInfo\{\d+:/.test(String(users || ''))) {
          throw new Error('Phone discovery is unavailable')
        }
      } catch (_) {
        throw Object.assign(new Error('The phone connection could not be verified.'), { code: 'PHONE_CONNECTION_UNAVAILABLE' })
      }
      if (sessionSnapshot.tenantId !== String(currentUserSession?.userId || '') || !currentUserSession?.sessionToken) return false
      return new RegExp(`UserInfo\\{${Number(userId)}:`).test(String(users || ''))
    },
    sealState: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable')
      return safeStorage.encryptString(String(value))
    },
    openState: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable')
      return safeStorage.decryptString(value)
    },
    getSmspoolKey: _readSmspoolKey,
    fetchBalance: _fetchSmspoolBalance,
    // Badge-only single-shot read. fetchBalance already retries 3x internally;
    // the badge must not stack another retry loop on top of it.
    fetchBalanceOnce: (apiKey) => _fetchSmspoolBalanceOnce(apiKey, 4000),
    getSmspoolOrderStatus: _getSmspoolOrderStatus,
    getCurrentUserId: async (serial) => {
      // The active Android user is a stable fact mid-create — a null here is a
      // transient adb hiccup, not a real "unknown profile". A false null aborts
      // the create with "active profile unknown", so retry before giving up.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const output = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 10_000)
          const match = String(output || '').match(/\d+/)
          if (match) return Number(match[0])
        } catch (_) { /* transient — retry below */ }
        if (attempt < 2) await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
      }
      return null
    },
    getBrainStatus: async () => {
      const snapshot = require('./lib/local-brain').getBrainHealthSnapshot()
      return { running: snapshot.ready === true, ...snapshot }
    },
    isInstagramReady: async (serial, userId) => {
      // IG being installed is a STABLE fact — a false here is almost always a
      // transient adb hiccup, not IG actually missing. Retry a few times so a
      // momentary blip can't wrongly report "Instagram is not ready" and abort
      // an account creation. executeADB already retries hard transient errors;
      // this also covers a rare empty-but-successful read under contention.
      const re = /(?:^|\s)package:com\.instagram\.android(?:\s|$)/
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const output = await executeADB([
            '-s', serial, 'shell', 'pm', 'list', 'packages', '--user', String(userId), 'com.instagram.android',
          ], 10_000)
          if (re.test(String(output || ''))) return true
        } catch (_) { /* transient — retry below */ }
        if (attempt < 2) await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
      }
      return false
    },
    isPhoneBusy: (serial) => _bulkScheduleEngine._busyPhones.has(
      _bulkScheduleEngine.canonicalPhoneKey(serial),
    ),
    // Lets the capacity probe tell "the shared ADB guard is refusing commands"
    // apart from "Instagram said no" and wait the cooldown out instead of
    // reporting a healthy phone as unverified.
    getAdbProcessStats,
    acquirePhoneLock: (serial) => _bulkScheduleEngine.acquirePhoneLock(serial),
    runModuleWs: (config, phoneLockOwnerToken, internalHooks) =>
      _bulkModuleHandlers.runModuleWsWithExistingPhoneLock(config, phoneLockOwnerToken, internalHooks),
    detectInstagramAccounts: async (serial, userId) => {
      const result = await require('./lib/models-dashboard-scan')._runModuleLocal(
        'detect_accounts', serial, String(userId), {},
      )
      if (!result?.success || !Array.isArray(result?.data?.accounts)) {
        throw Object.assign(new Error(result?.error || 'Instagram accounts could not be verified on the phone.'), {
          code: result?.code,
          data: result?.data,
        })
      }
      return result.data.accounts
    },
    scaffold: _bulkScaffoldAccount,
    returnInstagramHome: async (serial) => {
      const currentUser = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 10_000)
      const userId = String(currentUser || '').match(/\d+/)?.[0]
      if (!userId) throw new Error('Could not verify the active Android profile after account creation.')
      const result = await require('./lib/models-dashboard-scan')._runModuleLocal(
        'ig_launcher', serial, userId, { force_relaunch: true },
      )
      if (!result?.success) throw new Error(result?.error || 'Instagram did not return to a ready state.')
    },
  }
  const _accountCreationService = registerAccountCreationHandlers(ipcMain, _accountCreationDeps)
  console.log('[account-creation-handlers] registered (account-creation:preflight/status/reconcile/start)')
  registerBulkCreationHandlers(ipcMain, {
    userDataPath: app.getPath('userData'),
    accountCreationService: _accountCreationService,
    resolveHardwareId: _accountCreationDeps.resolveHardwareId,
    getCurrentUserSession: _accountCreationDeps.getCurrentUserSession,
    isTrustedIpcSender: _accountCreationDeps.isTrustedIpcSender,
    isPhoneProfileAuthorized: _accountCreationDeps.isPhoneProfileAuthorized,
    getRegistry: () => _bulkModelHandlers._getRegistry(),
    switchProfile: (args, phoneLockOwnerToken) =>
      _bulkProfileHandlers.switchProfile({ ...args, phoneLockOwnerToken }),
    acquirePhoneLock: (serial) => _bulkScheduleEngine.acquirePhoneLock(serial),
  })
  console.log('[bulk-creation-handlers] registered (bulk:preview/start/stop/status)')
} catch (e) { console.warn('[bulk-creation-handlers] register failed (non-fatal):', e?.message || e) }


// One-time migration: move content from old install-dir location to userData
const OLD_CONTENT_ROOT = path.join(path.dirname(app.getPath('exe')), 'Content')
function migrateContentFromInstallDir() {
  try {
    if (!fs.existsSync(OLD_CONTENT_ROOT)) return
    // Only migrate if old location has actual content and new location is empty/missing
    const oldEntries = fs.readdirSync(OLD_CONTENT_ROOT)
    if (oldEntries.length === 0) return

    if (!fs.existsSync(CONTENT_ROOT)) {
      fs.mkdirSync(CONTENT_ROOT, { recursive: true })
    }

    // Recursively copy files from old to new (don't overwrite existing)
    const copyRecursive = (src, dest) => {
      const stat = fs.statSync(src)
      if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
        for (const entry of fs.readdirSync(src)) {
          copyRecursive(path.join(src, entry), path.join(dest, entry))
        }
      } else {
        // Only copy if file doesn't exist in new location
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest)
        }
      }
    }

    for (const entry of oldEntries) {
      copyRecursive(path.join(OLD_CONTENT_ROOT, entry), path.join(CONTENT_ROOT, entry))
    }
    console.log(`[Content] Migrated content from install dir to userData: ${CONTENT_ROOT}`)
  } catch (err) {
    console.error('[Content] Migration failed (non-fatal):', err.message)
  }
}

const SUPPORTED_PLATFORMS = ['Instagram', 'TikTok', 'Twitter', 'Threads', 'reddit']
const DEFAULTS_FOLDER = '_defaults'
const DEFAULT_FILES = {
  'comments.txt': `# DEFAULT COMMENTS - Neutral, smart, general engagement
# These will be randomly selected for commenting on posts
# NOTE: No emojis - they break ADB input text command

love this
this is so good
amazing content
great post
such a vibe
this is fire
so cool
need more of this
incredible
this made my day
obsessed
absolutely love it
wow just wow
this is everything
so good
perfection
cant stop watching
literally perfect
this is art
so aesthetic
goals
living for this
straight fire
too good
insane content
best thing ever
how is this so good
unreal
you never miss
always delivering
`,
  'captions.txt': `# UNIVERSAL POST CAPTIONS
# Works for ANY image - selfies, photos, lifestyle
# 100% context-free

felt cute might delete later
no caption needed tbh
vibes only
just me being me
selfie era
just vibing tbh
no thoughts just vibes
living in the moment
someone appreciate me pls
hey hi hello
current mood: unbothered
feeling myself
main character energy only
giving what it's supposed to give
this one's for you
the energy rn
come say hi
you're welcome
manifesting good things
can't explain the vibe but you feel it
caption this for me
lowkey obsessed with myself rn
not me being cute again
respectfully iconic
soft moment
Hi hi :)
5 stars?
Ummm ok
Not you
Say yes
Tap outtt
who did??
yes you can
IYKYK
made you look
look closer :)
Maybe a couple
dont be scared
Do you relate?
Goes both ways
be overly happy
can you keep up?
Be honest with me
do you want one?
Hi say it back
hehe my life so crazy
confess your love
try it out sometime
Lets fail together
Youre still cute tho
its that easy for me
I truly am no better
Till I cant no more
this your type?
rate me 1-10
would you swipe right?
bored who wants to chat
guess what Im thinking about
this seat taken?
what are you waiting for
this or that? you pick
thinking about you rnn
catch me if you can
tell me something I dont know
the view from here is nice
dreaming about better days
`,
  'story_captions.txt': `# DEFAULT STORY CAPTIONS - Natural girl vibes, works for all content
# Mix of link CTAs, casual vibes, and engagement hooks
# One caption per line - randomly selected for story posts - TIME AGNOSTIC

LINK IN BIO
chat with me
You know where to find me
link in bio
tap the link babe
wanna talk? link in bio
Come say hi
DM me Im bored lol
click the link if you dare
here if you need me
I respond to everyone there
link in bio if you wanna chat
say hiiii
find me in my bio
slide into my links
check bio for where I really am
Im waiting for you
come find me
link is up
bio has what youre looking for
lets talk there instead
you know what to do
the link is calling you
active rn come chat
my page is free rn btw
catch me in the bio
where my real ones at? bio
hmu you know where
free content waiting for you
click if youre curious
not gonna beg but bio
this could be in your DMs js
respond to everyone fr
where we really connect
something special in bio
I actually check my messages there
you coming or what?
`
}

/**
 * Ensure base content directory structure exists
 * Creates platform folders and _defaults on first launch
 */
function ensureContentFolders() {
  try {
    // Create Content root
    if (!fs.existsSync(CONTENT_ROOT)) {
      fs.mkdirSync(CONTENT_ROOT, { recursive: true })
      console.log('[Content] Created Content folder:', CONTENT_ROOT)
    }

    // Create platform folders
    SUPPORTED_PLATFORMS.forEach(platform => {
      const platformPath = path.join(CONTENT_ROOT, platform)
      if (!fs.existsSync(platformPath)) {
        fs.mkdirSync(platformPath, { recursive: true })
        console.log(`[Content] Created platform folder: ${platform}`)
      }
    })

    // Create _defaults folder with template files
    const defaultsPath = path.join(CONTENT_ROOT, DEFAULTS_FOLDER)
    if (!fs.existsSync(defaultsPath)) {
      fs.mkdirSync(defaultsPath, { recursive: true })
      console.log('[Content] Created _defaults folder')

      // Create default template files
      Object.entries(DEFAULT_FILES).forEach(([filename, content]) => {
        const filePath = path.join(defaultsPath, filename)
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, content, 'utf8')
          console.log(`[Content] Created default template: ${filename}`)
        }
      })
    }

    return { success: true, path: CONTENT_ROOT }
  } catch (error) {
    console.error('[Content] Failed to create folders:', error)
    return { success: false, error: error.message }
  }
}

function normalizeContentPlatform(platform) {
  return String(platform || 'instagram').trim().toLowerCase() || 'instagram'
}

function normalizeContentAccountKey(accountUsername) {
  const key = String(accountUsername || '').replace(/^@+/, '').trim().toLowerCase()
  // Reject anything outside a safe charset so '/', '\\', and '..' can never
  // survive into a filesystem path. Empty return fails safe via the existing
  // `if (!accountKey)` guards in every handler.
  return /^[a-z0-9._-]+$/.test(key) ? key : ''
}

// Allow-list of subfolder names a renderer may target. Mirrors the union of
// every platform's subfolder set in createAccountFolders below. Any subfolder
// not in this set is rejected so an injected value (e.g. '..') can't escape.
const CONTENT_SUBFOLDERS = new Set([
  'images', 'videos', 'reels', 'trial_reels', 'stories',
  'used_images', 'used_videos', 'used_reels', 'used_trial_reels', 'used_stories',
  'captions', 'comments', 'story_captions',
])

// Belt-and-suspenders: assert a built path stays inside CONTENT_ROOT after
// resolution. Same pattern already used by content:moveToUsed.
function isInsideContentRoot(targetPath) {
  const resolved = path.resolve(targetPath)
  const resolvedRoot = path.resolve(CONTENT_ROOT)
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)
}

/**
 * Create account content folders for a specific account
 * Also copies default templates into text content folders
 * Folder structure is platform-specific (Reddit doesn't have stories/reels)
 */
function createAccountFolders(platform, accountUsername) {
  const platformLower = normalizeContentPlatform(platform)
  const accountKey = normalizeContentAccountKey(accountUsername)
  if (!accountKey) {
    return { success: false, error: 'Account username is required' }
  }

  // Platform-specific subfolder structures
  const platformSubfolders = {
    instagram: ['images', 'videos', 'reels', 'trial_reels', 'stories', 'used_images', 'used_videos', 'used_reels', 'used_trial_reels', 'used_stories', 'comments', 'captions', 'story_captions'],
    threads: ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
    tiktok: ['videos', 'used_videos', 'captions', 'comments'],
    twitter: ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
    // Reddit supports both images and videos (optional), plus text pools.
    // Adding new subfolders is backward-compatible for existing installs.
    reddit: ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
  }

  // Platform-specific default template mappings
  const platformTemplates = {
    instagram: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
      'story_captions': 'story_captions.txt',
    },
    threads: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
    },
    tiktok: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
    },
    twitter: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
    },
    reddit: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
    },
  }

  const subfolders = platformSubfolders[platformLower] || platformSubfolders.instagram
  const textFolderMap = platformTemplates[platformLower] || platformTemplates.instagram
  const accountPath = path.join(CONTENT_ROOT, platformLower, accountKey)
  const defaultsPath = path.join(CONTENT_ROOT, DEFAULTS_FOLDER)

  try {
    // Create all subfolders
    subfolders.forEach(subfolder => {
      const folderPath = path.join(accountPath, subfolder)
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true })
      }
    })

    // Copy default templates into text content folders
    Object.entries(textFolderMap).forEach(([folder, defaultFile]) => {
      const defaultFilePath = path.join(defaultsPath, defaultFile)
      const targetFilePath = path.join(accountPath, folder, defaultFile)

      // Only copy if default exists and target doesn't
      if (fs.existsSync(defaultFilePath) && !fs.existsSync(targetFilePath)) {
        const content = fs.readFileSync(defaultFilePath, 'utf8')
        fs.writeFileSync(targetFilePath, content, 'utf8')
        console.log(`[Content] Copied default ${defaultFile} to ${folder}/`)
      }
    })

    console.log(`[Content] Created account folders: ${platformLower}/${accountUsername}`)
    return { success: true, path: accountPath }
  } catch (error) {
    console.error('[Content] Failed to create account folders:', error)
    return { success: false, error: error.message }
  }
}

// IPC: Get content root path
ipcMain.handle('content:getRoot', async () => {
  return CONTENT_ROOT
})

// IPC: Open the Brain logs folder. Used by the "Send Logs" / diagnostic
// UI so users can grab account_creation.log and share when a run fails.
// Returns the resolved path even if the open fails (caller may want to
// surface the path as a copy-paste fallback).
ipcMain.handle('logs:openFolder', async () => {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
    try { await shell.openPath(dir) } catch (_) {}
    return { success: true, path: dir }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

// IPC: Read the latest N lines from a named log file in the Brain logs
// folder. Lets the renderer display recent diagnostics inline without
// requiring the user to open the folder. `name` is whitelisted to keep
// arbitrary path reads off the API.
ipcMain.handle('logs:tail', async (event, name, maxLines = 200) => {
  try {
    const allowed = new Set([
      'account_creation.log',
      'edit_profile.log',
      'post_trial_reel.log',
      'engagement.log',
      'launcher.log', // 2.17.21: sidebar live-logs prepopulates from here
    ])
    if (!allowed.has(String(name || ''))) {
      return { success: false, error: 'unknown log file' }
    }
    const dir = path.join(app.getPath('userData'), 'logs')
    const filePath = path.join(dir, name)
    if (!fs.existsSync(filePath)) {
      return { success: true, path: filePath, lines: [] }
    }
    const text = await fs.promises.readFile(filePath, 'utf8')
    const lines = text.split(/\r?\n/).filter(Boolean)
    const tail = lines.slice(-Math.max(1, Math.min(2000, Number(maxLines) || 200)))
    return { success: true, path: filePath, lines: tail }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

// 2.18.10: read ENTIRE log file (not tail). Used by sidebar's Copy Diag
// pill so VAs can dump the whole launcher.log to clipboard + DM it when
// something fails. launcher.log is auto-rotated at 5MB so worst case is
// 5MB of text — fine for clipboard. Anyro: "we need entire logs they can
// copy and dm me so we can debug whatever happened".
ipcMain.handle('logs:read-full', async (event, name) => {
  try {
    const allowed = new Set(['launcher.log', 'account_creation.log', 'edit_profile.log', 'post_trial_reel.log', 'engagement.log'])
    if (!allowed.has(String(name || ''))) {
      return { success: false, error: 'unknown log file' }
    }
    const dir = path.join(app.getPath('userData'), 'logs')
    const filePath = path.join(dir, name)
    if (!fs.existsSync(filePath)) {
      return { success: true, path: filePath, content: '', bytes: 0 }
    }
    const content = await fs.promises.readFile(filePath, 'utf8')
    return { success: true, path: filePath, content, bytes: content.length }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

function _appSettingsPath() {
  return path.join(app.getPath('userData'), 'app-settings.json')
}
const { createAppSettingsStore } = require('./lib/app-settings-store')
const _appSettingsStore = createAppSettingsStore({
  settingsPath: _appSettingsPath(),
  safeStorage,
})
// 3.2: scrcpy_quality — optional fleet-wide mirroring-quality preset. Nothing
// reads it yet (the live path is the per-serial toolbar chip + scrcpy:set-quality
// IPC); whitelisting it here just lets a future Settings dropdown persist a global
// default through the existing app:get/set-setting IPC without any new IPC/schema.
const SECRET_PROVIDER_SETTINGS = new Set(['smspool_api_key', 'textverified_api_key', 'textverified_api_username'])

function _providerSettingsTenant(event) {
  const tenantId = String(currentUserSession?.userId || '').trim()
  if (!tenantId || !currentUserSession?.sessionToken) return null
  const trustedIds = []
  if (mainWindow && !mainWindow.isDestroyed()) trustedIds.push(mainWindow.webContents.id)
  trustedIds.push(...require('./lib/mirror-toolbar').getToolbarWebContentsIds())
  trustedIds.push(...require('./lib/fleet-dashboard-window').getDashboardWebContentsIds())
  const fleetWindow = require('./lib/fleet-panel').getFleetPanelWindow()
  if (fleetWindow && !fleetWindow.isDestroyed()) trustedIds.push(fleetWindow.webContents.id)
  return trustedIds.includes(Number(event?.sender?.id)) ? tenantId : null
}

const ALLOWED_APP_SETTINGS = new Set([
  ...SECRET_PROVIDER_SETTINGS,
  'usb_vps_bridge',
  'usb_vps_allowed_ips',
  'usb_vps_allowed_node_ids',
  'usb_vps_required_tags',
  'scrcpy_quality',
  'react_dashboard',
])
const USB_VPS_IDENTITY_SETTINGS = new Set(['usb_vps_allowed_node_ids', 'usb_vps_required_tags'])
const USB_VPS_RESTART_SETTINGS = new Set(['usb_vps_allowed_ips', 'usb_vps_allowed_node_ids', 'usb_vps_required_tags'])
ipcMain.handle('app:get-setting', (_evt, key) => {
  const settingKey = String(key)
  if (!ALLOWED_APP_SETTINGS.has(settingKey)) return null
  if (SECRET_PROVIDER_SETTINGS.has(settingKey)) {
    const tenantId = _providerSettingsTenant(_evt)
    return tenantId ? _appSettingsStore.getRendererSetting(settingKey, tenantId) : { configured: false }
  }
  return _appSettingsStore.getPublicSetting(settingKey) ?? ''
})
ipcMain.handle('app:set-setting', async (_evt, key, value) => {
  const settingKey = String(key)
  if (!ALLOWED_APP_SETTINGS.has(settingKey)) return { success: false, error: 'unknown setting key' }
  try {
    if (SECRET_PROVIDER_SETTINGS.has(settingKey)) {
      const tenantId = _providerSettingsTenant(_evt)
      if (!tenantId) return { success: false, error: 'Sign in before saving your SMS provider credentials.' }
      const secret = String(value == null ? '' : value).trim()
      if (secret) {
        _appSettingsStore.setSecret(settingKey, secret, tenantId)
      } else {
        _appSettingsStore.clearSecret(settingKey, tenantId)
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win || win.isDestroyed()) continue
        try {
          win.webContents.send('app-setting-changed', {
            setting: 'sms_pool',
            configured: Boolean(secret),
          })
        } catch (_) {}
      }
      return { success: true }
    }

    if (settingKey === 'usb_vps_allowed_ips') {
      const bridge = require('./lib/usb-vps-bridge')
      const entries = String(value == null ? '' : value).split(/[\s,]+/).map(ip => ip.trim()).filter(Boolean)
      if (entries.some(ip => !bridge.normalizeRemoteIp(ip))) {
        return { success: false, error: 'Allowlist must contain only Tailnet IP addresses' }
      }
      _appSettingsStore.setPublicSetting(settingKey, bridge.normalizeAllowedRemoteIps(entries).join('\n'))
    } else if (USB_VPS_IDENTITY_SETTINGS.has(settingKey)) {
      const bridge = require('./lib/usb-vps-bridge')
      const candidate = {
        usb_vps_allowed_node_ids: _appSettingsStore.getPublicSetting('usb_vps_allowed_node_ids') || '',
        usb_vps_required_tags: _appSettingsStore.getPublicSetting('usb_vps_required_tags') || '',
        [settingKey]: String(value == null ? '' : value),
      }
      const policy = bridge.normalizeIdentityPolicy({
        allowedNodeIds: candidate.usb_vps_allowed_node_ids,
        requiredTags: candidate.usb_vps_required_tags,
      })
      if (!policy.valid) {
        return { success: false, error: 'Identity policy must contain stable node IDs and tags prefixed with tag:' }
      }
      _appSettingsStore.setPublicSetting('usb_vps_allowed_node_ids', policy.allowedNodeIds.join('\n'))
      _appSettingsStore.setPublicSetting('usb_vps_required_tags', policy.requiredTags.join('\n'))
    } else {
      const publicValue = settingKey === 'react_dashboard'
        ? value === true || value === 'true'
        : String(value == null ? '' : value)
      _appSettingsStore.setPublicSetting(settingKey, publicValue)
    }

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue
      try {
        win.webContents.send('app-setting-changed', {
          setting: settingKey,
        })
      } catch (_) {}
    }
    // Start/stop the USB-to-VPS relay the moment the operator toggles it.
    if (settingKey === 'usb_vps_bridge') {
      if (value === true || value === 'true' || value === 'on') await startUsbVpsBridge()
      else stopUsbVpsBridge()
    }
    if (USB_VPS_RESTART_SETTINGS.has(settingKey) && _usbVpsBridgeEnabled()) {
      stopUsbVpsBridge()
      await startUsbVpsBridge()
    }
    return { success: true }
  } catch (error) {
    console.error('[app-settings] update failed:', error?.message || error)
    return { success: false, error: error?.message || 'Could not update setting' }
  }
})

// USB-to-VPS bridge lifecycle. Opt-in via Settings (usb_vps_bridge). Relays each
// USB-attached phone onto the PC's Tailscale IP so a remote VPS can `adb connect`
// it WITHOUT Tailscale on the phone — USB as a first-class alternative to a
// tailnet phone. See lib/usb-vps-bridge.js.
function _usbVpsBridgeEnabled() {
  const v = _appSettingsStore.getPublicSetting('usb_vps_bridge')
  return v === true || v === 'true' || v === 'on'
}
function _usbVpsAllowedIps() {
  const raw = _appSettingsStore.getPublicSetting('usb_vps_allowed_ips') || ''
  return require('./lib/usb-vps-bridge').normalizeAllowedRemoteIps(String(raw).split(/[\s,]+/))
}
function _usbVpsIdentityPolicy() {
  const values = key => String(_appSettingsStore.getPublicSetting(key) || '').split(/[\s,]+/).map(value => value.trim()).filter(Boolean)
  return {
    allowedNodeIds: values('usb_vps_allowed_node_ids'),
    requiredTags: values('usb_vps_required_tags'),
  }
}
async function startUsbVpsBridge() {
  try {
    const bridge = require('./lib/usb-vps-bridge')
    const identityPolicy = _usbVpsIdentityPolicy()
    return await bridge.start({
      getAdbPath: () => getADBPath(),
      allowedRemoteIps: _usbVpsAllowedIps(),
      allowedNodeIds: identityPolicy.allowedNodeIds,
      requiredTags: identityPolicy.requiredTags,
      upstreamAdbPort: bridge.resolveUpstreamAdbPort(process.env.ANDROID_ADB_SERVER_PORT),
      log: (event, data) => { try { require('./lib/launcher-log').write(event, data) } catch (_) {} },
    })
  } catch (e) {
    console.error('[usb-vps-bridge] start failed:', e?.message || e)
    return { enabled: false, denied: true, error: e?.message || 'Bridge start failed', backendState: 'Unknown', endpoint: null, devices: [] }
  }
}
function stopUsbVpsBridge() {
  try { require('./lib/usb-vps-bridge').stop() } catch (_) {}
}
// { enabled, endpoint, devices } — the Settings UI shows the ANDROID_ADB_SERVER_SOCKET
// endpoint the VPS points at, plus the USB phones it'll see.
ipcMain.handle('usb-vps:status', async () => {
  try { return await require('./lib/usb-vps-bridge').status() } catch (_) { return { enabled: false, denied: true, error: 'Bridge status unavailable', backendState: 'Unknown', endpoint: null, devices: [] } }
})

// IPC: Copy a file on the host filesystem. Used by Quick Upload to stage
// selected media files into CONTENT_ROOT before pushing them to the
// device. The preload wires this as electronAPI.copyFile(from, to) but
// the handler was missing — every Quick Upload run silently failed the
// primary path and fell back to a direct ADB push to /sdcard/DCIM/ that
// only works for user 0 profiles.
//
// Security: the destination is constrained to CONTENT_ROOT (and its
// subtree) so a compromised renderer can't write into arbitrary host
// paths. Source has no such restriction — it's the file the user picked
// in the system picker, which they already had read access to.
ipcMain.handle('copy-file', async (event, fromPath, toPath) => {
  try {
    if (!fromPath || !toPath) return false
    const resolvedTo = path.resolve(toPath)
    const resolvedRoot = path.resolve(CONTENT_ROOT)
    if (!resolvedTo.startsWith(resolvedRoot + path.sep) && resolvedTo !== resolvedRoot) {
      console.warn(`[copy-file] Refusing destination outside CONTENT_ROOT: ${resolvedTo}`)
      return false
    }
    if (!fs.existsSync(fromPath)) {
      console.warn(`[copy-file] Source missing: ${fromPath}`)
      return false
    }
    // Ensure dest dir exists before the copy.
    fs.mkdirSync(path.dirname(resolvedTo), { recursive: true })
    await fs.promises.copyFile(fromPath, resolvedTo)
    return true
  } catch (err) {
    console.error(`[copy-file] ${err?.message || err}`)
    return false
  }
})

// IPC: Create account folders
ipcMain.handle('content:createAccountFolders', async (event, platform, accountUsername) => {
  return createAccountFolders(platform, accountUsername)
})

/**
 * Validate account folders - check if they exist
 * Returns status for each account: { username, existed, created, ready }
 * Uses same platform-specific folder structure as createAccountFolders
 */
function validateAccountFolders(platform, accounts) {
  const platformFolder = normalizeContentPlatform(platform)

  // Must match createAccountFolders structure
  const platformSubfolders = {
    instagram: ['images', 'videos', 'reels', 'trial_reels', 'stories', 'used_images', 'used_videos', 'used_reels', 'used_trial_reels', 'used_stories', 'comments', 'captions', 'story_captions'],
    threads: ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
    tiktok: ['videos', 'used_videos', 'captions', 'comments'],
    twitter: ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
    reddit: ['images', 'videos', 'used_images', 'used_videos', 'captions', 'comments'],
  }

  const platformTemplates = {
    instagram: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
      'story_captions': 'story_captions.txt',
    },
    threads: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
    },
    tiktok: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
    },
    twitter: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
    },
    reddit: {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
    },
  }

  const subfolders = platformSubfolders[platformFolder] || platformSubfolders.instagram
  const textFolderMap = platformTemplates[platformFolder] || platformTemplates.instagram
  const results = []

  // Enumerate nested layout once — Content/phones/*/profiles/*/<platform>/<account>/
  // Keyed by handle so per-account lookup is O(1).
  const cp = require('./lib/content-paths')
  const nestedByHandle = {}
  for (const e of cp.enumerateDiskAccounts(CONTENT_ROOT, platformFolder)) {
    if (!nestedByHandle[e.handle]) nestedByHandle[e.handle] = []
    nestedByHandle[e.handle].push(e.accountPath)
  }

  for (const account of accounts) {
    const username = normalizeContentAccountKey(account.username)
    if (!username) continue

    const accountPath = path.join(CONTENT_ROOT, platformFolder, username)
    const nestedPaths = nestedByHandle[username] || []

    // Check flat layout subfolders
    let flatAllExist = true
    const missingFolders = []
    for (const subfolder of subfolders) {
      const folderPath = path.join(accountPath, subfolder)
      if (!fs.existsSync(folderPath)) {
        flatAllExist = false
        missingFolders.push(subfolder)
      }
    }

    // Check flat template files
    const missingTemplates = []
    Object.entries(textFolderMap).forEach(([folder, defaultFile]) => {
      const targetFilePath = path.join(accountPath, folder, defaultFile)
      if (!fs.existsSync(targetFilePath)) {
        missingTemplates.push(`${folder}/${defaultFile}`)
      }
    })

    // Check nested layout: account is ready if ANY nested folder has all subfolders + templates.
    let nestedReady = false
    let nestedExist = false
    for (const nestedAcctPath of nestedPaths) {
      let nAllExist = true
      for (const subfolder of subfolders) {
        if (!fs.existsSync(path.join(nestedAcctPath, subfolder))) { nAllExist = false; break }
      }
      if (nAllExist) nestedExist = true
      let nTemplatesOk = true
      for (const [folder, defaultFile] of Object.entries(textFolderMap)) {
        if (!fs.existsSync(path.join(nestedAcctPath, folder, defaultFile))) { nTemplatesOk = false; break }
      }
      if (nAllExist && nTemplatesOk) { nestedReady = true; break }
    }

    // Ready = flat ready OR any nested folder ready.
    // existed = flat complete OR any nested folder structurally complete.
    const allExist = flatAllExist || nestedExist
    const ready = (flatAllExist && missingTemplates.length === 0) || nestedReady

    results.push({
      username,
      path: accountPath,
      existed: allExist,
      created: 0,  // Validate does NOT create — use createAccountFolders for that
      ready,
      missingFolders: allExist ? [] : missingFolders,
      missingTemplates: ready ? [] : missingTemplates,
    })
  }

  console.log(`[Content] Validated ${results.length} ${platformFolder} accounts (read-only check)`)
  return { success: true, results }
}

// IPC: Validate all account folders
ipcMain.handle('content:validateAccountFolders', async (event, platform, accounts) => {
  return validateAccountFolders(platform, accounts)
})

// IPC: Get default templates
ipcMain.handle('content:getDefaults', async () => {
  const defaultsPath = path.join(CONTENT_ROOT, DEFAULTS_FOLDER)
  const result = {}

  try {
    const files = ['comments.txt', 'captions.txt', 'story_captions.txt']
    files.forEach(file => {
      const filePath = path.join(defaultsPath, file)
      if (fs.existsSync(filePath)) {
        result[file.replace('.txt', '')] = fs.readFileSync(filePath, 'utf8')
      } else {
        result[file.replace('.txt', '')] = ''
      }
    })
    return { success: true, defaults: result }
  } catch (error) {
    console.error('[Content] Failed to read defaults:', error)
    return { success: false, error: error.message }
  }
})

// IPC: Save default templates
ipcMain.handle('content:saveDefaults', async (event, defaults) => {
  const defaultsPath = path.join(CONTENT_ROOT, DEFAULTS_FOLDER)

  try {
    // Ensure defaults folder exists
    if (!fs.existsSync(defaultsPath)) {
      fs.mkdirSync(defaultsPath, { recursive: true })
    }

    // Save each default file
    Object.entries(defaults).forEach(([key, content]) => {
      const filePath = path.join(defaultsPath, `${key}.txt`)
      fs.writeFileSync(filePath, content, 'utf8')
      console.log(`[Content] Saved default: ${key}.txt`)
    })

    return { success: true }
  } catch (error) {
    console.error('[Content] Failed to save defaults:', error)
    return { success: false, error: error.message }
  }
})

// IPC: Read a caption/comment pool — per-account file first, fall back to defaults.
// kind: 'captions' | 'story_captions' | 'comments'
// Returns { success, pool: string[], source: 'account' | 'defaults' | 'empty' }
ipcMain.handle('content:getCaptionPool', async (event, platform, accountUsername, kind) => {
  const platformLower = normalizeContentPlatform(platform)
  const accountKey = normalizeContentAccountKey(accountUsername)
  const validKinds = new Set(['captions', 'story_captions', 'comments'])
  const kindKey = validKinds.has(String(kind)) ? String(kind) : 'captions'
  const fileName = `${kindKey}.txt`

  const parsePool = (raw) => String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))

  try {
    if (accountKey) {
      const accountFile = path.join(CONTENT_ROOT, platformLower, accountKey, kindKey, fileName)
      if (fs.existsSync(accountFile)) {
        const pool = parsePool(fs.readFileSync(accountFile, 'utf8'))
        if (pool.length > 0) return { success: true, pool, source: 'account' }
      }
    }
    const defaultsFile = path.join(CONTENT_ROOT, DEFAULTS_FOLDER, fileName)
    if (fs.existsSync(defaultsFile)) {
      const pool = parsePool(fs.readFileSync(defaultsFile, 'utf8'))
      return { success: true, pool, source: pool.length > 0 ? 'defaults' : 'empty' }
    }
    return { success: true, pool: [], source: 'empty' }
  } catch (error) {
    console.error('[Content] Failed to read caption pool:', error)
    return { success: false, error: error.message, pool: [], source: 'empty' }
  }
})

// IPC: Apply defaults to ALL existing accounts.
// Default behavior: PRESERVES per-account customizations — only seeds defaults
// where no per-account file exists yet. Pass { force: true } to overwrite.
ipcMain.handle('content:applyDefaultsToAll', async (event, options = {}) => {
  const force = options && options.force === true
  const requestedPlatform = options?.platform
  if (requestedPlatform && !SUPPORTED_PLATFORMS.includes(requestedPlatform)) {
    return { success: false, error: `Unsupported content platform: ${requestedPlatform}` }
  }
  const targetPlatforms = [...new Set(
    (requestedPlatform ? [requestedPlatform] : SUPPORTED_PLATFORMS).map(normalizeContentPlatform)
  )]
  const defaultsPath = path.join(CONTENT_ROOT, DEFAULTS_FOLDER)
  let accountsUpdated = 0
  let filesWritten = 0
  let filesPreserved = 0
  const errors = []

  try {
    // Map of text folders to their default files
    const textFolderMap = {
      'comments': 'comments.txt',
      'captions': 'captions.txt',
      'story_captions': 'story_captions.txt'
    }

    for (const platform of targetPlatforms) {
      const platformPath = path.join(CONTENT_ROOT, platform)

      if (!fs.existsSync(platformPath)) continue

      // Get all account folders in this platform
      const accounts = fs.readdirSync(platformPath)
        .filter(item => {
          const itemPath = path.join(platformPath, item)
          return fs.statSync(itemPath).isDirectory() && !item.startsWith('.')
        })

      // For each account, copy defaults
      for (const account of accounts) {
        const accountPath = path.join(platformPath, account)

        try {
          // Copy each default file to its folder
          Object.entries(textFolderMap).forEach(([folder, defaultFile]) => {
            const defaultFilePath = path.join(defaultsPath, defaultFile)
            const targetFolder = path.join(accountPath, folder)
            const targetFilePath = path.join(targetFolder, defaultFile)

            // Ensure target folder exists
            if (!fs.existsSync(targetFolder)) {
              fs.mkdirSync(targetFolder, { recursive: true })
            }

            // Skip if no default to copy
            if (!fs.existsSync(defaultFilePath)) return

            // Preserve customizations unless caller explicitly forced overwrite
            if (!force && fs.existsSync(targetFilePath)) {
              filesPreserved++
              return
            }

            const content = fs.readFileSync(defaultFilePath, 'utf8')
            fs.writeFileSync(targetFilePath, content, 'utf8')
            filesWritten++
          })
          accountsUpdated++
          console.log(`[Content] Applied defaults to: ${platform}/${account}`)
        } catch (err) {
          errors.push(`${platform}/${account}: ${err.message}`)
        }
      }
    }

    return {
      success: true,
      accountsUpdated,
      filesWritten,
      filesPreserved,
      forced: force,
      errors: errors.length > 0 ? errors : undefined
    }
  } catch (error) {
    console.error('[Content] Failed to apply defaults to all:', error)
    return { success: false, error: error.message }
  }
})

// IPC: List local content for an account
ipcMain.handle('content:listLocal', async (event, platform, accountUsername, subfolder = 'images') => {
  try {
    const platformFolder = normalizeContentPlatform(platform)
    const accountKey = normalizeContentAccountKey(accountUsername)
    if (!accountKey) return { success: false, error: 'Account username is required', files: [] }
    if (subfolder && !CONTENT_SUBFOLDERS.has(subfolder)) {
      return { success: false, error: 'Invalid subfolder', files: [] }
    }
    const folderPath = path.join(CONTENT_ROOT, platformFolder, accountKey, subfolder)
    if (!isInsideContentRoot(folderPath)) {
      return { success: false, error: 'path outside content root', files: [] }
    }

    if (!fs.existsSync(folderPath)) {
      return { success: true, files: [] }
    }

    const names = (await fs.promises.readdir(folderPath))
      .filter(file => {
        const ext = path.extname(file).toLowerCase()
        if (subfolder.includes('images')) {
          return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)
        } else {
          return ['.mp4', '.mov', '.avi', '.webm', '.mkv'].includes(ext)
        }
      })
    const files = await Promise.all(names.map(async file => {
      const filePath = path.join(folderPath, file)
      const st = await fs.promises.stat(filePath)
      return { name: file, path: filePath, size: st.size, modified: st.mtime }
    }))

    return { success: true, files, folder: folderPath }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// IPC: Get content counts for an account (all subfolders)
ipcMain.handle('content:getCounts', async (event, platform, accountUsername) => {
  const counts = { images: 0, videos: 0, reels: 0, trial_reels: 0, stories: 0, used_images: 0, used_videos: 0, used_reels: 0, used_trial_reels: 0, used_stories: 0 }
  const platformFolder = normalizeContentPlatform(platform)
  const accountKey = normalizeContentAccountKey(accountUsername)
  if (!accountKey) return { success: false, error: 'Account username is required', counts }
  const accountPath = path.join(CONTENT_ROOT, platformFolder, accountKey)
  if (!isInsideContentRoot(accountPath)) {
    return { success: false, error: 'path outside content root', counts }
  }

  // Helper: count files in one on-disk account folder (flat or nested).
  // Returns a counts object with the same keys as `counts`.
  async function _countFolder(basePath) {
    const result = {}
    await Promise.all(Object.keys(counts).map(async (subfolder) => {
      const folderPath = path.join(basePath, subfolder)
      try {
        const entries = await fs.promises.readdir(folderPath)
        result[subfolder] = entries.filter(f => !f.startsWith('.')).length
      } catch (e) {
        if (e.code === 'ENOENT') { result[subfolder] = 0; return }
        throw e
      }
    }))
    return result
  }

  try {
    // --- Flat (legacy) layout: Content/<platform>/<account>/ ---
    const flatCounts = await _countFolder(accountPath)

    // --- Nested layout: Content/phones/*/profiles/*/<platform>/<account>/ ---
    // The caller only passes (platform, username) — no serial or profileId.
    // Scan ALL phone/profile combos for this handle and sum their counts.
    // Same-handle accounts on different phones are physically distinct content,
    // so summing is correct. Flat and nested are separate trees (no overlap).
    const cp = require('./lib/content-paths')
    const nestedMatches = cp.enumerateDiskAccounts(CONTENT_ROOT, platformFolder)
      .filter(e => e.handle === accountKey)

    const nestedCountsList = await Promise.all(nestedMatches.map(e => _countFolder(e.accountPath)))

    // Merge: sum flat + all nested matches per subfolder.
    for (const subfolder of Object.keys(counts)) {
      counts[subfolder] = flatCounts[subfolder] || 0
      for (const nc of nestedCountsList) counts[subfolder] += nc[subfolder] || 0
    }

    return { success: true, counts }
  } catch (error) {
    return { success: false, error: error.message, counts }
  }
})

// IPC: Move file to used folder after posting
ipcMain.handle('content:moveToUsed', async (event, filePath) => {
  try {
    const resolved = path.resolve(String(filePath))
    const resolvedRoot = path.resolve(CONTENT_ROOT)
    if (!resolved.startsWith(resolvedRoot + path.sep)) {
      return { success: false, error: 'path outside content root' }
    }
    const dir = path.dirname(resolved)
    const filename = path.basename(resolved)
    const folderName = path.basename(dir)

    // Determine destination folder
    let destFolder
    if (folderName === 'images') {
      destFolder = path.join(path.dirname(dir), 'used_images')
    } else if (folderName === 'videos') {
      destFolder = path.join(path.dirname(dir), 'used_videos')
    } else if (folderName === 'reels') {
      destFolder = path.join(path.dirname(dir), 'used_reels')
    } else if (folderName === 'trial_reels') {
      destFolder = path.join(path.dirname(dir), 'used_trial_reels')
    } else if (folderName === 'stories') {
      destFolder = path.join(path.dirname(dir), 'used_stories')
    } else {
      return { success: false, error: 'File not in images/videos/reels/trial_reels/stories folder' }
    }

    // Ensure destination exists
    if (!fs.existsSync(destFolder)) {
      fs.mkdirSync(destFolder, { recursive: true })
    }

    // Move file
    const destPath = path.join(destFolder, filename)
    fs.renameSync(resolved, destPath)
    console.log(`[Content] Moved to used: ${filename}`)

    return { success: true, newPath: destPath }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// IPC: Open content folder in file explorer
ipcMain.handle('content:openFolder', async (event, platform, accountUsername, subfolder) => {
  let folderPath
  if (platform && accountUsername) {
    const platformFolder = normalizeContentPlatform(platform)
    const accountKey = normalizeContentAccountKey(accountUsername)
    if (!accountKey) {
      return { success: false, error: 'Account username is required' }
    }
    if (subfolder && !CONTENT_SUBFOLDERS.has(subfolder)) {
      return { success: false, error: 'Invalid subfolder' }
    }
    folderPath = subfolder
      ? path.join(CONTENT_ROOT, platformFolder, accountKey, subfolder)
      : path.join(CONTENT_ROOT, platformFolder, accountKey)
  } else if (platform) {
    folderPath = path.join(CONTENT_ROOT, normalizeContentPlatform(platform))
  } else {
    folderPath = CONTENT_ROOT
  }

  // Containment assert BEFORE mkdir/openPath — shell.openPath on a Windows
  // .exe/.lnk/.bat launches it, so a path escape here is load-bearing.
  if (!isInsideContentRoot(folderPath)) {
    return { success: false, error: 'path outside content root' }
  }

  // Create if doesn't exist
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true })
  }

  shell.openPath(folderPath)
  return { success: true, path: folderPath }
})

// IPC: Delete account folders (when account is removed)
ipcMain.handle('content:deleteAccountFolders', async (event, platform, accountUsername) => {
  const SAFE_NAME = /^[A-Za-z0-9._-]+$/
  const safeAcct = normalizeContentAccountKey(accountUsername)   // strips leading @, trims, lowercases, charset-validates
  const safePlat = normalizeContentPlatform(platform)
  if (!safeAcct || !SAFE_NAME.test(safeAcct) || safeAcct.length > 64) {
    return { success: false, error: `Invalid accountUsername: ${accountUsername}` }
  }
  if (!SAFE_NAME.test(safePlat) || safePlat.length > 32) {
    return { success: false, error: `Invalid platform: ${platform}` }
  }
  const accountPath = path.resolve(CONTENT_ROOT, safePlat, safeAcct)
  const resolvedRoot = path.resolve(CONTENT_ROOT)
  if (!accountPath.startsWith(resolvedRoot + path.sep)) {
    return { success: false, error: 'path outside content root' }
  }

  try {
    if (fs.existsSync(accountPath)) {
      fs.rmSync(accountPath, { recursive: true, force: true })
      console.log(`[Content] Deleted account folder: ${accountPath}`)
      return { success: true, deleted: accountPath }
    } else {
      console.log(`[Content] Folder not found: ${accountPath}`)
      return { success: true, deleted: null }
    }
  } catch (error) {
    console.error('[Content] deleteAccountFolders failed:', error)
    return { success: false, error: error.message }
  }
})


// ==================== GOOGLE DRIVE DOWNLOAD ====================
// Download files from a Google Drive folder to local content folder
const DRIVE_CLIENT_ID = '1045727708702-q07gfkdll70djoi0odruiaa2slv3oa8d.apps.googleusercontent.com'
const DRIVE_CLIENT_SECRET = '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'
const DRIVE_REFRESH_TOKEN = '1//052fWWHgrRI7-CgYIARAAGAUSNwF-L9IrrDICccoy_I3uQSiy7jubK6CW_XYfGpmj9sHGyAnUFvURApDs5irvOCi1Rb6Qv6VkkLQ'

let driveAccessToken = null
let driveTokenExpiry = 0

async function getDriveAccessToken() {
  if (driveAccessToken && Date.now() < driveTokenExpiry) return driveAccessToken
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DRIVE_CLIENT_ID,
      client_secret: DRIVE_CLIENT_SECRET,
      refresh_token: DRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Drive OAuth refresh failed')
  driveAccessToken = data.access_token
  driveTokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  return driveAccessToken
}

function extractDriveFolderId(urlOrId) {
  if (!urlOrId) return null
  if (urlOrId.includes('drive.google.com')) {
    const match = urlOrId.match(/\/folders\/([a-zA-Z0-9_-]+)/)
    return match ? match[1] : null
  }
  return urlOrId
}

ipcMain.handle('drive:listFiles', async (event, driveUrl) => {
  try {
    const folderId = extractDriveFolderId(driveUrl)
    if (!folderId) return { success: false, error: 'Invalid Drive URL' }
    const token = await getDriveAccessToken()
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,size)&pageSize=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const data = await res.json()
    if (data.error) return { success: false, error: data.error.message }
    return { success: true, files: data.files || [] }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('drive:downloadToContent', async (event, { driveUrl, accountUsername, platform }) => {
  try {
    // Path-traversal guard. accountUsername and platform flow into
    // path.join(CONTENT_ROOT, platform, accountUsername) — without
    // validation a value like "../../Windows/System32" escapes the
    // content root and lets a compromised renderer clobber arbitrary
    // host files.
    const SAFE_NAME = /^[A-Za-z0-9._-]+$/
    const safeAcct = String(accountUsername || '').trim()
    const safePlat = String(platform || 'instagram').trim()
    if (!safeAcct || !SAFE_NAME.test(safeAcct) || safeAcct.length > 64) {
      return { success: false, error: `Invalid accountUsername: ${accountUsername}`, downloaded: 0 }
    }
    if (!SAFE_NAME.test(safePlat) || safePlat.length > 32) {
      return { success: false, error: `Invalid platform: ${platform}`, downloaded: 0 }
    }
    const folderId = extractDriveFolderId(driveUrl)
    if (!folderId) return { success: false, error: 'Invalid Drive URL', downloaded: 0 }
    const token = await getDriveAccessToken()

    // List files
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,size)&pageSize=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const listData = await listRes.json()
    if (listData.error) return { success: false, error: listData.error.message, downloaded: 0 }

    const files = (listData.files || []).filter(f =>
      f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/')
    )
    if (files.length === 0) return { success: true, downloaded: 0, message: 'No image/video files found' }

    const contentBase = path.join(CONTENT_ROOT, safePlat, safeAcct)
    // Belt-and-braces: make sure the resolved base actually lives under
    // CONTENT_ROOT even after symlink resolution.
    const resolvedBase = path.resolve(contentBase)
    const resolvedRoot = path.resolve(CONTENT_ROOT)
    if (!resolvedBase.startsWith(resolvedRoot + path.sep) && resolvedBase !== resolvedRoot) {
      return { success: false, error: 'Refusing to write outside the content root', downloaded: 0 }
    }
    const imagesDir = path.join(contentBase, 'images')
    const reelsDir = path.join(contentBase, 'reels')
    fs.mkdirSync(imagesDir, { recursive: true })
    fs.mkdirSync(reelsDir, { recursive: true })

    let downloaded = 0
    const errors = []

    for (const file of files) {
      try {
        const isVideo = file.mimeType?.startsWith('video/')
        const destDir = isVideo ? reelsDir : imagesDir

        // Sanitize the Drive-supplied name to a safe basename, then re-assert
        // containment before any fs access (the resolvedBase guard above runs
        // before file.name is appended, so it doesn't cover this join).
        const safeFileName = path.basename(String(file.name || '')).replace(/[^A-Za-z0-9._-]/g, '_')
        if (!safeFileName || safeFileName === '.' || safeFileName === '..') {
          errors.push({ file: file.name, error: 'unsafe name' })
          continue
        }
        const destPath = path.resolve(path.join(destDir, safeFileName))
        if (!destPath.startsWith(resolvedRoot + path.sep)) {
          errors.push({ file: file.name, error: 'path escape' })
          continue
        }

        // Skip if already exists
        if (fs.existsSync(destPath)) {
          console.log(`[Drive] Skipping (exists): ${file.name}`)
          continue
        }

        // Download
        const dlRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (!dlRes.ok) {
          errors.push({ file: file.name, error: `HTTP ${dlRes.status}` })
          continue
        }

        const buffer = Buffer.from(await dlRes.arrayBuffer())
        fs.writeFileSync(destPath, buffer)
        downloaded++

        // Send progress to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('drive:downloadProgress', {
            accountUsername,
            file: file.name,
            downloaded,
            total: files.length,
          })
        }

        console.log(`[Drive] Downloaded: ${file.name} -> ${isVideo ? 'reels' : 'images'}`)
      } catch (dlErr) {
        errors.push({ file: file.name, error: dlErr.message })
      }
    }

    return { success: true, downloaded, total: files.length, errors: errors.length > 0 ? errors : undefined }
  } catch (err) {
    return { success: false, error: err.message, downloaded: 0 }
  }
})

// ==================== REDDIT CAPTIONS (CLIENT-SIDE FETCH) ====================
// Fetch Reddit post titles from user's machine (residential IP bypasses cloud 403)
ipcMain.handle('fetch-reddit-captions', async (event, subreddit, limit = 10) => {
  const https = require('https')
  const subName = (subreddit || '').trim().replace(/^r\//, '')
  if (!subName) return { success: false, error: 'No subreddit provided', captions: [] }

  console.log(`[Reddit] Fetching captions for r/${subName} (limit=${limit})`)

  return new Promise((resolve) => {
    const url = `https://www.reddit.com/r/${encodeURIComponent(subName)}/hot.json?limit=${limit}&raw_json=1`
    const options = {
      headers: {
        'User-Agent': 'ShadowPhone/1.0 (Desktop Client)',
        'Cookie': 'over18=1',
        'Accept': 'application/json',
      },
      timeout: 10000,
    }

    const req = https.get(url, options, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.warn(`[Reddit] HTTP ${res.statusCode} for r/${subName}`)
            resolve({ success: false, error: `HTTP ${res.statusCode}`, captions: [] })
            return
          }

          const data = JSON.parse(body)
          const posts = data?.data?.children || []
          const captions = posts
            .filter(p => p.kind === 't3' && p.data?.title)
            .map(p => ({
              title: p.data.title,
              score: p.data.score || 0,
              upvote_ratio: p.data.upvote_ratio || 0,
              num_comments: p.data.num_comments || 0,
              permalink: p.data.permalink || '',
              post_type: p.data.is_video ? 'video'
                : p.data.is_gallery ? 'gallery'
                : (p.data.post_hint === 'image') ? 'image'
                : p.data.is_self ? 'text' : 'link',
              is_nsfw: Boolean(p.data.over_18),
            }))

          console.log(`[Reddit] Got ${captions.length} captions for r/${subName}`)
          resolve({ success: true, captions })
        } catch (parseErr) {
          console.error(`[Reddit] JSON parse error for r/${subName}:`, parseErr.message)
          resolve({ success: false, error: 'Failed to parse Reddit response', captions: [] })
        }
      })
    })

    req.on('error', (err) => {
      console.error(`[Reddit] Network error for r/${subName}:`, err.message)
      resolve({ success: false, error: err.message, captions: [] })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, error: 'Request timed out', captions: [] })
    })
  })
})

// ==================== PROCESS ERROR HANDLERS ====================
// Log unhandled errors so they're visible in production (no silent swallowing)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught Exception:', error)
})

// App lifecycle

app.whenReady().then(async () => {
  // Whole-pipeline sentinel — proves where execution stops if the brain
  // IIFE further down silently doesn't run. Each step writes a line; if
  // the file ends at "after-createWindow" but not "before-brain-iife",
  // we know what's eating it.
  const _writeSentinel = (tag) => {
    try {
      const fs = require('fs'); const path = require('path')
      const dir = path.join(app.getPath('userData'), 'logs')
      try { fs.mkdirSync(dir, { recursive: true }) } catch { /* */ }
      fs.appendFileSync(path.join(dir, 'brain.log'),
        `[${new Date().toISOString()}] whenReady step: ${tag}\n`)
    } catch (e) {
      try {
        require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'shadowphone-brain-fallback.log'),
          `[${new Date().toISOString()}] sentinel write failed at ${tag}: ${e?.message || e}\n`)
      } catch { /* swallow */ }
    }
  }
  _writeSentinel('whenReady-entry')
  const resolvedAdbPath = getADBPath()
  // Startup is the ONE moment a stale adb server may be reaped: nothing is
  // mirroring yet, so no live transport can be torn out from under scrcpy. The
  // runtime circuit-breaker recovery path deliberately never passes this.
  const staleAdb = await reapStaleAdbProcesses(resolvedAdbPath, { includeServer: true })
  if (staleAdb.killed > 0) {
    console.warn(`[ADB Guard] Reaped ${staleAdb.killed} stale bundled adb process${staleAdb.killed === 1 ? '' : 'es'} before startup`)
  } else if (staleAdb.error) {
    console.warn('[ADB Guard] Stale-process cleanup failed:', staleAdb.error)
  }
  // 3.2.3: release any USB device held by a FOREIGN adb server on the default
  // port 5037 (a system adb that grabbed the device would otherwise lock our
  // dedicated-port 5137 server out — two adb servers can't share one USB device).
  // Best-effort; our 5137 server claims the devices immediately afterwards.
  // No-op for the common case (no other adb server running).
  await runAdb(resolvedAdbPath, ['kill-server'], 5000, {
    env: { ANDROID_ADB_SERVER_PORT: '5037' },
  })
  await startADBServer()
  _writeSentinel('after-startADBServer')
  // 2.14.4: one-shot startup cleanup of port-mode scrcpy.Server processes
  // on every connected device. Fixes the version-transition war: when the
  // wizard updates from v2.14.x → v2.14.(x+1), the OLD sp_build servers
  // are still alive on the phones; the new wizard sees them as stale_args
  // and respawns, but on Pixel 6a the port-rebind hits TIME_WAIT and the
  // new spawn fails to bind. Doing a SYNCHRONOUS sweep at boot (before
  // any client touches the dashboard) gives TIME_WAIT 30s to drain
  // before normal flow tries to bind.
  try {
    const path = require('path')
    const brainLogPath = path.join(app.getPath('userData'), 'logs', 'brain.log')
    const cleanup = require('./lib/scrcpy-startup-cleanup')
    await cleanup.sweepAllDevices({
      adbPath: getADBPath(),
      logger: (m) => {
        try { fs.appendFileSync(brainLogPath, `[${new Date().toISOString()}] [startup-cleanup] ${m}\n`) } catch (_) {}
      },
    })
    // 2.16.18: also kill local-side orphan adb children left behind by a
    // crashed/killed previous ShadowPhone. These caused 2.16.16's "already
    // running" false-positive because their cmdline contained "scrcpy".
    try {
      const orphans = require('./lib/scrcpy-orphan-killer')
      orphans.sweep({ logger: (m) => {
        try { fs.appendFileSync(brainLogPath, `[${new Date().toISOString()}] ${m}\n`) } catch (_) {}
      }})
    } catch (e) { console.warn('[main] orphan sweep failed (non-fatal):', e?.message || e) }
    _writeSentinel('after-startup-cleanup')
  } catch (e) {
    try {
      const path = require('path')
      const brainLogPath = path.join(app.getPath('userData'), 'logs', 'brain.log')
      fs.appendFileSync(brainLogPath, `[${new Date().toISOString()}] [startup-cleanup] FAILED: ${e?.message || e}\n`)
    } catch (_) {}
  }
  migrateContentFromInstallDir() // Move content from old install dir to userData (one-time)
  _writeSentinel('after-migrateContentFromInstallDir')
  ensureContentFolders() // Create local content folder structure
  _writeSentinel('after-ensureContentFolders')
  createWindow()
  _writeSentinel('after-createWindow')

  // 2.17.24: clipboard trailing-newline trimmer. scrcpy's --legacy-paste
  // injects the clipboard as raw keystrokes — a trailing \n becomes Enter,
  // which submits forms / sends IG messages prematurely. Anyro: "only thing
  // i dont like is it auto enters after pasting". Watch the host clipboard
  // every 400ms; whenever the text content ends with one or more newlines,
  // strip them and re-set. Skips multi-line clipboards (only trims pure
  // trailing whitespace runs on what's otherwise single-line content).
  // Doesn't run for image/file clipboards (only text).
  try {
    let _lastTrimmedClipboardHash = ''
    setInterval(() => {
      try {
        const { clipboard } = require('electron')
        const txt = clipboard.readText() || ''
        if (!txt || !/[\n\r]+$/.test(txt)) return
        const trimmed = txt.replace(/[\n\r]+$/, '')
        if (!trimmed) return // would clear clipboard — skip
        // Hash so we don't fight other tools that intentionally append \n
        const hash = trimmed.length + ':' + trimmed.slice(0, 32) + ':' + trimmed.slice(-32)
        if (hash === _lastTrimmedClipboardHash) return
        clipboard.writeText(trimmed)
        _lastTrimmedClipboardHash = hash
      } catch (_) {}
    }, 400)
  } catch (e) {
    console.warn('[main] clipboard trimmer init failed:', e?.message || e)
  }

  // ==================== ALWAYS-ON LOCAL BRAIN ====================
  // Eager-spawn the local Python brain the moment Electron is ready, BEFORE
  // the renderer can fire a schedule run. Pre-warming the cold-start cost
  // (8-20s of Python imports) up here means a schedule firing right after
  // window load doesn't race the brain's boot.
  //
  // Async / non-blocking: window creation never waits on the brain. The
  // renderer's waitForLocalBrain(45s) + the watchdog handle the gap.
  //
  // Watchdog: starts immediately so even if the initial spawn fails (Python
  // missing during installer's first run, port already in use, etc.), the
  // 10s ticker keeps trying to bring it back. respawnAttempts is reset
  // after 2 consecutive healthy probes so transient crash loops don't
  // permanently brick the user.
  ;(async () => {
    // Sentinel — writes the moment this IIFE actually runs, so we can prove
    // whether the brain spawn was even attempted (no logs reach stdout in
    // a packaged NSIS launch, so this file is the ground truth).
    try {
      const fs = require('fs'); const path = require('path')
      const userData = app.getPath('userData')
      const logDir = path.join(userData, 'logs')
      try { fs.mkdirSync(logDir, { recursive: true }) } catch { /* */ }
      fs.appendFileSync(path.join(logDir, 'brain.log'),
        `[${new Date().toISOString()}] eager-spawn IIFE entered (resourcesPath=${process.resourcesPath})\n`)
    } catch { /* best effort */ }
    // Orphan cleanup + port-free wait are now owned by local-brain.js
    // (killOrphansOnBrainPort() + the bounded probeBrainPort() wait inside
    // startLocalBrain). The previous inline netstat/taskkill block here
    // duplicated the kill but did NOT wait for the OS to release :8090, so it
    // raced the local-brain spawn and re-introduced the [Errno 10048] flap it
    // was meant to prevent. Removed — single owner, single port-wait.
    try {
      const localBrain = require('./lib/local-brain')
      const endpoint = await localBrain.startLocalBrain({ getResourcesPath: process.resourcesPath, app })
      if (endpoint) {
        console.log(`[main] Local brain ready at ws://${endpoint.host}:${endpoint.port} (${endpoint.kind})`)
      } else {
        console.warn('[main] Local brain unavailable on first spawn — watchdog will keep retrying.')
      }
      // Let the watchdog consult the in-flight module-run refcount so it
      // never SIGKILLs a brain mid-run — a busy brain that's slow to answer
      // a health ping is not a dead brain, and killing it drops the
      // automation WebSocket (close code 1006) and hard-fails the run.
      try { localBrain.setActiveRunCountGetter(() => activeRunCount) } catch { /* best effort */ }
      // Always start the watchdog, even if the first spawn failed. The
      // watchdog is the recovery path for transient startup failures, and
      // it's what makes the brain genuinely "always on" rather than
      // "best-effort at boot."
      localBrain.startBrainWatchdog()
    } catch (e) {
      console.warn('[main] Local brain start failed:', e?.message || e)
      // Still start the watchdog so users who hit a transient error on
      // first spawn (e.g. Windows Defender mid-scan) self-heal without
      // having to relaunch the app.
      try {
        const lb = require('./lib/local-brain')
        lb.setActiveRunCountGetter(() => activeRunCount)
        lb.startBrainWatchdog()
      } catch { /* best effort */ }
    }
  })()

  // Manual restart from the renderer's Brain Status pill (DOWN > Restart).
  // Resets the respawn budget and forces a fresh spawn with cached options.
  ipcMain.handle('brain:restart', async () => {
    try {
      const { restartLocalBrain } = require('./lib/local-brain')
      const result = await restartLocalBrain()
      if (result?.endpoint) {
        return {
          success: true,
          endpoint: `ws://${result.endpoint.host}:${result.endpoint.port}`,
          kind: result.endpoint.kind,
        }
      }
      return { success: false, error: result?.error || 'Brain failed to restart.' }
    } catch (e) {
      console.warn('[main] brain:restart failed:', e?.message || e)
      return { success: false, error: e?.message || 'Restart threw an exception.' }
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

})

let localBrainTeardownPromise = null
let localBrainTeardownComplete = false
let appQuitContinuationScheduled = false
let appQuitTeardownComplete = false

function stopLocalBrainOnce() {
  if (!localBrainTeardownPromise) {
    localBrainTeardownPromise = (async () => {
      try {
        const localBrain = require('./lib/local-brain')
        localBrain.stopBrainWatchdog()
        const result = await localBrain.stopLocalBrain()
        if (result && !result.ok) console.warn('[main] Local brain teardown was incomplete:', result.error)
      } catch (error) {
        console.warn('[main] Local brain teardown failed:', error?.message || error)
      }
    })().finally(() => { localBrainTeardownComplete = true })
  }
  return localBrainTeardownPromise
}

app.on('window-all-closed', async () => {
  // The app had NO exit telemetry: launcher.log's last line was the operator's
  // create submit and the process was simply gone, with no Windows fault record
  // and no scrcpy:closed — indistinguishable from a crash. Closing the dashboard
  // destroys it for good (no tray, no 'close' interceptor), so once it is gone
  // the mirror sidebar is the LAST window and its teardown quits the whole app.
  // Log what was live at that instant so this is never a mystery again.
  try {
    require('./lib/launcher-log').write('app:window-all-closed', {
      busyPhones: (() => { try { return require('./lib/schedule-engine').hasBusyPhones() === true } catch (_) { return null } })(),
      openToolbars: (() => { try { return require('./lib/mirror-toolbar').getOpenSerials().length } catch (_) { return null } })(),
    })
  } catch (_) {}
  stopRuntimeQueueRelay()
  stopADBMonitoring()
  await stopADBServer()
  // device-watchdog is app-scoped: its tick + keepalive intervals leak across
  // window lifecycle and can hold the event loop open, delaying clean quit.
  try { require('./lib/device-watchdog').stop() } catch (_) {}
  try { require('./lib/schedule-engine').stopPhoneLockJanitor() } catch (_) {}
  // Reap every running scrcpy (incl. its adb child tree via taskkill /T on
  // win32) so app exit doesn't leave orphan mirror windows alive on the phone
  // farm. Synchronous + swallowed so it can't stall quit; idempotent with the
  // before-quit pass below (maps clear on first call).
  try { require('./handlers/system-handlers').killAllScrcpy() } catch (_) {}
  await stopLocalBrainOnce()
  if (process.platform !== 'darwin') {
    shutdownAdbProcesses()
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  if (appQuitTeardownComplete) return
  try {
    require('./lib/launcher-log').write('app:before-quit', {
      busyPhones: (() => { try { return require('./lib/schedule-engine').hasBusyPhones() === true } catch (_) { return null } })(),
    })
  } catch (_) {}
  event.preventDefault()
  if (appQuitContinuationScheduled) return
  appQuitContinuationScheduled = true
  stopRuntimeQueueRelay()
  stopADBMonitoring()
  await stopADBServer()
  // Quit is synchronously gated above, so Electron cannot exit while the
  // daemon stop is in flight. Close the manager immediately afterward and
  // before the remaining asynchronous teardown.
  shutdownAdbProcesses()
  try { require('./lib/device-watchdog').stop() } catch (_) {}
  // Reap every running scrcpy + its adb child tree so quitting never leaves
  // orphan mirror windows alive on the farm (only reaped at next launch
  // otherwise). Synchronous + swallowed; idempotent with the window-all-closed
  // pass above.
  try { require('./handlers/system-handlers').killAllScrcpy() } catch (_) {}
  // Kill any in-flight logcat streams (F2) so quitting never leaves an orphan
  // `adb logcat` process attached to a phone. Same tree-kill idiom as above.
  try { require('./lib/logcat-stream').stopAll() } catch (_) {}
  await stopLocalBrainOnce()
  try { await shutdownPortal() } catch { /* best effort */ }
  appQuitTeardownComplete = true
  appQuitContinuationScheduled = false
  app.quit()
})
