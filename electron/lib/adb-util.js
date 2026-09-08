const { execFile, spawn, spawnSync } = require('node:child_process')

const DEFAULT_MAX_CONCURRENT = 8
const DEFAULT_MAX_QUEUE = 64
// Sync commands get their own small lane instead of sharing the async ceiling.
// spawnSync blocks the JS thread, so sync calls can never overlap themselves —
// but a busy fleet keeps the async lane pinned at maxConcurrent, and rejecting
// sync callers here starved them permanently (create-IG preflight died with
// "ADB process capacity is full (8 active)" whenever heartbeats were busy).
// Worst-case total adb processes = maxConcurrent + SYNC_LANE_LIMIT.
const SYNC_LANE_LIMIT = 2
const DEFAULT_TIMEOUT_THRESHOLD = 3
const DEFAULT_TIMEOUT_WINDOW_MS = 30_000
const DEFAULT_COOLDOWN_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
// A local module driving a phone (detect_accounts and friends) runs adb through
// spawnSync, which BLOCKS the Electron main thread for seconds at a time. Every
// pending timer — including our own per-command deadlines — then fires long
// after its wall-clock deadline, in the timers phase, BEFORE the poll phase can
// deliver the 'close' of an adb child that already exited cleanly. Counting
// those as real timeouts is what opened the circuit breaker during a Create,
// and opening it auto-reaped the adb processes a live mirror depends on. When a
// deadline fires this much later than it was scheduled for, the loop was
// starved, not adb — grant ONE grace window so 'close' can land first.
const DEFAULT_LOOP_STALL_GRACE_MS = 1_000

function createResult({ code = null, stdout = '', stderr = '', error = null, timedOut = false }) {
  return {
    code,
    stdout: String(stdout || ''),
    stderr: String(stderr || ''),
    error: error ? String(error) : null,
    ...(timedOut ? { timedOut: true } : {}),
  }
}

class AdbProcessManager {
  constructor({
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    maxQueue = DEFAULT_MAX_QUEUE,
    timeoutThreshold = DEFAULT_TIMEOUT_THRESHOLD,
    timeoutWindowMs = DEFAULT_TIMEOUT_WINDOW_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    loopStallGraceMs = DEFAULT_LOOP_STALL_GRACE_MS,
    now = () => Date.now(),
    onCircuitOpen = null,
    recover = null,
  } = {}) {
    this.spawnImpl = spawnImpl
    this.spawnSyncImpl = spawnSyncImpl
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || DEFAULT_MAX_CONCURRENT)
    this.maxQueue = Math.max(0, Number(maxQueue) || 0)
    this.timeoutThreshold = Math.max(1, Number(timeoutThreshold) || DEFAULT_TIMEOUT_THRESHOLD)
    this.timeoutWindowMs = Math.max(1, Number(timeoutWindowMs) || DEFAULT_TIMEOUT_WINDOW_MS)
    this.cooldownMs = Math.max(1, Number(cooldownMs) || DEFAULT_COOLDOWN_MS)
    this.maxOutputBytes = Math.max(1024, Number(maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES)
    this.loopStallGraceMs = Math.max(1, Number(loopStallGraceMs) || DEFAULT_LOOP_STALL_GRACE_MS)
    this.now = now
    this.onCircuitOpen = typeof onCircuitOpen === 'function' ? onCircuitOpen : null
    this.recover = typeof recover === 'function' ? recover : null
    this.recoveryPromise = null
    this.active = new Map()
    this.syncActive = 0
    this.queue = []
    this.timeoutEvents = []
    this.circuitUntil = 0
    this.closed = false
    this.counters = { spawned: 0, rejected: 0, timedOut: 0, peakActive: 0 }
  }

  stats() {
    return {
      active: this.active.size + this.syncActive,
      queued: this.queue.length,
      circuitOpen: this._circuitOpen(),
      // How long new adb work stays refused. Callers that must not report an
      // infrastructure cooldown as a phone/Instagram failure (the create-IG
      // capacity probe) wait this out instead of burning a fixed backoff that
      // is shorter than the cooldown.
      cooldownRemainingMs: Math.max(0, this.circuitUntil - this.now()),
      spawned: this.counters.spawned,
      rejected: this.counters.rejected,
      timedOut: this.counters.timedOut,
      peakActive: this.counters.peakActive,
    }
  }

  run(adbPath, args, timeoutMs = 15_000, options = {}) {
    if (timeoutMs && typeof timeoutMs === 'object') {
      options = timeoutMs
      timeoutMs = options.timeoutMs || 15_000
    }
    const commandArgs = Array.isArray(args) ? args.map(value => String(value)) : []
    const budget = Math.max(1, Number(timeoutMs) || 15_000)

    if (this.closed) {
      return Promise.resolve(createResult({ error: 'ADB process manager is shut down' }))
    }
    if (this._circuitOpen()) {
      this.counters.rejected += 1
      return Promise.resolve(createResult({ error: 'ADB circuit is open after repeated command timeouts' }))
    }

    return new Promise(resolve => {
      const task = {
        adbPath,
        args: commandArgs,
        timeoutMs: budget,
        options: options || {},
        resolve,
        settled: false,
        released: false,
        killRequested: false,
        stdout: '',
        stderr: '',
        outputBytes: 0,
        timer: null,
        abortHandler: null,
        child: null,
      }
      this._bindAbort(task)
      if (task.settled) return
      if (this.active.size < this.maxConcurrent) {
        this._launch(task)
      } else if (this.queue.length < this.maxQueue) {
        this.queue.push(task)
      } else {
        this.counters.rejected += 1
        this._settle(task, createResult({ error: `ADB queue is full (${this.maxQueue} waiting)` }))
      }
    })
  }

  runSync(adbPath, args, timeoutMs = 30_000, options = {}) {
    if (this.closed) return createResult({ error: 'ADB process manager is shut down' })
    if (this._circuitOpen()) {
      this.counters.rejected += 1
      return createResult({ error: 'ADB circuit is open after repeated command timeouts' })
    }
    if (this.syncActive >= SYNC_LANE_LIMIT) {
      this.counters.rejected += 1
      return createResult({ error: `ADB process capacity is full (${this.maxConcurrent} active)` })
    }

    const budget = Math.max(1, Number(timeoutMs) || 30_000)
    const outputLimit = Math.max(1024, Number(options.maxOutputBytes) || this.maxOutputBytes)
    this.syncActive += 1
    this.counters.spawned += 1
    this.counters.peakActive = Math.max(this.counters.peakActive, this.active.size + this.syncActive)
    try {
      const result = this.spawnSyncImpl(adbPath, Array.isArray(args) ? args.map(String) : [], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: options.encoding || 'utf8',
        timeout: budget,
        maxBuffer: outputLimit,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      })
      const timedOut = result?.error?.code === 'ETIMEDOUT'
      if (timedOut) {
        this.counters.timedOut += 1
        this._recordTimeout(adbPath)
      }
      return createResult({
        code: typeof result?.status === 'number' ? result.status : null,
        stdout: result?.stdout,
        stderr: result?.stderr,
        error: result?.error?.message || (result?.status == null && result?.signal
          ? `ADB exited with ${result.signal}`
          : null),
        timedOut,
      })
    } catch (error) {
      return createResult({ error: error?.message || error })
    } finally {
      this.syncActive -= 1
    }
  }

  shutdown() {
    if (this.closed) return
    this.closed = true
    this._rejectQueue('ADB process manager is shutting down')
    for (const task of this.active.values()) {
      if (task.timer) clearTimeout(task.timer)
      this._settle(task, createResult({ error: 'ADB process manager is shutting down' }))
      this._kill(task)
      try { task.child?.unref?.() } catch (_) {}
    }
  }

  _circuitOpen() {
    return this.now() < this.circuitUntil
  }

  _launch(task) {
    if (task.settled) return
    if (this.closed || this._circuitOpen()) {
      this.counters.rejected += 1
      this._settle(task, createResult({ error: this.closed
        ? 'ADB process manager is shut down'
        : 'ADB circuit is open after repeated command timeouts' }))
      return
    }

    let child
    try {
      child = this.spawnImpl(task.adbPath, task.args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: task.options.env ? { ...process.env, ...task.options.env } : process.env,
      })
    } catch (error) {
      this._settle(task, createResult({ error: error?.message || error }))
      this._drain()
      return
    }

    task.child = child
    this.active.set(child, task)
    this.counters.spawned += 1
    this.counters.peakActive = Math.max(this.counters.peakActive, this.active.size)

    const append = (field, chunk) => {
      if (task.settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ''))
      task.outputBytes += bytes
      const outputLimit = Math.max(1024, Number(task.options.maxOutputBytes) || this.maxOutputBytes)
      if (task.outputBytes > outputLimit) {
        this._settle(task, createResult({
          stdout: task.stdout,
          stderr: task.stderr,
          error: `ADB output exceeded ${outputLimit} bytes`,
        }))
        this._kill(task)
        return
      }
      if (field === 'stdout' && typeof task.options.onStdoutChunk === 'function') {
        try {
          task.options.onStdoutChunk(chunk)
        } catch (error) {
          this._settle(task, createResult({
            stdout: task.stdout,
            stderr: task.stderr,
            error: error?.message || error,
          }))
          this._kill(task)
          return
        }
      }
      if (field === 'stdout' && task.options.captureStdout === false) return
      task[field] += String(chunk || '')
    }
    child.stdout?.on('data', chunk => append('stdout', chunk))
    child.stderr?.on('data', chunk => append('stderr', chunk))

    child.once('error', error => {
      this._settle(task, createResult({
        stdout: task.stdout,
        stderr: task.stderr,
        error: error?.message || error,
      }))
      this._release(task)
    })
    child.once('close', (code, signal) => {
      this._settle(task, createResult({
        code: typeof code === 'number' ? code : null,
        stdout: task.stdout,
        stderr: task.stderr,
        error: typeof code === 'number' ? null : `ADB exited with ${signal ?? 'unknown status'}`,
      }))
      this._release(task)
    })

    task.deadlineAt = this.now() + task.timeoutMs
    task.timer = setTimeout(() => this._timeout(task), task.timeoutMs)
    if (task.settled) clearTimeout(task.timer)
    try { task.options.onProcessStart?.(child) } catch (_) {}
  }

  _timeout(task) {
    if (task.released || task.settled) return
    // Event-loop starvation guard (see DEFAULT_LOOP_STALL_GRACE_MS): this timer
    // firing far past its own deadline means the JS thread was blocked, so the
    // adb child may already have exited with its 'close' still queued in the
    // poll phase. Re-arm ONCE and let it land — a starved loop must never be
    // charged to the circuit breaker, whose recovery hook kills adb processes.
    const lateBy = this.now() - (task.deadlineAt || 0)
    if (!task.stallGraceUsed && lateBy > this.loopStallGraceMs) {
      task.stallGraceUsed = true
      task.deadlineAt = this.now() + this.loopStallGraceMs
      task.timer = setTimeout(() => this._timeout(task), this.loopStallGraceMs)
      return
    }
    this.counters.timedOut += 1
    this._settle(task, createResult({
      stdout: task.stdout,
      stderr: task.stderr,
      error: `ADB command timed out after ${task.timeoutMs}ms`,
      timedOut: true,
    }))
    this._recordTimeout(task.adbPath)
    this._kill(task)

    if (this._circuitOpen()) {
      this._rejectQueue('ADB circuit is open after repeated command timeouts')
      for (const activeTask of this.active.values()) {
        this._settle(activeTask, createResult({ error: 'ADB circuit opened; command cancelled' }))
        this._kill(activeTask)
      }
    }
  }

  _recordTimeout(adbPath) {
    const now = this.now()
    this.timeoutEvents = this.timeoutEvents.filter(at => now - at <= this.timeoutWindowMs)
    this.timeoutEvents.push(now)
    if (this.timeoutEvents.length < this.timeoutThreshold) return
    const wasOpen = this._circuitOpen()
    this.circuitUntil = Math.max(this.circuitUntil, now + this.cooldownMs)
    if (!wasOpen) {
      console.warn(`[ADB Guard] Circuit opened after ${this.timeoutEvents.length} timeouts; pausing new commands for ${this.cooldownMs}ms`)
      try { this.onCircuitOpen?.(this.stats()) } catch (_) {}
      if (this.recover && !this.recoveryPromise) {
        this.recoveryPromise = Promise.resolve()
          .then(() => this.recover(adbPath))
          .then(result => {
            if (result?.killed > 0) {
              console.warn(`[ADB Guard] Runtime recovery reaped ${result.killed} bundled adb process${result.killed === 1 ? '' : 'es'}`)
            }
          })
          .catch(error => console.warn('[ADB Guard] Runtime recovery failed:', error?.message || error))
          .finally(() => { this.recoveryPromise = null })
      }
    }
  }

  _kill(task) {
    if (!task.child || task.killRequested) return
    task.killRequested = true
    try { task.child.stdout?.destroy?.() } catch (_) {}
    try { task.child.stderr?.destroy?.() } catch (_) {}
    try { task.child.kill('SIGKILL') } catch (_) {}
  }

  _settle(task, result) {
    if (task.settled) return
    task.settled = true
    this._detachAbort(task)
    task.resolve(result)
  }

  _release(task) {
    if (task.released) return
    task.released = true
    if (task.timer) clearTimeout(task.timer)
    if (task.abortHandler && task.options.signal) {
      this._detachAbort(task)
    }
    if (task.child) this.active.delete(task.child)
    try { task.options.onProcessClose?.(task.child) } catch (_) {}
    this._drain()
  }

  _bindAbort(task) {
    const signal = task.options.signal
    if (!signal || typeof signal.addEventListener !== 'function') return
    task.abortHandler = () => {
      if (!task.child) {
        const index = this.queue.indexOf(task)
        if (index >= 0) this.queue.splice(index, 1)
      }
      this._settle(task, createResult({
        stdout: task.stdout,
        stderr: task.stderr,
        error: 'ADB command aborted',
      }))
      this._kill(task)
    }
    if (signal.aborted) task.abortHandler()
    else signal.addEventListener('abort', task.abortHandler, { once: true })
  }

  _detachAbort(task) {
    if (!task.abortHandler || !task.options.signal) return
    try { task.options.signal.removeEventListener('abort', task.abortHandler) } catch (_) {}
    task.abortHandler = null
  }

  _rejectQueue(message) {
    const queued = this.queue.splice(0)
    for (const task of queued) {
      this.counters.rejected += 1
      this._settle(task, createResult({ error: message }))
    }
  }

  _drain() {
    if (this.closed) return
    if (this._circuitOpen()) {
      this._rejectQueue('ADB circuit is open after repeated command timeouts')
      return
    }
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const task = this.queue.shift()
      if (!task.settled) this._launch(task)
    }
  }
}

function createAdbProcessManager(options) {
  return new AdbProcessManager(options)
}

const defaultManager = createAdbProcessManager({
  // Runtime recovery runs while mirrors are LIVE and a paid create may be
  // in flight, so it must never touch the adb server or a mirror's own adb
  // child (includeServer stays false — see reapStaleAdbProcesses).
  recover: adbPath => reapStaleAdbProcesses(adbPath, { includeServer: false }),
})

function runAdb(adbPath, args, timeoutMs = 15_000, options = {}) {
  return defaultManager.run(adbPath, args, timeoutMs, options)
}

function runAdbSync(adbPath, args, timeoutMs = 30_000, options = {}) {
  return defaultManager.runSync(adbPath, args, timeoutMs, options)
}

function getAdbProcessStats() {
  return defaultManager.stats()
}

function shutdownAdbProcesses() {
  defaultManager.shutdown()
}

// ── Which bundled adb clients are safe to force-kill ─────────────────────────
// INCIDENT (2026-07-25, v3.6.8): the mirror died 18s into every Create with
// `WARN: Device disconnected` + exit code 2 and no USB removal event. Cause: the
// circuit breaker's `recover` hook is this reaper, and it matched adb.exe by
// IMAGE PATH only — so opening the circuit force-killed
//   (a) the app's own adb SERVER (`adb -L tcp:5137 fork-server server`), whose
//       death tears the transport out from under EVERY live scrcpy mirror, and
//   (b) that mirror's own on-device server shell
//       (`adb -s SERIAL shell CLASSPATH=…/scrcpy-server.jar …`) — the exact
//       "kills a healthy mirror with exit code 2" case lib/scrcpy-orphan-killer.js
//       was already taught to spare.
// Both are now unconditionally spared. What remains reapable is what this reaper
// was written for: genuinely stray/wedged one-shot clients piling up on the host.
function _isAdbServerCommand(command) {
  return /(?:^|\s)(?:fork-server|start-server)(?:\s|$)|(?:^|\s)server(?:\s|$)/i.test(String(command || ''))
}

function _isScrcpyMirrorCommand(command) {
  return /scrcpy-server\.jar/i.test(String(command || ''))
}

function _selectReapableAdbPids({ candidates = [], includeServer = false } = {}) {
  const pids = []
  for (const candidate of candidates || []) {
    const pid = Number(candidate && candidate.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const command = String((candidate && candidate.command) || '')
    if (_isScrcpyMirrorCommand(command)) continue
    if (!includeServer && _isAdbServerCommand(command)) continue
    pids.push(pid)
  }
  return pids
}

function _parseProcessLines(stdout) {
  const rows = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), command: match[2].trim() })
  }
  return rows
}

/**
 * @param {string} adbPath bundled adb binary — only processes running THIS image are considered
 * @param {object} [options]
 * @param {boolean} [options.includeServer=false] also reap the adb server itself.
 *   Startup passes true (nothing is mirroring yet, and a stale server from a dead
 *   session should go). The runtime circuit-breaker recovery must NEVER pass it.
 */
function reapStaleAdbProcesses(adbPath, {
  platform = process.platform,
  execFileImpl = execFile,
  killImpl = process.kill.bind(process),
  includeServer = false,
} = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    return Promise.resolve({ supported: false, killed: 0, error: null })
  }
  if (!adbPath) {
    return Promise.resolve({ supported: true, killed: 0, error: 'ADB path unavailable' })
  }

  const killSelected = (candidates) => {
    let killed = 0
    for (const pid of _selectReapableAdbPids({ candidates, includeServer })) {
      try {
        killImpl(pid, 'SIGKILL')
        killed += 1
      } catch (_) {}
    }
    return killed
  }

  if (platform !== 'win32') {
    return new Promise(resolve => {
      const finish = (error, stdout) => {
        if (error) {
          resolve({ supported: true, killed: 0, error: String(error.message || error) })
          return
        }
        const target = String(adbPath)
        const candidates = _parseProcessLines(stdout).filter(
          row => row.command === target || row.command.startsWith(`${target} `),
        )
        resolve({ supported: true, killed: killSelected(candidates), error: null })
      }
      try {
        execFileImpl('ps', ['-axo', 'pid=,command='], {
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        }, finish)
      } catch (error) {
        finish(error, '')
      }
    })
  }

  // Win32: ONE hidden PowerShell process enumerates candidates (Get-CimInstance
  // so the command line is visible — Get-Process cannot see it, which is why the
  // server and the mirror's child were indistinguishable before). The selection
  // and the killing stay in JS so both are unit-testable without a process table.
  const script = [
    '$target=[System.IO.Path]::GetFullPath($targetPath)',
    'Get-CimInstance Win32_Process -Filter "Name=\'adb.exe\'" -ErrorAction SilentlyContinue'
      + ' | ForEach-Object { try { if ($_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target))'
      + ' { [Console]::Out.WriteLine("$($_.ProcessId) $($_.CommandLine)") } } catch {} }',
  ].join('; ')

  return new Promise(resolve => {
    const finish = (error, stdout) => {
      if (error) {
        resolve({ supported: true, killed: 0, error: String(error.message || error) })
        return
      }
      resolve({ supported: true, killed: killSelected(_parseProcessLines(stdout)), error: null })
    }
    try {
      execFileImpl('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& { param($targetPath) ' + script + ' }',
        adbPath,
      ], {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      }, finish)
    } catch (error) {
      finish(error, '')
    }
  })
}

module.exports = {
  runAdb,
  runAdbSync,
  createAdbProcessManager,
  getAdbProcessStats,
  shutdownAdbProcesses,
  reapStaleAdbProcesses,
  _selectReapableAdbPids,
}
