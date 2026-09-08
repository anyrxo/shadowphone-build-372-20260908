/**
 * lib/scrcpy-loading-overlay.js — PROPOSAL (not auto-wired)
 *
 * Problem
 * ───────
 * scrcpy is a native binary. When we spawn it, there is a 1–3 s window
 * where the window exists but no frames are decoded yet — Windows users
 * see a black rectangle, Mac users see a translucent grey ghost. Both
 * read as "the app is broken" instead of "loading".
 *
 * Solution
 * ────────
 * Pre-render an Electron BrowserWindow positioned exactly where scrcpy
 * will appear, showing a brand-on phone-frame skeleton + spinner. Fade
 * it out once scrcpy proves it's drawing (we either get a paint signal
 * via a tracker or hit a hard 3 s timeout — whichever first).
 *
 * Lifecycle
 * ─────────
 *   1. system-handlers.js calls show({ serial, rect }) BEFORE spawning scrcpy.
 *   2. scrcpy is spawned at `rect`. The overlay covers the same rect.
 *   3. After 1.5 s the toolbar HWND tracker reports a successful HWND find
 *      for scrcpy — that's our "scrcpy is alive" signal. Call hide(serial).
 *   4. Hard cap: 3 s. If we never hear back, hide anyway so the overlay
 *      never becomes the stuck-loader bug.
 *
 * Wire-up (no IPC needed, all main-process)
 *   const overlay = require('../lib/scrcpy-loading-overlay')
 *   overlay.show({ serial, rect: { x, y, w, h }, mirrorTitle })
 *   // After child = spawn(scrcpyPath, args):
 *   child.once('spawn', () => {
 *       // Poll for first paint via the toolbar's tracker, then:
 *       overlay.hide(serial)
 *   })
 *
 * Existing protocols touched: none.
 * New IPC methods: none.
 * New DOM ids: none.
 */

const { BrowserWindow, screen } = require('electron')

/**
 * Convert a device-pixel rect to CSS/DIP pixels using the same DPI-correct
 * display match that mirror-toolbar.js deviceToCssPixels uses.
 * Falls back to rect as-is if the display lookup fails (graceful degradation:
 * worst case is the 300ms mis-position that exists today, not a crash).
 */
function _deviceToCss(rect) {
    const os = require('os')
    if (os.platform() === 'darwin') return { ...rect }
    try {
        const cx = rect.x + rect.w / 2
        const cy = rect.y + rect.h / 2
        const displays = screen.getAllDisplays()
        const d = displays.find(disp => {
            const sf = disp.scaleFactor || 1
            const dx = disp.bounds.x * sf, dy = disp.bounds.y * sf
            return cx >= dx && cx < dx + disp.bounds.width * sf &&
                   cy >= dy && cy < dy + disp.bounds.height * sf
        }) || screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) })
        const scale = d?.scaleFactor || 1
        return {
            x: Math.round(rect.x / scale),
            y: Math.round(rect.y / scale),
            w: Math.round(rect.w / scale),
            h: Math.round(rect.h / scale),
        }
    } catch (_) {
        return { ...rect }   // fallback: use device px as-is (same as today's behaviour)
    }
}

const overlays = new Map()         // serial → BrowserWindow
const hideTimers = new Map()       // serial → safety-net setTimeout
const fadingSerials = new Set()    // serials currently mid-fade — move() skips these
const HARD_TIMEOUT_MS = 5000       // overlay never lives past this (raised from 3000 so it
                                   // outlasts the ~3s HWND-find timeout in mirror-toolbar.js
                                   // and is still alive when reposition() calls hide())

function buildHtml(mirrorTitle) {
    const safeTitle = String(mirrorTitle || '...')
        .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        :root {
            --bg: #0a0a0a;
            --surface: #141414;
            --surface-2: #181818;
            --border: #1f1f1f;
            --border-hot: #2a2a2a;
            --text: #fafafa;
            --text-dim: #8b8b8b;
            --text-tertiary: #5a5a5a;
            --brand: #facc15;
            --brand-glow: rgba(250,204,21,0.10);
            --brand-stroke: rgba(250,204,21,0.32);
        }
        html, body {
            margin: 0; height: 100%;
            background:
                radial-gradient(60% 50% at 50% 30%, rgba(250,204,21,0.05) 0%, transparent 70%),
                linear-gradient(180deg, #0e0a18 0%, #0a0a0a 60%, #050505 100%);
            color: var(--text);
            font-family: -apple-system, "SF Pro Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
            -webkit-font-smoothing: antialiased;
            overflow: hidden;
            user-select: none; -webkit-user-select: none;
            position: relative;
            transition: opacity .42s cubic-bezier(.2,.8,.25,1);
        }
        body.fading { opacity: 0; }
        body::before {
            /* film grain */
            content: ""; position: absolute; inset: 0; pointer-events: none;
            background: repeating-linear-gradient(0deg,
                rgba(255,255,255,0.012) 0px,
                rgba(255,255,255,0.012) 1px,
                transparent 1px, transparent 3px);
            mix-blend-mode: screen;
            opacity: 0.5;
        }
        /* Phone-frame skeleton — a thin rounded rectangle in the centre.
           Scaling lets the same skeleton work at any rect size. */
        .frame {
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            width: 56%; height: 78%;
            border: 1.5px solid var(--border-hot);
            border-radius: 24px;
            background:
                linear-gradient(180deg, rgba(255,255,255,0.02), transparent);
            box-shadow: 0 8px 30px rgba(0,0,0,0.5);
            display: flex; flex-direction: column;
            overflow: hidden;
        }
        /* notch */
        .frame::before {
            content: ""; position: absolute;
            left: 50%; top: 14px;
            transform: translateX(-50%);
            width: 24%; height: 10px;
            border-radius: 10px;
            background: #050505;
            border: 1px solid var(--border);
        }
        /* skeleton inner — shimmer rows that animate */
        .inner {
            flex: 1;
            margin: 36px 14px 18px;
            display: flex; flex-direction: column;
            gap: 8px;
        }
        .row {
            height: 12px;
            border-radius: 4px;
            background: linear-gradient(90deg,
                var(--surface) 0%,
                var(--surface-2) 40%,
                var(--surface) 80%);
            background-size: 200% 100%;
            animation: shimmer 1.6s linear infinite;
        }
        .row.tall { height: 28%; min-height: 60px; margin-bottom: 6px; }
        .row.short { width: 60%; }
        @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

        .caption {
            position: absolute;
            left: 50%; bottom: 14%;
            transform: translateX(-50%);
            display: flex; flex-direction: column; align-items: center;
            gap: 8px;
            max-width: 90%;
            text-align: center;
        }
        .spinner {
            width: 22px; height: 22px;
            border-radius: 50%;
            position: relative;
        }
        .spinner::before, .spinner::after {
            content: ""; position: absolute; inset: 0; border-radius: 50%;
            border: 2px solid transparent;
        }
        .spinner::before { border-color: var(--border-hot); }
        .spinner::after  {
            border-top-color: var(--brand);
            border-right-color: var(--brand);
            filter: drop-shadow(0 0 6px var(--brand-stroke));
            animation: spin .9s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .l1 {
            font-size: 9.5px;
            color: var(--text-tertiary);
            letter-spacing: 0.18em;
            text-transform: uppercase;
            font-family: "SF Mono", ui-monospace, monospace;
            font-weight: 600;
        }
        .l2 {
            font-size: 12.5px;
            color: var(--brand);
            font-weight: 600;
            letter-spacing: -0.005em;
            font-family: "SF Pro Display", -apple-system, system-ui, sans-serif;
            text-shadow: 0 0 12px var(--brand-glow);
            word-break: break-all;
        }
        .l3 {
            font-size: 10px;
            color: var(--text-tertiary);
            font-family: "SF Mono", ui-monospace, monospace;
            letter-spacing: 0.02em;
        }

        /* Hairline brand accent at very top, same language as the toolbar header */
        body::after {
            content: ""; position: absolute; left: 0; right: 0; top: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--brand-stroke) 50%, transparent);
            opacity: 0.7;
        }
    </style></head>
    <body>
        <div class="frame">
            <div class="inner">
                <div class="row tall"></div>
                <div class="row"></div>
                <div class="row short"></div>
                <div class="row"></div>
                <div class="row short"></div>
                <div class="row"></div>
            </div>
        </div>
        <div class="caption">
            <div class="spinner"></div>
            <div class="l1">connecting mirror</div>
            <div class="l2">${safeTitle}</div>
            <div class="l3">scrcpy · first frame imminent</div>
        </div>
        <script>
            // Allow the main process to trigger a fade-out before close.
            window.__fadeOut = () => {
                document.body.classList.add('fading');
                return new Promise(r => setTimeout(r, 420));
            };
        </script>
    </body></html>`
}

function show({ serial, rect, mirrorTitle }) {
    hide(serial)
    if (!rect || rect.w < 80 || rect.h < 80) return null

    const cssRect = _deviceToCss(rect)           // device px → CSS/DIP px

    const win = new BrowserWindow({
        x: cssRect.x, y: cssRect.y, width: cssRect.w, height: cssRect.h,
        frame: false,
        transparent: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        focusable: false,
        hasShadow: false,
        backgroundColor: '#0a0a0a',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch (_) {}
    try { win.setIgnoreMouseEvents(true) } catch (_) {}
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(mirrorTitle)))

    overlays.set(serial, win)
    hideTimers.set(serial, setTimeout(() => {
        console.warn(`[scrcpy-loading-overlay] HARD_TIMEOUT_MS reached for ${serial} — force-hiding`)
        hide(serial)
    }, HARD_TIMEOUT_MS))

    return win
}

async function hide(serial) {
    const t = hideTimers.get(serial)
    if (t) { clearTimeout(t); hideTimers.delete(serial) }
    const win = overlays.get(serial)
    if (!win || win.isDestroyed()) { overlays.delete(serial); fadingSerials.delete(serial); return }
    fadingSerials.add(serial)       // block move() calls during the fade window
    try {
        await win.webContents.executeJavaScript('window.__fadeOut && window.__fadeOut()')
    } catch (_) { /* if executeJavaScript fails just close immediately */ }
    try { win.close() } catch (_) {}
    overlays.delete(serial)
    fadingSerials.delete(serial)
}

function hideAll() {
    for (const serial of Array.from(overlays.keys())) hide(serial)
}

/**
 * Reposition an active overlay to track the REAL scrcpy window (CSS/DIP px).
 * No-op if no overlay exists for this serial (already hidden) or the rect is
 * junk. scrcpy resizes its window to the --max-size video dimensions shortly
 * after spawn, so the requested spawn rect the overlay was created at no longer
 * matches where scrcpy actually renders — without this the skeleton floats off
 * to the side / wrong size. The mirror toolbar (which already tracks scrcpy's
 * live rect every tick) calls this so the loading skeleton stays glued over the
 * actual scrcpy window until it hides.
 */
function move(serial, rect) {
    if (!rect || rect.w < 80 || rect.h < 80) return
    if (fadingSerials.has(serial)) return   // don't reposition mid-fade (macOS snap-flash)
    const win = overlays.get(serial)
    if (!win || win.isDestroyed()) return
    try {
        const x = Math.round(rect.x), y = Math.round(rect.y)
        const width = Math.round(rect.w), height = Math.round(rect.h)
        const cur = win.getBounds()
        if (cur.x === x && cur.y === y && cur.width === width && cur.height === height) return
        win.setBounds({ x, y, width, height })
    } catch (_) {}
}

module.exports = { show, hide, hideAll, move }
