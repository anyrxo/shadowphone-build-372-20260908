/*
 * usb-vps-bridge.js — adb-server-share.
 *
 * Exposes THIS PC's local adb server on the PC's Tailscale IP so a remote VPS can
 * drive USB-attached phones over the USB CABLE — with NO Tailscale on the phones.
 * USB as a first-class alternative to running phones on Tailscale.
 *
 * Why the adb server (not a per-device TCP relay): a relay needs the phone's
 * network adbd (tcp:5555), which DIES the moment the phone enters airplane mode —
 * and the profile-switch flow is airplane-on -> switch-user -> airplane-off. The
 * USB transport is airplane-proof (it's a cable), so driving over the PC's adb
 * server holds through the entire switch. Battle-tested: a VPS drove a Pixel 6
 * through airplane on/off continuously.
 *
 * The VPS sets:  ANDROID_ADB_SERVER_SOCKET=tcp:<pcTailnetIp>:5037
 * and every USB phone on this PC shows up in `adb devices`, fully drivable.
 *
 * Pure Node (net) — identical on Windows + macOS. The proxy binds ONLY to the
 * PC's tailnet IP, so only tailnet members can reach it.
 */

const net = require('net')
const { execFile } = require('child_process')
const { findTailscaleBinary, getTailscaleDeniedReason, getTailscaleStatus } = require('./tailscale-status')
const { runAdb } = require('./adb-util')

const BRIDGE_LISTEN_PORT = 5037
const UPSTREAM_ADB_PORT = 5137
const ENSURE_MS = 20000
const IDENTITY_AUTH_TIMEOUT_MS = 5000
const IDENTITY_CACHE_TTL_MS = 5000
const IDENTITY_CACHE_MAX_ENTRIES = 64

function resolveUpstreamAdbPort(value = process.env.ANDROID_ADB_SERVER_PORT) {
    const port = Number(value)
    return Number.isInteger(port) && port > 0 && port <= 65535 && port !== BRIDGE_LISTEN_PORT
        ? port
        : UPSTREAM_ADB_PORT
}

let _server = null
let _boundIp = null
let _listening = false
let _timer = null
let _adbPath = null
let _getAdbPath = null
let _getTailscaleStatus = getTailscaleStatus
let _log = () => {}
let _upstreamAdbPort = resolveUpstreamAdbPort()
let _allowedRemoteIps = new Set()
let _identityPolicy = { allowedNodeIds: [], requiredTags: [], configured: false }
let _verifyRemoteIdentity = queryTailscaleIdentity
let _identityResolver = createIdentityResolver(queryTailscaleIdentity)
let _backendState = 'Unknown'
let _deniedReason = null
let _ensureGeneration = 0
let _runAdb = _adb
let _openProxyImpl = _openProxy
// Upstream (local adb server) liveness, distinct from the listen-socket bind state.
// `enabled` reflects the bind layer only; `_upstreamHealthy` reflects whether the adb
// daemon the VPS forwards into actually answers — so the operator can tell
// "socket up, daemon behind it dead" from a healthy bridge. null = not yet probed.
let _upstreamHealthy = null
let _lastUpstreamWarnAt = 0
const _UPSTREAM_WARN_MS = 5 * 60 * 1000
// Open client sockets — server.close() only stops accepting new connections, so the
// already-piped pairs must be destroyed explicitly on rebind/stop or they leak and an
// immediate re-listen(sameIp) can hit EADDRINUSE. Destroying the client triggers the
// existing upstream teardown via the client 'error' handler.
const _clientPairs = new Map()

function destroyClientPairs(clientPairs = _clientPairs) {
    for (const [client, upstream] of clientPairs) {
        try { upstream?.destroy() } catch (_) {}
        try { client.destroy() } catch (_) {}
    }
    clientPairs.clear()
}

function _destroyClients() {
    destroyClientPairs(_clientPairs)
}

function normalizeRemoteIp(value) {
    const ip = String(value || '').trim()
    if (ip.toLowerCase().startsWith('::ffff:')) {
        const mapped = ip.slice(7)
        if (net.isIP(mapped) === 4) return mapped
    }
    return net.isIP(ip) ? ip.toLowerCase() : null
}

function normalizeAllowedRemoteIps(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(normalizeRemoteIp)
        .filter(Boolean))]
}

function isRemoteAllowed(remoteAddress, allowedRemoteIps) {
    const remoteIp = normalizeRemoteIp(remoteAddress)
    if (!remoteIp) return false
    const allowed = allowedRemoteIps instanceof Set
        ? allowedRemoteIps
        : new Set(normalizeAllowedRemoteIps(allowedRemoteIps))
    return allowed.has(remoteIp)
}

function normalizeIdentityValues(value, predicate = () => true) {
    const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/)
    return [...new Set(values.map(item => String(item || '').trim()).filter(item => item && predicate(item)))]
}

function normalizeIdentityPolicy({ allowedNodeIds, requiredTags } = {}) {
    const rawNodeIds = normalizeIdentityValues(allowedNodeIds)
    const rawTags = normalizeIdentityValues(requiredTags)
    const nodeIds = rawNodeIds.filter(value => /^[A-Za-z0-9._:-]+$/.test(value))
    const tags = rawTags.filter(value => /^tag:[A-Za-z0-9._-]+$/.test(value))
    return {
        allowedNodeIds: nodeIds,
        requiredTags: tags,
        configured: rawNodeIds.length > 0 || rawTags.length > 0,
        valid: nodeIds.length === rawNodeIds.length && tags.length === rawTags.length,
    }
}

function resolveIdentityPolicy({ allowedNodeIds, requiredTags, env = process.env } = {}) {
    const envNodeIds = String(env?.SHADOWPHONE_USB_VPS_ALLOWED_NODE_IDS || '').trim()
    const envTags = String(env?.SHADOWPHONE_USB_VPS_REQUIRED_TAGS || '').trim()
    return normalizeIdentityPolicy({
        allowedNodeIds: envNodeIds || allowedNodeIds,
        requiredTags: envTags || requiredTags,
    })
}

function createIdentityResolver(verifyRemoteIdentity, {
    ttlMs = IDENTITY_CACHE_TTL_MS,
    maxEntries = IDENTITY_CACHE_MAX_ENTRIES,
    now = Date.now,
} = {}) {
    const cache = new Map()
    const inflight = new Map()
    const cacheTtlMs = Math.max(0, Number(ttlMs) || 0)
    const cacheLimit = Math.max(1, Math.floor(Number(maxEntries) || 1))
    let generation = 0

    function keyFor(remoteAddress, policy) {
        const remoteIp = normalizeRemoteIp(remoteAddress) || ''
        const nodeIds = normalizeIdentityValues(policy?.allowedNodeIds).sort()
        const tags = normalizeIdentityValues(policy?.requiredTags).sort()
        return JSON.stringify([remoteIp, nodeIds, tags, policy?.valid !== false])
    }

    function resolve(remoteAddress, policy) {
        if (typeof verifyRemoteIdentity !== 'function') {
            return Promise.resolve({ ok: false, error: 'Tailscale identity unavailable' })
        }
        const remoteIp = normalizeRemoteIp(remoteAddress)
        if (!remoteIp) return Promise.resolve({ ok: false, error: 'Tailscale identity unavailable' })
        const key = keyFor(remoteIp, policy)
        const cached = cache.get(key)
        if (cached && cached.expiresAt > now()) {
            cache.delete(key)
            cache.set(key, cached)
            return Promise.resolve(cached.identity)
        }
        if (cached) cache.delete(key)
        if (inflight.has(key)) return inflight.get(key)
        if (inflight.size >= cacheLimit) {
            return Promise.resolve({ ok: false, error: 'Tailscale identity unavailable' })
        }

        const lookupGeneration = generation
        let lookup
        try {
            lookup = Promise.resolve(verifyRemoteIdentity(remoteIp))
        } catch (_) {
            lookup = Promise.resolve({ ok: false, error: 'Tailscale identity unavailable' })
        }
        lookup = lookup.then(identity => {
            const normalized = identity?.ok === true
                ? {
                    ok: true,
                    nodeId: typeof identity.nodeId === 'string' ? identity.nodeId.trim() : '',
                    tags: normalizeIdentityValues(identity.tags, value => value.startsWith('tag:')),
                }
                : { ok: false, error: 'Tailscale identity unavailable' }
            if (normalized.ok && normalized.nodeId && generation === lookupGeneration && cacheTtlMs > 0) {
                while (cache.size >= cacheLimit) cache.delete(cache.keys().next().value)
                cache.set(key, { identity: normalized, expiresAt: now() + cacheTtlMs })
            }
            return normalized.ok && normalized.nodeId
                ? normalized
                : { ok: false, error: 'Tailscale identity unavailable' }
        }, () => ({ ok: false, error: 'Tailscale identity unavailable' })).finally(() => {
            if (inflight.get(key) === lookup) inflight.delete(key)
        })
        inflight.set(key, lookup)
        return lookup
    }

    return {
        resolve,
        clear() {
            generation += 1
            cache.clear()
            inflight.clear()
        },
        get size() { return cache.size },
        get pending() { return inflight.size },
    }
}

function queryTailscaleIdentity(remoteAddress, options = {}) {
    const remoteIp = normalizeRemoteIp(remoteAddress)
    if (!remoteIp) return Promise.resolve({ ok: false, error: 'Tailscale identity unavailable' })
    const binary = options.binary || findTailscaleBinary()
    const execFileImpl = options.execFileImpl || execFile
    const timeout = options.timeoutMs ?? 4000
    return new Promise(resolve => {
        let child = null
        let settled = false
        const finish = result => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }
        const timer = setTimeout(() => {
            try { child?.kill() } catch (_) {}
            finish({ ok: false, error: 'Tailscale identity unavailable' })
        }, timeout)
        try {
            child = execFileImpl(binary, ['whois', '--json', remoteIp], {
                windowsHide: true,
                timeout,
                maxBuffer: 64 * 1024,
            }, (error, stdout) => {
                if (error) {
                    finish({ ok: false, error: 'Tailscale identity unavailable' })
                    return
                }
                try {
                    const parsed = JSON.parse(String(stdout || ''))
                    const nodeId = typeof parsed?.Node?.StableID === 'string' ? parsed.Node.StableID.trim() : ''
                    const tags = normalizeIdentityValues(parsed?.Node?.Tags, value => value.startsWith('tag:'))
                    if (!nodeId) throw new Error('stable node identity missing')
                    finish({ ok: true, nodeId, tags })
                } catch (_) {
                    finish({ ok: false, error: 'Tailscale identity unavailable' })
                }
            })
        } catch (_) {
            finish({ ok: false, error: 'Tailscale identity unavailable' })
        }
    })
}

async function authorizeRemoteIdentity(remoteAddress, {
    allowedRemoteIps,
    identityPolicy,
    verifyRemoteIdentity,
    resolveRemoteIdentity,
} = {}) {
    if (!isRemoteAllowed(remoteAddress, allowedRemoteIps)) return { ok: false, reason: 'source-ip-not-authorized' }
    const policy = identityPolicy?.configured === true ? identityPolicy : normalizeIdentityPolicy(identityPolicy)
    if (!policy.configured) return { ok: false, reason: 'identity-policy-missing' }
    if (policy.valid === false) return { ok: false, reason: 'identity-policy-invalid' }
    const resolveIdentity = resolveRemoteIdentity || verifyRemoteIdentity
    if (typeof resolveIdentity !== 'function') return { ok: false, reason: 'identity-unavailable' }

    let identity
    try {
        identity = await resolveIdentity(normalizeRemoteIp(remoteAddress), policy)
    } catch (_) {
        return { ok: false, reason: 'identity-unavailable' }
    }
    const nodeId = typeof identity?.nodeId === 'string' ? identity.nodeId.trim() : ''
    const tags = new Set(normalizeIdentityValues(identity?.tags, value => value.startsWith('tag:')))
    if (identity?.ok !== true || !nodeId) return { ok: false, reason: 'identity-unavailable' }
    if (policy.allowedNodeIds.length > 0 && !policy.allowedNodeIds.includes(nodeId)) {
        return { ok: false, reason: 'node-not-authorized' }
    }
    if (policy.requiredTags.some(tag => !tags.has(tag))) return { ok: false, reason: 'tag-not-authorized' }
    return { ok: true }
}

function evaluateBridgeGate(tailscaleStatus, allowedRemoteIps, identityPolicy) {
    if (normalizeAllowedRemoteIps(allowedRemoteIps).length === 0) {
        return { ok: false, ip: null, error: 'Remote VPS Tailnet IP allowlist is empty' }
    }
    if (!identityPolicy?.configured) {
        return { ok: false, ip: null, error: 'Remote VPS Tailscale identity policy is missing' }
    }
    if (identityPolicy.valid === false) {
        return { ok: false, ip: null, error: 'Remote VPS Tailscale identity policy is invalid' }
    }
    const error = getTailscaleDeniedReason(tailscaleStatus)
    if (error) return { ok: false, ip: null, error }
    return { ok: true, ip: tailscaleStatus.self.ip, error: null }
}

function pcTailnetIp() {
    return _boundIp
}

function runAdbCommand(adbPath, args, {
    timeoutMs = 8000,
    upstreamAdbPort = resolveUpstreamAdbPort(),
    execFileImpl = execFile,
} = {}) {
    const port = resolveUpstreamAdbPort(upstreamAdbPort)
    if (execFileImpl === execFile) {
        return runAdb(adbPath, args, timeoutMs, {
            env: { ANDROID_ADB_SERVER_PORT: String(port) },
        })
    }
    return new Promise(resolve => {
        execFileImpl(adbPath, args, {
            timeout: timeoutMs,
            windowsHide: true,
            env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) },
        }, (err, stdout) => {
            resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '' })
        })
    })
}

function _adb(args, timeoutMs = 8000, upstreamAdbPort = _upstreamAdbPort) {
    return runAdbCommand(_adbPath, args, { timeoutMs, upstreamAdbPort })
}

async function handleProxyClient(client, {
    bridgeIp,
    allowedRemoteIps,
    identityPolicy,
    verifyRemoteIdentity,
    resolveRemoteIdentity,
    authTimeoutMs = IDENTITY_AUTH_TIMEOUT_MS,
    upstreamAdbPort = resolveUpstreamAdbPort(),
    connectUpstream = port => net.connect(port, '127.0.0.1'),
    clientPairs = _clientPairs,
    log = _log,
} = {}) {
    let upstream = null
    clientPairs.set(client, null)
    client.on('close', () => {
        clientPairs.delete(client)
        try { upstream?.destroy() } catch (_) {}
    })
    client.on('error', () => { try { upstream?.destroy() } catch (_) {} })
    client.pause()

    let authorization
    let authTimer = null
    try {
        const timeoutMs = Number.isFinite(authTimeoutMs) && authTimeoutMs > 0
            ? authTimeoutMs
            : IDENTITY_AUTH_TIMEOUT_MS
        authorization = await Promise.race([
            authorizeRemoteIdentity(client.remoteAddress, {
                allowedRemoteIps,
                identityPolicy,
                verifyRemoteIdentity,
                resolveRemoteIdentity,
            }),
            new Promise(resolve => {
                authTimer = setTimeout(() => resolve({ ok: false, reason: 'identity-timeout' }), timeoutMs)
            }),
        ])
    } catch (_) {
        authorization = { ok: false, reason: 'identity-unavailable' }
    } finally {
        if (authTimer) clearTimeout(authTimer)
    }
    if (!authorization.ok || client.destroyed) {
        log('usb-vps:client-denied', { reason: authorization.reason || 'client-closed' })
        try { client.destroy() } catch (_) {}
        return false
    }

    try {
        // 3.2.3: forward to OUR adb server's dedicated port (ANDROID_ADB_SERVER_PORT,
        // default 5137), not the listen port. The bridge LISTENS on 5037 (what the
        // remote VPS dials, unchanged) but our local adb daemon now lives on the
        // isolated port so a foreign system adb can't war with it.
        upstream = connectUpstream(resolveUpstreamAdbPort(upstreamAdbPort))
        clientPairs.set(client, upstream)
    } catch (_) {
        log('usb-vps:client-denied', { reason: 'upstream-unavailable' })
        try { client.destroy() } catch (_) {}
        return false
    }
    // Reap silently-dead tunnel halves: a tailnet tunnel drop can leave one half
    // wedged open with NO FIN (documented gotcha here). TCP keepalive forces the
    // OS to probe and surface the dead peer, which then trips the teardown below.
    // Only ever tears down a pair where a half is already dead — healthy proxied
    // adb sessions are unaffected.
    try { client.setKeepAlive(true, 30000); upstream.setKeepAlive(true, 30000) } catch (_) {}
    let bytesFlowed = false
    upstream.once('data', () => { bytesFlowed = true })
    client.pipe(upstream); upstream.pipe(client); client.resume()
    upstream.on('error', e => {
        // Upstream (local adb server) refused/half-dead before any bytes flowed —
        // surface it so a dead daemon behind a live listen socket is visible.
        if (!bytesFlowed) { _upstreamHealthy = false; log('usb-vps:upstream-down', { ip: bridgeIp, error: e && e.message }) }
        try { client.destroy() } catch (_) {}
    })
    // A CLEAN upstream FIN (no error) — exactly what `adb kill-server`/daemon restart
    // produces — must also tear down the client; the client close path destroys the
    // paired upstream and removes the pair from the tracked set.
    upstream.on('close', () => { try { client.destroy() } catch (_) {} })
    upstream.on('end', () => { try { client.destroy() } catch (_) {} })
    return true
}

function _openProxy(ip) {
    const server = net.createServer(client => {
        void handleProxyClient(client, {
            bridgeIp: ip,
            allowedRemoteIps: _allowedRemoteIps,
            identityPolicy: _identityPolicy,
            verifyRemoteIdentity: _verifyRemoteIdentity,
            resolveRemoteIdentity: _identityResolver.resolve,
            upstreamAdbPort: _upstreamAdbPort,
        })
    })
    server.on('error', e => { _listening = false; _boundIp = null; _log('usb-vps:share-error', { ip, error: e && e.message }) })
    server.listen(BRIDGE_LISTEN_PORT, ip, () => { _boundIp = ip; _listening = true; _log('usb-vps:share-up', { endpoint: `${ip}:${BRIDGE_LISTEN_PORT}` }) })
    return server
}

// Keep the proxy bound to the CURRENT tailnet IP (it can appear late at boot or,
// rarely, change). Only re-binds when the IP actually changes.
// Async so each tick can capture the start-server result + a cheap liveness probe
// without blocking; setInterval tolerates an async fn. The probes are short-budgeted
// (<=6s start-server, <=3s liveness) and non-throwing so a slow/contended adb (the
// documented dump-balloon-under-scrcpy condition) can't stall the ensure tick.
async function _ensure() {
    const generation = ++_ensureGeneration
    let tailscaleStatus
    try {
        tailscaleStatus = await _getTailscaleStatus()
    } catch (error) {
        tailscaleStatus = { ok: false, backendState: 'Unknown', self: { online: false, ip: null, dnsName: null }, peers: [], error: error?.message || 'Tailscale status failed' }
    }
    if (generation !== _ensureGeneration) return { enabled: false, denied: true, error: _deniedReason || 'Bridge state check superseded', backendState: _backendState, endpoint: null, devices: [] }
    _backendState = tailscaleStatus?.backendState || 'Unknown'
    const gate = evaluateBridgeGate(tailscaleStatus, [..._allowedRemoteIps], _identityPolicy)
    if (!gate.ok) {
        _deniedReason = gate.error
        _identityResolver.clear()
        // Tailnet flapped away: the bound socket points at a vanished interface and
        // can no longer be valid. Tear it down so the same-IP return rebinds clean
        // (the _listening gate above won't catch a server that's still "listening"
        // on a dead interface).
        if (_server) { _destroyClients(); try { _server.close() } catch (_) {} _server = null }
        _boundIp = null
        _listening = false
        _upstreamHealthy = null
        _log('usb-vps:denied', { backendState: _backendState, error: _deniedReason })
        return { enabled: false, denied: true, error: _deniedReason, backendState: _backendState, endpoint: null, devices: [] }
    }
    _deniedReason = null
    const ip = gate.ip
    _adbPath = typeof _getAdbPath === 'function' ? _getAdbPath() : _getAdbPath
    if (!_adbPath) {
        _deniedReason = 'ShadowPhone ADB path unavailable'
        return { enabled: false, denied: true, error: _deniedReason, backendState: _backendState, endpoint: null, devices: [] }
    }
    // Keep the local adb server alive EVERY tick — the device-watchdog periodically
    // `adb kill-server`s the very server the VPS proxies into; start-server is a
    // no-op when it's already up and revives it otherwise, so the share self-heals
    // instead of forwarding to a dead server until app restart.
    // Inspect the result (the old `.catch(()=>{})` was dead code — _adb always
    // resolves and never rejects) so a failed revival is observable, not silent.
    const sr = await _runAdb(['start-server'], 6000, _upstreamAdbPort)
    if (generation !== _ensureGeneration) return { enabled: false, denied: true, error: _deniedReason || 'Bridge state check superseded', backendState: _backendState, endpoint: null, devices: [] }
    if (sr.code !== 0) {
        _upstreamHealthy = false
        if (Date.now() - _lastUpstreamWarnAt >= _UPSTREAM_WARN_MS) {
            _lastUpstreamWarnAt = Date.now()
            _log('usb-vps:start-server-failed', { code: sr.code, ip })
        }
    } else {
        // Cheap liveness probe: start-server exit 0 only means the launcher ran; confirm
        // the daemon actually answers a trivial query before declaring upstream healthy.
        const ls = await _runAdb(['get-state'], 3000, _upstreamAdbPort)
        if (generation !== _ensureGeneration) return { enabled: false, denied: true, error: _deniedReason || 'Bridge state check superseded', backendState: _backendState, endpoint: null, devices: [] }
        _upstreamHealthy = ls.code === 0
        if (!_upstreamHealthy && Date.now() - _lastUpstreamWarnAt >= _UPSTREAM_WARN_MS) {
            _lastUpstreamWarnAt = Date.now()
            _log('usb-vps:upstream-down', { ip, error: 'get-state probe failed' })
        }
    }
    if (generation !== _ensureGeneration) return { enabled: false, denied: true, error: _deniedReason || 'Bridge state check superseded', backendState: _backendState, endpoint: null, devices: [] }
    if (_server && _boundIp === ip && _listening) return status()
    if (_server) {
        _identityResolver.clear()
        _destroyClients()
        try { _server.close() } catch (_) {}
        _server = null
        _listening = false
    }
    _server = _openProxyImpl(ip)
    return status()
}

// Cross-module nicety: device-watchdog._restartAdbServer() does its own kill/start.
// Letting it ping this lets the bridge re-probe upstream health immediately instead
// of waiting up to ENSURE_MS, shrinking the transient-refusal window. Non-throwing,
// no-op when the bridge isn't running.
function pingEnsure() {
    if (!_timer) return
    Promise.resolve().then(_ensure).catch(() => {})
}

async function start({
    getAdbPath,
    log,
    allowedRemoteIps,
    allowedNodeIds,
    requiredTags,
    upstreamAdbPort,
    verifyRemoteIdentity,
    getTailscaleStatus: statusCollector,
    runAdb,
    openProxy,
} = {}) {
    if (_timer || _server) stop()
    else _ensureGeneration += 1
    _log = log || (() => {})
    _upstreamAdbPort = resolveUpstreamAdbPort(upstreamAdbPort)
    const normalizedAllowedIps = normalizeAllowedRemoteIps(allowedRemoteIps)
    _allowedRemoteIps = new Set(normalizedAllowedIps)
    if (_allowedRemoteIps.size === 0) {
        _deniedReason = 'Remote VPS Tailnet IP allowlist is empty'
        return { enabled: false, denied: true, error: _deniedReason, backendState: 'Unknown', endpoint: null, devices: [] }
    }
    _identityPolicy = resolveIdentityPolicy({ allowedNodeIds, requiredTags })
    if (!_identityPolicy.configured) {
        _deniedReason = 'Remote VPS Tailscale identity policy is missing'
        return { enabled: false, denied: true, error: _deniedReason, backendState: 'Unknown', endpoint: null, devices: [] }
    }
    if (!_identityPolicy.valid) {
        _deniedReason = 'Remote VPS Tailscale identity policy is invalid'
        return { enabled: false, denied: true, error: _deniedReason, backendState: 'Unknown', endpoint: null, devices: [] }
    }
    _verifyRemoteIdentity = verifyRemoteIdentity || queryTailscaleIdentity
    _identityResolver.clear()
    _identityResolver = createIdentityResolver(_verifyRemoteIdentity)
    _getAdbPath = getAdbPath
    _getTailscaleStatus = statusCollector || getTailscaleStatus
    _runAdb = runAdb || _adb
    _openProxyImpl = openProxy || _openProxy
    const initialGeneration = _ensureGeneration + 1
    const initialStatus = await _ensure()
    if (_ensureGeneration !== initialGeneration) return { enabled: false, denied: true, error: _deniedReason || 'Bridge start superseded', backendState: _backendState, endpoint: null, devices: [] }
    _timer = setInterval(_ensure, ENSURE_MS)
    if (_timer.unref) _timer.unref()
    _log('usb-vps:started', {
        allowedRemoteIpCount: normalizedAllowedIps.length,
        allowedNodeIdCount: _identityPolicy.allowedNodeIds.length,
        requiredTagCount: _identityPolicy.requiredTags.length,
    })
    return initialStatus
}

function stop() {
    _ensureGeneration += 1
    if (_timer) { clearInterval(_timer); _timer = null }
    _destroyClients()
    if (_server) { try { _server.close() } catch (_) {} _server = null }
    _boundIp = null
    _listening = false
    _backendState = 'Unknown'
    _deniedReason = null
    _allowedRemoteIps = new Set()
    _identityPolicy = normalizeIdentityPolicy()
    _verifyRemoteIdentity = queryTailscaleIdentity
    _identityResolver.clear()
    _identityResolver = createIdentityResolver(queryTailscaleIdentity)
    _upstreamAdbPort = resolveUpstreamAdbPort()
    _getAdbPath = null
    _getTailscaleStatus = getTailscaleStatus
    _runAdb = _adb
    _openProxyImpl = _openProxy
    _log('usb-vps:stopped', {})
}

// USB-attached serials (skip tcp ip:port rows) — what the VPS will see.
async function listUsbSerials(runAdb = _runAdb, upstreamAdbPort = _upstreamAdbPort) {
    const r = await runAdb(['devices', '-l'], 8000, upstreamAdbPort)
    return r.stdout.split('\n').slice(1)
        .map(l => l.trim()).filter(Boolean)
        .map(l => l.split(/\s+/))
        .filter(p => p[1] === 'device' && !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(p[0]))
        .map(p => p[0])
}

async function _usbSerials() {
    return listUsbSerials(_runAdb, _upstreamAdbPort)
}

// { enabled, upstreamHealthy, endpoint, devices[] } for the Settings UI + VPS connect
// string. `enabled` reflects ONLY the bind/socket layer; `upstreamHealthy` is a separate
// signal for the adb daemon behind it — so a transient start-server hiccup surfaces as
// enabled:true + upstreamHealthy:false ("socket up, daemon broken") rather than flapping
// the connect string the UI/VPS reads.
async function status() {
    // enabled ONLY when the socket actually bound (a failed/blocked bind — EADDRINUSE,
    // macOS Local Network denial — must not read as live to the UI or the VPS).
    if (!_server || !_listening || !_boundIp) {
        return { enabled: false, denied: !!_deniedReason, error: _deniedReason, backendState: _backendState, upstreamHealthy: _upstreamHealthy, endpoint: null, devices: [] }
    }
    let devices = []
    try { devices = await _usbSerials() } catch (_) {}
    return { enabled: true, denied: false, error: null, backendState: _backendState, upstreamHealthy: _upstreamHealthy, endpoint: `${_boundIp}:${BRIDGE_LISTEN_PORT}`, devices }
}

module.exports = {
    BRIDGE_LISTEN_PORT,
    UPSTREAM_ADB_PORT,
    authorizeRemoteIdentity,
    createIdentityResolver,
    destroyClientPairs,
    evaluateBridgeGate,
    isRemoteAllowed,
    handleProxyClient,
    listUsbSerials,
    normalizeAllowedRemoteIps,
    normalizeIdentityPolicy,
    normalizeRemoteIp,
    pcTailnetIp,
    pingEnsure,
    queryTailscaleIdentity,
    resolveUpstreamAdbPort,
    resolveIdentityPolicy,
    runAdbCommand,
    start,
    status,
    stop,
}
