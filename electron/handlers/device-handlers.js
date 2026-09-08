/**
 * Device Management IPC Handlers
 * Handles ADB device detection, monitoring, and device operations
 */

const { ipcMain, shell } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { runAdb } = require('../lib/adb-util')
const { classifyTransport, mergeByHwSerial, hwSerialFor, withStableHwSerialProvenance } = require('../lib/device-identity')
const { scanForAdbPort } = require('../lib/companion-discovery')
const { isTailnetRoutable, TAILNET_CGNAT_RE } = require('../lib/tailscale-status')
const { appAuthFetch } = require('../lib/app-auth-fetch')

// Device state management
let connectedDevices = []
// hwSerial -> { ip, port }: last seen tailnet endpoint. Lets the WiFi toggle stay
// selectable + reconnect after a transient relay drop (the adb link flaps).
let lastKnownTailnet = {}
// hwSerial -> consecutive polls where the phone was present but had NO live tailnet
// twin. After TAILNET_STALE_MISSES misses we prune lastKnownTailnet[devKey] so a
// phone genuinely off the tailnet stops advertising WiFi-available (and the forced-
// WiFi branch stops pointing ops at a dead cached tcp endpoint).
let tailnetMissCounts = {}
const TAILNET_STALE_MISSES = 3
// hwSerial -> consecutive polls where the phone was FULLY absent from adb (no USB
// twin, no TCP twin). The present-but-no-twin sweep above never visits these (it
// runs inside dedup.map, which only iterates phones seen this poll), so a phone
// that drops off adb entirely would keep a stale lastKnownTailnet endpoint forever
// (until a full resetUserScopedState). This is gated MORE forgivingly than the
// present-phone sweep: the tailnet tunnel flakes ('error: closed') and a phone can
// vanish for 1-2 polls then return, so a single-miss prune would thrash a phone
// that is only transiently gone and kill its WiFi-reconnect path.
let tailnetAbsentCounts = {}
const TAILNET_ABSENT_PRUNE = 6   // ~30s at the 5s poll cadence
// devKeys with a detached rotated-port rescan in flight. The per-poll forced-WiFi
// fallback runs every ~5s and a cold scanForAdbPort is 50-120s, so we MUST NOT
// block the poll on it — instead fire one detached scan per device and latch it so
// overlapping scans don't pile up. Cleared the moment a live tailnet twin reappears
// for that key (so a phone that drops again later can be rescanned).
let _tailnetRescanInflight = new Set()
let alertedNewDevices = new Set()
let userSavedDevices = []
let previousDeviceSerials = new Set()
let monitoringInterval = null
let mainWindow = null
let adbPath = null

// Detection gate — true once the renderer has synced saved devices from
// Supabase at least once via 'set-saved-devices'. The live monitor must not
// run new-device checks before this (every fleet phone would look "new").
let savedDevicesSynced = false

// Local nickname overrides — { [serial]: nickname } persisted to userData
// so the desktop remembers your custom label across reconnects even if you
// never set a Device name on the Android side.
let deviceNicknames = {}
let nicknamesFilePath = null

// Per-device connection-transport preference — { [hwSerial]: 'auto'|'usb'|'wifi' }
// persisted to userData. 'auto' (default) keeps the M4 prefer-USB merge exactly
// as-is; 'usb'/'wifi' force the operational serial onto that transport when the
// target form is available, so EVERY op for that phone reroutes accordingly.
let deviceTransportPrefs = {}
let transportPrefsFilePath = null
const VALID_TRANSPORT_PREFS = ['usb', 'wifi']   // 'auto' removed — default is USB

// Injected from main.js so the handler can sync renames to Supabase via the
// Next.js API. Set in initDeviceHandlers.
let appUrl = null
let getSessionToken = () => null
let registeredDeviceActions = null

function loadDeviceNicknames(app) {
    try {
        nicknamesFilePath = path.join(app.getPath('userData'), 'device-nicknames.json')
        if (fs.existsSync(nicknamesFilePath)) {
            const raw = fs.readFileSync(nicknamesFilePath, 'utf8')
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
                deviceNicknames = parsed
                console.log(`[Device] Loaded ${Object.keys(deviceNicknames).length} nicknames`)
            }
        }
    } catch (err) {
        console.warn('[Device] Failed to load nicknames:', err?.message || err)
        deviceNicknames = {}
    }
}

function saveDeviceNicknames() {
    if (!nicknamesFilePath) return
    try {
        fs.writeFileSync(nicknamesFilePath, JSON.stringify(deviceNicknames, null, 2), 'utf8')
    } catch (err) {
        console.warn('[Device] Failed to save nicknames:', err?.message || err)
    }
}

function loadDeviceTransportPrefs(app) {
    try {
        transportPrefsFilePath = path.join(app.getPath('userData'), 'device-transport.json')
        if (fs.existsSync(transportPrefsFilePath)) {
            const raw = fs.readFileSync(transportPrefsFilePath, 'utf8')
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
                deviceTransportPrefs = parsed
                console.log(`[Device] Loaded ${Object.keys(deviceTransportPrefs).length} transport prefs`)
            }
        }
    } catch (err) {
        console.warn('[Device] Failed to load transport prefs:', err?.message || err)
        deviceTransportPrefs = {}
    }
}

function saveDeviceTransportPrefs() {
    if (!transportPrefsFilePath) return
    try {
        fs.writeFileSync(transportPrefsFilePath, JSON.stringify(deviceTransportPrefs, null, 2), 'utf8')
    } catch (err) {
        console.warn('[Device] Failed to save transport prefs:', err?.message || err)
    }
}

/**
 * Initialize device handlers with app reference
 */
function initDeviceHandlers(app, window, opts = {}) {
    mainWindow = window

    // Set up ADB path
    adbPath = getADBPath(app)

    // Load locally-persisted device nicknames
    loadDeviceNicknames(app)

    // Load locally-persisted per-device transport preferences
    loadDeviceTransportPrefs(app)

    if (opts.appUrl) appUrl = opts.appUrl
    if (typeof opts.getSessionToken === 'function') getSessionToken = opts.getSessionToken

    // Register all IPC handlers. Thread opts through so set-device-transport can
    // use opts.relaunchMirror/isMirrorOpen (relaunch the mirror on the chosen
    // transport) + the optional opts.setDeviceSnapshot — previously `opts` was
    // out of scope inside registerDeviceHandlers, making those a dead no-op (and
    // a v3.2.1 fix-agent's typeof opts.setDeviceSnapshot threw ReferenceError,
    // breaking the whole USB<->WiFi toggle).
    registerDeviceHandlers(app, opts)
}

function pushNicknameToServer(serial, nickname) {
    if (!appUrl) return
    const token = getSessionToken()
    if (!token) return
    // Idempotent nickname upsert. appAuthFetch mints a live token per request so
    // this stops silently 401-warning on a stale snapshot; a persistent auth
    // failure throws and lands in the existing catch, keeping the
    // fire-and-forget shape intact.
    appAuthFetch(`${appUrl}/api/devices`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial, nickname: nickname || null }),
    }, { fallbackToken: token }).then((res) => {
        if (!res.ok) {
            console.warn(`[Device] Remote nickname sync ${res.status} for ${serial}`)
        }
    }).catch((err) => {
        console.warn('[Device] Remote nickname sync failed:', err?.message || err)
    })
}

/**
 * Get the path to the ADB executable
 */
let cachedAdbPath = null
function getADBPath(app) {
    const platform = os.platform()
    const adbBinary = platform === 'win32' ? 'adb.exe' : 'adb'

    // 1. Check app data folder first (where auto-installer puts ADB)
    const userDataPath = app.getPath('userData')
    const downloadedPath = path.join(userDataPath, 'adb', adbBinary)
    if (fs.existsSync(downloadedPath)) {
        console.log('[ADB] Found at:', downloadedPath)
        return downloadedPath
    }

    // 2. Check common installation paths
    const commonPaths = platform === 'win32' ? [
        path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        'C:\\Program Files\\Android\\platform-tools\\adb.exe',
        'C:\\Android\\platform-tools\\adb.exe',
        'C:\\platform-tools\\adb.exe',
    ] : platform === 'darwin' ? [
        '/usr/local/bin/adb',
        path.join(process.env.HOME || '', 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    ] : ['/usr/bin/adb']

    for (const p of commonPaths) {
        if (p && fs.existsSync(p)) {
            console.log('[ADB] Found at:', p)
            return p
        }
    }

    // Check installations first so a newly downloaded binary supersedes the PATH cache.
    const searchPath = process.env.PATH || ''
    if (cachedAdbPath && cachedAdbPath.searchPath === searchPath && fs.existsSync(cachedAdbPath.path)) {
        return cachedAdbPath.path
    }
    cachedAdbPath = null

    // 3. Try system PATH via where/which
    try {
        const { execSync } = require('child_process')
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
    } catch (e) { /* not in PATH */ }

    // Fallback — will fail if not in PATH
    console.error('[ADB] Not found in any known location')
    return adbBinary
}

// Transient adb errors that clear on a fresh re-spawn — mirrors the Python
// TRANSIENT_PATTERNS set in python/lib/remote_device.py. Re-spawning adb per
// attempt naturally re-establishes a dropped tailnet transport (the link flaps
// mid-command under scrcpy+tailnet contention), so a single blip no longer
// throws all the way up to getConnectedDevices' catch and blanks the fleet.
const ADB_TRANSIENT_PATTERNS = [
    'error: closed',
    'error: device offline',
    'error: device not found',
    'error: protocol fault',
    'error: connection reset',
    'cannot connect to daemon',
]

function isTransientADBError(err) {
    const msg = String(err?.message || err || '').toLowerCase()
    return ADB_TRANSIENT_PATTERNS.some(p => msg.includes(p))
}

/**
 * Run adb once (raw spawn). No retry — used by executeADB's retry loop.
 */
async function _spawnADB(args, timeout) {
    const result = await runAdb(adbPath, args, timeout)
    if (result.code === 0) return result.stdout.trim()
    const error = new Error(result.stderr || result.error || `ADB exited with code ${result.code}`)
    error.code = result.code
    throw error
}

/**
 * Execute an ADB command, retrying transient transport blips (a flapped tailnet
 * link) up to a couple times with short escalating backoff before giving up.
 * Non-transient failures (bad args, real device errors) reject immediately.
 */
async function executeADB(args, timeout = 30000) {
    const backoffs = [300, 600]   // up to 3 total attempts
    let attempt = 0
    for (;;) {
        try {
            return await _spawnADB(args, timeout)
        } catch (err) {
            if (attempt >= backoffs.length || !isTransientADBError(err)) throw err
            await new Promise(r => setTimeout(r, backoffs[attempt]))
            attempt++
        }
    }
}

/**
 * Get device property via ADB
 */
async function getDeviceProperty(serial, property) {
    try {
        const output = await executeADB(['-s', serial, 'shell', 'getprop', property])
        return output.trim()
    } catch {
        return null
    }
}

/**
 * Get the user-set "Device name" from Android (Settings → About phone → Device name).
 * Stored in global settings. Falls back to null when unset / unsupported.
 */
async function getAndroidDeviceName(serial) {
    try {
        const output = await executeADB(['-s', serial, 'shell', 'settings', 'get', 'global', 'device_name'])
        const value = output.trim()
        if (!value || value === 'null') return null
        return value
    } catch {
        return null
    }
}

/**
 * Compute the friendly display name with precedence:
 *   nickname (local override) > Android device_name > model
 */
function buildDisplayName(serial, deviceName, model) {
    const nickname = deviceNicknames[serial]
    if (nickname && nickname.trim()) return nickname.trim()
    if (deviceName && deviceName.trim()) return deviceName.trim()
    return model || serial
}

/**
 * Get battery level for a device
 */
async function getBatteryLevel(serial) {
    try {
        const output = await executeADB(['-s', serial, 'shell', 'dumpsys', 'battery'])
        const levelMatch = output.match(/level:\s*(\d+)/)
        return levelMatch ? parseInt(levelMatch[1]) : null
    } catch {
        return null
    }
}

/**
 * hwSerial-aware equality helper for saved-device lookups (F16).
 * Many saved entries only have {serial} (no hwSerial), so we fall back to
 * serial equality when either side lacks a hwSerial — never crash on undefined.
 */
function sameSaved(savedEntry, dev) {
    if (savedEntry.serial === dev.serial) return true
    if (dev.hwSerial && savedEntry.hwSerial && savedEntry.hwSerial === dev.hwSerial) return true
    return false
}

/**
 * Get all connected devices with details.
 *
 * Single-flight: rapid IPC actions (get-devices / refresh-devices / set-device-*
 * plus the 5s monitor tick) can otherwise overlap and each run their own poll,
 * racing the shared tailnet caches (lastKnownTailnet / tailnetMissCounts) so a
 * stale-miss gets double-counted. Concurrent callers now share one in-flight
 * promise, so the cache mutations + redundant getprop load happen exactly once
 * per real poll.
 */
let _getDevicesInflight = null
async function getConnectedDevices() {
    if (_getDevicesInflight) return _getDevicesInflight
    _getDevicesInflight = _getConnectedDevicesImpl()
    try {
        return await _getDevicesInflight
    } finally {
        _getDevicesInflight = null
    }
}

async function _getConnectedDevicesImpl() {
    try {
        const output = await executeADB(['devices', '-l'])
        const lines = output.split('\n').slice(1)
        const raw = []

        for (const line of lines) {
            if (line.trim() && !line.includes('List of devices')) {
                const parts = line.trim().split(/\s+/)
                const serial = parts[0]
                const status = parts[1]

                if (status === 'device') {
                    let [model, brand, androidVersion, deviceName, battery, hwSerial] = await Promise.all([
                        getDeviceProperty(serial, 'ro.product.model'),
                        getDeviceProperty(serial, 'ro.product.brand'),
                        getDeviceProperty(serial, 'ro.build.version.release'),
                        getAndroidDeviceName(serial),
                        getBatteryLevel(serial),
                        // ro.serialno is the phone's real hardware serial — same value over
                        // USB and over `adb connect <ip>:5555`. Used to dedupe the same
                        // phone from showing up twice when reachable via both transports.
                        getDeviceProperty(serial, 'ro.serialno'),
                    ])
                    // H4: a null read is a TRANSIENT adb failure, not a distinct
                    // phone. Retry once before the merge falls back to `serial`
                    // as the key (which would split one phone into two cards
                    // under scrcpy-over-Tailnet getprop contention).
                    if (!hwSerial) hwSerial = await getDeviceProperty(serial, 'ro.serialno')
                    raw.push({
                        serial,
                        hwSerial: hwSerial || null,
                        status,
                        model: model || 'Unknown',
                        brand: brand || 'Unknown',
                        androidVersion: androidVersion || 'Unknown',
                        battery,
                        connected: true,
                        deviceName: deviceName || null,
                        transport: /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial) ? 'tcp' : 'usb',
                    })
                } else if (status === 'unauthorized') {
                    raw.push({
                        serial,
                        hwSerial: null,
                        status: 'unauthorized',
                        model: 'Unauthorized',
                        brand: 'Please allow USB debugging',
                        androidVersion: '-',
                        battery: null,
                        connected: false,
                        deviceName: null,
                        transport: classifyTransport(serial),
                    })
                }
            }
        }

        // Merge USB + TCP entries for the same physical phone via the canonical
        // identity helper (USB stays canonical with its UDID so the nickname map
        // still resolves; the TCP twin contributes tailnetIp/tailnetPort). This
        // is the SAME logic that used to live inline here, extracted to
        // device-identity.mergeByHwSerial so every consumer dedups identically —
        // and it carries the H4 null-hwSerial TCP fold the inline copy lacked.
        // Pass lastKnownTailnet (devKey->{ip,port}) so a null-hwSerial TCP twin
        // in the common 2-entry [USB, null-TCP] case folds into its USB host via
        // the cached ip->hwSerial link instead of shipping a duplicate card.
        const dedup = mergeByHwSerial(raw, lastKnownTailnet)

        // Finalize: apply nickname + displayName + per-device transport pref.
        // Nickname now resolves hwSerial-first (web sets renames by hwSerial),
        // with the canonical serial as a fallback for pre-existing entries.
        const finalized = dedup.map(d => {
            const identity = withStableHwSerialProvenance(d)
            const nickname = deviceNicknames[d.hwSerial] || deviceNicknames[d.serial] || null
            const displayName = d.connected
                ? buildDisplayName(d.serial, d.deviceName, d.model)
                : (nickname || 'Unauthorized')

            // Which transport FORMS this physical phone is reachable by right now.
            // usbAvailable: the merged record itself is the USB twin (transport
            // 'usb'), i.e. a non-tcp serial is present for this hwSerial.
            // wifiAvailable: a tailnet ip was folded in by mergeByHwSerial.
            const usbAvailable = d.transport === 'usb'
            // Stable per-phone key: ro.serialno (hwSerial), falling back to the merged
            // serial so a phone whose ro.serialno read failed still keys consistently.
            // Written back as `hwSerial` below so the renderer passes the SAME key to
            // set-device-transport that we look the pref up under (kills revert-to-default).
            const devKey = identity.hwSerial
            // Remember the live tailnet endpoint so WiFi stays selectable + can be
            // reconnected after a transient relay drop. Track misses so a phone that
            // is present every poll but has NO live tailnet twin eventually prunes its
            // stale cache (and stops advertising WiFi-available on a dead endpoint).
            if (d.tailnetIp) {
                lastKnownTailnet[devKey] = { ip: d.tailnetIp, port: d.tailnetPort || 5555 }
                delete tailnetMissCounts[devKey]
                // Live twin back — allow a fresh rescan if this phone drops again.
                _tailnetRescanInflight.delete(devKey)
            } else if (lastKnownTailnet[devKey]) {
                tailnetMissCounts[devKey] = (tailnetMissCounts[devKey] || 0) + 1
                if (tailnetMissCounts[devKey] >= TAILNET_STALE_MISSES) {
                    delete lastKnownTailnet[devKey]
                    delete tailnetMissCounts[devKey]
                }
            }
            const knownTn = lastKnownTailnet[devKey] || null
            const wifiAvailable = !!d.tailnetIp || !!knownTn

            // Default is USB (force the cable when reachable — no 'auto'). 'wifi' forces
            // Tailscale. If the chosen form isn't reachable, fall through to the merged
            // record (so 'usb' on a tailnet-only VA phone stays on tailnet).
            const transportPref = deviceTransportPrefs[devKey] || 'usb'
            let serial = d.serial
            let transport = d.transport
            if (transportPref === 'wifi' && d.tailnetIp) {
                // LIVE tailnet twin this poll — safe to route ops over tcp.
                serial = `${d.tailnetIp}:${d.tailnetPort || 5555}`
                transport = 'tcp'
            } else if (transportPref === 'wifi' && knownTn) {
                // WiFi forced but NO live tailnet twin this poll. The cached endpoint is
                // likely dead (Tailscale logged out / phone moved networks / relay down),
                // so do NOT force ops onto it. Fire a best-effort reconnect to try to
                // bring the link back, but keep the OPERATIONAL serial on the working USB
                // twin when present (only fall through to the merged record otherwise).
                // If the cached port is dead after a reboot port-rotation, rediscover it
                // via a DETACHED scan (a cold scan is 50-120s — must never block the poll),
                // latched per-device so overlapping polls don't pile up scans.
                const rescanRotatedPort = () => {
                    if (_tailnetRescanInflight.has(devKey)) return
                    _tailnetRescanInflight.add(devKey)
                    scanForAdbPort(knownTn.ip, { hintPort: knownTn.port }).then(newPort => {
                        if (newPort && newPort !== knownTn.port) {
                            return executeADB(['connect', `${knownTn.ip}:${newPort}`], 6000)
                                .then(() => { lastKnownTailnet[devKey] = { ip: knownTn.ip, port: newPort } })
                                // Confirmed reconnect on the rotated port — push a fresh devices
                                // list now so the UI reflects the live tailnet twin immediately
                                // instead of waiting for the trailing ~5s poll. getConnectedDevices
                                // is single-flight guarded so this can't race the scheduled poll.
                                .then(() => getConnectedDevices())
                                .then(devs => {
                                    if (mainWindow && !mainWindow.isDestroyed()) {
                                        try { mainWindow.webContents.send('devices-updated', devs) } catch { /* best effort */ }
                                    }
                                })
                        }
                    }).catch(() => {}).finally(() => { _tailnetRescanInflight.delete(devKey) })
                }
                // Tailnet gate: this fires on EVERY device poll (~5s) for a phone
                // pinned to 'wifi'. Against a down Tailscale each connect burns
                // its full 6s timeout, so a 6s timeout every 5s trips the shared
                // adb circuit breaker on its own — which then kills a healthy USB
                // phone's in-flight commands. Dormant today only because the
                // default pref is 'usb'; gate it before an operator flips one.
                // Scoped to CGNAT (100.64/10) endpoints: the gate needs a 100.x
                // address on this PC, so applying it to a plain LAN endpoint
                // would refuse the reconnect forever on a machine without
                // Tailscale — exactly the phones that never needed it.
                const wifiGate = TAILNET_CGNAT_RE.test(String(knownTn.ip || ''))
                    ? isTailnetRoutable()
                    : Promise.resolve({ ok: true })
                wifiGate.then(gate => {
                    if (gate && gate.ok === false) return null
                    return executeADB(['connect', `${knownTn.ip}:${knownTn.port}`], 6000).then(out => {
                        if (!/connected to|already connected/i.test(String(out || ''))) rescanRotatedPort()
                    }).catch(() => rescanRotatedPort())
                }).catch(() => {})
                if (usbAvailable) {
                    serial = d.serial
                    transport = 'usb'
                }
            } else if (transportPref === 'usb' && usbAvailable) {
                serial = d.serial
                transport = 'usb'
            }

            // The transport ops ACTUALLY run over this poll (after the fallback
            // above), so the renderer label reflects reality — not just the pref.
            // 'wifi' forced with no live tailnet twin silently runs over USB.
            const effectiveTransport = transport === 'tcp' ? 'wifi' : 'usb'

            return {
                ...identity, serial, transport, nickname, displayName,
                transportPref, usbAvailable, wifiAvailable, effectiveTransport,
            }
        })

        connectedDevices = finalized
        return finalized
    } catch (error) {
        console.error('Error getting devices:', error)
        // null = transient adb-daemon failure (monitor holds last-good fleet).
        // [] is reserved for a genuinely empty fleet (clean exit, no throw).
        return null
    } finally {
        // Age out lastKnownTailnet for phones absent this poll. Runs even when
        // executeADB(['devices','-l']) throws (adb daemon crash) so stale tailnet
        // entries don't linger and report wifiAvailable=true during outage windows.
        // seenKeys is empty on error paths → all keys get absent-counted, which is
        // correct safe behaviour (no phone was confirmed reachable this poll).
        const seenKeys = new Set((connectedDevices || []).map(d => d.hwSerial || d.serial))
        for (const key of Object.keys(lastKnownTailnet)) {
            if (seenKeys.has(key)) {
                delete tailnetAbsentCounts[key]
                continue
            }
            tailnetAbsentCounts[key] = (tailnetAbsentCounts[key] || 0) + 1
            if (tailnetAbsentCounts[key] >= TAILNET_ABSENT_PRUNE) {
                delete lastKnownTailnet[key]
                delete tailnetMissCounts[key]
                delete tailnetAbsentCounts[key]
            }
        }
    }
}

/**
 * Check if a device is new (not in saved devices).
 * Accepts the full device object so hwSerial-aware matching works (F16).
 */
function isNewDevice(device) {
    return !userSavedDevices.some(saved => sameSaved(saved, device))
}

/**
 * Notify renderer about new device detection
 */
function notifyNewDevice(device) {
    if (alertedNewDevices.has(device.serial)) return

    alertedNewDevices.add(device.serial)
    console.log(`[Device] New device detected: ${device.brand} ${device.model} (${device.serial})`)

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('new-device-detected', {
            serial: device.serial,
            hwSerial: device.hwSerial || null,
            transport: device.transport || null,
            model: device.model,
            brand: device.brand,
            androidVersion: device.androidVersion,
            battery: device.battery
        })
    }
}

/**
 * Check for newly connected devices
 */
function checkForNewDevices(currentDevices) {
    for (const device of currentDevices) {
        if (device.status !== 'device') continue

        const isNew = isNewDevice(device)
        // Key plug-detection on hwSerial (ro.serialno) so a tailnet port rotation
        // doesn't read as a fresh plug-in on the next poll.
        const justPluggedIn = !previousDeviceSerials.has(device.hwSerial || device.serial)

        if (isNew && justPluggedIn) {
            notifyNewDevice(device)
        }
    }

    // Stable key: hwSerial when available, serial as fallback.
    previousDeviceSerials = new Set(currentDevices.map(d => d.hwSerial || d.serial))
}

/**
 * Seed previousDeviceSerials without firing popups — used by the live monitor
 * for the initial scan and on every tick while the saved-devices gate is closed
 * (so the first scan after the gate opens doesn't flag the whole fleet as new).
 */
function seedDeviceSerials(currentDevices) {
    previousDeviceSerials = new Set(currentDevices.map(d => d.hwSerial || d.serial))
}

/**
 * Detection gate: true once the renderer has synced saved devices at least once
 * via 'set-saved-devices'. The live monitor must not run checkForNewDevices
 * before this — every fleet phone would otherwise look "new".
 */
function savedDevicesReady() {
    return savedDevicesSynced
}

/**
 * Start ADB server
 */
async function startADBServer() {
    try {
        await executeADB(['start-server'])
        return true
    } catch (error) {
        console.error('Failed to start ADB server:', error)
        return false
    }
}

/**
 * Stop ADB server
 */
async function stopADBServer() {
    try {
        await executeADB(['kill-server'])
    } catch (error) {
        console.error('Failed to stop ADB server:', error)
    }
}

/**
 * Start device monitoring loop
 */
function startADBMonitoring() {
    // Initial scan
    getConnectedDevices().then(devices => {
        checkForNewDevices(devices)
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('devices-updated', devices)
        }
    }).catch(err => console.warn('[Device] initial scan error:', err?.message))

    // Poll every 5 seconds (balances responsiveness vs ADB call volume)
    monitoringInterval = setInterval(async () => {
        try {
            const devices = await getConnectedDevices()
            if (devices == null) return
            checkForNewDevices(devices)
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('devices-updated', devices)
            }
        } catch (err) {
            console.warn('[Device] poll error:', err?.message)
        }
    }, 5000)
}

/**
 * Stop device monitoring
 */
function stopADBMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval)
        monitoringInterval = null
    }
}

/**
 * Register all device-related IPC handlers
 */
function registerDeviceHandlers(app, opts = {}) {
    // Basic device queries
    ipcMain.handle('get-devices', async () => {
        return (await getConnectedDevices()) || []
    })

    ipcMain.handle('refresh-devices', async () => {
        return (await getConnectedDevices()) || []
    })

    // Device management
    ipcMain.handle('set-saved-devices', async (event, devices) => {
        userSavedDevices = devices || []
        // Open the detection gate: the monitor can now flag genuinely-new phones.
        savedDevicesSynced = true
        console.log(`[Device] Loaded ${userSavedDevices.length} saved devices from Supabase`)

        // Merge remote nicknames in for serials we don't already have locally.
        // Local writes always win — only fill blanks.
        let added = 0
        for (const d of userSavedDevices) {
            if (d?.serial && d?.nickname && !deviceNicknames[d.serial]) {
                deviceNicknames[d.serial] = String(d.nickname).trim()
                added++
            }
        }
        if (added > 0) {
            saveDeviceNicknames()
            console.log(`[Device] Merged ${added} remote nicknames into local cache`)
        }
        return { success: true, count: userSavedDevices.length }
    })

    ipcMain.handle('add-device-to-saved', async (event, device) => {
        // F16: persist hwSerial into the saved record so future sameSaved() lookups
        // can match by hwSerial even if the transport serial rotates.
        const entry = { ...device }
        if (!entry.hwSerial) {
            const live = connectedDevices.find(d => d.serial === device.serial)
            if (live && live.hwSerial) entry.hwSerial = live.hwSerial
        }
        userSavedDevices.push(entry)
        console.log(`[Device] Added device to saved: ${entry.serial}`)
        return { success: true }
    })

    ipcMain.handle('remove-device-from-saved', async (event, serial) => {
        // F16: match by hwSerial too so a saved entry stored under TCP serial
        // is removed correctly when the USB UDID is passed, and vice-versa.
        const targetDev = connectedDevices.find(d => d.serial === serial) || { serial }
        userSavedDevices = userSavedDevices.filter(d => !sameSaved(d, targetDev))
        alertedNewDevices.delete(serial)
        console.log(`[Device] Removed device from saved: ${serial}`)
        return { success: true }
    })

    ipcMain.handle('get-devices-with-status', async () => {
        const connected = await getConnectedDevices()
        // null sentinel (transient adb failure) -> report empty rather than crash.
        // F16: use sameSaved so a device saved under its TCP serial is recognised
        // as saved when it reappears with a different transport serial.
        return (connected || []).map(device => ({
            ...device,
            isSaved: userSavedDevices.some(d => sameSaved(d, device)),
            savedDevice: userSavedDevices.find(d => sameSaved(d, device))
        }))
    })

    ipcMain.handle('dismiss-new-device', async (event, serial) => {
        alertedNewDevices.add(serial)
        console.log(`[Device] User dismissed new device: ${serial}`)
        return { success: true }
    })

    // ==================== DEVICE NICKNAMES ====================
    ipcMain.handle('get-device-nicknames', async () => {
        return { ...deviceNicknames }
    })

    ipcMain.handle('set-device-nickname', async (event, serial, nickname) => {
        if (!serial || typeof serial !== 'string') {
            return { success: false, error: 'serial is required' }
        }
        // Resolve a stable key (hwSerial) before writing so a rename made while
        // a phone is tcp-only survives the tailnet port rotating on reboot or
        // the USB udid becoming canonical. Falls back to the raw serial.
        const key = hwSerialFor(serial, connectedDevices) || serial
        const trimmed = typeof nickname === 'string' ? nickname.trim() : ''
        if (trimmed) {
            deviceNicknames[key] = trimmed
        } else {
            delete deviceNicknames[key]
        }
        saveDeviceNicknames()
        // Fire-and-forget — local file is authoritative on this machine.
        pushNicknameToServer(serial, trimmed)
        // Push fresh device list so any open renderer reflects the rename
        // immediately without waiting for the next 5s monitor tick.
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                const devices = await getConnectedDevices()
                mainWindow.webContents.send('devices-updated', devices)
            } catch { /* best effort */ }
        }
        return { success: true, nickname: trimmed || null }
    })

    // ==================== DEVICE TRANSPORT PREFERENCE ====================
    // Per-device Auto/USB/WiFi keyed by hwSerial. 'auto' = current prefer-USB
    // merge (unchanged); 'usb'/'wifi' force every op for that phone onto the
    // chosen transport when that form is reachable.
    ipcMain.handle('get-device-transport', async () => {
        return { ...deviceTransportPrefs }
    })

    ipcMain.handle('set-device-transport', async (event, hwSerial, pref) => {
        if (!hwSerial || typeof hwSerial !== 'string') {
            return { success: false, error: 'hwSerial is required' }
        }
        if (!VALID_TRANSPORT_PREFS.includes(pref)) {
            return { success: false, error: `pref must be one of ${VALID_TRANSPORT_PREFS.join('/')}` }
        }
        deviceTransportPrefs[hwSerial] = pref
        saveDeviceTransportPrefs()
        // Selecting WiFi: (re)establish the tailnet adb link now so the reroute is
        // reachable immediately even if the relay had transiently dropped. If the
        // cached port is dead after a reboot port-rotation, rediscover the rotated
        // port (a phone with no open mirror has no watchdog intent to recover it).
        // This path is a one-shot user action, so a brief block to scan is fine.
        if (pref === 'wifi' && lastKnownTailnet[hwSerial]) {
            const tn = lastKnownTailnet[hwSerial]
            let connected = false
            try {
                const out = await executeADB(['connect', `${tn.ip}:${tn.port}`], 6000)
                connected = /connected to|already connected/i.test(String(out || ''))
            } catch { /* best effort */ }
            if (!connected) {
                try {
                    const newPort = await scanForAdbPort(tn.ip, { hintPort: tn.port })
                    if (newPort && newPort !== tn.port) {
                        await executeADB(['connect', `${tn.ip}:${newPort}`], 6000)
                        // Write back so the getConnectedDevices() below this handler
                        // picks up the live endpoint instead of the dead cached port.
                        lastKnownTailnet[hwSerial] = { ip: tn.ip, port: newPort }
                    }
                } catch { /* best effort */ }
            }
        }
        // Push fresh device list so any open renderer reflects the reroute
        // immediately without waiting for the next 5s monitor tick.
        // Refresh the device list (reflects the new operational serial), push it to
        // the renderer, AND use it to restart an open mirror onto the chosen transport.
        let devices = []
        try { devices = await getConnectedDevices() } catch { /* best effort */ }
        // Refresh system-handlers' _lastDeviceSnapshot from this fresher poll BEFORE the
        // isMirrorOpen check below. isMirrorOpen -> hasRunningScrcpyForSerial bridges the
        // old-transport mirror key to the new operational serial only via the synchronous
        // sameDevice() collapse, which reads that snapshot. The snapshot is otherwise
        // written only inside launchScrcpyForSerial, so on a USB->WiFi switch where the
        // tailnet twin was NOT live at the last launch it lacks tailnetIp, sameDevice()
        // misses, and the relaunch silently no-ops (card flips to WiFi, stream stays USB).
        // Feeding the live `devices` (which carries tailnetIp this poll) fixes the gate.
        if (typeof opts.setDeviceSnapshot === 'function') {
            try { opts.setDeviceSnapshot(devices) } catch { /* best effort */ }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.send('devices-updated', devices) } catch { /* best effort */ }
        }
        // If a mirror is open for this phone, restart it on the newly chosen transport.
        // launchScrcpyForSerial closes the old-transport mirror first, so the toggle
        // actually switches the connection instead of leaving a stale/duplicate mirror.
        try {
            if (typeof opts.relaunchMirror === 'function' && typeof opts.isMirrorOpen === 'function') {
                const dev = devices.find(x => (x.hwSerial || x.serial) === hwSerial)
                const newSerial = dev && dev.serial
                if (newSerial && opts.isMirrorOpen(newSerial)) opts.relaunchMirror(newSerial)
            }
        } catch { /* best effort */ }
        // Return the ACTUAL transport outcome (derived from the refreshed dev record, not
        // the local `connected` flag — that flag is only set inside the wifi-cache block,
        // so if the cache was pruned between poll and click it stays false while
        // effectiveTransport reflects reality). Lets the renderer honestly report when a
        // WiFi request fell through to USB instead of silently appearing to succeed.
        const outDev = devices.find(x => (x.hwSerial || x.serial) === hwSerial)
        return { success: true, requested: pref, effectiveTransport: outDev?.effectiveTransport ?? 'usb' }
    })

    // Device control actions

    // 3.2 (p2): stream the PNG straight off the device with `exec-out screencap -p`,
    // piping adb's stdout to the local temp file. This skips the screencap→/sdcard
    // write + pull + rm dance (two fewer adb round-trips, no on-device file). It is
    // strictly a latency nicety — the pull-based handler below stays the fallback.
    // exec-out emits RAW PNG bytes, so we must NOT route this through executeADB()
    // (that captures stdout as a utf8 string + .trim()s it, which corrupts binary).
    // Over the tailnet relay binary exec-out can occasionally truncate without a
    // non-zero exit, so we validate a real PNG (signature + plausible size) before
    // trusting it; any error/short-read falls through to the pull path untouched.
    async function tryExecOutScreenshot(serial, localPath, timeout = 12000) {
        const out = fs.createWriteStream(localPath)
        const controller = new AbortController()
        let bytes = 0
        let streamError = null
        const streamDone = new Promise(resolve => {
            out.once('finish', resolve)
            out.once('error', error => {
                streamError = error
                controller.abort()
                resolve()
            })
        })

        try {
            const result = await runAdb(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], timeout, {
                signal: controller.signal,
                captureStdout: false,
                maxOutputBytes: 32 * 1024 * 1024,
                onStdoutChunk: chunk => {
                    bytes += chunk.length
                    out.write(chunk)
                },
            })
            if (result.code !== 0) {
                throw new Error(result.error || result.stderr || `exec-out exited ${result.code}`)
            }
            out.end()
            await streamDone
            if (streamError) throw streamError

            const buf = fs.readFileSync(localPath)
            const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
            if (buf.length < 1024 || !buf.slice(0, 8).equals(pngSig)) {
                throw new Error(`exec-out produced invalid PNG (${bytes} bytes)`)
            }
            return localPath
        } catch (error) {
            controller.abort()
            try { out.destroy() } catch { /* best effort */ }
            try { fs.unlinkSync(localPath) } catch { /* may not exist */ }
            throw error
        }
    }

    const takeScreenshot = async (serial) => {
        const timestamp = Date.now()
        const localPath = path.join(app.getPath('temp'), `screenshot_${timestamp}.png`)

        // Fast path: direct binary stream, no on-device file. Best-effort.
        try {
            await tryExecOutScreenshot(serial, localPath)
            return { success: true, path: localPath, fast: true }
        } catch { /* fall back to the proven pull-based path below */ }

        // Fallback: the original screencap→/sdcard→pull→rm dance.
        try {
            await executeADB(['-s', serial, 'shell', 'screencap', '-p', '/sdcard/screenshot.png'])
            await executeADB(['-s', serial, 'pull', '/sdcard/screenshot.png', localPath])
            await executeADB(['-s', serial, 'shell', 'rm', '/sdcard/screenshot.png'])

            return { success: true, path: localPath }
        } catch (error) {
            return { success: false, error: error.message }
        }
    }
    ipcMain.handle('take-screenshot', (_event, serial) => takeScreenshot(serial))

    ipcMain.handle('execute-tap', async (event, serial, x, y) => {
        try {
            await executeADB(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)])
            return { success: true }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('execute-swipe', async (event, serial, x1, y1, x2, y2, duration = 300) => {
        try {
            await executeADB(['-s', serial, 'shell', 'input', 'swipe',
                String(x1), String(y1), String(x2), String(y2), String(duration)])
            return { success: true }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('input-text', async (event, serial, text) => {
        try {
            // adb shell input text takes a single argv string that gets
            // re-evaluated by sh on the device. The old escape regex
            // `\\$1` produced LITERAL backslashes that got typed as part
            // of the text (e.g. `O'Brien` became `O\'Brien`). Use the
            // single-quote-wrap pattern from lib/local-modules.js: wrap
            // the whole thing in `'...'` and replace embedded single
            // quotes with `'\''`. Spaces still need %s for adb input.
            const str = String(text || '')
            const withSpaces = str.replace(/ /g, '%s')
            const quoted = `'${withSpaces.replace(/'/g, "'\\''")}'`
            await executeADB(['-s', serial, 'shell', 'input', 'text', quoted])
            return { success: true }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    const pressKey = async (serial, keycode) => {
        try {
            await executeADB(['-s', serial, 'shell', 'input', 'keyevent', String(keycode)])
            return { success: true }
        } catch (error) {
            return { success: false, error: error.message }
        }
    }
    ipcMain.handle('press-key', (_event, serial, keycode) => pressKey(serial, keycode))

    // 2.16.55: cache the resolved launcher component per (serial, package).
    // Apps don't change their launcher activity at runtime — eliminates the
    // resolve-activity round-trip on every relaunch.
    // Cache key uses hwSerial (stable hardware serial) rather than the adb transport
    // serial so tailnet phones (100.x:port, rotates on reboot) still hit the cache
    // after a port rotation. Falls back to serial when hwSerial is not yet resolved.
    const _componentCache = new Map() // key: hwSerial::pkg (or serial::pkg) → component
    const launchApp = async (serial, packageName) => {
        try {
            if (!/^[a-z][A-Za-z0-9_.]*$/.test(String(packageName || ''))) {
                return { success: false, error: `Invalid packageName: ${packageName}` }
            }

            const _hwSerial = connectedDevices.find(d => d.serial === serial)?.hwSerial || serial
            const cacheKey = `${_hwSerial}::${packageName}`
            const cachedComponent = _componentCache.get(cacheKey)

            // Fast path: known component → just `am start --user current`.
            // One adb call. Most launches hit this.
            if (cachedComponent) {
                try {
                    await executeADB(['-s', serial, 'shell', 'am', 'start',
                        '--user', 'current', '-n', cachedComponent], 6000)
                    return { success: true, component: cachedComponent, cached: true }
                } catch (e) {
                    // Component may have been uninstalled — fall through to re-resolve
                    _componentCache.delete(cacheKey)
                }
            }

            // Slow path: resolve component, cache it, launch
            const userRaw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
            const userId = String(userRaw || '').trim()

            const resolveActivity = async () => {
                try {
                    const out = await executeADB(['-s', serial, 'shell', 'cmd', 'package',
                        'resolve-activity', '--user', 'current', '--brief',
                        '-c', 'android.intent.category.LAUNCHER', packageName], 5000)
                    const lines = String(out || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
                    const comp = lines.reverse().find(l => l.includes('/') && l.startsWith(packageName))
                    return comp || null
                } catch (_) { return null }
            }

            let component = await resolveActivity()
            if (!component && /^\d+$/.test(userId) && userId !== '0') {
                try {
                    await executeADB(['-s', serial, 'shell', 'pm', 'install-existing',
                        '--user', userId, packageName], 8000)
                    component = await resolveActivity()
                } catch (_) { /* fall through */ }
            }

            if (!component) {
                return {
                    success: false,
                    error: `${packageName} is not installed for the current profile (user ${userId}). Install it from the Play Store on this profile first.`,
                }
            }

            _componentCache.set(cacheKey, component)
            await executeADB(['-s', serial, 'shell', 'am', 'start',
                '--user', 'current', '-n', component], 6000)
            return { success: true, component, userId }
        } catch (error) {
            return { success: false, error: error.message }
        }
    }
    ipcMain.handle('launch-app', (_event, serial, packageName) => launchApp(serial, packageName))
    registeredDeviceActions = Object.freeze({ takeScreenshot, pressKey, launchApp })

    ipcMain.handle('get-installed-apps', async (event, serial) => {
        try {
            const output = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'])
            const packages = output.split('\n')
                .filter(line => line.startsWith('package:'))
                .map(line => line.replace('package:', '').trim())
            return { success: true, packages }
        } catch (error) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('open-external', async (event, url) => {
        // Security: Only allow http/https URLs
        try {
            const urlObj = new URL(url)
            if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
                console.error(`[Security] Blocked non-http URL: ${url}`)
                return { success: false, error: 'Only http/https URLs allowed' }
            }
            shell.openExternal(url)
            return { success: true }
        } catch {
            console.error(`[Security] Invalid URL: ${url}`)
            return { success: false, error: 'Invalid URL' }
        }
    })
}

// Export functions for use in main.js
// Reset the per-user volatile device state so a NEW user signing in on this same
// install never inherits the previous user's in-memory device list / account
// handles. Hardware-local labels (deviceNicknames / deviceTransportPrefs) are NOT
// touched — they describe the physical phones on this machine and are keyed by
// serial, so a returning same user keeps them (and they never leak user data).
function resetUserScopedState() {
    connectedDevices = []
    lastKnownTailnet = {}
    tailnetMissCounts = {}
    tailnetAbsentCounts = {}
    _tailnetRescanInflight.clear()
    alertedNewDevices.clear()
    userSavedDevices = []
    savedDevicesSynced = false
    previousDeviceSerials.clear()
}

function getDeviceActions() {
    if (!registeredDeviceActions) throw new Error('Device actions are not initialized.')
    return registeredDeviceActions
}

function getSavedDevices() {
    return userSavedDevices.map(device => ({ ...device }))
}

module.exports = {
    initDeviceHandlers,
    startADBMonitoring,
    stopADBMonitoring,
    startADBServer,
    stopADBServer,
    executeADB,
    getConnectedDevices,
    getDeviceProperty,
    getBatteryLevel,
    getDeviceActions,
    getSavedDevices,
    // New-device detection (single owner — main.js's monitor calls these).
    checkForNewDevices,
    seedDeviceSerials,
    savedDevicesReady,
    resetUserScopedState,
    clearDeviceState: () => {
        userSavedDevices = []
        savedDevicesSynced = false
        alertedNewDevices.clear()
        previousDeviceSerials.clear()
    }
}
