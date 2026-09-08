// electron/lib/portal-auth-proxy.js
// Token-gated HTTP + WebSocket reverse proxy in front of ws-scrcpy.
//
// Two token tiers:
//   1. MASTER token  — created when the portal starts; sees the entire fleet.
//   2. DEVICE token  — created on demand via issueDeviceToken(serial); the
//      bearer has a server-side role/capability set for THAT one device.
//      Other devices are filtered and cross-device operations are rejected.
//
// ws-scrcpy itself has no auth; this proxy is the only thing the cloudflared
// tunnel exposes. On a fresh nav with `?t=<token>` we also set an httpOnly
// cookie so sub-assets (bundle.js, main.css, WS upgrade) authenticate without
// needing the token in every URL.
//
// Extra ShadowPhone-specific endpoints (under `/sp-api/`):
//   • GET /sp-api/token-info — caller's token scope/serial (so the injected
//     wizard JS can hide non-matching device rows).
//   • GET /sp-api/nicknames  — { serial: nickname } map sourced from the
//     desktop app's device-nicknames.json, so the wizard can relabel
//     "Pixel 6a" → the operator's chosen name.

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { runAdb } = require('./adb-util')
const { mediaMimeType } = require('./media-mime')
const scheduleEngine = require('./schedule-engine')
const { ScrcpyDirectStreamSource } = require('./scrcpy-direct-source')
const { fetchDeviceMeta } = require('./scrcpy-device-meta')
const { createForwardPool } = require('./adb-forward')
const { encodeVideoSettings } = require('./scrcpy-protocol')

// Profile nickname store shared with electron/handlers/profile-handlers.js.
// File: <userData>/profile-nicknames.json — { [serial]: { [userId]: nickname } }.
// We mirror that handler's read/write behaviour so a rename from either the
// desktop overview OR the web pop-out toolbar updates the same source of
// truth and both surfaces show the renamed name.
let _nicknamesPath = null
function nicknamesFilePath() {
    if (_nicknamesPath) return _nicknamesPath
    try {
        const electron = require('electron')
        const userData = electron && electron.app && electron.app.getPath('userData')
        if (userData) _nicknamesPath = path.join(userData, 'profile-nicknames.json')
    } catch (_) { /* not in electron main — fall through */ }
    if (!_nicknamesPath) _nicknamesPath = path.join(os.tmpdir(), 'shadowphone-profile-nicknames.json')
    return _nicknamesPath
}
function readNicknames() {
    try {
        const raw = fs.readFileSync(nicknamesFilePath(), 'utf8')
        const parsed = JSON.parse(raw)
        return (parsed && typeof parsed === 'object') ? parsed : {}
    } catch (_) { return {} }
}
function writeNicknames(obj) {
    try {
        fs.writeFileSync(nicknamesFilePath(), JSON.stringify(obj, null, 2), 'utf8')
        return true
    } catch (_) { return false }
}

// Raw ws-scrcpy file-system and devtools paths are never portal capabilities.
const BLOCKED_PREFIXES = ['/fs/', '/devtools']
const COOKIE_NAME = 'sp_portal_t'
const DEFAULT_DEVICE_TOKEN_TTL_MS = 15 * 60 * 1000
const ALL_CAPABILITIES = Object.freeze([
    'app.launch',
    'content.upload',
    'device.control',
    'diagnostics.read',
    'gallery.wipe',
    'profile.create',
    'profile.delete',
    'profile.rename',
    'profile.switch',
    'status.read',
    'stream.read',
    'stream.respawn',
    'telemetry.write',
    'text.type',
    'token.issue',
])
const VIEWER_CAPABILITIES = Object.freeze(['status.read', 'stream.read'])
const VA_CAPABILITIES = Object.freeze([
    ...VIEWER_CAPABILITIES,
    'app.launch',
    'content.upload',
    'device.control',
    'profile.rename',
    'profile.switch',
    'stream.respawn',
    'telemetry.write',
    'text.type',
])
const CAPABILITY_ALIASES = Object.freeze({
    view: VIEWER_CAPABILITIES,
    control: VA_CAPABILITIES,
})
const ENDPOINT_CAPABILITIES = new Map([
    ['GET /sp-api/debug-events', 'diagnostics.read'],
    ['GET /sp-api/token-info', 'status.read'],
    ['GET /sp-api/devices', 'status.read'],
    ['POST /sp-api/upload-to-device', 'content.upload'],
    ['POST /sp-api/upload-via-vanadium', 'content.upload'],
    ['POST /sp-api/wipe-gallery', 'gallery.wipe'],
    ['POST /sp-api/launch-app', 'app.launch'],
    ['POST /sp-api/client-event', 'telemetry.write'],
    ['GET /sp-api/health-events', 'status.read'],
    ['GET /sp-api/diagnostic-bundle', 'diagnostics.read'],
    ['GET /sp-api/health-state', 'status.read'],
    ['GET /sp-api/debug-state', 'diagnostics.read'],
    ['GET /sp-api/lan-links', 'token.issue'],
    ['POST /sp-api/force-respawn', 'stream.respawn'],
    ['GET /sp-api/list-users', 'status.read'],
    ['POST /sp-api/switch-user', 'profile.switch'],
    ['POST /sp-api/rename-profile', 'profile.rename'],
    ['POST /sp-api/delete-profile', 'profile.delete'],
    ['POST /sp-api/create-profile', 'profile.create'],
    ['POST /sp-api/type-text', 'text.type'],
    ['POST /sp-api/issue-device-token', 'token.issue'],
    ['GET /sp-api/nicknames', 'status.read'],
])
const STATIC_ASSETS = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/bundle.js', ['bundle.js', 'text/javascript; charset=utf-8']],
    ['/bundle.worker.js', ['bundle.worker.js', 'text/javascript; charset=utf-8']],
    ['/main.css', ['main.css', 'text/css; charset=utf-8']],
    ['/avc.wasm', ['avc.wasm', 'application/wasm']],
    ['/1279f368b5bb729ca7b35990042f9928.png', ['1279f368b5bb729ca7b35990042f9928.png', 'image/png']],
    ['/0adc36cf9cddfe4b6056c3ca47abaca0.png', ['0adc36cf9cddfe4b6056c3ca47abaca0.png', 'image/png']],
])
function resolveStaticRoot(resourcesPath = process.resourcesPath) {
    const packaged = typeof resourcesPath === 'string' && resourcesPath
        ? path.join(resourcesPath, 'ws-scrcpy', 'dist', 'public')
        : ''
    if (packaged && fs.existsSync(packaged)) return packaged
    return path.join(__dirname, '..', 'vendor', 'ws-scrcpy', 'dist', 'public')
}

function requestedCapabilities(raw) {
    if (Array.isArray(raw)) return raw.filter(value => typeof value === 'string')
    if (!raw || typeof raw !== 'object') return []
    return Object.entries(raw).filter(([, enabled]) => enabled === true).map(([name]) => name)
}

function normalizeAuthorization(raw, fallbackRole = 'viewer') {
    const input = raw && typeof raw === 'object' ? raw : {}
    const suppliedRole = typeof input.role === 'string' ? input.role.trim().toLowerCase() : ''
    const role = suppliedRole || fallbackRole
    if (!['viewer', 'va', 'operator', 'owner'].includes(role)) {
        return { role: 'invalid', capabilities: [] }
    }
    if (role === 'operator' || role === 'owner') {
        return { role, capabilities: [...ALL_CAPABILITIES] }
    }
    const allowed = new Set(role === 'va' ? VA_CAPABILITIES : VIEWER_CAPABILITIES)
    if (role === 'va') {
        for (const capability of requestedCapabilities(input.capabilities)) {
            const expanded = CAPABILITY_ALIASES[capability] || [capability]
            for (const name of expanded) {
                if (ALL_CAPABILITIES.includes(name)) allowed.add(name)
            }
        }
    }
    return { role, capabilities: Array.from(allowed).sort() }
}

function hasCapability(meta, capability) {
    return Boolean(meta && Array.isArray(meta.capabilities) && meta.capabilities.includes(capability))
}

function endpointCapability(method, reqPath) {
    return ENDPOINT_CAPABILITIES.get(`${method} ${reqPath}`) || null
}

function runAbortableAdb(adbPath, args, timeoutMs = 15_000, signal) {
    return runAdb(adbPath, args, timeoutMs, signal ? { signal } : {})
}

// Constant-time compare of two strings of equal length.
function safeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    if (a.length !== b.length) return false
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)) } catch { return false }
}

function tokenFromUrl(reqUrl) {
    try { return new URL(reqUrl, 'http://x').searchParams.get('t') } catch { return null }
}

function tokenFromCookie(req) {
    const raw = req.headers && req.headers.cookie
    if (!raw) return null
    const m = String(raw).match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'))
    if (!m) return null
    try { return decodeURIComponent(m[1]) } catch (_) { return null }
}

function safeDecodeURIComponent(value) {
    try { return decodeURIComponent(value) } catch (_) { return null }
}

function udidFromUrl(reqUrl) {
    try { return new URL(reqUrl, 'http://x').searchParams.get('udid') } catch { return null }
}

// Hard cap on uploaded file size — prevents a VA (or a token leak) from
// filling the operator's disk via the upload endpoint. 200MB covers any
// reasonable Instagram reel/image; bigger should go through the desktop
// app instead.
const UPLOAD_MAX_BYTES = 200 * 1024 * 1024

// Strip path-traversal + control chars from a user-supplied filename. We
// keep the extension because that's what determines what Android does
// with it after push (gallery picks up .jpg/.mp4 etc).
function sanitizeFilename(raw) {
    const base = String(raw || '').split(/[\\/]/).pop() || 'upload'
    const safe = base.replace(/[^A-Za-z0-9._\- ]+/g, '_').slice(0, 120)
    return safe || 'upload'
}

// Detect which Android user is currently in the foreground. Returns "0" by
// default if `am get-current-user` is unavailable or unparseable; the rest
// of the pipeline still works but skips the cross-user copy.
async function detectCurrentUser(adbPath, serial, runAdbCommand = runAdb) {
    const res = await runAdbCommand(adbPath, ['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
    const out = res.stdout.trim()
    return /^\d+$/.test(out) ? out : '0'
}

function createViewerNegotiationPacket(meta) {
    const displayId = Number.isInteger(meta?.displayInfo?.displayId) ? meta.displayInfo.displayId : 0
    return Buffer.concat([
        Buffer.from([101]),
        encodeVideoSettings({
            bitrate: 8_000_000,
            maxFps: 60,
            iFrameInterval: 2,
            bounds: null,
            crop: null,
            sendFrameMeta: false,
            lockedVideoOrientation: -1,
            displayId,
            codecOptions: 'i-frame-interval=2',
            encoderName: null,
        }),
    ])
}

// Run the full upload-to-device pipeline. Pushes to user 0's /sdcard/Download
// (the canonical adb-push destination), then mirrors the file into the
// currently-active user's storage so apps running in that profile can see it.
// Returns { ok, serial, user, remote, bytes, error? }.
async function runUploadPipeline({ adbPath, serial, tmpPath, filename, bytes, runAdbCommand = runAdb }) {
    const remotePush = `/sdcard/Download/${filename}`
    const push = await runAdbCommand(adbPath, ['-s', serial, 'push', tmpPath, remotePush], 120_000)
    if (push.code !== 0) {
        return { ok: false, error: `adb push failed: ${push.stderr.trim() || push.error || 'unknown'}` }
    }
    const activeUser = await detectCurrentUser(adbPath, serial, runAdbCommand)
    let visibleRemote = remotePush
    if (activeUser !== '0') {
        // Copy to the active user's storage. /storage/emulated/<user>/Download
        // is the canonical path; using `cp` via `shell --user <X>` runs the
        // copy in that user's filesystem namespace so the destination ends up
        // owned by the user and visible to their MediaStore + apps.
        const destDir = `/storage/emulated/${activeUser}/Download`
        const destPath = `${destDir}/${filename}`
        // Some Android versions need the directory created first; mkdir -p
        // under the user's namespace handles missing-dir cases.
        await runAdbCommand(adbPath, ['-s', serial, 'shell', `--user`, activeUser, 'mkdir', '-p', destDir], 5000)
        const copy = await runAdbCommand(adbPath, ['-s', serial, 'shell', `--user`, activeUser, 'cp', remotePush, destPath], 30_000)
        if (copy.code === 0) {
            visibleRemote = destPath
        } else {
            // Fall back: copy via root shell (which CAN cross users) if `cp`
            // under --user denied. The shell-cp also avoids the cross-user
            // VFS restriction on some kernels.
            const fallback = await runAdbCommand(adbPath, ['-s', serial, 'shell', 'cp', remotePush, destPath], 30_000)
            if (fallback.code === 0) visibleRemote = destPath
            else return {
                ok: false,
                error: `pushed to /sdcard/Download/${filename} but cross-user copy to user ${activeUser} failed: ${(copy.stderr || fallback.stderr || '').trim()}`,
                serial, user: activeUser, remote: remotePush, bytes,
            }
        }
        // Nudge MediaStore so gallery/picker see the new file immediately
        // (otherwise it's there but won't appear until the next periodic scan).
        // Best-effort — failures don't fail the whole upload.
        await runAdbCommand(adbPath, ['-s', serial, 'shell', '--user', activeUser, 'am', 'broadcast',
            '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
            '-d', `file://${destPath}`], 5000)
    }
    // Verify the visible file actually exists with the right size before we
    // claim success. Without this, the user gets "Uploaded ✓" when something
    // silently went sideways and the phone has nothing useful.
    const verify = await runAdbCommand(adbPath, ['-s', serial, 'shell', 'ls', '-l', visibleRemote], 5000)
    if (verify.code !== 0 || !verify.stdout.trim()) {
        return {
            ok: false,
            error: `file not visible after push: ${verify.stderr.trim() || 'ls returned empty'}`,
            serial, user: activeUser, remote: visibleRemote, bytes,
        }
    }
    return { ok: true, serial, user: activeUser, remote: visibleRemote, bytes }
}

async function startPortalAuthProxy({
    token,                // optional explicit master token (else random)
    port = 0,             // preferred port; 0 = OS picks. Falls back to random on EADDRINUSE.
    // Bind to all interfaces so Tailscale (100.x.x.x) and LAN access
    // work alongside cloudflared. Token auth gates every request, so
    // exposing this on any interface is no less secure than the
    // cloudflared public tunnel was — both required the master token
    // either as ?t= or as a cookie. The cloudflared tunnel still
    // forwards to 127.0.0.1:<port> internally so its behaviour is
    // unchanged; staff on the host's tailnet can hit
    // http://<tailscale-ip>:<port>/?t=<token> directly, no tunnel
    // involved. Caller can override with host:'127.0.0.1' if a
    // deployment really needs loopback-only.
    host = '0.0.0.0',
    getNicknames,         // () => { [serial]: nickname } — read at request time so renames propagate live
    getDevices,           // () => Promise<[{ serial, model, status }]> — for the custom wizard landing
    getCurrentUserSession,
    getHealthMachine,
    now = Date.now,
    deviceTokenTtlMs = DEFAULT_DEVICE_TOKEN_TTL_MS,
    readStaticAsset = (name) => fs.promises.readFile(path.join(resolveStaticRoot(), name)),
    createWebSocketServer,
    setAuthSweepInterval = setInterval,
    clearAuthSweepInterval = clearInterval,
    runAdbCommand = runAbortableAdb,
    getDeviceMetaForSerial,
    getFanOutForSerial,
    retainFanOutForSerial,
    releaseFanOutForSerial,
    adbPath,              // absolute path to the adb binary — for file uploads
    uploadTempDir,        // dir to stage uploaded files before adb-push
}) {
    const currentUserId = () => {
        const session = typeof getCurrentUserSession === 'function' ? getCurrentUserSession() : null
        return session && typeof session.userId === 'string' && session.userId.trim()
            ? session.userId.trim()
            : null
    }
    const ownerUserId = currentUserId()
    if (!ownerUserId) throw new Error('authenticated desktop session required')

    // tokenStore is the source of truth for what each token can do.
    //   key: token string
    //   value: tenant/device scope plus immutable role, capabilities and audit metadata.
    const tokenStore = new Map()
    const tokenConnections = new Map()
    const vanadiumFileStore = new Map()
    let authSweepInterval = null

    const masterTok = token || crypto.randomBytes(24).toString('base64url')
    const masterAuthorization = normalizeAuthorization({ role: 'owner' })
    tokenStore.set(masterTok, {
        scope: '*',
        userId: ownerUserId,
        createdAt: now(),
        label: 'master',
        jti: crypto.randomBytes(16).toString('base64url'),
        ...masterAuthorization,
    })

    function trackTokenConnection(token, connection) {
        if (!tokenConnections.has(token)) tokenConnections.set(token, new Set())
        tokenConnections.get(token).add(connection)
        return () => {
            const connections = tokenConnections.get(token)
            if (!connections) return
            connections.delete(connection)
            if (connections.size === 0) tokenConnections.delete(token)
        }
    }

    function closeTokenConnections(token, reason) {
        const connections = tokenConnections.get(token)
        if (!connections) return
        tokenConnections.delete(token)
        for (const connection of connections) {
            try { connection.close(reason) } catch (_) {}
        }
    }

    function invalidateToken(token, reason) {
        const removed = tokenStore.delete(token)
        closeTokenConnections(token, reason)
        for (const [fileToken, entry] of vanadiumFileStore) {
            if (entry.parentToken !== token) continue
            try { fs.unlinkSync(entry.filePath) } catch (_) {}
            vanadiumFileStore.delete(fileToken)
        }
        return removed
    }

    function sweepAuth() {
        const sessionUserId = currentUserId()
        for (const [stored, meta] of tokenStore) {
            if (!sessionUserId || meta.userId !== sessionUserId) {
                invalidateToken(stored, 'desktop session changed')
                continue
            }
            if (meta.expiresAt && now() >= meta.expiresAt) {
                invalidateToken(stored, 'token expired')
            }
        }
    }

    function tokenIsActive(token, expectedMeta) {
        const stored = tokenStore.get(token)
        if (!stored || stored !== expectedMeta) return false
        const sessionUserId = currentUserId()
        if (!sessionUserId || stored.userId !== sessionUserId) {
            invalidateToken(token, 'desktop session changed')
            return false
        }
        if (stored.expiresAt && now() >= stored.expiresAt) {
            invalidateToken(token, 'token expired')
            return false
        }
        return true
    }

    const forwardPool = createForwardPool({ adbPath })

    const deviceMetaCache = new Map()
    async function getDeviceMeta(serial) {
        if (deviceMetaCache.has(serial)) return deviceMetaCache.get(serial)
        const meta = typeof getDeviceMetaForSerial === 'function'
            ? await getDeviceMetaForSerial(serial)
            : await fetchDeviceMeta(adbPath, serial)
        deviceMetaCache.set(serial, meta)
        return meta
    }

    // 2.13.0: device health state machine integration.
    // SSE subscribers receive iframe_reload_hint + health_state events.
    const { getMachine, SIGNALS } = require('./device-health')
    // 2.14.0: scrcpy fan-out — one upstream per device, broadcasts to N
    // browser clients with codec-config + last-keyframe replay on connect.
    // Fixes the pop-out + multi-staff black-screen problem caused by the
    // device-side scrcpy server being single-client.
    const WebSocket = require('ws')
    const { getFanOut, retainFanOut, releaseFanOut } = require('./scrcpy-fanout')
    const ownedFanouts = new Map()
    const wssAdb = typeof createWebSocketServer === 'function'
        ? createWebSocketServer({ noServer: true, perMessageDeflate: false })
        : new WebSocket.Server({ noServer: true, perMessageDeflate: false })
    wssAdb.on('connection', async (ws, req) => {
        const udid = (() => { try { return new URL(req.url, 'http://x').searchParams.get('udid') } catch (_) { return null } })()
        if (!udid) { try { ws.close(1008, 'udid required') } catch (_) {}; return }
        let meta
        try { meta = await getDeviceMeta(udid) } catch (e) {
            recordEvent('fanout_device_meta_err', { udid, err: e?.message?.slice(0, 200) })
            try { ws.close(1011, 'device meta unavailable') } catch (_) {}
            return
        }
        if (!req.portalAuthorization || req.portalAuthorization.revoked ||
            !tokenIsActive(req.portalAuthorization.token, req.portalAuthorization.meta) ||
            (typeof ws.readyState === 'number' && ws.readyState !== WebSocket.OPEN)) {
            try { ws.close(1008, 'authorization expired') } catch (_) {}
            return
        }
        // 2.15.0: use direct-source factory instead of ws-scrcpy upstream so
        // the fan-out drives the device stream itself via adb-forward + scrcpy.
        const fanoutFactory = typeof getFanOutForSerial === 'function' ? getFanOutForSerial : getFanOut
        const fanout = fanoutFactory(udid, `direct://${udid}`, {
            recordEvent, broadcast,
            viewerNegotiationPacket: createViewerNegotiationPacket(meta),
            sourceFactory: () => new ScrcpyDirectStreamSource({
                udid, devicePort: 8886, forwardPool, deviceMeta: meta, encoders: [],
            }),
        })
        if (!ownedFanouts.has(udid)) {
            const retainOwnedFanOut = typeof retainFanOutForSerial === 'function'
                ? retainFanOutForSerial
                : typeof getFanOutForSerial === 'function'
                    ? () => true
                    : retainFanOut
            if (!retainOwnedFanOut(udid, fanout)) {
                try { ws.close(1011, 'device stream unavailable') } catch (_) {}
                return
            }
            ownedFanouts.set(udid, fanout)
        }
        const canControl = req.portalCanControl === true
        fanout.addClient(ws, {
            canControl,
            canNegotiate: canControl,
            canRequestStream: !canControl,
        })
        ws.portalDetach = () => fanout.removeClient(ws)
        recordEvent('fanout_client_attached', { udid, clients: fanout.clients.size })
    })
    const sseClients = new Set()
    function broadcast(kind, payload) {
        const msg = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`
        const serial = payload && (payload.serial || payload.udid)
        const userId = payload && (payload.userId || payload.user_id)
        for (const client of sseClients) {
            if (client.meta.scope === 'device' && (!serial || serial !== client.meta.serial)) continue
            if (userId && userId !== client.meta.userId) continue
            try { client.res.write(msg) } catch (_) { /* dead client */ }
        }
    }
    function machineFor(serial) {
        const options = { adbPath, recordEvent, broadcast }
        return typeof getHealthMachine === 'function'
            ? getHealthMachine(serial, options)
            : getMachine(serial, options)
    }

    // Vanadium HTTP upload: temp store of files the wizard is hosting for
    // download by the phones' Vanadium browser. The token in the file URL
    // path IS the auth (the phone has no wizard cookie), so requests under
    // /sp-api/file/<token>/... bypass the normal cookie check below.
    const VANADIUM_TTL_MS = 10 * 60 * 1000
    const vanadiumCleanupInterval = setInterval(() => {
        const now = Date.now()
        for (const [tok, entry] of vanadiumFileStore) {
            if (entry.expiresAt < now) {
                try { fs.unlinkSync(entry.filePath) } catch (_) { /* ignore */ }
                vanadiumFileStore.delete(tok)
            }
        }
    }, 60_000)
    vanadiumCleanupInterval.unref()

    function serveVanadiumFile(req, res, token, filename) {
        const entry = vanadiumFileStore.get(token)
        const parent = entry && tokenStore.get(entry.parentToken)
        if (!entry || !parent || parent.userId !== currentUserId() ||
            (parent.expiresAt && now() >= parent.expiresAt) ||
            entry.expiresAt < Date.now() || entry.filename !== filename) {
            res.writeHead(404); return res.end('not found')
        }
        let st
        try { st = fs.statSync(entry.filePath) }
        catch (_) { res.writeHead(404); return res.end('file gone') }
        res.writeHead(200, {
            // Chromium files the download under this Content-Type and MediaProvider
            // keeps it on the row, so octet-stream left every .mov mislabeled for
            // the brain's video posting guard. content-disposition stays — it is
            // what forces the download path.
            'content-type': mediaMimeType(filename),
            'content-length': st.size,
            'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
            'cache-control': 'no-store',
        })
        const stream = fs.createReadStream(entry.filePath)
        const untrack = trackTokenConnection(entry.parentToken, {
            close: () => {
                try { stream.destroy() } catch (_) {}
                try { res.destroy() } catch (_) { try { res.end() } catch (_) {} }
                try { req.destroy() } catch (_) {}
            },
        })
        res.once('finish', untrack)
        res.once('close', untrack)
        stream.pipe(res)
    }

    // Server-side debug ring buffer. Pushed at key inflection points
    // (auth failures, WS upgrades, vanadium uploads). Exposed read-only
    // at /sp-api/debug-events under master scope — so when the wizard
    // misbehaves (a tile stays black, master shows fewer devices than
    // are connected, etc.), an operator can copy the JSON for inspection
    // instead of fishing through electron-main logs.
    const DEBUG_EVENT_CAP = 500
    const debugEvents = []
    function recordEvent(type, data) {
        debugEvents.push({ t: Date.now(), type, ...(data || {}) })
        if (debugEvents.length > DEBUG_EVENT_CAP) debugEvents.shift()
    }
    function visibleDebugEvents(meta, limit = DEBUG_EVENT_CAP) {
        const visible = meta.scope === 'device'
            ? debugEvents.filter((event) => {
                const serial = event.udid || event.serial
                return !serial || serial === meta.serial
            })
            : debugEvents
        return visible.slice(-limit)
    }
    recordEvent('proxy_started', { host })

    function setCookieFor(tok, req) {
        const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
        const standardForwarded = String(req?.headers?.forwarded || '')
        const secure = req?.socket?.encrypted === true || forwarded === 'https' || /(?:^|[;,]\s*)proto=https(?:[;,]|$)/i.test(standardForwarded)
        return `${COOKIE_NAME}=${encodeURIComponent(tok)}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`
    }

    function urlWithoutToken(reqUrl) {
        const parsed = new URL(reqUrl, 'http://portal.local')
        parsed.searchParams.delete('t')
        return parsed.pathname + parsed.search
    }

    function filterDevices(meta, devices) {
        const tenantDevices = (Array.isArray(devices) ? devices : []).filter((device) => {
            const deviceUserId = device && (device.userId || device.user_id)
            return deviceUserId === meta.userId
        })
        return meta.scope === 'device'
            ? tenantDevices.filter(device => device && device.serial === meta.serial)
            : tenantDevices
    }

    // Returns { ok, token, meta, fromUrl, fromCookie } for the request.
    function authPick(req) {
        const urlTok = tokenFromUrl(req.url)
        const cookieTok = tokenFromCookie(req)
        const sessionUserId = currentUserId()
        if (!sessionUserId) return { ok: false }
        // Look up by exact match first, but verify with timingSafeEqual to
        // keep constant-time semantics (an attacker who knows valid token
        // length but not value shouldn't be able to time-leak prefix matches
        // via the Map.has() short-circuit). We iterate stored tokens.
        const candidates = [urlTok, cookieTok].filter(Boolean)
        for (const cand of candidates) {
            for (const [stored, meta] of tokenStore.entries()) {
                if (safeEq(stored, cand)) {
                    if (meta.userId !== sessionUserId) continue
                    if (meta.expiresAt && now() >= meta.expiresAt) {
                        invalidateToken(stored, 'token expired')
                        continue
                    }
                    return {
                        ok: true,
                        token: stored,
                        meta,
                        fromUrl: cand === urlTok,
                        fromCookie: cand === cookieTok,
                        queryTokenPresent: urlTok !== null,
                    }
                }
            }
        }
        return { ok: false }
    }

    // For a device-scoped token, validate that the request's `udid=` matches.
    // Returns true if the request is allowed under the token's scope, false
    // if it's a scoped token attempting to address a different device.
    // Requests with no udid (HTML, device-list WS, assets) always pass — the
    // injected JS handles client-side filtering for those.
    function deviceScopeAllows(meta, reqUrl) {
        if (!meta || meta.scope === '*') return true
        if (meta.scope === 'device') {
            const udid = udidFromUrl(reqUrl)
            if (!udid) return true
            return udid === meta.serial
        }
        return false
    }

    async function issueDeviceToken(serial, label, authorization = {}) {
        const userId = currentUserId()
        if (!userId || userId !== ownerUserId) throw new Error('authenticated desktop session required')
        const normalizedSerial = String(serial || '').trim()
        if (!normalizedSerial) throw new Error('serial required')
        const requestedHwSerial = typeof authorization.hwSerial === 'string' ? authorization.hwSerial.trim() : ''
        const hardwareIdentity = device => {
            const hasStableProvenance = device != null && (
                Object.prototype.hasOwnProperty.call(device, 'stableHwSerial')
                || Object.prototype.hasOwnProperty.call(device, 'stable_hw_serial')
            )
            const values = [...new Set((hasStableProvenance
                ? [device?.stableHwSerial, device?.stable_hw_serial]
                : [device?.hwSerial, device?.hw_serial]
            ).map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean))]
            return values.length === 1 ? values[0] : ''
        }
        const devices = typeof getDevices === 'function' ? await getDevices() : []
        const allowed = filterDevices({ scope: '*', userId }, devices)
            .some(device => device && (
                device.serial === normalizedSerial
                || (requestedHwSerial && hardwareIdentity(device) === requestedHwSerial)
            ))
        if (!allowed) throw new Error('serial is not available to the current tenant')
        const createdAt = now()
        const token = crypto.randomBytes(24).toString('base64url')
        const normalizedAuthorization = normalizeAuthorization(authorization)
        const optionalString = value => typeof value === 'string' && value.trim() ? value.trim() : null
        tokenStore.set(token, {
            scope: 'device',
            userId,
            serial: normalizedSerial,
            createdAt,
            expiresAt: createdAt + deviceTokenTtlMs,
            label: label || null,
            jti: crypto.randomBytes(16).toString('base64url'),
            ...normalizedAuthorization,
            actorUserId: optionalString(authorization.actorUserId),
            grantId: optionalString(authorization.grantId),
            grantVersion: Number.isSafeInteger(authorization.grantVersion) && authorization.grantVersion >= 0
                ? authorization.grantVersion
                : null,
        })
        return token
    }

    const server = http.createServer((req, res) => {
        const reqPath = (req.url.split('?')[0] || '/')

        // Vanadium HTTP upload: phones hit /sp-api/file/<token>/<filename>
        // via adb reverse to download a wizard-hosted file. The opaque token
        // in the path IS the auth (these requests come from the phone's
        // browser, which has no wizard cookie), so handle this BEFORE the
        // normal cookie/token gate.
        const fileMatch = reqPath.match(/^\/sp-api\/file\/([A-Za-z0-9_-]+)\/(.+)$/)
        if (fileMatch && req.method === 'GET') {
            const filename = safeDecodeURIComponent(fileMatch[2])
            if (filename === null) { res.writeHead(400); return res.end('malformed filename encoding') }
            recordEvent('file_serve', { token: fileMatch[1].slice(0, 8) + '…', filename })
            return serveVanadiumFile(req, res, fileMatch[1], filename)
        }

        const auth = authPick(req)
        if (!auth.ok) {
            recordEvent('auth_fail', { path: reqPath, ua: (req.headers['user-agent'] || '').slice(0, 80) })
            res.writeHead(401); return res.end('unauthorized')
        }

        if (auth.queryTokenPresent) {
            res.writeHead(302, {
                location: urlWithoutToken(req.url),
                'set-cookie': setCookieFor(auth.token, req),
                'cache-control': 'no-store',
            })
            return res.end()
        }

        const capability = reqPath.startsWith('/sp-api/')
            ? endpointCapability(req.method, reqPath)
            : 'stream.read'
        if (!capability || !hasCapability(auth.meta, capability)) {
            recordEvent('capability_deny', { path: reqPath, method: req.method, role: auth.meta.role })
            res.writeHead(403); return res.end('forbidden')
        }

        const requestAbort = new AbortController()
        const authorizationError = () => Object.assign(new Error('portal authorization revoked'), {
            code: 'PORTAL_AUTHORIZATION_REVOKED',
        })
        const ensureRequestAuthorized = () => {
            if (requestAbort.signal.aborted || !tokenIsActive(auth.token, auth.meta)) {
                if (!requestAbort.signal.aborted) requestAbort.abort(authorizationError())
                throw authorizationError()
            }
        }
        const runSafetyAdb = (requestedAdbPath, args, timeoutMs) =>
            runAdbCommand(requestedAdbPath, args, timeoutMs)
        const runAdb = async (requestedAdbPath, args, timeoutMs) => {
            ensureRequestAuthorized()
            const result = await runAdbCommand(requestedAdbPath, args, timeoutMs, requestAbort.signal)
            ensureRequestAuthorized()
            return result
        }
        const waitForAuthorization = (delayMs) => new Promise((resolve, reject) => {
            ensureRequestAuthorized()
            const onAbort = () => {
                clearTimeout(timer)
                reject(authorizationError())
            }
            const timer = setTimeout(() => {
                requestAbort.signal.removeEventListener('abort', onAbort)
                try { ensureRequestAuthorized(); resolve() } catch (error) { reject(error) }
            }, delayMs)
            requestAbort.signal.addEventListener('abort', onAbort, { once: true })
        })
        const untrackRequest = trackTokenConnection(auth.token, {
            close: (reason) => {
                if (!requestAbort.signal.aborted) requestAbort.abort(authorizationError())
                if (res.writableEnded || res.destroyed) return
                if (typeof res.destroy === 'function') res.destroy()
                else res.end()
                try { req.destroy() } catch (_) {}
            },
        })
        res.once('finish', untrackRequest)
        res.once('close', untrackRequest)

        // Read-only debug event dump — diagnostics capability only. Operators fetch
        // this from a browser tab after reproducing a wizard issue and ships
        // the JSON to dev.
        if (reqPath === '/sp-api/debug-events') {
            const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
            if (auth.fromUrl) headers['set-cookie'] = setCookieFor(auth.token, req)
            res.writeHead(200, headers)
            return res.end(JSON.stringify({ events: visibleDebugEvents(auth.meta), now: Date.now() }))
        }

        // ShadowPhone overlay endpoints — served by the proxy itself, never
        // forwarded to ws-scrcpy. Cookie is set on these too so the injected
        // wizard JS reuses the same auth as everything else.
        if (reqPath === '/sp-api/token-info') {
            const out = {
                scope: auth.meta.scope,
                serial: auth.meta.serial || null,
                label: auth.meta.label || null,
                role: auth.meta.role,
                capabilities: auth.meta.capabilities,
                jti: auth.meta.jti,
                actorUserId: auth.meta.actorUserId || null,
                grantId: auth.meta.grantId || null,
                grantVersion: auth.meta.grantVersion ?? null,
            }
            const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
            if (auth.fromUrl) headers['set-cookie'] = setCookieFor(auth.token, req)
            res.writeHead(200, headers)
            return res.end(JSON.stringify(out))
        }
        if (reqPath === '/sp-api/devices') {
            const respond = (devs) => {
                const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
                if (auth.fromUrl) headers['set-cookie'] = setCookieFor(auth.token, req)
                res.writeHead(200, headers)
                res.end(JSON.stringify({ devices: filterDevices(auth.meta, devs) }))
            }
            try {
                const p = (typeof getDevices === 'function') ? getDevices() : Promise.resolve([])
                Promise.resolve(p).then(respond).catch(() => respond([]))
            } catch (_) { respond([]) }
            return
        }
        // Upload a file from the visitor's browser straight onto the phone.
        // GrapheneOS multi-user gotcha: `adb push /sdcard/...` lands in
        // Android user 0's storage. ShadowPhone operators run accounts on
        // user 10/11/12/..., and Android user-isolation makes user 0's files
        // INVISIBLE to those other users — Instagram running on user 12 can't
        // see what was pushed. Earlier upload was reporting success but the
        // VA could never find the file in their gallery picker.
        //
        // The fix:
        //   1. `am get-current-user` → detect which Android user is active.
        //   2. adb push to /sdcard/Download/<filename> (lands in user 0).
        //   3. If active user != 0, run `cmd content insert` AS THAT USER to
        //      copy into their MediaStore-visible Download dir. Falls back
        //      to `cp` via `run-as`/`shell --user` if that's not available.
        //   4. Verify the destination file exists via `ls -la`. Only then
        //      report success.
        if (reqPath === '/sp-api/upload-to-device' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            const filenameRaw = String(req.headers['x-sp-filename'] || '').trim()
            if (!serial) { res.writeHead(400); return res.end('X-SP-Serial header required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            if (!uploadTempDir) { res.writeHead(500); return res.end('upload temp dir not configured') }
            const filename = sanitizeFilename(filenameRaw)
            const tmpPath = path.join(uploadTempDir, `sp-upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${filename}`)
            let writeStream
            try { writeStream = fs.createWriteStream(tmpPath) }
            catch (e) { res.writeHead(500); return res.end(`tmp create failed: ${e.message}`) }
            let received = 0
            let aborted = false
            requestAbort.signal.addEventListener('abort', () => {
                aborted = true
                writeStream.destroy()
                try { fs.unlinkSync(tmpPath) } catch (_) {}
            }, { once: true })
            req.on('data', (chunk) => {
                received += chunk.length
                if (received > UPLOAD_MAX_BYTES && !aborted) {
                    aborted = true
                    writeStream.destroy()
                    try { fs.unlinkSync(tmpPath) } catch (_) { /* ignore */ }
                    res.writeHead(413); res.end(`file exceeds ${UPLOAD_MAX_BYTES} bytes`)
                    req.destroy()
                }
            })
            req.pipe(writeStream)
            writeStream.on('error', () => {
                try { fs.unlinkSync(tmpPath) } catch (_) {}
                if (!res.headersSent) { res.writeHead(500); res.end('write failed') }
            })
            writeStream.on('finish', () => {
                if (aborted || requestAbort.signal.aborted) return
                runUploadPipeline({
                    adbPath, serial, tmpPath, filename, bytes: received, runAdbCommand: runAdb,
                }).then((result) => {
                    try { fs.unlinkSync(tmpPath) } catch (_) {}
                    if (requestAbort.signal.aborted) return
                    if (!result.ok) {
                        res.writeHead(502, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify(result))
                    }
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify(result))
                }).catch((err) => {
                    try { fs.unlinkSync(tmpPath) } catch (_) {}
                    if (requestAbort.signal.aborted) return
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: err && err.message || String(err) }))
                })
            })
            return
        }
        // Upload-via-Vanadium: stage the file on the wizard, set up adb
        // reverse so the phone's localhost reaches the wizard, then
        // `am start` the phone's default browser (Vanadium on GrapheneOS)
        // at /sp-api/file/<token>/<filename>. The browser downloads the
        // file into the active user's Downloads, bypassing the cross-user
        // copy dance adb-push needs on GrapheneOS.
        if (reqPath === '/sp-api/upload-via-vanadium' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            const filenameRaw = String(req.headers['x-sp-filename'] || '').trim()
            if (!serial) { res.writeHead(400); return res.end('X-SP-Serial header required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            if (!uploadTempDir) { res.writeHead(500); return res.end('upload temp dir not configured') }
            const filename = sanitizeFilename(filenameRaw)
            const fileToken = crypto.randomBytes(16).toString('base64url')
            const filePath = path.join(uploadTempDir, `sp-vanadium-${fileToken}-${filename}`)
            let writeStream
            try { writeStream = fs.createWriteStream(filePath) }
            catch (e) { res.writeHead(500); return res.end(`tmp create failed: ${e.message}`) }
            let received = 0
            let aborted = false
            requestAbort.signal.addEventListener('abort', () => {
                aborted = true
                writeStream.destroy()
                try { fs.unlinkSync(filePath) } catch (_) {}
            }, { once: true })
            req.on('data', (chunk) => {
                received += chunk.length
                if (received > UPLOAD_MAX_BYTES && !aborted) {
                    aborted = true
                    writeStream.destroy()
                    try { fs.unlinkSync(filePath) } catch (_) {}
                    res.writeHead(413); res.end(`file exceeds ${UPLOAD_MAX_BYTES} bytes`)
                    req.destroy()
                }
            })
            req.pipe(writeStream)
            writeStream.on('error', () => {
                try { fs.unlinkSync(filePath) } catch (_) {}
                if (!res.headersSent) { res.writeHead(500); res.end('write failed') }
            })
            writeStream.on('finish', async () => {
                if (aborted || requestAbort.signal.aborted) return
                try {
                    vanadiumFileStore.set(fileToken, {
                        filePath, filename, bytes: received,
                        parentToken: auth.token,
                        expiresAt: Date.now() + VANADIUM_TTL_MS,
                    })
                    const port = req.socket.localPort
                    // adb reverse: phone's localhost:<port> → host:<port>.
                    // Re-running an existing reverse just updates it.
                    const reverse = await runAdb(adbPath,
                        ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], 5000)
                    if (reverse.code !== 0) {
                        try { fs.unlinkSync(filePath) } catch (_) {}
                        vanadiumFileStore.delete(fileToken)
                        res.writeHead(502, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify({ ok: false,
                            error: `adb reverse failed: ${(reverse.stderr || reverse.error || '').trim()}` }))
                    }
                    const url = `http://127.0.0.1:${port}/sp-api/file/${fileToken}/${encodeURIComponent(filename)}`
                    const launch = await runAdb(adbPath,
                        ['-s', serial, 'shell', 'am', 'start',
                         '-a', 'android.intent.action.VIEW', '-d', url], 8000)
                    if (launch.code !== 0) {
                        try { fs.unlinkSync(filePath) } catch (_) {}
                        vanadiumFileStore.delete(fileToken)
                        res.writeHead(502, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify({ ok: false,
                            error: `am start failed: ${(launch.stderr || launch.error || '').trim()}` }))
                    }
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, serial, filename, bytes: received, url,
                        hint: 'Vanadium is downloading on the phone' }))
                } catch (err) {
                    try { fs.unlinkSync(filePath) } catch (_) {}
                    vanadiumFileStore.delete(fileToken)
                    if (requestAbort.signal.aborted) return
                    if (!res.headersSent) {
                        res.writeHead(500, { 'content-type': 'application/json' })
                        res.end(JSON.stringify({ ok: false, error: err && err.message || String(err) }))
                    }
                }
            })
            return
        }
        // Quick gallery wipe from the pop-out toolbar — mirrors the
        // electron/lib/modules/gallery_clean.js pipeline but as a single
        // adb-shell round-trip so the wizard doesn't need to spin up the
        // brain. Detects the active Android user (multi-profile
        // GrapheneOS) so the MediaStore deletes target THEIR storage,
        // not user 0's empty default.
        if (reqPath === '/sp-api/wipe-gallery' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            if (!serial) { res.writeHead(400); return res.end('X-SP-Serial header required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            ;(async () => {
                try {
                    const user = await detectCurrentUser(adbPath, serial, runAdb)
                    const userFlag = user && user !== '0' ? ` --user ${user}` : ''
                    const dirs = '/sdcard/DCIM /sdcard/DCIM/Camera /sdcard/Pictures /sdcard/Download /sdcard/Movies /sdcard/ShadowPhone/content /sdcard/Pictures/Instagram'
                    const recursive = dirs.split(' ').flatMap(d => [`${d}/Camera/*`, `${d}/Screenshots/*`]).join(' ')
                    const cmd = [
                        `find ${dirs} -maxdepth 1 -type f -delete 2>/dev/null`,
                        `rm -rf ${recursive} 2>/dev/null`,
                        `content delete${userFlag} --uri content://media/external/images/media 2>/dev/null`,
                        `content delete${userFlag} --uri content://media/external/video/media 2>/dev/null`,
                        `content delete${userFlag} --uri content://media/external/downloads 2>/dev/null`,
                    ].join('; :; ') + '; :'
                    const r = await runAdb(adbPath, ['-s', serial, 'shell', cmd], 30000)
                    if (r.code !== 0 && r.stderr) {
                        recordEvent('wipe_gallery_err', { udid: serial, user, err: (r.stderr || '').trim().slice(0, 200) })
                        res.writeHead(502, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify({ ok: false, error: r.stderr.trim() }))
                    }
                    recordEvent('wipe_gallery', { udid: serial, user })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, user }))
                } catch (e) {
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }))
                }
            })()
            return
        }
        // Quick-launch an app — IG, TikTok, Gmail, anything. Used by the
        // pop-out toolbar so VAs don't have to fish through the home
        // screen. Whitelist of packages to avoid the endpoint being a
        // generic exec channel.
        if (reqPath === '/sp-api/launch-app' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            const pkg = String(req.headers['x-sp-package'] || '').trim()
            if (!serial) { res.writeHead(400); return res.end('X-SP-Serial header required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            const allowed = new Set([
                'com.instagram.android',
                'com.instagram.barcelona',
                'com.zhiliaoapp.musically',  // TikTok
                'com.google.android.gm',     // Gmail
                'com.google.android.youtube',
                'com.twitter.android',       // X
                'com.android.chrome',
                'app.vanadium.browser',
            ])
            if (!allowed.has(pkg)) { res.writeHead(400); return res.end('package not allowed') }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            ;(async () => {
                try {
                    const user = await detectCurrentUser(adbPath, serial, runAdb)
                    // `monkey --user` is silently ignored on modern Android
                    // (verified on a Pixel 6a / GrapheneOS — `monkey --user
                    // 0 -p ...` just prints "bash arg: --user" and exits 0
                    // without launching). The reliable path is to resolve
                    // the launcher component on the target user and `am
                    // start --user <X> -n <component>`.
                    const resolveCmd =
                        `cmd package resolve-activity --brief --user ${user} ` +
                        `-c android.intent.category.LAUNCHER ${pkg}`
                    const resolved = await runAdb(adbPath, ['-s', serial, 'shell', resolveCmd], 5000)
                    const lastLine = ((resolved.stdout || '').trim().split(/\r?\n/).pop() || '').trim()
                    if (!lastLine || !lastLine.includes('/')) {
                        recordEvent('launch_app_err', { udid: serial, pkg, user, err: 'not installed on this user' })
                        res.writeHead(404, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify({
                            ok: false,
                            error: `${pkg} not installed for active user ${user}. Install it on the active Android profile first.`,
                            active_user: user,
                        }))
                    }
                    const launch = await runAdb(adbPath, ['-s', serial, 'shell', 'am', 'start', '--user', user, '-n', lastLine], 8000)
                    if (launch.code !== 0) {
                        recordEvent('launch_app_err', { udid: serial, pkg, user, component: lastLine, err: (launch.stderr || '').trim().slice(0, 200) })
                        res.writeHead(502, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify({ ok: false, error: (launch.stderr || launch.stdout || 'am start failed').trim(), component: lastLine }))
                    }
                    recordEvent('launch_app', { udid: serial, pkg, user, component: lastLine })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, pkg, user, component: lastLine }))
                } catch (e) {
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }))
                }
            })()
            return
        }
        // Client → server event ingest. The master-tile watchdog and
        // pop-out diag post here every 10s with their view of the
        // stream (videoWidth, currentTime, paused, readyState) so
        // /sp-api/debug-events shows the BROWSER's state alongside the
        // server's. When a tile goes black post-2.12.9, the operator
        // (or a dev) can pull debug-events and see exactly when the
        // watchdog fired, what state it saw, and which devices it tried
        // to respawn — root-causable from the JSON alone.
        if (reqPath === '/sp-api/client-event' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial || '')}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            let body = ''
            req.on('data', (c) => { body += c.toString('utf8'); if (body.length > 4096) req.destroy() })
            req.on('end', () => {
                let parsed = {}
                try { parsed = JSON.parse(body || '{}') } catch (_) {}
                const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
                const telemetry = {
                    event: parsed.type === 'watchdog_tick' ? 'watchdog_tick' : 'unknown',
                    width: Math.max(0, finite(parsed.width)),
                    height: Math.max(0, finite(parsed.height)),
                    currentTime: Math.max(0, finite(parsed.ct)),
                    paused: parsed.paused === true,
                    readyState: Math.max(0, Math.min(4, Math.trunc(finite(parsed.ready)))),
                }
                recordEvent('client', {
                    udid: serial,
                    actorUserId: auth.meta.actorUserId || null,
                    grantId: auth.meta.grantId || null,
                    grantVersion: auth.meta.grantVersion ?? null,
                    jti: auth.meta.jti,
                    telemetry,
                })
                // 2.13.0: forward iframe video state to device-health
                if (serial && telemetry.event === 'watchdog_tick') {
                    machineFor(serial).onSignal(SIGNALS.IFRAME_PROGRESS, {
                        width: telemetry.width,
                        height: telemetry.height,
                        ct: telemetry.currentTime,
                        paused: telemetry.paused,
                        ready: telemetry.readyState,
                    })
                }
                res.writeHead(204); res.end()
            })
            return
        }

        // 2.13.0: SSE broadcast — clients subscribe here to receive
        // iframe_reload_hint and health_state events from device-health.
        if (reqPath === '/sp-api/health-events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store, no-transform',
                'Connection': 'keep-alive',
            })
            res.write('event: hello\ndata: {}\n\n')
            const client = { res, meta: auth.meta }
            sseClients.add(client)
            const untrack = trackTokenConnection(auth.token, {
                close: () => {
                    sseClients.delete(client)
                    res.end()
                },
            })
            req.on('close', () => {
                sseClients.delete(client)
                untrack()
            })
            return
        }

        // 2.14.1: one-shot diagnostic dump for SaaS user support. Requires
        // diagnostics.read. Returns JSON with everything Anyro/team needs to
        // root-cause a black tile or stream stall — wizard version,
        // ring buffer, every device's health snapshot + scrcpy log tail
        // + adb forward state, recent log file tails, system info. Staff
        // hit "Download diagnostics" in the master grid UI, save the
        // JSON, send to support — no manual file gathering required.
        if (reqPath === '/sp-api/diagnostic-bundle') {
            ;(async () => {
                const bundle = {
                    generated_at: new Date().toISOString(),
                    wizard_version: (() => { try { return require('../package.json').version } catch (_) { return null } })(),
                    platform: process.platform,
                    arch: process.arch,
                    node: process.versions.node,
                    electron: process.versions.electron || null,
                    debug_events: visibleDebugEvents(auth.meta, 200),
                    devices: [],
                    log_tails: {},
                    fanout_snapshots: [],
                    rival_stacks: [],
                }
                // 2.14.6: surface rival ws-scrcpy stacks so support can see
                // at-a-glance whether the user has a parallel respawner
                // fighting the wizard (Nur's 2026-05-23 incident).
                try {
                    const { detectRivalStacks } = require('./scrcpy-startup-cleanup')
                    bundle.rival_stacks = await detectRivalStacks({ logger: () => {} })
                } catch (_) {}
                // Per-device snapshots
                let devs = []
                try { devs = filterDevices(auth.meta, await getDevices()) } catch (_) { devs = [] }
                for (const d of devs) {
                    const serial = d.serial
                    const item = { serial, model: d.model, status: d.status }
                    try {
                        const m = machineFor(serial)
                        item.health = m.snapshot()
                    } catch (_) {}
                    if (adbPath) {
                        try {
                            // 2.14.2: awk script in single quotes so the
                            // device-side sh doesn't expand $2 to empty
                            // before awk sees it (Nur's 2.14.1 bundle had
                            // empty --PORT-- output for exactly this reason).
                            const r = await runAdb(adbPath, ['-s', serial, 'shell',
                                "echo --PID--; cat /data/local/tmp/ws_scrcpy.pid 2>/dev/null; " +
                                "echo --PROCS--; pgrep -fa scrcpy.Server 2>/dev/null; " +
                                "echo --PORT--; awk '$2 ~ /:22B6$/' /proc/net/tcp /proc/net/tcp6 2>/dev/null; " +
                                "echo --LOG--; tail -30 /data/local/tmp/ws_scrcpy.log 2>/dev/null",
                            ], 5000)
                            item.device_state = (r.stdout || '').slice(0, 8000)
                        } catch (_) {}
                        try {
                            const r = await runAdb(adbPath, ['forward', '--list'], 3000)
                            item.adb_forwards = (r.stdout || '').split('\n').filter(l => l.includes(serial))
                        } catch (_) {}
                    }
                    bundle.devices.push(item)
                }
                // Fanout state per device
                try {
                    const { getExistingFanOut } = require('./scrcpy-fanout')
                    bundle.fanout_snapshots = devs.map(d => {
                        try {
                            const f = getExistingFanOut(d.serial)
                            return f && f.snapshot ? f.snapshot() : null
                        } catch (_) { return null }
                    }).filter(Boolean)
                } catch (_) {}
                // Local log tails
                try {
                    const path = require('path')
                    const fs = require('fs')
                    const electronApp = (() => { try { return require('electron').app } catch (_) { return null } })()
                    const userData = electronApp ? electronApp.getPath('userData') : null
                    if (userData) {
                        const logDir = path.join(userData, 'logs')
                        if (fs.existsSync(logDir)) {
                            for (const name of fs.readdirSync(logDir)) {
                                if (!name.endsWith('.log')) continue
                                try {
                                    const p = path.join(logDir, name)
                                    const stat = fs.statSync(p)
                                    const size = stat.size
                                    const readBytes = Math.min(size, 32_000)
                                    const fd = fs.openSync(p, 'r')
                                    const buf = Buffer.alloc(readBytes)
                                    fs.readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes))
                                    fs.closeSync(fd)
                                    bundle.log_tails[name] = buf.toString('utf8')
                                } catch (_) {}
                            }
                        }
                    }
                } catch (_) {}
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                    'content-disposition': `attachment; filename="shadowphone-diagnostics-${Date.now()}.json"`,
                })
                res.end(JSON.stringify(bundle, null, 2))
            })()
            return
        }

        // 2.13.0: snapshot of per-device health for the e2e test +
        // operator debugging via curl.
        if (reqPath === '/sp-api/health-state') {
            const serial = (() => { try { return new URL(req.url, 'http://x').searchParams.get('serial') } catch (_) { return null } })()
            if (!serial) { res.writeHead(400); return res.end('serial param required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            const machine = machineFor(serial)
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            return res.end(JSON.stringify(machine.snapshot()))
        }

        // Read-only device state inspection — for a developer or
        // support agent to dump exactly what scrcpy processes a phone
        // is running + the state of its 8886 port + its pid/lock
        // files, WITHOUT mutating anything. Mirror of the manual
        // diagnostic Anyro's friend's-Claude has been running each
        // black-tile round, now usable from a browser tab with the
        // master token.
        if (reqPath.startsWith('/sp-api/debug-state') && req.method === 'GET') {
            const serial = (() => { try { return new URL(req.url, 'http://x').searchParams.get('serial') || '' } catch (_) { return '' } })()
            if (!serial) { res.writeHead(400); return res.end('serial query param required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            ;(async () => {
                try {
                    const inspect = [
                        'echo "--PID--"; cat /data/local/tmp/ws_scrcpy.pid 2>/dev/null',
                        'echo "--LOCK--"; ls -ld /data/local/tmp/ws_scrcpy.lock 2>/dev/null; cat /data/local/tmp/ws_scrcpy.lock/owner 2>/dev/null',
                        'echo "--SCRCPY-PROCS--"; for p in $(pgrep -f scrcpy.Server 2>/dev/null); do echo "$p:$(cat /proc/$p/comm 2>/dev/null): $(tr "\\0" " " </proc/$p/cmdline 2>/dev/null | head -c 200)"; done',
                        // 2.14.2: single-quote awk to stop sh from expanding $2.
                        "echo \"--TCP4-8886--\"; awk '$2 ~ /:22B6$/' /proc/net/tcp 2>/dev/null",
                        "echo \"--TCP6-8886--\"; awk '$2 ~ /:22B6$/' /proc/net/tcp6 2>/dev/null",
                        'echo "--LOG-TAIL--"; tail -20 /data/local/tmp/ws_scrcpy.log 2>/dev/null',
                        'echo "--ACTIVE-USER--"; am get-current-user',
                    ].join('; ')
                    const r = await runAdb(adbPath, ['-s', serial, 'shell', inspect], 8000)
                    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
                    if (auth.fromUrl) headers['set-cookie'] = setCookieFor(auth.token, req)
                    res.writeHead(200, headers)
                    res.end(JSON.stringify({ ok: true, serial, output: (r.stdout || '').trim() }))
                } catch (e) {
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }))
                }
            })()
            return
        }

        // Enumerate every local address the portal is reachable on, so the
        // desktop tray / Nur's-Claude can copy a Tailscale or LAN link
        // instead of relying on cloudflared. Tailscale IPs are in
        // 100.64.0.0/10 (CGNAT range); we tag them so the UI can show
        // "(Tailscale)" / "(LAN)" badges. Master-token only — exposing
        // callers without token.issue would leak the host's network topology.
        if (reqPath === '/sp-api/lan-links' && req.method === 'GET') {
            const ifaces = os.networkInterfaces()
            const port = server.address() && server.address().port
            const links = []
            for (const name of Object.keys(ifaces)) {
                for (const addr of ifaces[name] || []) {
                    if (addr.internal) continue
                    if (addr.family !== 'IPv4') continue   // keep it copy-pasteable; v6 in URLs needs brackets
                    let kind = 'lan'
                    const a = addr.address
                    // Tailscale CGNAT range 100.64.0.0/10 — first octet 100,
                    // second octet between 64 and 127 inclusive.
                    if (a.startsWith('100.')) {
                        const second = parseInt(a.split('.')[1], 10)
                        if (second >= 64 && second <= 127) kind = 'tailscale'
                    }
                    links.push({
                        iface: name,
                        address: a,
                        kind,
                        url: `http://${a}:${port}/`,
                    })
                }
            }
            // Sort Tailscale first — it's the recommended staff path.
            links.sort((x, y) => (x.kind === 'tailscale' ? -1 : y.kind === 'tailscale' ? 1 : 0))
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            return res.end(JSON.stringify({ ok: true, port, links }))
        }

        // Force a clean device-side respawn of the scrcpy server.
        // Triggered by the browser-side watchdog when a tile has no
        // frames for >15s (stale-server-survives-restart wedge: an
        // old ws server squats port 8886 with a pid the host-side
        // ws-scrcpy trusts, so getServerPid() returns "healthy" and
        // RUN_COMMAND is never invoked — the stale server lives
        // forever and the tile is permanently black until a human
        // intervenes). Targets ONLY the ws server identified by
        // port_number=8886 in its argv; the local-mirror scrcpy
        // (different scid, no port_number flag) is untouched. Friend's
        // -Claude derived this exact filter from field diagnostics.
        if (reqPath === '/sp-api/force-respawn' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            if (!serial) { res.writeHead(400); return res.end('X-SP-Serial header required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            // Server-side rate limit: max 1 respawn per device per 60s.
            // Field-diagnosed loop (friend's Claude, May 22) showed an
            // older pre-2.12.12 client hammering force-respawn every
            // ~5s on a false-positive "stream-frozen" reading, then the
            // new spawn couldn't rebind (kernel TIME_WAIT) and the loop
            // self-sustained: PID changing every few seconds, est=0,
            // bindstate=err, never recovering. Even with the 2.12.12+
            // client triage in place, an older deployed client (or a
            // staff member with a stale cached page) can still trigger
            // this. Rate-limiting at the SERVER means no client version
            // can churn the device.
            // 2.13.0: rate limit lives in DeviceHealthMachine cooldowns
            // (RESPAWN_COOLDOWN_MS). Endpoint now delegates by injecting
            // a synthetic DEVICE_PROBE signal that fails all checks —
            // the state machine respects its own cooldown and either
            // triggers respawn or records health_probe_cooldown.
            ;(async () => {
                try {
                    const killed = []
                    for (const dline of '0123456789'.split('').map(d => '/proc/' + d + '*')) {
                        /* placeholder for analyzer; real walk runs on device */
                    }
                    // Kill stale → wait for socket teardown → SPAWN
                    // FRESH ourselves + write the pid file. Field-
                    // captured ring buffer (v2.12.9) showed kill alone
                    // doesn't fix the wedge: ws-scrcpy's host-side
                    // state caches the dead PID, so new WS clients
                    // connect, can't find a server, and immediately
                    // close. We pre-empt that race by always leaving
                    // a fresh, bound server in place — the next
                    // getServerPid() sees it and attaches cleanly.
                    // Kill stale → POLL for port 8886 to actually free
                    // (kill releases LISTEN immediately on most kernels
                    // but field evidence on Pixel 6a / GrapheneOS shows
                    // bind() rejecting 'Address already in use' for a
                    // brief window post-kill; without polling, the
                    // fresh spawn collides with the just-released port
                    // and the watchdog loops killing each new spawn) →
                    // SPAWN fresh + write the pid file ourselves.
                    // 2.12.19: require N CONSECUTIVE empty samples before
                    // declaring the port free, then bind WITH RETRY on
                    // failure. Field-diagnosed in the Tailscale E2E test:
                    // the kill→spawn race against TIME_WAIT was firing
                    // single-sample "port free" detections, then bind()
                    // would still hit EADDRINUSE because the OS hadn't
                    // fully drained the closing TCP state yet. /proc/net/
                    // tcp transitions FIN_WAIT_1 → FIN_WAIT_2 → TIME_WAIT
                    // with brief gaps; a one-shot sample can hit a gap
                    // and declare "empty" prematurely. Requiring 3
                    // consecutive empty samples (=1.5s of stable empty)
                    // eliminates that race. Then if bind STILL fails,
                    // sleep 5s + spawn again (one retry only — beyond
                    // that the kernel itself needs more time; the
                    // server-side rate limit prevents looping).
                    // 2.13.0/2.13.1: same buildSpawnCommand() the ws-scrcpy
                    // launcher uses. One source of truth in lib/scrcpy-
                    // spawn.js. Also explicitly pushes the wizard's bundled
                    // scrcpy-server jar so the new spawn always loads the
                    // current build (covers the case where a stale jar from
                    // a different scrcpy fork is sitting on the device and
                    // rejects current spawn args as "Unknown server option").
                    const { buildSpawnCommand, pushScrcpyJar } = require('./scrcpy-spawn')
                    ensureRequestAuthorized()
                    const pushResult = await pushScrcpyJar(adbPath, serial, process.resourcesPath)
                    ensureRequestAuthorized()
                    recordEvent('force_respawn_jar_push', { udid: serial, ...pushResult })
                    const cmd = buildSpawnCommand()
                    // The device-side scrcpy process detaches itself. Keep the
                    // short-lived host adb shell inside the bounded manager.
                    const launch = await runAdbCommand(adbPath, ['-s', serial, 'shell', cmd], 15_000, requestAbort.signal)
                    if (launch.code !== 0) {
                        throw new Error(launch.error || launch.stderr || 'scrcpy respawn command failed')
                    }
                    ensureRequestAuthorized()
                    // Allow time for kill + port-free poll + spawn + bind
                    // verification inside the shell (up to ~12s in worst
                    // case, but typical path is ~3s).
                    await waitForAuthorization(5000)
                    // 2.14.2: single-quote awk (see diagnostic-bundle note).
                    const verify = await runAdbCommand(adbPath, ['-s', serial, 'shell',
                        "cat /data/local/tmp/ws_scrcpy.pid 2>/dev/null; echo --; awk '$2 ~ /:22B6$/ && $4 == \"0A\"' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l"
                    ], 5000, requestAbort.signal)
                    const lines = (verify.stdout || '').trim().split('\n')
                    const spawned = (lines[0] || '').trim() || null
                    const listening = parseInt(lines[2] || '0', 10) > 0
                    const bindstate = listening ? 'ok' : 'err'
                    recordEvent('force_respawn', { udid: serial, spawned, bindstate, via: 'scrcpy-spawn' })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, spawned, bindstate }))
                } catch (e) {
                    if (requestAbort.signal.aborted) return
                    recordEvent('force_respawn_err', { udid: serial, err: e?.message?.slice(0, 200) })
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }))
                }
            })()
            return
        }

        // List the phone's Android users for the pop-out switch-user
        // dropdown. Pulls `cmd user list -v` + `am get-current-user`
        // in one shot so the UI can star the active profile.
        if (reqPath.startsWith('/sp-api/list-users') && req.method === 'GET') {
            const serial = (() => { try { return new URL(req.url, 'http://x').searchParams.get('serial') || '' } catch (_) { return '' } })()
            if (!serial) { res.writeHead(400); return res.end('serial query param required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            ;(async () => {
                try {
                    const [list, current] = await Promise.all([
                        runAdb(adbPath, ['-s', serial, 'shell', 'cmd', 'user', 'list', '-v'], 6000),
                        runAdb(adbPath, ['-s', serial, 'shell', 'am', 'get-current-user'], 4000),
                    ])
                    const users = []
                    const re = /id=(\d+),\s*name=([^,]+),/g
                    let m
                    while ((m = re.exec(list.stdout || '')) != null) {
                        users.push({ id: m[1], name: m[2].trim() })
                    }
                    // Merge in local nickname overrides (the GrapheneOS
                    // shell can't actually rename users, so the desktop
                    // app + wizard share a local "displayName" override
                    // store; both surfaces show the renamed name).
                    const nicks = readNicknames()[serial] || {}
                    for (const u of users) {
                        if (nicks[u.id]) { u.original_name = u.name; u.name = nicks[u.id] }
                    }
                    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
                    if (auth.fromUrl) headers['set-cookie'] = setCookieFor(auth.token, req)
                    res.writeHead(200, headers)
                    res.end(JSON.stringify({ ok: true, users, active_id: (current.stdout || '').trim() }))
                } catch (e) {
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }))
                }
            })()
            return
        }

        // Switch Android user. Airplane ON → am switch-user → poll
        // until get-current-user returns the target → airplane OFF.
        // The airplane bookend prevents IG/Gmail/etc on the outgoing
        // profile from briefly resuming and seeing a network blip
        // during the switch (detection signal). Mirrors the same
        // bookend the v2 profile_create flow uses.
        if (reqPath === '/sp-api/switch-user' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            const userId = String(req.headers['x-sp-user-id'] || '').trim()
            if (!serial || !/^\d+$/.test(userId)) { res.writeHead(400); return res.end('serial + numeric user-id required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            // Hold the shared per-phone busy lock for the whole switch so a
            // portal op can never interleave with an in-flight run/sweep.
            const releasePhoneLock = scheduleEngine.acquirePhoneLock(serial)
            if (!releasePhoneLock) {
                recordEvent('switch_user_busy', { udid: serial, target: userId })
                res.writeHead(409, { 'content-type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, code: 'PHONE_BUSY', error: 'This phone is already running another automation.' }))
            }
            ;(async () => {
                let networkOff = false
                try {
                    networkOff = true
                    await runAdb(adbPath, ['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'], 5000)
                    const sw = await runAdb(adbPath, ['-s', serial, 'shell', 'am', 'switch-user', userId], 15000)
                    if (sw.code !== 0) throw new Error((sw.stderr || sw.stdout || 'am switch-user failed').trim())
                    let active = null
                    for (let i = 0; i < 10; i++) {
                        await waitForAuthorization(1000)
                        const c = await runAdb(adbPath, ['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                        active = (c.stdout || '').trim()
                        if (active === userId) break
                    }
                    await runAdb(adbPath, ['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], 5000)
                    networkOff = false
                    recordEvent('switch_user', { udid: serial, target: userId, active })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, target_user: userId, active_user: active }))
                } catch (e) {
                    // Always try to re-enable network on failure — leaving
                    // a phone in airplane mode after a failed switch is
                    // worse than the original failure.
                    if (networkOff) {
                        try { await runSafetyAdb(adbPath, ['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], 5000) } catch (_) {}
                    }
                    if (requestAbort.signal.aborted) return
                    recordEvent('switch_user_err', { udid: serial, target: userId, err: e?.message?.slice(0, 200) })
                    res.writeHead(502, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }))
                } finally {
                    releasePhoneLock()
                }
            })()
            return
        }

        // Rename a profile — for real this time. Ports the desktop brain's
        // execute_profile_rename_ws flow (electron/python/server.py:17041):
        // GrapheneOS lets users rename ONLY themselves, so we must
        // `am switch-user <target>` INTO the profile first, then drive
        // Settings → "You (CurrentName)" → user_name EditText → OK
        // button via uiautomator. Field-validated live: this actually
        // changes `cmd user list -v` output on-device, unlike the
        // service-path attempts that all 401 on MANAGE_USERS.
        //
        // Local nickname is ALSO updated as a fallback so the rename
        // shows in the overview/wizard UIs even if the UI flow fails
        // (e.g. screen locked, Settings activity not foregrounded).
        if (reqPath === '/sp-api/rename-profile' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            const userId = String(req.headers['x-sp-user-id'] || '').trim()
            const name = String(req.headers['x-sp-name'] || '').trim()
            if (!serial || !/^\d+$/.test(userId) || !name) {
                res.writeHead(400); return res.end('serial + numeric user-id + name required')
            }
            if (!/^[A-Za-z0-9 _.\-]{1,30}$/.test(name)) {
                res.writeHead(400); return res.end('name must be alphanumeric + space / dash / underscore / dot, max 30 chars')
            }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            // Hold the shared per-phone busy lock: the rename switches the
            // foreground user, which must never interleave with a run/sweep.
            const releasePhoneLock = scheduleEngine.acquirePhoneLock(serial)
            if (!releasePhoneLock) {
                recordEvent('rename_profile_busy', { udid: serial, user_id: userId })
                res.writeHead(409, { 'content-type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, code: 'PHONE_BUSY', error: 'This phone is already running another automation.' }))
            }
            ;(async () => {
                // Always write nickname first — even if UI fails, the UI
                // surfaces still reflect the rename.
                ensureRequestAuthorized()
                const all = readNicknames()
                if (!all[serial]) all[serial] = {}
                all[serial][userId] = name
                const wroteNick = writeNicknames(all)

                // Helper: parse `pm list users` for one user's name.
                const fetchCurrentName = async () => {
                    const r = await runAdb(adbPath, ['-s', serial, 'shell', 'pm', 'list', 'users'], 5000)
                    const m = (r.stdout || '').split('\n').map(l => l.match(new RegExp('UserInfo\\{' + userId + ':([^:]+):')))
                        .find(Boolean)
                    return m ? m[1] : null
                }
                // Helper: parse a uiautomator dump for the first node matching
                // a resource-id; returns its bounds center [x,y] or null.
                const findCenterByResId = (xml, rid) => {
                    const re = new RegExp(`resource-id="${rid.replace(/[$:.+]/g, '\\\\$&')}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)
                    const m = (xml || '').match(re)
                    if (!m) return null
                    return [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)]
                }
                const findCenterByText = (xml, txt) => {
                    const re = new RegExp(`text="${txt.replace(/[\\^$*+?.()|[\\]{}]/g, '\\\\$&')}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)
                    const m = (xml || '').match(re)
                    if (!m) return null
                    return [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)]
                }
                const sleep = waitForAuthorization
                const safetySleep = (ms) => new Promise(r => setTimeout(r, ms))
                const sh = (...args) => runAdb(adbPath, ['-s', serial, 'shell', ...args], 8000)
                const safetySh = (...args) => runSafetyAdb(adbPath, ['-s', serial, 'shell', ...args], 8000)
                const dumpUi = async () => {
                    const r = await runAdb(adbPath, ['-s', serial, 'shell',
                        'rm -f /sdcard/sp_rename.xml; uiautomator dump /sdcard/sp_rename.xml >/dev/null && cat /sdcard/sp_rename.xml',
                    ], 15000)
                    return r.stdout || ''
                }

                let onDevice = false
                let restoreUser = null
                try {
                    const currentName = await fetchCurrentName()
                    if (!currentName) throw new Error(`profile id ${userId} not found on device`)
                    if (currentName === name) {
                        onDevice = true
                        recordEvent('rename_profile', { udid: serial, user_id: userId, name, on_device: true, no_op: true, local_saved: wroteNick })
                        res.writeHead(200, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify({ ok: true, user_id: userId, name, on_device: true, no_op: true, local_saved: wroteNick }))
                    }
                    // Try the cheap service path first — silently succeeds on
                    // a future kernel that grants it, no UI flicker.
                    try {
                        await sh('cmd', 'user', 'set-user-name', userId, name)
                        await sleep(600)
                        const post = await fetchCurrentName()
                        if (post === name) {
                            onDevice = true
                            recordEvent('rename_profile', { udid: serial, user_id: userId, name, on_device: true, via: 'service', local_saved: wroteNick })
                            res.writeHead(200, { 'content-type': 'application/json' })
                            return res.end(JSON.stringify({ ok: true, user_id: userId, name, on_device: true, via: 'service', local_saved: wroteNick }))
                        }
                    } catch (_) { /* expected on GrapheneOS — fall through */ }

                    // UI flow: switch to target user, drive Settings.
                    const curR = await runAdb(adbPath, ['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                    const startedAs = (curR.stdout || '').trim()
                    if (startedAs !== userId) {
                        restoreUser = startedAs
                        await sh('cmd', 'connectivity', 'airplane-mode', 'enable')
                        await sleep(800)
                        await sh('am', 'switch-user', userId)
                        // Poll for switch up to 12s.
                        for (let i = 0; i < 12; i++) {
                            await sleep(1000)
                            const c = await runAdb(adbPath, ['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                            if ((c.stdout || '').trim() === userId) break
                        }
                        await sh('cmd', 'connectivity', 'airplane-mode', 'disable')
                        await sleep(1200)
                    }

                    // Wake + unlock + open Settings → Users.
                    await sh('input', 'keyevent', '224').catch(() => {})
                    await sh('input', 'keyevent', '82').catch(() => {})
                    await sleep(700)
                    await sh('am', 'start', '-a', 'android.settings.USER_SETTINGS')
                    await sleep(2500)

                    // Tap "You (CurrentName)" row.
                    let xml = await dumpUi()
                    let youCenter = findCenterByText(xml, `You (${currentName})`)
                    if (!youCenter) {
                        // Sometimes the row text just reads "You" with currentName in summary.
                        youCenter = findCenterByText(xml, 'You')
                    }
                    if (!youCenter) throw new Error('Settings: could not find "You (' + currentName + ')" row')
                    await sh('input', 'tap', String(youCenter[0]), String(youCenter[1]))
                    await sleep(1500)

                    // Locate the user_name EditText + button_ok.
                    xml = await dumpUi()
                    const editCenter = findCenterByResId(xml, 'com.android.settings:id/user_name')
                    const okCenter = findCenterByResId(xml, 'com.android.settings:id/button_ok')
                    if (!editCenter || !okCenter) {
                        throw new Error('Settings: rename dialog not visible (no user_name EditText or button_ok)')
                    }

                    // Tap EditText, clear current text, type new.
                    await sh('input', 'tap', String(editCenter[0]), String(editCenter[1]))
                    await sleep(500)
                    await sh('input', 'keyevent', 'KEYCODE_MOVE_END').catch(() => {})
                    // Backspace many times (current text length plus margin).
                    const clearCount = Math.max((currentName.length + 5), 30)
                    await sh(`i=0; while [ $i -lt ${clearCount} ]; do input keyevent 67; i=$((i+1)); done`)
                    await sleep(400)
                    const safeText = name.replace(/ /g, '%s').replace(/'/g, '').replace(/"/g, '').replace(/&/g, 'and')
                    await sh('input', 'text', safeText)
                    await sleep(500)
                    await sh('input', 'tap', String(okCenter[0]), String(okCenter[1]))
                    await sleep(1500)
                    await sh('input', 'keyevent', 'KEYCODE_HOME').catch(() => {})

                    const verify = await fetchCurrentName()
                    onDevice = verify === name
                } catch (uiErr) {
                    recordEvent('rename_profile_ui_err', { udid: serial, user_id: userId, name, err: uiErr?.message?.slice(0, 200) })
                } finally {
                    if (restoreUser && restoreUser !== userId) {
                        try {
                            await safetySh('cmd', 'connectivity', 'airplane-mode', 'enable')
                            await safetySleep(800)
                            // Verified restore through the guard: start-user →
                            // switch-user → get-current-user poll (a bare
                            // switch-user silently no-ops on a stopped user).
                            await scheduleEngine.guardedSwitchUser({
                                execAdb: (adbArgs, timeoutMs) => runSafetyAdb(adbPath, adbArgs, timeoutMs).then(r => r.stdout || ''),
                                serial,
                                targetUser: restoreUser,
                                intent: 'human',
                                wait: safetySleep,
                            })
                            await safetySh('cmd', 'connectivity', 'airplane-mode', 'disable')
                        } catch (_) { /* best effort */ }
                    }
                }

                if (requestAbort.signal.aborted) return
                recordEvent('rename_profile', { udid: serial, user_id: userId, name, on_device: onDevice, via: onDevice ? 'ui' : 'nickname_only', local_saved: wroteNick })
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, user_id: userId, name, on_device: onDevice, via: onDevice ? 'ui' : 'nickname_only', local_saved: wroteNick }))
            })().finally(releasePhoneLock)
            return
        }

        // Delete an Android profile. Refuses user 0 (the system owner
        // user is undeletable + removing it bricks the phone). If the
        // target is the currently-active foreground user, mirrors the
        // desktop semantics: pick a safe non-Owner landing profile BEFORE
        // deleting (409 if none), transition to Owner through the guard,
        // remove the user, then land on the safe profile — the phone is
        // never left parked on Owner.
        if (reqPath === '/sp-api/delete-profile' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            const userId = String(req.headers['x-sp-user-id'] || '').trim()
            if (!serial || !/^\d+$/.test(userId)) { res.writeHead(400); return res.end('serial + numeric user-id required') }
            if (userId === '0') { res.writeHead(400); return res.end('cannot delete user 0 (Owner)') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            // Hold the shared per-phone busy lock for the whole delete so a
            // portal op can never owner-flip a phone mid-run.
            const releasePhoneLock = scheduleEngine.acquirePhoneLock(serial)
            if (!releasePhoneLock) {
                recordEvent('delete_profile_busy', { udid: serial, user_id: userId })
                res.writeHead(409, { 'content-type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, code: 'PHONE_BUSY', error: 'This phone is already running another automation.' }))
            }
            ;(async () => {
                try {
                    const execAdb = (adbArgs, timeoutMs) => runAdb(adbPath, adbArgs, timeoutMs).then(r => r.stdout || '')
                    const cur = await runAdb(adbPath, ['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                    const active = (cur.stdout || '').trim()
                    let safeProfileId = null
                    if (active === userId) {
                        const usersR = await runAdb(adbPath, ['-s', serial, 'shell', 'pm', 'list', 'users'], 6000)
                        safeProfileId = Array.from(String(usersR.stdout || '').matchAll(/UserInfo\{(\d+):/g), m => m[1])
                            .find(id => id !== '0' && id !== userId) || null
                        if (!safeProfileId) {
                            res.writeHead(409, { 'content-type': 'application/json' })
                            return res.end(JSON.stringify({ ok: false, code: 'NO_SAFE_PROFILE', error: 'No non-Owner profile remains to land on after this deletion.' }))
                        }
                        const ownerSwitch = await scheduleEngine.guardedSwitchUser({
                            execAdb, serial, targetUser: '0', intent: 'human', wait: waitForAuthorization,
                        })
                        if (!ownerSwitch.success) {
                            throw new Error(`Owner transition failed (${ownerSwitch.code}); deletion was not attempted`)
                        }
                    }
                    const r = await runAdb(adbPath, ['-s', serial, 'shell', 'pm', 'remove-user', userId], 15000)
                    const ok = /success/i.test(r.stdout || '')
                    if (!ok) {
                        recordEvent('delete_profile_err', { udid: serial, user_id: userId, err: (r.stderr || r.stdout || '').trim().slice(0, 200) })
                        res.writeHead(502, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify({ ok: false, error: (r.stderr || r.stdout || 'pm remove-user failed').trim() }))
                    }
                    if (safeProfileId) {
                        const landed = await scheduleEngine.guardedSwitchUser({
                            execAdb, serial, targetUser: safeProfileId, intent: 'human', wait: waitForAuthorization,
                        })
                        if (!landed.success) {
                            recordEvent('delete_profile_strand', { udid: serial, user_id: userId, safe: safeProfileId, code: landed.code })
                            res.writeHead(502, { 'content-type': 'application/json' })
                            return res.end(JSON.stringify({ ok: false, deleted: true, error: `profile deleted, but the phone did not leave Owner for user ${safeProfileId}` }))
                        }
                    }
                    // Drop the nickname override for the dead user — no
                    // sense leaving stale entries in the share file.
                    try {
                        const all = readNicknames()
                        if (all[serial] && all[serial][userId]) {
                            delete all[serial][userId]
                            writeNicknames(all)
                        }
                    } catch (_) {}
                    recordEvent('delete_profile', { udid: serial, user_id: userId, safe_profile_id: safeProfileId })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, user_id: userId, safe_profile_id: safeProfileId }))
                } catch (e) {
                    if (requestAbort.signal.aborted) return
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }))
                } finally {
                    releasePhoneLock()
                }
            })()
            return
        }

        // Create a new Android profile on the phone. `pm create-user
        // --profileOf 0 <name>` returns "Success: created user id N";
        // we parse N out, then best-effort wizard-bypass on that new
        // user so it's immediately usable when an operator switches
        // into it (settings put --user N secure user_setup_complete 1
        // + am force-stop --user N org.grapheneos.setupwizard).
        if (reqPath === '/sp-api/create-profile' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            const name = String(req.headers['x-sp-name'] || '').trim()
            if (!serial || !name) { res.writeHead(400); return res.end('serial + name required') }
            if (!/^[A-Za-z0-9 _.\-]{1,30}$/.test(name)) {
                res.writeHead(400); return res.end('name must be alphanumeric + space / dash / underscore / dot, max 30 chars')
            }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            ;(async () => {
                try {
                    const r = await runAdb(adbPath, ['-s', serial, 'shell', 'pm', 'create-user', '--profileOf', '0', name], 30000)
                    const m = (r.stdout || '').match(/id\s+(\d+)/i)
                    if (!m) {
                        recordEvent('create_profile_err', { udid: serial, name, err: (r.stderr || r.stdout || '').trim().slice(0, 200) })
                        res.writeHead(502, { 'content-type': 'application/json' })
                        return res.end(JSON.stringify({ ok: false, error: (r.stderr || r.stdout || 'pm create-user failed').trim() }))
                    }
                    const newId = m[1]
                    try {
                        await runAdb(adbPath, ['-s', serial, 'shell', 'settings', 'put', '--user', newId, 'secure', 'user_setup_complete', '1'], 5000)
                        await runAdb(adbPath, ['-s', serial, 'shell', 'am', 'force-stop', '--user', newId, 'org.grapheneos.setupwizard'], 5000)
                    } catch (_) { /* wizard bypass is best-effort */ }
                    recordEvent('create_profile', { udid: serial, name, user_id: newId })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, user_id: newId, name }))
                } catch (e) {
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }))
                }
            })()
            return
        }

        // Ctrl+V into a phone — the wizard catches Ctrl+V client-side (in
        // index.html, on any focused stream page), reads navigator.clipboard
        // .readText(), and POSTs the text here. We forward it to the phone
        // via `adb shell input text`. `input text` only accepts %s for
        // spaces and dies on bare apostrophes; we encode spaces and shell-
        // quote each line, then send KEYCODE_ENTER between lines so
        // multi-line clipboard pastes preserve newlines.
        if (reqPath === '/sp-api/type-text' && req.method === 'POST') {
            const serial = String(req.headers['x-sp-serial'] || '').trim()
            if (!serial) { res.writeHead(400); return res.end('X-SP-Serial header required') }
            if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                res.writeHead(403); return res.end('device scope mismatch')
            }
            if (!adbPath) { res.writeHead(500); return res.end('adb not configured on this brain') }
            let body = ''
            let typeAborted = false
            req.on('data', (chunk) => {
                body += chunk.toString('utf8')
                if (body.length > 50000 && !typeAborted) {
                    typeAborted = true
                    res.writeHead(413); res.end('clipboard text exceeds 50000 chars')
                    req.destroy()
                }
            })
            req.on('end', async () => {
                if (typeAborted) return
                const lines = body.split(/\r?\n/)
                try {
                    for (let i = 0; i < lines.length; i++) {
                        if (i > 0) {
                            await runAdb(adbPath, ['-s', serial, 'shell', 'input', 'keyevent', '66'], 4000)
                        }
                        const line = lines[i]
                        if (!line) continue
                        // %s = space (only escape `adb shell input text` honors).
                        // Single-quote-wrap to neutralize shell metacharacters;
                        // escape any internal apostrophes via the standard
                        // single-quote dance: ' → '\''.
                        const escaped = "'" + line.replace(/ /g, '%s').replace(/'/g, "'\\''") + "'"
                        const r = await runAdb(adbPath, ['-s', serial, 'shell', 'input', 'text', escaped], 8000)
                        if (r.code !== 0) throw new Error(`adb input text failed: ${(r.stderr || r.error || '').trim()}`)
                    }
                    recordEvent('type_text', { udid: serial, chars: body.length, lines: lines.length })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, chars: body.length, lines: lines.length }))
                } catch (err) {
                    recordEvent('type_text_err', { udid: serial, err: err && err.message })
                    if (!res.headersSent) {
                        res.writeHead(500, { 'content-type': 'application/json' })
                        res.end(JSON.stringify({ ok: false, error: err && err.message || String(err) }))
                    }
                }
            })
            return
        }
        // Issue a viewer token. The parent needs token.issue; device-scoped
        // parents remain constrained to their own serial.
        if (reqPath === '/sp-api/issue-device-token' && req.method === 'POST') {
            let body = ''
            req.on('data', (c) => { body += c.toString('utf8'); if (body.length > 4096) req.destroy() })
            req.on('end', async () => {
                let parsed = {}
                try { parsed = JSON.parse(body || '{}') } catch (_) { /* leave empty */ }
                const serial = String(parsed.serial || '').trim()
                if (!serial) { res.writeHead(400); return res.end('serial required') }
                if (!deviceScopeAllows(auth.meta, `/?udid=${encodeURIComponent(serial)}`)) {
                    res.writeHead(403); return res.end('device scope mismatch')
                }
                const label = parsed.label ? String(parsed.label).slice(0, 80) : null
                try {
                    const newTok = await issueDeviceToken(serial, label, {
                        role: 'viewer',
                        actorUserId: auth.meta.actorUserId,
                        grantId: auth.meta.grantId,
                        grantVersion: auth.meta.grantVersion,
                    })
                    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
                    res.end(JSON.stringify({ token: newTok, serial, label }))
                } catch (error) {
                    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
                    res.end(JSON.stringify({ error: error.message }))
                }
            })
            return
        }
        if (reqPath === '/sp-api/nicknames') {
            let nicks = {}
            try { nicks = (typeof getNicknames === 'function' ? getNicknames() : null) || {} } catch { nicks = {} }
            if (auth.meta.scope === 'device') {
                nicks = Object.prototype.hasOwnProperty.call(nicks, auth.meta.serial)
                    ? { [auth.meta.serial]: nicks[auth.meta.serial] }
                    : {}
            }
            const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
            if (auth.fromUrl) headers['set-cookie'] = setCookieFor(auth.token, req)
            res.writeHead(200, headers)
            return res.end(JSON.stringify(nicks))
        }

        if (BLOCKED_PREFIXES.some(p => reqPath.startsWith(p))) { res.writeHead(403); return res.end('forbidden') }
        if (!deviceScopeAllows(auth.meta, req.url)) { res.writeHead(403); return res.end('device scope mismatch') }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(404); return res.end('not found')
        }
        const asset = STATIC_ASSETS.get(reqPath)
        if (!asset) { res.writeHead(404); return res.end('not found') }
        const [name, contentType] = asset
        Promise.resolve(readStaticAsset(name)).then((body) => {
            const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
            res.writeHead(200, {
                'content-type': contentType,
                'content-length': buffer.length,
                'cache-control': 'no-store',
            })
            res.end(req.method === 'HEAD' ? '' : buffer)
        }).catch(() => {
            res.writeHead(404); res.end('not found')
        })
    })

    server.on('upgrade', (req, clientSocket, head) => {
        // Pull the udid out of the WS URL so debug events report PER-DEVICE
        // upgrade results — that's the data point that pins multi-device
        // black-tile bugs ("device A upgraded, device B got reset").
        const upUdid = (() => { try { return new URL(req.url, 'http://x').searchParams.get('udid') } catch (_) { return null } })()
        const upAction = (() => { try { return new URL(req.url, 'http://x').searchParams.get('action') } catch (_) { return null } })()
        const auth = authPick(req)
        if (!auth.ok) {
            recordEvent('ws_upgrade_auth_fail', { udid: upUdid, action: upAction })
            clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return clientSocket.destroy()
        }
        if (!deviceScopeAllows(auth.meta, req.url)) {
            recordEvent('ws_upgrade_scope_deny', { udid: upUdid, action: upAction, scope: auth.meta.scope })
            clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return clientSocket.destroy()
        }
        if (!hasCapability(auth.meta, 'stream.read')) {
            recordEvent('ws_upgrade_capability_deny', { udid: upUdid, action: upAction, role: auth.meta.role })
            clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return clientSocket.destroy()
        }
        // 2.14.0: proxy-adb upgrades go through the fan-out so a 2nd
        // browser to the same device doesn't collapse the scrcpy
        // single-client server. The fan-out maintains ONE upstream WS
        // per device and broadcasts to all browser clients with
        // initial-info + last-keyframe replay so late joiners decode
        // immediately. All other actions (multiplex, etc.) keep going
        // through the existing raw TCP pipe — those don't have the
        // single-client problem.
        if (upAction === 'proxy-adb' && upUdid) {
            recordEvent('ws_upgrade_open', { udid: upUdid, action: upAction, via: 'fanout' })
            req.portalCanControl = hasCapability(auth.meta, 'device.control')
            req.portalAuthorization = { token: auth.token, meta: auth.meta, revoked: false }
            wssAdb.handleUpgrade(req, clientSocket, head, (ws) => {
                const untrack = trackTokenConnection(auth.token, {
                    close: (reason) => {
                        req.portalAuthorization.revoked = true
                        try { ws.portalDetach?.() } catch (_) {}
                        try { ws.close(1008, reason) } catch (_) {}
                    },
                })
                ws.once('close', () => {
                    req.portalAuthorization.revoked = true
                    try { ws.portalDetach?.() } catch (_) {}
                    untrack()
                })
                wssAdb.emit('connection', ws, req)
            })
            return
        }
        recordEvent('ws_upgrade_unknown', { udid: upUdid, action: upAction })
        clientSocket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        clientSocket.destroy()
    })

    await new Promise((resolve, reject) => {
        const onError = (err) => {
            if (err.code === 'EADDRINUSE' && port > 0) {
                server.removeListener('error', onError)
                server.listen(0, host, resolve)
            } else {
                reject(err)
            }
        }
        server.once('error', onError)
        server.listen(port || 0, host, () => {
            server.removeListener('error', onError)
            resolve()
        })
    })

    authSweepInterval = setAuthSweepInterval(sweepAuth, 1000)
    if (authSweepInterval && typeof authSweepInterval.unref === 'function') authSweepInterval.unref()

    return {
        port: server.address().port,
        // Issue a fresh role/capability-bound token for one serial.
        issueDeviceToken,
        // Listing + revoke for the desktop UI's "Manage links" surface.
        listTokens() {
            sweepAuth()
            const out = []
            for (const [tok, meta] of tokenStore.entries()) {
                if (meta.scope !== 'device') continue
                out.push({
                    token: tok,
                    scope: meta.scope,
                    userId: meta.userId,
                    serial: meta.serial || null,
                    createdAt: meta.createdAt,
                    expiresAt: meta.expiresAt || null,
                    label: meta.label || null,
                    role: meta.role,
                    capabilities: [...meta.capabilities],
                    jti: meta.jti,
                    actorUserId: meta.actorUserId || null,
                    grantId: meta.grantId || null,
                    grantVersion: meta.grantVersion ?? null,
                })
            }
            return out
        },
        revokeToken(tok) {
            // Can't revoke the master token while the portal is running —
            // killing the server is the only way out, by design.
            if (tok === masterTok) return false
            return invalidateToken(tok, 'token revoked')
        },
        close: async () => {
            if (authSweepInterval !== null) {
                clearAuthSweepInterval(authSweepInterval)
                authSweepInterval = null
            }
            for (const token of Array.from(tokenStore.keys())) invalidateToken(token, 'portal closed')
            clearInterval(vanadiumCleanupInterval)
            for (const client of sseClients) {
                try { client.res.end() } catch (_) {}
            }
            sseClients.clear()
            const releaseOwnedFanOut = typeof releaseFanOutForSerial === 'function'
                ? releaseFanOutForSerial
                : releaseFanOut
            let canReleaseForwardPool = true
            for (const [udid, fanout] of ownedFanouts) {
                try {
                    if (!releaseOwnedFanOut(udid, fanout)) canReleaseForwardPool = false
                } catch (_) {
                    canReleaseForwardPool = false
                }
            }
            ownedFanouts.clear()
            if (canReleaseForwardPool) {
                try { await forwardPool._releaseAll() } catch (_) {}
            }
            await new Promise(resolve => server.close(resolve))
        },
        forwardPool,
    }
}

module.exports = { resolveStaticRoot, startPortalAuthProxy }
