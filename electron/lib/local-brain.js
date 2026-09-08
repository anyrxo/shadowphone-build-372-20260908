/**
 * Local Python brain orchestrator.
 *
 * Spawns electron/python/server.py as a subprocess bound to 127.0.0.1 so
 * module execution stays on the user's machine — no Railway round-trip
 * latency. The renderer's runModuleWs flow tries this local endpoint first
 * and falls back to the Railway WS if local startup fails.
 *
 * Security:
 *   - Brain binds 127.0.0.1 only (BIND_HOST env var). External traffic
 *     cannot reach it.
 *   - A fresh API secret (UUID) is generated on every app boot and passed
 *     to the brain via SHADOWPHONE_API_SECRET env var. The secret only
 *     lives in the spawned brain's environment + this module's memory.
 *   - Renderer reads the secret via getLocalBrainSecret() and sends it on
 *     the WS connect handshake.
 *
 * Deployment modes:
 *   - DEV (your machine): system Python 3.11+ on PATH. Spawns
 *     `python <repo>/electron/python/server.py`. No bundling required.
 *   - PRODUCTION (installer): PyInstaller binary at
 *     `<resources>/python-brain/server.exe` (or `server` on Mac). Path
 *     resolved via app.getAppPath() + extraResources.
 *
 * The chooser logic prefers the bundled binary; falls back to system Python
 * if it doesn't exist (so dev workflow keeps working).
 */

const { spawn, execFile } = require('child_process')
const net = require('net')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const BRAIN_HOST = '127.0.0.1'
const BRAIN_PORT = 8090

async function isBrainReadyResponse(response) {
    if (!response || response.status !== 200) return false
    try {
        const payload = await response.json()
        return payload?.ready === true
    } catch {
        return false
    }
}

// Cold-start budget. Python imports (httpx, pydantic, lib.ws_modules.*, the
// Supabase client, etc.) reliably take 8-20s on Windows even with PYC caches
// warm — and longer on first launch after an installer update. The original
// 25s ceiling tripped during a real Pixel 6 schedule run where the brain
// would have come up a few seconds later, so the schedule hard-failed with
// `LOCAL_BRAIN_UNAVAILABLE`. 45s matches the worst case we observe in practice
// while still preventing zombie hangs.
const BRAIN_STARTUP_DEADLINE_MS = 45_000

// Auto-respawn policy. If the brain exits unexpectedly (segfault, OOM,
// uncaught exception in a module handler), we silently restart it up to
// MAX_AUTO_RESPAWNS times per app session. Past that, the user has to hit
// the "Restart Brain" button — repeated crashes are almost always a config
// problem that a respawn can't fix.
const MAX_AUTO_RESPAWNS = 3
const RESPAWN_DEBOUNCE_MS = 4_000

let brainProcess = null
let brainSecret = null
let brainStartedAt = 0
let brainReady = false
let brainExitReason = null
let nextBrainLaunchId = 0
let currentBrainLaunchId = null
let brainOwnershipDescriptor = null
let brainShutdownRequested = false
let brainStopPromise = null
let brainTerminationPromise = null
let brainRestartPromise = null

// Auto-respawn bookkeeping.
let respawnAttempts = 0
let lastSpawnOptions = null   // captured on the first startLocalBrain() call so
                              // the exit handler can re-invoke without the
                              // caller having to thread options through.
let respawnTimer = null
let respawnInFlight = false

// Boot spawn-race latch. startLocalBrain() now awaits a bounded port-free
// wait (poll probeBrainPort() until 8090 is free) between the idempotency
// guard and the actual spawn(). That await opens a window where a second
// caller (eager-spawn IIFE + watchdog tick + restart, all firing near boot)
// could pass the `brainProcess` guard and double-spawn — two uvicorns racing
// the same port = the [Errno 10048] :8090 flapping. The latch holds the
// "spawn intent" synchronously across that await so only one spawn proceeds.
let spawnInProgress = false

// Watchdog state. The watchdog pings /health every WATCHDOG_INTERVAL_MS and
// auto-restarts the brain if it doesn't respond. WATCHDOG_HEAL_THRESHOLD
// consecutive healthy pings reset the respawn counter — without it the
// 3-respawn cap would permanently brick users who hit a transient crash
// loop (e.g. WiFi flap during Supabase import on first boot).
const WATCHDOG_INTERVAL_MS = 10_000
// Generous HTTP probe — antivirus on the loopback path (Windows Defender RT
// scan, MalwareBytes, ESET) can hold a localhost HTTP request for 3-5s on
// some user setups. The previous 2.5s budget was firing false-unhealthy on
// those machines and triggering the up/down flap operators reported.
const WATCHDOG_PROBE_TIMEOUT_MS = 5_000
const WATCHDOG_HEAL_THRESHOLD = 1
// A busy brain is NOT a dead brain. During a module run (engagement, posting,
// etc.) the brain's event loop is pinned by uiautomator screen dumps, scrolls
// and network calls, so an HTTP /health ping can time out for tens of seconds
// while the process is perfectly alive. Killing it here drops the in-flight
// automation WebSocket and the run hard-fails with close code 1006. The
// watchdog therefore only kills when the brain is GENUINELY gone — child
// process exited OR TCP port 8090 no longer accepting connections — and only
// after WATCHDOG_KILL_THRESHOLD consecutive such observations.
//
// 5 = 50s of sustained dead state before killing. Bumped from 3 (30s) after
// field reports of users seeing brain status flap between "online" and
// "down" — the brain was genuinely fine but a single slow tick was eating
// into the 3-cycle budget too aggressively.
const WATCHDOG_KILL_THRESHOLD = 5
// TCP connect probe budget for the port-bound liveness check. A bound-but-busy
// port still completes the TCP handshake near-instantly even when the HTTP
// layer is starved, so this stays moderately tight.
const WATCHDOG_PORT_PROBE_TIMEOUT_MS = 3_000

// brain.log noise control. The 10s watchdog hits `/` on the brain → uvicorn
// emits `INFO: 127.0.0.1:<port> - "GET / HTTP/1.1" 200 OK` on stdout → 2.11.8's
// blanket stdout capture wrote those into brain.log every 10s → file grew to
// hundreds of KB per session of useless lines that drowned out real errors.
// Skip those access-log lines on the way to disk; everything else still lands.
const UVICORN_HEALTH_PROBE_RE = /^INFO:\s+127\.0\.0\.1:\d+\s+-\s+"GET\s+\/\s+HTTP\/1\.1"\s+200\s+OK\s*$/
const BRAIN_LOG_MAX_BYTES = 512 * 1024  // truncate-and-restart at 512 KB

// Last-known orphan PIDs we couldn't kill (access denied — usually because
// they were spawned by an elevated parent and the current user-mode app can't
// touch them). Surfaced to the renderer via getBrainExitReason() so the user
// gets an actionable message instead of a generic auth-error toast.
let lastUnkillableOrphans = []

function normalizeIdentityPath(value) {
    if (typeof value !== 'string' || !value.trim()) return null
    const unquoted = value.trim().replace(/^"|"$/g, '')
    return /^[a-z]:[\\/]/i.test(unquoted) || unquoted.includes('\\')
        ? path.win32.normalize(unquoted).toLowerCase()
        : path.posix.normalize(unquoted)
}

function commandLineArguments(commandLine) {
    if (typeof commandLine !== 'string' || !commandLine.trim()) return []
    const args = []
    const token = /"([^"]*)"|'([^']*)'|(\S+)/g
    let match
    while ((match = token.exec(commandLine)) !== null) {
        args.push(match[1] ?? match[2] ?? match[3])
    }
    return args
}

function isOwnedBrainProcess(processInfo, descriptor) {
    if (!processInfo || !descriptor || !Number.isSafeInteger(Number(processInfo.pid)) || Number(processInfo.pid) <= 0) return false
    const executablePath = normalizeIdentityPath(processInfo.executablePath)
    const commandPaths = commandLineArguments(processInfo.commandLine).map(normalizeIdentityPath).filter(Boolean)
    if (!executablePath || commandPaths.length === 0) return false

    const frozenExecutablePaths = Array.isArray(descriptor.frozenExecutablePaths)
        ? descriptor.frozenExecutablePaths.map(normalizeIdentityPath).filter(Boolean)
        : []
    const sourceExecutablePaths = Array.isArray(descriptor.sourceExecutablePaths)
        ? descriptor.sourceExecutablePaths.map(normalizeIdentityPath).filter(Boolean)
        : []
    const sourceScriptPath = normalizeIdentityPath(descriptor.sourceScriptPath)

    if (frozenExecutablePaths.includes(executablePath)) return commandPaths.includes(executablePath)
    return !!sourceScriptPath && sourceExecutablePaths.includes(executablePath) && commandPaths.includes(sourceScriptPath)
}

function terminateOwnedProcessTree(pid, platform) {
    const numericPid = Number(pid)
    if (!Number.isSafeInteger(numericPid) || numericPid <= 0) {
        return Promise.resolve({ ok: false, error: 'Invalid process ID' })
    }
    if (platform !== 'win32') {
        try {
            process.kill(-numericPid, 'SIGTERM')
            return Promise.resolve({ ok: true })
        } catch (error) {
            if (error && error.code === 'ESRCH') return Promise.resolve({ ok: true })
            return Promise.resolve({ ok: false, error: String(error?.message || error || 'Process-group termination failed').slice(0, 512) })
        }
    }
    return new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(numericPid), '/T', '/F'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10_000,
        }, (error, _stdout, stderr) => {
            if (!error) return resolve({ ok: true })
            const message = String(stderr || error.message || error).trim().slice(0, 512)
            if (/not\s+found|no\s+running\s+instance|not\s+exist/i.test(message)) return resolve({ ok: true })
            resolve({ ok: false, error: message || 'Process-tree termination failed' })
        })
    })
}

function execFileResult(file, args, options = {}) {
    return new Promise((resolve) => {
        execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000, ...options }, (error, stdout, stderr) => {
            resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
        })
    })
}

async function readProcessIdentity(pid, platform) {
    try {
        if (platform === 'win32') {
            const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; if ($null -ne $p) { [pscustomobject]@{pid=[int]$p.ProcessId;executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine} | ConvertTo-Json -Compress }`
            const result = await execFileResult('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
            if (result.error || !result.stdout.trim()) return null
            const identity = JSON.parse(result.stdout.trim())
            return identity && identity.executablePath && identity.commandLine ? identity : null
        }
        if (platform === 'linux') {
            const executablePath = await fs.promises.readlink(`/proc/${pid}/exe`)
            const commandLine = (await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean).map((arg) => JSON.stringify(arg)).join(' ')
            return executablePath && commandLine ? { pid, executablePath, commandLine } : null
        }
        const executable = await execFileResult('ps', ['-p', String(pid), '-o', 'comm='])
        const command = await execFileResult('ps', ['-p', String(pid), '-o', 'command='])
        if (executable.error || command.error || !executable.stdout.trim() || !command.stdout.trim()) return null
        return { pid, executablePath: executable.stdout.trim(), commandLine: command.stdout.trim() }
    } catch {
        return null
    }
}

async function listBrainPortPids(platform) {
    if (platform === 'win32') {
        const result = await execFileResult('netstat', ['-ano', '-p', 'tcp'])
        if (result.error && !result.stdout) return []
        const pids = new Set()
        for (const line of result.stdout.split(/\r?\n/)) {
            const fields = line.trim().split(/\s+/)
            if (fields.length >= 5 && fields[0].toUpperCase() === 'TCP' && fields[1].endsWith(`:${BRAIN_PORT}`) && fields[3].toUpperCase() === 'LISTENING' && /^\d+$/.test(fields[4])) {
                pids.add(Number(fields[4]))
            }
        }
        return [...pids]
    }
    const result = await execFileResult('lsof', ['-nP', `-iTCP:${BRAIN_PORT}`, '-sTCP:LISTEN', '-t'])
    if (result.error && !result.stdout) return []
    return [...new Set(result.stdout.split(/\s+/).filter((value) => /^\d+$/.test(value)).map(Number))]
}

function createBrainOwnershipDescriptor(entry, getResourcesPath) {
    const exeName = process.platform === 'win32' ? 'server.exe' : 'server'
    const frozenExecutablePaths = []
    if (getResourcesPath) {
        frozenExecutablePaths.push(
            path.join(getResourcesPath, 'python-brain', exeName),
            path.join(getResourcesPath, 'python-brain', 'server', exeName),
        )
    }
    if (entry?.kind === 'binary') frozenExecutablePaths.push(entry.cmd)
    return {
        frozenExecutablePaths: [...new Set(frozenExecutablePaths)],
        sourceExecutablePaths: entry && entry.kind !== 'binary' && entry.cmd ? [entry.cmd] : [],
        sourceScriptPath: entry && entry.kind !== 'binary' ? (entry.args?.[0] || '') : '',
    }
}

// Pre-spawn orphan cleanup. If the app was force-killed (Task Manager kill,
// hard crash, OS shutdown without graceful exit), the spawned brain process
// can outlive its parent and keep port 8090 bound. The next launch then spawns
// a fresh brain that fails to bind → uvicorn exits → watchdog respawns → loop
// forever, with two server.exe processes alive (the orphan + the latest dead
// child). Sweep listeners on BRAIN_PORT before each spawn so the new brain
// gets a clean port.
//
// Returns { killed: string[], unkillable: string[] }. Unkillable PIDs almost
// always mean the orphan was spawned with elevated privileges (e.g. the user
// once launched ShadowPhone with "Run as administrator") and the current
// user-mode process can't terminate it. The caller surfaces those PIDs so
// the renderer can show the user a fix-it message instead of looping.
async function killOrphansOnBrainPort(descriptor) {
    const killed = []
    const unkillable = []
    const skipped = []
    for (const pid of await listBrainPortPids(process.platform)) {
        if (pid === process.pid) continue
        const identity = await readProcessIdentity(pid, process.platform)
        if (!isOwnedBrainProcess(identity, descriptor)) {
            skipped.push(String(pid))
            console.warn(`[LocalBrain] Port ${BRAIN_PORT} PID ${pid} is not a verified ShadowPhone brain; leaving it untouched.`)
            continue
        }
        const result = await terminateOwnedProcessTree(pid, process.platform)
        if (result.ok) {
            killed.push(String(pid))
            console.warn(`[LocalBrain] Terminated owned orphan brain PID ${pid} (port ${BRAIN_PORT})`)
        } else {
            unkillable.push(String(pid))
            console.warn(`[LocalBrain] Could not terminate owned orphan PID ${pid}: ${result.error}`)
        }
    }
    lastUnkillableOrphans = unkillable
    return { killed, unkillable, skipped }
}

// In-memory size estimator for brain.log so we don't fs.statSync() on every
// line. During a busy run the brain can emit 20-30 log lines per second; a
// stat per line is 20-30 sync syscalls/sec on the main thread. We rehydrate
// the counter once on first write, then track byte deltas locally and only
// touch the FS when we exceed the cap.
let brainLogBytes = -1  // -1 = unknown, will stat on next write

function appendBrainLog(logDir, prefix, text) {
    if (!logDir || !text) return
    if (prefix === 'STDOUT' && UVICORN_HEALTH_PROBE_RE.test(text)) return
    try {
        const logPath = path.join(logDir, 'brain.log')
        const line = `[${new Date().toISOString()}] ${prefix}: ${text}\n`
        if (brainLogBytes < 0) {
            try { brainLogBytes = fs.statSync(logPath).size } catch (_) { brainLogBytes = 0 }
        }
        if (brainLogBytes > BRAIN_LOG_MAX_BYTES) {
            try { fs.truncateSync(logPath, 0); brainLogBytes = 0 } catch (_) { /* concurrent rotate ok */ }
        }
        fs.appendFileSync(logPath, line)
        brainLogBytes += Buffer.byteLength(line, 'utf8')
    } catch (_) { /* best-effort, never crash the brain over logging */ }
}
let watchdogTimer = null
let watchdogHealthyStreak = 0
let watchdogUnhealthyStreak = 0
let watchdogStarted = false
let lastHealthyAt = 0

// Callback supplied by main.js that returns the current in-flight module-run
// refcount (acquire/release-active-run). While it returns > 0 the watchdog
// must never kill the brain — a kill would guarantee the run fails. Defaults
// to a 0-returning stub so the watchdog still works if it's never wired.
let activeRunCountGetter = () => 0

/**
 * Wire the active-run refcount into the watchdog. main.js owns the counter
 * (acquire/release-active-run IPC); this lets the watchdog consult it so it
 * never SIGKILLs a brain that's mid-module-run.
 */
function setActiveRunCountGetter(fn) {
    if (typeof fn === 'function') activeRunCountGetter = fn
}

/**
 * Resolve the python3 command for non-Windows source-mode entrypoints.
 *
 * Mac gotcha: Apple removed `/usr/bin/python3` from the default Catalina+
 * PATH for non-developer accounts, so a packaged-app exec environment
 * frequently has no `python3` on PATH at all. ENOENT on spawn then silently
 * routes us to the Railway fallback. We probe known install locations
 * explicitly (Homebrew arm64, Homebrew x86_64, system) and adopt the first
 * that exists; if none do, we return null and the caller logs + records
 * the `no_python_runtime` exit reason.
 *
 * Linux is unchanged — distro Python is reliably on PATH.
 */
function resolveSystemPython() {
    if (process.platform === 'win32') {
        // Try PATH first — works when the user launched Electron from a shell
        // that inherited PATH (terminal-launched dev mode).
        try {
            const r = require('child_process').spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true })
            if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
        } catch (_) { /* fall through */ }
        try {
            const r = require('child_process').spawnSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true })
            if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
        } catch (_) { /* fall through */ }
        // Probe known Windows install locations. Start Menu / NSIS-installed
        // Electron often inherits a stripped PATH that excludes the user's
        // %LOCALAPPDATA%\Programs\Python\..., so the simple `python` spawn
        // ENOENTs silently and the brain never starts.
        const homeDir = process.env.USERPROFILE || ''
        const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local')
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
        const candidates = [
            // Per-user installs (most common on the dev/SaaS path)
            path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'),
            path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
            path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
            // System-wide installs
            path.join(programFiles, 'Python313', 'python.exe'),
            path.join(programFiles, 'Python312', 'python.exe'),
            path.join(programFiles, 'Python311', 'python.exe'),
            path.join(programFilesX86, 'Python313', 'python.exe'),
            path.join(programFilesX86, 'Python312', 'python.exe'),
            path.join(programFilesX86, 'Python311', 'python.exe'),
            // Bare-root (legacy installers default)
            'C:\\Python313\\python.exe',
            'C:\\Python312\\python.exe',
            'C:\\Python311\\python.exe',
        ]
        for (const c of candidates) {
            if (fs.existsSync(c)) return fs.realpathSync(c)
        }
        return null
    }
    if (process.platform === 'darwin') {
        const candidates = [
            '/opt/homebrew/bin/python3',  // Apple Silicon Homebrew
            '/usr/local/bin/python3',     // Intel Homebrew
            '/usr/bin/python3',           // System (developer tools)
        ]
        for (const c of candidates) {
            if (fs.existsSync(c)) return fs.realpathSync(c)
        }
        return null
    }
    try {
        const r = require('child_process').spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
        if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
    } catch (_) { /* fall through */ }
    return 'python3'
}

// Read the build-time manifest a build worker drops at
// python-brain/.brain-manifest. Returns true if it asserts the bundled binary
// SHOULD ship. Tolerates its absence (returns false) and either a JSON body
// ({"binary": true|"server.exe"}) or a plain non-empty marker file. Used to
// distinguish "AV quarantined the exe" (manifest present, exe gone) from a
// legitimate source-only build (no manifest).
function brainBinaryExpected(brainDir) {
    try {
        const manifestPath = path.join(brainDir, '.brain-manifest')
        if (!fs.existsSync(manifestPath)) return false
        const raw = fs.readFileSync(manifestPath, 'utf8')
        try {
            const j = JSON.parse(raw)
            return !!(j && (j.binary || j.exe || j.expectBinary))
        } catch {
            return raw.trim().length > 0
        }
    } catch {
        return false
    }
}

function pickBrainEntrypoint(getResourcesPath) {
    // Resolution order:
    //   1. PyInstaller binary in <resources>/python-brain/ — zero Python
    //      required on user's machine. The binary may use one of two layouts:
    //        - ONEFILE: <resources>/python-brain/server[.exe] (a file).
    //          Windows ships this (server.spec win32 branch).
    //        - ONEDIR:  <resources>/python-brain/server/server[.exe] (the
    //          executable inside a server/ dir of dylibs). macOS ships this
    //          (server.spec macOS branch) because a onefile binary re-execs
    //          out of a temp dir, which hardened-runtime kills on a signed app.
    //   2. Bundled source in <resources>/python/server.py (works on any
    //      installer where the user has Python 3.11+ on PATH)
    //   3. Dev fallback: ../python/server.py relative to this file (repo)
    const exeName = process.platform === 'win32' ? 'server.exe' : 'server'

    if (getResourcesPath) {
        const brainDir = path.join(getResourcesPath, 'python-brain')
        // Probe both layouts. Windows primary = onefile; macOS primary =
        // onedir. The opposite layout is kept as a fallback so a future
        // packaging-mode flip on either platform still resolves.
        const onefileBinary = path.join(brainDir, exeName)
        const onedirBinary = path.join(brainDir, 'server', exeName)
        const binaryCandidates = process.platform === 'win32'
            ? [onefileBinary, onedirBinary]
            : [onedirBinary, onefileBinary]
        for (const bundledExe of binaryCandidates) {
            if (fs.existsSync(bundledExe)) {
                return { kind: 'binary', cmd: bundledExe, args: [] }
            }
        }
        // Binary not found. If the build manifest asserts it SHOULD ship, the
        // overwhelmingly likely cause is AV quarantine of the unsigned exe
        // (silent deletion) rather than a packaging miss. Flag it so the caller
        // surfaces an actionable message instead of a silent source-mode drop.
        const quarantined = brainBinaryExpected(brainDir)
        const bundledSource = path.join(getResourcesPath, 'python', 'server.py')
        if (fs.existsSync(bundledSource)) {
            const pythonCmd = resolveSystemPython()
            if (!pythonCmd) return { kind: 'no-python', cmd: null, args: [bundledSource], quarantined }
            return { kind: 'bundled-python', cmd: pythonCmd, args: [bundledSource], quarantined }
        }
        // No source fallback either — quarantined binary and nothing to run.
        if (quarantined) {
            return { kind: 'no-python', cmd: null, args: [], quarantined }
        }
    }

    const repoServer = path.join(__dirname, '..', 'python', 'server.py')
    if (fs.existsSync(repoServer)) {
        const pythonCmd = resolveSystemPython()
        if (!pythonCmd) return { kind: 'no-python', cmd: null, args: [repoServer] }
        return { kind: 'dev-python', cmd: pythonCmd, args: [repoServer] }
    }
    return null
}

/**
 * Spawn the brain. Idempotent — returns the existing process if already up.
 * Resolves once the brain has bound its port (probed via HTTP /health) or
 * rejects after a hard timeout. Resolves with { host, port, secret, kind }.
 */
/** Resolve the per-user log directory for Brain modules. Created lazily. */
function resolveLogDir(app) {
    try {
        if (app) {
            const userData = app.getPath('userData')
            const dir = path.join(userData, 'logs')
            fs.mkdirSync(dir, { recursive: true })
            return dir
        }
    } catch (_) { /* fall through */ }
    return ''
}

// Modules server.py imports at the top level. If ANY is missing the brain
// crashes at boot with ModuleNotFoundError (PyJWT above all — server.py does a
// top-level `import jwt`). The frozen server.exe bundles these; the source-mode
// fallback runs the USER's Python and must ensure them itself.
// Only the modules whose absence CRASHES server.py at boot / breaks auth — these
// mirror server.py's own critical-deps preflight. supabase is deliberately
// EXCLUDED: it's lazy-loaded (get_supabase) so a missing supabase doesn't crash
// boot, and its heavy import chain (gotrue/postgrest/httpx) would inflate the
// probe time and cause false timeouts on slow/AV machines. PIL is EXCLUDED too —
// server.py guards it (_HAS_PIL). pip still installs the FULL requirements.txt.
const REQUIRED_IMPORTS = ['fastapi', 'pydantic', 'httpx', 'jwt', 'uvicorn', 'cryptography']

// Best-effort, bounded import probe. Resolves { ok, err } — ok=true when
// `python -c "import ..."` exits 0. Never throws. This is the FAST-PATH gate
// for source-mode: a healthy machine returns ok in a few hundred ms with no
// pip involved, so a working install is never stalled. It also catches deps an
// antivirus later removed, which a stale install marker would have missed.
function probeSourceImports(pythonCmd, timeoutMs = 20_000) {
    return new Promise((resolve) => {
        try {
            const p = spawn(pythonCmd, ['-c', `import ${REQUIRED_IMPORTS.join(',')}`], {
                stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
            })
            let err = ''
            p.stderr.on('data', (d) => { err += d.toString() })
            // A TIMEOUT must be distinguishable from a real import failure: a slow /
            // AV-throttled interpreter can exceed the probe budget while still
            // importing fine within server.py's own 45s startup deadline. Callers
            // must NOT treat timedOut as "deps missing".
            const to = setTimeout(() => { try { p.kill() } catch (_) {} resolve({ ok: false, timedOut: true, err: 'import probe timed out' }) }, timeoutMs)
            p.on('exit', (code) => { clearTimeout(to); resolve({ ok: code === 0, err }) })
            p.on('error', (e) => { clearTimeout(to); resolve({ ok: false, err: e.message }) })
        } catch (e) { resolve({ ok: false, err: e.message }) }
    })
}

// Run a single `python -m pip ...` (or ensurepip) invocation. Captures BOTH
// stdout and stderr, is timeout-bounded, and never throws. Returns { code, out }.
function runPip(pythonCmd, args, timeoutMs = 300_000) {
    return new Promise((resolve) => {
        let out = ''
        try {
            const p = spawn(pythonCmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
            p.stdout.on('data', (d) => { out += d.toString() })
            p.stderr.on('data', (d) => { out += d.toString() })
            const to = setTimeout(() => { try { p.kill() } catch (_) {} resolve({ code: -1, out: out + '\n[pip timed out]' }) }, timeoutMs)
            p.on('exit', (code) => { clearTimeout(to); resolve({ code, out }) })
            p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out: out + `\n[pip spawn error] ${e.message}` }) })
        } catch (e) { resolve({ code: -1, out: `[pip spawn threw] ${e.message}` }) }
    })
}

// Ensure source-mode Python deps are importable before we spawn server.py.
// Flow: PROBE first (fast path, no pip). Only when the probe fails do we run a
// hardened `pip install -r requirements.txt`, then RE-PROBE. Returns a
// structured result so the caller can decide whether to spawn:
//   { ok: true }                  deps import — safe to spawn
//   { ok: false, missing: name }  still missing after install — caller SKIPS
//                                 the spawn (server.py would crash on import →
//                                 respawn loop). Never throws; skipped entirely
//                                 on the binary (exe) path.
async function ensureSourceDeps(pythonCmd, serverPyPath, logDir, app) {
    try {
        const reqPath = path.join(path.dirname(serverPyPath), 'requirements.txt')
        if (!fs.existsSync(reqPath)) return { ok: true }

        // FAST PATH: if the required modules already import, we're done. No pip,
        // no network — a healthy machine is not stalled.
        const firstProbe = await probeSourceImports(pythonCmd)
        if (firstProbe.ok) return { ok: true }
        // A TIMEOUT is not a proven missing dep — a slow/AV interpreter can exceed
        // the probe budget yet import fine within server.py's 45s startup deadline.
        // Don't run a full pip cycle (or skip the spawn) on a maybe-healthy machine;
        // proceed and let startup be the real gate.
        if (firstProbe.timedOut) {
            appendBrainLog(logDir, 'DEPS', 'import probe timed out (slow interpreter) — proceeding to spawn without pip')
            return { ok: true }
        }

        // Deps missing. Marker keyed on requirements.txt CONTENT (not app
        // version) so a changed dependency set re-triggers install and we can
        // tell a first install from a reinstall after a previously-good set.
        let sha = '0'
        try { sha = crypto.createHash('sha256').update(fs.readFileSync(reqPath)).digest('hex').slice(0, 12) } catch (_) {}
        const markerDir = (app && app.getPath) ? app.getPath('userData') : path.dirname(serverPyPath)
        const marker = path.join(markerDir, `.brain-deps-${sha}.ok`)
        const priorInstall = fs.existsSync(marker)
        appendBrainLog(logDir, 'DEPS', `source-mode imports missing — ${priorInstall ? 're-' : ''}installing requirements.txt (${pythonCmd})`)

        const baseArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqPath]
        let res = await runPip(pythonCmd, baseArgs)
        // Bootstrap pip itself if the interpreter has none.
        if (res.code !== 0 && /No module named pip/i.test(res.out)) {
            appendBrainLog(logDir, 'DEPS', 'pip missing — bootstrapping via ensurepip')
            await runPip(pythonCmd, ['-m', 'ensurepip', '--upgrade'], 120_000)
            res = await runPip(pythonCmd, baseArgs)
        }
        // Permission error (system-site install without rights) → --user;
        // otherwise a generic failure (often transient network) → retry once.
        if (res.code !== 0 && /permission denied|Errno 13|access is denied|--user/i.test(res.out)) {
            appendBrainLog(logDir, 'DEPS', 'pip permission error — retrying with --user')
            res = await runPip(pythonCmd, [...baseArgs, '--user'])
        } else if (res.code !== 0) {
            appendBrainLog(logDir, 'DEPS', 'pip failed — retrying once')
            res = await runPip(pythonCmd, baseArgs)
        }
        appendBrainLog(logDir, 'DEPS', `pip exit ${res.code}:\n${res.out.trim()}`)

        // RE-PROBE — the install exit code lies sometimes (partial installs,
        // wheels cached for the wrong ABI). The import check is the real gate.
        const reprobe = await probeSourceImports(pythonCmd)
        if (reprobe.ok) {
            try { fs.writeFileSync(marker, String(Date.now())) } catch (_) {}
            appendBrainLog(logDir, 'DEPS', 'requirements importable after install')
            return { ok: true }
        }
        // Re-probe timed out (slow interpreter), not a proven miss — pip already
        // ran, so proceed to spawn and let server.py's startup deadline catch a
        // genuine failure rather than falsely dropping the user to Railway forever.
        if (reprobe.timedOut) {
            try { fs.writeFileSync(marker, String(Date.now())) } catch (_) {}
            appendBrainLog(logDir, 'DEPS', 're-probe timed out after install — proceeding to spawn')
            return { ok: true }
        }
        const m = reprobe.err && reprobe.err.match(/No module named '([\w.]+)'/)
        const missing = m ? m[1] : 'python dependencies'
        appendBrainLog(logDir, 'DEPS', `still missing after install: ${missing}`)
        return { ok: false, missing }
    } catch (e) {
        // Never block a spawn over our own unexpected error (probe/pip helpers
        // don't throw — this only fires on fs/crypto oddities). Best-effort:
        // proceed as before rather than falsely reporting missing deps.
        appendBrainLog(logDir, 'DEPS', `ensureSourceDeps error (proceeding): ${e.message}`)
        return { ok: true }
    }
}

function isCurrentBrainLaunch(launchId, launchedProcess) {
    return currentBrainLaunchId === launchId && brainProcess === launchedProcess
}

function canAcceptBrainReadiness(launchId, launchedProcess) {
    return !!launchId && !!launchedProcess && isCurrentBrainLaunch(launchId, launchedProcess)
        && !brainShutdownRequested && !brainTerminationPromise && !brainExitReason
}

function scheduleBrainRespawn(wasReady) {
    const terminal = brainShutdownRequested || brainExitReason === 'no_python_runtime' || brainExitReason === 'SIGTERM'
    if (terminal || brainTerminationPromise || brainRestartPromise || respawnAttempts >= MAX_AUTO_RESPAWNS || respawnTimer || respawnInFlight) return
    respawnAttempts += 1
    console.warn(`[LocalBrain] Scheduling auto-respawn ${respawnAttempts}/${MAX_AUTO_RESPAWNS} in ${RESPAWN_DEBOUNCE_MS}ms (lastReady=${wasReady}).`)
    respawnTimer = setTimeout(() => {
        respawnTimer = null
        if (brainShutdownRequested) return
        respawnInFlight = true
        startLocalBrain(lastSpawnOptions || {})
            .then((endpoint) => {
                if (endpoint) console.log('[LocalBrain] Auto-respawn succeeded.')
                else console.warn('[LocalBrain] Auto-respawn returned null.')
            })
            .catch((error) => console.warn('[LocalBrain] Auto-respawn threw:', error?.message || error))
            .finally(() => { respawnInFlight = false })
    }, RESPAWN_DEBOUNCE_MS)
}

function terminateCurrentBrainProcess(reason) {
    if (brainTerminationPromise) return brainTerminationPromise
    const launchedProcess = brainProcess
    const launchId = currentBrainLaunchId
    if (!launchedProcess || !launchId) return Promise.resolve({ ok: true })

    const descriptor = brainOwnershipDescriptor
    brainReady = false
    brainExitReason = reason

    brainTerminationPromise = (async () => {
        const liveIdentity = await readProcessIdentity(launchedProcess.pid, process.platform)
        if (!isOwnedBrainProcess(liveIdentity, descriptor)) {
            if (launchedProcess.exitCode === null && launchedProcess.signalCode === null) {
                console.error(`[LocalBrain] Refusing to terminate PID ${launchedProcess.pid || 'unknown'} because its ownership metadata is missing or mismatched.`)
                return { ok: false, error: 'Brain process ownership could not be verified' }
            }
        } else {
            const result = await terminateOwnedProcessTree(launchedProcess.pid, process.platform)
            if (!result.ok) {
                console.warn(`[LocalBrain] Process-tree termination failed for launch ${launchId}: ${result.error}`)
                return result
            }
        }
        if (isCurrentBrainLaunch(launchId, launchedProcess)) {
            currentBrainLaunchId = null
            brainProcess = null
            brainOwnershipDescriptor = null
        }
        return { ok: true }
    })().finally(() => { brainTerminationPromise = null })
    return brainTerminationPromise
}

async function startLocalBrain(opts = {}) {
    const { getResourcesPath, app } = opts
    // Cache the very first set of spawn options so the exit-handler-driven
    // respawn path (and the explicit restartLocalBrain IPC) can reuse them
    // without callers having to pass them in again.
    if (!lastSpawnOptions) lastSpawnOptions = { getResourcesPath, app }

    if (brainShutdownRequested || brainTerminationPromise) return null

    if (brainProcess && !brainProcess.killed) {
        return brainReady ? { host: BRAIN_HOST, port: BRAIN_PORT, secret: brainSecret, kind: 'existing' } : null
    }

    // Synchronous spawn-race guard. Set BEFORE the first await (the port-free
    // wait below) so a concurrent caller that slips past the brainProcess
    // guard during that window short-circuits instead of double-spawning.
    if (spawnInProgress) {
        return null
    }
    spawnInProgress = true
    try {

    const entry = pickBrainEntrypoint(getResourcesPath)
    if (!entry) {
        const msg = '[LocalBrain] No entrypoint found — neither bundled binary nor python/server.py exists.'
        console.warn(msg)
        return null
    }
    if (entry.kind === 'no-python') {
        // The brain can't start. Record a reason so the status pill / popover
        // shows a fix-it message instead of a silent "using Railway fallback".
        // Distinguish "AV ate the bundled binary" from "no Python runtime", and
        // give Windows its own message (this branch is reachable on win32 when
        // the exe is quarantined and no system Python exists).
        if (entry.quarantined) {
            brainExitReason = 'brain_binary_quarantined'
            console.error('[LocalBrain] Bundled brain binary is missing though the install manifest expects it — almost certainly quarantined by antivirus. ' +
                'Add a Defender/AV exclusion for the ShadowPhone install directory (or allowlist the app) and reinstall to restore the bundled brain.')
        } else if (process.platform === 'win32') {
            brainExitReason = 'no_python_runtime'
            console.error('[LocalBrain] No bundled brain binary and no system Python on this PC. ' +
                'Install Python 3.11 from python.org (tick "Add python.exe to PATH") OR reinstall ShadowPhone to restore the bundled brain.')
        } else {
            brainExitReason = 'no_python_runtime'
            console.error('[LocalBrain] No python3 runtime found on this Mac. Checked /opt/homebrew/bin, /usr/local/bin, /usr/bin. Install via `brew install python@3.11` to enable the local brain.')
        }
        return null
    }

    // Keep the same secret across respawns within an app session — the
    // renderer caches it after the first spawn. Regenerating on every
    // respawn was making the renderer present a stale secret to the new
    // brain, which rejected it with "Authentication required" and broke
    // every module call after a crash-restart.
    if (!brainSecret) brainSecret = crypto.randomUUID()
    brainStartedAt = Date.now()
    brainReady = false
    brainExitReason = null

    const logDir = resolveLogDir(app)

    const env = {
        ...process.env,
        BIND_HOST: BRAIN_HOST,
        PORT: String(BRAIN_PORT),
        SHADOWPHONE_API_SECRET: brainSecret,
        // LOCAL_MODE tells the brain to skip multi-tenant Supabase quota /
        // concurrent-device checks. The renderer already enforces quotas
        // at the parent app level, and the local brain only listens on
        // 127.0.0.1 — there's no second tenant to gate.
        LOCAL_MODE: '1',
        // Persistent log directory — modules append diagnostic lines
        // here so users can ship the file when a flow breaks.
        // <userData>/logs/account_creation.log etc.
        SHADOWPHONE_LOG_DIR: logDir,
        // Lazy-init Discord / Supabase modules — they aren't needed for
        // local execution and pulling them in costs ~80MB RAM at boot.
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        // smspool key for bulk/signup phone verification. There is no baked-in
        // fallback in server.py anymore — the brain fails CLOSED without it, so
        // forward it explicitly from the Electron env (already inherited via the
        // spread above, kept here so the contract is visible and survives any
        // future env filtering).
        SMSPOOL_API_KEY: (process.env.SMSPOOL_API_KEY || '').trim(),
    }

    // CWD has to be the directory containing server.py so its
    // `from lib.ws_module_adapter import …` etc. resolve correctly.
    // For binary entrypoints (`server.exe` standalone), cwd is the dir
    // holding the .exe — relative imports already baked into the
    // binary. For source modes (dev-python AND bundled-python), the
    // server.py path lives in args[0], so cwd = dirname of args[0].
    // Previously: the ternary checked `entry.kind === 'python'` (which
    // we never emit — kinds are 'binary' / 'dev-python' / 'bundled-python')
    // so the bundled-python production path got cwd=path.dirname('python')
    // = '.', and server.py crashed on import because lib/ wasn't on
    // the resolved path.
    const spawnCwd = entry.kind === 'binary'
        ? path.dirname(entry.cmd)
        : path.dirname(entry.args[0])
    console.log(`[LocalBrain] Spawning ${entry.kind}: ${entry.cmd} ${entry.args.join(' ')} (cwd=${spawnCwd})`)
    // Bundled binary missing but source-mode available: still works, just
    // slower. Leave a breadcrumb (likely AV quarantine) so the user can restore
    // the faster bundled brain, without blocking the working fallback.
    if (entry.quarantined) {
        appendBrainLog(logDir, 'BRAIN', 'bundled brain binary missing (manifest expected it) — likely AV quarantine; running slower source-mode fallback. Add an AV exclusion for the install dir + reinstall to restore the bundled brain.')
    }
    // Source-mode fallback needs its Python deps importable or server.py crashes
    // on a top-level import (e.g. jwt) → respawn loop. PROBE first (fast path,
    // no pip); only pip when missing; if STILL missing, SKIP the spawn rather
    // than feed a guaranteed crash loop.
    if (entry.kind === 'bundled-python' || entry.kind === 'dev-python') {
        const deps = await ensureSourceDeps(entry.cmd, entry.args[0], logDir, app)
        if (deps && !deps.ok) {
            brainExitReason = 'missing_python_deps'
            const reqPath = path.join(path.dirname(entry.args[0]), 'requirements.txt')
            console.error(`[LocalBrain] Python deps missing (${deps.missing}) — skipping spawn to avoid a crash loop. ` +
                `Repair with: ${entry.cmd} -m pip install -r ${reqPath}`)
            appendBrainLog(logDir, 'DEPS', `missing_python_deps:${deps.missing} — spawn skipped`)
            return null
        }
    }
    const ownershipDescriptor = createBrainOwnershipDescriptor(entry, getResourcesPath)
    // Sweep orphan listeners (from a prior force-kill) before binding, or
    // uvicorn will EADDRINUSE and we'll respawn-loop forever.
    const orphanCleanup = await killOrphansOnBrainPort(ownershipDescriptor)
    // Bounded port-free wait. taskkill returns before the OS has actually
    // released the socket — the listener lingers in TIME_WAIT / teardown for
    // a beat. Spawning uvicorn into that window hits [Errno 10048] and we
    // respawn-loop. Poll probeBrainPort() (true = something still listening)
    // and only proceed once it's free. An occupied port cannot supply this
    // launch's readiness response or justify starting another process.
    const portFreeDeadline = Date.now() + 5_000
    while (Date.now() < portFreeDeadline) {
        if (!(await probeBrainPort())) break
        await new Promise((r) => setTimeout(r, 200))
    }
    if (await probeBrainPort()) {
        const occupants = [...orphanCleanup.unkillable, ...orphanCleanup.skipped]
        brainExitReason = `port_${BRAIN_PORT}_in_use:${occupants.join(',') || 'unknown'}`
        console.warn(`[LocalBrain] Port ${BRAIN_PORT} remains occupied; no replacement Brain was started.`)
        return null
    }
    if (brainShutdownRequested) return null
    // Also write spawn intent to brain.log so we can debug a silent ENOENT
    // even when Electron's stdout isn't captured (packaged NSIS launches).
    appendBrainLog(logDir, 'SPAWN', `${entry.kind} cmd=${entry.cmd} args=${JSON.stringify(entry.args)} cwd=${spawnCwd}`)
    const launchedProcess = spawn(entry.cmd, entry.args, {
        env,
        cwd: spawnCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
    })
    brainProcess = launchedProcess
    const launchId = ++nextBrainLaunchId
    currentBrainLaunchId = launchId
    brainOwnershipDescriptor = ownershipDescriptor
    // Capture spawn ENOENT / permission failures that don't fire the
    // 'exit' event. Without this, a broken python path / sandboxed
    // executable silently never produces logs and the pill is left
    // guessing the cause forever.
    brainProcess.on('error', (err) => {
        if (!isCurrentBrainLaunch(launchId, launchedProcess)) return
        brainExitReason = `spawn_error: ${err.code || ''}${err.code ? ' — ' : ''}${err.message || err}`
        brainReady = false
        console.error(`[LocalBrain] Spawn failed: ${brainExitReason}`)
        appendBrainLog(logDir, 'SPAWN_ERROR', brainExitReason)
        const failedProc = launchedProcess
        currentBrainLaunchId = null
        brainProcess = null
        brainOwnershipDescriptor = null
        // The 'exit' handler is what schedules respawns; without an exit
        // event after spawn-error, we need to nudge the respawn ourselves.
        if (failedProc) scheduleBrainRespawn(false)
    })

    brainProcess.stdout.on('data', (buf) => {
        if (!isCurrentBrainLaunch(launchId, launchedProcess)) return
        const text = String(buf).trimEnd()
        if (text) console.log(`[Brain] ${text}`)
        appendBrainLog(logDir, 'STDOUT', text)
    })
    brainProcess.stderr.on('data', (buf) => {
        if (!isCurrentBrainLaunch(launchId, launchedProcess)) return
        const text = String(buf).trimEnd()
        if (text) console.warn(`[Brain] ${text}`)
        // ALSO capture to brain.log — uvicorn + Python tracebacks come over
        // stderr, and when the brain crashes in a loop this is the only
        // place the cause shows up (Electron's console isn't persisted in
        // a packaged build).
        appendBrainLog(logDir, 'STDERR', text)
        // Catch the EADDRINUSE crash loop early. uvicorn writes:
        //   ERROR: [Errno 10048] error while attempting to bind on address...
        // when an orphan (or any other process) is holding 8090. Surface that
        // as a structured exitReason so the renderer can show a fix-it message
        // instead of looping into a generic "auth error" toast.
        if (/Errno\s*10048|address.*already in use|EADDRINUSE/i.test(text)) {
            brainReady = false
            const pids = lastUnkillableOrphans.length
                ? ` Cannot kill PID(s): ${lastUnkillableOrphans.join(', ')}.`
                : ''
            brainExitReason = `port_${BRAIN_PORT}_in_use:${lastUnkillableOrphans.join(',') || 'unknown'}`
            console.error(`[LocalBrain] Port ${BRAIN_PORT} is occupied — this Brain launch cannot bind and is not ready.${pids}`)
        }
        // A crashing top-level import lands here first. Surface it as a
        // structured, actionable reason so the status pill can prompt "repair
        // dependencies" instead of a silent Railway fallback; the exit handler
        // below preserves this reason instead of clobbering it with the code.
        const missMod = text.match(/ModuleNotFoundError: No module named '([\w.]+)'/)
        if (missMod) {
            brainExitReason = `missing_python_module:${missMod[1]}`
            console.error(`[LocalBrain] Brain crashed on missing Python module '${missMod[1]}'. Repair dependencies (pip install -r requirements.txt) or reinstall ShadowPhone.`)
        }
    })
    brainProcess.on('exit', (code, signal) => {
        if (!isCurrentBrainLaunch(launchId, launchedProcess)) return
        // Preserve a specific, actionable reason captured from stderr (e.g. a
        // ModuleNotFoundError) rather than clobbering it with the generic code.
        if (!(brainExitReason && (brainExitReason.startsWith('missing_python_module:') || brainExitReason.startsWith(`port_${BRAIN_PORT}_in_use:`)))) {
            brainExitReason = signal || `exit code ${code}`
        }
        const wasReady = brainReady
        brainReady = false
        console.warn(`[LocalBrain] Brain exited: ${brainExitReason}`)
        appendBrainLog(logDir, 'EXIT', `${brainExitReason} (code=${code}, signal=${signal || 'null'})`)
        currentBrainLaunchId = null
        brainProcess = null
        brainOwnershipDescriptor = null
        // Auto-respawn on unexpected exit. Skip when:
        //   - we hit the per-session attempt cap (the watchdog also resets
        //     this counter when it observes a healthy brain so recoveries
        //     after a transient crash don't permanently consume it),
        //   - the exit reason is terminal (no Python — there's nothing to
        //     respawn, or intentional SIGTERM from stopLocalBrain on shutdown),
        //   - a respawn is already pending.
        // NOTE: 'startup_hang' is NOT terminal anymore. Cold-start failures
        // are often transient (Supabase client first-import, slow disk,
        // Windows Defender real-time scan stalling lib/ws_modules/*.py
        // imports). The watchdog + respawn handle that recovery.
        scheduleBrainRespawn(wasReady)
    })

    // Wait up to BRAIN_STARTUP_DEADLINE_MS for the brain to finish registering
    // its required module handlers. We poll HTTP /ready unconditionally —
    // log-string scraping ("Application startup
    // complete") is unreliable because Python sometimes line-buffers stderr
    // even with PYTHONUNBUFFERED=1, and on Windows the parent's pipe drain
    // can lag the actual port bind by several seconds. The 2.10.1 Pixel-6
    // failure was exactly this: brain bound :8090 within ~6s but the
    // ready-line didn't surface to Node until well past the 45s ceiling,
    // so the renderer's waitForLocalBrain saw `brainReady=false` and
    // hard-failed despite a perfectly healthy brain.
    //
    // Each fetch carries a 1.5s AbortSignal — without it, if the brain binds
    // the port but hangs in startup (the 2.8.20 lib-import-deadlock failure
    // mode), Node's fetch waits forever and every poll iteration leaks a
    // socket. The outer deadline still fires, but the brain process is
    // left as a zombie and getLocalBrainEndpoint() silently returns null,
    // dumping us to Railway with no diagnostic.
    const deadline = Date.now() + BRAIN_STARTUP_DEADLINE_MS
    while (Date.now() < deadline) {
        if (!canAcceptBrainReadiness(launchId, launchedProcess)) {
            return null
        }
        try {
            const res = await fetch(`http://${BRAIN_HOST}:${BRAIN_PORT}/ready`, {
                method: 'GET',
                signal: AbortSignal.timeout(1500),
            })
            if (await isBrainReadyResponse(res)) {
                if (!canAcceptBrainReadiness(launchId, launchedProcess)) return null
                // Port is bound AND the server returned something — flip
                // brainReady to true so the rest of the module honors the
                // endpoint even if the log line never lands.
                brainReady = true
                lastHealthyAt = Date.now()
                console.log(`[LocalBrain] Ready in ${Date.now() - brainStartedAt}ms (kind=${entry.kind})`)
                return { host: BRAIN_HOST, port: BRAIN_PORT, secret: brainSecret, kind: entry.kind }
            }
        } catch { /* not ready yet (or per-fetch 1.5s abort), keep polling */ }
        await new Promise((r) => setTimeout(r, 250))
    }

    // Hard timeout. The brain bound the port but never finished startup —
    // SIGKILL it so we don't leak a zombie, and record the reason for the
    // status pill / popover to surface.
    brainExitReason = 'startup_hang'
    console.warn(`[LocalBrain] Startup hang — brain bound port but never reported ready in ${BRAIN_STARTUP_DEADLINE_MS}ms. SIGKILL.`)
    if (isCurrentBrainLaunch(launchId, launchedProcess)) {
        await terminateCurrentBrainProcess('startup_hang')
        scheduleBrainRespawn(false)
    }
    return null

    } finally {
        // Release the spawn-race latch on every exit path (success, early
        // return, throw) so a later legitimate (re)spawn isn't blocked.
        spawnInProgress = false
    }
}

async function stopLocalBrain() {
    // Mark this as an intentional stop so the exit handler's auto-respawn
    // path skips it. On Windows the child has no signal name; we still set
    // brainExitReason to 'SIGTERM' explicitly so the terminal check works.
    brainShutdownRequested = true
    brainExitReason = 'SIGTERM'
    if (respawnTimer) {
        clearTimeout(respawnTimer)
        respawnTimer = null
    }
    if (brainStopPromise) return brainStopPromise
    brainStopPromise = terminateCurrentBrainProcess('SIGTERM')
    return brainStopPromise
}

/**
 * Explicit restart triggered from the renderer (Brain Status pill > Restart).
 * Stops the current process if it's running, resets the auto-respawn counter
 * (the user is taking ownership of recovery so they get a fresh budget),
 * clears any terminal exit reason, and re-spawns with the cached options.
 *
 * Returns the new endpoint on success, or null + a reason string on failure.
 */
function restartLocalBrain() {
    if (brainRestartPromise) return brainRestartPromise
    brainRestartPromise = (async () => {
        console.log('[LocalBrain] Manual restart requested.')
        brainShutdownRequested = false
        brainStopPromise = null
        if (respawnTimer) {
            clearTimeout(respawnTimer)
            respawnTimer = null
        }
        if (brainProcess) {
            const stopped = await terminateCurrentBrainProcess('restart')
            if (!stopped.ok) return { endpoint: null, error: stopped.error }
            // Brief grace so the OS releases the port before we re-bind.
            await new Promise((r) => setTimeout(r, 500))
        }
        if (brainShutdownRequested) return { endpoint: null, error: 'Brain shutdown was requested during restart.' }
        respawnAttempts = 0
        brainExitReason = null
        if (!lastSpawnOptions) {
            console.warn('[LocalBrain] restart called before any prior start — no cached options to reuse.')
            return { endpoint: null, error: 'Brain has never been started; nothing to restart.' }
        }
        try {
            const endpoint = await startLocalBrain(lastSpawnOptions)
            return { endpoint, error: endpoint ? null : (brainExitReason || 'Brain failed to start.') }
        } catch (e) {
            return { endpoint: null, error: e?.message || 'Restart threw an exception.' }
        }
    })().finally(() => { brainRestartPromise = null })
    return brainRestartPromise
}

function getLocalBrainEndpoint() {
    if (!brainReady || !canAcceptBrainReadiness(currentBrainLaunchId, brainProcess)) return null
    return {
        host: BRAIN_HOST,
        port: BRAIN_PORT,
        secret: brainSecret,
        wsUrl: `ws://${BRAIN_HOST}:${BRAIN_PORT}`,
        httpUrl: `http://${BRAIN_HOST}:${BRAIN_PORT}`,
    }
}

/**
 * Wait for the local brain to become reachable, up to `timeoutMs`.
 *
 * The brain is spawned asynchronously at app boot (main.js whenReady) and can
 * take several seconds to bind + finish startup. A schedule run that fires
 * during that window sees `getLocalBrainEndpoint() === null` and — without
 * this — silently dumps to the Railway WS. For brain-only modules (posting)
 * that's the wrong target: the user expects posting to run on the local
 * brain. This lets the WS dispatcher briefly block for the brain instead of
 * giving up on the first null.
 *
 * Returns the endpoint once ready, or null if the brain genuinely cannot
 * start within the window (no Python, crashed, startup hang) — the caller
 * decides whether to hard-fail or fall through.
 */
async function waitForLocalBrain(timeoutMs = 20_000) {
    const ready = getLocalBrainEndpoint()
    if (ready) return ready

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (brainShutdownRequested) return null
        // Genuinely terminal states: no Python to spawn, or the bundled binary
        // was quarantined with no source fallback. 'startup_hang' and
        // 'missing_python_deps' are recoverable (watchdog restarts / deps may
        // finish installing), so wait those out instead of bailing.
        if (brainExitReason === 'no_python_runtime' || brainExitReason === 'brain_binary_quarantined') {
            return null
        }
        const endpoint = getLocalBrainEndpoint()
        if (endpoint) return endpoint
        const observedLaunchId = currentBrainLaunchId
        const observedProcess = brainProcess
        // Also probe readiness directly — handles the race where the brain is
        // registered + accepting modules but our internal brainReady flag
        // hasn't flipped yet (e.g. mid-respawn from the watchdog).
        try {
            const res = await fetch(`http://${BRAIN_HOST}:${BRAIN_PORT}/ready`, {
                method: 'GET',
                signal: AbortSignal.timeout(1000),
            })
            if (await isBrainReadyResponse(res) && canAcceptBrainReadiness(observedLaunchId, observedProcess)) {
                brainReady = true
                lastHealthyAt = Date.now()
                const ep = getLocalBrainEndpoint()
                if (ep) return ep
            }
        } catch { /* keep waiting */ }
        await new Promise((r) => setTimeout(r, 250))
    }
    return getLocalBrainEndpoint()
}

/**
 * Last known reason the brain isn't running, or null if it's healthy / has
 * never started. Surfaced through the brain:get-status IPC so the topbar
 * pill popover can tell the user WHY they're on Railway fallback.
 *
 * Possible values:
 *   - null              brain is running, or has never been started
 *   - 'startup_hang'    brain bound the port but never finished startup; SIGKILL'd
 *   - 'no_python_runtime'  no python3/py in any known install location
 *   - 'missing_python_deps'  source-mode deps still un-importable after pip; spawn skipped
 *   - 'missing_python_module:<name>'  brain crashed on a missing top-level import
 *   - 'brain_binary_quarantined'  manifest expects the exe but it's gone (likely AV)
 *   - 'SIGTERM' / 'SIGKILL' / 'exit code N'  process-emitted exit signals/codes
 */
function getBrainExitReason() {
    return brainExitReason
}

/**
 * Readiness probe used by both the watchdog and brain:get-status. A process can
 * be alive while a required registration block is missing, so only /ready may
 * restore the green endpoint state.
 */
async function probeBrainHealth() {
    if (!brainProcess) return false
    try {
        const res = await fetch(`http://${BRAIN_HOST}:${BRAIN_PORT}/ready`, {
            method: 'GET',
            signal: AbortSignal.timeout(WATCHDOG_PROBE_TIMEOUT_MS),
        })
        return await isBrainReadyResponse(res)
    } catch {
        return false
    }
}

/**
 * TCP-level liveness probe. Opens a bare socket to 127.0.0.1:8090 and resolves
 * true if the handshake completes. A brain that's pinned mid-module-run still
 * accepts TCP connections instantly even when its HTTP event loop is starved,
 * so this distinguishes "busy" (port bound, connect succeeds) from "dead"
 * (port unbound, ECONNREFUSED). Used by the watchdog as the death test —
 * an HTTP /health timeout alone is never treated as death.
 */
function probeBrainPort() {
    return new Promise((resolve) => {
        const socket = new net.Socket()
        let settled = false
        const done = (alive) => {
            if (settled) return
            settled = true
            try { socket.destroy() } catch { /* ignore */ }
            resolve(alive)
        }
        socket.setTimeout(WATCHDOG_PORT_PROBE_TIMEOUT_MS)
        socket.once('connect', () => done(true))
        socket.once('timeout', () => done(false))
        socket.once('error', () => done(false))
        try {
            socket.connect(BRAIN_PORT, BRAIN_HOST)
        } catch {
            done(false)
        }
    })
}

/**
 * Background watchdog. Pings the brain every WATCHDOG_INTERVAL_MS and:
 *   - resets respawnAttempts after WATCHDOG_HEAL_THRESHOLD consecutive
 *     healthy probes (so transient crash loops don't permanently cap the
 *     respawn budget),
 *   - only kills + respawns when the brain is GENUINELY dead — i.e. the
 *     child process has exited AND/OR TCP port 8090 is no longer accepting
 *     connections — and only after WATCHDOG_KILL_THRESHOLD consecutive such
 *     observations. A slow/timed-out HTTP /health response is NEVER on its
 *     own treated as death: a brain pinned by a module run (uiautomator
 *     dumps, scrolling, network calls) is busy, not dead, and killing it
 *     drops the in-flight automation WebSocket (close code 1006).
 *   - never kills while a module run is in flight (activeRunCountGetter > 0);
 *     it logs concern but defers — the run finishing frees the brain.
 *
 * Skipped when:
 *   - brainExitReason === 'no_python_runtime' (nothing to recover)
 *   - lastSpawnOptions is unset (brain has never been started)
 */
function startBrainWatchdog() {
    if (watchdogStarted) return
    watchdogStarted = true
    watchdogTimer = setInterval(async () => {
        if (brainShutdownRequested || spawnInProgress || brainTerminationPromise || brainRestartPromise) return
        // No-op when the user can't actually run the brain (nothing to spawn).
        // 'missing_python_deps' is intentionally NOT here — leaving it out lets
        // a later watchdog tick retry the install and auto-recover once deps
        // become available (bounded to one attempt at a time by spawnInProgress).
        if (brainExitReason === 'no_python_runtime' || brainExitReason === 'brain_binary_quarantined') return
        if (!lastSpawnOptions) return

        const observedLaunchId = currentBrainLaunchId
        const observedProcess = brainProcess
        const observationIsCurrent = () => currentBrainLaunchId === observedLaunchId && brainProcess === observedProcess
            && !brainShutdownRequested && !spawnInProgress && !brainTerminationPromise && !brainRestartPromise
        const healthy = await probeBrainHealth()
        if (!observationIsCurrent()) return
        if (healthy && canAcceptBrainReadiness(observedLaunchId, observedProcess)) {
            lastHealthyAt = Date.now()
            watchdogUnhealthyStreak = 0
            // Self-heal flag: only flip brainReady true here if a respawn
            // raced past our cold-start probe loop, so the renderer can
            // see a green endpoint instantly.
            if (!brainReady) {
                brainReady = true
                console.log('[Watchdog] Brain newly reachable; flipping ready=true.')
            }
            watchdogHealthyStreak += 1
            if (watchdogHealthyStreak >= WATCHDOG_HEAL_THRESHOLD && respawnAttempts > 0) {
                console.log(`[Watchdog] Healthy for ${watchdogHealthyStreak} cycles — resetting respawnAttempts (was ${respawnAttempts}).`)
                respawnAttempts = 0
            }
            return
        }

        watchdogHealthyStreak = 0

        // HTTP ping failed. Before concluding anything, decide if the brain
        // is BUSY or DEAD. The death test is: process gone OR port unbound.
        const processAlive = !!(brainProcess && !brainProcess.killed)
        const portBound = await probeBrainPort()
        if (!observationIsCurrent()) return

        // Busy, not dead: a live process with a bound port that simply
        // didn't answer HTTP fast enough. This is the legitimate-load case
        // (module run pinning the event loop). Never kill here.
        if (processAlive && portBound) {
            watchdogUnhealthyStreak = 0
            console.warn('[Watchdog] HTTP ping slow but process alive + port 8090 bound — brain is BUSY, not dead. No action.')
            return
        }

        // Genuinely unhealthy: process exited and/or port unbound. Even so,
        // never kill mid-run — the run will fail anyway and a kill guarantees
        // it. Defer recovery until the run releases.
        let activeRuns = 0
        try { activeRuns = activeRunCountGetter() || 0 } catch { activeRuns = 0 }
        if (activeRuns > 0) {
            console.warn(`[Watchdog] Brain looks unhealthy (process=${processAlive ? 'alive' : 'null'}, port=${portBound ? 'bound' : 'unbound'}) but ${activeRuns} module run(s) in flight — deferring recovery, will not kill.`)
            return
        }

        // Debounce: require WATCHDOG_KILL_THRESHOLD consecutive genuinely-dead
        // observations before acting, so a single unlucky tick can't trigger
        // an unnecessary kill/respawn cycle.
        watchdogUnhealthyStreak += 1
        if (watchdogUnhealthyStreak < WATCHDOG_KILL_THRESHOLD) {
            console.warn(`[Watchdog] Brain unhealthy (process=${processAlive ? 'alive' : 'null'}, port=${portBound ? 'bound' : 'unbound'}) — ${watchdogUnhealthyStreak}/${WATCHDOG_KILL_THRESHOLD} before recovery.`)
            return
        }

        watchdogUnhealthyStreak = 0
        console.warn(`[Watchdog] Brain confirmed dead over ${WATCHDOG_KILL_THRESHOLD} cycles (process=${processAlive ? 'alive' : 'null'}, port=${portBound ? 'bound' : 'unbound'}) — kicking recovery.`)

        // Process exists but the port is unbound / TCP-dead: the brain is a
        // zombie. Kill it so the exit handler's respawn path takes over.
        // The next watchdog tick sees brainProcess=null and starts fresh.
        if (processAlive) {
            const stopped = await terminateCurrentBrainProcess('watchdog_recovery')
            if (stopped.ok) scheduleBrainRespawn(false)
            return
        }

        // Process is gone and the exit-handler didn't queue a respawn (or
        // already exhausted the budget). Trigger a fresh start. Idempotent
        // — if a respawn is already pending, this just returns the cached
        // entry path probe and bails.
        if (!brainShutdownRequested && !respawnInFlight && !respawnTimer) {
            try {
                await startLocalBrain(lastSpawnOptions)
            } catch (e) {
                console.warn('[Watchdog] respawn threw:', e?.message || e)
            }
        }
    }, WATCHDOG_INTERVAL_MS)
    if (watchdogTimer && typeof watchdogTimer.unref === 'function') {
        watchdogTimer.unref()
    }
    console.log(`[LocalBrain] Watchdog started (interval=${WATCHDOG_INTERVAL_MS}ms).`)
}

function stopBrainWatchdog() {
    if (watchdogTimer) {
        clearInterval(watchdogTimer)
        watchdogTimer = null
    }
    watchdogStarted = false
    watchdogHealthyStreak = 0
    watchdogUnhealthyStreak = 0
}

/**
 * Returns a structured snapshot for the renderer's brain:get-status IPC.
 * Surfaces enough that the status pill popover can render without a second
 * IPC call.
 */
function getBrainHealthSnapshot() {
    return {
        ready: brainReady,
        host: BRAIN_HOST,
        port: BRAIN_PORT,
        startedAt: brainStartedAt || null,
        lastHealthyAt: lastHealthyAt || null,
        respawnAttempts,
        watchdogStarted,
        exitReason: brainExitReason,
        hasProcess: !!brainProcess,
        hasEntrypoint: lastSpawnOptions ? true : false,
    }
}

module.exports = {
    isOwnedBrainProcess,
    terminateOwnedProcessTree,
    startLocalBrain,
    stopLocalBrain,
    restartLocalBrain,
    getLocalBrainEndpoint,
    waitForLocalBrain,
    getBrainExitReason,
    startBrainWatchdog,
    stopBrainWatchdog,
    probeBrainHealth,
    probeBrainPort,
    getBrainHealthSnapshot,
    setActiveRunCountGetter,
}
