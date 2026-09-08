// electron/lib/device-health.js
// Per-device health state machine. Owns ALL recovery decisions
// (force-respawn, iframe-reload broadcasts). Every other layer
// REPORTS signals here; nothing else takes recovery action.

const STATES = Object.freeze({
    UNKNOWN:    'unknown',
    HEALTHY:    'healthy',
    DEGRADED:   'degraded',
    DEAD:       'dead',
    RECOVERING: 'recovering',
})

const SIGNALS = Object.freeze({
    FRAME_BYTES:     'frame_bytes',
    CLIENT_OPEN:     'client_open',
    CLIENT_CLOSE:    'client_close',
    IFRAME_PROGRESS: 'iframe_progress',
    DEVICE_PROBE:    'device_probe',
    RESPAWN_DONE:    'respawn_done',
})

const RESPAWN_COOLDOWN_MS = 60_000
const IFRAME_RELOAD_COOLDOWN_MS = 30_000
const STALE_FRAME_MS = 10_000

class DeviceHealthMachine {
    constructor(serial, opts = {}) {
        this.serial = serial
        this.adbPath = opts.adbPath || null
        this.recordEvent = opts.recordEvent || (() => {})
        this.broadcast = opts.broadcast || (() => {})
        this.state = STATES.UNKNOWN
        this.lastFrameAt = 0
        this.lastRespawnAt = 0
        this.lastIframeReloadAt = 0
        this.totalBytes = 0
        this.activeClients = 0
        this._probeTimer = null
        this._forceRespawnImpl = null
        this._consecutiveMisses = 0
        this._evicted = false
        if (!opts.skipProbeTimer && this.adbPath) {
            this._forceRespawnImpl = this._defaultForceRespawn.bind(this)
            this._scheduleProbe()
        }
    }

    onSignal(kind, payload) {
        switch (kind) {
            case SIGNALS.FRAME_BYTES: {
                this.totalBytes += payload.bytes || 0
                if (payload.bytes > 0 && payload.direction === 'device→browser') {
                    this.lastFrameAt = Date.now()
                    this._transition(STATES.HEALTHY)
                }
                break
            }
            case SIGNALS.CLIENT_OPEN: {
                this.activeClients += 1
                break
            }
            case SIGNALS.CLIENT_CLOSE: {
                this.activeClients = Math.max(0, this.activeClients - 1)
                if (payload.bytes === 0 && payload.aliveMs < 1000) {
                    this._considerDegraded('relay_fast_close')
                }
                break
            }
            case SIGNALS.IFRAME_PROGRESS: {
                if (payload.width > 0 && payload.ct > 0) this.lastFrameAt = Date.now()
                break
            }
            case SIGNALS.DEVICE_PROBE: {
                this._handleProbe(payload)
                break
            }
            case SIGNALS.RESPAWN_DONE: {
                this._transition(payload.bindstate === 'ok' ? STATES.DEGRADED : STATES.DEAD)
                break
            }
        }
    }

    _considerDegraded(reason) {
        const sinceFrame = Date.now() - this.lastFrameAt
        if (this.state === STATES.HEALTHY && sinceFrame > STALE_FRAME_MS) {
            this._transition(STATES.DEGRADED)
            this.recordEvent('health_degraded', { serial: this.serial, reason, sinceFrame })
            const sinceReload = Date.now() - this.lastIframeReloadAt
            if (sinceReload > IFRAME_RELOAD_COOLDOWN_MS) {
                this.lastIframeReloadAt = Date.now()
                this.broadcast('iframe_reload_hint', { serial: this.serial, reason })
            }
        }
    }

    async _handleProbe(probe) {
        if (!probe.alive || !probe.bound || !probe.build_id_match) {
            const sinceRespawn = Date.now() - this.lastRespawnAt
            if (sinceRespawn > RESPAWN_COOLDOWN_MS) {
                this.lastRespawnAt = Date.now()
                this._transition(STATES.RECOVERING)
                const reason = !probe.build_id_match ? 'stale_args' : (!probe.bound ? 'unbound' : 'dead')
                this.recordEvent('respawn_start', { serial: this.serial, reason })
                if (this._forceRespawnImpl) {
                    try { await this._forceRespawnImpl(reason) }
                    catch (e) { this.recordEvent('respawn_err', { serial: this.serial, err: e?.message?.slice(0, 200) }) }
                }
            } else {
                this.recordEvent('health_probe_cooldown', { serial: this.serial, sinceRespawn })
            }
        } else if (this.state === STATES.UNKNOWN || this.state === STATES.DEAD) {
            this._transition(STATES.DEGRADED)
        }
    }

    _scheduleProbe() {
        if (this._evicted) return
        if (this._probeTimer) clearTimeout(this._probeTimer)
        const interval = this.state === STATES.HEALTHY ? 60_000 : 15_000
        this._probeTimer = setTimeout(() => this._runProbe(), interval)
        if (this._probeTimer.unref) this._probeTimer.unref()
    }

    async _runProbe() {
        if (!this.adbPath) { this._scheduleProbe(); return }
        try {
            const { runAdb } = require('./adb-util')
            const { BUILD_ID } = require('./scrcpy-spawn')
            const cmd = [
                'cat /data/local/tmp/ws_scrcpy.pid 2>/dev/null',
                'echo --',
                'for p in $(pgrep -f scrcpy.Server 2>/dev/null); do echo "$p $(tr \\\\0 \\\\  </proc/$p/cmdline 2>/dev/null)"; done',
                'echo --',
                'awk "$2 ~ /:22B6$/" /proc/net/tcp /proc/net/tcp6 2>/dev/null',
            ].join('; ')
            const r = await runAdb(this.adbPath, ['-s', this.serial, 'shell', cmd], 5000)
            // runAdb never throws — a vanished serial (rotated tailnet port,
            // unplugged USB) surfaces as a non-zero code + a tell-tale stderr.
            // A rotated ip:port never answers at the old address again, so
            // stop probing it for good after a few consecutive misses.
            if (this._isMissingDevice(r)) {
                this._consecutiveMisses += 1
                if (this._consecutiveMisses >= 3) {
                    this.recordEvent('health_evicted', { serial: this.serial, reason: 'device_missing' })
                    removeMachine(this.serial)
                    return
                }
            } else {
                this._consecutiveMisses = 0
                const probe = this._parseProbeOutput(r.stdout || '', BUILD_ID)
                this.onSignal(SIGNALS.DEVICE_PROBE, probe)
            }
        } catch (e) {
            this.recordEvent('health_probe_err', { serial: this.serial, err: e?.message?.slice(0, 200) })
        } finally {
            if (!this._evicted) this._scheduleProbe()
        }
    }

    _isMissingDevice(r) {
        if (!r || r.code === 0) return false
        const s = `${r.stderr || ''} ${r.error || ''}`.toLowerCase()
        return s.includes('not found') || s.includes('offline') ||
            s.includes('closed') || s.includes('no devices') ||
            s.includes('cannot connect') || s.includes('device unauthorized')
    }

    _parseProbeOutput(stdout, expectedBuildId) {
        const sections = String(stdout || '').split('--')
        const pid = (sections[0] || '').trim()
        const cmdline = (sections[1] || '').trim()
        const tcpEntries = (sections[2] || '').trim()
        const alive = Boolean(pid && cmdline.includes('com.genymobile.scrcpy.Server'))
        const bound = /:22B6\s+\S+\s+0A/.test(tcpEntries)
        const build_id_match = cmdline.includes(`sp_build=${expectedBuildId}`)
        return { pid, alive, bound, build_id_match, cmdline }
    }

    async _defaultForceRespawn(reason) {
        const { runAdb } = require('./adb-util')
        const { buildSpawnCommand } = require('./scrcpy-spawn')
        const cmd = buildSpawnCommand()
        const launch = await runAdb(this.adbPath, ['-s', this.serial, 'shell', cmd], 15_000)
        if (launch.code !== 0) {
            throw new Error(launch.error || launch.stderr || 'scrcpy respawn command failed')
        }
        await new Promise(r => setTimeout(r, 4500))
        const r = await runAdb(this.adbPath, ['-s', this.serial, 'shell',
            'awk "$2 ~ /:22B6$/ && $4 == \\"0A\\"" /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l'
        ], 5000)
        const bound = parseInt(String(r.stdout || '').trim(), 10) > 0
        this.onSignal(SIGNALS.RESPAWN_DONE, { bindstate: bound ? 'ok' : 'err' })
    }

    _transition(next) {
        if (this.state === next) return
        const prev = this.state
        this.state = next
        this.recordEvent('health_transition', { serial: this.serial, prev, next })
        this.broadcast('health_state', { serial: this.serial, state: next })
        if (this._probeTimer) this._scheduleProbe()
    }

    snapshot() {
        return {
            serial: this.serial,
            state: this.state,
            lastFrameAt: this.lastFrameAt,
            lastRespawnAt: this.lastRespawnAt,
            totalBytes: this.totalBytes,
            activeClients: this.activeClients,
        }
    }
}

const machines = new Map()
// liveSerials (optional Set/Array): when provided, sweeps ghost machines before
// returning — lets callers that already have the live device list drive cleanup
// without a separate sweepMachines() call.  Existing callers that omit it are
// unaffected.
function getMachine(serial, opts, liveSerials) {
    if (liveSerials != null) sweepMachines(liveSerials)
    if (!machines.has(serial)) machines.set(serial, new DeviceHealthMachine(serial, opts || {}))
    return machines.get(serial)
}

// Evict a machine whose serial has vanished from the fleet (rotated tailnet
// port, unplugged USB). Stops its probe timer so the instance can be GC'd —
// without this the Map grows unbounded across rotating tailnet serials.
function removeMachine(serial) {
    const m = machines.get(serial)
    if (m) {
        m._evicted = true
        if (m._probeTimer) { clearTimeout(m._probeTimer); m._probeTimer = null }
    }
    return machines.delete(serial)
}

// Proactive sweep: drop any machine whose serial is no longer in the live
// device set. More reliable than the reactive miss-counter because tailnet
// port rotation drops the old ip:port silently (no clean WS 'close').
function sweepMachines(liveSerials) {
    const live = liveSerials instanceof Set ? liveSerials : new Set(liveSerials || [])
    let removed = 0
    for (const serial of machines.keys()) {
        if (!live.has(serial)) { removeMachine(serial); removed += 1 }
    }
    return removed
}

function _resetForTests() {
    for (const serial of [...machines.keys()]) removeMachine(serial)
}

module.exports = { DeviceHealthMachine, STATES, SIGNALS, getMachine, removeMachine, sweepMachines, _resetForTests }
