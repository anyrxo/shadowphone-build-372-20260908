'use strict'
/**
 * scrcpy-mac-installer.js — auto-install scrcpy on macOS when missing.
 *
 * Flow when user clicks Launch on Mac and findScrcpyBinary can't find it:
 *   1. detectHomebrew()  — is brew installed?
 *   2. If YES: prompt user → run `brew install scrcpy` (2-3 min)
 *      Stream progress to launcher.log; show dialog when done.
 *   3. If NO: show a dialog with one-liner to install homebrew first,
 *      then re-run the wizard.
 *
 * Result: Mac users with no scrcpy + no homebrew get a clear, actionable
 * path. Mac users with homebrew get a one-click install. Mac users with
 * scrcpy already there are unaffected.
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')

function detectHomebrew() {
    // Check the standard locations FIRST (avoids relying on PATH which
    // Electron's spawn doesn't inherit reliably on Mac).
    const candidates = [
        '/opt/homebrew/bin/brew',   // Apple Silicon
        '/usr/local/bin/brew',      // Intel
    ]
    for (const c of candidates) {
        if (fs.existsSync(c)) return { found: true, path: c, arch: c.includes('opt/homebrew') ? 'arm64' : 'x64' }
    }
    // PATH fallback via `which`
    try {
        const r = spawnSync('which', ['brew'], { encoding: 'utf8', timeout: 2000 })
        if (r.status === 0 && r.stdout.trim()) {
            const p = r.stdout.trim().split('\n')[0]
            if (fs.existsSync(p)) return { found: true, path: p, arch: 'unknown' }
        }
    } catch (_) {}
    return { found: false, path: null, arch: null }
}

// 2.17.10: Xcode Command Line Tools detection. Brew install fails with
// cryptic "exit 1" when CLT is missing — most common reason scrcpy install
// dies after the bottle download. We surface a clear path for the user.
function detectXcodeCLT() {
    try {
        const r = spawnSync('xcode-select', ['-p'], { encoding: 'utf8', timeout: 2000 })
        const path = String(r.stdout || '').trim()
        if (r.status === 0 && path) {
            // Verify the path actually exists (sometimes -p returns a stale path)
            if (fs.existsSync(path)) return { installed: true, path }
        }
    } catch (_) {}
    return { installed: false, path: null }
}

function installXcodeCLT(onProgress) {
    return new Promise((resolve) => {
        let proc
        const tail = []
        try {
            proc = spawn('xcode-select', ['--install'], { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (e) {
            return resolve({ ok: false, error: 'xcode-select spawn failed: ' + (e?.message || e) })
        }
        const onChunk = (data) => {
            const text = String(data || '').trim()
            if (!text) return
            tail.push(text); if (tail.length > 20) tail.shift()
            try { onProgress?.('xcode-clt: ' + text) } catch (_) {}
        }
        proc.stdout?.on('data', onChunk)
        proc.stderr?.on('data', onChunk)
        proc.on('error', (err) => resolve({ ok: false, error: 'xcode-clt error: ' + (err?.message || err) }))
        proc.on('close', (code) => {
            // "already installed" returns non-zero with that string — treat as success
            const out = tail.join('\n').toLowerCase()
            if (out.includes('already installed')) return resolve({ ok: true, alreadyInstalled: true })
            // `xcode-select --install` triggers a SYSTEM POPUP; user must click Install.
            // The command exits while the popup is still showing — we ALWAYS poll for
            // up to 6 minutes after triggering the popup.
            const deadline = Date.now() + 6 * 60 * 1000
            const poll = () => {
                const det = detectXcodeCLT()
                if (det.installed) return resolve({ ok: true })
                if (Date.now() > deadline) return resolve({ ok: false, error: 'Xcode Command Line Tools install timed out after 6 min. Open Terminal and run `xcode-select --install`, click Install when popup appears, then click Launch again.' })
                setTimeout(poll, 5000)
            }
            try { onProgress?.('xcode-clt: triggered install popup — click Install and wait ~5 min …') } catch (_) {}
            setTimeout(poll, 5000)
        })
    })
}

/**
 * Run `brew install scrcpy` and stream progress. 2.17.10: runs `brew update`
 * first (stale brew is the #2 cause of exit-1) and captures FULL output tail
 * for diagnosis instead of truncating mid-stream.
 */
function installScrcpyViaBrew(brewPath, onProgress) {
    return new Promise((resolve) => {
        const tail = []
        // 1) brew update — non-fatal if it fails (slow networks, etc.)
        const update = spawnSync(brewPath, ['update'], {
            env: { ...process.env, HOMEBREW_NO_INSTALL_FROM_API: '' },
            encoding: 'utf8', timeout: 120_000,
        })
        try { onProgress?.('brew update: ' + (String(update.stdout || '').split('\n').pop() || 'done').slice(0, 80)) } catch (_) {}

        // 2) brew install scrcpy
        let proc
        try {
            proc = spawn(brewPath, ['install', 'scrcpy'], {
                env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            })
        } catch (e) {
            return resolve({ ok: false, error: 'brew spawn failed: ' + (e?.message || e) })
        }
        const onChunk = (data) => {
            const text = String(data || '').trim()
            if (!text) return
            // Split multi-line chunks so we don't blow our line buffer with one big blob.
            for (const ln of text.split('\n')) {
                if (!ln.trim()) continue
                tail.push(ln)
                if (tail.length > 60) tail.shift()
                try { onProgress?.(ln.slice(0, 160)) } catch (_) {}
            }
        }
        proc.stdout?.on('data', onChunk)
        proc.stderr?.on('data', onChunk)
        proc.on('error', (err) => resolve({ ok: false, error: 'brew error: ' + (err?.message || err) }))
        proc.on('close', (code) => {
            if (code === 0) {
                const { detectScrcpyAvailability } = require('./scrcpy-spawn-native')
                const det = detectScrcpyAvailability({})
                if (det.found) return resolve({ ok: true, binary: det.binary, source: det.source })
                return resolve({ ok: false, error: 'brew exited 0 but scrcpy still not found' })
            }
            // 2.17.10: surface the last 25 lines so users can DM the actual reason.
            const fullTail = tail.slice(-25).join('\n')
            resolve({
                ok: false,
                error: `brew install scrcpy exited ${code}.\n\nLast lines:\n${fullTail.slice(0, 1500)}`,
                fullLog: fullTail,
            })
        })
    })
}

/**
 * High-level: ensure scrcpy is available on this Mac.
 * 2.17.10: pre-flight Xcode Command Line Tools (brew install ${formula}
 * silently exit-1s without it on fresh Macs), then brew update + install.
 */
async function ensureScrcpyOnMac(opts) {
    const { detectScrcpyAvailability } = require('./scrcpy-spawn-native')
    const present = detectScrcpyAvailability({})
    if (present.found) return { ok: true, binary: present.binary, source: present.source, alreadyInstalled: true }

    const brew = detectHomebrew()
    if (!brew.found) {
        return {
            ok: false,
            error: 'scrcpy is not installed and Homebrew is missing. Install Homebrew from https://brew.sh then re-launch.',
            needsHomebrew: true,
        }
    }

    // Pre-flight: Xcode Command Line Tools required for brew to compile/link bottles.
    const clt = detectXcodeCLT()
    if (!clt.installed) {
        try { opts?.onProgress?.('Xcode Command Line Tools missing — triggering install (~5 min)…') } catch (_) {}
        const cltRes = await installXcodeCLT(opts?.onProgress)
        if (!cltRes.ok) {
            return {
                ok: false,
                error: cltRes.error || 'Xcode Command Line Tools install failed',
                needsXcodeCLT: true,
            }
        }
        try { opts?.onProgress?.('Xcode Command Line Tools ready ✓') } catch (_) {}
    }

    return await installScrcpyViaBrew(brew.path, opts?.onProgress)
}

module.exports = { detectHomebrew, installScrcpyViaBrew, ensureScrcpyOnMac, detectXcodeCLT, installXcodeCLT }
