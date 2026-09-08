// electron/lib/scrcpy-fanout.js
//
// Per-device fan-out proxy: maintains ONE upstream WebSocket to the device's
// scrcpy server (which is single-client by design) and broadcasts its byte
// stream to N browser clients. Caches the initial info packet + the latest
// video keyframe so a new browser joining mid-stream gets a decodable starting
// point instead of un-decodable deltas (which is what made the wizard's
// pop-out always go black: the 2nd client joined mid-stream with no SPS/PPS).
//
// Field-found by Nur's Claude (2026-05-23): the bundled ws-scrcpy fork's
// scrcpy.Server is single-client — a 2nd direct connection collapses the
// 1st client AND kills the server. This module is the correct fix.

const WebSocket = require('ws')
const { MAGIC_INITIAL, MAGIC_MESSAGE } = require('./scrcpy-protocol')

const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024
const MAX_PENDING_UPSTREAM_BYTES = 1024 * 1024
const SET_VIDEO_SETTINGS_TYPE = 101
const MIN_SET_VIDEO_SETTINGS_BYTES = 36

function asMessageBuffer(data) {
    if (Buffer.isBuffer(data)) return data
    if (Array.isArray(data)) return Buffer.concat(data.map(chunk => Buffer.from(chunk)))
    if (data instanceof ArrayBuffer) return Buffer.from(data)
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    return null
}

function isVideoNegotiationMessage(data, isBinary) {
    if (!isBinary) return false
    const packet = asMessageBuffer(data)
    if (!packet || packet.length < MIN_SET_VIDEO_SETTINGS_BYTES || packet.length > MAX_CONTROL_MESSAGE_BYTES) return false
    if (packet.readUInt8(0) !== SET_VIDEO_SETTINGS_TYPE) return false
    const codecLength = packet.readInt32BE(28)
    if (codecLength < 0) return false
    const encoderLengthOffset = 32 + codecLength
    if (encoderLengthOffset + 4 > packet.length) return false
    const encoderLength = packet.readInt32BE(encoderLengthOffset)
    if (encoderLength < 0) return false
    return encoderLengthOffset + 4 + encoderLength === packet.length
}

function startsWithMagic(packet, magic) {
    return packet.length >= magic.length && packet.subarray(0, magic.length).equals(magic)
}

function h264NalTypes(packet) {
    const types = new Set()
    for (let index = 0; index + 4 < packet.length; index += 1) {
        let headerOffset = -1
        if (packet[index] === 0 && packet[index + 1] === 0 && packet[index + 2] === 1) {
            headerOffset = index + 3
        } else if (packet[index] === 0 && packet[index + 1] === 0 &&
            packet[index + 2] === 0 && packet[index + 3] === 1) {
            headerOffset = index + 4
        }
        if (headerOffset >= 0 && headerOffset < packet.length) {
            types.add(packet[headerOffset] & 0x1f)
            index = headerOffset
        }
    }
    return types
}

// 2.14.1: WS protocol PING every 25s on the upstream connection so the
// fan-out → ws-scrcpy → adb forward → device:8886 chain stays warm. Without
// this, Cloudflared's quick-tunnel idle timeout (~100s) kills the WS even
// though the device is fine and our fan-out has live browser clients.
const UPSTREAM_KEEPALIVE_MS = 25_000

// 2.14.16: stall watchdog. If the fan-out has active clients but the upstream
// hasn't sent ANY bytes in 30s after at least one client sent SetVideoSettings,
// the underlying scrcpy on the device likely died (crash, OOM, system_server
// soft-restart). Force-close + reconnect the upstream so ws-scrcpy re-spawns
// scrcpy via RUN_COMMAND. Without this, scrcpy crashes leave the dashboard
// permanently black until the user closes/reopens the tab.
const STALL_DETECT_MS = 30_000
const STALL_CHECK_INTERVAL_MS = 10_000

class FanOut {
    constructor(udid, upstreamUrl, opts = {}) {
        this.udid = udid
        this.upstreamUrl = upstreamUrl
        this.recordEvent = opts.recordEvent || (() => {})
        this.broadcast = opts.broadcast || (() => {})  // for iframe_reload_hint on reconnect
        this._sourceFactory = opts.sourceFactory || null
        this.viewerNegotiationPacket = Buffer.isBuffer(opts.viewerNegotiationPacket)
            ? Buffer.from(opts.viewerNegotiationPacket)
            : null
        this.upstream = null
        this.upstreamReady = false
        this.clients = new Set()
        this.clientPolicies = new Map()
        // 2.14.2: primary-controller pattern. The bundled ws-scrcpy fork's
        // scrcpy.Server closes the upstream with code 4010 ("config
        // mismatch") when a 2nd client sends SetVideoSettings with even
        // slightly different parameters from the 1st. Multi-viewer support
        // means we must accept multiple browser sockets but only forward
        // control messages from ONE of them to scrcpy. The first-attached
        // client is the primary; secondaries are read-only viewers.
        // On primary disconnect, the next client gets promoted so control
        // doesn't die with the primary's tab close.
        this.primaryClient = null
        this.negotiationClient = null
        // 2.14.1: pending message queue. Buffers client → upstream messages
        // that arrive BEFORE the upstream WS reaches OPEN state. Without this,
        // the first client's SetVideoSettings gets silently dropped while the
        // upstream is in CONNECTING state, and scrcpy never starts encoding.
        this.pendingUpstream = []
        this.pendingUpstreamBytes = 0
        this._viewerNegotiationRequested = false
        // Replay buffer — sent to each new client in order before live tail.
        this.initialInfo = null
        this.lastConfigFrame = null
        this.lastKeyframe = null
        this.haveKeyframe = false
        this._keepaliveTimer = null
        this._reconnectTimer = null
        this._reconnecting = false
        this._stallCheckTimer = null
        this._lastClientControlAt = 0  // when did we last forward a client msg to upstream
        this._lastReloadHintAt = 0  // 2.14.19: throttle reload broadcasts
        this._connect()
        this._startStallWatchdog()
    }

    // 2.14.19: throttled reload broadcast to prevent reload-loops.
    // 2.14.20: SUPPRESSED. Anyro field-found 2026-05-23: any reload hint
    // — even throttled — triggers chains where the browsers reload, the
    // ws-scrcpy upstream cycles, and pop-out windows tear down. Browser
    // already auto-reconnects on WS close via the ws-scrcpy client code.
    // We don't need to push reload hints at all. The stall watchdog still
    // fires on REAL silence (>30s no bytes upstream) but quietly drops
    // the upstream socket — browser sees the socket close and re-handshakes
    // on its own backoff schedule, no full page reload.
    _broadcastReloadHint(reason) {
        this.recordEvent('fanout_reload_hint_suppressed', { udid: this.udid, reason })
        // intentionally do nothing — see comment above
    }

    _onUpstreamOpen() {
        // FIX_SAFE: clear stale replay buffers on every (re)open so a
        // stall-watchdog-triggered reconnect to the same URL doesn't serve
        // a mismatched old initial-info blob to new clients. The existing
        // guard at _onUpstreamMessage (initialInfo === null) repopulates
        // them correctly from the fresh encoder session's first two packets.
        // Live-stream clients are unaffected — they never receive replay data.
        this.initialInfo = null
        this.lastConfigFrame = null
        this.lastKeyframe = null
        this.haveKeyframe = false
        this.upstreamReady = true
        this._reconnecting = false
        this._reconnectAttempts = 0  // 2.14.18: reset backoff on successful open
        this._upstreamOpenAt = Date.now()
        this.recordEvent('fanout_upstream_open', { udid: this.udid, clients: this.clients.size, url: this.upstreamUrl })
        // Flush queued client → upstream messages now that upstream is OPEN.
        while (this.pendingUpstream.length > 0) {
            const { data, isBinary, bytes, client, kind } = this.pendingUpstream.shift()
            this.pendingUpstreamBytes = Math.max(0, this.pendingUpstreamBytes - bytes)
            if (!this._clientCanForward(client, kind)) continue
            try { this.upstream.send(data, { binary: isBinary }) } catch (_) {}
        }
        // Start keepalive ping cadence.
        this._startKeepalive()
        // If this was a RECONNECT (not the first open), broadcast a reload
        // hint so browser clients re-handshake — their cached SetVideoSettings
        // state is stale and the new upstream doesn't have the encoder
        // primed for them yet.
        // The broadcast callback is set by portal-auth-proxy; null in tests.
    }

    _onUpstreamClose(code) {
        this.upstreamReady = false
        this._viewerNegotiationRequested = false
        this._stopKeepalive()
        this.recordEvent('fanout_upstream_close', { udid: this.udid, code, clients: this.clients.size })
        // 2.14.18: ALWAYS schedule reconnect when clients are attached.
        // Previous logic (2.14.3) excluded 4005/4010/4011 thinking they
        // were storm triggers — but those storms were a SEPARATE bug
        // (buildSpawnCommand had `&;` syntax error + set -e + bad pgrep)
        // that's fixed in 2.14.7+. The exclusion now blocks legitimate
        // recovery: code 4011 = "scrcpy not listening" which is exactly
        // when we MUST reconnect so ws-scrcpy re-spawns it. Real-VA
        // test showed 360s+ without recovery after scrcpy died because
        // we dropped upstream and waited for a new addClient that
        // never came.
        //
        // Backoff is exponential (handled in _scheduleReconnect) so we
        // don't busy-loop if scrcpy truly can't bind.
        if (this.clients.size > 0) {
            // 2.14.20: do NOT broadcast iframe_reload_hint — ws-scrcpy
            // browser client auto-reconnects WS on close. Reload hints
            // caused reload-loops (Anyro field-found).
            this._scheduleReconnect()
        } else {
            this.upstream = null
        }
    }

    _connect() {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
        try {
            if (this._sourceFactory) {
                const src = this._sourceFactory()
                this.upstream = src
                src.on('open', () => this._onUpstreamOpen())
                src.on('initial_info', (blob) => this._onUpstreamInitialInfo(blob))
                src.on('frame', (chunk) => this._onUpstreamMessage(chunk))
                src.on('device_message', (chunk) => this._onUpstreamDeviceMessage(chunk))
                src.on('close', (code) => this._onUpstreamClose(code || 1006))
                src.on('error', () => { /* logged via close path */ })
                src.open()
                return
            }
            // Existing WebSocket path — stays intact for backwards compat.
            this.upstream = new WebSocket(this.upstreamUrl, { perMessageDeflate: false })
        } catch (e) {
            this.recordEvent('fanout_upstream_err', { udid: this.udid, err: e?.message?.slice(0, 200), phase: 'construct' })
            this._scheduleReconnect()
            return
        }
        this.upstream.binaryType = 'arraybuffer'
        this.upstream.on('open', () => this._onUpstreamOpen())
        this.upstream.on('message', (data, isBinary) => {
            const buf = isBinary && data instanceof Buffer ? data : Buffer.from(data)
            this._onUpstreamMessage(buf)
        })
        this.upstream.on('close', (code) => this._onUpstreamClose(code))
        this.upstream.on('error', (e) => {
            this.recordEvent('fanout_upstream_err', { udid: this.udid, err: e?.message?.slice(0, 200), phase: 'runtime' })
        })
    }

    _scheduleReconnect() {
        if (this._reconnecting) return
        this._reconnecting = true
        // 2.14.18: exponential backoff 2s, 4s, 8s, 16s, capped at 30s.
        // Resets on successful open. Prevents busy-loop when scrcpy
        // truly can't bind (port hijacked, device offline, etc) while
        // still recovering FAST from transient blips.
        this._reconnectAttempts = (this._reconnectAttempts || 0) + 1
        const delayMs = Math.min(2000 * Math.pow(2, this._reconnectAttempts - 1), 30_000)
        this.recordEvent('fanout_reconnect_scheduled', { udid: this.udid, attempt: this._reconnectAttempts, delayMs })
        this._reconnectTimer = setTimeout(() => this._connect(), delayMs)
        if (this._reconnectTimer.unref) this._reconnectTimer.unref()
    }

    _startKeepalive() {
        this._stopKeepalive()
        this._keepaliveTimer = setInterval(() => {
            try {
                if (this.upstream && this.upstream.readyState === WebSocket.OPEN && typeof this.upstream.ping === 'function') {
                    this.upstream.ping()
                }
            } catch (_) { /* benign */ }
        }, UPSTREAM_KEEPALIVE_MS)
        if (this._keepaliveTimer.unref) this._keepaliveTimer.unref()
    }

    _stopKeepalive() {
        if (this._keepaliveTimer) { clearInterval(this._keepaliveTimer); this._keepaliveTimer = null }
    }

    // 2.14.16: stall watchdog. Runs every 10s. If clients are connected AND
    // a client has sent at least one control message (so we expect frames in
    // return) AND no upstream bytes in 30s → assume scrcpy crashed, force-
    // close the upstream so it gets re-created (which triggers ws-scrcpy to
    // re-spawn scrcpy via our RUN_COMMAND).
    _startStallWatchdog() {
        this._stopStallWatchdog()
        this._stallCheckTimer = setInterval(() => {
            try {
                if (this.clients.size === 0) return  // nobody watching, nothing to recover
                if (!this.upstreamReady) return  // upstream not even open yet
                const now = Date.now()
                // If we've received initialInfo, scrcpy is alive on the device.
                // After that, if no bytes for STALL_DETECT_MS, the chain died
                // (scrcpy crashed, adb forward broke, ws-scrcpy hiccup). Force
                // reconnect so the wizard re-spawns scrcpy via RUN_COMMAND.
                //
                // 2.14.18: relaxed — fires regardless of whether the client sent
                // control messages. VAs may just WATCH a tile without tapping;
                // upstream silence still means stream broken.
                const sinceLastByte = now - (this._lastByteAt || this._upstreamOpenAt || now)
                if (sinceLastByte > STALL_DETECT_MS) {
                    this.recordEvent('fanout_stall_detected', {
                        udid: this.udid,
                        sinceLastByteMs: sinceLastByte,
                        clients: this.clients.size,
                        cachedInitial: this.initialInfo !== null,
                    })
                    try { this.upstream?.close(1006, 'stall-detected') } catch (_) {}
                    // 2.14.20: suppressed reload hint — see _broadcastReloadHint note.
                    // Browser WS auto-reconnects, no full reload needed.
                }
            } catch (_) {}
        }, STALL_CHECK_INTERVAL_MS)
        if (this._stallCheckTimer.unref) this._stallCheckTimer.unref()
    }

    _stopStallWatchdog() {
        if (this._stallCheckTimer) { clearInterval(this._stallCheckTimer); this._stallCheckTimer = null }
    }

    _onUpstreamInitialInfo(blob) {
        const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
        if (this.initialInfo && !this.initialInfo.equals(buf)) {
            this.lastConfigFrame = null
            this.lastKeyframe = null
            this.haveKeyframe = false
        }
        this.initialInfo = buf
        this.recordEvent('fanout_initial_info_cached', { udid: this.udid, bytes: buf.length })
        for (const client of this.clients) {
            if (client.readyState !== WebSocket.OPEN) continue
            try { client.send(buf, { binary: true }) } catch (_) { /* dead client */ }
        }
    }

    _onUpstreamMessage(buf) {
        this._totalBytes = (this._totalBytes || 0) + buf.length
        this._messageCount = (this._messageCount || 0) + 1
        this._lastByteAt = Date.now()
        if (startsWithMagic(buf, MAGIC_MESSAGE)) {
            this._broadcastUpstream(buf)
            return
        }
        if (this.initialInfo === null && startsWithMagic(buf, MAGIC_INITIAL)) {
            this.initialInfo = buf
            this.recordEvent('fanout_initial_info_cached', { udid: this.udid, bytes: buf.length })
        } else {
            const nalTypes = h264NalTypes(buf)
            const hasConfig = nalTypes.has(7) || nalTypes.has(8)
            const hasIdr = nalTypes.has(5)
            if (hasConfig && !hasIdr) this.lastConfigFrame = buf
            if (hasIdr) {
                if (hasConfig) this.lastConfigFrame = null
                this.lastKeyframe = buf
                this.haveKeyframe = true
                this.recordEvent('fanout_keyframe_cached', {
                    udid: this.udid,
                    bytes: buf.length,
                    includesConfig: hasConfig,
                    msAfterOpen: Date.now() - (this._upstreamOpenAt || 0),
                })
            }
        }
        this._broadcastUpstream(buf)
    }

    _onUpstreamDeviceMessage(buf) {
        const packet = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
        this._totalBytes = (this._totalBytes || 0) + packet.length
        this._messageCount = (this._messageCount || 0) + 1
        this._lastByteAt = Date.now()
        this.recordEvent('fanout_device_message', { udid: this.udid, bytes: packet.length })
        this._broadcastUpstream(packet)
    }

    _broadcastUpstream(buf) {
        for (const c of this.clients) {
            if (c.readyState !== WebSocket.OPEN) continue
            try { c.send(buf, { binary: true }) } catch (_) { /* dead client */ }
        }
    }

    addClient(clientSocket, policy = {}) {
        const canControl = policy.canControl === true
        const canNegotiate = policy.canNegotiate === true
        const canRequestStream = policy.canRequestStream === true
        this.clients.add(clientSocket)
        this.clientPolicies.set(clientSocket, { canControl, canNegotiate, canRequestStream })
        // 2.14.2: promote the first client to primary. Only the primary's
        // control messages reach scrcpy.
        const becamePrimary = canControl && this.primaryClient === null
        if (becamePrimary) {
            this.primaryClient = clientSocket
            if (canNegotiate) this.negotiationClient = clientSocket
            this._dropPendingViewerNegotiation()
            this.recordEvent('fanout_primary_assigned', { udid: this.udid, clients: this.clients.size })
        }
        if (canControl && canNegotiate && this.negotiationClient === null) {
            this.negotiationClient = clientSocket
        }
        // If upstream isn't connected (closed earlier), reconnect.
        // FIX_SAFE: when _sourceFactory is used, this.upstream is a
        // ScrcpyDirectStreamSource (EventEmitter) with no readyState property,
        // so `readyState === WebSocket.CLOSED` always evaluates to
        // `undefined === 3` (false) — the guard never fires. Fall back to
        // !this.upstreamReady when readyState is unavailable; it is cleared
        // to false in _onUpstreamClose and only set true in _onUpstreamOpen.
        const upstreamDead = !this.upstream ||
            (typeof this.upstream.readyState !== 'undefined'
                ? this.upstream.readyState === WebSocket.CLOSED
                : !this.upstreamReady)
        if (upstreamDead) this._connect()
        // Forward control messages (SetVideoSettings, ChangeStreamParameters,
        // touch/key events) — but ONLY from the primary client. Secondary
        // clients' SetVideoSettings would conflict with the primary's
        // already-established encoder config and scrcpy.Server closes the
        // upstream with code 4010, blacking out everyone. The fan-out's
        // job is broadcast; control flow stays single-source.
        // Field-found from Nur's 2026-05-23 diagnostic bundle.
        clientSocket.on('message', (data, isBinary) => {
            if (clientSocket.readyState !== WebSocket.OPEN) return
            let kind = isVideoNegotiationMessage(data, isBinary) ? 'negotiation' : 'control'
            let outbound = data
            let outboundBinary = isBinary
            if (!this._clientCanForward(clientSocket, kind)) {
                const viewerMayRequest = kind === 'negotiation' &&
                    this.primaryClient === null &&
                    this.clientPolicies.get(clientSocket)?.canRequestStream === true &&
                    this.viewerNegotiationPacket !== null &&
                    !this._viewerNegotiationRequested
                if (!viewerMayRequest) return
                this._viewerNegotiationRequested = true
                kind = 'viewer-negotiation'
                outbound = this.viewerNegotiationPacket
                outboundBinary = true
            }
            const bytes = Array.isArray(outbound)
                ? outbound.reduce((sum, chunk) => sum + (chunk?.byteLength || chunk?.length || 0), 0)
                : Buffer.isBuffer(outbound) || typeof outbound === 'string'
                    ? Buffer.byteLength(outbound)
                    : outbound?.byteLength || outbound?.length || 0
            if (bytes > MAX_CONTROL_MESSAGE_BYTES) {
                this.recordEvent('fanout_control_dropped', { udid: this.udid, bytes, reason: 'message_too_large' })
                return
            }
            // 2.14.16: track that a client has asked for frames so the stall
            // watchdog knows it's reasonable to expect bytes back from upstream.
            this._lastClientControlAt = Date.now()
            if (this.upstream && this.upstreamReady) {
                try { this.upstream.send(outbound, { binary: outboundBinary }) } catch (_) {}
            } else {
                // 2.14.1: queue for flush on upstream open. Bounded so a
                // misbehaving client can't push us OOM if upstream stays
                // down — drop the oldest beyond 64 messages.
                while (this.pendingUpstream.length > 0 &&
                    (this.pendingUpstream.length >= 64 || this.pendingUpstreamBytes + bytes > MAX_PENDING_UPSTREAM_BYTES)) {
                    const dropped = this.pendingUpstream.shift()
                    this.pendingUpstreamBytes = Math.max(0, this.pendingUpstreamBytes - dropped.bytes)
                }
                this.pendingUpstream.push({ data: outbound, isBinary: outboundBinary, bytes, client: clientSocket, kind })
                this.pendingUpstreamBytes += bytes
            }
        })
        // Replay cached state so the new client has a decodable starting
        // point. Order matters: initial info first, then keyframe.
        if (this.initialInfo) {
            try { clientSocket.send(this.initialInfo, { binary: true }) } catch (_) {}
        }
        if (this.lastConfigFrame) {
            try { clientSocket.send(this.lastConfigFrame, { binary: true }) } catch (_) {}
        }
        if (this.lastKeyframe) {
            try { clientSocket.send(this.lastKeyframe, { binary: true }) } catch (_) {}
        }
        clientSocket.on('close', () => this.removeClient(clientSocket))
        clientSocket.on('error', () => this.removeClient(clientSocket))
        this.recordEvent('fanout_client_added', { udid: this.udid, clients: this.clients.size })
    }

    _clientCanForward(client, kind) {
        if (!this.clients.has(client)) return false
        const policy = this.clientPolicies.get(client)
        if (kind === 'viewer-negotiation') {
            return this.primaryClient === null && policy?.canRequestStream === true
        }
        if (kind === 'negotiation') {
            return client === this.negotiationClient && policy?.canNegotiate === true
        }
        return client === this.primaryClient && policy?.canControl === true
    }

    _dropPendingViewerNegotiation() {
        this.pendingUpstream = this.pendingUpstream.filter(item => item.kind !== 'viewer-negotiation')
        this.pendingUpstreamBytes = this.pendingUpstream.reduce((sum, item) => sum + item.bytes, 0)
        this._viewerNegotiationRequested = false
    }

    removeClient(clientSocket) {
        if (!this.clients.has(clientSocket)) return
        this.clients.delete(clientSocket)
        this.clientPolicies.delete(clientSocket)
        const retained = []
        let retainedBytes = 0
        for (const pending of this.pendingUpstream) {
            if (pending.client === clientSocket) continue
            retained.push(pending)
            retainedBytes += pending.bytes
        }
        this.pendingUpstream = retained
        this.pendingUpstreamBytes = retainedBytes
        // 2.14.2: promote next client to primary if the primary just left.
        // Without this, control would die with the primary's tab close
        // even though other browsers are still attached.
        if (clientSocket === this.primaryClient) {
            this.primaryClient = Array.from(this.clients)
                .find(client => this.clientPolicies.get(client)?.canControl) || null
            this.negotiationClient = this.primaryClient && this.clientPolicies.get(this.primaryClient)?.canNegotiate
                ? this.primaryClient
                : null
            this.recordEvent('fanout_primary_promoted', {
                udid: this.udid,
                hasPrimary: this.primaryClient !== null,
                clients: this.clients.size,
            })
        } else if (clientSocket === this.negotiationClient) {
            this.negotiationClient = Array.from(this.clients)
                .find(client => this.clientPolicies.get(client)?.canControl && this.clientPolicies.get(client)?.canNegotiate) || null
        }
        this.recordEvent('fanout_client_removed', { udid: this.udid, clients: this.clients.size })
        // Keep upstream alive even with no clients. cleanup=false on the
        // device means scrcpy stays bound, and holding the upstream open
        // means the next client gets fast replay without reconnect lag.
    }

    snapshot() {
        return {
            udid: this.udid,
            upstreamReady: this.upstreamReady,
            upstreamUrl: this.upstreamUrl,
            upstreamOpenAt: this._upstreamOpenAt || null,
            clients: this.clients.size,
            primaryClientAttached: this.primaryClient !== null,
            cachedInitialInfo: this.initialInfo !== null,
            initialInfoBytes: this.initialInfo ? this.initialInfo.length : 0,
            cachedConfigFrame: this.lastConfigFrame !== null,
            configFrameBytes: this.lastConfigFrame ? this.lastConfigFrame.length : 0,
            cachedKeyframe: this.lastKeyframe !== null,
            lastKeyframeBytes: this.lastKeyframe ? this.lastKeyframe.length : 0,
            totalBytesFromUpstream: this._totalBytes || 0,
            messageCountFromUpstream: this._messageCount || 0,
            lastByteAt: this._lastByteAt || null,
            pendingUpstreamQueue: this.pendingUpstream.length,
            pendingUpstreamBytes: this.pendingUpstreamBytes,
        }
    }

    close() {
        this._stopKeepalive()
        this._stopStallWatchdog()
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
        for (const c of this.clients) {
            try { c.close(1000, 'fanout shutdown') } catch (_) {}
        }
        this.clients.clear()
        this.clientPolicies.clear()
        this.primaryClient = null
        this.negotiationClient = null
        this.pendingUpstream = []
        this.pendingUpstreamBytes = 0
        this._viewerNegotiationRequested = false
        try { this.upstream?.close() } catch (_) {}
        this.upstream = null
    }
}

// Per-process registry — one FanOut per udid.
const fanouts = new Map()
const fanoutRetains = new Map()
function getFanOut(udid, upstreamUrl, opts) {
    const existing = fanouts.get(udid)
    // 2.14.21: portal stop/start rotates the ws-scrcpy upstreamPort.
    // The module-level registry survives module re-init, so a cached
    // FanOut would keep trying to reach a dead upstream port forever
    // (clients attach, upstreamReady stays false, no bytes flow). If the
    // caller hands us a different upstreamUrl than the cached fan-out
    // was built with, the old upstream is gone — tear it down and build
    // a fresh one pointed at the live port.
    if (existing && upstreamUrl && existing.upstreamUrl !== upstreamUrl && !fanoutRetains.has(udid)) {
        try { existing.close() } catch (_) {}
        fanouts.delete(udid)
    }
    if (!fanouts.has(udid)) {
        fanouts.set(udid, new FanOut(udid, upstreamUrl, opts))
    }
    return fanouts.get(udid)
}
function getExistingFanOut(udid) {
    return fanouts.get(udid) || null
}
function retainFanOut(udid, expectedFanOut = null) {
    const current = fanouts.get(udid)
    if (!current || (expectedFanOut && current !== expectedFanOut)) return false
    fanoutRetains.set(udid, (fanoutRetains.get(udid) || 0) + 1)
    return true
}
function releaseFanOut(udid, expectedFanOut = null) {
    const current = fanouts.get(udid)
    if (!current || (expectedFanOut && current !== expectedFanOut)) return false
    const retainCount = fanoutRetains.get(udid) || 0
    if (retainCount > 1) {
        fanoutRetains.set(udid, retainCount - 1)
        return false
    }
    fanoutRetains.delete(udid)
    try { current.close() } catch (_) {}
    fanouts.delete(udid)
    return true
}
function _resetForTests() {
    for (const f of fanouts.values()) { try { f.close() } catch (_) {} }
    fanouts.clear()
    fanoutRetains.clear()
}

module.exports = {
    FanOut,
    getFanOut,
    getExistingFanOut,
    retainFanOut,
    releaseFanOut,
    _resetForTests,
    MAX_CONTROL_MESSAGE_BYTES,
    MAX_PENDING_UPSTREAM_BYTES,
}
