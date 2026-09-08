/**
 * Cloudflared subprocess manager for ShadowPhone portal tunnels.
 *
 * Spawns `cloudflared tunnel --url http://localhost:<port>` and parses
 * the resulting `https://NAME.trycloudflare.com` URL from stderr/stdout.
 * Cloudflared is bundled under `electron/vendor/cloudflared/<platform>-<arch>/`
 * via electron-builder `extraResources` so installs ship without an
 * extra runtime dependency.
 *
 * Apache-2.0 licensed — safe to bundle alongside ShadowPhone.
 *
 * NOTE: TryCloudflare quick tunnels don't require auth or a TOS click in
 *       headless mode — cloudflared just prints the URL and starts
 *       forwarding. Confirmed by the explicit `--url` flag path: it's
 *       distinct from the named-tunnel auth flow that needs `cloudflared
 *       tunnel login`. If Cloudflare ever changes that, the spawn will
 *       just hang on stdout and the start() promise will reject after
 *       the 20s timeout.
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TRYCLOUDFLARE_URL_RE = /https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com/i

/**
 * Resolve the bundled cloudflared binary path for the current platform.
 * Falls back to a system-installed `cloudflared` on PATH if the bundled
 * binary is missing (useful in `npm run dev` before assets are seeded).
 */
function resolveCloudflaredPath({ getResourcesPath, isPackaged } = {}) {
    const platform = os.platform()           // 'win32' | 'darwin' | 'linux'
    const arch = os.arch()                   // 'x64' | 'arm64'
    const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    const subdir = `${platform}-${arch}`

    // Packaged app: <resources>/cloudflared/<platform>-<arch>/cloudflared
    if (isPackaged && getResourcesPath) {
        const packaged = path.join(getResourcesPath, 'cloudflared', subdir, exe)
        if (fs.existsSync(packaged)) return packaged
    }

    // Dev / unpacked: electron/vendor/cloudflared/<platform>-<arch>/cloudflared
    const devPath = path.join(__dirname, '..', 'vendor', 'cloudflared', subdir, exe)
    if (fs.existsSync(devPath)) return devPath

    // Last resort: rely on PATH. spawn will surface ENOENT if missing.
    return exe
}

/**
 * Start a cloudflared quick-tunnel pointing at `http://localhost:<port>`.
 * Resolves with `{ url, child, kill }` once the trycloudflare URL has
 * been observed on stdout/stderr (cloudflared logs it via stderr in
 * practice; we watch both to be safe).
 *
 * Rejects after `urlTimeoutMs` if the URL never appears.
 */
async function startCloudflaredTunnel({
    port,
    cloudflaredPath,
    log = () => {},
    urlTimeoutMs = 20_000,
}) {
    if (!port) throw new Error('port required')
    const bin = cloudflaredPath || resolveCloudflaredPath()

    // --no-autoupdate keeps the subprocess from forking an updater when
    // we're embedding cloudflared inside a signed app bundle (the updater
    // can't write into Program Files / .app). --protocol http2 sidesteps
    // the QUIC handshake which some user firewalls block silently.
    const args = [
        'tunnel',
        '--no-autoupdate',
        '--protocol', 'http2',
        '--url', `http://127.0.0.1:${port}`,
    ]

    log('info', `[cloudflared] spawn ${bin} ${args.join(' ')}`)
    const child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    let resolved = false
    let url = null

    const result = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (resolved) return
            resolved = true
            try { child.kill('SIGTERM') } catch (_) { /* best effort */ }
            reject(new Error(`cloudflared did not emit a trycloudflare URL within ${urlTimeoutMs}ms`))
        }, urlTimeoutMs)

        const consume = (buf) => {
            const text = buf.toString('utf8')
            log('info', `[cloudflared] ${text.trim()}`)
            if (!url) {
                const m = text.match(TRYCLOUDFLARE_URL_RE)
                if (m) {
                    url = m[0]
                    resolved = true
                    clearTimeout(timeout)
                    // Big-flag log line — grep-greppable for support /
                    // debug recovery (regular "[cloudflared] <chunk>"
                    // lines bury the URL inside noisy log output).
                    log('info', `[cloudflared] PORTAL URL: ${url}`)
                    // Mirror to a deterministic file. Without this, the
                    // current ephemeral *.trycloudflare.com hostname is
                    // only recoverable via the desktop app's UI — a
                    // 2.12.2 portal.log regression on some installs left
                    // the URL invisible to anyone on the host machine's
                    // terminal. Field-confirmed: a friend with a 3-phone
                    // setup lost the URL after auto-update because
                    // portal.log silently stopped writing for that run.
                    try {
                        const urlFile = path.join(os.tmpdir(), 'shadowphone-current-portal-url.txt')
                        fs.writeFileSync(urlFile, `${url}\n${new Date().toISOString()}\n`, 'utf8')
                        log('info', `[cloudflared] URL mirrored to ${urlFile}`)
                    } catch (e) {
                        log('warn', `[cloudflared] URL mirror failed: ${e?.message || e}`)
                    }
                    resolve({ url, child, kill: () => safeKill(child) })
                }
            }
        }

        child.stdout?.on('data', consume)
        child.stderr?.on('data', consume)

        child.on('error', (err) => {
            if (resolved) return
            resolved = true
            clearTimeout(timeout)
            reject(err)
        })

        child.on('exit', (code, signal) => {
            log('warn', `[cloudflared] exited code=${code} signal=${signal} (url=${url || 'never-seen'})`)
            if (resolved) return
            resolved = true
            clearTimeout(timeout)
            reject(new Error(`cloudflared exited (code=${code}, signal=${signal}) before emitting URL`))
        })
    })

    return result
}

function safeKill(child) {
    if (!child || child.killed) return
    try {
        child.kill('SIGTERM')
    } catch (_) { /* swallow */ }
    // Cloudflared on Windows occasionally ignores SIGTERM. Send a hard
    // kill after a grace period so we don't leak orphan processes.
    setTimeout(() => {
        if (!child.killed) {
            try { child.kill('SIGKILL') } catch (_) { /* swallow */ }
        }
    }, 3000).unref?.()
}

module.exports = {
    startCloudflaredTunnel,
    resolveCloudflaredPath,
    safeKill,
    TRYCLOUDFLARE_URL_RE,
}
