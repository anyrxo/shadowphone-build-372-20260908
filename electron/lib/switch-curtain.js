/**
 * switch-curtain.js — "Switching profile…" overlay shown while a tailnet
 * phone is in the airplane-mode gap of a profile switch.
 *
 * scrcpy's TCP connection to the phone dies the instant airplane mode goes
 * on, which kills the scrcpy window and leaves a black hole in the UI. The
 * curtain covers that area with a clean spinner + label so the operator
 * doesn't think the phone crashed. Removed once scrcpy respawns.
 */

const { BrowserWindow, screen } = require('electron')
const os = require('os')
const win32Dock = require('./win32-dock')

const curtains = new Map() // serial -> BrowserWindow
const curtainTimers = new Map() // serial -> setTimeout handle (max-alive)
// 2.16.58: hard cap — even if every async path screws up, the curtain
// goes away after this. A switch never legitimately takes >20s.
// For brand-new GrapheneOS profiles pass maxAliveMs ~35000 to cover
// the 25-30s first-boot init before the curtain drops.
const MAX_ALIVE_MS = 20_000

function deviceToCss(rect) {
    if (!rect) return null
    if (os.platform() === 'darwin') return { ...rect }
    try {
        const display = screen.getDisplayNearestPoint({
            x: Math.round(rect.x + rect.w / 2),
            y: Math.round(rect.y + rect.h / 2),
        })
        const scale = display?.scaleFactor || 1
        return {
            x: Math.round(rect.x / scale),
            y: Math.round(rect.y / scale),
            w: Math.round(rect.w / scale),
            h: Math.round(rect.h / scale),
        }
    } catch (_) {
        return { ...rect }
    }
}

async function resolveScrcpyBoundsCss(scrcpyTitle, scrcpyPid) {
    if (!scrcpyTitle || !win32Dock.available()) return null
    const hwnd = await win32Dock.findScrcpyHwnd(scrcpyTitle, { timeoutMs: 1500, preferPid: scrcpyPid })
    if (!hwnd) return null
    const rect = win32Dock.getWindowRect(hwnd)
    return deviceToCss(rect)
}

function buildHtml(label) {
    const safe = String(label || '...').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    // Self-contained data: URL — no external stylesheets, no preload. The
    // visual system mirrors shared.css tokens 1:1 so the curtain reads as a
    // member of the same family as toolbar + fleet panel.
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        :root {
            --bg: #0a0a0a;
            --surface: #181818;
            --border: #1f1f1f;
            --border-hot: #2a2a2a;
            --text: #fafafa;
            --text-dim: #8b8b8b;
            --text-tertiary: #5a5a5a;
            --brand: #facc15;
            --brand-stroke: rgba(250,204,21,0.32);
            --brand-glow: rgba(250,204,21,0.10);
        }
        html, body {
            margin: 0; height: 100%;
            background:
                radial-gradient(60% 50% at 50% 35%, rgba(250,204,21,0.06) 0%, transparent 70%),
                radial-gradient(80% 60% at 50% 100%, rgba(20,15,30,0.6)  0%, transparent 60%),
                var(--bg);
            color: var(--text);
            font-family: -apple-system, "SF Pro Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
            -webkit-font-smoothing: antialiased;
            overflow: hidden;
            user-select: none; -webkit-user-select: none;
            position: relative;
        }
        /* Subtle scanline texture */
        body::before {
            content: ""; position: absolute; inset: 0; pointer-events: none;
            background: repeating-linear-gradient(0deg,
                rgba(255,255,255,0.014) 0px,
                rgba(255,255,255,0.014) 1px,
                transparent 1px,
                transparent 3px);
            opacity: 0.55;
            mix-blend-mode: screen;
        }
        /* Top hairline brand accent */
        body::after {
            content: ""; position: absolute; left: 0; right: 0; top: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--brand-stroke) 50%, transparent);
            opacity: 0.7;
        }

        .wrap {
            height: 100%;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            gap: 22px;
            position: relative;
            animation: rise .42s cubic-bezier(.2,.8,.25,1) both;
        }
        @keyframes rise { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

        /* Premium spinner: two concentric rings, outer breathes, inner spins */
        .spin-wrap {
            position: relative;
            width: 64px; height: 64px;
            display: flex; align-items: center; justify-content: center;
        }
        .spin-wrap::before {
            /* breathing halo */
            content: ""; position: absolute; inset: -10px;
            border-radius: 50%;
            border: 1px solid var(--brand-stroke);
            animation: halo 2s ease-in-out infinite;
        }
        @keyframes halo {
            0%, 100% { opacity: 0.5; transform: scale(0.96); }
            50%      { opacity: 0;   transform: scale(1.12); }
        }
        .spinner {
            width: 48px; height: 48px;
            border-radius: 50%;
            position: relative;
        }
        .spinner::before, .spinner::after {
            content: ""; position: absolute; inset: 0; border-radius: 50%;
            border: 2.5px solid transparent;
        }
        .spinner::before { border-color: var(--border-hot); }
        .spinner::after  {
            border-top-color: var(--brand);
            border-right-color: var(--brand);
            filter: drop-shadow(0 0 8px var(--brand-stroke));
            animation: spin .9s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .label {
            font-size: 10px;
            color: var(--text-tertiary);
            letter-spacing: 0.18em;
            text-transform: uppercase;
            font-family: "SF Mono", ui-monospace, "JetBrains Mono", Consolas, monospace;
            font-weight: 600;
            display: flex; align-items: center; gap: 8px;
        }
        .label .pulse-dot {
            width: 5px; height: 5px; border-radius: 50%;
            background: var(--brand);
            box-shadow: 0 0 8px var(--brand-stroke);
            animation: pulseDot 1.6s ease-in-out infinite;
        }
        @keyframes pulseDot { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

        .strong {
            font-size: 19px;
            color: var(--brand);
            font-weight: 600;
            text-align: center;
            padding: 0 18px;
            line-height: 1.25;
            font-family: -apple-system, "SF Pro Display", "Segoe UI Variable Display", system-ui, sans-serif;
            letter-spacing: -0.015em;
            max-width: 90vw;
            word-break: break-word;
            text-shadow: 0 0 16px var(--brand-glow);
        }
        .sub {
            font-size: 10.5px;
            color: var(--text-tertiary);
            font-family: "SF Mono", ui-monospace, monospace;
            letter-spacing: 0.03em;
            text-align: center;
            padding: 0 12px;
            max-width: 92vw;
        }

        /* Step indicator: tiny progress beads showing where we are in the bracket */
        .beads {
            display: flex; gap: 6px;
            margin-top: 4px;
        }
        .beads span {
            width: 18px; height: 2px; border-radius: 2px;
            background: var(--border-hot);
        }
        .beads span.on {
            background: var(--brand);
            box-shadow: 0 0 6px var(--brand-stroke);
        }
        .beads span:nth-child(1) { animation: beadFill 5s ease-in-out infinite; }
        .beads span:nth-child(2) { animation: beadFill 5s ease-in-out 1.6s infinite; background: var(--border-hot); }
        .beads span:nth-child(3) { animation: beadFill 5s ease-in-out 3.2s infinite; background: var(--border-hot); }
        @keyframes beadFill {
            0%, 30%   { background: var(--border-hot); box-shadow: none; }
            40%, 90%  { background: var(--brand); box-shadow: 0 0 6px var(--brand-stroke); }
            100%      { background: var(--border-hot); box-shadow: none; }
        }
    </style></head><body><div class="wrap">
        <div class="spin-wrap"><div class="spinner"></div></div>
        <div class="label"><span class="pulse-dot"></span>switching profile</div>
        <div class="strong">${safe}</div>
        <div class="sub">phone briefly offline · sidebar back in a sec</div>
        <div class="beads"><span></span><span></span><span></span></div>
    </div></body></html>`
}

async function show({ serial, scrcpyTitle, scrcpyPid, profileLabel, maxAliveMs }) {
    hide(serial)
    const bounds = await resolveScrcpyBoundsCss(scrcpyTitle, scrcpyPid)
    if (!bounds || bounds.w < 80 || bounds.h < 80) {
        console.warn(`[switch-curtain] no scrcpy bounds for "${scrcpyTitle}" — skipping curtain`)
        return null
    }
    const win = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h,
        frame: false,
        transparent: false,
        // 2.16.18: focusable now true. scrcpy is WS_EX_TOPMOST; for our
        // alwaysOnTop curtain to draw above it Windows needs to grant the
        // curtain at least one focus event after creation so the topmost
        // ordering resolves in our favor. Without this the curtain
        // sometimes stayed BEHIND the (dying) scrcpy frame.
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        focusable: true,
        hasShadow: false,
        backgroundColor: '#0a0a0a',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch (_) {}
    try { win.setIgnoreMouseEvents(false) } catch (_) {}
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(profileLabel)))

    // 2.16.18: actively hoist above scrcpy. moveTop() asks Windows to bump
    // our HWND to the top of the topmost band; focus() ensures the WM
    // applies the request. The 250/600/1200ms retries cover the moment when
    // scrcpy is still alive and competing, then again after it dies and
    // Windows is repainting.
    const hoist = () => {
        if (!win || win.isDestroyed()) return
        try { win.show() } catch (_) {}
        try { win.moveTop() } catch (_) {}
        try { win.focus() } catch (_) {}
    }
    setTimeout(hoist, 50)
    setTimeout(hoist, 250)
    setTimeout(hoist, 600)
    setTimeout(hoist, 1200)
    setTimeout(hoist, 2500)
    setTimeout(hoist, 4000)

    curtains.set(serial, win)
    // 2.16.58: max-alive safety. If launchScrcpyForSerial hangs (no resolve
    // and no reject), the normal hide() never fires. This timer guarantees
    // the operator never sees a frozen spinner.
    // Callers may pass a larger maxAliveMs for brand-new profiles whose
    // first-boot init keeps am get-current-user returning 0 for ~25-30s.
    const aliveMs = (typeof maxAliveMs === 'number' && maxAliveMs > MAX_ALIVE_MS) ? maxAliveMs : MAX_ALIVE_MS
    const t = setTimeout(() => {
        if (curtains.has(serial)) {
            console.warn(`[switch-curtain] max-alive (${aliveMs}ms) reached for ${serial} — force-hiding stale curtain`)
            hide(serial)
        }
    }, aliveMs)
    curtainTimers.set(serial, t)
    console.log(`[switch-curtain] shown for ${serial} at ${JSON.stringify(bounds)} (max-alive ${aliveMs}ms)`)
    return win
}

function hide(serial) {
    const win = curtains.get(serial)
    if (win && !win.isDestroyed()) {
        try { win.close() } catch (_) {}
    }
    curtains.delete(serial)
    const t = curtainTimers.get(serial)
    if (t) { clearTimeout(t); curtainTimers.delete(serial) }
    console.log(`[switch-curtain] hidden for ${serial}`)
}

function hideAll() {
    for (const serial of Array.from(curtains.keys())) hide(serial)
}

module.exports = { show, hide, hideAll }
