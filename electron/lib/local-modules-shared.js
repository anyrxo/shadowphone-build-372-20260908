// electron/lib/local-modules-shared.js
/**
 * Shared helpers, state, and LocalDevice class used by all local module handlers.
 * This is the single source of truth for ADB utilities, UI parsing helpers,
 * GrapheneOS setup wizard automation, stats parsing, and the pending snapshots queue.
 */

const { execFileSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { runAdbSync } = require('./adb-util')

// ── ADB helper (reuses logic from ws-module-client.js) ───────────
let _adbPath = null

function getADBPath() {
    if (_adbPath) return _adbPath
    // Headless / VPS override: a box without the bundled adb can point at a known
    // adb binary (the runner drives phones over ANDROID_ADB_SERVER_SOCKET regardless).
    if (process.env.SP_ADB_PATH) { _adbPath = process.env.SP_ADB_PATH; return _adbPath }
    const platform = os.platform()
    const possiblePaths = []

    try {
        const { app } = require('electron')
        const userDataPath = app.getPath('userData')
        const adbBinary = platform === 'win32' ? 'adb.exe' : 'adb'
        possiblePaths.push(path.join(userDataPath, 'adb', adbBinary))
    } catch (e) { /* not in Electron context */ }

    if (platform === 'win32') {
        possiblePaths.push(
            path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
            path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
            'C:\\Program Files\\Android\\platform-tools\\adb.exe',
            'C:\\Android\\platform-tools\\adb.exe',
            'C:\\platform-tools\\adb.exe',
        )
    } else if (platform === 'darwin') {
        possiblePaths.push(
            '/usr/local/bin/adb',
            path.join(process.env.HOME || '', 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
        )
    } else {
        possiblePaths.push('/usr/bin/adb')
    }

    for (const p of possiblePaths) {
        try { if (p && fs.existsSync(p)) { _adbPath = p; return p } } catch (e) { }
    }

    // System PATH fallback
    try {
        const cmd = platform === 'win32' ? 'where adb.exe' : 'which adb'
        const result = execFileSync(platform === 'win32' ? 'cmd' : 'sh',
            platform === 'win32' ? ['/c', cmd] : ['-c', cmd],
            { encoding: 'utf8', timeout: 5000 }).trim()
        if (result) { _adbPath = result.split('\n')[0].trim(); return _adbPath }
    } catch (e) { }

    _adbPath = platform === 'win32' ? 'adb.exe' : 'adb'
    return _adbPath
}

function _syncSleep(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch (_) { /* SAB unavailable */ }
}
// Transient adb-server churn: a version-mismatched/killed/reset server (the
// device-watchdog kill-server + scrcpy's adb fighting over :5037) makes a call
// fail while the server restarts. The app tolerates this implicitly; retry so it,
// and a headless/VPS run, survive it.
const _ADB_TRANSIENT = /protocol fault|connection reset|doesn't match this client|device offline|device '[^']*' not found|failed to (?:start|check)|daemon|closed|process capacity is full|queue is full/i

function adb(args, deviceId = null) {
    const fullArgs = deviceId ? ['-s', deviceId, ...args] : args
    let lastErr
    for (let attempt = 0; attempt < 3; attempt++) {
        const result = runAdbSync(getADBPath(), fullArgs, 30000)
        if (result.code === 0) return result.stdout.trim()
        const error = new Error(result.stderr || result.error || `ADB exited with code ${result.code}`)
        error.code = result.code
        error.stderr = result.stderr
        lastErr = error
        if (attempt < 2 && _ADB_TRANSIENT.test(error.message)) {
            runAdbSync(getADBPath(), ['start-server'], 8000)
            _syncSleep(1000)
            continue
        }
        throw error
    }
    throw lastErr
}

function shell(deviceId, command) {
    return adb(['shell', command], deviceId)
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Validate an Android user/profile id before interpolating into `am switch-user` /
// `pm remove-user` shell strings. Inputs flow from scheduler/Airtable JSON, so a
// non-digit value here is a shell-injection vector (e.g. "0;rm -rf /sdcard").
function safeUserId(value) {
    const str = String(value ?? '').trim()
    if (!/^\d+$/.test(str)) return null
    return str
}

// Quote an arbitrary string for safe use as a single argv element in
// `adb shell <cmd> ...`. `adb shell` re-evaluates the resulting string
// through `sh` on the device, so any unquoted special chars in the
// argument become shell metacharacters. Wrap the whole thing in single
// quotes and escape any embedded single quotes via `'\''` (the standard
// POSIX-shell technique).
function quoteAndroidShell(value) {
    const str = String(value ?? '')
    return `'${str.replace(/'/g, "'\\''")}'`
}

// Validate a human-supplied profile/account name. Allow letters, digits,
// space, underscore, dash, dot. Reject anything else — including the
// shell metacharacters that would let an Airtable row or untrusted form
// input pivot to arbitrary `adb shell` execution.
function safeProfileName(value) {
    const str = String(value ?? '').trim()
    if (!str) return null
    if (str.length > 64) return null
    if (!/^[A-Za-z0-9 ._-]+$/.test(str)) return null
    return str
}

function parseBounds(bounds) {
    const match = String(bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (!match) return null
    const x1 = Number(match[1]), y1 = Number(match[2]), x2 = Number(match[3]), y2 = Number(match[4])
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null
    return {
        x: Math.round((x1 + x2) / 2),
        y: Math.round((y1 + y2) / 2),
        x1, y1, x2, y2,
    }
}

function parseUiNodes(xml) {
    const nodes = []
    const nodeRegex = /<node\b[^>]*>/gi
    const attrRegex = /([\w:-]+)=(["'])(.*?)\2/gs
    let nodeMatch
    while ((nodeMatch = nodeRegex.exec(String(xml || ''))) !== null) {
        const raw = nodeMatch[0]
        const attrs = {}
        let attrMatch
        while ((attrMatch = attrRegex.exec(raw)) !== null) {
            attrs[attrMatch[1]] = attrMatch[3]
        }
        const center = parseBounds(attrs.bounds)
        if (center) nodes.push({ raw, attrs, center })
    }
    return nodes
}

function findControlCenter(xml, labels, resourceIds = []) {
    const normalizedLabels = labels.map(label => String(label).trim().toLowerCase()).filter(Boolean)
    const normalizedIds = resourceIds.map(id => String(id).trim().toLowerCase()).filter(Boolean)
    const nodes = parseUiNodes(xml)

    const exactLabel = nodes.find(node => {
        const text = String(node.attrs.text || '').trim().toLowerCase()
        const desc = String(node.attrs['content-desc'] || '').trim().toLowerCase()
        return normalizedLabels.includes(text) || normalizedLabels.includes(desc)
    })
    if (exactLabel) return exactLabel.center

    const idMatch = nodes.find(node => {
        const resourceId = String(node.attrs['resource-id'] || '').trim().toLowerCase()
        return normalizedIds.some(id => resourceId === id || resourceId.endsWith(`/${id}`) || resourceId.includes(id))
    })
    if (idMatch) return idMatch.center

    return null
}

function isGrapheneSetupWizardXml(xml) {
    const lower = String(xml || '').toLowerCase()
    return lower.includes('welcome to grapheneos')
        || lower.includes('grapheneos setup')
        || lower.includes('location services')
        || lower.includes('set a pin')
        || lower.includes('skip setup for pin')
        || lower.includes('fingerprint unlock')
        || lower.includes('restore apps')
        || lower.includes("you're all set")
        || lower.includes('app.grapheneos.setupwizard')
        || lower.includes('org.grapheneos.setupwizard')
}

function isGrapheneSetupWizardActivity(output) {
    const lower = String(output || '').toLowerCase()
    return lower.includes('setupwizard')
        || lower.includes('setup_wizard')
        || lower.includes('app.grapheneos.setupwizard')
        || lower.includes('org.grapheneos.setupwizard')
        || lower.includes('com.google.android.setupwizard')
}

async function isGrapheneSetupWizardVisible(device) {
    try {
        await device.getScreen()
        if (isGrapheneSetupWizardXml(device.currentScreen || '')) return true
    } catch {}

    try {
        const windowDump = device.shell('dumpsys window')
        const focusLines = String(windowDump || '')
            .split(/\r?\n/)
            .filter(line => /mCurrentFocus|mFocusedApp|topResumedActivity|setupwizard/i.test(line))
            .join('\n')
        return isGrapheneSetupWizardActivity(focusLines)
    } catch {
        return false
    }
}

const SETUP_WIZARD_NEXT_IDS = [
    'next',
    'next_button',
    'sud_layout_next',
    'sud_navbar_next',
    'app.grapheneos.setupwizard:id/next',
    'app.grapheneos.setupwizard:id/next_button',
    'app.grapheneos.setupwizard:id/sud_layout_next',
    'app.grapheneos.setupwizard:id/sud_navbar_next',
    'org.grapheneos.setupwizard:id/next',
    'org.grapheneos.setupwizard:id/next_button',
    'com.google.android.setupwizard:id/suc_layout_next',
    'com.google.android.setupwizard:id/sud_layout_next',
]

const SETUP_WIZARD_SKIP_IDS = [
    'skip',
    'skip_button',
    'sud_layout_skip',
    'sud_navbar_skip',
    'app.grapheneos.setupwizard:id/skip',
    'app.grapheneos.setupwizard:id/skip_button',
    'app.grapheneos.setupwizard:id/sud_layout_skip',
    'org.grapheneos.setupwizard:id/skip',
    'org.grapheneos.setupwizard:id/skip_button',
    'com.google.android.setupwizard:id/suc_layout_skip',
    'com.google.android.setupwizard:id/sud_layout_skip',
]

async function getScreenSize(device) {
    try {
        const output = device.shell('wm size')
        const match = String(output || '').match(/Physical size:\s*(\d+)x(\d+)/i)
        if (match) return { width: Number(match[1]), height: Number(match[2]) }
    } catch {}
    return { width: 1080, height: 2400 }
}

async function tapSetupWizardControl(device, xml, labels, fallbackRatio = null, resourceIds = []) {
    const center = findControlCenter(xml, labels, resourceIds)
    if (center) {
        await device.tap(center.x, center.y, 450)
        return { tapped: true, label: labels[0], x: center.x, y: center.y, exact: true }
    }

    if (!fallbackRatio) return { tapped: false }
    const size = await getScreenSize(device)
    const x = Math.round(size.width * fallbackRatio.x)
    const y = Math.round(size.height * fallbackRatio.y)
    await device.tap(x, y, 450)
    return { tapped: true, label: labels[0], x, y, exact: false }
}

async function completeGrapheneSetupWizard(device, maxSteps = 8) {
    const steps = []
    let detected = false

    for (let i = 0; i < maxSteps; i++) {
        await device.getScreen()
        const xml = device.currentScreen || ''
        const lower = xml.toLowerCase()
        const wizardVisible = isGrapheneSetupWizardXml(xml)

        if (!wizardVisible) {
            if (await isGrapheneSetupWizardVisible(device)) {
                detected = true
                const action = await tapSetupWizardControl(
                    device,
                    xml,
                    ['Next', 'Continue', 'Get started', 'Start', 'Done', 'Skip'],
                    { x: 0.86, y: 0.91 },
                    SETUP_WIZARD_NEXT_IDS
                )
                if (!action?.tapped) return { detected, completed: false, steps, reason: 'wizard_visible_no_xml_button' }
                steps.push(action.exact ? action.label : `${action.label} fallback`)
                await sleep(700)
                continue
            }
            return { detected, completed: true, steps }
        }
        detected = true

        let action = null
        if (lower.includes('location services')) {
            if (lower.includes('sud_items_switch') && lower.includes('checked="true"')) {
                const toggle = findControlCenter(xml, [], ['sud_items_switch'])
                if (toggle) {
                    await device.tap(toggle.x, toggle.y, 350)
                    steps.push('Disable location')
                    await device.getScreen()
                }
            }
            action = await tapSetupWizardControl(
                device,
                device.currentScreen || xml,
                ['Next'],
                { x: 0.86, y: 0.91 },
                SETUP_WIZARD_NEXT_IDS
            )
        } else if (lower.includes('set a pin')) {
            action = await tapSetupWizardControl(device, xml, ['Skip'], { x: 0.1, y: 0.63 }, SETUP_WIZARD_SKIP_IDS)
        } else if (lower.includes('skip setup for pin') || lower.includes('fingerprint unlock')) {
            action = await tapSetupWizardControl(device, xml, ['Skip'], { x: 0.828, y: 0.58 }, SETUP_WIZARD_SKIP_IDS)
        } else if (lower.includes('restore apps')) {
            action = await tapSetupWizardControl(device, xml, ['Skip'], { x: 0.1, y: 0.908 }, SETUP_WIZARD_SKIP_IDS)
        } else if (lower.includes("you're all set") || lower.includes('you&apos;re all set')) {
            action = await tapSetupWizardControl(device, xml, ['Start', 'Done', 'Finish'], { x: 0.86, y: 0.91 }, ['start_button', 'done_button', ...SETUP_WIZARD_NEXT_IDS])
        } else {
            action = await tapSetupWizardControl(
                device,
                xml,
                ['Next', 'Continue', 'Get started', 'Start', 'Done', 'Skip'],
                { x: 0.86, y: 0.91 },
                [...SETUP_WIZARD_NEXT_IDS, 'done_button', ...SETUP_WIZARD_SKIP_IDS]
            )
        }

        if (!action?.tapped) {
            return { detected, completed: false, steps, reason: 'button_not_found' }
        }

        steps.push(action.exact ? action.label : `${action.label} fallback`)
        await sleep(350)
    }

    const completed = !(await isGrapheneSetupWizardVisible(device))
    return { detected, completed, steps, reason: completed ? null : 'max_steps_reached' }
}

/**
 * Parse IG profile stats from screen XML.
 * Returns { followers, following, posts } or null if not on a profile screen.
 * Works with content-desc attributes like "44.8Kfollowers", "567friends", "30posts"
 */
function parseStatsFromXml(xml) {
    if (!xml) return null
    const followersMatch = xml.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*(?:followers?|Followers?)/i)
    const followingMatch = xml.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*(?:following|Following|friends)/i)
    const postsMatch = xml.match(/(\d+(?:,\d+)*)\s*(?:posts?|Posts?)/i)
    if (!followersMatch && !followingMatch && !postsMatch) return null
    return {
        followers: followersMatch ? followersMatch[1] : null,
        following: followingMatch ? followingMatch[1] : null,
        posts: postsMatch ? postsMatch[1] : null,
    }
}

/**
 * Parse stat string like "44.8K" or "1,234" to a number.
 */
function parseStatNumber(val) {
    if (!val) return 0
    const clean = String(val).replace(/,/g, '')
    if (clean.endsWith('K') || clean.endsWith('k')) return Math.round(parseFloat(clean) * 1000)
    if (clean.endsWith('M') || clean.endsWith('m')) return Math.round(parseFloat(clean) * 1000000)
    if (clean.endsWith('B') || clean.endsWith('b')) return Math.round(parseFloat(clean) * 1000000000)
    return parseInt(clean, 10) || 0
}

// Pending stats snapshots — flushed to Supabase by the main process.
// Bounded FIFO: capped at MAX_PENDING_SNAPSHOTS so the array can't grow forever
// if the user never has a session (flush is then skipped — see module-handlers.js).
const MAX_PENDING_SNAPSHOTS = 500
const _pendingSnapshots = []

/**
 * Queue a stats snapshot for later Supabase flush.
 * Called passively when we happen to be on a profile screen.
 * `context` carries optional profile_id / run_id / module_id for traceability —
 * the IPC handler injects these from the run config before invoking handlers.
 */
function queueStatsSnapshot(username, stats, deviceId, context = {}) {
    if (!username || !stats) return
    if (_pendingSnapshots.length >= MAX_PENDING_SNAPSHOTS) {
        _pendingSnapshots.shift() // drop oldest
    }
    _pendingSnapshots.push({
        username,
        followers: parseStatNumber(stats.followers),
        following: parseStatNumber(stats.following),
        posts: parseStatNumber(stats.posts),
        captured_at: new Date().toISOString(),
        device_id: deviceId,
        profile_id: context.profile_id ?? null,
        run_id: context.run_id ?? null,
        module_id: context.module_id ?? null,
        source: 'local_passive',
    })
}

function getPendingSnapshots() {
    return _pendingSnapshots.splice(0) // drain and return
}

// ── LocalDevice — lightweight local equivalent of RemoteDevice ────
function isInstagramNotificationPermission(xml) {
    const screen = String(xml || '').toLowerCase()
    return /(?:package|resource-id)="com\.(?:android|google\.android)\.permissioncontroller(?:"|:id\/)/.test(screen)
        && screen.includes('instagram') && screen.includes('notification')
}

function instagramLocationPopup(xml) {
    const nodes = parseUiNodes(xml).filter(({ attrs }) => attrs['visible-to-user'] !== 'false')
    const label = value => String(value || '').replace(/[\u2018\u2019]/g, "'")
        .replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()
    const hasLabel = (node, text) => [node.attrs.text, node.attrs['content-desc']].some(value => label(value) === text)
    const instagramNodes = nodes.filter(({ attrs }) => attrs.package === 'com.instagram.android')
    const permissionNodes = nodes.filter(({ attrs }) => /^com\.(?:android|google\.android)\.permissioncontroller$/.test(attrs.package || ''))
    const control = (candidates, text) => {
        const matches = candidates.filter(node => hasLabel(node, text) && node.attrs.enabled !== 'false'
            && (node.attrs.clickable === 'true' || node.attrs.class === 'android.widget.Button'))
        return matches.length === 1 ? matches[0].center : null
    }

    if (permissionNodes.some(({ attrs }) => /:id\/permission_message$/.test(attrs['resource-id'] || '')
        && /^allow instagram to access (?:this device's|your) location\??$/.test(label(attrs.text)))) {
        return { kind: 'permission', control: control(permissionNodes, "don't allow") }
    }
    if (instagramNodes.some(node => node.attrs['resource-id'] === 'com.instagram.android:id/igds_alert_dialog_headline'
        && hasLabel(node, 'open your location settings to allow "instagram" access to your location'))) {
        return { kind: 'settings', control: control(instagramNodes, 'cancel') }
    }
    if (instagramNodes.some(node => hasLabel(node, 'set up on new device'))
        && instagramNodes.some(node => hasLabel(node, 'to use location services, allow instagram to access your location'))) {
        return { kind: 'setup', control: control(instagramNodes, 'continue') }
    }
    return null
}

class LocalDevice {
    constructor(deviceId, progressCallback, logCallback) {
        this.deviceId = deviceId
        this._onProgress = progressCallback || (() => {})
        this._onLog = logCallback || (() => {})
        this.currentScreen = null
    }

    sendProgress(percent, message) {
        this._onProgress(percent, message)
    }

    sendLog(message, level = 'INFO') {
        this._onLog(message, level)
    }

    adb(args) {
        return adb(args, this.deviceId)
    }

    shell(command) {
        return shell(this.deviceId, command)
    }

    async tap(x, y, waitAfter = 500) {
        this.adb(['shell', 'input', 'tap', String(x), String(y)])
        if (waitAfter > 0) await sleep(waitAfter)
    }

    async swipe(x1, y1, x2, y2, durationMs = 300, waitAfter = 500) {
        this.adb(['shell', 'input', 'swipe',
            String(x1), String(y1), String(x2), String(y2), String(durationMs)])
        if (waitAfter > 0) await sleep(waitAfter)
    }

    async keyevent(keycode) {
        this.adb(['shell', 'input', 'keyevent', String(keycode)])
    }

    async back() { await this.keyevent(4) }
    async home() { await this.keyevent(3) }
    async enter() { await this.keyevent(66) }

    async inputText(text) {
        // adb shell re-evaluates the command via `sh -c` on-device, so backslash-escaping
        // metacharacters leaves literal backslashes in the typed string. Instead:
        //   1. spaces -> %s (input text's own escape — single quotes don't help here
        //      because `input text` tokenizes its argv by spaces)
        //   2. wrap the whole arg in single quotes so the device shell sees literal $, !, &, etc.
        //   3. close-escape-reopen for any embedded single quote: ' -> '\''
        const withSpaceEscape = String(text || '').replace(/ /g, '%s')
        const singleQuoteEscaped = withSpaceEscape.replace(/'/g, "'\\''")
        this.adb(['shell', 'input', 'text', `'${singleQuoteEscaped}'`])
    }

    async getScreen() {
        try {
            this.adb(['shell', 'uiautomator', 'dump', '--compressed', '/sdcard/window_dump.xml'])
            this.currentScreen = this.adb(['shell', 'cat', '/sdcard/window_dump.xml'])
            // Immediately delete the XML dump — no trace left on phone
            try { this.adb(['shell', 'rm', '-f', '/sdcard/window_dump.xml']) } catch (e) { /* best effort */ }
        } catch (e) {
            this.currentScreen = null
        }
        return this.currentScreen
    }

    textOnScreen(text) {
        if (!this.currentScreen) return false
        return this.currentScreen.toLowerCase().includes(text.toLowerCase())
    }

    findElementByText(text) {
        if (!this.currentScreen) return null
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp(
            `text="[^"]*${escaped}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i')
        const match = this.currentScreen.match(pattern)
        if (match) {
            return { x: Math.floor((parseInt(match[1]) + parseInt(match[3])) / 2),
                     y: Math.floor((parseInt(match[2]) + parseInt(match[4])) / 2) }
        }
        // Try reverse attribute order
        const patternRev = new RegExp(
            `bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*text="[^"]*${escaped}[^"]*"`, 'i')
        const matchRev = this.currentScreen.match(patternRev)
        if (matchRev) {
            return { x: Math.floor((parseInt(matchRev[1]) + parseInt(matchRev[3])) / 2),
                     y: Math.floor((parseInt(matchRev[2]) + parseInt(matchRev[4])) / 2) }
        }
        return null
    }

    findElementByContentDesc(desc) {
        if (!this.currentScreen) return null
        const escaped = desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp(
            `content-desc="[^"]*${escaped}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i')
        const match = this.currentScreen.match(pattern)
        if (match) {
            return { x: Math.floor((parseInt(match[1]) + parseInt(match[3])) / 2),
                     y: Math.floor((parseInt(match[2]) + parseInt(match[4])) / 2) }
        }
        const patternRev = new RegExp(
            `bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*content-desc="[^"]*${escaped}[^"]*"`, 'i')
        const matchRev = this.currentScreen.match(patternRev)
        if (matchRev) {
            return { x: Math.floor((parseInt(matchRev[1]) + parseInt(matchRev[3])) / 2),
                     y: Math.floor((parseInt(matchRev[2]) + parseInt(matchRev[4])) / 2) }
        }
        return null
    }

    findElementByResourceId(resourceId) {
        if (!this.currentScreen) return null
        const exactNode = parseUiNodes(this.currentScreen).find(node => (
            node.attrs['resource-id'] === resourceId
        ))
        if (exactNode) {
            return { x: exactNode.center.x, y: exactNode.center.y }
        }
        if (String(resourceId).includes(':id/')) return null
        const escaped = resourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp(
            `resource-id="[^"]*${escaped}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i')
        const match = this.currentScreen.match(pattern)
        if (match) {
            return { x: Math.floor((parseInt(match[1]) + parseInt(match[3])) / 2),
                     y: Math.floor((parseInt(match[2]) + parseInt(match[4])) / 2) }
        }
        const patternRev = new RegExp(
            `bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*resource-id="[^"]*${escaped}[^"]*"`, 'i')
        const matchRev = this.currentScreen.match(patternRev)
        if (matchRev) {
            return { x: Math.floor((parseInt(matchRev[1]) + parseInt(matchRev[3])) / 2),
                     y: Math.floor((parseInt(matchRev[2]) + parseInt(matchRev[4])) / 2) }
        }
        return null
    }

    findAllElementsByText(text) {
        if (!this.currentScreen) return []
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const results = []
        for (const pat of [
            new RegExp(`text="[^"]*${escaped}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'gi'),
            new RegExp(`bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*text="[^"]*${escaped}[^"]*"`, 'gi'),
        ]) {
            let m
            while ((m = pat.exec(this.currentScreen)) !== null) {
                const coord = { x: Math.floor((parseInt(m[1]) + parseInt(m[3])) / 2),
                                y: Math.floor((parseInt(m[2]) + parseInt(m[4])) / 2) }
                if (!results.some(r => r.x === coord.x && r.y === coord.y)) {
                    results.push(coord)
                }
            }
        }
        return results
    }

    async scrollDown(amount = 800) {
        await this.swipe(540, 1500, 540, 1500 - amount, 300)
    }

    async scrollUp(amount = 800) {
        await this.swipe(540, 700, 540, 700 + amount, 300)
    }

    async launchApp(packageName, waitAfter = 3000) {
        this.adb(['shell', 'monkey', '-p', packageName, '-c',
            'android.intent.category.LAUNCHER', '1'])
        if (waitAfter > 0) await sleep(waitAfter)
    }

    async dismissCommonPopups() {
        for (let attempt = 0; attempt < 3 && !this.currentScreen; attempt++) {
            await this.getScreen()
            if (!this.currentScreen && attempt < 2) await sleep(200)
        }
        if (!this.currentScreen) return 0
        let dismissed = 0
        const { detectVerificationState } = require('./modules/account_insights')
        const dismissLocationPopups = async () => {
            if (!this.currentScreen || detectVerificationState(this.currentScreen)) return false
            const visited = new Set()
            let popup = instagramLocationPopup(this.currentScreen)
            while (popup) {
                if (visited.has(popup.kind) || !popup.control) return false
                visited.add(popup.kind)
                await this.tap(popup.control.x, popup.control.y)
                await this.getScreen()
                if (!this.currentScreen || detectVerificationState(this.currentScreen)) return false
                popup = instagramLocationPopup(this.currentScreen)
                if (!popup && /package=["']com\.(?:android|google\.android)\.permissioncontroller["']/.test(this.currentScreen)) return false
            }
            if (visited.size) dismissed++
            return true
        }
        if (!await dismissLocationPopups()) return dismissed
        if (isInstagramNotificationPermission(this.currentScreen)) {
            const deny = parseUiNodes(this.currentScreen).find(({ attrs }) => {
                if (attrs.enabled === 'false') return false
                const id = attrs['resource-id'] || ''
                if (/^com\.(?:android|google\.android)\.permissioncontroller:id\/permission_deny_button$/.test(id)) return true
                const label = String(attrs.text || attrs['content-desc'] || '').replace(/[\u2018\u2019]/g, "'").trim().toLowerCase()
                return label === "don't allow" && (attrs.clickable === 'true' || attrs.class === 'android.widget.Button')
            })
            if (!deny) return 0
            await this.tap(deny.center.x, deny.center.y)
            await this.getScreen()
            if (!this.currentScreen || isInstagramNotificationPermission(this.currentScreen)) return 0
            dismissed++
        }
        if (!await dismissLocationPopups()) return dismissed
        const feedPreviewMarkers = [
            'com.instagram.android:id/feed_preview_keep_watching_backdrop',
            'com.instagram.android:id/feed_preview_keep_watching_button',
        ]
        if (feedPreviewMarkers.every(marker => this.currentScreen.includes(marker))) {
            await this.back()
            await sleep(300)
            await this.getScreen()
            dismissed++
        }
        const popups = [
            { check: 'Turn on Notifications', tap: 'Not Now' },
            { check: 'notifications make things easier', tap: 'No thanks' },
            { check: 'Vanadium notifications', tap: 'No thanks' },
            { check: 'Got it', tap: 'Got it' },
            { check: 'Save your login info', tap: 'Not now' },
            { check: 'Allow notifications', tap: 'Not now' },
            { check: 'Dismiss', tap: 'Dismiss' },
            { check: 'Skip', tap: 'Skip' },
            { check: 'Not now', tap: 'Not now' },
            { check: 'No thanks', tap: 'No thanks' },
            { check: 'Allow', tap: 'Allow' },
            { check: 'While using the app', tap: 'While using the app' },
        ]
        for (const popup of popups) {
            if (!await dismissLocationPopups()) return dismissed
            if (isInstagramNotificationPermission(this.currentScreen)) return dismissed
            if (this.textOnScreen(popup.check)) {
                const el = this.findElementByText(popup.tap)
                if (el) {
                    await this.tap(el.x, el.y)
                    await sleep(500)
                    await this.getScreen()
                    dismissed++
                }
            }
        }
        await dismissLocationPopups()
        return dismissed
    }

    async wait(ms) {
        await sleep(ms)
    }
}

module.exports = {
    // ADB utilities
    getADBPath,
    adb,
    shell,
    sleep,
    // Input validators
    safeUserId,
    quoteAndroidShell,
    safeProfileName,
    // UI XML parsing
    parseBounds,
    parseUiNodes,
    findControlCenter,
    isInstagramNotificationPermission,
    // GrapheneOS setup wizard
    isGrapheneSetupWizardXml,
    isGrapheneSetupWizardActivity,
    isGrapheneSetupWizardVisible,
    completeGrapheneSetupWizard,
    SETUP_WIZARD_NEXT_IDS,
    SETUP_WIZARD_SKIP_IDS,
    getScreenSize,
    tapSetupWizardControl,
    // Stats parsing
    parseStatsFromXml,
    parseStatNumber,
    // Pending snapshots queue
    queueStatsSnapshot,
    getPendingSnapshots,
    // Device class
    LocalDevice,
}
