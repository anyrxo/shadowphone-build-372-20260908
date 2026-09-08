'use strict'
/**
 * Talks to the phone's PortBroadcastService over Tailnet :8765 + falls
 * back to a TCP port scan when the Companion doesn't know the adb port.
 *
 * Why the fallback exists: Android 16's SELinux blocks untrusted_app
 * from reading /proc/net/tcp* so the Companion often returns adbPort=0.
 * `service.adb.tls.port` is also unset on Pixel firmware. We brute-force
 * connect-probe a small range of likely ports over Tailnet (Android picks
 * adbd TLS ports from the ephemeral range), which takes <2s in parallel.
 *
 * Discovery flow:
 *   1. GET http://<ip>:8765/ — confirms Companion alive + Tailnet reachable
 *   2. If body.adbPort > 0: use it directly
 *   3. Else: parallel TCP connect to 5555 + ports 32768..60999 in batches
 *      until one accepts. The first accepting port is returned.
 */
const http = require('http')
const net = require('net')

const DEFAULT_PORT = 8765
const DEFAULT_TIMEOUT_MS = 2000

function discoverAdbPort(tailnetIp, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
    const hostPort = opts.hostPort || DEFAULT_PORT
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: tailnetIp,
            port: hostPort,
            path: '/',
            method: 'GET',
            timeout: timeoutMs,
            headers: { 'Connection': 'close' },
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume()
                return reject(new Error(`companion responded ${res.statusCode}`))
            }
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => { body += chunk })
            res.on('end', () => {
                let parsed
                try { parsed = JSON.parse(body) }
                catch (_) { return reject(new Error(`companion body not JSON: ${body.slice(0, 80)}`)) }
                const port = Number(parsed.adbPort)
                if (!Number.isFinite(port) || port < 1024 || port > 65535) {
                    return reject(new Error(`invalid port ${parsed.adbPort}`))
                }
                resolve(port)
            })
            res.on('error', reject)
        })
        req.on('timeout', () => {
            req.destroy(new Error(`companion :${hostPort} timeout after ${timeoutMs}ms`))
        })
        req.on('error', reject)
        req.end()
    })
}

/**
 * Probe Companion liveness only (no adb port). Used as the first step
 * before deciding to scan — if Companion doesn't respond, the phone is
 * unreachable on Tailnet and scanning is pointless.
 */
function probeCompanion(tailnetIp, opts = {}) {
    return discoverAdbPort(tailnetIp, opts).then(p => ({ adbPort: p }))
        .catch(async (e) => {
            // discoverAdbPort throws on invalid port too — distinguish
            // "reachable but adbPort=0" from "unreachable".
            if (/invalid port 0/.test(e.message)) return { adbPort: 0 }
            throw e
        })
}

/**
 * TCP connect-scan a list of candidate ports in parallel. Resolves with
 * the FIRST port that accepts a TCP connection within the timeout.
 * Doesn't validate it's actually adb — caller should follow up with
 * `adb connect`.
 */
function probePort(ip, port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket()
        let done = false
        // Resolve shape: { port } on connect, null on closed, 'EMFILE' on
        // fd exhaustion (caller backs off + retries rather than treating
        // it as "port closed"). Mac's default ulimit -n is 256 so heavy
        // parallelism can transiently exhaust descriptors.
        const finish = (result) => {
            if (done) return
            done = true
            try { sock.destroy() } catch (_) {}
            resolve(result)
        }
        sock.setTimeout(timeoutMs)
        sock.once('connect', () => finish(port))
        sock.once('timeout', () => finish(null))
        sock.once('error', (e) => finish(e?.code === 'EMFILE' || e?.code === 'ENFILE' ? 'EMFILE' : null))
        try {
            sock.connect(port, ip)
        } catch (e) {
            finish(e?.code === 'EMFILE' || e?.code === 'ENFILE' ? 'EMFILE' : null)
        }
    })
}

async function scanForAdbPort(tailnetIp, opts = {}) {
    const probeTimeout = opts.probeTimeoutMs || 800
    const overallTimeout = opts.overallTimeoutMs || 60_000
    const hint = opts.hintPort  // previous successful port — scan near it first
    const deadline = Date.now() + overallTimeout

    // Build candidates with priority:
    //   1. 5555 (legacy adb tcpip — fast win)
    //   2. Expanding rings around the hint port (clustering — kernel often
    //      reuses nearby ephemeral ports across reboots). ±1024 first for
    //      the common small-rotation case, then ±4096 and ±16384 so a
    //      moderately-rotated port is still found within the deadline
    //      before the cold sweep.
    //   3. Full Android ephemeral range 32768-61000 (cold fallback)
    const seen = new Set()
    const candidates = []
    const push = (p) => { if (!seen.has(p)) { seen.add(p); candidates.push(p) } }
    push(5555)
    if (hint) {
        push(hint)
        const rings = [1024, 4096, 16384]  // expanding fast-find windows before cold sweep
        let prev = 1
        for (const ring of rings) {
            for (let off = prev; off < ring; off++) {
                if (hint + off < 61000) push(hint + off)
                if (hint - off >= 32768) push(hint - off)
            }
            prev = ring
        }
    }
    for (let p = 32768; p < 61000; p++) push(p)

    // Parallel TCP connect-probes. Concurrency is platform-aware: macOS
    // ships a 256 default fd limit (ulimit -n) so we cap lower there to
    // avoid EMFILE; Windows + Linux tolerate more. Each probe is 800ms
    // max — with short-circuit on first hit, a hint-guided scan finds the
    // port in ~2-5s; a cold full-range scan is ~50-120s worst case.
    const PARALLEL = opts.parallel || (process.platform === 'darwin' ? 96 : 200)
    let cursor = 0
    let found = null

    const worker = async () => {
        while (!found && Date.now() < deadline) {
            const myPort = candidates[cursor++]
            if (myPort === undefined) return
            const hit = await probePort(tailnetIp, myPort, probeTimeout)
            if (hit === 'EMFILE') {
                // Descriptor exhaustion — back off, re-queue this port,
                // let in-flight sockets drain before retrying.
                cursor--
                await new Promise((r) => setTimeout(r, 50))
                continue
            }
            if (hit && !found) found = hit
        }
    }

    const workers = []
    for (let w = 0; w < PARALLEL; w++) workers.push(worker())
    await Promise.all(workers)
    return found
}

module.exports = { discoverAdbPort, probeCompanion, scanForAdbPort }
