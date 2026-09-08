/**
 * WebSocket Client for Real-Time Module Execution
 * 
 * This client connects to the Railway server's WebSocket endpoint
 * to execute modules with real-time screen state feedback.
 * 
 * Architecture:
 * - Server controls ALL module logic (Python modules on Railway)
 * - Client executes ADB commands and returns screen state
 * - WebSocket maintains persistent connection for low latency
 * 
 * Flow:
 * 1. Client connects and authenticates (JWT or API secret)
 * 2. Client requests module start
 * 3. Server sends commands (tap, swipe, input, etc.)
 * 4. Client executes via ADB and returns screen XML
 * 5. Server analyzes screen and sends next command
 * 6. Loop until module completes
 */

const WebSocket = require('ws')
const { execSync } = require('child_process')
const http = require('http')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { createHash, randomUUID } = require('crypto')
const { TAILNET_SERIAL_RE, classifyTransport } = require('./device-identity')
const { acquireModuleRunMutex } = require('./schedule-engine')
const { runAdb } = require('./adb-util')
const { mediaMimeType } = require('./media-mime')

const MAX_HUMAN_TEXT_INJECTIONS = 8
const TARGET_GRAPHEMES_PER_HUMAN_INJECTION = 12
const MAX_HUMAN_TEXT_DELAY_MS = 10000
const ADB_KEYBOARD_SHA256 = '41a8a0996d7397a2390d1ca16a75cb66c4a7bdaa89cf4e63600a4d3fb346fbbb'
const REDACTED_COMMAND_FIELDS = new Set([
    'text',
    'value',
    'keys',
    'password',
    'caption',
    'message',
    'token',
    'auth_token',
    'secret',
    'command',
])

// ── Device-liveness abort ────────────────────────────────────────────────────
// Incident: a run whose phone dies mid-flight hangs SILENTLY for up to the full
// 15-minute EXECUTION_TIMEOUT (1800s with MAX_ATTEMPTS=2) with no error surfaced.
// The brain is uvicorn: its protocol task answers WS PING frames at the SOCKET
// level even while the Python handler is BLOCKED on a dead adb call, so
// lastPongAt stays fresh and HEARTBEAT_STALE_MS never trips. This is the
// confirmed create-IG stall ("it switched to IG, opened the add-account popup,
// then nothing happened"). server.exe is frozen, so the fix lives here.
//
// Two independent signals, both required:
//   1. SILENCE — no inbound app message AND no local command in flight. Free.
//      Every device touch is a `command` the DESKTOP executes, so a 360s
//      push_to_profile, _recoverNetwork's deliberate 10-40s radio drop,
//      guardedSwitchUser's ~25s ladder and the ~74s executeADB device-unavailable
//      recovery chain are all in flight LOCALLY and structurally cannot register
//      as silence.
//   2. PROBE — one host-level `adb devices`, issued ONLY during silence, so a
//      healthy run adds exactly ZERO adb calls.
// A single failed adb probe means nothing (established v3.6.1-v3.6.4), so the
// probe must miss repeatedly AND across a sustained wall-clock window, and any
// reading taken while the adb layer is itself unhealthy is frozen, not counted.
const DEVICE_LIVENESS = {
    // Fire threshold for silence. Same value as HEARTBEAT_STALE_MS (introduces no
    // looser constant) and 8x the brain's worst legitimate cadence — the 180s SMS
    // wait is chunked 12x15s with a send_progress between chunks.
    RUN_SILENT_MS: 120_000,
    // Probing does not begin until silence reaches this → a healthy run is free.
    PROBE_START_SILENCE_MS: 60_000,
    // == RELAUNCH_MIN_GAP_MS in device-watchdog: the codebase's "do not re-poke a
    // transport faster than this".
    PROBE_CADENCE_MS: 15_000,
    PROBE_TIMEOUT_MS: 4_000,
    // Deliberately 2x more conservative than the watchdog's own 2/2 shell probe:
    // a false abort here hits a PAID account creation.
    MISS_STREAK: 4,
    MISS_SPAN_MS: 60_000,
    // A tailnet ip:port serial does not re-enumerate after `adb kill-server`
    // without an explicit `adb connect`, so misses inside this window of a
    // watchdog adb-server restart are inconclusive — otherwise restart makes the
    // serial vanish, the run aborts, the busy lock clears, and the watchdog
    // restarts again.
    ADB_RESTART_GRACE_MS: 20_000,
    WATCHDOG_AGREE_MS: 30_000,
    // Hard bound on the post-abort module-run-mutex quarantine. Unconditional and
    // unref'd, so it cannot strand a phone (the v3.6.0/v3.6.1 lesson).
    QUARANTINE_MS: 120_000,
}

// adb-LAYER refusals: the command never reached a device, so it says nothing
// about the phone. Mirrors the error strings adb-util's process manager emits.
const ADB_LAYER_ERROR_RE = /ADB circuit is open|ADB queue is full|ADB process capacity is full|ADB process manager is (?:shut down|shutting down)/i

function parseAdbDevicesRows(stdout) {
    const rows = []
    for (const line of String(stdout || '').split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/)
        if (!parts[0] || !parts[1]) continue
        rows.push({ serial: parts[0], state: parts[1] })
    }
    return rows
}

// Transport-tolerant presence test. A run's deviceId can legitimately change
// transport mid-flight, so an exact-serial-only match would false-abort:
//   - Companion rediscovery rewrites `ip:oldPort` -> `ip:newPort` in place, so
//     ANY live port on the same tailnet IP proves the phone is there.
//   - Reads may already be routed to the phone's USB twin.
function adbRowsShowDevice(rows, deviceId, usbTwinSerial = null) {
    const target = String(deviceId || '')
    if (!target) return false
    const live = new Set((rows || []).filter(row => row.state === 'device').map(row => row.serial))
    if (live.has(target)) return true
    if (usbTwinSerial && live.has(String(usbTwinSerial))) return true
    if (TAILNET_SERIAL_RE.test(target)) {
        const ip = target.split(':')[0]
        for (const serial of live) if (serial.startsWith(`${ip}:`)) return true
    }
    return false
}

// 'alive' | 'inconclusive' | 'miss'. 'inconclusive' FREEZES the streak — neither
// incremented nor reset — so a blackout in the adb layer can neither trigger an
// abort nor silently forgive a genuinely dead phone.
function classifyDeviceLivenessProbe({
    result,
    deviceId,
    usbTwinSerial = null,
    adbWedged = false,
    adbServerRestartAt = 0,
    watchdogSeenAt = 0,
    now = Date.now(),
}) {
    const errText = String((result && (result.error || result.stderr)) || '')
    if (!result || result.timedOut === true || result.code !== 0 || ADB_LAYER_ERROR_RE.test(errText)) {
        return 'inconclusive'
    }
    if (adbRowsShowDevice(parseAdbDevicesRows(result.stdout), deviceId, usbTwinSerial)) return 'alive'
    if (adbWedged) return 'inconclusive'
    if (adbServerRestartAt > 0 && now - adbServerRestartAt < DEVICE_LIVENESS.ADB_RESTART_GRACE_MS) return 'inconclusive'
    // Watchdog VETO only, never a trigger: if its own intent still sees this phone
    // as a live device, our miss is not corroborated. Headless runs have no intent
    // and so simply get no veto.
    if (watchdogSeenAt > 0 && now - watchdogSeenAt < DEVICE_LIVENESS.WATCHDOG_AGREE_MS) return 'inconclusive'
    return 'miss'
}

function applyDeviceLivenessVerdict(state, verdict, now = Date.now()) {
    if (verdict === 'alive') {
        state.missStreak = 0
        state.firstMissAt = 0
        return state
    }
    if (verdict === 'inconclusive') return state
    state.missStreak += 1
    if (!state.firstMissAt) state.firstMissAt = now
    return state
}

function shouldAbortForDeviceLoss(state, now = Date.now()) {
    if ((state.commandsInFlight || 0) > 0) return false
    if (now - state.lastAppMessageAt < DEVICE_LIVENESS.RUN_SILENT_MS) return false
    if ((state.missStreak || 0) < DEVICE_LIVENESS.MISS_STREAK) return false
    if (!state.firstMissAt || now - state.firstMissAt < DEVICE_LIVENESS.MISS_SPAN_MS) return false
    return true
}

function textGraphemes(value) {
    const text = String(value ?? '')
    if (typeof Intl.Segmenter !== 'function') return Array.from(text)
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), segment => segment.segment)
}

function planHumanTextInput(value, random = Math.random) {
    const graphemes = textGraphemes(value)
    if (graphemes.length === 0) {
        return { chunks: [], delays_ms: [], total_delay_ms: 0 }
    }

    const desiredChunks = Math.min(
        MAX_HUMAN_TEXT_INJECTIONS,
        Math.max(1, Math.ceil(graphemes.length / TARGET_GRAPHEMES_PER_HUMAN_INJECTION)),
    )
    const graphemesPerChunk = Math.ceil(graphemes.length / desiredChunks)
    const chunks = []
    for (let index = 0; index < graphemes.length; index += graphemesPerChunk) {
        chunks.push(graphemes.slice(index, index + graphemesPerChunk).join(''))
    }

    const delays = chunks.slice(0, -1).map(chunk => {
        const last = chunk.at(-1) || ''
        const base = 55 + Math.floor(Math.max(0, Math.min(1, random())) * 71)
        if (/[.!?,;:]$/.test(last)) return base + 80
        if (/\s$/.test(last)) return base + 25
        return base
    })
    const rawTotal = delays.reduce((total, delay) => total + delay, 0)
    const scale = rawTotal > MAX_HUMAN_TEXT_DELAY_MS
        ? MAX_HUMAN_TEXT_DELAY_MS / rawTotal
        : 1
    const delaysMs = delays.map(delay => Math.max(1, Math.floor(delay * scale)))

    return {
        chunks,
        delays_ms: delaysMs,
        total_delay_ms: delaysMs.reduce((total, delay) => total + delay, 0),
    }
}

function redactCommandParams(_action, params = {}) {
    return Object.fromEntries(Object.entries(params).map(([key, value]) => {
        if (!REDACTED_COMMAND_FIELDS.has(key.toLowerCase()) || value == null) return [key, value]
        return [key, `[REDACTED length=${String(value).length}]`]
    }))
}

/**
 * Resolve a relative content folder path against both content systems.
 * Primary: CONTENT_ROOT (install dir/Content/) â€” where installer & ensureContentFolders create dirs
 * Fallback: ~/ShadowPhone/ â€” legacy create-content-folders IPC system
 *
 * Checks for actual media files (not just empty dirs created by ensureContentFolders).
 * Also tries legacy path mapping: Instagram -> content/instagram, reels -> videos.
 *
 * Returns the resolved string path (backward compatible). Callers that need to
 * surface a useful error when no media is found should call
 * resolveContentFolderDetailed() instead â€” it returns { path, attempted, foundMedia }.
 */
function resolveContentFolderDetailed(relativePath) {
    // Headless / VPS: no Electron available, and an explicit content root can be
    // supplied via SP_CONTENT_ROOT (the device-agent runs outside the app).
    let app = null
    try { ({ app } = require('electron')) } catch (_) { /* not in Electron context */ }
    const _spContentBase = process.env.SP_CONTENT_ROOT
        || (app ? path.join(app.getPath('userData'), 'Content') : null)

    // Guard 1: Already an absolute path â€” use it directly (DB now stores full paths)
    if (path.isAbsolute(relativePath)) {
        console.log(`[Content] Path is already absolute: ${relativePath}`)
        return { path: relativePath, attempted: [relativePath], foundMedia: fs.existsSync(relativePath) }
    }

    // Guard 2: Embedded absolute path (e.g. "Instagram/C:\...\reels" from server prepending platform)
    const absMatch = relativePath.match(/([A-Za-z]:\\)/)
    if (absMatch) {
        const extractedPath = relativePath.substring(absMatch.index)
        console.log(`[Content] Extracted embedded absolute path: "${relativePath}" â†’ "${extractedPath}"`)
        return { path: extractedPath, attempted: [extractedPath], foundMedia: fs.existsSync(extractedPath) }
    }

    // Primary: SP_CONTENT_ROOT (headless) or userData (%APPDATA%/shadowphone-desktop/Content)
    const contentRoot = path.join(_spContentBase || os.tmpdir(), relativePath)

    // Fallback: old install-dir content (for users who haven't migrated yet)
    const installDirContent = app ? path.join(path.dirname(app.getPath('exe')), 'Content', relativePath) : contentRoot

    // Build legacy path: map CONTENT_ROOT naming â†’ legacy naming
    const legacyRelative = relativePath
        .replace(/^Instagram\//i, 'content/instagram/')
        .replace(/\/reels$/i, '/videos')
    const legacyPath = path.join(os.homedir(), 'ShadowPhone', legacyRelative)
    // Also try the exact relative path against legacy base (for custom content_folder values)
    const legacyExact = path.join(os.homedir(), 'ShadowPhone', relativePath)

    const attempted = [contentRoot, installDirContent, legacyPath]
    if (legacyExact !== legacyPath) attempted.push(legacyExact)

    const hasMediaFiles = (dir) => {
        try {
            if (!fs.existsSync(dir)) return false
            // Check root level
            if (fs.readdirSync(dir).some(f => /\.(jpg|jpeg|png|mp4|mov|webp)$/i.test(f))) return true
            // Also check common subdirectories.
            for (const sub of ['images', 'videos', 'reels', 'stories']) {
                const subDir = path.join(dir, sub)
                try {
                    if (fs.existsSync(subDir) && fs.readdirSync(subDir).some(f => /\.(jpg|jpeg|png|mp4|mov|webp)$/i.test(f))) return true
                } catch { /* skip */ }
            }
            return false
        } catch { return false }
    }

    // 1. CONTENT_ROOT (userData) has files â†’ use it (primary, update-safe)
    if (hasMediaFiles(contentRoot)) {
        console.log(`[Content] Resolved (userData): ${relativePath} â†’ ${contentRoot}`)
        return { path: contentRoot, attempted, foundMedia: true }
    }
    // 2. Old install-dir content has files â†’ use it (pre-migration fallback)
    if (hasMediaFiles(installDirContent)) {
        console.log(`[Content] Resolved (install-dir fallback): ${relativePath} â†’ ${installDirContent}`)
        return { path: installDirContent, attempted, foundMedia: true }
    }
    // 3. Legacy mapped path has files â†’ use it
    if (hasMediaFiles(legacyPath)) {
        console.log(`[Content] Resolved (legacy mapped): ${relativePath} â†’ ${legacyPath}`)
        return { path: legacyPath, attempted, foundMedia: true }
    }
    // 4. Legacy exact path has files â†’ use it
    if (legacyExact !== legacyPath && hasMediaFiles(legacyExact)) {
        console.log(`[Content] Resolved (legacy exact): ${relativePath} â†’ ${legacyExact}`)
        return { path: legacyExact, attempted, foundMedia: true }
    }
    // 5. No files anywhere â€” log all checked paths so the user knows where to put content
    console.log(`[Content] No media files found for "${relativePath}". Checked:`)
    console.log(`  1. userData: ${contentRoot} (${fs.existsSync(contentRoot) ? 'exists, empty' : 'does not exist'})`)
    console.log(`  2. Install dir: ${installDirContent} (${fs.existsSync(installDirContent) ? 'exists, empty' : 'does not exist'})`)
    console.log(`  3. Legacy mapped: ${legacyPath} (${fs.existsSync(legacyPath) ? 'exists, empty' : 'does not exist'})`)
    if (legacyExact !== legacyPath) {
        console.log(`  4. Legacy exact: ${legacyExact} (${fs.existsSync(legacyExact) ? 'exists, empty' : 'does not exist'})`)
    }
    console.log(`  Defaulting to userData: ${contentRoot}`)
    return { path: contentRoot, attempted, foundMedia: false }
}

function resolveContentFolder(relativePath) {
    return resolveContentFolderDetailed(relativePath).path
}

/**
 * Given a tailnet deviceId (e.g. "100.x.y.z:5555") and the current merged
 * device list (from getConnectedDevices / mergeByHwSerial), return the USB-twin
 * serial for the same physical phone — or null if no safe match exists.
 *
 * Returns null in ALL uncertain cases:
 *   - deviceId is already a USB serial (no routing needed)
 *   - device list is absent or empty
 *   - no record in the list matches this tailnet IP
 *   - matched record has no hwSerial (merge was incomplete)
 *   - no USB entry exists for that hwSerial
 *   - more than one USB entry matches (ambiguous fleet)
 *
 * Pure: never throws, never mutates input.
 */
function resolveUsbTwin(tailnetDeviceId, liveDevices) {
    if (!tailnetDeviceId || !TAILNET_SERIAL_RE.test(tailnetDeviceId)) return null
    if (!liveDevices || liveDevices.length === 0) return null

    const [ip] = String(tailnetDeviceId).split(':')

    const owner = liveDevices.find(d => {
        if (d.tailnetIp === ip) return true
        if (classifyTransport(d.serial) === 'tcp') {
            const [dIp] = String(d.serial).split(':')
            return dIp === ip
        }
        return false
    })
    if (!owner) return null
    if (!owner.hwSerial) return null

    const usbCandidates = liveDevices.filter(
        d => d.hwSerial === owner.hwSerial && classifyTransport(d.serial) === 'usb'
    )
    if (usbCandidates.length !== 1) return null

    return usbCandidates[0].serial
}

function parseValidatedWifiAgent(connectivityDump) {
    const blocks = String(connectivityDump || '').split(/(?=NetworkAgentInfo\{)/)
    const wifiBlock = blocks.find(block => (
        /\bni\{WIFI\s+CONNECTED\b/i.test(block)
        && /\bInterfaceName:\s*wlan0\b/i.test(block)
    ))
    if (!wifiBlock) {
        return {
            valid: false,
            wifi_connected: false,
            wifi_validated: false,
            reason: 'wifi_network_agent_missing',
        }
    }

    // Only inspect the NetworkAgentInfo header. Request records later in the
    // block also contain INTERNET/VALIDATED and must not make an unvalidated
    // Wi-Fi agent look healthy.
    const headerEnd = wifiBlock.indexOf('factorySerialNumber=')
    const agentHeader = headerEnd >= 0 ? wifiBlock.slice(0, headerEnd) : wifiBlock
    const capabilities = agentHeader.match(/\bCapabilities:\s*([A-Z0-9_&|]+)/i)?.[1] || ''
    const capabilitySet = new Set(capabilities.toUpperCase().split(/[&|]/).filter(Boolean))
    const hasInternet = capabilitySet.has('INTERNET')
    const isValidated = capabilitySet.has('VALIDATED')
    return {
        valid: hasInternet && isValidated,
        wifi_connected: true,
        wifi_validated: isValidated,
        has_internet: hasInternet,
        reason: !hasInternet
            ? 'wifi_internet_capability_missing'
            : (!isValidated ? 'wifi_not_validated' : 'wifi_validated'),
    }
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm'])
const CONTENT_FOLDERS = {
    image: ['images'],
    reel: ['reels', 'videos', 'trial_reels'],
    story: ['stories'],
    media: ['images', 'reels', 'videos', 'trial_reels', 'stories'],
}
const POST_CONTENT_TYPES = {
    post_feed: 'image',
    post_reel: 'reel',
    post_trial_reel: 'reel',
    post_story: 'story',
}
const EXPLICIT_RETRY_PROOF_MODULES = new Set([
    'post_feed',
    'post_reel',
    'post_story',
    'post_trial_reel',
])
const MAX_PENDING_TRANSFERS = 64
const MAX_PUBLISHED_SOURCE_KEYS = 4096
const pendingTransfers = new Map()
const plannerMintedTransfers = new WeakSet()
const profileStorageFailures = new WeakMap()
const OWNER_DOCUMENT_METHOD = 'owner_document_share'
const OWNER_FEED_COMPONENT = 'com.instagram.android/com.instagram.share.handleractivity.ShareHandlerActivity'
const publishedSourceKeys = new Set()
const UNBOUND_ACCOUNT_IDENTITIES = new Set([
    'unknown',
    'quick_upload',
    'n/a',
    'na',
    'none',
    'null',
    'undefined',
])

function rememberPublishedSourceKey(identity) {
    const key = String(identity || '').trim()
    if (!key) return publishedSourceKeys.size
    if (publishedSourceKeys.has(key)) publishedSourceKeys.delete(key)
    publishedSourceKeys.add(key)
    while (publishedSourceKeys.size > MAX_PUBLISHED_SOURCE_KEYS) {
        publishedSourceKeys.delete(publishedSourceKeys.values().next().value)
    }
    return publishedSourceKeys.size
}

function publishedSourceCacheSize() {
    return publishedSourceKeys.size
}

function normalizeTransferContentType(value) {
    const normalized = String(value || 'media').trim().toLowerCase()
    if (['image', 'images', 'feed', 'photo', 'post'].includes(normalized)) return 'image'
    if (['reel', 'reels', 'video', 'videos', 'trial_reel', 'trial-reel'].includes(normalized)) return 'reel'
    if (['story', 'stories'].includes(normalized)) return 'story'
    return 'media'
}

function normalizeInstagramAccountUsername(value) {
    const username = String(value ?? '').trim().replace(/^@+/, '').toLowerCase()
    if (!username || UNBOUND_ACCOUNT_IDENTITIES.has(username)) return ''
    return /^[a-z0-9._]{1,30}$/.test(username) ? username : ''
}

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        const input = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
        input.on('data', chunk => hash.update(chunk))
        input.on('error', reject)
        input.on('end', () => resolve(hash.digest('hex')))
    })
}

async function verifyLocalManifestEntry(entry) {
    if (!entry || !entry.source_path) throw new Error('A manifest source is required for local verification')
    const before = await fs.promises.stat(entry.source_path)
    const sha256 = await hashFile(entry.source_path)
    const after = await fs.promises.stat(entry.source_path)
    if (!before.isFile() || !after.isFile()) {
        throw new Error(`Manifest source is not a file: ${entry.source_path}`)
    }
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`Local source changed while being verified: ${entry.source_path}`)
    }
    if (after.size !== entry.size_bytes || sha256 !== entry.sha256) {
        throw new Error(`Local source changed after planning: ${entry.source_path}`)
    }
    return Object.freeze({ size_bytes: after.size, sha256 })
}

function parseRemoteSize(output, label) {
    const match = String(output || '').trim().match(/^(\d+)$/)
    if (!match) throw new Error(`Remote size verification returned no exact byte count for ${label}`)
    return Number(match[1])
}

function parseRemoteSha256(output, label) {
    const match = String(output || '').trim().match(/^([a-f0-9]{64})(?:\s|$)/i)
    if (!match) throw new Error(`Remote SHA-256 verification returned no digest for ${label}`)
    return match[1].toLowerCase()
}

async function verifyAdbRemoteEntry(execute, entry) {
    const remoteSize = parseRemoteSize(
        await execute(['shell', 'stat', '-c', '%s', entry.phone_destination]),
        entry.remote_filename,
    )
    if (remoteSize !== entry.size_bytes) {
        throw new Error(`Remote size mismatch for ${entry.remote_filename}: expected ${entry.size_bytes}, received ${remoteSize}`)
    }
    const remoteSha256 = parseRemoteSha256(
        await execute(['shell', 'sha256sum', entry.phone_destination]),
        entry.remote_filename,
    )
    if (remoteSha256 !== entry.sha256) {
        throw new Error(`Remote SHA-256 mismatch for ${entry.remote_filename}`)
    }
    return Object.freeze({ size_bytes: remoteSize, sha256: remoteSha256 })
}

function quoteAndroidShellValue(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`
}

function sqlStringValue(value) {
    return String(value).replace(/'/g, "''")
}

// ── Profile MediaStore resolution ────────────────────────────────────
// 2026-07-26, @a.mroczkowska1996 / Android profile 19: every secondary-profile
// push failed with "Could not resolve one exact MediaStore item". Two defects,
// both introduced when this strict verifier replaced the old name-only check:
//  1. MediaProvider prints the literal `_size=NULL` for a freshly finalized
//     Chromium download until it scans it. The old `_size=(\d+)` capture
//     dropped that row and reported it as "the file does not exist".
//  2. The row was only ever looked for in the one collection the extension
//     implies, and ONE opaque message covered six different states — which is
//     why four investigations were needed to explain one failure.
// RESOLUTION is widened and every state is now named. ACCEPTANCE is unchanged:
// the exact row is still streamed through its content URI and compared byte for
// byte on size and SHA-256.
const MEDIA_STORE_COLLECTIONS = Object.freeze({
    images: 'content://media/external/images/media',
    video: 'content://media/external/video/media',
    downloads: 'content://media/external/downloads',
    files: 'content://media/external/file',
})
// Causes a later poll can still resolve on its own (or that a rescan fixes).
// Everything else is terminal so the caller stops burning its per-file budget
// on a state that cannot heal.
// `name_drift` is retryable ON PURPOSE. The drift probe runs on EVERY poll and
// cannot tell "Chromium uniquified the saved name" from "an earlier run's
// same-sha row is still on the phone while THIS download is still in flight" —
// the two produce the identical row. Poll #1 fires ~400ms after the Download
// tap, so on a large .mov (the operator's reels) the exact row cannot exist yet
// and a terminal verdict there failed the file before it could possibly be
// indexed. It stays retryable and only survives as the reported cause when the
// wall-clock budget expires with it still true.
const RETRYABLE_MEDIA_CAUSES = new Set([
    'not_indexed',
    'name_drift',
    'size_pending',
    'wrong_collection',
    'size_mismatch',
    'query_failed',
])
// A `#` would open a shell comment, so the section marker must not use one.
const MEDIA_QUERY_MARKER = 'SPCOLL::'
const MEDIA_DRIFT_SECTION = 'drift'
const MEDIA_STAT_MARKER = 'SPSTAT::'

function mediaVerificationError(causeCode, detail, diagnostics = {}) {
    const error = new Error(`[cause=${causeCode}] ${detail}`)
    error.cause_code = causeCode
    error.retryable = RETRYABLE_MEDIA_CAUSES.has(causeCode)
    error.diagnostics = diagnostics
    return error
}

function detectProfileStorageFailure(output, { targetUser, startedAt }) {
    if (!Number.isFinite(startedAt) || startedAt <= 0 || !/^\d+$/.test(String(targetUser))) return null
    for (const line of String(output || '').split(/\r?\n/)) {
        const match = line.match(/^[ \t]*(\d+\.\d+)\s+\d+\s+\d+\s+E\s+MediaProvider\s*:\s+Xattr:user\.extdbnextrowid(\d+) not found on external storage: android\.system\.ErrnoException: getxattr failed: ENODATA\b/)
        if (!match || Number(match[1]) <= startedAt || match[2] !== String(targetUser)) continue
        const error = mediaVerificationError(
            'profile_storage_unavailable',
            `Android profile ${targetUser} storage cannot save media because its media database is unavailable. Use another working profile or resolve this profile's storage before retrying. The local source was preserved.`,
        )
        profileStorageFailures.set(error, String(targetUser))
        return error
    }
    return null
}

// `content query` reports provider/permission/invalid-token failures on stderr
// with exit code 0, and _runAdbProcess returns stdout only — so a broken query
// is indistinguishable from an empty result unless the caller hands us both.
function normalizeExecOutput(result) {
    if (result && typeof result === 'object') {
        return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
    }
    return { stdout: String(result ?? ''), stderr: '' }
}

function mediaRowField(line, column) {
    return line.match(new RegExp(`(?:^|[,\\s])${column}=([^,]*)`))?.[1]?.trim()
}

function parseMediaStoreRows(text) {
    return String(text || '')
        .split(/\r?\n/)
        .filter(line => /(?:^|[,\s])_id=\d+/.test(line))
        .map(line => {
            const size = mediaRowField(line, '_size')
            return {
                id: mediaRowField(line, '_id'),
                display_name: mediaRowField(line, '_display_name') || '',
                // `_size=NULL` means "not scanned yet", never "not there".
                size: /^\d+$/.test(size || '') ? Number(size) : null,
                relative_path: mediaRowField(line, 'relative_path') || '',
                mime_type: mediaRowField(line, 'mime_type') || '',
                media_type: mediaRowField(line, 'media_type') || '',
            }
        })
}

function mediaQuerySegment(profile, uri, where, section = uri) {
    // media_type exists only on content://media/external/file; asking the
    // images/video views for it fails the whole query with "Invalid column".
    const projection = uri === MEDIA_STORE_COLLECTIONS.files
        ? '_id:_display_name:_size:relative_path:mime_type:media_type'
        : '_id:_display_name:_size:relative_path'
    return `echo ${MEDIA_QUERY_MARKER}${section}; content query --user ${profile} --uri ${uri}`
        + ` --projection ${projection} --where ${quoteAndroidShellValue(where)}`
}

function splitMediaQuerySections(text, sections) {
    const output = new Map(sections.map(section => [section, '']))
    // Single-segment callers emit no marker, so everything belongs to the first
    // (primary) section until a marker says otherwise.
    let current = sections[0]
    for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.startsWith(MEDIA_QUERY_MARKER)) {
            current = trimmed.slice(MEDIA_QUERY_MARKER.length).trim()
            continue
        }
        if (!output.has(current)) continue
        output.set(current, `${output.get(current)}${line}\n`)
    }
    return output
}

function manifestRelativeDir(entry) {
    const destination = String(entry?.phone_destination || '').replace(/\\/g, '/')
    const directory = destination.slice(0, destination.lastIndexOf('/') + 1)
    return directory.match(/^\/(?:storage\/emulated\/\d+|sdcard)\/(.*)$/)?.[1] || ''
}

function sameRelativeDir(left, right) {
    const normalize = value => String(value || '').replace(/^\/+|\/+$/g, '').toLowerCase()
    return normalize(left) === normalize(right)
}

async function verifyProfileMediaEntry(execute, { targetUser, entry, queryExecute } = {}) {
    const profile = String(targetUser || '').trim()
    if (!/^\d+$/.test(profile)) throw new Error('A numeric Android profile is required for MediaStore verification')
    if (!entry?.remote_filename) throw new Error('A manifest item is required for MediaStore verification')
    const runQuery = queryExecute || execute
    const isVideo = VIDEO_EXTENSIONS.has(path.extname(entry.remote_filename).toLowerCase())
    const primaryUri = isVideo ? MEDIA_STORE_COLLECTIONS.video : MEDIA_STORE_COLLECTIONS.images
    // The extension's own collection first, then the two views a download that
    // MediaProvider has not classified yet actually shows up in.
    const searchUris = [primaryUri, MEDIA_STORE_COLLECTIONS.downloads, MEDIA_STORE_COLLECTIONS.files]
    const where = `_display_name='${sqlStringValue(entry.remote_filename)}'`
    const segments = searchUris.map(uri => mediaQuerySegment(profile, uri, where))
    // Folded into the SAME adb round trip (a live `content query` costs ~2.3s of
    // transport, the extra on-device query costs ~0.2s) so a name Chromium
    // uniquified to " (1).mov" is named on the first poll instead of after the
    // whole per-file budget. Every minted name carries the content sha256.
    const driftWhere = /^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))
        ? `_display_name LIKE 'sp_${sqlStringValue(entry.sha256)}_%'`
        : null
    if (driftWhere) {
        segments.push(mediaQuerySegment(profile, MEDIA_STORE_COLLECTIONS.files, driftWhere, MEDIA_DRIFT_SECTION))
    }
    // Trailing `:` so the script always exits 0: an empty `content query` exits
    // non-zero on some Android builds, and a throw would cost us both the stderr
    // that names a provider failure and the cause code the caller logs.
    const query = `${segments.join('; ')}; :`
    const queried = normalizeExecOutput(await runQuery(['shell', query]))
    const sections = splitMediaQuerySections(queried.stdout, [...searchUris, MEDIA_DRIFT_SECTION])
    const diagnostics = {
        query,
        primary_uri: primaryUri,
        stdout: queried.stdout,
        stderr: queried.stderr,
        rows: [],
    }

    let matches = []
    let matchedUri = null
    const otherNames = new Set()
    for (const uri of searchUris) {
        const rows = parseMediaStoreRows(sections.get(uri))
        for (const row of rows) {
            diagnostics.rows.push({ ...row, collection_uri: uri })
            if (row.display_name !== entry.remote_filename) otherNames.add(row.display_name)
        }
        const exact = rows.filter(row => row.display_name === entry.remote_filename)
        if (exact.length) {
            matches = exact
            matchedUri = uri
            break
        }
    }

    if (!matches.length) {
        const queryFailure = queried.stderr.trim()
        if (queryFailure && !/no result found/i.test(queryFailure)) {
            throw mediaVerificationError(
                'query_failed',
                `profile ${profile} MediaStore query for ${entry.remote_filename} failed: ${queryFailure.slice(0, 300)}`,
                diagnostics,
            )
        }
        const drifted = parseMediaStoreRows(sections.get(MEDIA_DRIFT_SECTION))
            .map(row => row.display_name)
            .filter(name => name && name !== entry.remote_filename)
        if (drifted.length) {
            throw mediaVerificationError(
                'name_drift',
                `profile ${profile} saved ${entry.remote_filename} under a different name: ${drifted.join(', ')}`,
                diagnostics,
            )
        }
        throw mediaVerificationError(
            'not_indexed',
            `could not resolve one exact MediaStore item with _id and _size for ${entry.remote_filename}`
            + ` in profile ${profile} (searched ${searchUris.join(', ')}`
            + `${otherNames.size ? `; other names present: ${[...otherNames].join(', ')}` : ''})`,
            diagnostics,
        )
    }

    if (matches.length > 1) {
        // Prefer the row that sits where the manifest put the file. Preferring
        // then verifying is safe: a wrong pick still cannot pass SHA-256.
        const expectedDir = manifestRelativeDir(entry)
        const preferred = expectedDir
            ? matches.filter(row => sameRelativeDir(row.relative_path, expectedDir))
            : []
        if (preferred.length !== 1) {
            throw mediaVerificationError(
                'duplicate_rows',
                `profile ${profile} has ${matches.length} MediaStore rows named ${entry.remote_filename} in ${matchedUri}: `
                + matches.map(row => `_id=${row.id} relative_path=${row.relative_path || 'NULL'}`).join(', '),
                diagnostics,
            )
        }
        matches = preferred
    }

    const item = matches[0]
    diagnostics.media_id = item.id
    diagnostics.matched_uri = matchedUri
    if (item.size === null) {
        throw mediaVerificationError(
            'size_pending',
            `profile ${profile} MediaStore row _id=${item.id} for ${entry.remote_filename} in ${matchedUri}`
            + ' still reports _size=NULL — MediaProvider has not scanned the finished download yet',
            diagnostics,
        )
    }
    if (item.size !== entry.size_bytes) {
        throw mediaVerificationError(
            'size_mismatch',
            `Remote MediaStore size mismatch for ${entry.remote_filename} (_id=${item.id}): expected ${entry.size_bytes}, received ${item.size}`,
            diagnostics,
        )
    }
    const contentUri = `${matchedUri}/${item.id}`
    const streamedSize = parseRemoteSize(
        await execute(['shell', `content read --user ${profile} --uri ${contentUri} | wc -c`]),
        entry.remote_filename,
    )
    if (streamedSize !== entry.size_bytes) {
        throw mediaVerificationError(
            'size_mismatch',
            `Remote content URI size mismatch for ${entry.remote_filename}: expected ${entry.size_bytes}, received ${streamedSize}`,
            diagnostics,
        )
    }
    const remoteSha256 = parseRemoteSha256(
        await execute(['shell', `content read --user ${profile} --uri ${contentUri} | sha256sum`]),
        entry.remote_filename,
    )
    if (remoteSha256 !== entry.sha256) {
        throw mediaVerificationError(
            'sha_mismatch',
            `Remote MediaStore SHA-256 mismatch for ${entry.remote_filename} (_id=${item.id} in ${matchedUri})`,
            diagnostics,
        )
    }
    // Byte-exact — but Instagram's picker and the brain's posting guard read the
    // extension's own collection, so a row still sitting in downloads/file is
    // not usable yet. A rescan is what promotes it, hence retryable.
    if (matchedUri !== primaryUri) {
        throw mediaVerificationError(
            'wrong_collection',
            `${entry.remote_filename} is indexed in ${matchedUri} (mime_type=${item.mime_type || 'unknown'},`
            + ` media_type=${item.media_type || 'unknown'}) instead of ${primaryUri} for profile ${profile}`,
            diagnostics,
        )
    }
    return Object.freeze({
        content_uri: contentUri,
        size_bytes: streamedSize,
        sha256: remoteSha256,
        collection_uri: matchedUri,
        media_id: item.id,
    })
}

// Forces the scan that populates `_size` (and promotes an unclassified download
// into the images/video view) instead of hoping MediaProvider gets to it inside
// the poll budget. `content call --method scan_file` is synchronous, honours
// --user and returns the resulting content URI. It replaces the two
// MEDIA_SCANNER_SCAN_FILE directory broadcasts that used to fire AFTER the whole
// file loop — too late to help any verification, and one of them aimed at
// ShadowPhone/content/, which is not even where Vanadium lands downloads.
// `stat` is diagnostic only (it cannot read another user's storage as shell) and
// never an assertion: it separates "never downloaded" from "not indexed".
async function scanProfileMediaFile(execute, { targetUser, phoneDestination }) {
    const quoted = quoteAndroidShellValue(phoneDestination)
    const output = normalizeExecOutput(await execute(['shell',
        `content call --user ${targetUser} --uri content://media --method scan_file --arg ${quoted}`
        + `; echo ${MEDIA_STAT_MARKER}; stat -c %s ${quoted} 2>/dev/null || true`,
    ])).stdout
    const [scanText = '', statText = ''] = String(output).split(MEDIA_STAT_MARKER)
    const onDiskSize = statText.trim().match(/(\d+)/)?.[1]
    return {
        scanned_uri: scanText.match(/content:\/\/[^\s\]}]+/)?.[0] || null,
        on_disk_size: onDiskSize === undefined ? null : Number(onDiskSize),
    }
}

// Serves one planned manifest entry per ASCII-safe index URL (/0, /1, ...) so
// Vanadium can fetch files with Unicode names. Hoisted out of the
// push_to_profile case so the phone-facing response headers are testable.
function createManifestHttpServer(indexToFile) {
    return http.createServer((req, res) => {
        const key = decodeURIComponent(String(req.url || '').replace(/^\//, ''))
        const entry = indexToFile.get(key)
        if (!entry || !fs.existsSync(entry.source_path)) {
            res.writeHead(404)
            res.end('Not found')
            return
        }
        const stat = fs.statSync(entry.source_path)
        res.writeHead(200, {
            // Chromium files the download under the Content-Type we serve and
            // MediaProvider keeps that mime on the row, so octet-stream left
            // every .mov row mislabeled for the brain's video posting guard.
            // Content-Disposition stays: it is what forces the download prompt
            // the blind Download tap depends on.
            'Content-Type': mediaMimeType(entry.remote_filename),
            'Content-Disposition': `attachment; filename="${entry.remote_filename}"`,
            'Content-Length': stat.size,
        })
        fs.createReadStream(entry.source_path).pipe(res)
    })
}

function joinPhonePath(folder, filename) {
    return `${String(folder || '').replace(/\\/g, '/').replace(/\/$/, '')}/${filename}`
}

function publishedSourceIdentity(sourcePath, sha256) {
    const resolved = path.resolve(sourcePath).replace(/\\/g, '/')
    const normalizedPath = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    return createHash('sha256').update(`${normalizedPath}\n${sha256}`).digest('hex')
}

function contentStateRoot() {
    let stateRoot = path.join(os.homedir(), 'ShadowPhone')
    try {
        const { app } = require('electron')
        if (app?.getPath) stateRoot = app.getPath('userData')
    } catch { /* headless runtime */ }
    if (process.env.SP_CONTENT_ROOT) stateRoot = path.dirname(path.resolve(process.env.SP_CONTENT_ROOT))
    return stateRoot
}

function canStageOwnerDocument(plan, params, failure) {
    const entry = plan?.manifest?.[0]
    return plannerMintedTransfers.has(plan)
        && params?.allow_owner_profile_staging === true
        && params.manual_transfer_only !== true
        && Number(params.max_files) === 1
        && plan.manifest.length === 1
        && plan.content_type === 'image'
        && /^[1-9]\d*$/.test(plan.phone_profile)
        && Boolean(normalizeInstagramAccountUsername(plan.account_username))
        && Boolean(plan.device_id)
        && entry?.remote_filename.endsWith('.png')
        && profileStorageFailures.get(failure) === plan.phone_profile
}

function ownerStagingDirectory(entry) {
    const identity = createHash('sha256').update([
        entry.device_id, entry.account_username, entry.sha256, entry.transfer_id,
    ].join('\n')).digest('hex')
    return path.join(contentStateRoot(), 'owner-document-staging-v1', identity)
}

function readOwnerRecord(filePath) {
    if (fs.statSync(filePath).size > 16384) throw new Error('Owner staging record is oversized')
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function validateOwnerRecordBinding(record, intent, phase) {
    if (record.version !== 1 || record.method !== OWNER_DOCUMENT_METHOD || record.phase !== phase
        || !Number.isFinite(Date.parse(record.recorded_at))
        || ['transfer_id', 'device_id', 'account_username', 'source_profile', 'phone_profile', 'source_path', 'remote_filename', 'sha256', 'size_bytes']
            .some(key => record[key] !== intent[key])) {
        throw new Error(`Owner ${phase} record does not match its staging intent`)
    }
    return record
}

function ownerEditorIsClosed(xml, accountUsername = null) {
    if (typeof xml !== 'string' || xml.length > 2 * 1024 * 1024 || !/<hierarchy\b/.test(xml) || !/<\/hierarchy>\s*$/.test(xml)) return false
    const stack = []
    const selectedTabs = new Set()
    const visibleNodes = []
    for (const match of xml.matchAll(/<\/?node\b[^>]*>/g)) {
        const token = match[0]
        if (token.startsWith('</')) {
            if (!stack.length) return false
            stack.pop()
            continue
        }
        const attrs = Object.fromEntries([...token.matchAll(/([\w:-]+)=(["'])(.*?)\2/gs)].map(item => [item[1], item[3]]))
        const bounds = attrs.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)
        const visible = stack.every(parent => parent.visible) && attrs['visible-to-user'] !== 'false'
            && (!bounds || (Number(bounds[3]) > Number(bounds[1]) && Number(bounds[4]) > Number(bounds[2])))
        const resource = attrs['resource-id'] || ''
        const tab = visible && attrs.package === 'com.instagram.android'
            && /^com\.instagram\.android:id\/(?:feed_tab|profile_tab)$/.test(resource) ? resource : stack.at(-1)?.tab
        if (visible) {
            visibleNodes.push(attrs)
            if (attrs.package && attrs.package !== 'com.instagram.android') return false
            if (/EditText|Dialog/.test(attrs.class || '')
                || /(?:^|\/)(?:caption_input_text_view|share_footer_button|quick_edit_fragment|quick_edit_compose_view|gallery_media_thumbnail_tray|feed_post_capture_controls_container|media_thumbnail_tray_constraintlayout|media_thumbnail_tray_button|clips_post_capture_controls|post_capture_controls_container|gallery_recycler_view|gallery_picker_grid_item_container|dialog_container|modal_container|igds_alert_dialog|igds_headline|bottom_sheet|share_sheet)$/.test(resource)
                || /^(?:New post|Sharing posts)$/.test(attrs.text || '')) return false
            if (tab && attrs.selected === 'true' && attrs.enabled !== 'false') selectedTabs.add(tab)
        }
        if (!token.endsWith('/>')) stack.push({ visible, tab })
        if (stack.length > 256) return false
    }
    if (stack.length !== 0 || selectedTabs.size !== 1) return false
    if (accountUsername === null) return true
    const account = normalizeInstagramAccountUsername(accountUsername)
    const prefix = 'com.instagram.android:id/'
    const matching = resource => visibleNodes.filter(attrs => attrs['resource-id'] === prefix + resource)
    const titles = [...matching('action_bar_title'), ...matching('action_bar_textview_title')]
    const avatars = matching('row_profile_header_imageview')
    const counts = matching('profile_header_familiar_post_count_value')
    const edits = matching('button_container').filter(attrs => attrs['content-desc'] === 'Edit profile')
    return Boolean(account) && selectedTabs.has(prefix + 'profile_tab')
        && titles.length === 1 && [titles[0].text, titles[0]['content-desc']].filter(value => value?.trim()).length > 0
        && [titles[0].text, titles[0]['content-desc']].filter(value => value?.trim())
            .every(value => normalizeInstagramAccountUsername(value) === account)
        && avatars.length === 1 && /^Your profile(?:\.|$)/.test(avatars[0]['content-desc'] || '')
        && counts.length === 1 && /^\d[\d,.]*[KM]?$/.test(counts[0].text || '')
        && edits.length === 1 && edits[0].clickable === 'true' && edits[0].enabled !== 'false'
}

function ownerAbandonmentMatches(proof, dispatch, stored = false) {
    if (!proof || !dispatch || dispatch.success !== true || dispatch.action !== 'share_owner_document'
        || dispatch.share_dispatched !== true || dispatch.selection_verified !== 'exact_document_bytes'
        || proof.publish_attempted !== false || proof.editor_closed !== true
        || proof.abandonment_verified !== 'observed_editor_to_own_profile') return false
    const bindings = ['transfer_id', 'remote_filename', 'sha256', 'method', 'source_profile', 'phone_profile',
        'download_id', 'document_uri', 'device_id', 'account_username', 'size_bytes', 'reservation_id', 'dispatch_id']
    const keys = [...bindings, 'publish_attempted', 'editor_closed', 'abandonment_verified',
        ...(stored ? ['version', 'phase', 'source_path', 'recorded_at'] : [])]
    return Object.keys(proof).length === keys.length && keys.every(key => Object.hasOwn(proof, key))
        && bindings.every(key => proof[key] === dispatch[key])
}

function hasOwnerAbandonmentProof(reservation, proof) {
    const record = pendingTransfers.get(reservation?.transfer_id)
    return reservation?.entry?.method === OWNER_DOCUMENT_METHOD
        && record?.reservation_id === reservation.reservation_id
        && record.ownerDispatch?.reservation_id === reservation.reservation_id
        && record.remaining[0] === reservation.entry
        && ownerAbandonmentMatches(proof, record.ownerDispatch)
}

function readOwnerAbandonment(intent) {
    const folder = ownerStagingDirectory(intent)
    const proof = validateOwnerRecordBinding(readOwnerRecord(path.join(folder, 'unpublished-abandoned.json')), intent, 'unpublished-abandoned')
    const dispatch = validateOwnerRecordBinding(readOwnerRecord(path.join(folder, 'dispatch-confirmed.json')), intent, 'dispatch-confirmed')
    if (!ownerAbandonmentMatches(proof, dispatch, true) || Date.parse(proof.recorded_at) < Date.parse(dispatch.recorded_at)) {
        throw new Error('Owner abandonment does not match its confirmed dispatch')
    }
    return proof
}

function hasUnresolvedOwnerStaging(accountUsername, sha256) {
    const directory = path.join(contentStateRoot(), 'owner-document-staging-v1')
    if (!fs.existsSync(directory)) return false
    try {
        for (const candidate of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!candidate.isDirectory() || !/^[a-f0-9]{64}$/.test(candidate.name)) continue
            const folder = path.join(directory, candidate.name)
            const intentPath = path.join(folder, 'intent.json')
            if (!fs.existsSync(intentPath)) continue
            const intent = readOwnerRecord(intentPath)
            if (intent.account_username !== accountUsername || intent.sha256 !== sha256) continue
            const cleanedPath = path.join(folder, 'cleanup-complete.json')
            if (!fs.existsSync(cleanedPath)) return true
            const cleaned = validateOwnerRecordBinding(readOwnerRecord(cleanedPath), intent, 'cleanup-complete')
            if (cleaned.cleaned !== true) return true
        }
        return false
    } catch {
        return true
    }
}

async function writeOwnerRecord(entry, phase, details = {}) {
    const target = path.join(ownerStagingDirectory(entry), `${phase}.json`)
    const payload = {
        version: 1, method: OWNER_DOCUMENT_METHOD, phase,
        transfer_id: entry.transfer_id, device_id: entry.device_id,
        account_username: entry.account_username, source_profile: '0', phone_profile: entry.phone_profile,
        source_path: entry.source_path, remote_filename: entry.remote_filename,
        sha256: entry.sha256, size_bytes: entry.size_bytes,
        ...details, recorded_at: new Date().toISOString(),
    }
    await writeJsonAtomically(target, payload, { rejectExisting: true })
    const handle = await fs.promises.open(target, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    if (JSON.stringify(readOwnerRecord(target)) !== JSON.stringify(payload)) throw new Error('Owner staging record did not persist exactly')
    return payload
}

function ownerProviderRows(result) {
    const { stdout, stderr } = normalizeExecOutput(result)
    if (stderr.trim() || /(?:Exception|Error while|Permission Denial)/i.test(stdout)) {
        throw new Error('Owner DownloadProvider request failed')
    }
    if (/^No result found\.?\s*$/.test(stdout.trim())) return []
    const lines = stdout.split(/\r?\n/).filter(line => line.trim())
    if (!lines.length || lines.some(line => !/^Row: \d+\s/.test(line))) throw new Error('Owner DownloadProvider returned an invalid row result')
    return lines.map(line => Object.fromEntries(line.replace(/^Row: \d+\s+/, '').split(/,\s+/).map(field => {
        const separator = field.indexOf('=')
        return [field.slice(0, separator), field.slice(separator + 1)]
    })))
}

function assertOwnerRow(row, intent, { completed = true } = {}) {
    if (!row || !/^[1-9]\d*$/.test(row._id)
        || row.title !== intent.remote_filename || row.uri !== intent.request_url
        || row.uid !== '2000' || row.notificationpackage !== 'com.android.shell'
        || row.destination !== '4' || row.hint !== `file://${intent.staging_destination}`
        || row.mimetype !== 'image/png'
        || (intent.download_id && row._id !== intent.download_id)) {
        throw new Error('Owner download row does not match its exact staging intent')
    }
    if (completed && (row.status !== '200' || row._data !== intent.staging_destination
        || Number(row.total_bytes) !== intent.size_bytes || Number(row.current_bytes) !== intent.size_bytes)) {
        throw new Error('Owner download did not complete with the exact expected bytes')
    }
    return row
}

function validateOwnerIntent(intent, folder) {
    if (intent.version !== 1 || intent.method !== OWNER_DOCUMENT_METHOD || intent.phase !== 'intent'
        || intent.consent !== true || intent.source_profile !== '0' || !/^[1-9]\d*$/.test(intent.phone_profile)
        || !intent.device_id || normalizeInstagramAccountUsername(intent.account_username) !== intent.account_username
        || !/^[a-f0-9]{64}$/.test(intent.sha256) || !Number.isSafeInteger(intent.size_bytes) || intent.size_bytes <= 0
        || !new RegExp(`^sp_${intent.sha256}_[a-f0-9]{8}_[a-f0-9]{8}\\.png$`).test(intent.remote_filename)
        || intent.staging_destination !== `/storage/emulated/0/Download/${intent.remote_filename}`
        || !/^http:\/\/localhost:\d{1,5}\/[a-f0-9-]{36}$/.test(intent.request_url)
        || !path.isAbsolute(intent.source_path || '') || ownerStagingDirectory(intent) !== folder) {
        throw new Error('Owner staging intent is invalid; manual reconciliation is required')
    }
    return intent
}

function publishedMarkerPaths(sourcePath, sha256) {
    const identity = publishedSourceIdentity(sourcePath, sha256)
    const adjacent = path.join(path.dirname(sourcePath), `.shadowphone-published-${identity}.json`)
    const central = path.join(contentStateRoot(), 'published-content-journal', `${identity}.json`)
    return { identity, paths: [adjacent, central] }
}

function accountContentIdentity(accountUsername, sha256) {
    const account = normalizeInstagramAccountUsername(accountUsername)
    const digest = String(sha256 || '').trim().toLowerCase()
    if (!account || !/^[a-f0-9]{64}$/.test(digest)) return null
    return {
        account,
        sha256: digest,
        identity: createHash('sha256').update(`${account}\n${digest}`).digest('hex'),
    }
}

function accountContentLedgerPath(accountUsername, sha256) {
    const content = accountContentIdentity(accountUsername, sha256)
    return content
        ? path.join(contentStateRoot(), 'published-account-content-v2', `${content.identity}.json`)
        : null
}

function accountContentOutcomeDirectory(accountUsername, sha256) {
    const content = accountContentIdentity(accountUsername, sha256)
    return content
        ? path.join(contentStateRoot(), 'published-account-content-outcomes-v2', content.identity)
        : null
}

function accountContentOutcomePath(accountUsername, sha256, transferId) {
    const outcomeDirectory = accountContentOutcomeDirectory(accountUsername, sha256)
    const normalizedTransferId = String(transferId || '').trim()
    if (!outcomeDirectory || !normalizedTransferId) return null
    const transferIdentity = createHash('sha256').update(normalizedTransferId).digest('hex')
    return path.join(outcomeDirectory, `${transferIdentity}.json`)
}

function hasAccountContentOutcome(accountUsername, sha256) {
    const outcomeDirectory = accountContentOutcomeDirectory(accountUsername, sha256)
    if (!outcomeDirectory || !fs.existsSync(outcomeDirectory)) return false
    try {
        return fs.readdirSync(outcomeDirectory, { withFileTypes: true })
            .some(entry => entry.isFile() && entry.name.endsWith('.json'))
    } catch {
        return true
    }
}

function hasAccountContentLedger(accountUsername, sha256) {
    const ledgerPath = accountContentLedgerPath(accountUsername, sha256)
    return Boolean(ledgerPath && fs.existsSync(ledgerPath))
        || hasAccountContentOutcome(accountUsername, sha256)
}

function readAccountContentOutcome(accountUsername, sha256, transferId) {
    const outcomePath = accountContentOutcomePath(accountUsername, sha256, transferId)
    if (!outcomePath || !fs.existsSync(outcomePath)) return null
    return JSON.parse(fs.readFileSync(outcomePath, 'utf8'))
}

function hasPendingAccountContent(accountUsername, sha256, excludedTransferId = '') {
    const content = accountContentIdentity(accountUsername, sha256)
    if (!content) return false
    for (const [transferId, record] of pendingTransfers) {
        if (transferId === excludedTransferId) continue
        if (record.remaining.some(entry => {
            const pending = accountContentIdentity(entry.account_username, entry.sha256)
            return pending?.identity === content.identity
        })) return true
    }
    return false
}

function hasPublishedMarker(sourcePath, sha256) {
    const marker = publishedMarkerPaths(sourcePath, sha256)
    return publishedSourceKeys.has(marker.identity)
        || marker.paths.some(markerPath => fs.existsSync(markerPath))
}

async function writeJsonAtomically(targetPath, payload, { rejectExisting = false } = {}) {
    const existingRecordError = () => {
        const error = new Error(`Durable content ledger already exists: ${targetPath}`)
        error.code = 'CONTENT_LEDGER_ALREADY_EXISTS'
        return error
    }
    if (fs.existsSync(targetPath)) {
        if (rejectExisting) throw existingRecordError()
        return targetPath
    }
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
    const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
    try {
        await fs.promises.writeFile(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' })
        try {
            await fs.promises.link(tempPath, targetPath)
        } catch (error) {
            if (['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
                try {
                    await fs.promises.copyFile(tempPath, targetPath, fs.constants.COPYFILE_EXCL)
                    return targetPath
                } catch (copyError) {
                    error = copyError
                }
            }
            if (!fs.existsSync(targetPath)) throw error
            if (rejectExisting) throw existingRecordError()
        }
    } finally {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
    }
    return targetPath
}

async function writeSourceJournal(entry, status, details = {}) {
    const marker = publishedMarkerPaths(entry.source_path, entry.sha256)
    rememberPublishedSourceKey(marker.identity)
    const payload = {
        version: 1,
        status,
        transfer_id: entry.transfer_id,
        source_path: entry.source_path,
        sha256: entry.sha256,
        size_bytes: entry.size_bytes,
        ...details,
        recorded_at: new Date().toISOString(),
    }
    const markerErrors = []
    for (const markerPath of marker.paths) {
        try {
            return {
                durable_marker: true,
                marker_identity: marker.identity,
                published_marker_path: await writeJsonAtomically(markerPath, payload),
                marker_errors: Object.freeze(markerErrors),
            }
        } catch (error) {
            markerErrors.push(`${markerPath}: ${error.message}`)
        }
    }
    const error = new Error(`Unable to persist content reconciliation journal: ${markerErrors.join('; ')}`)
    error.code = 'CONTENT_RECONCILIATION_JOURNAL_FAILED'
    error.marker_identity = marker.identity
    error.marker_errors = Object.freeze(markerErrors)
    throw error
}

async function writeAccountContentLedger(entry, status, details = {}) {
    const content = accountContentIdentity(entry.account_username, entry.sha256)
    if (!content) {
        const error = new Error('A valid Instagram account username is required for the account-content publish ledger')
        error.code = 'CONTENT_ACCOUNT_IDENTITY_REQUIRED'
        throw error
    }
    const ledgerPath = accountContentLedgerPath(content.account, content.sha256)
    const payload = {
        version: 2,
        status,
        account_username: content.account,
        sha256: content.sha256,
        transfer_id: entry.transfer_id,
        source_path: entry.source_path,
        size_bytes: entry.size_bytes,
        ...details,
        recorded_at: new Date().toISOString(),
    }
    return Object.freeze({
        durable_account_content_ledger: true,
        account_content_identity: content.identity,
        account_content_ledger_path: await writeJsonAtomically(ledgerPath, payload, { rejectExisting: true }),
    })
}

async function writeAccountContentOutcome(entry, archiveDisposition, details = {}) {
    const content = accountContentIdentity(entry.account_username, entry.sha256)
    const transferId = String(entry.transfer_id || '').trim()
    if (!content || !transferId) {
        const error = new Error('A valid account, content hash, and transfer ID are required for the archive outcome ledger')
        error.code = 'CONTENT_ARCHIVE_OUTCOME_IDENTITY_REQUIRED'
        throw error
    }
    if (!['archived', 'failed'].includes(archiveDisposition)) {
        throw new Error(`Unsupported archive disposition: ${archiveDisposition}`)
    }
    const outcomePath = accountContentOutcomePath(content.account, content.sha256, transferId)
    const payload = {
        version: 2,
        account_username: content.account,
        sha256: content.sha256,
        transfer_id: transferId,
        archive_disposition: archiveDisposition,
        archived_path: details.archived_path || null,
        archive_error: details.archive_error || null,
        source_retained: details.source_retained === true,
        recorded_at: new Date().toISOString(),
    }
    return Object.freeze({
        durable_archive_outcome: true,
        archive_outcome_path: await writeJsonAtomically(outcomePath, payload, { rejectExisting: true }),
    })
}

async function markPublishedSource(entry, archiveError) {
    return writeSourceJournal(entry, 'published_but_archive_failed', {
        archive_error: archiveError.message,
    })
}

async function quarantineUnconfirmedTransfer(reservation, details = {}) {
    const record = reservation && pendingTransfers.get(reservation.transfer_id)
    if (!record || record.reservation_id !== reservation.reservation_id) {
        throw new Error(`Transfer ${reservation?.transfer_id || '(unknown)'} is not reserved for uncertainty quarantine`)
    }
    const entry = record.remaining[0]
    if (!entry || entry.source_path !== reservation.entry.source_path || entry.sha256 !== reservation.entry.sha256) {
        throw new Error(`Transfer ${reservation.transfer_id} no longer points to the reserved manifest item`)
    }
    const ledger = await writeAccountContentLedger(entry, 'publish_unconfirmed_exact_selection', {
        reason: details.reason || 'Module reported success without matching exact gallery selection and publish proof',
        ...details,
        archive_disposition: 'manual_reconciliation_required',
        manual_reconciliation_required: true,
    })
    let marker
    try {
        marker = await writeSourceJournal(entry, 'publish_unconfirmed_exact_selection', {
            reason: details.reason || 'Module reported success without matching exact gallery selection and publish proof',
            manual_reconciliation_required: true,
            ...details,
        })
    } catch (error) {
        error.durable_account_content_ledger = ledger.durable_account_content_ledger
        error.account_content_ledger_path = ledger.account_content_ledger_path
        throw error
    }
    consumePublishedReservation(record, reservation)
    return Object.freeze({
        status: 'publish_unconfirmed_exact_selection',
        publish_success: null,
        archive_success: false,
        transfer_id: reservation.transfer_id,
        source_path: entry.source_path,
        archived_path: null,
        sha256: entry.sha256,
        durable_marker: marker.durable_marker,
        published_marker_path: marker.published_marker_path,
        marker_errors: marker.marker_errors,
        durable_account_content_ledger: ledger.durable_account_content_ledger,
        account_content_ledger_path: ledger.account_content_ledger_path,
        manual_reconciliation_required: true,
        source_retained: fs.existsSync(entry.source_path),
    })
}

function consumeUncertainReservation(reservation) {
    if (!reservation?.entry) return false
    rememberPublishedSourceKey(publishedSourceIdentity(reservation.entry.source_path, reservation.entry.sha256))
    const record = pendingTransfers.get(reservation.transfer_id)
    if (!record || record.reservation_id !== reservation.reservation_id) return false
    consumePublishedReservation(record, reservation)
    return true
}

function isPathInside(parentPath, candidatePath) {
    const relative = path.relative(parentPath, candidatePath)
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function resolveScheduledContentCandidate({
    resolvedSource,
    selectedSourceFile,
    scanFolders,
    allowsExtension,
}) {
    const sourceRoot = await fs.promises.realpath(resolvedSource)
    const hasPathSegments = selectedSourceFile.includes('/') || selectedSourceFile.includes('\\')
    let matches

    if (path.isAbsolute(selectedSourceFile) || hasPathSegments) {
        const candidate = path.isAbsolute(selectedSourceFile)
            ? path.resolve(selectedSourceFile)
            : path.resolve(resolvedSource, selectedSourceFile)
        if (!isPathInside(path.resolve(resolvedSource), candidate)) {
            throw new Error(`Scheduled content file is outside the account content folder: ${selectedSourceFile}`)
        }
        matches = [candidate]
    } else {
        const requestedName = selectedSourceFile.toLowerCase()
        matches = []
        for (const folder of scanFolders) {
            if (!fs.existsSync(folder)) continue
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                if (entry.name.toLowerCase() !== requestedName) continue
                matches.push(path.resolve(folder, entry.name))
            }
        }
        if (matches.length > 1) {
            throw new Error(`Ambiguous scheduled content file '${selectedSourceFile}' matched ${matches.length} files in the account content folder`)
        }
    }

    if (matches.length === 0) {
        throw new Error(`Scheduled content file was not found in the account content folder: ${selectedSourceFile}`)
    }

    let sourcePath
    try {
        sourcePath = await fs.promises.realpath(matches[0])
    } catch {
        throw new Error(`Scheduled content file was not found in the account content folder: ${selectedSourceFile}`)
    }
    if (!isPathInside(sourceRoot, sourcePath)) {
        throw new Error(`Scheduled content file is outside the account content folder: ${selectedSourceFile}`)
    }
    const eligibleRoots = []
    for (const folder of scanFolders) {
        try {
            const eligibleRoot = await fs.promises.realpath(folder)
            if (isPathInside(sourceRoot, eligibleRoot)) eligibleRoots.push(eligibleRoot)
        } catch {
            // Missing content folders cannot contain the selected file.
        }
    }
    if (!eligibleRoots.some(folder => isPathInside(folder, sourcePath))) {
        throw new Error(`Scheduled content file is outside the eligible content folders: ${selectedSourceFile}`)
    }

    let stat
    let handle
    try {
        stat = await fs.promises.stat(sourcePath)
        if (!stat.isFile()) throw new Error('not a file')
        handle = await fs.promises.open(sourcePath, 'r')
    } catch {
        throw new Error(`Scheduled content path is not a readable regular file: ${selectedSourceFile}`)
    } finally {
        await handle?.close().catch(() => undefined)
    }

    const extension = path.extname(sourcePath).toLowerCase()
    if (!allowsExtension(extension)) {
        throw new Error(`Scheduled content file is incompatible with the requested content type: ${selectedSourceFile}`)
    }

    return {
        filename: path.basename(sourcePath),
        relativePath: path.relative(sourceRoot, sourcePath).replace(/\\/g, '/'),
        sourcePath,
    }
}

async function planContentTransfer({
    sourceFolder,
    sourceFile,
    contentType,
    maxFiles = 10,
    extensions,
    transferId,
    deviceId = '',
    targetUser = '0',
    accountUsername = '',
    destinationFolder = '/sdcard/ShadowPhone/content',
}) {
    const resolvedSource = path.resolve(String(sourceFolder || ''))
    if (!sourceFolder || !fs.existsSync(resolvedSource)) {
        throw new Error(`Content folder not found: ${sourceFolder || '(empty)'}`)
    }

    const normalizedType = normalizeTransferContentType(contentType)
    const extensionList = Array.isArray(extensions)
        ? extensions
        : [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]
    const requestedExtensions = new Set(extensionList
        .map(extension => String(extension).toLowerCase())
        .map(extension => extension.startsWith('.') ? extension : `.${extension}`))
    const allowsExtension = extension => {
        if (!requestedExtensions.has(extension)) return false
        if (normalizedType === 'image') return IMAGE_EXTENSIONS.has(extension)
        if (normalizedType === 'reel') return VIDEO_EXTENSIONS.has(extension)
        return IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension)
    }

    const sourceBase = path.basename(resolvedSource).toLowerCase()
    const knownFolders = new Set(Object.values(CONTENT_FOLDERS).flat())
    const scanFolders = knownFolders.has(sourceBase)
        ? (normalizedType === 'media' || CONTENT_FOLDERS[normalizedType].includes(sourceBase) ? [resolvedSource] : [])
        : normalizedType === 'media'
            ? [resolvedSource, ...CONTENT_FOLDERS.media.map(folder => path.join(resolvedSource, folder))]
            : CONTENT_FOLDERS[normalizedType].map(folder => path.join(resolvedSource, folder))

    const selectedSourceFile = String(sourceFile || '').trim()
    const candidates = selectedSourceFile
        ? [await resolveScheduledContentCandidate({
            resolvedSource,
            selectedSourceFile,
            scanFolders,
            allowsExtension,
        })]
        : []
    if (!selectedSourceFile) {
        for (const folder of scanFolders) {
            if (!fs.existsSync(folder)) continue
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                if (!entry.isFile()) continue
                const extension = path.extname(entry.name).toLowerCase()
                if (!allowsExtension(extension)) continue
                const sourcePath = path.resolve(folder, entry.name)
                candidates.push({
                    filename: entry.name,
                    relativePath: path.relative(resolvedSource, sourcePath).replace(/\\/g, '/'),
                    sourcePath,
                })
            }
        }
    }
    candidates.sort((left, right) => {
        const insensitive = left.relativePath.localeCompare(right.relativePath, 'en', { sensitivity: 'base' })
        return insensitive || left.relativePath.localeCompare(right.relativePath, 'en')
    })

    const numericLimit = Number(maxFiles)
    const limit = selectedSourceFile
        ? 1
        : Number.isFinite(numericLimit) && numericLimit > 0
        ? Math.max(1, Math.trunc(numericLimit))
        : 1
    const resolvedTransferId = String(transferId || randomUUID())
    const transferHash = createHash('sha256').update(resolvedTransferId).digest('hex').slice(0, 8)
    const normalizedAccountUsername = normalizeInstagramAccountUsername(accountUsername)
    const seenHashes = new Set()
    const manifest = []
    for (const candidate of candidates) {
        if (manifest.length >= limit) break
        const beforeHash = await fs.promises.stat(candidate.sourcePath)
        const sha256 = await hashFile(candidate.sourcePath)
        const afterHash = await fs.promises.stat(candidate.sourcePath)
        if (beforeHash.size !== afterHash.size || beforeHash.mtimeMs !== afterHash.mtimeMs) {
            throw new Error(`Content changed while its transfer manifest was being created: ${candidate.sourcePath}`)
        }
        if (hasPublishedMarker(candidate.sourcePath, sha256)) continue
        if (hasAccountContentLedger(normalizedAccountUsername, sha256)) continue
        if (hasPendingAccountContent(normalizedAccountUsername, sha256)) continue
        if (hasUnresolvedOwnerStaging(normalizedAccountUsername, sha256)) {
            if (selectedSourceFile) throw new Error('Owner document staging requires reconciliation before this content can be planned again')
            continue
        }
        if (seenHashes.has(sha256)) continue
        seenHashes.add(sha256)
        const pathHash = createHash('sha256').update(candidate.relativePath.toLowerCase()).digest('hex').slice(0, 8)
        const remoteFilename = `sp_${sha256}_${pathHash}_${transferHash}${path.extname(candidate.filename).toLowerCase()}`
        manifest.push(Object.freeze({
            transfer_id: resolvedTransferId,
            source_path: candidate.sourcePath,
            filename: candidate.filename,
            content_type: normalizedType,
            size_bytes: afterHash.size,
            sha256,
            remote_filename: remoteFilename,
            phone_destination: joinPhonePath(destinationFolder, remoteFilename),
            phone_profile: String(targetUser || '0'),
            device_id: String(deviceId || ''),
            account_username: normalizedAccountUsername,
            device_selection: 'pending_exact_gallery_selection',
        }))
    }
    if (selectedSourceFile && manifest.length === 0) {
        throw new Error(`Scheduled content file is unavailable because it is already published or reserved: ${selectedSourceFile}`)
    }

    const plan = {
        transfer_id: resolvedTransferId,
        source_folder: resolvedSource,
        content_type: normalizedType,
        device_id: String(deviceId || ''),
        phone_profile: String(targetUser || '0'),
        account_username: normalizedAccountUsername,
        manifest: Object.freeze(manifest),
    }
    plannerMintedTransfers.add(plan)
    return Object.freeze(plan)
}

function registerTransferManifest(plan) {
    if (!plan || !plan.transfer_id || !Array.isArray(plan.manifest) || plan.manifest.length === 0) {
        throw new Error('A non-empty transfer manifest with transfer_id is required')
    }
    if (!plannerMintedTransfers.has(plan)) {
        throw new Error('Transfer manifest is untrusted; registration requires the exact planner-minted plan object')
    }
    if (pendingTransfers.has(plan.transfer_id)) {
        throw new Error(`Transfer ${plan.transfer_id} is already registered`)
    }
    if (pendingTransfers.size >= MAX_PENDING_TRANSFERS) {
        throw new Error('Transfer manifest registry is full; explicitly discard or consume a pending transfer before adding another')
    }
    const planKeys = new Set()
    for (const entry of plan.manifest) {
        if (hasPublishedMarker(entry.source_path, entry.sha256)) {
            throw new Error(`Transfer ${plan.transfer_id} contains content already recorded by the legacy publish journal`)
        }
        const content = accountContentIdentity(entry.account_username, entry.sha256)
        if (!content) continue
        if (planKeys.has(content.identity)) {
            throw new Error(`Transfer ${plan.transfer_id} contains a duplicate account-content hash`)
        }
        planKeys.add(content.identity)
        if (hasAccountContentLedger(content.account, content.sha256)) {
            throw new Error(`Transfer ${plan.transfer_id} contains content already published for account ${content.account}`)
        }
        if (hasPendingAccountContent(content.account, content.sha256, plan.transfer_id)) {
            throw new Error(`Transfer ${plan.transfer_id} has an account-content hash already pending`)
        }
    }
    pendingTransfers.set(plan.transfer_id, {
        plan,
        remaining: [...plan.manifest],
        reservation_id: null,
    })
    return plan.transfer_id
}

function discardTransferManifest(transferId) {
    const id = String(transferId || '').trim()
    const record = pendingTransfers.get(id)
    if (!record) return false
    if (record.reservation_id) {
        throw new Error(`Transfer ${id} is reserved and cannot be discarded`)
    }
    pendingTransfers.delete(id)
    return true
}

function transferMatches(record, criteria) {
    const plan = record.plan
    if (criteria.deviceId && plan.device_id !== String(criteria.deviceId)) return false
    if (criteria.targetUser != null && plan.phone_profile !== String(criteria.targetUser)) return false
    if (criteria.accountUsername) {
        const username = normalizeInstagramAccountUsername(criteria.accountUsername)
        if (plan.account_username !== username) return false
    }
    if (criteria.contentType && plan.content_type !== normalizeTransferContentType(criteria.contentType)) return false
    return true
}

function hasCompleteTransferBinding(criteria) {
    return String(criteria.deviceId || '').trim() !== ''
        && criteria.targetUser !== undefined
        && criteria.targetUser !== null
        && String(criteria.targetUser).trim() !== ''
        && normalizeInstagramAccountUsername(criteria.accountUsername) !== ''
        && String(criteria.contentType || '').trim() !== ''
}

function reserveTransferForPost(criteria = {}) {
    const transferId = String(criteria.transferId || criteria.transfer_id || '').trim()
    let selected
    if (transferId) {
        if (!hasCompleteTransferBinding(criteria)) {
            throw new Error('Explicit transfer_id reservation requires all of device, profile, a valid account username, and content type')
        }
        selected = pendingTransfers.get(transferId)
        if (!selected) return null
        if (!transferMatches(selected, criteria)) {
            throw new Error(`Transfer ${transferId} does not match the requested device, profile, account, or content type`)
        }
    } else {
        if (!hasCompleteTransferBinding(criteria)) {
            throw new Error('Compatibility lookup without transfer_id requires all of device, profile, a valid account username, and content type')
        }
        const candidates = Array.from(pendingTransfers.values()).filter(record => transferMatches(record, criteria))
        if (candidates.length > 1) {
            throw new Error('Ambiguous pending content transfer; pass the exact transfer_id')
        }
        selected = candidates[0]
        if (!selected) return null
    }
    if (selected.reservation_id) {
        throw new Error(`Transfer ${selected.plan.transfer_id} is already reserved`)
    }
    const entry = selected.remaining[0]
    if (!entry) return null
    if (entry.method === OWNER_DOCUMENT_METHOD && criteria.moduleId !== 'post_feed') {
        throw new Error('Owner document content can only be reserved by Feed')
    }
    if (!normalizeInstagramAccountUsername(entry.account_username)) {
        throw new Error('A valid Instagram account username is required to reserve content for publishing')
    }
    if (hasPublishedMarker(entry.source_path, entry.sha256)
        || hasAccountContentLedger(entry.account_username, entry.sha256)) {
        pendingTransfers.delete(selected.plan.transfer_id)
        throw new Error(`Transfer ${selected.plan.transfer_id} content is already recorded as published for this account`)
    }
    selected.reservation_id = randomUUID()
    return Object.freeze({
        transfer_id: selected.plan.transfer_id,
        reservation_id: selected.reservation_id,
        entry,
    })
}

function releaseTransferReservation(reservation) {
    if (!reservation) return false
    const record = pendingTransfers.get(reservation.transfer_id)
    if (!record || record.reservation_id !== reservation.reservation_id) return false
    record.reservation_id = null
    return true
}

function consumePublishedReservation(record, reservation) {
    record.remaining.shift()
    record.reservation_id = null
    if (record.remaining.length === 0) pendingTransfers.delete(reservation.transfer_id)
}

async function existingArchiveMatches(targetPath, entry) {
    if (!fs.existsSync(targetPath)) return false
    const stat = await fs.promises.stat(targetPath)
    if (!stat.isFile() || stat.size !== entry.size_bytes) return false
    return await hashFile(targetPath) === entry.sha256
}

async function moveToArchive(sourcePath, archivedPath, entry) {
    try {
        await fs.promises.rename(sourcePath, archivedPath)
        return
    } catch (renameError) {
        const tempPath = `${archivedPath}.${process.pid}.${randomUUID()}.tmp`
        try {
            await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL)
            const copiedStat = await fs.promises.stat(tempPath)
            const copiedHash = await hashFile(tempPath)
            if (copiedStat.size !== entry.size_bytes || copiedHash !== entry.sha256) {
                throw new Error('Verified archive copy did not match the transfer manifest')
            }
            try {
                await fs.promises.rename(tempPath, archivedPath)
            } catch (commitError) {
                if (!await existingArchiveMatches(archivedPath, entry)) throw commitError
            }
            await fs.promises.unlink(sourcePath)
        } catch (fallbackError) {
            throw new Error(`Archive rename failed (${renameError.message}); verified copy fallback failed (${fallbackError.message})`)
        } finally {
            await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
        }
    }
}

function hasExactPublishProof(reservation, contentSelection) {
    const exact = Boolean(contentSelection)
        && contentSelection.transfer_id === reservation?.transfer_id
        && contentSelection.remote_filename === reservation?.entry?.remote_filename
        && contentSelection.sha256 === reservation?.entry?.sha256
        && contentSelection.selection_verified === 'exact'
        && contentSelection.publish_confirmed === true
    if (!exact) return false
    if (reservation.entry.method !== OWNER_DOCUMENT_METHOD) return contentSelection.method !== OWNER_DOCUMENT_METHOD
    const dispatch = pendingTransfers.get(reservation.transfer_id)?.ownerDispatch
    return dispatch?.reservation_id === reservation.reservation_id
        && dispatch.share_dispatched === true
        && ['method', 'source_profile', 'phone_profile', 'download_id', 'document_uri', 'device_id',
            'account_username', 'size_bytes', 'reservation_id', 'dispatch_id'].every(key => contentSelection[key] === dispatch[key])
}

function assertExactPublishProof(reservation, contentSelection) {
    if (!hasExactPublishProof(reservation, contentSelection)) {
        throw new Error('Exact content archival requires matching transfer_id, remote_filename, SHA-256, exact selection proof, and publish confirmation')
    }
}

async function archivePublishedTransfer(reservation, contentSelection) {
    assertExactPublishProof(reservation, contentSelection)
    const record = reservation && pendingTransfers.get(reservation.transfer_id)
    if (!record) throw new Error(`Transfer ${reservation?.transfer_id || '(unknown)'} is not pending or was already consumed`)
    if (record.reservation_id !== reservation.reservation_id) {
        throw new Error(`Transfer ${reservation.transfer_id} reservation was already consumed`)
    }

    const entry = record.remaining[0]
    if (!entry || entry.source_path !== reservation.entry.source_path || entry.sha256 !== reservation.entry.sha256) {
        throw new Error(`Transfer ${reservation.transfer_id} no longer points to the reserved manifest item`)
    }
    let archivedPath = null
    let pendingJournal = null
    let accountLedger = null
    try {
        accountLedger = await writeAccountContentLedger(entry, 'publish_confirmed', {
            remote_filename: contentSelection.remote_filename,
            selection_verified: contentSelection.selection_verified,
            publish_confirmed: true,
            archive_disposition: 'pending',
            manual_reconciliation_required: true,
        })
        pendingJournal = await writeSourceJournal(entry, 'publish_confirmed_archive_pending', {
            remote_filename: contentSelection.remote_filename,
            selection_verified: contentSelection.selection_verified,
            publish_confirmed: true,
            manual_reconciliation_required: true,
        })
        if (!fs.existsSync(entry.source_path)) {
            throw new Error(`Transferred source is missing before archival: ${entry.source_path}`)
        }
        const beforeHash = await fs.promises.stat(entry.source_path)
        const currentHash = await hashFile(entry.source_path)
        const afterHash = await fs.promises.stat(entry.source_path)
        if (beforeHash.size !== afterHash.size || beforeHash.mtimeMs !== afterHash.mtimeMs) {
            throw new Error(`Transferred source changed while being verified for archival: ${entry.source_path}`)
        }
        if (afterHash.size !== entry.size_bytes || currentHash !== entry.sha256) {
            throw new Error(`Transferred source changed after transfer: ${entry.source_path}`)
        }

        const sourceFolder = path.dirname(entry.source_path)
        const sourceBase = path.basename(sourceFolder)
        const usedFolder = sourceBase.startsWith('used_')
            ? sourceFolder
            : path.join(path.dirname(sourceFolder), `used_${sourceBase}`)
        await fs.promises.mkdir(usedFolder, { recursive: true })
        archivedPath = path.join(usedFolder, entry.filename)
        if (fs.existsSync(archivedPath)) {
            if (await existingArchiveMatches(archivedPath, entry)) {
                await fs.promises.unlink(entry.source_path)
            } else {
                const extension = path.extname(entry.filename)
                const stem = path.basename(entry.filename, extension)
                const transferSuffix = String(entry.transfer_id).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'transfer'
                archivedPath = path.join(usedFolder, `${stem}.${entry.sha256.slice(0, 12)}.${transferSuffix}${extension}`)
                if (fs.existsSync(archivedPath)) {
                    if (await existingArchiveMatches(archivedPath, entry)) {
                        await fs.promises.unlink(entry.source_path)
                    } else {
                        throw new Error(`Deterministic archive destination already exists: ${archivedPath}`)
                    }
                } else {
                    await moveToArchive(entry.source_path, archivedPath, entry)
                }
            }
        } else {
            await moveToArchive(entry.source_path, archivedPath, entry)
        }

        let archiveOutcome
        try {
            archiveOutcome = await writeAccountContentOutcome(entry, 'archived', {
                archived_path: archivedPath,
                archive_error: null,
                source_retained: false,
            })
        } catch (archiveOutcomeError) {
            consumePublishedReservation(record, reservation)
            return Object.freeze({
                status: 'published_archive_reconciliation_required',
                publish_success: true,
                archive_success: true,
                transfer_id: reservation.transfer_id,
                source_path: entry.source_path,
                archived_path: archivedPath,
                sha256: entry.sha256,
                durable_account_content_ledger: accountLedger.durable_account_content_ledger,
                account_content_ledger_path: accountLedger.account_content_ledger_path,
                durable_archive_outcome: false,
                archive_outcome_path: accountContentOutcomePath(entry.account_username, entry.sha256, entry.transfer_id),
                archive_outcome_error: archiveOutcomeError.message,
                manual_reconciliation_required: true,
                source_retained: fs.existsSync(entry.source_path),
            })
        }

        consumePublishedReservation(record, reservation)
        if (pendingJournal.published_marker_path) {
            await fs.promises.rm(pendingJournal.published_marker_path, { force: true }).catch(() => undefined)
        }
        publishedSourceKeys.delete(pendingJournal.marker_identity)
        return Object.freeze({
            status: 'archived',
            publish_success: true,
            archive_success: true,
            transfer_id: reservation.transfer_id,
            source_path: entry.source_path,
            archived_path: archivedPath,
            sha256: entry.sha256,
            durable_account_content_ledger: accountLedger.durable_account_content_ledger,
            account_content_ledger_path: accountLedger.account_content_ledger_path,
            durable_archive_outcome: archiveOutcome.durable_archive_outcome,
            archive_outcome_path: archiveOutcome.archive_outcome_path,
            manual_reconciliation_required: false,
        })
    } catch (archiveError) {
        let marker = null
        let markerFailure = null
        try {
            marker = await markPublishedSource(entry, archiveError)
        } catch (error) {
            markerFailure = error
        }
        let archiveOutcome = null
        let archiveOutcomeFailure = null
        try {
            archiveOutcome = await writeAccountContentOutcome(entry, 'failed', {
                archived_path: archivedPath,
                archive_error: archiveError.message,
                source_retained: fs.existsSync(entry.source_path),
            })
        } catch (error) {
            archiveOutcomeFailure = error
        }
        consumePublishedReservation(record, reservation)
        return Object.freeze({
            status: 'published_but_archive_failed',
            publish_success: true,
            archive_success: false,
            transfer_id: reservation.transfer_id,
            source_path: entry.source_path,
            archived_path: archivedPath,
            sha256: entry.sha256,
            archive_error: archiveError.message,
            durable_marker: marker?.durable_marker === true,
            published_marker_path: marker?.published_marker_path || null,
            marker_errors: marker?.marker_errors || markerFailure?.marker_errors || [],
            durable_account_content_ledger: accountLedger?.durable_account_content_ledger === true,
            account_content_ledger_path: accountLedger?.account_content_ledger_path
                || accountContentLedgerPath(entry.account_username, entry.sha256),
            durable_archive_outcome: archiveOutcome?.durable_archive_outcome === true,
            archive_outcome_path: archiveOutcome?.archive_outcome_path
                || accountContentOutcomePath(entry.account_username, entry.sha256, entry.transfer_id),
            archive_outcome_error: archiveOutcomeFailure?.message || null,
            manual_reconciliation_required: true,
            manual_cleanup_required: fs.existsSync(entry.source_path),
            source_retained: fs.existsSync(entry.source_path),
        })
    }
}

function pendingTransferCount() {
    return pendingTransfers.size
}

class ModuleWebSocketClient {
    /**
     * Create a WebSocket client for module execution
     * @param {string} serverUrl - The Railway server URL
     * @param {string} authToken - JWT token or API secret for authentication
     * @param {string} authType - 'jwt' for JWT token or 'secret' for legacy API secret
     */
    constructor(serverUrl, authToken, authType = 'secret') {
        this.serverUrl = serverUrl.replace('https://', 'wss://').replace('http://', 'ws://')
        if (!this.serverUrl.endsWith('/ws/execute')) {
            this.serverUrl = this.serverUrl.replace(/\/$/, '') + '/ws/execute'
        }
        this.authToken = authToken
        this.authType = authType  // 'jwt' or 'secret'
        this.ws = null
        this.sessionId = null
        this.connected = false
        this.abortRequested = false
        this.adbPath = null
        this._getDevices = null
        this._activeAdbProcesses = new Set()
        this._uncertainAdbProcesses = new Set()
        this._runAdb = runAdb
        this._adbAbortController = new AbortController()
        this._adbKeyboardCompatibility = new Set()
        this._moduleRunLockTicket = null
        this._quarantinedModuleRunRelease = null
    }

    /** Inject a live device-list getter (optional). Called from module-handlers after construction. */
    setDeviceListGetter(fn) {
        this._getDevices = typeof fn === 'function' ? fn : null
    }

    /**
     * Resolve the best deviceId for read-only (dump/screencap) calls.
     * If the original deviceId is a tailnet serial AND a clean USB twin is
     * available in the live device list, return the USB serial instead.
     * Falls back to the original deviceId in every uncertain case — never throws.
     */
    async _resolveReadDeviceId(tailnetDeviceId) {
        // Device-list source: an injected getter (setDeviceListGetter) if present,
        // else the canonical device-handlers list (lazy require — device-handlers
        // does NOT require this module, so no circular-init hazard). Guarded: any
        // miss returns the original tailnet deviceId, so dumps never break and
        // headless/VPS contexts (no device-handlers) just no-op the routing.
        let getDevices = this._getDevices
        if (typeof getDevices !== 'function' && process.env.SP_ADB_PATH) {
            return tailnetDeviceId
        }
        if (typeof getDevices !== 'function') {
            try { getDevices = require('../handlers/device-handlers').getConnectedDevices } catch (_) { getDevices = null }
        }
        if (typeof getDevices !== 'function') return tailnetDeviceId
        try {
            // 5s TTL cache so back-to-back reads in one step don't each re-enumerate adb.
            const now = Date.now()
            if (!this._devCache || (now - (this._devCacheTs || 0)) > 5000) {
                this._devCache = await getDevices()
                this._devCacheTs = now
            }
            const usbSerial = resolveUsbTwin(tailnetDeviceId, this._devCache)
            return usbSerial || tailnetDeviceId
        } catch (_) {
            return tailnetDeviceId
        }
    }

    async _resolveRadioUsbTwin(deviceId) {
        if (!TAILNET_SERIAL_RE.test(String(deviceId || ''))) return null
        let getDevices = this._getDevices
        if (typeof getDevices !== 'function' && process.env.SP_ADB_PATH) return null
        if (typeof getDevices !== 'function') {
            try { getDevices = require('../handlers/device-handlers').getConnectedDevices } catch (_) { getDevices = null }
        }
        if (typeof getDevices !== 'function') return null
        try {
            const now = Date.now()
            if (!this._devCache || (now - (this._devCacheTs || 0)) > 5000) {
                this._devCache = await getDevices()
                this._devCacheTs = now
            }
            return resolveUsbTwin(deviceId, this._devCache)
        } catch {
            return null
        }
    }

    async _networkPreflight(deviceId) {
        const readDeviceId = await this._resolveReadDeviceId(deviceId)
        try {
            const connectivityDump = await this.executeADB(
                ['shell', 'dumpsys', 'connectivity'],
                readDeviceId,
            )
            const status = parseValidatedWifiAgent(connectivityDump)
            let pingOk = false
            if (status.valid) {
                try {
                    const ping = await this.executeADB(
                        ['shell', 'ping', '-c', '1', '-W', '2', '1.1.1.1'],
                        readDeviceId,
                    )
                    pingOk = /\b1\s+(?:packets?\s+)?received\b|\b1\s+received\b/i.test(String(ping || ''))
                } catch {
                    // Android's VALIDATED capability is authoritative; ICMP is
                    // only corroboration and may be filtered by the network.
                }
            }
            return {
                success: true,
                action: 'network_preflight',
                ...status,
                ping_ok: pingOk,
                probe_device: readDeviceId,
            }
        } catch (error) {
            return {
                success: true,
                action: 'network_preflight',
                valid: false,
                wifi_connected: false,
                wifi_validated: false,
                ping_ok: false,
                reason: 'connectivity_probe_failed',
                error: error.message,
                probe_device: readDeviceId,
            }
        }
    }

    async _recoverNetwork(deviceId, params = {}) {
        const maxAttempts = Math.max(1, Math.min(12, Number.parseInt(params.max_attempts, 10) || 10))
        const requestedPollMs = Number.parseInt(params.poll_interval_ms, 10)
        const pollMs = Number.isFinite(requestedPollMs)
            ? Math.max(0, Math.min(2500, requestedPollMs))
            : 1500
        const wait = ms => ms > 0
            ? new Promise(resolve => setTimeout(resolve, ms))
            : Promise.resolve()

        const usbTwin = await this._resolveRadioUsbTwin(deviceId)
        const isTailnet = TAILNET_SERIAL_RE.test(String(deviceId || ''))
        const radioDeviceId = usbTwin || (!isTailnet ? deviceId : null)
        let recoveryPath
        let scriptFiles = null

        try {
            if (radioDeviceId) {
                recoveryPath = usbTwin ? 'usb_twin' : 'usb'
                await this.executeADB(
                    ['shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'],
                    radioDeviceId,
                )
                await this.executeADB(['shell', 'svc', 'wifi', 'disable'], radioDeviceId)
                await wait(pollMs > 0 ? Math.min(750, pollMs) : 0)
                await this.executeADB(['shell', 'svc', 'wifi', 'enable'], radioDeviceId)
                await this.executeADB(
                    ['shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'],
                    radioDeviceId,
                )
            } else {
                recoveryPath = 'tailnet_detached_safety'
                const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
                const mainFile = `/data/local/tmp/sp-network-recover-${suffix}.sh`
                const safetyFile = `/data/local/tmp/sp-network-safety-${suffix}.sh`
                const logFile = `/data/local/tmp/sp-network-recover-${suffix}.log`
                scriptFiles = { mainFile, safetyFile, logFile }
                const mainScript = [
                    `date +%s > ${logFile}`,
                    `cmd connectivity airplane-mode disable >> ${logFile} 2>&1`,
                    `svc wifi disable >> ${logFile} 2>&1`,
                    'sleep 1',
                    `svc wifi enable >> ${logFile} 2>&1`,
                    `cmd connectivity airplane-mode disable >> ${logFile} 2>&1`,
                    `echo DONE >> ${logFile}`,
                ].join(' ; ')
                const safetyScript = [
                    'sleep 10',
                    'svc wifi enable',
                    'cmd connectivity airplane-mode disable',
                    `echo SAFETY_NET_FIRED >> ${logFile}`,
                ].join(' ; ')
                const mainEncoded = Buffer.from(mainScript).toString('base64')
                const safetyEncoded = Buffer.from(safetyScript).toString('base64')
                await this.executeADB([
                    'shell',
                    `echo ${mainEncoded} | base64 -d > ${mainFile} && echo ${safetyEncoded} | base64 -d > ${safetyFile} && chmod 755 ${mainFile} ${safetyFile}`,
                ], deviceId)
                // Launch the independent safety net first. The complete radio
                // sequence is then detached on-phone, so losing the Tailnet ADB
                // route after Wi-Fi-off cannot strand the phone offline.
                await this.executeADB([
                    'shell',
                    `setsid sh ${safetyFile} </dev/null >/dev/null 2>&1 & setsid sh ${mainFile} </dev/null >/dev/null 2>&1 &`,
                ], deviceId)
            }
        } catch (error) {
            return {
                success: true,
                action: 'network_recover',
                valid: false,
                wifi_connected: false,
                wifi_validated: false,
                reason: 'network_recovery_start_failed',
                recovery_path: recoveryPath || 'unavailable',
                attempts: 0,
                error: error.message,
            }
        }

        let lastStatus = {
            valid: false,
            wifi_connected: false,
            wifi_validated: false,
            reason: 'wifi_not_validated_after_recovery',
        }
        const validationDeviceId = radioDeviceId || deviceId
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await wait(pollMs)
            if (!radioDeviceId) {
                try { await this.executeADB(['connect', deviceId], null) } catch { /* keep polling */ }
            }
            lastStatus = await this._networkPreflight(validationDeviceId)
            if (lastStatus.valid) {
                if (scriptFiles) {
                    try {
                        await this.executeADB(
                            ['shell', `rm -f ${scriptFiles.mainFile} ${scriptFiles.safetyFile}`],
                            deviceId,
                        )
                    } catch { /* safety process may still hold the unlinked file */ }
                }
                return {
                    ...lastStatus,
                    action: 'network_recover',
                    recovery_path: recoveryPath,
                    attempts: attempt,
                }
            }
        }

        return {
            ...lastStatus,
            success: true,
            action: 'network_recover',
            valid: false,
            recovery_path: recoveryPath,
            attempts: maxAttempts,
        }
    }

    /**
     * Get the path to ADB executable
     */
    getADBPath() {
        if (this.adbPath) return this.adbPath
        // Headless / VPS: point at a known adb binary (drives over ANDROID_ADB_SERVER_SOCKET).
        if (process.env.SP_ADB_PATH) { this.adbPath = process.env.SP_ADB_PATH; return this.adbPath }

        const platform = os.platform()
        const possiblePaths = []

        // 1. Check app data folder first (where Electron auto-installer puts ADB)
        try {
            const { app } = require('electron')
            const userDataPath = app.getPath('userData')
            const adbBinary = platform === 'win32' ? 'adb.exe' : 'adb'
            possiblePaths.push(path.join(userDataPath, 'adb', adbBinary))
        } catch (e) { /* not in Electron context */ }

        // 2. Check bundled and common installation paths
        if (platform === 'win32') {
            possiblePaths.push(
                path.join(__dirname, '..', 'adb', 'windows', 'platform-tools', 'adb.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
                path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
                'C:\\Program Files\\Android\\platform-tools\\adb.exe',
                'C:\\Android\\platform-tools\\adb.exe',
                'C:\\platform-tools\\adb.exe',
            )
        } else if (platform === 'darwin') {
            possiblePaths.push(
                path.join(__dirname, '..', 'adb', 'darwin', 'platform-tools', 'adb'),
                '/usr/local/bin/adb',
                path.join(process.env.HOME || '', 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
            )
        } else {
            possiblePaths.push(
                path.join(__dirname, '..', 'adb', 'linux', 'platform-tools', 'adb'),
                '/usr/bin/adb',
            )
        }

        for (const p of possiblePaths) {
            try {
                if (p && fs.existsSync(p)) {
                    console.log('[ADB] Found at:', p)
                    this.adbPath = p
                    return p
                }
            } catch (e) {
                if (p) console.warn('[ADB] existsSync probe failed for', p, '-', e.message)
            }
        }

        // 3. Try system PATH via where/which
        const adbBin = platform === 'win32' ? 'adb.exe' : 'adb'
        try {
            const whereCmd = platform === 'win32' ? `where ${adbBin}` : `which ${adbBin}`
            const result = execSync(whereCmd, { encoding: 'utf8', timeout: 5000 }).trim()
            if (result) {
                const firstPath = result.split('\n')[0].trim()
                if (fs.existsSync(firstPath)) {
                    console.log('[ADB] Found in PATH:', firstPath)
                    this.adbPath = firstPath
                    return firstPath
                }
            }
        } catch (e) {
            console.warn('[ADB] PATH probe failed:', e.message)
        }

        // Fallback â€” will likely fail but gives a clear error
        console.error('[ADB] Not found in any known location. User needs to install ADB or use the auto-installer.')
        this.adbPath = adbBin
        return adbBin
    }

    /**
     * Execute an ADB command and return the result
     */
    async _runAdbRaw(adb, fullArgs, timeoutMs = 30000, options = {}) {
        const token = {}
        let started = false
        const { allowAfterAbort = false, ...managerOptions } = options
        const result = await this._runAdb(adb, fullArgs, timeoutMs, {
            ...managerOptions,
            signal: allowAfterAbort ? undefined : this._adbAbortController.signal,
            onProcessStart: child => {
                started = true
                this._activeAdbProcesses.add(token)
                try { managerOptions.onProcessStart?.(child) } catch (_) {}
            },
            onProcessClose: child => {
                this._activeAdbProcesses.delete(token)
                this._uncertainAdbProcesses.delete(token)
                try { managerOptions.onProcessClose?.(child) } catch (_) {}
                if (this._uncertainAdbProcesses.size || !this._quarantinedModuleRunRelease) return
                this._quarantinedModuleRunRelease.recover()
                this._quarantinedModuleRunRelease = null
            },
        })
        if (result.code === 0) {
            // In-band device-liveness corroboration: the run proving the phone
            // alive with its OWN adb call is stronger evidence than the background
            // probe, and it covers _recoverNetwork / am switch-user / airplane
            // wraps for free instead of enumerating them.
            try { this._onAdbAlive?.() } catch (_) {}
            return result
        }

        const lifecycleError = String(result.error || '')
        if (started && this._activeAdbProcesses.has(token) && (result.timedOut || /aborted/i.test(lifecycleError))) {
            this._uncertainAdbProcesses.add(token)
        }
        const error = new Error(result.stderr || lifecycleError || `ADB command failed with exit code ${result.code ?? 'unknown'}`)
        if (/aborted/i.test(lifecycleError)) error.code = 'ADB_PROCESS_ABORTED'
        else if (result.timedOut) error.code = 'ADB_TIMEOUT'
        else error.code = 'ADB_COMMAND_FAILED'
        error.exitCode = result.code
        error.stdout = result.stdout
        error.stderr = result.stderr
        throw error
    }

    async _runAdbProcess(adb, fullArgs, timeoutMs = 30000, options = {}) {
        const result = await this._runAdbRaw(adb, fullArgs, timeoutMs, options)
        return result.stdout.trim()
    }

    _moduleAbortedError() {
        const error = new Error('Module was aborted')
        error.code = 'MODULE_ABORTED'
        return error
    }

    async executeADB(args, deviceId = null, attempt = 0, options = {}) {
        if (this.abortRequested && !options.allowAfterAbort) throw this._moduleAbortedError()
        const adb = this.getADBPath()
        const fullArgs = deviceId ? ['-s', deviceId, ...args] : args

        try {
            if (options.raw) {
                // `content query` reports provider/permission/invalid-token
                // failures on stderr with exit code 0, and the trimmed-stdout
                // path drops them — so a broken query was indistinguishable from
                // "the row is not indexed yet" (2026-07-26 profile 19 push).
                const result = await this._runAdbRaw(adb, fullArgs, options.timeoutMs ?? 30000, { allowAfterAbort: options.allowAfterAbort, maxOutputBytes: options.maxOutputBytes })
                return { stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() }
            }
            return await this._runAdbProcess(adb, fullArgs, options.timeoutMs ?? 30000, { allowAfterAbort: options.allowAfterAbort, maxOutputBytes: options.maxOutputBytes })
        } catch (error) {
                if (error?.code === 'ADB_PROCESS_ABORTED') throw error
                if (this.abortRequested && !options.allowAfterAbort) throw this._moduleAbortedError()
                const stderr = error?.stderr ? String(error.stderr) : ''
                const stdout = error?.stdout ? String(error.stdout) : ''
                const combinedMessage = [stderr, stdout].filter(Boolean).join(' ')
                const lower = combinedMessage.toLowerCase()

                // Tailscale mid-command transport flakes that are transient and safe to retry once.
                // Mirrors remote_device.py TRANSIENT_PATTERNS list.
                const isTransientFlake = (
                    lower.includes('error: closed') ||
                    lower.includes('error: protocol fault') ||
                    lower.includes('error: connection reset') ||
                    lower.includes('cannot connect to daemon')
                )

                const isDeviceUnavailable = !!deviceId && (
                    lower.includes(`device '${String(deviceId).toLowerCase()}' not found`) ||
                    lower.includes(`device "${String(deviceId).toLowerCase()}" not found`) ||
                    lower.includes('device not found') ||
                    lower.includes('no devices/emulators found') ||
                    lower.includes('device offline') ||
                    lower.includes('device unauthorized')
                )

                // One recovery attempt: restart server + wait briefly for the selected device.
                if (isTransientFlake && attempt === 0) {
                    console.warn('[ADB] Transient transport flake, retrying once')
                    return this.executeADB(args, deviceId, attempt + 1, options)
                }

                if (isDeviceUnavailable && attempt === 0) {
                    try {
                        await this._runAdbProcess(adb, ['start-server'], 8000, { allowAfterAbort: options.allowAfterAbort })
                    } catch {
                        console.warn('[ADB] start-server recovery failed')
                    }

                    try {
                        await this._runAdbProcess(adb, ['-s', deviceId, 'wait-for-device'], 6000, { allowAfterAbort: options.allowAfterAbort })
                    } catch {
                        // Device may truly be unplugged; allow the retry path below to surface cleanly.
                    }

                    return this.executeADB(args, deviceId, attempt + 1, options)
                }

                const finalError = new Error(
                    isDeviceUnavailable
                        ? 'ADB device unavailable'
                        : (isTransientFlake ? 'ADB transport failed' : error.message || 'ADB command failed'),
                )
                finalError.code = error?.code || 'ADB_COMMAND_FAILED'
                if (isDeviceUnavailable) {
                    finalError.code = 'ADB_DEVICE_UNAVAILABLE'
                    finalError.deviceId = deviceId
                }
                throw finalError
        }
    }

    /**
     * Get screen XML dump via ADB.
     * Read-only: attempts via USB twin first (faster, no scrcpy contention);
     * falls back to the original tailnet deviceId on any failure.
     */
    async getScreenDump(deviceId) {
        if (this.abortRequested) return null
        const readDeviceId = await this._resolveReadDeviceId(deviceId)
        try {
            await this.executeADB(['shell', 'uiautomator', 'dump', '--compressed', '/sdcard/window_dump.xml'], readDeviceId)
            const xml = await this.executeADB(['shell', 'cat', '/sdcard/window_dump.xml'], readDeviceId)
            return xml
        } catch (error) {
            if (readDeviceId !== deviceId) {
                // USB twin failed — hard fallback to tailnet
                try {
                    await this.executeADB(['shell', 'uiautomator', 'dump', '--compressed', '/sdcard/window_dump.xml'], deviceId)
                    const xml = await this.executeADB(['shell', 'cat', '/sdcard/window_dump.xml'], deviceId)
                    console.warn(`[ADB] USB-twin dump failed, fell back to tailnet for ${deviceId}`)
                    return xml
                } catch (fallbackError) {
                    console.error('[ADB] Screen dump failed (both USB twin and tailnet):', fallbackError.message)
                    return null
                }
            }
            console.error('[ADB] Screen dump failed:', error.message)
            return null
        }
    }

    /**
     * Read one screen pixel's RGB via raw `screencap` (no PNG decode).
     * `adb exec-out screencap` emits a header [w,h,format,...] then w*h*4 RGBA
     * bytes; the header length is derived as (total - w*h*4) so it works across
     * Android versions. Returns { r, g, b, w, h }.
     * Read-only: attempts via USB twin first; falls back to tailnet on failure.
     */
    async screencapPixel(deviceId, x, y) {
        const readDeviceId = await this._resolveReadDeviceId(deviceId)
        const capture = async target => {
            const chunks = []
            await this._runAdbRaw(
                this.getADBPath(),
                target ? ['-s', target, 'exec-out', 'screencap'] : ['exec-out', 'screencap'],
                15000,
                {
                    captureStdout: false,
                    maxOutputBytes: 64 * 1024 * 1024,
                    onStdoutChunk: chunk => chunks.push(Buffer.from(chunk)),
                },
            )
            return Buffer.concat(chunks)
        }
        let buf
        try {
            buf = await capture(readDeviceId)
        } catch (twinErr) {
            if (readDeviceId !== deviceId) {
                console.warn(`[ADB] USB-twin screencap failed, falling back to tailnet: ${twinErr.message}`)
                buf = await capture(deviceId)
            } else {
                throw twinErr
            }
        }
        if (!buf || buf.length < 16) {
            throw new Error('screencap returned empty/short buffer')
        }
        const w = buf.readUInt32LE(0)
        const h = buf.readUInt32LE(4)
        // Sanity-check w/h before calculating header to detect corruption and
        // prevent precision loss from large products. Allow up to 3000.
        if (w < 100 || h < 100 || w > 3000 || h > 3000) {
            throw new Error(`screencap w=${w} h=${h} out of plausible range`)
        }
        const header = buf.length - (w * h * 4)
        if (header < 12 || x < 0 || y < 0 || x >= w || y >= h) {
            throw new Error(`screencap pixel out of range (${x},${y}) for ${w}x${h} header=${header}`)
        }
        const off = header + ((y * w) + x) * 4
        return { r: buf[off], g: buf[off + 1], b: buf[off + 2], w, h }
    }

    /**
     * Get current foreground app package
     */
    async getCurrentApp(deviceId) {
        try {
            return await this.getForegroundPackage(deviceId)
        } catch (error) {
            return null
        }
    }

    /**
     * Check if app is installed
     */
    async isAppInstalled(deviceId, packageName) {
        try {
            const result = await this.executeADB(['shell', 'pm', 'list', 'packages', packageName], deviceId)
            return String(result || '')
                .split(/\r?\n/)
                .some(line => line.trim() === `package:${packageName}`)
        } catch (error) {
            return false
        }
    }

    async getCurrentAndroidUser(deviceId) {
        try {
            const result = await this.executeADB(['shell', 'am', 'get-current-user'], deviceId)
            const match = String(result || '').match(/\d+/)
            return match ? match[0] : null
        } catch {
            return null
        }
    }

    async isAppInstalledForCurrentUser(deviceId, packageName) {
        const userId = await this.getCurrentAndroidUser(deviceId)
        const args = userId
            ? ['shell', 'pm', 'list', 'packages', '--user', userId, packageName]
            : ['shell', 'pm', 'list', 'packages', packageName]

        try {
            const result = await this.executeADB(args, deviceId)
            return String(result || '')
                .split(/\r?\n/)
                .some(line => line.trim() === `package:${packageName}`)
        } catch {
            return false
        }
    }

    async installExistingForCurrentUser(deviceId, packageName) {
        const userId = await this.getCurrentAndroidUser(deviceId)
        if (!userId) return

        const attempts = [
            ['shell', 'cmd', 'package', 'install-existing', '--user', userId, packageName],
            ['shell', 'pm', 'install-existing', '--user', userId, packageName],
        ]

        for (const args of attempts) {
            try {
                const result = await this.executeADB(args, deviceId)
                if (/installed|package/i.test(result || '')) {
                    return
                }
            } catch {
                // Package may already be enabled, or may not exist on this device.
            }
        }
    }

    async _executeAdbCleanup(args, deviceId = null) {
        return this.executeADB(args, deviceId, 0, { allowAfterAbort: true })
    }

    async hasCompatibleAdbKeyboard(deviceId) {
        if (this._adbKeyboardCompatibility.has(deviceId)) return true
        try {
            await this.installExistingForCurrentUser(deviceId, 'com.android.adbkeyboard')
            const pathResult = await this.executeADB(
                ['shell', 'pm', 'path', 'com.android.adbkeyboard'],
                deviceId,
            )
            const apkPath = String(pathResult || '').split(/\r?\n/)
                .map(line => line.replace(/^package:/, '').trim())
                .find(Boolean)
            if (!apkPath) return false
            const digest = await this.executeADB(['shell', 'sha256sum', apkPath], deviceId)
            const hash = String(digest || '').trim().match(/^([a-fA-F0-9]{64})\b/)?.[1]?.toLowerCase()
            if (hash !== ADB_KEYBOARD_SHA256) return false
            this._adbKeyboardCompatibility.add(deviceId)
            return true
        } catch {
            return false
        }
    }

    async enablePackageForCurrentUser(deviceId, packageName) {
        const userId = await this.getCurrentAndroidUser(deviceId)
        if (!userId) return

        try {
            await this.executeADB(['shell', 'pm', 'enable', '--user', userId, packageName], deviceId)
        } catch {
            // Some system packages are already enabled or cannot be toggled by shell.
        }
    }

    async getForegroundPackage(deviceId) {
        const dumpsysCommands = [
            ['shell', 'dumpsys', 'activity', 'activities'],
            ['shell', 'dumpsys', 'window'],
        ]

        for (const args of dumpsysCommands) {
            try {
                const result = await this.executeADB(args, deviceId)
                const text = String(result || '')
                const match =
                    text.match(/mResumedActivity:.*?\s([a-zA-Z0-9_.]+)\//) ||
                    text.match(/topResumedActivity=.*?\s([a-zA-Z0-9_.]+)\//) ||
                    text.match(/mCurrentFocus=.*?\s([a-zA-Z0-9_.]+)\//) ||
                    text.match(/mFocusedApp=.*?\s([a-zA-Z0-9_.]+)\//) ||
                    text.match(/mFocusedWindow=.*?\s([a-zA-Z0-9_.]+)\//)

                if (match) return match[1]
            } catch {
                // Try the next dumpsys source.
            }
        }

        return null
    }

    async resolveLaunchComponent(deviceId, packageName) {
        const resolveCommands = [
            ['shell', 'cmd', 'package', 'resolve-activity', '--brief', packageName],
            ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName],
        ]

        for (const args of resolveCommands) {
            try {
                const result = await this.executeADB(args, deviceId)
                const component = String(result || '')
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .find(line => /^[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.$]+$/.test(line))
                if (component) return component
            } catch {
                // Some Android builds do not support this exact resolve form.
            }
        }

        return null
    }

    async launchApp(deviceId, packageName) {
        const pkg = String(packageName || '').trim()
        if (!pkg) {
            throw new Error('No package name provided for launch_app')
        }

        // GrapheneOS secondary profiles often have the APK available but not
        // installed for the active user. Expose it before launching when possible.
        if (!(await this.isAppInstalledForCurrentUser(deviceId, pkg))) {
            await this.installExistingForCurrentUser(deviceId, pkg)
        }
        await this.enablePackageForCurrentUser(deviceId, pkg)

        const component = await this.resolveLaunchComponent(deviceId, pkg)
        const launchAttempts = [
            ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
            component ? ['shell', 'am', 'start', '--user', 'current', '-n', component] : null,
            ['shell', 'am', 'start', '--user', 'current', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg],
        ].filter(Boolean)

        let lastError = null
        let lastOutput = ''

        for (const args of launchAttempts) {
            try {
                lastOutput = await this.executeADB(args, deviceId)
            } catch (error) {
                lastError = error
            }

            await new Promise(resolve => setTimeout(resolve, 650))
            const foreground = await this.getForegroundPackage(deviceId)
            if (foreground === pkg || (foreground && foreground.startsWith(`${pkg}.`))) {
                return { output: lastOutput, foreground }
            }
        }

        const installedForUser = await this.isAppInstalledForCurrentUser(deviceId, pkg)
        const installedSomewhere = installedForUser || (await this.isAppInstalled(deviceId, pkg))
        const detail = String(lastError?.message || lastOutput || 'no launcher activity reached foreground')
            .replace(/\s+/g, ' ')
            .slice(0, 700)

        if (!installedSomewhere) {
            throw new Error(`${pkg} is not installed on this phone. Install it in the active GrapheneOS profile, then run the module again.`)
        }

        if (!installedForUser) {
            throw new Error(`${pkg} is installed on the phone but not available in the active GrapheneOS profile. Install or enable it for the current profile, then run the module again. Last launch detail: ${detail}`)
        }

        throw new Error(`Could not launch ${pkg} in the active Android profile. Last launch detail: ${detail}`)
    }

    /**
     * Get device screen resolution
     */
    async getScreenSize(deviceId) {
        try {
            const result = await this.executeADB(['shell', 'wm', 'size'], deviceId)
            const match = result.match(/Physical size: (\d+)x(\d+)/)
            if (match) {
                return { width: parseInt(match[1]), height: parseInt(match[2]) }
            }
        } catch (error) {
            // Ignore
        }
        return { width: 1080, height: 1920 } // Default
    }

    /**
     * Parse bounds string "[x1,y1][x2,y2]" to center coordinates
     */
    parseBounds(boundsStr) {
        const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
        if (match) {
            return {
                x: Math.floor((parseInt(match[1]) + parseInt(match[3])) / 2),
                y: Math.floor((parseInt(match[2]) + parseInt(match[4])) / 2),
                x1: parseInt(match[1]),
                y1: parseInt(match[2]),
                x2: parseInt(match[3]),
                y2: parseInt(match[4])
            }
        }
        return null
    }

    /**
     * Find an element on screen by various selectors
     * Returns center coordinates { x, y } or null
     */
    async findElement(deviceId, params) {
        const xml = await this.getScreenDump(deviceId)
        if (!xml) return null

        const {
            resource_id, resourceId,
            text,
            content_desc, contentDesc, contentDescription,
            class_name, className,
            xpath,
            index
        } = params

        // Try to find by resource-id
        const rid = resource_id || resourceId
        if (rid) {
            const match = xml.match(new RegExp(`resource-id="${rid}"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'i'))
            if (match) return this.parseBounds(match[1])
        }

        // Try to find by text (exact match)
        if (text) {
            const match = xml.match(new RegExp(`text="${text}"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'i'))
            if (match) return this.parseBounds(match[1])

            // Also try text that contains
            const containsMatch = xml.match(new RegExp(`text="[^"]*${text}[^"]*"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'i'))
            if (containsMatch) return this.parseBounds(containsMatch[1])
        }

        // Try to find by content-desc
        const cd = content_desc || contentDesc || contentDescription
        if (cd) {
            const match = xml.match(new RegExp(`content-desc="${cd}"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'i'))
            if (match) return this.parseBounds(match[1])

            // Also try content-desc that contains
            const containsMatch = xml.match(new RegExp(`content-desc="[^"]*${cd}[^"]*"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'i'))
            if (containsMatch) return this.parseBounds(containsMatch[1])
        }

        // Try to find by class name
        const cn = class_name || className
        if (cn) {
            const match = xml.match(new RegExp(`class="${cn}"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'i'))
            if (match) return this.parseBounds(match[1])
        }

        return null
    }

    /**
     * Find all matching elements on screen
     * Returns array of { x, y, bounds, text, resourceId } objects
     */
    async findElements(deviceId, params) {
        const xml = await this.getScreenDump(deviceId)
        if (!xml) return []

        const elements = []
        const { resource_id, resourceId, text, content_desc, contentDesc, class_name, className } = params

        // Build regex pattern based on selector
        let pattern = null
        const rid = resource_id || resourceId
        const cd = content_desc || contentDesc
        const cn = class_name || className

        if (rid) {
            pattern = new RegExp(`resource-id="${rid}"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'gi')
        } else if (text) {
            pattern = new RegExp(`text="${text}"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'gi')
        } else if (cd) {
            pattern = new RegExp(`content-desc="${cd}"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'gi')
        } else if (cn) {
            pattern = new RegExp(`class="${cn}"[^>]*bounds="(\\[[^\\]]+\\]\\[[^\\]]+\\])"`, 'gi')
        }

        if (pattern) {
            let match
            while ((match = pattern.exec(xml)) !== null) {
                const coords = this.parseBounds(match[1])
                if (coords) {
                    elements.push(coords)
                }
            }
        }

        return elements
    }

    /**
     * Wait for element to appear on screen
     */
    async waitForElement(deviceId, options, timeout = 10000) {
        const { text, resourceId, resource_id, contentDesc, content_desc } = options
        const startTime = Date.now()

        while (Date.now() - startTime < timeout) {
            const xml = await this.getScreenDump(deviceId)
            if (!xml) {
                await new Promise(r => setTimeout(r, 500))
                continue
            }

            // Check for element by various selectors
            const rid = resourceId || resource_id
            const cd = contentDesc || content_desc

            if (text && xml.includes(`text="${text}"`)) return true
            if (rid && xml.includes(`resource-id="${rid}"`)) return true
            if (cd && xml.includes(`content-desc="${cd}"`)) return true

            await new Promise(r => setTimeout(r, 500))
        }

        return false
    }

    /**
     * Execute a single command from the server
     * Supports all ADB actions needed for Instagram, social media, and system modules
     */
    async _queryOwnerDownloads(deviceId, intent) {
        const where = `title='${sqlStringValue(intent.remote_filename)}' AND uri='${sqlStringValue(intent.request_url)}'`
        return ownerProviderRows(await this.executeADB(['shell',
            `content query --user 0 --uri content://downloads/my_downloads --projection _id:title:uri:hint:_data:status:destination:uid:notificationpackage:mimetype:total_bytes:current_bytes --where ${quoteAndroidShellValue(where)}`,
        ], deviceId, 1, { raw: true, timeoutMs: 5000 }))
    }

    async _verifyOwnerDocumentBytes(deviceId, entry, { expectMissing = false, rowAbsenceVerified = false } = {}) {
        if (expectMissing && (expectMissing !== true || rowAbsenceVerified !== true
            || typeof entry.download_id !== 'string' || !/^[1-9]\d*$/.test(entry.download_id)
            || entry.document_uri !== `content://0@com.android.providers.downloads.documents/document/${entry.download_id}`)) {
            throw new Error('Owner document absence requires a verified exact missing row')
        }
        const digest = createHash('sha256')
        let size = 0
        const diagnostic = []
        const result = await this._runAdbRaw(this.getADBPath(), [
            '-s', deviceId, 'exec-out', 'content', 'read', '--user', '0', '--uri', entry.document_uri,
        ], 20000, {
            captureStdout: false, maxOutputBytes: expectMissing ? 4096 : entry.size_bytes + 65536,
            onStdoutChunk: chunk => {
                if (!Buffer.isBuffer(chunk)) throw new Error('Owner document read did not return raw bytes')
                size += chunk.length
                if (expectMissing) {
                    if (size > 4096) throw new Error('Owner document missing-file diagnostic exceeds its bound')
                    diagnostic.push(Buffer.from(chunk))
                    return
                }
                if (size > entry.size_bytes) throw new Error('Owner document byte stream exceeds the planned size')
                digest.update(chunk)
            },
        })
        if (expectMissing) {
            const stderr = String(result.stderr || '')
            const boundStderr = new RegExp(`^java\\.io\\.FileNotFoundException: No entry for download ${entry.download_id}(?:\\r?\\n)?$`)
            if (result.code === 0 && !result.stdout && size === 0 && boundStderr.test(stderr)) return
            if (result.code === 0 && !result.stdout && stderr === '' && size > 0) {
                let text = ''
                try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(diagnostic)) } catch {}
                const lines = text.replace(/\r\n/g, '\n').split('\n')
                const frames = [
                    /^\tat android\.database\.DatabaseUtils\.readExceptionWithFileNotFoundExceptionFromParcel\(DatabaseUtils\.java:\d+\)$/,
                    /^\tat android\.content\.ContentProviderProxy\.openFile\(ContentProviderNative\.java:\d+\)$/,
                    /^\tat com\.android\.commands\.content\.Content\$ReadCommand\.onExecute\(Content\.java:\d+\)$/,
                    /^\tat com\.android\.commands\.content\.Content\$Command\.execute\(Content\.java:\d+\)$/,
                    /^\tat com\.android\.commands\.content\.Content\.main\(Content\.java:\d+\)$/,
                    /^\tat com\.android\.internal\.os\.RuntimeInit\.nativeFinishInit\(Native Method\)$/,
                    /^\tat com\.android\.internal\.os\.RuntimeInit\.main\(RuntimeInit\.java:\d+\)$/,
                ]
                if (lines.length === 10 && lines[0] === 'Error while accessing provider:0@com.android.providers.downloads.documents'
                    && new RegExp(`^java\\.io\\.FileNotFoundException: No file found for content://downloads/all_downloads/${entry.download_id} as UID \\d+$`).test(lines[1])
                    && frames.every((frame, index) => frame.test(lines[index + 2])) && lines[9] === '') return
            }
            throw new Error('Owner document removal could not be verified')
        }
        if (String(result.stderr || '').trim() || size !== entry.size_bytes || digest.digest('hex') !== entry.sha256) {
            throw new Error('Owner document bytes do not match the exact transfer manifest')
        }
    }

    async _stageOwnerDocument(plan, params, failure, { serverPort, indexToFile }) {
        if (!canStageOwnerDocument(plan, params, failure)) throw new Error('Owner document staging is not eligible for this transfer')
        const original = plan.manifest[0]
        await verifyLocalManifestEntry(original)
        const handle = await fs.promises.open(original.source_path, 'r')
        const signature = Buffer.alloc(8)
        try { await handle.read(signature, 0, 8, 0) } finally { await handle.close() }
        if (signature.toString('hex') !== '89504e470d0a1a0a') throw new Error('Owner document staging requires an actual PNG image')
        if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535 || !(indexToFile instanceof Map)) {
            throw new Error('Owner document staging requires this transfer\'s live HTTP server')
        }
        const route = randomUUID()
        const intent = {
            ...original, source_profile: '0',
            staging_destination: `/storage/emulated/0/Download/${original.remote_filename}`,
            request_url: `http://localhost:${serverPort}/${route}`,
        }
        if ((await this._queryOwnerDownloads(plan.device_id, intent)).length) throw new Error('Owner download selector already exists')
        await writeOwnerRecord(original, 'intent', {
            staging_destination: intent.staging_destination, request_url: intent.request_url,
            consent: true, mime_type: 'image/png',
        })
        indexToFile.set(route, original)
        try {
            const bind = (key, type, value) => `--bind ${quoteAndroidShellValue(`${key}:${type}:${String(value).replace(/:/g, '\\:')}`)}`
            const inserted = normalizeExecOutput(await this.executeADB(['shell', [
                'content insert --user 0 --uri content://downloads/my_downloads',
                bind('is_public_api', 'b', 'true'), bind('destination', 'i', '4'),
                bind('uri', 's', intent.request_url), bind('hint', 's', `file://${intent.staging_destination}`),
                bind('title', 's', original.remote_filename), bind('mimetype', 's', 'image/png'),
                bind('visibility', 'i', '1'), bind('notificationpackage', 's', 'com.android.shell'),
            ].join(' ')], plan.device_id, 1, { raw: true, timeoutMs: 5000 }))
            if (inserted.stderr.trim() || /Exception|Error while|Permission Denial/i.test(inserted.stdout)) {
                throw new Error('Owner DownloadProvider insert failed; staging intent requires reconciliation')
            }
            const deadline = Date.now() + 30000
            let rowId = null
            let row
            while (Date.now() < deadline) {
                if (this.abortRequested) throw this._moduleAbortedError()
                const rows = await this._queryOwnerDownloads(plan.device_id, intent)
                if (rows.length !== 1) throw new Error('Owner download did not resolve to one exact owned row')
                row = assertOwnerRow(rows[0], { ...intent, download_id: rowId }, { completed: false })
                if (rowId === null) {
                    rowId = row._id
                    await writeOwnerRecord(original, 'row', { download_id: rowId })
                }
                if (row.status === '200') break
                if (!/^19[0-9]$/.test(row.status)) throw new Error('Owner download failed before completion')
                await new Promise(resolve => setTimeout(resolve, 500))
            }
            assertOwnerRow(row, { ...intent, download_id: rowId })
            const { phone_destination, ...retained } = original
            const entry = Object.freeze({
                ...retained, method: OWNER_DOCUMENT_METHOD, source_profile: '0',
                download_id: rowId, document_uri: `content://0@com.android.providers.downloads.documents/document/${rowId}`,
                staging_destination: intent.staging_destination, allowed_post_module: 'post_feed',
                device_selection: 'pending_exact_document_share',
            })
            await this._verifyOwnerDocumentBytes(plan.device_id, entry)
            await writeOwnerRecord(entry, 'verified', { download_id: rowId, document_uri: entry.document_uri })
            const staged = Object.freeze({ ...plan, manifest: Object.freeze([entry]) })
            plannerMintedTransfers.add(staged)
            return staged
        } finally {
            indexToFile.delete(route)
        }
    }

    async _shareOwnerDocument(deviceId, params, runContext) {
        const reservation = runContext?.transferReservation
        const record = reservation && pendingTransfers.get(reservation.transfer_id)
        if (runContext?.moduleId !== 'post_feed' || !record
            || record.reservation_id !== reservation.reservation_id
            || record.remaining[0] !== reservation.entry
            || record.plan.device_id !== deviceId
            || reservation.entry.method !== OWNER_DOCUMENT_METHOD) {
            throw new Error('Owner document share requires the current Feed reservation')
        }
        if (Object.keys(params).length !== 1 || params.transfer_id !== reservation.transfer_id) {
            throw new Error('Owner document share accepts only the exact transfer_id')
        }
        if (record.ownerDispatchAttempted) throw new Error('Owner document permits only a single dispatch')
        const entry = reservation.entry
        const folder = ownerStagingDirectory(entry)
        const intent = validateOwnerIntent(readOwnerRecord(path.join(folder, 'intent.json')), folder)
        if (intent.transfer_id !== entry.transfer_id || intent.sha256 !== entry.sha256
            || intent.device_id !== deviceId || intent.account_username !== entry.account_username
            || intent.phone_profile !== entry.phone_profile || intent.source_profile !== '0'
            || intent.staging_destination !== entry.staging_destination) {
            throw new Error('Owner document staging intent does not match the current reservation')
        }
        const currentUser = async () => String(await this.executeADB(['shell', 'am', 'get-current-user'], deviceId, 1, { timeoutMs: 5000 })).trim()
        if (await currentUser() !== entry.phone_profile) throw new Error('Owner document target profile is no longer active')
        const rows = await this._queryOwnerDownloads(deviceId, intent)
        if (rows.length !== 1) throw new Error('Owner document row is absent or ambiguous')
        assertOwnerRow(rows[0], { ...intent, download_id: entry.download_id })
        await this._verifyOwnerDocumentBytes(deviceId, entry)
        const resolution = normalizeExecOutput(await this.executeADB(['shell',
            `cmd package query-activities --user ${entry.phone_profile} -a android.intent.action.SEND -t image/png -d ${quoteAndroidShellValue(entry.document_uri)} -p com.instagram.android`,
        ], deviceId, 1, { raw: true, timeoutMs: 5000 }))
        const activities = resolution.stdout.split(/^\s*Activity #\d+:\s*$/m).slice(1)
            .map(block => block.split(/^\s*ApplicationInfo:\s*$/m)[0])
        const feedHandlers = activities.filter(block => /^\s*name=com\.instagram\.share\.handleractivity\.ShareHandlerActivity\s*$/m.test(block))
        if (resolution.stderr.trim() || feedHandlers.length !== 1
            || !/^\s*packageName=com\.instagram\.android\s*$/m.test(feedHandlers[0])
            || !/^\s*enabled=true exported=true\b/m.test(feedHandlers[0])
            || !/\bisDefault=true\b/.test(feedHandlers[0])) {
            throw new Error('The supported Instagram Feed share handler is unavailable or ambiguous')
        }
        if (await currentUser() !== entry.phone_profile) throw new Error('Owner document target profile changed before sharing')
        if (record.ownerDispatchAttempted) throw new Error('Owner document permits only a single dispatch')
        record.ownerDispatchAttempted = true
        const dispatchId = randomUUID()
        await writeOwnerRecord(entry, 'dispatch-intent', {
            download_id: entry.download_id, document_uri: entry.document_uri,
            reservation_id: reservation.reservation_id, dispatch_id: dispatchId,
        })
        const started = normalizeExecOutput(await this.executeADB(['shell',
            `am start --user ${entry.phone_profile} -a android.intent.action.SEND -n ${OWNER_FEED_COMPONENT} -t image/png -d ${quoteAndroidShellValue(entry.document_uri)} --eu android.intent.extra.STREAM ${quoteAndroidShellValue(entry.document_uri)} --grant-read-uri-permission`,
        ], deviceId, 1, { raw: true, timeoutMs: 5000 }))
        if (started.stderr.trim() || !/^Starting: Intent\s*\{/m.test(started.stdout)
            || /Error:|Exception|Permission Denial|unable to resolve/i.test(started.stdout)) {
            throw new Error('Owner document share dispatch could not be confirmed; reconcile the current editor before retrying')
        }
        const proof = Object.freeze({
            success: true, action: 'share_owner_document', method: OWNER_DOCUMENT_METHOD,
            transfer_id: entry.transfer_id, reservation_id: reservation.reservation_id, dispatch_id: dispatchId,
            device_id: entry.device_id, account_username: entry.account_username,
            source_profile: '0', phone_profile: entry.phone_profile,
            download_id: entry.download_id, document_uri: entry.document_uri,
            remote_filename: entry.remote_filename, size_bytes: entry.size_bytes, sha256: entry.sha256,
            component: OWNER_FEED_COMPONENT, uri_grant: 'read',
            selection_verified: 'exact_document_bytes', share_dispatched: true,
        })
        await writeOwnerRecord(entry, 'dispatch-confirmed', proof)
        record.ownerDispatch = proof
        return proof
    }

    async _readOwnerCleanupScreen(deviceId) {
        const dumpPath = `/sdcard/sp_owner_cleanup_${randomUUID()}.xml`
        try {
            const dump = normalizeExecOutput(await this.executeADB(['shell', 'uiautomator', 'dump', '--compressed', dumpPath], deviceId, 1, { raw: true, timeoutMs: 10000, maxOutputBytes: 65536 }))
            if (dump.stderr.trim() || !dump.stdout.includes(`UI hierchary dumped to: ${dumpPath}`)) throw new Error('Owner cleanup screen capture was not confirmed')
            const screen = normalizeExecOutput(await this.executeADB(['shell', 'cat', dumpPath], deviceId, 1, { raw: true, timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024 }))
            if (screen.stderr.trim()) throw new Error('Owner cleanup screen could not be read')
            return screen.stdout
        } finally {
            try { await this.executeADB(['shell', 'rm', '-f', dumpPath], deviceId, 1, { allowAfterAbort: true, timeoutMs: 3000 }) } catch {}
        }
    }

    async _cleanupOwnerIntent(intent) {
        const folder = ownerStagingDirectory(intent)
        validateOwnerIntent(intent, folder)
        const completePath = path.join(folder, 'cleanup-complete.json')
        if (fs.existsSync(completePath)) {
            const complete = validateOwnerRecordBinding(readOwnerRecord(completePath), intent, 'cleanup-complete')
            if (complete.cleaned !== true || (complete.download_id !== null && !/^[1-9]\d*$/.test(complete.download_id))) {
                throw new Error('Owner cleanup record is invalid')
            }
            return { cleaned: true, cleanup_pending: false }
        }
        const rowPath = path.join(folder, 'row.json')
        const rowRecord = fs.existsSync(rowPath) ? validateOwnerRecordBinding(readOwnerRecord(rowPath), intent, 'row') : null
        if (rowRecord && !/^[1-9]\d*$/.test(rowRecord.download_id)) {
            throw new Error('Owner staging row record does not match its intent')
        }
        let downloadId = rowRecord?.download_id || null
        const abandonmentPath = path.join(folder, 'unpublished-abandoned.json')
        const abandonment = fs.existsSync(abandonmentPath) ? readOwnerAbandonment(intent) : null
        if (abandonment && (abandonment.download_id !== downloadId
            || abandonment.document_uri !== `content://0@com.android.providers.downloads.documents/document/${downloadId}`)) {
            throw new Error('Owner abandonment document does not match its row')
        }
        const verifyCurrentProfile = async () => {
            const currentUser = String(await this.executeADB(['shell', 'am', 'get-current-user'], intent.device_id, 1, { timeoutMs: 5000 })).trim()
            if (currentUser !== intent.phone_profile) throw new Error('Owner cleanup target profile is no longer active')
            if (abandonment && !ownerEditorIsClosed(await this._readOwnerCleanupScreen(intent.device_id), intent.account_username)) {
                throw new Error('Owner abandonment account and editor closure could not be confirmed')
            }
            if (abandonment && String(await this.executeADB(['shell', 'am', 'get-current-user'], intent.device_id, 1, { timeoutMs: 5000 })).trim() !== intent.phone_profile) {
                throw new Error('Owner abandonment profile changed during identity verification')
            }
        }
        await verifyCurrentProfile()
        const rows = await this._queryOwnerDownloads(intent.device_id, intent)
        if (rows.length > 1) throw new Error('Owner cleanup selector is ambiguous')
        if (rows.length) {
            const row = assertOwnerRow(rows[0], { ...intent, download_id: downloadId }, { completed: false })
            downloadId = row._id
            const entry = { ...intent, download_id: downloadId, document_uri: `content://0@com.android.providers.downloads.documents/document/${downloadId}` }
            if (row.status === '200') {
                assertOwnerRow(row, entry)
                await this._verifyOwnerDocumentBytes(intent.device_id, entry)
            } else if (row._data !== 'NULL' && row._data !== intent.staging_destination) {
                throw new Error('Owner partial download path is foreign')
            }
            if (fs.existsSync(path.join(folder, 'dispatch-intent.json')) && !ownerEditorIsClosed(await this._readOwnerCleanupScreen(intent.device_id))) {
                throw new Error('Owner document editor closure could not be confirmed')
            }
            await verifyCurrentProfile()
            const where = `_id=${downloadId} AND title='${sqlStringValue(intent.remote_filename)}' AND uid=2000 AND notificationpackage='com.android.shell'`
            const deleted = normalizeExecOutput(await this.executeADB(['shell',
                `content delete --user 0 --uri content://downloads/my_downloads/${downloadId} --where ${quoteAndroidShellValue(where)}`,
            ], intent.device_id, 1, { raw: true, timeoutMs: 5000 }))
            if (deleted.stderr.trim() || !/^Deleted 1 rows\.?\s*$/.test(deleted.stdout.trim())) throw new Error('Owner download deletion was not confirmed')
        }
        if ((await this._queryOwnerDownloads(intent.device_id, intent)).length) throw new Error('Owner download row remains after cleanup')
        if (downloadId) await this._verifyOwnerDocumentBytes(intent.device_id, {
            ...intent, download_id: downloadId, document_uri: `content://0@com.android.providers.downloads.documents/document/${downloadId}`,
        }, { expectMissing: true, rowAbsenceVerified: true })
        await writeOwnerRecord(intent, 'cleanup-complete', { download_id: downloadId, cleaned: true })
        return { cleaned: true, cleanup_pending: false }
    }

    async _settleOwnerDocument(reservation, { published = false, abandonment = null } = {}) {
        const entry = reservation?.entry
        if (entry?.method !== OWNER_DOCUMENT_METHOD) return null
        const folder = ownerStagingDirectory(entry)
        try {
            const intent = validateOwnerIntent(readOwnerRecord(path.join(folder, 'intent.json')), folder)
            const dispatched = fs.existsSync(path.join(folder, 'dispatch-intent.json'))
            const abandoned = dispatched && !published && hasOwnerAbandonmentProof(reservation, abandonment)
            if (dispatched && !published && !abandoned) return { cleaned: false, cleanup_pending: true }
            if (abandoned) {
                if (this.abortRequested) throw new Error('Owner abandonment was interrupted')
                const currentUser = String(await this.executeADB(['shell', 'am', 'get-current-user'], intent.device_id, 1, { timeoutMs: 5000 })).trim()
                if (currentUser !== intent.phone_profile
                    || !ownerEditorIsClosed(await this._readOwnerCleanupScreen(intent.device_id), intent.account_username)) {
                    throw new Error('Owner abandonment target and closed account screen are unverified')
                }
                if (!fs.existsSync(path.join(folder, 'unpublished-abandoned.json'))) {
                    await writeOwnerRecord(entry, 'unpublished-abandoned', abandonment)
                }
                const stored = readOwnerAbandonment(intent)
                if (stored.reservation_id !== reservation.reservation_id || stored.dispatch_id !== abandonment.dispatch_id) {
                    throw new Error('Owner abandonment reservation changed')
                }
            }
            const terminalPath = path.join(folder, 'terminal.json')
            if (!fs.existsSync(terminalPath)) await writeOwnerRecord(entry, 'terminal', {
                published, safe_before_dispatch: !dispatched,
                ...(abandoned ? { unpublished_abandoned: true, reservation_id: abandonment.reservation_id, dispatch_id: abandonment.dispatch_id } : {}),
            })
            const terminal = validateOwnerRecordBinding(readOwnerRecord(terminalPath), intent, 'terminal')
            if (terminal.published !== published || terminal.safe_before_dispatch !== !dispatched) throw new Error('Owner terminal state changed')
            if (abandoned && (terminal.unpublished_abandoned !== true || terminal.reservation_id !== abandonment.reservation_id
                || terminal.dispatch_id !== abandonment.dispatch_id)) throw new Error('Owner abandonment terminal state changed')
            const cleanup = await this._cleanupOwnerIntent(intent)
            if (!published) {
                releaseTransferReservation(reservation)
                discardTransferManifest(reservation.transfer_id)
            }
            return cleanup
        } catch {
            return { cleaned: false, cleanup_pending: true }
        }
    }

    async _reconcileOwnerStaging({ deviceId, targetUser, accountUsername }) {
        const directory = path.join(contentStateRoot(), 'owner-document-staging-v1')
        if (!fs.existsSync(directory)) return []
        const outcomes = []
        for (const candidate of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!candidate.isDirectory() || !/^[a-f0-9]{64}$/.test(candidate.name)) continue
            const folder = path.join(directory, candidate.name)
            const intentPath = path.join(folder, 'intent.json')
            if (!fs.existsSync(intentPath)) continue
            try {
                const intent = validateOwnerIntent(readOwnerRecord(intentPath), folder)
                if (intent.device_id !== deviceId || intent.phone_profile !== targetUser || intent.account_username !== accountUsername) continue
                if (pendingTransfers.get(intent.transfer_id)?.reservation_id) continue
                const dispatchPath = path.join(folder, 'dispatch-intent.json')
                const terminalPath = path.join(folder, 'terminal.json')
                if (fs.existsSync(dispatchPath)) {
                    const terminal = fs.existsSync(terminalPath) ? validateOwnerRecordBinding(readOwnerRecord(terminalPath), intent, 'terminal') : null
                    let abandoned = false
                    if (terminal?.published === false && terminal.safe_before_dispatch === false && terminal.unpublished_abandoned === true) {
                        const proof = readOwnerAbandonment(intent)
                        abandoned = terminal.reservation_id === proof.reservation_id && terminal.dispatch_id === proof.dispatch_id
                    }
                    if (!abandoned && (terminal?.published !== true || terminal.safe_before_dispatch !== false)) {
                        outcomes.push({ cleaned: false, cleanup_pending: true })
                        continue
                    }
                }
                outcomes.push(await this._cleanupOwnerIntent(intent))
                if (pendingTransfers.has(intent.transfer_id)) discardTransferManifest(intent.transfer_id)
            } catch {
                outcomes.push({ cleaned: false, cleanup_pending: true })
            }
        }
        return outcomes
    }

    async executeCommand(deviceId, command, runContext = null) {
        const { action, params = {} } = command

        // Debug: console.log(`[ADB] Executing: ${action}`, params)

        try {
            if (action === 'share_owner_document') {
                return await this._shareOwnerDocument(deviceId, params, runContext)
            }
            const hasUnicodeChars = (value) => /[^\x20-\x7E\n]/.test(String(value ?? ''))

            const hasShellSensitiveChars = (value) =>
                /[<>&|;'"`\\$!()[\]{}*?%#]/.test(String(value ?? ''))

            const requiresUnicodeIme = (value) =>
                hasUnicodeChars(value) || /[%#]/.test(String(value ?? ''))

            const abortTextInput = () => {
                if (!this.abortRequested) return
                const error = new Error('Module aborted during text input')
                error.code = 'MODULE_ABORTED'
                throw error
            }

            const waitForHumanDelay = async (delayMs) => {
                let remaining = delayMs
                while (remaining > 0) {
                    abortTextInput()
                    const interval = Math.min(50, remaining)
                    await new Promise(resolve => setTimeout(resolve, interval))
                    remaining -= interval
                }
                abortTextInput()
            }

            const inputPlan = (rawText, typingMode) => {
                const normalized = String(rawText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                if (typingMode === 'human') return planHumanTextInput(normalized)
                return { chunks: [normalized], delays_ms: [], total_delay_ms: 0 }
            }

            // Escape shell-significant chars for the device's mksh, then turn
            // spaces into %s (the marker the Android `input text` binary uses).
            //
            // CRITICAL: the replacement here MUST be `\\$1` — one backslash in
            // the output plus the matched character. The previous value
            // `\\\\$1` (two backslashes in the JS source = two literal
            // backslashes in the output) caused mksh to consume the first
            // backslash and pass the second through, so `input text` typed a
            // visible `\?` on the device instead of `?` (same for `!`, `(`,
            // `&`, etc.).
            const encodeAdbText = (value) =>
                String(value ?? '')
                    .replace(/(["'`\\$!&*()[\]{}|;<>?])/g, '\\$1')
                    .replace(/ /g, '%s')

            const typeTextViaAdb = async (rawText, plan, clearFirst = false) => {
                const normalized = String(rawText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                if (!normalized.trim()) return false

                if (clearFirst) {
                    abortTextInput()
                    await this.executeADB(['shell', 'input', 'keycombination', '113', '29'], deviceId)
                    await this.executeADB(['shell', 'input', 'keyevent', '67'], deviceId)
                }

                const chunks = plan?.chunks?.length ? plan.chunks : [normalized]
                for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
                    abortTextInput()
                    const parts = chunks[chunkIndex].split('\n')
                    for (let i = 0; i < parts.length; i++) {
                        const part = parts[i]
                        if (part) {
                            await this.executeADB(['shell', 'input', 'text', encodeAdbText(part)], deviceId)
                        }
                        if (i < parts.length - 1) {
                            await this.executeADB(['shell', 'input', 'keyevent', '66'], deviceId)
                        }
                    }
                    abortTextInput()
                    const delayMs = plan?.delays_ms?.[chunkIndex] || 0
                    if (delayMs > 0) await waitForHumanDelay(delayMs)
                }
                return true
            }

            const typeTextViaUnicodeIme = async (rawText, plan, clearFirst = false) => {
                const normalized = String(rawText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                if (!normalized.trim()) return false

                const unicodeIme = 'com.android.adbkeyboard/.AdbIME'
                let originalIme = ''
                let switchAttempted = false
                let wasEnabledBefore = false
                let injectionAttempted = false
                let restored = false
                let restoreError = null

                try {
                    if (!await this.hasCompatibleAdbKeyboard(deviceId)) return false
                    let imeListAll = await this.executeADB(['shell', 'ime', 'list', '-a'], deviceId).catch(() => '')

                    if (!imeListAll.includes(unicodeIme)) {
                        return false
                    }

                    originalIme = (await this.executeADB(['shell', 'settings', 'get', 'secure', 'default_input_method'], deviceId).catch(() => '') || '').trim()
                    const originalImeIsValid = /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(originalIme)
                        && imeListAll.includes(originalIme)
                    if (!originalImeIsValid) return false
                    const imeListEnabled = await this.executeADB(['shell', 'ime', 'list', '-s'], deviceId).catch(() => '')
                    wasEnabledBefore = imeListEnabled.includes(unicodeIme)

                    if (originalIme !== unicodeIme) {
                        await this.executeADB(['shell', 'ime', 'enable', unicodeIme], deviceId)
                        switchAttempted = true
                        await this.executeADB(['shell', 'ime', 'set', unicodeIme], deviceId)
                        const selectedIme = (await this.executeADB(
                            ['shell', 'settings', 'get', 'secure', 'default_input_method'],
                            deviceId,
                        )).trim()
                        if (selectedIme !== unicodeIme) {
                            const error = new Error('Unicode IME did not become the selected input method')
                            error.code = 'UNICODE_IME_SETUP_FAILED'
                            throw error
                        }
                    }

                    if (clearFirst) {
                        await this.executeADB(['shell', 'am broadcast -a ADB_CLEAR_TEXT -p com.android.adbkeyboard'], deviceId)
                    }

                    const chunks = plan?.chunks?.length ? plan.chunks : [normalized]
                    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
                        abortTextInput()
                        const parts = chunks[chunkIndex].split('\n')
                        for (let i = 0; i < parts.length; i++) {
                            const part = parts[i]
                            if (part) {
                                const b64 = Buffer.from(part, 'utf8').toString('base64')
                                injectionAttempted = true
                                await this.executeADB(['shell', `am broadcast -a ADB_INPUT_B64 -p com.android.adbkeyboard --es msg '${b64}'`], deviceId)
                            }
                            if (i < parts.length - 1) {
                                await this.executeADB(['shell', 'input', 'keyevent', '66'], deviceId)
                            }
                        }
                        abortTextInput()
                        const delayMs = plan?.delays_ms?.[chunkIndex] || 0
                        if (delayMs > 0) await waitForHumanDelay(delayMs)
                    }
                    return true
                } catch (error) {
                    if (error?.code === 'MODULE_ABORTED') throw error
                    if (injectionAttempted) {
                        const partialError = new Error('Unicode IME input failed after injection began')
                        partialError.code = 'UNICODE_INPUT_PARTIAL_FAILURE'
                        throw partialError
                    }
                    console.warn('[ADB] Unicode IME setup failed')
                    return false
                } finally {
                    if (switchAttempted) {
                        try {
                            let selectedIme = (await this._executeAdbCleanup(
                                ['shell', 'settings', 'get', 'secure', 'default_input_method'],
                                deviceId,
                            ).catch(() => '') || '').trim()
                            if (selectedIme !== originalIme) {
                                await this._executeAdbCleanup(['shell', 'ime', 'set', originalIme], deviceId)
                                selectedIme = (await this._executeAdbCleanup(
                                    ['shell', 'settings', 'get', 'secure', 'default_input_method'],
                                    deviceId,
                                )).trim()
                            }
                            if (selectedIme !== originalIme) throw new Error('IME restore was not applied')
                            restored = true
                        } catch {
                            restoreError = new Error('Original input method could not be restored')
                            restoreError.code = 'IME_RESTORE_FAILED'
                        }
                    }
                    // Keep helper IMEs off unless user already had them enabled.
                    if (restored && !wasEnabledBefore) {
                        try {
                            await this._executeAdbCleanup(['shell', 'ime', 'disable', unicodeIme], deviceId)
                        } catch {
                            // Ignore disable failures; module can continue.
                        }
                    }
                    if (restoreError) throw restoreError
                }
            }

            const typeTextSmart = async (rawText, typingMode = 'instant', clearFirst = false) => {
                const normalized = String(rawText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                if (!normalized.trim()) {
                    const error = new Error('Text input cannot be empty')
                    error.code = 'EMPTY_TEXT_INPUT'
                    throw error
                }

                const plan = inputPlan(normalized, typingMode)
                const preferUnicodeIme = hasUnicodeChars(normalized) || hasShellSensitiveChars(normalized)

                if (preferUnicodeIme) {
                    const typedUnicode = await typeTextViaUnicodeIme(normalized, plan, clearFirst)
                    if (typedUnicode) return true
                    if (requiresUnicodeIme(normalized)) {
                        const error = new Error('Unicode-safe input method is unavailable for this text')
                        error.code = 'UNICODE_INPUT_UNAVAILABLE'
                        throw error
                    }
                }

                return typeTextViaAdb(normalized, plan, clearFirst)
            }

            switch (action) {
                // ==================== BASIC INPUT ====================
                case 'tap':
                    await this.executeADB(['shell', 'input', 'tap', String(params.x), String(params.y)], deviceId)
                    break

                case 'double_tap':
                    // 80ms delay between taps for Instagram double-tap like (from old appium module)
                    await this.executeADB(['shell', 'input', 'tap', String(params.x), String(params.y)], deviceId)
                    await new Promise(r => setTimeout(r, 80))
                    await this.executeADB(['shell', 'input', 'tap', String(params.x), String(params.y)], deviceId)
                    break

                case 'long_tap':
                case 'long_press':
                    const duration = params.duration_ms || params.duration || 1000
                    await this.executeADB(['shell', 'input', 'swipe',
                        String(params.x), String(params.y),
                        String(params.x), String(params.y),
                        String(duration)], deviceId)
                    break

                case 'swipe':
                    await this.executeADB(['shell', 'input', 'swipe',
                        String(params.x1 || params.startX), String(params.y1 || params.startY),
                        String(params.x2 || params.endX), String(params.y2 || params.endY),
                        String(params.duration_ms || params.duration || 300)], deviceId)
                    break

                case 'swipe_up':
                    // Swipe up from bottom to top (scroll down content)
                    await this.executeADB(['shell', 'input', 'swipe', '540', '1500', '540', '500', String(params.duration_ms || 300)], deviceId)
                    break

                case 'swipe_down':
                    // Swipe down from top to bottom (scroll up content / refresh)
                    await this.executeADB(['shell', 'input', 'swipe', '540', '500', '540', '1500', String(params.duration_ms || 300)], deviceId)
                    break

                case 'swipe_left':
                    await this.executeADB(['shell', 'input', 'swipe', '900', '1000', '100', '1000', String(params.duration_ms || 300)], deviceId)
                    break

                case 'swipe_right':
                    await this.executeADB(['shell', 'input', 'swipe', '100', '1000', '900', '1000', String(params.duration_ms || 300)], deviceId)
                    break

                case 'scroll':
                    // Generic scroll with direction
                    const scrollDir = params.direction || 'down'
                    const scrollDist = params.distance || 500
                    if (scrollDir === 'down' || scrollDir === 'up') {
                        const startY = scrollDir === 'down' ? 1200 : 700
                        const endY = scrollDir === 'down' ? 700 : 1200
                        await this.executeADB(['shell', 'input', 'swipe', '540', String(startY), '540', String(endY), '300'], deviceId)
                    } else {
                        const startX = scrollDir === 'right' ? 200 : 800
                        const endX = scrollDir === 'right' ? 800 : 200
                        await this.executeADB(['shell', 'input', 'swipe', String(startX), '1000', String(endX), '1000', '300'], deviceId)
                    }
                    break

                // ==================== TEXT INPUT ====================
                case 'input_text':
                case 'type':
                case 'text':
                    // Handle text input via ADB
                    let textToType = String(params.text ?? params.value ?? '')

                    // Keep ASCII fast path, but support Unicode/emoji when available.
                    await typeTextSmart(textToType, params.typing_mode, params.clear_first || params.clear)
                    break

                case 'input_emoji':
                    await typeTextSmart(
                        String(params.text ?? ''),
                        params.typing_mode,
                        params.clear_first || params.clear,
                    )
                    break

                // ==================== KEY EVENTS ====================
                case 'keyevent':
                case 'key':
                    const keycode = params.keycode || params.key || params.code
                    await this.executeADB(['shell', 'input', 'keyevent', String(keycode)], deviceId)
                    break

                case 'back':
                    await this.executeADB(['shell', 'input', 'keyevent', '4'], deviceId) // KEYCODE_BACK
                    break

                case 'home':
                    await this.executeADB(['shell', 'input', 'keyevent', '3'], deviceId) // KEYCODE_HOME
                    break

                case 'recent':
                case 'recents':
                    await this.executeADB(['shell', 'input', 'keyevent', '187'], deviceId) // KEYCODE_APP_SWITCH
                    break

                case 'enter':
                    await this.executeADB(['shell', 'input', 'keyevent', '66'], deviceId) // KEYCODE_ENTER
                    break

                case 'tab':
                    await this.executeADB(['shell', 'input', 'keyevent', '61'], deviceId) // KEYCODE_TAB
                    break

                case 'delete':
                case 'backspace':
                    await this.executeADB(['shell', 'input', 'keyevent', '67'], deviceId) // KEYCODE_DEL
                    break

                case 'power':
                    await this.executeADB(['shell', 'input', 'keyevent', '26'], deviceId) // KEYCODE_POWER
                    break

                case 'volume_up':
                    await this.executeADB(['shell', 'input', 'keyevent', '24'], deviceId)
                    break

                case 'volume_down':
                    await this.executeADB(['shell', 'input', 'keyevent', '25'], deviceId)
                    break

                // ==================== APP MANAGEMENT ====================
                case 'launch_app':
                case 'open_app':
                case 'start_app':
                    const pkg = params.package || params.packageName || params.app
                    const launchResult = await this.launchApp(deviceId, pkg)
                    if (command.wait_after > 0) {
                        await new Promise(resolve => setTimeout(resolve, command.wait_after))
                    }
                    return { success: true, action, ...launchResult }

                case 'launch_activity':
                    await this.executeADB(['shell', 'am', 'start', '-n', params.component], deviceId)
                    break

                case 'force_stop':
                case 'kill_app':
                    await this.executeADB(['shell', 'am', 'force-stop', params.package || params.packageName], deviceId)
                    break

                case 'clear_app':
                case 'clear_data':
                    await this.executeADB(['shell', 'pm', 'clear', params.package || params.packageName], deviceId)
                    break

                // ==================== SYSTEM SETTINGS ====================
                case 'airplane_on':
                    await this.executeADB(['shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'], deviceId)
                    break

                case 'airplane_off':
                    await this.executeADB(['shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], deviceId)
                    break

                case 'airplane_toggle':
                    // Get current state and toggle
                    const airplaneState = await this.executeADB(['shell', 'settings', 'get', 'global', 'airplane_mode_on'], deviceId)
                    const newState = airplaneState.trim() === '1' ? 'disable' : 'enable'
                    await this.executeADB(['shell', 'cmd', 'connectivity', 'airplane-mode', newState], deviceId)
                    break

                case 'wifi_on':
                    await this.executeADB(['shell', 'svc', 'wifi', 'enable'], deviceId)
                    break

                case 'wifi_off':
                    await this.executeADB(['shell', 'svc', 'wifi', 'disable'], deviceId)
                    break

                case 'network_preflight':
                    return this._networkPreflight(deviceId)

                case 'network_recover':
                    return this._recoverNetwork(deviceId, params)

                case 'mobile_data_on':
                    await this.executeADB(['shell', 'svc', 'data', 'enable'], deviceId)
                    break

                case 'mobile_data_off':
                    await this.executeADB(['shell', 'svc', 'data', 'disable'], deviceId)
                    break

                case 'set_brightness':
                    await this.executeADB(['shell', 'settings', 'put', 'system', 'screen_brightness', String(params.value || 128)], deviceId)
                    break

                // ==================== SHELL COMMANDS ====================
                case 'shell':
                case 'exec':
                case 'run':
                    const shellResult = await this.executeADB(['shell', params.command || params.cmd], deviceId)
                    return { output: shellResult, success: true }

                case 'get_prop':
                    const propResult = await this.executeADB(['shell', 'getprop', params.prop || params.property], deviceId)
                    return { output: propResult.trim(), success: true }

                // ==================== FILE OPERATIONS (LOCAL -> PHONE) ====================
                case 'push_files':
                case 'adb_push': {
                    // Push local files to phone via ADB
                    const path = require('path')
                    const fs = require('fs')
                    const srcFolder = params.source_folder || params.src
                    const destFolder = params.dest_folder || params.dest || '/sdcard/ShadowPhone/content'
                    const maxFiles = params.max_files || 10
                    const extensions = params.extensions || ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.avi', '.mkv', '.webm']

                    // Smart dual-path resolution: CONTENT_ROOT primary, ~/ShadowPhone/ fallback
                    let resolvedSrc = srcFolder
                    let resolvedAttempted = null
                    let resolvedFoundMedia = true
                    if (srcFolder && !path.isAbsolute(srcFolder)) {
                        const detail = resolveContentFolderDetailed(srcFolder)
                        resolvedSrc = detail.path
                        resolvedAttempted = detail.attempted
                        resolvedFoundMedia = detail.foundMedia
                    }

                    const normalizedAccountUsername = normalizeInstagramAccountUsername(params.account_username)
                    const manualTransferOnly = params.manual_transfer_only === true
                    if (!normalizedAccountUsername && !manualTransferOnly) {
                        return {
                            success: false,
                            pushed: 0,
                            transfer_id: undefined,
                            manual_transfer_only: false,
                            error: 'A valid Instagram account username is required unless manual_transfer_only is explicitly true.',
                        }
                    }
                    const acctLabel = normalizedAccountUsername ? `@${normalizedAccountUsername}` : 'this manual transfer'
                    let pushed = 0

                    if (!resolvedSrc || !fs.existsSync(resolvedSrc) || !resolvedFoundMedia) {
                        const triedList = resolvedAttempted && resolvedAttempted.length
                            ? ` â€” tried: ${resolvedAttempted.join(', ')}. None contained media.`
                            : ''
                        console.error(`[PushFiles] Folder not found: '${srcFolder}'${triedList}`)
                        return { pushed: 0, success: false, manual_transfer_only: manualTransferOnly, error: `Content folder not found for ${acctLabel}: '${srcFolder}'${triedList} Open the Content Folder from your account settings and add your media files there.` }
                    }

                    const plan = await planContentTransfer({
                        sourceFolder: resolvedSrc,
                        contentType: params.content_type,
                        maxFiles,
                        extensions,
                        transferId: params.transfer_id,
                        deviceId,
                        targetUser: params.target_user || '0',
                        accountUsername: normalizedAccountUsername,
                        destinationFolder: destFolder,
                    })
                    const files = plan.manifest
                    const publishTransferId = !manualTransferOnly && plan.account_username ? plan.transfer_id : undefined

                    if (files.length === 0) {
                        console.log(`[PushFiles] No media files in ${resolvedSrc}`)
                        return { pushed: 0, success: false, manual_transfer_only: manualTransferOnly, error: `No content files found for ${acctLabel}. Add images, reels, or stories to your content folder before running Push Content.` }
                    }

                    // Create dest folder on device
                    await this.executeADB(['shell', 'mkdir', '-p', destFolder], deviceId)

                    // Parallel pushes with a concurrency cap. adb's daemon
                    // handles concurrent file transfers fine; the cap of 3
                    // prevents USB-bus saturation on slower phones while
                    // still giving a 2-3x speedup over the serial loop.
                    // (Previously: N files × ~400-1500ms each. Now: ceil(N/3) batches.)
                    const PUSH_CONCURRENCY = 3
                    const pushOne = async (entry) => {
                        let transferred = false
                        try {
                            await verifyLocalManifestEntry(entry)
                            await this.executeADB(['push', entry.source_path, entry.phone_destination], deviceId)
                            transferred = true
                            await verifyAdbRemoteEntry(args => this.executeADB(args, deviceId), entry)
                            return { entry, transferred, error: null }
                        } catch (e) {
                            console.error(`[WS] Failed to push ${entry.filename}: ${e.message}`)
                            return {
                                entry,
                                transferred,
                                error: Object.freeze({
                                    source_path: entry.source_path,
                                    phone_destination: entry.phone_destination,
                                    error: e.message,
                                }),
                            }
                        }
                    }
                    const outcomes = []
                    for (let i = 0; i < files.length; i += PUSH_CONCURRENCY) {
                        const batch = files.slice(i, i + PUSH_CONCURRENCY)
                        const results = await Promise.all(batch.map(pushOne))
                        outcomes.push(...results)
                        pushed += results.filter(result => !result.error).length
                    }

                    const successfulManifest = Object.freeze(outcomes.filter(result => !result.error).map(result => result.entry))
                    const failures = outcomes.filter(result => result.error).map(result => result.error)
                    const transferredCount = outcomes.filter(result => result.transferred).length
                    try {
                        await this.executeADB(['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${destFolder}/`], deviceId)
                    } catch (error) {
                        failures.push(Object.freeze({ error: `Media indexing failed: ${error.message}` }))
                    }
                    let success = failures.length === 0 && pushed === files.length
                    if (success && publishTransferId) {
                        try {
                            registerTransferManifest(plan)
                        } catch (error) {
                            failures.push(Object.freeze({
                                stage: 'manifest_registration',
                                error: `Transfer manifest registration failed: ${error.message}`,
                            }))
                            success = false
                        }
                    }
                    const error = success
                        ? undefined
                        : pushed < files.length
                            ? `${files.length - pushed} of ${files.length} content transfer(s) failed: ${failures.map(failure => failure.error).join('; ')}`
                            : failures.map(failure => failure.error).join('; ')
                    return {
                        success,
                        partial: transferredCount > 0 && !success,
                        pushed,
                        total: files.length,
                        transfer_id: publishTransferId,
                        manual_transfer_only: manualTransferOnly,
                        manifest: successfulManifest,
                        failures: Object.freeze(failures),
                        error,
                    }
                }

                case 'move_to_used': {
                    return {
                        success: false,
                        moved: 0,
                        error: 'Folder-based move_to_used is disabled. Archive the exact transfer_id manifest item only after positive publish confirmation.',
                    }
                }

                case 'delete_from_phone': {
                    // Delete content from phone after switching profiles (cleanup)
                    const delFolder = params.folder || params.path || '/sdcard/ShadowPhone/content'
                    if (!delFolder || !delFolder.startsWith('/sdcard/') || delFolder.includes('..')) {
                        return { success: false, error: 'Invalid folder path — must be under /sdcard/' }
                    }
                    await this.executeADB(['shell', `rm -rf ${delFolder}/*`], deviceId)
                    return { success: true, folder: delFolder }
                }

                case 'push_to_profile': {
                    /**
                     * Push files to a non-owner Android profile via Vanadium browser download.
                     * Works for ANY user that isn't user 0 (the owner) â€” user 10, 11, 12, 15, etc.
                     * Bypasses Android's cross-profile storage restrictions by:
                     * 1. Starting a local HTTP server on PC to serve the content files
                     * 2. Setting up `adb reverse` so phone localhost:18765 -> PC localhost:18765
                     * 3. Opening each file URL in Vanadium on the target profile
                     * 4. Tapping the Download button at known coordinates (837, 1509)
                     * 
                     * params:
                     *   source_folder: local folder with media files
                     *   target_user: Android user ID (REQUIRED â€” auto-detected by server.py via `am get-current-user`)
                     *   max_files: max files to push (default 10)
                     *   extensions: file extensions to include
                     *   port: HTTP server port (default 18765)
                     */
                    const pathUtil = require('path')
                    const fsUtil = require('fs')

                    const srcDir = params.source_folder || params.src

                    // Smart dual-path resolution: CONTENT_ROOT primary, ~/ShadowPhone/ fallback
                    let resolvedPushSrc = srcDir
                    if (srcDir && !pathUtil.isAbsolute(srcDir)) {
                        resolvedPushSrc = resolveContentFolder(srcDir)
                    }

                    const normalizedAccountUsername = normalizeInstagramAccountUsername(params.account_username)
                    const manualTransferOnly = params.manual_transfer_only === true
                    if (!normalizedAccountUsername && !manualTransferOnly) {
                        return {
                            success: false,
                            pushed: 0,
                            transfer_id: undefined,
                            manual_transfer_only: false,
                            error: 'A valid Instagram account username is required unless manual_transfer_only is explicitly true.',
                        }
                    }

                    // target_user is REQUIRED â€” server.py auto-detects it, any non-zero user triggers this path
                    const targetUser = String(params.target_user || params.user || '')
                    if (!targetUser) {
                        return { success: false, error: 'Could not detect Android user profile. Make sure the phone is unlocked and connected.', pushed: 0, manual_transfer_only: manualTransferOnly }
                    }
                    const maxPush = params.max_files || 10
                    const extsFilter = params.extensions || ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.avi', '.mkv', '.webm']
                    const serverPort = params.port || 18765
                    const acctName = normalizedAccountUsername
                    let pushed = 0
                    let httpServer = null
                    const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`
                    const sqlString = (value) => String(value).replace(/'/g, "''")
                    const isVideoName = (name) => /\.(mp4|mov|avi|mkv|webm)$/i.test(name)
                    // Cleanup has to cover every collection a Vanadium download can
                    // land in, not just the extension's own view: a stale row left
                    // in downloads/ collides with the exact-name resolution on the
                    // next attempt and turns one failure into a permanent one.
                    const mediaUrisFor = (name) => isVideoName(name)
                        ? [MEDIA_STORE_COLLECTIONS.video, MEDIA_STORE_COLLECTIONS.images, MEDIA_STORE_COLLECTIONS.downloads]
                        : [MEDIA_STORE_COLLECTIONS.images, MEDIA_STORE_COLLECTIONS.video, MEDIA_STORE_COLLECTIONS.downloads]
                    const queryProfileMediaByName = async (fileName) => {
                        // One round trip for every collection (a live `content query`
                        // costs ~2.3s of transport, so per-collection round trips are
                        // the expensive part); `; :;` keeps a collection that rejects
                        // the predicate from short-circuiting the rest.
                        const where = `_display_name='${sqlString(fileName)}'`
                        const script = mediaUrisFor(fileName)
                            .map(uri => `content query --user ${targetUser} --uri ${uri} --projection _display_name:_data:relative_path --where ${shellQuote(where)} 2>/dev/null`)
                            .join('; :; ') + '; :'
                        try {
                            const output = await this.executeADB(['shell', script], deviceId)
                            if (output && output.includes(fileName)) return { found: true, output }
                        } catch {
                            // Empty query results exit non-zero on some Android builds.
                        }
                        return { found: false }
                    }
                    // One round trip for every collection; `; :;` so a collection
                    // that rejects the predicate cannot short-circuit the rest
                    // (same pattern gallery_clean uses).
                    const deleteProfileMediaWhere = async (fileName, where) => {
                        const script = mediaUrisFor(fileName)
                            .map(uri => `content delete --user ${targetUser} --uri ${uri} --where ${shellQuote(where)} 2>/dev/null`)
                            .join('; :; ') + '; :'
                        await this.executeADB(['shell', script], deviceId)
                    }
                    const deleteProfileMediaByName = async (fileName) => {
                        const existing = await queryProfileMediaByName(fileName)
                        if (!existing.found) return false
                        await deleteProfileMediaWhere(fileName, `_display_name='${sqlString(fileName)}'`)
                        if ((await queryProfileMediaByName(fileName)).found) {
                            throw new Error(`Could not remove stale profile media named ${fileName}`)
                        }
                        return true
                    }
                    // Residue cleanup after a failed transfer. Chromium may have
                    // saved the file under a uniquified name (" (1).mov") that the
                    // exact-name cleanup cannot see, and the old failure branch left
                    // it on the phone — so the retry collided with it forever.
                    // Bounded by the content sha256 the planner minted into the name
                    // and scoped to this run's Android user: no cross-profile and no
                    // cross-content blast radius.
                    const deleteProfileMediaResidue = async (entry) => {
                        if (!/^[a-f0-9]{64}$/.test(String(entry?.sha256 || ''))) return
                        await deleteProfileMediaWhere(entry.remote_filename, `_display_name LIKE 'sp_${sqlString(entry.sha256)}_%'`)
                    }

                    console.log(`[PushProfile] @${acctName} â†’ user ${targetUser} | source: ${resolvedPushSrc} | port: ${serverPort}`)

                    if (!resolvedPushSrc || !fsUtil.existsSync(resolvedPushSrc)) {
                        console.error(`[PushProfile] Folder not found: ${resolvedPushSrc}`)
                        return { success: false, error: `Content folder not found for @${acctName}. Open the Content Folder from your account settings and add your media files there.`, pushed: 0, manual_transfer_only: manualTransferOnly }
                    }

                    if (params.allow_owner_profile_staging === true && !manualTransferOnly && /^[1-9]\d*$/.test(targetUser)) {
                        await this._reconcileOwnerStaging({ deviceId, targetUser, accountUsername: acctName })
                    }
                    const plan = await planContentTransfer({
                        sourceFolder: resolvedPushSrc,
                        sourceFile: params.source_file,
                        contentType: params.content_type,
                        maxFiles: maxPush,
                        extensions: extsFilter,
                        transferId: params.transfer_id,
                        deviceId,
                        targetUser,
                        accountUsername: acctName,
                        destinationFolder: `/storage/emulated/${targetUser}/Download`,
                    })
                    const files = plan.manifest
                    const publishTransferId = !manualTransferOnly && plan.account_username ? plan.transfer_id : undefined
                    const pushedManifest = []
                    const failures = []

                    if (files.length === 0) {
                        console.log(`[PushProfile] No media files in ${resolvedPushSrc} (checked root + images/videos/reels/stories)`)
                        return { success: false, error: `No content files found for @${acctName}. Add images, reels, or stories (.jpg, .png, .mp4, .mov) to your content folder before running Push Content.`, pushed: 0, manual_transfer_only: manualTransferOnly }
                    }

                    try {
                        // Step 0: Force-close Vanadium to ensure clean state
                        await this.executeADB(['shell', `am force-stop --user ${targetUser} app.vanadium.browser`], deviceId)
                        await new Promise(r => setTimeout(r, 500))

                        // Step 1: Clean slate â€” remove stale ADB reverse from previous runs
                        try {
                            await this.executeADB(['reverse', '--remove', `tcp:${serverPort}`], deviceId)
                        } catch (e) { /* may not exist, that's fine */ }

                        // Step 2: Start HTTP server with retry on EADDRINUSE
                        console.log(`[PushProfile] Starting HTTP server on port ${serverPort} for ${resolvedPushSrc}`)
                        // Map each file to an ASCII-safe index URL (/0, /1, etc.)
                        // so Vanadium can download files with Unicode/special-char names
                        const indexToFile = new Map()
                        let fileIdx = 0
                        for (const entry of files) {
                            indexToFile.set(String(fileIdx), entry)
                            fileIdx++
                        }

                        const createServer = () => createManifestHttpServer(indexToFile)

                        const killPortProcess = (port) => {
                            const { execSync: execSyncLocal } = require('child_process')
                            if (process.platform === 'win32') {
                                try {
                                    const out = execSyncLocal(`netstat -aon | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] })
                                    const pids = new Set()
                                    for (const line of out.split('\n')) {
                                        const parts = line.trim().split(/\s+/)
                                        const pid = parts[parts.length - 1]
                                        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
                                    }
                                    for (const pid of pids) {
                                        try { execSyncLocal(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'pipe' }) } catch { /* ok */ }
                                    }
                                } catch { /* no process on port */ }
                            } else {
                                try { execSyncLocal(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { timeout: 3000, stdio: 'pipe' }) } catch { /* ok */ }
                            }
                        }

                        for (let attempt = 0; attempt < 3; attempt++) {
                            try {
                                httpServer = createServer()
                                await new Promise((resolve, reject) => {
                                    httpServer.listen(serverPort, '127.0.0.1', () => {
                                        console.log(`[PushProfile] HTTP server listening on 127.0.0.1:${serverPort}`)
                                        resolve()
                                    })
                                    httpServer.on('error', reject)
                                })
                                break // success
                            } catch (err) {
                                if (err.code === 'EADDRINUSE' && attempt < 2) {
                                    console.log(`[PushProfile] Port ${serverPort} in use (attempt ${attempt + 1}), killing and retrying...`)
                                    killPortProcess(serverPort)
                                    httpServer = null
                                    await new Promise(r => setTimeout(r, 800))
                                    continue
                                }
                                httpServer = null
                                return { success: false, error: `Could not start HTTP server on port ${serverPort}: ${err.message}`, pushed: 0 }
                            }
                        }

                        if (!httpServer) {
                            return { success: false, error: `Port ${serverPort} still in use after kill attempts`, pushed: 0 }
                        }

                        // Step 2: Set up ADB reverse port forwarding
                        const ensureAdbReverse = async () => {
                            // Remove stale mapping first, then re-establish
                            try { await this.executeADB(['reverse', '--remove', `tcp:${serverPort}`], deviceId) } catch { /* ok */ }
                            await this.executeADB(['reverse', `tcp:${serverPort}`, `tcp:${serverPort}`], deviceId)
                            console.log(`[PushProfile] ADB reverse tcp:${serverPort} established`)
                        }
                        await ensureAdbReverse()

                        // Step 3: Push each file via Vanadium download
                        // Speed-optimized: open Vanadium ONCE up front, then per file
                        // just navigate to the new URL and tap Download. Saves ~6s/file
                        // vs the old force-stop/cold-launch dance.
                        const downloadBtnX = params.download_btn_x || 837
                        const downloadBtnY = params.download_btn_y || 1509
                        const PER_FILE_TIMEOUT = 30000 // 30s max per file (was 45s)

                        // ── One-time Vanadium prep ────────────────────────────────
                        // Cold-start, dismiss restore popup once
                        await this.executeADB(['shell', `am force-stop --user ${targetUser} app.vanadium.browser`], deviceId)
                        await new Promise(r => setTimeout(r, 700))
                        await this.executeADB(['shell', `am start --user ${targetUser} -n app.vanadium.browser/org.chromium.chrome.browser.ChromeTabbedActivity`], deviceId)
                        await new Promise(r => setTimeout(r, 1500))
                        // Blind back-press dismisses Restore tabs / Welcome / Onboarding
                        // popups in one tap; safe no-op on the new-tab page
                        await this.executeADB(['shell', 'input', 'keyevent', 'KEYCODE_BACK'], deviceId)
                        await new Promise(r => setTimeout(r, 500))

                        // Track whether we've already dismissed the "Send notifications"
                        // first-launch popup so we don't dump XML every file
                        let notificationsPopupHandled = false

                        for (let fi = 0; fi < files.length; fi++) {
                            const file = files[fi]
                            console.log(`[PushProfile] Pushing file ${pushed + 1}/${files.length}: ${file.filename}`)

                            try {
                                await verifyLocalManifestEntry(file)
                            } catch (error) {
                                failures.push(Object.freeze({
                                    source_path: file.source_path,
                                    phone_destination: file.phone_destination,
                                    error: error.message,
                                }))
                                continue
                            }

                            try {
                                // Residue from an EARLIER run first. A push that
                                // transferred but never published leaves
                                // sp_<sha>_<pathhash>_<transferA><ext> behind
                                // (archivePublishedTransfer only runs on publish, and
                                // releaseTransferReservation makes the same sha
                                // re-selectable), and this run mints a different
                                // transfer segment — so the exact-name cleanup below
                                // cannot see it and it becomes the drift row every poll
                                // reports. Clearing it BEFORE the download instead of
                                // only after a failure is what stops each run from
                                // re-arming the next one. Same blast radius as the
                                // post-failure cleanup: one content sha256, this run's
                                // Android user, and the planner already rejects a
                                // second manifest entry with the same sha.
                                await deleteProfileMediaResidue(file)
                                await deleteProfileMediaByName(file.remote_filename)
                            } catch (error) {
                                failures.push(Object.freeze({
                                    source_path: file.source_path,
                                    phone_destination: file.phone_destination,
                                    error: `Exact remote-name cleanup failed: ${error.message}`,
                                }))
                                continue
                            }

                            // Re-establish ADB reverse before each file to prevent stale tunnel
                            try { await ensureAdbReverse() } catch (reverseErr) {
                                console.log(`[PushProfile] ADB reverse refresh failed: ${reverseErr.message}, retrying after adb reconnect...`)
                                try {
                                    await this.executeADB(['reconnect'], deviceId)
                                    await new Promise(r => setTimeout(r, 1500))
                                    await ensureAdbReverse()
                                } catch (reconnErr) {
                                    console.error(`[PushProfile] Cannot re-establish ADB reverse: ${reconnErr.message}`)
                                    for (const pending of files.slice(fi)) {
                                        failures.push(Object.freeze({
                                            source_path: pending.source_path,
                                            phone_destination: pending.phone_destination,
                                            error: `ADB reverse failed: ${reconnErr.message}`,
                                        }))
                                    }
                                    break
                                }
                            }

                            let downloadStartedAt = null
                            try {
                                const epoch = String(await this.executeADB(['shell', 'date', '+%s.%N'], deviceId, 1, { timeoutMs: 3000 })).trim()
                                if (/^\d+\.\d+$/.test(epoch)) downloadStartedAt = Number(epoch)
                            } catch (error) {
                                if (error.code === 'MODULE_ABORTED' || error.code === 'ADB_PROCESS_ABORTED') throw error
                                // A diagnostic clock read must not block a valid transfer.
                            }

                            // Navigate Vanadium to the new download URL — no force-stop,
                            // no cold launch. android.intent.action.VIEW into the same
                            // browser activity reuses the current tab/process.
                            const downloadUrl = `http://localhost:${serverPort}/${fi}`
                            await this.executeADB(['shell', `am start --user ${targetUser} -a android.intent.action.VIEW -d '${downloadUrl}'`], deviceId)

                            // Wait for the download prompt to appear. Vanadium shows
                            // the prompt within ~1.5s on a hot process; cold starts
                            // were the old 3s requirement.
                            await new Promise(r => setTimeout(r, 1500))

                            // First-file only: check for the "Send notifications" popup
                            // and dismiss it (it only appears on first launch since
                            // boot). Skip the XML dump on all subsequent files.
                            if (!notificationsPopupHandled) {
                                try {
                                    await this.executeADB(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'], deviceId)
                                    const dumpXml = await this.executeADB(['shell', 'cat', '/sdcard/window_dump.xml'], deviceId)
                                    await this.executeADB(['shell', 'rm', '/sdcard/window_dump.xml'], deviceId)
                                    if (dumpXml && dumpXml.includes('No thanks')) {
                                        const ntMatch = dumpXml.match(/text="No thanks"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                                                        dumpXml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="No thanks"/)
                                        if (ntMatch) {
                                            const ntx = Math.floor((parseInt(ntMatch[1])+parseInt(ntMatch[3]))/2)
                                            const nty = Math.floor((parseInt(ntMatch[2])+parseInt(ntMatch[4]))/2)
                                            await this.executeADB(['shell', 'input', 'tap', String(ntx), String(nty)], deviceId)
                                            await new Promise(r => setTimeout(r, 700))
                                        }
                                    }
                                } catch { /* non-fatal */ }
                                notificationsPopupHandled = true
                            }

                            // Tap Download button — coords are stable across Vanadium
                            // versions because the dialog uses fixed AlertDialog metrics
                            await this.executeADB(['shell', 'input', 'tap', String(downloadBtnX), String(downloadBtnY)], deviceId)
                            console.log(`[PushProfile] Tapped Download for ${file.filename} at (${downloadBtnX}, ${downloadBtnY})`)

                            // Wall-clock poll only. The old "500ms × up to 24 = 12s
                            // ceiling" comment was ~3x optimistic: a live `content
                            // query` round trip measures ~2.3s, so the loop always
                            // exited on the deadline and never on the attempt count.
                            // fileStart is stamped HERE, after the tap, so the 30s
                            // budget is 30s of polling — it used to start before
                            // `am start` + the 1.5s prompt wait + the uiautomator
                            // dump, which spent ~9s of it before poll #1
                            // (2026-07-26 profile 19 / @a.mroczkowska1996 failure).
                            const fileStart = Date.now()
                            const safeFilename = file.remote_filename
                            let remoteVerification = null
                            let verificationError = null
                            let scanResult = null
                            let attempts = 0
                            // Quick initial check — small files (<5MB) often land instantly.
                            // A matching display name is never sufficient: resolve the exact
                            // MediaStore row, stream its content URI, and compare size + SHA-256.
                            await new Promise(r => setTimeout(r, 400))
                            while (true) {
                                attempts++
                                try {
                                    remoteVerification = await verifyProfileMediaEntry(
                                        args => this.executeADB(args, deviceId),
                                        {
                                            targetUser,
                                            entry: file,
                                            queryExecute: args => this.executeADB(args, deviceId, 0, { raw: true }),
                                        },
                                    )
                                    verificationError = null
                                    break
                                } catch (error) {
                                    verificationError = error
                                    // An aborted run must not spin the whole budget on
                                    // calls that can only fail.
                                    if (error.code === 'MODULE_ABORTED' || error.code === 'ADB_PROCESS_ABORTED') throw error
                                    // duplicate_rows / sha_mismatch cannot heal, so stop
                                    // burning the budget on them. name_drift is NOT in
                                    // that set: it is only real once the budget is gone
                                    // (see RETRYABLE_MEDIA_CAUSES).
                                    if (error.retryable === false) break
                                }
                                if (Date.now() - fileStart > PER_FILE_TIMEOUT) {
                                    console.log(`[PushProfile] Timeout verifying ${file.filename} (${PER_FILE_TIMEOUT}ms, ${attempts} attempt(s))`)
                                    break
                                }
                                // Make indexing deterministic instead of hoping: force the
                                // scan that populates _size for the file we just downloaded.
                                try {
                                    scanResult = await scanProfileMediaFile(
                                        args => this.executeADB(args, deviceId),
                                        { targetUser, phoneDestination: file.phone_destination },
                                    )
                                } catch (scanError) {
                                    scanResult = { error: scanError.message }
                                }
                                if (Date.now() - fileStart > PER_FILE_TIMEOUT) {
                                    console.log(`[PushProfile] Timeout verifying ${file.filename} (${PER_FILE_TIMEOUT}ms, ${attempts} attempt(s))`)
                                    break
                                }
                                await new Promise(r => setTimeout(r, 250))
                            }

                            if (remoteVerification) {
                                pushed++
                                pushedManifest.push(file)
                                console.log(`[PushProfile] Cryptographically verified in MediaStore: ${safeFilename} (${file.filename}) in ${Date.now() - fileStart}ms after ${attempts} attempt(s)`)
                            } else {
                                if (downloadStartedAt !== null && ['not_indexed', 'query_failed'].includes(verificationError?.cause_code)) {
                                    try {
                                        const snapshot = await this.executeADB(
                                            ['logcat', '-d', '-v', 'epoch', '-T', downloadStartedAt.toFixed(6), 'MediaProvider:E', '*:S'],
                                            deviceId, 1, { timeoutMs: 3000, maxOutputBytes: 256 * 1024 },
                                        )
                                        verificationError = detectProfileStorageFailure(snapshot, {
                                            targetUser, startedAt: downloadStartedAt,
                                        }) || verificationError
                                    } catch (error) {
                                        if (error.code === 'MODULE_ABORTED' || error.code === 'ADB_PROCESS_ABORTED') throw error
                                        // Keep the original verification cause when logs are unavailable.
                                    }
                                }
                                if (canStageOwnerDocument(plan, params, verificationError)) {
                                    try {
                                        const staged = await this._stageOwnerDocument(plan, params, verificationError, { serverPort, indexToFile })
                                        registerTransferManifest(staged)
                                        return {
                                            success: true, pushed: 1, total: 1, transfer_id: staged.transfer_id,
                                            method: OWNER_DOCUMENT_METHOD, source_profile: '0', phone_profile: targetUser,
                                            device_selection: 'pending_exact_document_share',
                                            manual_transfer_only: false, manifest: staged.manifest, failures: [],
                                        }
                                    } catch (error) {
                                        if (error.code === 'MODULE_ABORTED' || error.code === 'ADB_PROCESS_ABORTED') throw error
                                        verificationError = mediaVerificationError('owner_staging_unavailable',
                                            'Temporary Owner-profile staging could not be verified. The local source was preserved; reconcile the owned staging record before retrying.')
                                    }
                                }
                                const cause = verificationError?.cause_code || 'unknown'
                                const diagnostics = verificationError?.diagnostics || {}
                                failures.push(Object.freeze({
                                    source_path: file.source_path,
                                    phone_destination: file.phone_destination,
                                    cause,
                                    retryable: verificationError?.retryable ?? false,
                                    error: `profile ${targetUser} MediaStore byte verification failed for ${file.filename}: ${verificationError?.message || 'no exact item found'}`,
                                }))
                                // One deliberate diagnostic block, on the final attempt
                                // only: four separate investigations of the 2026-07-26
                                // failure had nothing but "Could not resolve one exact
                                // MediaStore item" to work from, which covered six
                                // different states.
                                console.log(`[PushProfile] FAILED ${safeFilename} cause=${cause} attempts=${attempts} elapsed=${Date.now() - fileStart}ms on_disk=${scanResult?.on_disk_size ?? 'unknown'} scanned_uri=${scanResult?.scanned_uri || 'none'}`)
                                console.log(`[PushProfile] FAILED ${safeFilename} query: ${diagnostics.query || 'n/a'}`)
                                console.log(`[PushProfile] FAILED ${safeFilename} rows=${(diagnostics.rows || []).length} ${JSON.stringify(diagnostics.rows || [])}`)
                                console.log(`[PushProfile] FAILED ${safeFilename} stdout: ${String(diagnostics.stdout || '').slice(0, 1024)}`)
                                if (diagnostics.stderr) console.log(`[PushProfile] FAILED ${safeFilename} stderr: ${String(diagnostics.stderr).slice(0, 1024)}`)
                                // Leave nothing behind for the retry to collide with.
                                try {
                                    await deleteProfileMediaResidue(file)
                                } catch (cleanupError) {
                                    console.log(`[PushProfile] Residue cleanup failed (non-fatal): ${cleanupError.message}`)
                                }
                                if (cause === 'not_indexed') {
                                    // Tailnet tunnel can degrade to 0-byte transfers while still
                                    // appearing alive (documented push-tunnel-degrade gotcha). A
                                    // disconnect/connect re-establishes the transport without
                                    // needing a full app restart. Gated to not_indexed: it used
                                    // to fire for every cause and misdirected every reader
                                    // toward a network theory.
                                    console.log(`[PushProfile] ${file.filename} never indexed — reconnecting ADB in case the tailnet tunnel degraded`)
                                    try {
                                        await this.executeADB(['disconnect', deviceId], deviceId)
                                        await this.executeADB(['connect', deviceId], deviceId)
                                        await new Promise(r => setTimeout(r, 1500))
                                        console.log(`[PushProfile] ADB reconnected after MediaStore timeout for ${file.filename}`)
                                    } catch (reconnErr) {
                                        console.log(`[PushProfile] ADB reconnect after MediaStore timeout failed (non-fatal): ${reconnErr.message}`)
                                    }
                                }
                            }
                        }

                        console.log(`[PushProfile] Secondary profile files are verified through MediaStore in Download/`)

                        // No post-loop MEDIA_SCANNER_SCAN_FILE broadcasts: they fired
                        // after every file had already passed or failed, they took
                        // DIRECTORIES, and the second aimed at ShadowPhone/content/ —
                        // not the Download/ dir Vanadium actually writes to. The
                        // per-file `content call ... scan_file` above replaces them.

                        // Cleanup: force-stop Vanadium for the profile we drove
                        await this.executeADB(['shell', 'am', 'force-stop', '--user', targetUser, 'app.vanadium.browser'], deviceId)

                    } catch (err) {
                        console.error(`[PushProfile] Error: ${err.message}`)
                        failures.push(Object.freeze({ error: err.message }))
                        return {
                            success: false,
                            partial: pushed > 0,
                            error: err.message,
                            pushed,
                            total: files.length,
                            transfer_id: publishTransferId,
                            manual_transfer_only: manualTransferOnly,
                            manifest: Object.freeze([...pushedManifest]),
                            failures: Object.freeze([...failures]),
                        }
                    } finally {
                        // Always force-stop Vanadium so it doesn't block the next step.
                        // --user scoped: the unscoped form stopped user 0's browser and
                        // left the target profile's own Vanadium running with a possibly
                        // in-flight download.
                        try {
                            await this.executeADB(['shell', 'am', 'force-stop', '--user', targetUser, 'app.vanadium.browser'], deviceId)
                            console.log(`[PushProfile] Vanadium force-stopped for user ${targetUser} (cleanup)`)
                        } catch { /* best effort */ }
                        // Force-destroy HTTP server (closeAllConnections ensures no keep-alive sockets linger)
                        if (httpServer) {
                            try { httpServer.closeAllConnections() } catch { /* Node <18.2 fallback */ }
                            httpServer.close()
                            httpServer = null
                            console.log(`[PushProfile] HTTP server stopped`)
                        }
                        // Remove ADB reverse
                        try {
                            await this.executeADB(['reverse', '--remove', `tcp:${serverPort}`], deviceId)
                        } catch { /* ignore */ }
                    }

                    let success = pushed === files.length && failures.length === 0
                    if (success && publishTransferId) {
                        try {
                            registerTransferManifest(plan)
                        } catch (error) {
                            failures.push(Object.freeze({
                                stage: 'manifest_registration',
                                error: `Transfer manifest registration failed: ${error.message}`,
                            }))
                            success = false
                        }
                    }
                    return {
                        success,
                        partial: pushed > 0 && !success,
                        pushed,
                        total: files.length,
                        transfer_id: publishTransferId,
                        manual_transfer_only: manualTransferOnly,
                        manifest: Object.freeze([...pushedManifest]),
                        failures: Object.freeze([...failures]),
                        error: success
                            ? undefined
                            : failures.map(failure => failure.error).join('; ') || `${files.length - pushed} of ${files.length} profile transfer(s) failed`,
                    }
                }

                // ==================== TIMING ====================
                case 'wait':
                case 'sleep':
                case 'delay':
                    await new Promise(resolve => setTimeout(resolve, params.ms || params.duration || 1000))
                    break

                // ==================== SCREEN OPERATIONS ====================
                case 'dump_screen':
                case 'get_screen':
                    // Just return - screen will be fetched after
                    break

                case 'screenshot':
                case 'capture':
                    const screenshotPath = params.path || '/sdcard/screenshot.png'
                    await this.executeADB(['shell', 'screencap', '-p', screenshotPath], deviceId)
                    return { path: screenshotPath, success: true }

                case 'pixel_at':
                    // Read one screen pixel's RGB (caption-bleed share-screen gate).
                    // Brain sends this with expect_screen_dump:false and reads `data`.
                    return await this.screencapPixel(deviceId, params.x, params.y)

                case 'screen_on':
                    await this.executeADB(['shell', 'input', 'keyevent', '224'], deviceId) // KEYCODE_WAKEUP
                    break

                case 'screen_off':
                    await this.executeADB(['shell', 'input', 'keyevent', '223'], deviceId) // KEYCODE_SLEEP
                    break

                case 'unlock':
                    // Wake screen and swipe up to unlock
                    await this.executeADB(['shell', 'input', 'keyevent', '224'], deviceId)
                    await new Promise(r => setTimeout(r, 300))
                    await this.executeADB(['shell', 'input', 'swipe', '540', '1800', '540', '800', '300'], deviceId)
                    break

                // ==================== FILE OPERATIONS ====================
                case 'push_file':
                case 'push':
                    await this.executeADB(['push', params.local_path || params.local, params.remote_path || params.remote], deviceId)
                    break

                case 'pull_file':
                case 'pull':
                    await this.executeADB(['pull', params.remote_path || params.remote, params.local_path || params.local], deviceId)
                    break

                case 'delete_file':
                case 'rm':
                    await this.executeADB(['shell', 'rm', '-f', params.path || params.file], deviceId)
                    break

                // ==================== GRAPHENEOS PROFILE ====================
                case 'switch_profile':
                case 'profile_switch':
                    // GrapheneOS profile switching via Settings
                    await this.executeADB(['shell', 'am', 'start', '-a', 'android.settings.USER_SETTINGS'], deviceId)
                    break

                case 'get_current_profile':
                    const profileResult = await this.executeADB(['shell', 'dumpsys', 'user', '|', 'grep', 'UserInfo'], deviceId)
                    return { output: profileResult, success: true }

                // ==================== INSTAGRAM SPECIFIC ====================
                case 'open_instagram':
                    await this.executeADB(['shell', 'monkey', '-p', 'com.instagram.android', '-c', 'android.intent.category.LAUNCHER', '1'], deviceId)
                    break

                case 'open_instagram_dm':
                    await this.executeADB(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'instagram://direct_inbox'], deviceId)
                    break

                case 'open_instagram_profile':
                    const username = params.username || params.user
                    if (username) {
                        await this.executeADB(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `instagram://user?username=${username}`], deviceId)
                    }
                    break

                case 'open_instagram_post':
                    const postId = params.post_id || params.postId || params.id
                    if (postId) {
                        await this.executeADB(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `instagram://media?id=${postId}`], deviceId)
                    }
                    break

                // ==================== CLIPBOARD ====================
                case 'set_clipboard':
                case 'copy':
                    const clipText = params.text || params.value
                    // Use am broadcast to set clipboard
                    await this.executeADB(['shell', `am broadcast -a clipper.set -e text "${clipText}"`], deviceId)
                    break

                case 'paste':
                    await this.executeADB(['shell', 'input', 'keyevent', '279'], deviceId) // KEYCODE_PASTE
                    break

                // ==================== ELEMENT INTERACTION ====================
                // These commands find elements on screen and interact with them
                // Server may send element selectors OR pre-resolved coordinates

                case 'tap_element':
                case 'click_element':
                    // If coordinates provided, use them directly
                    if (params.x && params.y) {
                        await this.executeADB(['shell', 'input', 'tap', String(params.x), String(params.y)], deviceId)
                    } else if (params.bounds) {
                        // Parse bounds like "[0,0][100,100]"
                        const coords = this.parseBounds(params.bounds)
                        if (coords) {
                            await this.executeADB(['shell', 'input', 'tap', String(coords.x), String(coords.y)], deviceId)
                        }
                    } else {
                        // Find element on screen and tap it
                        const elemCoords = await this.findElement(deviceId, params)
                        if (elemCoords) {
                            await this.executeADB(['shell', 'input', 'tap', String(elemCoords.x), String(elemCoords.y)], deviceId)
                        } else {
                            return { success: false, error: `Element not found: ${JSON.stringify(params)}` }
                        }
                    }
                    break

                case 'long_press_element':
                    const lpCoords = params.x && params.y
                        ? { x: params.x, y: params.y }
                        : params.bounds
                            ? this.parseBounds(params.bounds)
                            : await this.findElement(deviceId, params)

                    if (lpCoords) {
                        await this.executeADB(['shell', 'input', 'swipe',
                            String(lpCoords.x), String(lpCoords.y),
                            String(lpCoords.x), String(lpCoords.y),
                            String(params.duration || 1000)], deviceId)
                    } else {
                        return { success: false, error: `Element not found for long press` }
                    }
                    break

                case 'swipe_element':
                    // Swipe starting from an element
                    const swipeStart = params.x && params.y
                        ? { x: params.x, y: params.y }
                        : params.bounds
                            ? this.parseBounds(params.bounds)
                            : await this.findElement(deviceId, params)

                    if (swipeStart) {
                        const endX = swipeStart.x + (params.dx || 0)
                        const endY = swipeStart.y + (params.dy || 0)
                        await this.executeADB(['shell', 'input', 'swipe',
                            String(swipeStart.x), String(swipeStart.y),
                            String(endX), String(endY),
                            String(params.duration || 300)], deviceId)
                    }
                    break

                case 'input_text_element':
                case 'type_in_element':
                    // Tap element first, then type
                    const inputCoords = params.x && params.y
                        ? { x: params.x, y: params.y }
                        : params.bounds
                            ? this.parseBounds(params.bounds)
                            : await this.findElement(deviceId, params)

                    if (inputCoords) {
                        // Tap to focus
                        await this.executeADB(['shell', 'input', 'tap', String(inputCoords.x), String(inputCoords.y)], deviceId)
                        await new Promise(r => setTimeout(r, 300))

                        // Clear if needed
                        if (params.clear_first || params.clear) {
                            await this.executeADB(['shell', 'input', 'keyevent', '67'], deviceId)
                        }

                        // Type text
                        const text = params.text || params.value || ''
                        await typeTextSmart(text)
                    } else {
                        return { success: false, error: `Input element not found` }
                    }
                    break

                case 'wait_for_element':
                    // Wait until element appears on screen
                    const found = await this.waitForElement(deviceId, params, params.timeout || 10000)
                    return { success: found, found }

                case 'element_exists':
                case 'check_element':
                    // Check if element exists
                    const exists = await this.findElement(deviceId, params)
                    return { success: true, exists: !!exists, coords: exists }

                case 'get_element_text':
                    // Get text content of an element (from screen XML)
                    const xml = await this.getScreenDump(deviceId)
                    if (xml && params.resource_id) {
                        const match = xml.match(new RegExp(`resource-id="${params.resource_id}"[^>]*text="([^"]*)"`, 'i'))
                        return { success: true, text: match ? match[1] : null }
                    }
                    return { success: false, error: 'Could not get element text' }

                // ==================== APPIUM-STYLE COMMANDS ====================
                // For compatibility with Appium-style module scripts

                case 'find_element':
                    const foundElem = await this.findElement(deviceId, params)
                    return { success: !!foundElem, element: foundElem }

                case 'find_elements':
                    const foundElems = await this.findElements(deviceId, params)
                    return { success: true, elements: foundElems }

                case 'click':
                    // Appium-style click (same as tap_element)
                    if (params.element) {
                        await this.executeADB(['shell', 'input', 'tap', String(params.element.x), String(params.element.y)], deviceId)
                    } else if (params.x && params.y) {
                        await this.executeADB(['shell', 'input', 'tap', String(params.x), String(params.y)], deviceId)
                    } else {
                        const clickCoords = await this.findElement(deviceId, params)
                        if (clickCoords) {
                            await this.executeADB(['shell', 'input', 'tap', String(clickCoords.x), String(clickCoords.y)], deviceId)
                        }
                    }
                    break

                case 'send_keys':
                    // Appium-style send_keys
                    const keys = params.keys || params.text || params.value || ''
                    await typeTextSmart(keys, params.typing_mode, params.clear_first || params.clear)
                    break

                case 'clear':
                    // Clear current input field
                    await this.executeADB(['shell', 'input', 'keycombination', '113', '29'], deviceId)
                    await this.executeADB(['shell', 'input', 'keyevent', '67'], deviceId)
                    break

                default:
                    console.warn(`[ADB] Unknown action: ${action}`)
                    // Don't throw - just log and continue
                    return { success: false, error: `Unknown action: ${action}` }
            }

            // Wait if specified
            if (command.wait_after > 0) {
                await new Promise(resolve => setTimeout(resolve, command.wait_after))
            }

            return { success: true, action }
        } catch (error) {
            console.error(`[ADB] Command failed: ${action}`, error.message)
            throw error
        }
    }

    /**
     * Run a module via WebSocket
     * @param {string} moduleId - Module to execute (e.g., 'airplane_toggle')
     * @param {string} deviceId - ADB device serial number
     * @param {string} profileId - GrapheneOS profile ID (optional)
     * @param {object} config - Module-specific configuration
     * @param {string} userId - User ID for quota tracking
     * @param {object} callbacks - Progress, completion, error, and log callbacks
     * @returns {Promise<object>} Module result
     */
    async runModule(moduleId, deviceId, profileId, config, userId, callbacks = {}) {
        this.abortRequested = false
        this._deviceLostRun = false
        this._adbAbortController = new AbortController()
        let ticket = null
        let release = null
        try {
            if (!String(deviceId ?? '').trim()) {
                const error = new Error('Physical phone identity could not be verified')
                error.code = 'HARDWARE_IDENTITY_UNVERIFIED'
                throw error
            }
            let hardwareSerial
            try {
                hardwareSerial = await this.executeADB(
                    ['shell', 'getprop', 'ro.serialno'],
                    deviceId,
                )
            } catch (cause) {
                if (this.abortRequested) {
                    const error = new Error('Module was aborted before execution started')
                    error.code = 'MODULE_ABORTED'
                    throw error
                }
                const error = new Error('Physical phone identity could not be verified')
                error.code = 'HARDWARE_IDENTITY_UNVERIFIED'
                error.cause = cause
                throw error
            }

            if (this.abortRequested) {
                const error = new Error('Module was aborted before execution started')
                error.code = 'MODULE_ABORTED'
                throw error
            }

            ticket = acquireModuleRunMutex(hardwareSerial)
            this._moduleRunLockTicket = ticket
            release = await ticket.wait

            if (this.abortRequested) {
                const error = new Error('Module was aborted before execution started')
                error.code = 'MODULE_ABORTED'
                throw error
            }

            return await this._runModuleUnlocked(
                moduleId,
                deviceId,
                profileId,
                config,
                userId,
                callbacks,
            )
        } finally {
            try {
                if (release) await this._teardownModuleSocket()
            } finally {
                if (release && this._uncertainAdbProcesses.size > 0) {
                    release.quarantine()
                    this._quarantinedModuleRunRelease = release
                    if (this._uncertainAdbProcesses.size === 0) {
                        release.recover()
                        this._quarantinedModuleRunRelease = null
                    }
                } else if (release && this._deviceLostRun) {
                    // A DEVICE_LOST abort cuts the run at ~2min instead of the 900s
                    // ceiling, and the {type:'abort'} we sent cannot be READ while
                    // the brain's loop is blocked — that IS the bug. So the brain
                    // may still be driving this phone as we free the slot. Hold the
                    // module-run mutex quarantined so a second run can't collide,
                    // but bound it HARD with an unconditional unref'd timer: an
                    // unbounded defer is exactly the v3.6.0 deadlock shape.
                    release.quarantine()
                    const recoveryTimer = setTimeout(() => {
                        try { release.recover() } catch (_) {}
                    }, DEVICE_LIVENESS.QUARANTINE_MS)
                    if (recoveryTimer.unref) recoveryTimer.unref()
                } else if (release) {
                    release()
                }
                if (this._moduleRunLockTicket === ticket) this._moduleRunLockTicket = null
            }
        }
    }

    async _teardownModuleSocket() {
        const socket = this.ws
        if (!socket) return
        if (socket.readyState === WebSocket.CLOSED) {
            if (this.ws === socket) this.ws = null
            return
        }

        await new Promise(resolve => {
            let settled = false
            let timer = null
            const finish = () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                if (typeof socket.off === 'function') socket.off('close', finish)
                resolve()
            }

            if (typeof socket.once !== 'function') {
                finish()
                return
            }
            socket.once('close', finish)
            timer = setTimeout(() => {
                try { socket.terminate?.() } catch { /* teardown is best effort */ }
                finish()
            }, 1000)
            if (socket.readyState !== WebSocket.CLOSING) {
                try { socket.close() } catch { finish() }
            }
        })

        if (this.ws === socket) {
            this.connected = false
            this.ws = null
        }
    }

    _runModuleUnlocked(moduleId, deviceId, profileId, config, userId, callbacks = {}) {
        const { onProgress, onComplete, onError, onLog, onUserPrompt } = callbacks
        const postContentType = POST_CONTENT_TYPES[moduleId]
        const explicitTransferId = String(config?.transfer_id || config?.transferId || '').trim()
        let transferReservation = null
        if (postContentType) {
            try {
                transferReservation = reserveTransferForPost({
                    moduleId,
                    transferId: explicitTransferId,
                    deviceId,
                    targetUser: config?.target_user ?? profileId,
                    accountUsername: config?.account_username,
                    contentType: postContentType,
                })
            } catch (error) {
                return Promise.reject(error)
            }
            if (explicitTransferId && !transferReservation) {
                return Promise.reject(new Error(`Transfer ${explicitTransferId} is not pending or was already consumed`))
            }
        }
        const effectiveConfig = transferReservation
            ? {
                ...(config || {}),
                transfer_id: transferReservation.transfer_id,
                content_manifest_item: transferReservation.entry,
                content_type: transferReservation.entry.content_type,
                device_selection: transferReservation.entry.device_selection,
                target_user: transferReservation.entry.phone_profile,
                account_username: transferReservation.entry.account_username,
            }
            : (config || {})
        let reservationSettled = false
        const releaseReservedTransfer = () => {
            if (!transferReservation || reservationSettled) return
            releaseTransferReservation(transferReservation)
            reservationSettled = true
        }

        // Connection timeout (30 seconds)
        const CONNECTION_TIMEOUT = 30000
        // Module execution timeout â€” 15 minutes
        // This matches the per-profile execution limit. Engagement sessions with
        // 14+ stories, 20+ reels, or split feed+reels can take 10-12 min.
        // If a module hits this limit, it means the session is stuck or took too long.
        const EXECUTION_TIMEOUT = 900000
        // Keepalive heartbeat to prevent idle WS disconnects through proxies/load balancers.
        const HEARTBEAT_INTERVAL = 12000
        // Raised to 120s as defense-in-depth for legitimately slow steps (dump_screen
        // ~25s under scrcpy/Tailnet; airplane/network settle). Protocol-level pings keep
        // lastPongAt fresh for a busy-but-alive brain; this is only the last-resort dead-socket window.
        const HEARTBEAT_STALE_MS = 120000

        return new Promise((resolve, reject) => {
            let connectionTimer = null
            let executionTimer = null
            let heartbeatTimer = null
            let lastPongAt = Date.now()
            // Deliberately INDEPENDENT of lastPongAt, which is refreshed by the
            // protocol pong handler AND by every inbound message — uvicorn keeps it
            // fresh from its own task while the Python handler is blocked, which is
            // exactly why HEARTBEAT_STALE_MS never fires on this failure mode.
            let lastAppMessageAt = Date.now()
            let commandsInFlight = 0
            let livenessTimer = null
            const livenessState = { missStreak: 0, firstMissAt: 0 }
            let hasConnected = false
            let moduleStartSent = false
            let terminalStarted = false
            let promiseSettled = false
            const deliveredLogCounts = new Map()
            const deliveredLogOrder = []
            const rememberRealtimeLog = log => {
                const value = String(log == null ? '' : log)
                deliveredLogCounts.set(value, (deliveredLogCounts.get(value) || 0) + 1)
                deliveredLogOrder.push(value)
                if (deliveredLogOrder.length > 200) {
                    const oldest = deliveredLogOrder.shift()
                    const count = deliveredLogCounts.get(oldest) || 0
                    if (count <= 1) deliveredLogCounts.delete(oldest)
                    else deliveredLogCounts.set(oldest, count - 1)
                }
            }
            const deliverCompletionLogs = logs => {
                const replayBudget = new Map(deliveredLogCounts)
                for (const log of logs || []) {
                    const value = String(log == null ? '' : log)
                    const alreadyDelivered = replayBudget.get(value) || 0
                    if (alreadyDelivered > 0) {
                        if (alreadyDelivered === 1) replayBudget.delete(value)
                        else replayBudget.set(value, alreadyDelivered - 1)
                        continue
                    }
                    invokeCallback('onLog', onLog, log)
                }
            }
            const invokeCallback = (label, callback, ...args) => {
                if (!callback) return
                try {
                    callback(...args)
                } catch (error) {
                    console.error(`[WS-Module] ${label} callback failed: ${error.message}`)
                }
            }
            const rejectOnce = error => {
                if (promiseSettled) return false
                promiseSettled = true
                invokeCallback('onError', onError, error)
                reject(error)
                return true
            }
            const resolveOnce = (value, data) => {
                if (promiseSettled) return false
                promiseSettled = true
                invokeCallback('onComplete', onComplete, data)
                resolve(value)
                return true
            }
            const settleTransportFailure = async (transportError, reason) => {
                if (promiseSettled) return
                transportError.transportFailure = true
                transportError.moduleStartSent = moduleStartSent
                if (!moduleStartSent || !transferReservation) {
                    releaseReservedTransfer()
                    rejectOnce(transportError)
                    return
                }
                try {
                    const quarantined = await quarantineUnconfirmedTransfer(transferReservation, {
                        reason,
                        transport_code: transportError.code || null,
                        transport_message: transportError.message,
                    })
                    reservationSettled = true
                    transportError.status = quarantined.status
                    transportError.content_archive_status = quarantined.status
                    transportError.transfer_id = transferReservation.transfer_id
                    transportError.publish_success = null
                    transportError.archive_success = false
                    transportError.manual_reconciliation_required = true
                    transportError.durable_marker = quarantined.durable_marker
                    transportError.published_marker_path = quarantined.published_marker_path
                    transportError.marker_errors = quarantined.marker_errors
                    transportError.durable_account_content_ledger = quarantined.durable_account_content_ledger
                    transportError.account_content_ledger_path = quarantined.account_content_ledger_path
                    transportError.source_retained = quarantined.source_retained
                    rejectOnce(transportError)
                } catch (journalError) {
                    consumeUncertainReservation(transferReservation)
                    reservationSettled = true
                    const error = new Error(
                        `Automation transport failed after module start and its content state requires manual reconciliation: ${journalError.message}`,
                    )
                    error.code = 'PUBLISH_RECONCILIATION_REQUIRED'
                    error.transportFailure = true
                    error.moduleStartSent = moduleStartSent
                    error.transport_code = transportError.code || null
                    error.transport_message = transportError.message
                    error.cause = journalError
                    error.transfer_id = transferReservation.transfer_id
                    error.publish_success = null
                    error.manual_reconciliation_required = true
                    error.source_retained = fs.existsSync(transferReservation.entry.source_path)
                    error.marker_errors = journalError.marker_errors || null
                    error.durable_account_content_ledger = journalError.durable_account_content_ledger === true
                    error.account_content_ledger_path = journalError.account_content_ledger_path || null
                    rejectOnce(error)
                }
            }

            const markAppActivity = () => { lastAppMessageAt = Date.now() }
            const onAdbAlive = () => {
                livenessState.missStreak = 0
                livenessState.firstMissAt = 0
            }
            const stopLivenessWatch = () => {
                if (livenessTimer) {
                    clearInterval(livenessTimer)
                    livenessTimer = null
                }
                if (this._onAdbAlive === onAdbAlive) this._onAdbAlive = null
            }
            const livenessAdbWedged = () => {
                try {
                    const stats = require('./adb-util').getAdbProcessStats
                    const s = typeof stats === 'function' ? stats() : null
                    return !!s && (s.circuitOpen === true || (s.queued || 0) >= 16)
                } catch (_) { return false }
            }
            const livenessAdbServerRestartAt = () => {
                try {
                    const watchdog = require('./device-watchdog')
                    return typeof watchdog.getAdbServerRestartAt === 'function' ? watchdog.getAdbServerRestartAt() : 0
                } catch (_) { return 0 }
            }
            const livenessWatchdogSeenAt = () => {
                try {
                    const watchdog = require('./device-watchdog')
                    if (typeof watchdog.getIntents !== 'function') return 0
                    for (const intent of watchdog.getIntents() || []) {
                        if (intent.serial !== deviceId || intent.state !== 'device') continue
                        return intent.lastSeenOnlineAt || 0
                    }
                } catch (_) {}
                return 0
            }
            const livenessTick = async () => {
                if (terminalStarted || promiseSettled || !moduleStartSent) return
                // A local command in flight IS activity — the desktop is driving the
                // phone right now, however long the step legitimately takes.
                if (commandsInFlight > 0) { markAppActivity(); return }
                if (Date.now() - lastAppMessageAt < DEVICE_LIVENESS.PROBE_START_SILENCE_MS) return

                let result
                try {
                    // ONE host-level `adb devices`. Never `-s <serial> shell` (that
                    // hangs on a half-dead transport) and never via executeADB (its
                    // start-server + wait-for-device recovery adds ~14s and would
                    // defeat the entire point).
                    result = await runAdb(this.getADBPath(), ['devices'], DEVICE_LIVENESS.PROBE_TIMEOUT_MS)
                } catch (error) {
                    result = { code: null, stdout: '', stderr: '', error: error?.message || String(error) }
                }
                if (terminalStarted || promiseSettled) return

                const verdict = classifyDeviceLivenessProbe({
                    result,
                    deviceId,
                    // Cache-only twin lookup — never enumerate adb just to classify.
                    usbTwinSerial: this._devCache ? resolveUsbTwin(deviceId, this._devCache) : null,
                    adbWedged: livenessAdbWedged(),
                    adbServerRestartAt: livenessAdbServerRestartAt(),
                    watchdogSeenAt: livenessWatchdogSeenAt(),
                })
                applyDeviceLivenessVerdict(livenessState, verdict)
                if (!shouldAbortForDeviceLoss({ ...livenessState, commandsInFlight, lastAppMessageAt })) return

                terminalStarted = true
                this._deviceLostRun = true
                stopLivenessWatch()
                const silentSec = Math.round((Date.now() - lastAppMessageAt) / 1000)
                const error = new Error(
                    `Phone ${deviceId} stopped answering adb for ${silentSec}s while '${moduleId}' was running — run aborted. `
                    + `Check the USB cable (or Tailscale, if this phone runs wireless), then reconcile this phone before retrying.`
                )
                error.code = 'DEVICE_LOST'
                error.details = {
                    device_lost: true,
                    device_id: deviceId,
                    uncertain_outcome: moduleStartSent,
                    retryable: !moduleStartSent,
                }
                console.error(`[WS-Module] Device liveness lost for '${deviceId}' during '${moduleId}' after ${silentSec}s of silence. Aborting run.`)
                if (this.ws) {
                    // Tell the brain to stop BEFORE we close (same reasoning as the
                    // execution-timeout path): a bare close leaves the brain driving
                    // a phone whose slot we have already freed.
                    try { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'abort' })) } catch (e) { }
                    try { this.ws.close() } catch (e) { }
                }
                // NEVER this.abort() here. abortRequested would make
                // isUncertainNonIdempotentWsOutcome return false, so a paid,
                // possibly-created IG account would exit as a plain failure — and
                // bulk-account-creator would buy ANOTHER SMSPool number on the same
                // dead phone. settleTransportFailure keeps the uncertain mapping.
                void settleTransportFailure(
                    error,
                    'Module start was sent, but the phone stopped answering adb before a publish result was received',
                )
            }
            const startLivenessWatch = () => {
                if (livenessTimer || terminalStarted) return
                this._onAdbAlive = onAdbAlive
                livenessTimer = setInterval(() => { void livenessTick() }, DEVICE_LIVENESS.PROBE_CADENCE_MS)
                if (livenessTimer.unref) livenessTimer.unref()
            }

            // Set connection timeout
            connectionTimer = setTimeout(() => {
                if (!hasConnected && !terminalStarted) {
                    terminalStarted = true
                    releaseReservedTransfer()
                    const error = new Error('WebSocket connection timeout')
                    error.code = 'CONNECTION_TIMEOUT'
                    if (this.ws) {
                        try { this.ws.close() } catch (e) { }
                    }
                    rejectOnce(error)
                }
            }, CONNECTION_TIMEOUT)

            console.log(`[WS-Module] Connecting to server...`)

            this.ws = new WebSocket(this.serverUrl)

            this.ws.on('open', () => {
                console.log(`[WS-Module] Connected! Starting auth...`)
                // Clear connection timeout
                if (connectionTimer) {
                    clearTimeout(connectionTimer)
                    connectionTimer = null
                }
                hasConnected = true

                // Protocol-level pong handler. Uvicorn/websockets answers ws PING frames from
                // its own protocol task even while the brain's asyncio receive loop is blocked
                // in await handler(...), so lastPongAt stays fresh for a busy-but-alive brain.
                this.ws.on('pong', () => { lastPongAt = Date.now() })

                // Set execution timeout
                executionTimer = setTimeout(() => {
                    if (terminalStarted) return
                    terminalStarted = true
                    const error = new Error(
                        `Module exceeded 15-minute execution limit. ` +
                        `This usually means the module got stuck on a screen, a popup wasn't dismissed, ` +
                        `or the session had too many items to process. ` +
                        `Try reducing the count (e.g. fewer reels/stories per run) or check device logs for stuck screens.`
                    )
                    error.code = 'EXECUTION_TIMEOUT'
                    console.error(`[WS-Module] â±ï¸ TIMEOUT after 15 minutes for module '${moduleId}' on device '${deviceId}'. Closing connection.`)
                    if (this.ws) {
                        // Tell the brain to stop BEFORE we close. A bare close leaves the
                        // brain driving the phone (orphaned run) while the desktop frees
                        // the slot — a window for a second run to collide on the same phone.
                        try { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'abort' })) } catch (e) { }
                        try { this.ws.close() } catch (e) { }
                    }
                    void settleTransportFailure(
                        error,
                        'Module start was sent, but execution timed out before a publish result was received',
                    )
                }, EXECUTION_TIMEOUT)

                // Start keepalive once connected.
                heartbeatTimer = setInterval(() => {
                    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

                    const staleForMs = Date.now() - lastPongAt
                    if (staleForMs > HEARTBEAT_STALE_MS) {
                        if (terminalStarted) return
                        terminalStarted = true
                        const hbError = new Error(
                            `WebSocket keepalive timed out after ${Math.round(staleForMs / 1000)}s`
                        )
                        hbError.code = 'WS_HEARTBEAT_TIMEOUT'
                        console.error(`[WS-Module] Heartbeat timeout (${staleForMs}ms), closing socket`)
                        void settleTransportFailure(
                            hbError,
                            'Module start was sent, but the WebSocket heartbeat timed out before a publish result was received',
                        )
                        // Best-effort abort before close (mirrors the execution-timeout
                        // path) so the brain stops rather than orphan-driving the phone.
                        try { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'abort' })) } catch (e) { }
                        try { this.ws.close(4001, 'Heartbeat timeout') } catch (e) { }
                        return
                    }

                    try {
                        if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
                            // Protocol-level PING frame (not the app-level JSON ping). The brain
                            // processes modules inline in the same loop that reads WS messages, so
                            // app-level pings sit unanswered during a run; the ws protocol task
                            // replies to PING frames regardless, keeping the socket fresh.
                            this.ws.ping()
                        }
                    } catch (e) {
                        // Ignore; onerror/onclose will handle.
                    }
                }, HEARTBEAT_INTERVAL)

                // Build auth object based on auth type
                const authPayload = this.authType === 'jwt'
                    ? { jwt_token: this.authToken }  // JWT auth - user_id is extracted from token server-side
                    : { api_secret: this.authToken, user_id: userId }  // Legacy secret auth

                // Send auth message
                const connectMsg = {
                    type: 'connect',
                    auth: authPayload,
                    device_id: deviceId,
                    client_version: '1.3.0'
                }
                console.log(`[WS-Module] Sending connect message for device: ${deviceId}`)
                if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
                    this.ws.send(JSON.stringify(connectMsg))
                }
            })

            this.ws.on('message', async (data) => {
                try {
                    const msg = JSON.parse(data.toString())
                    console.log(`[WS-Module] Received message type: ${msg.type}`, msg.type === 'error' ? msg : '')
                    lastPongAt = Date.now()

                    switch (msg.type) {
                        case 'connected':
                            console.log(`[WS-Module] Auth successful, session: ${msg.session_id}`)
                            // Auth successful, start module
                            this.sessionId = msg.session_id
                            this.connected = true
                            // Session established

                            if (this.abortRequested) {
                                console.log('[WS-Module] Abort requested before module start; stopping session')
                                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                                    this.ws.send(JSON.stringify({ type: 'abort' }))
                                    this.ws.close(1000, 'User aborted')
                                }
                                break
                            }

                            // Start the module
                            console.log(`[WS-Module] Starting module: ${moduleId}, profile: ${profileId}`)
                            if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
                                this.ws.send(JSON.stringify({
                                    type: 'start_module',
                                    module_id: moduleId,
                                    profile_id: profileId,
                                    config: effectiveConfig
                                }))
                                moduleStartSent = true
                                markAppActivity()
                                startLivenessWatch()
                            }
                            break

                        case 'command':
                            markAppActivity()
                            if (this.abortRequested) {
                                console.log(`[WS-Module] Skipping command after abort: ${msg.action}`)
                                if (this.ws && this.ws.readyState === WebSocket.OPEN && msg.cmd_id) {
                                    this.ws.send(JSON.stringify({
                                        type: 'command_result',
                                        cmd_id: msg.cmd_id,
                                        success: false,
                                        error: 'Aborted by user'
                                    }))
                                }
                                break
                            }
                            // Execute command and send result back
                            console.log(
                                `[WS-Module] Executing command: ${msg.action}`,
                                redactCommandParams(msg.action, msg.params || {}),
                            )
                            commandsInFlight += 1
                            try {
                                const cmdResult = await this.executeCommand(deviceId, msg, { moduleId, transferReservation })

                                // Get screen state if requested
                                let screenData = null
                                let screenDumpFailed = false
                                if (msg.expect_screen_dump !== false) {
                                    const screenXml = await this.getScreenDump(deviceId)
                                    if (screenXml === null) {
                                        // Dump timed out (Tailnet+scrcpy contention) — command still succeeded.
                                        // Signal screen_dump_failed so the brain can explicitly re-request rather
                                        // than working off stale XML from a previous round-trip.
                                        screenDumpFailed = true
                                        console.warn(`[WS-Module] Screen dump returned null after successful command: ${msg.action} — brain should re-request`)
                                    }
                                    const currentApp = await this.getCurrentApp(deviceId)

                                    screenData = {
                                        xml: screenXml,
                                        current_app: currentApp,
                                        timestamp: Date.now()
                                    }
                                }

                                if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
                                    this.ws.send(JSON.stringify({
                                        type: 'command_result',
                                        cmd_id: msg.cmd_id,
                                        success: true,
                                        screen: screenData,
                                        screen_dump_failed: screenDumpFailed,
                                        data: cmdResult,
                                        executed_at: Date.now()
                                    }))
                                }
                            } catch (cmdError) {
                                console.error(`[WS-Module] Command failed: ${msg.action}`, cmdError.message)

                                // Diagnostics are useful only while the run is live. After abort,
                                // issuing a fresh dump can mutate adb state after ownership ended.
                                let failureScreen = null
                                if (!this.abortRequested) {
                                    try {
                                        const screenXml = await this.getScreenDump(deviceId)
                                        failureScreen = { xml: screenXml }
                                    } catch (e) { /* ignore */ }
                                }

                                if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
                                    this.ws.send(JSON.stringify({
                                        type: 'command_result',
                                        cmd_id: msg.cmd_id,
                                        success: false,
                                        error: cmdError.message,
                                        screen: failureScreen
                                    }))
                                }
                            } finally {
                                // Silence only accrues when NOTHING is in flight. This
                                // is what makes a 360s push_to_profile, a deliberate
                                // 10-40s radio drop and the ~74s executeADB recovery
                                // chain structurally unable to look like a dead phone.
                                commandsInFlight = Math.max(0, commandsInFlight - 1)
                                markAppActivity()
                            }
                            break

                        case 'progress':
                            markAppActivity()
                            if (onProgress) {
                                onProgress(msg.percent, msg.message)
                            }
                            break

                        case 'log':
                            // Real-time log message from server
                            markAppActivity()
                            rememberRealtimeLog(msg.message || msg.log)
                            invokeCallback('onLog', onLog, msg.message || msg.log)
                            break

                        case 'user_prompt':
                            // Server needs user input (e.g. 2FA handling)
                            markAppActivity()
                            console.log(`[WS-Module] User prompt received: ${msg.prompt_id}`)
                            if (onUserPrompt) {
                                // Provide a respond function that sends the answer back through WS
                                const respond = (action) => {
                                    if (this.ws && this.ws.readyState === 1) {
                                        this.ws.send(JSON.stringify({
                                            type: 'user_response',
                                            prompt_id: msg.prompt_id,
                                            action: action
                                        }))
                                        console.log(`[WS-Module] Sent user_response: ${action}`)
                                    }
                                }
                                onUserPrompt({
                                    promptId: msg.prompt_id,
                                    message: msg.message,
                                    options: msg.options || ['continue', 'cancel']
                                }, respond)
                            }
                            break

                        case 'pong':
                            // Heartbeat ACK from server.
                            lastPongAt = Date.now()
                            break

                        case 'complete': {
                            if (terminalStarted) break
                            // Completion owns the socket terminal state immediately, while
                            // promiseSettled remains false until reconciliation I/O finishes.
                            terminalStarted = true
                            const contentSelection = msg.data?.content_selection
                            const exactPublishProof = Boolean(msg.success && transferReservation)
                                && hasExactPublishProof(transferReservation, contentSelection)
                            const safeToRetry = Boolean(
                                !msg.success
                                && transferReservation
                                && msg.data?.publish_attempted === false
                                && msg.data?.safe_to_retry === true
                                && !(transferReservation.entry.method === OWNER_DOCUMENT_METHOD
                                    && pendingTransfers.get(transferReservation.transfer_id)?.ownerDispatchAttempted)
                            )
                            const ownerAbandoned = Boolean(!msg.success && !this.abortRequested && moduleId === 'post_feed'
                                && msg.data?.publish_attempted === false
                                && hasOwnerAbandonmentProof(transferReservation, msg.data?.owner_document_abandonment))
                            const uncertainModuleFailure = Boolean(
                                !msg.success
                                && transferReservation
                                && EXPLICIT_RETRY_PROOF_MODULES.has(moduleId)
                                && !safeToRetry
                                && !ownerAbandoned
                            )
                            try {
                                if (executionTimer) {
                                    clearTimeout(executionTimer)
                                    executionTimer = null
                                }
                                if (heartbeatTimer) {
                                    clearInterval(heartbeatTimer)
                                    heartbeatTimer = null
                                }
                                stopLivenessWatch()
                                if (Array.isArray(msg.logs)) deliverCompletionLogs(msg.logs)

                                if (uncertainModuleFailure) {
                                    if (transferReservation.entry.method === OWNER_DOCUMENT_METHOD) {
                                        msg.data = { ...(msg.data || {}), owner_document_cleanup: { cleaned: false, cleanup_pending: true } }
                                    }
                                    const moduleError = new Error(msg.error || 'Module failed after start without retry-safe publish proof')
                                    moduleError.code = msg.code || 'MODULE_OUTCOME_UNCERTAIN'
                                    moduleError.details = msg.data || null
                                    moduleError.publish_attempted = msg.data?.publish_attempted ?? null
                                    await settleTransportFailure(
                                        moduleError,
                                        msg.data?.publish_attempted === true
                                            ? 'Module reported a failure after the verified Share control was tapped'
                                            : 'Module failed after start without explicit proof that publishing was not attempted',
                                    )
                                    if (this.ws) { try { this.ws.close() } catch (e) { } }
                                    break
                                }

                                if (msg.success && transferReservation) {
                                    let archived
                                    if (exactPublishProof) {
                                        try {
                                            archived = await archivePublishedTransfer(transferReservation, contentSelection)
                                        } catch (archiveError) {
                                            const marker = await markPublishedSource(transferReservation.entry, archiveError)
                                            const record = pendingTransfers.get(transferReservation.transfer_id)
                                            if (record?.reservation_id === transferReservation.reservation_id) {
                                                consumePublishedReservation(record, transferReservation)
                                            }
                                            archived = Object.freeze({
                                                status: 'published_but_archive_failed',
                                                publish_success: true,
                                                archive_success: false,
                                                transfer_id: transferReservation.transfer_id,
                                                source_path: transferReservation.entry.source_path,
                                                archived_path: null,
                                                sha256: transferReservation.entry.sha256,
                                                archive_error: archiveError.message,
                                                durable_marker: marker.durable_marker,
                                                published_marker_path: marker.published_marker_path,
                                                marker_errors: marker.marker_errors,
                                                manual_cleanup_required: fs.existsSync(transferReservation.entry.source_path),
                                            })
                                        }
                                    } else {
                                        archived = await quarantineUnconfirmedTransfer(transferReservation)
                                    }
                                    reservationSettled = true
                                    msg.data = {
                                        ...(msg.data || {}),
                                        transfer_id: transferReservation.transfer_id,
                                        content_manifest_item: transferReservation.entry,
                                        archived_content: archived,
                                        content_archive_status: archived.status,
                                        publish_success: archived.publish_success,
                                        archive_success: archived.archive_success,
                                        device_selection: exactPublishProof ? 'exact' : 'unconfirmed',
                                        durable_marker: archived.durable_marker,
                                        published_marker_path: archived.published_marker_path,
                                        durable_account_content_ledger: archived.durable_account_content_ledger,
                                        account_content_ledger_path: archived.account_content_ledger_path,
                                        durable_archive_outcome: archived.durable_archive_outcome,
                                        archive_outcome_path: archived.archive_outcome_path,
                                        archive_outcome_error: archived.archive_outcome_error,
                                        manual_reconciliation_required: archived.manual_reconciliation_required === true,
                                    }
                                    if (transferReservation.entry.method === OWNER_DOCUMENT_METHOD) {
                                        msg.data.owner_document_cleanup = await this._settleOwnerDocument(transferReservation, { published: exactPublishProof })
                                        if (exactPublishProof && msg.data.owner_document_cleanup?.cleanup_pending === true) {
                                            invokeCallback('onLog', onLog, 'Publication succeeded. Temporary Owner document cleanup is pending; the post will not be submitted again.')
                                        }
                                    }
                                    if (!exactPublishProof) {
                                        msg.status = 'publish_unconfirmed_exact_selection'
                                        msg.data.status = 'publish_unconfirmed_exact_selection'
                                        invokeCallback('onLog', onLog, 'Publish outcome is unknown because exact gallery selection proof was missing; source retained and quarantined for manual reconciliation')
                                    } else if (!archived.archive_success) {
                                        msg.status = 'published_but_archive_failed'
                                        msg.data.status = 'published_but_archive_failed'
                                        msg.data.archive_warning = archived.archive_error
                                        invokeCallback('onLog', onLog, `Publish succeeded, but local content archival failed: ${archived.archive_error}`)
                                    } else if (archived.manual_reconciliation_required) {
                                        msg.status = archived.status
                                        msg.data.status = archived.status
                                        msg.data.archive_warning = archived.archive_outcome_error
                                        invokeCallback('onLog', onLog, `Publish and local archival succeeded, but the durable archive outcome requires manual reconciliation: ${archived.archive_outcome_error}`)
                                    }
                                } else if (!msg.success) {
                                    if (transferReservation?.entry.method === OWNER_DOCUMENT_METHOD) {
                                        const cleanup = await this._settleOwnerDocument(transferReservation, {
                                            abandonment: ownerAbandoned ? msg.data.owner_document_abandonment : null,
                                        })
                                        msg.data = { ...(msg.data || {}), owner_document_cleanup: cleanup,
                                            ...(ownerAbandoned ? { safe_to_retry: cleanup.cleaned === true, source_retained: true } : {}),
                                        }
                                    }
                                    releaseReservedTransfer()
                                }
                                if (msg.data?.move_instructions && !transferReservation) {
                                    console.warn('[WS-Module] Ignoring folder-based move_instructions without an exact transfer_id manifest')
                                }

                                if (this.ws) { try { this.ws.close() } catch (e) { } }
                                if (msg.success) {
                                    resolveOnce(msg, msg.data)
                                } else {
                                    const moduleError = new Error(msg.error || 'Module failed')
                                    moduleError.code = msg.code
                                    moduleError.details = msg.data || null
                                    rejectOnce(moduleError)
                                }
                            } catch (processingError) {
                                const reconciliationRequired = Boolean(msg.success && transferReservation)
                                if (reconciliationRequired) {
                                    consumeUncertainReservation(transferReservation)
                                    reservationSettled = true
                                } else {
                                    releaseReservedTransfer()
                                }
                                const error = new Error(
                                    reconciliationRequired
                                        ? `Publish completed, but its local content state requires manual reconciliation: ${processingError.message}`
                                        : `Module completion processing failed: ${processingError.message}`,
                                )
                                error.code = reconciliationRequired
                                    ? 'PUBLISH_RECONCILIATION_REQUIRED'
                                    : 'MODULE_COMPLETION_PROCESSING_FAILED'
                                error.cause = processingError
                                if (reconciliationRequired) {
                                    error.transfer_id = transferReservation.transfer_id
                                    error.publish_success = exactPublishProof ? true : null
                                    error.manual_reconciliation_required = true
                                        error.source_retained = fs.existsSync(transferReservation.entry.source_path)
                                        error.marker_errors = processingError.marker_errors || null
                                        error.durable_account_content_ledger = processingError.durable_account_content_ledger === true
                                        error.account_content_ledger_path = processingError.account_content_ledger_path || null
                                    }
                                if (this.ws) { try { this.ws.close() } catch (e) { } }
                                rejectOnce(error)
                            }
                            break
                        }

                        case 'error':
                            if (terminalStarted) break
                            terminalStarted = true
                            // Server error occurred - clear timers
                            console.error(`[WS-Module] Server error:`, msg)
                            if (executionTimer) {
                                clearTimeout(executionTimer)
                                executionTimer = null
                            }
                            if (heartbeatTimer) {
                                clearInterval(heartbeatTimer)
                                heartbeatTimer = null
                            }
                            stopLivenessWatch()
                            const serverError = new Error(msg.message || msg.error || 'Server error')
                            serverError.code = msg.code || 'SERVER_ERROR'
                            serverError.details = msg.details || null
                            await settleTransportFailure(
                                serverError,
                                'Server reported an error after module start without a trustworthy pre-publish retry signal',
                            )
                            if (this.ws) { try { this.ws.close() } catch (e) { } }
                            break

                        default:
                        // Unknown message
                    }
                } catch (parseError) {
                    // Parse error - silent
                }
            })

            this.ws.on('error', (error) => {
                // Clear all timers
                if (connectionTimer) clearTimeout(connectionTimer)
                if (executionTimer) clearTimeout(executionTimer)
                if (heartbeatTimer) clearInterval(heartbeatTimer)
                stopLivenessWatch()

                // Enhance error with code if not present
                if (!error.code) {
                    error.code = 'WS_ERROR'
                }
                console.error(`[WS-Module] WebSocket error: ${error.message}`)
                if (!terminalStarted) {
                    terminalStarted = true
                    void settleTransportFailure(
                        error,
                        'Module start was sent, but the WebSocket failed before a publish result was received',
                    )
                }
            })

            this.ws.on('close', (code, reason) => {
                // Clear all timers
                if (connectionTimer) clearTimeout(connectionTimer)
                if (executionTimer) clearTimeout(executionTimer)
                if (heartbeatTimer) clearInterval(heartbeatTimer)
                stopLivenessWatch()

                this.connected = false
                this.ws = null

                // If no terminal message owns the outcome, reject to avoid dangling forever.
                if (!terminalStarted) {
                    terminalStarted = true
                    const reasonText = Buffer.isBuffer(reason)
                        ? reason.toString('utf8')
                        : String(reason || '')
                    const suffix = reasonText ? `, reason: ${reasonText}` : ''
                    const closeError = new Error(`Automation WebSocket disconnected (code ${code}${suffix})`)
                    closeError.code = 'WS_CLOSED'
                    closeError.closeCode = code
                    closeError.closeReason = reasonText
                    void settleTransportFailure(
                        closeError,
                        'Module start was sent, but the WebSocket closed before a publish result was received',
                    )
                }
            })
        })
    }

    /**
     * Abort current module execution
     */
    abort() {
        console.log('[WS-Module] Aborting execution...')
        this.abortRequested = true
        this._moduleRunLockTicket?.cancel()
        this._adbAbortController.abort()

        if (this.ws) {
            try {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'abort' }))
                }
                // If still connecting, or server ignores abort, force close quickly.
                setTimeout(() => {
                    if (this.ws) {
                        console.log('[WS-Module] Force-closing after abort timeout')
                        this.ws.close(1000, 'User aborted')
                        this.connected = false
                        this.ws = null
                    }
                }, 1200)
            } catch (e) {
                console.error('[WS-Module] Abort error:', e.message)
                this.connected = false
                this.ws = null
            }
        }
    }

}

module.exports = {
    ModuleWebSocketClient,
    DEVICE_LIVENESS,
    parseAdbDevicesRows,
    adbRowsShowDevice,
    classifyDeviceLivenessProbe,
    applyDeviceLivenessVerdict,
    shouldAbortForDeviceLoss,
    planHumanTextInput,
    redactCommandParams,
    normalizeTransferContentType,
    planContentTransfer,
    registerTransferManifest,
    discardTransferManifest,
    reserveTransferForPost,
    releaseTransferReservation,
    archivePublishedTransfer,
    verifyProfileMediaEntry,
    detectProfileStorageFailure,
    canStageOwnerDocument,
    ownerEditorIsClosed,
    scanProfileMediaFile,
    createManifestHttpServer,
    pendingTransferCount,
    rememberPublishedSourceKey,
    publishedSourceCacheSize,
    normalizeInstagramAccountUsername,
    accountContentLedgerPath,
    accountContentOutcomePath,
    readAccountContentOutcome,
}
