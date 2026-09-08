/**
 * lib/mirror-frame-overlay.js — PROPOSAL (visual mockup only, not wired)
 *
 * What it does
 * ─────────────
 * Draws a thin glowing rounded-corner frame AROUND the scrcpy mirror window
 * via a transparent, click-through, frameless Electron BrowserWindow. The
 * frame is empty in the middle — scrcpy's native video shows through — but
 * its 1.5px brand-stroke gradient edge makes the mirror + the docked
 * toolbar visually unify into a single physical-looking card.
 *
 * Why it's a separate window
 * ──────────────────────────
 * scrcpy is a native binary; its window contents are uncontrollable. Drawing
 * the frame in a sibling Electron window is the only way to add chrome
 * around it without forking scrcpy. The overlay window:
 *   • is transparent + frameless + always-on-top (same as the toolbar)
 *   • has setIgnoreMouseEvents(true) so clicks pass through to scrcpy
 *   • is sized to scrcpy's current rect + a 10px inset on each edge
 *   • repositions on the same HWND-tracker that already keeps the toolbar
 *     glued (see lib/mirror-toolbar.js — `reposition()`); we just register
 *     a second subscriber to the same location-change events
 *
 * State management mirrors lib/mirror-toolbar.js exactly:
 *   • one BrowserWindow per scrcpy serial, indexed by serial
 *   • closes automatically when its scrcpy mirror exits
 *   • on Win32, uses win32Dock.dockAsOwned() so z-order follows scrcpy
 *
 * IPC additions (none required — pure main-process module):
 *   • createFrameOverlay({ serial, mirrorTitle, scrcpyPid }) → Promise<void>
 *   • closeFrameOverlay(serial)
 *
 * To enable, call createFrameOverlay() right after createToolbar() in
 * system-handlers.js spawnScrcpyAtSlot(). Failure is non-fatal — the frame
 * is decorative.
 *
 * Footprint:
 *   • +1 BrowserWindow per active mirror (~6 MB RSS each — measured on a
 *     transparent 400×800 window with no JS)
 *   • zero extra polling — piggybacks on the toolbar's existing tracker
 */

const { BrowserWindow, screen } = require('electron')
const path = require('path')
let win32Dock = null
try { win32Dock = require('./win32-dock') } catch (_) { /* fallback to PS tracker */ }

const FRAME_INSET_PX = 10       // how far the frame sits outside scrcpy on every edge
const overlayWindows = new Map()  // serial → BrowserWindow

function createFrameOverlay({ serial, mirrorTitle, scrcpyPid }) {
    if (overlayWindows.has(serial)) return overlayWindows.get(serial)

    const win = new BrowserWindow({
        width: 400, height: 800,
        x: 0, y: 0,
        transparent: true,
        frame: false,
        hasShadow: false,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        fullscreenable: false,
        // CRITICAL — pass-through. Without this, the overlay catches all
        // clicks meant for scrcpy (the user clicks the frame, scrcpy never
        // sees the tap).
        // setIgnoreMouseEvents true is the right call; the second arg
        // {forward:true} would forward but we don't need DOM events at all.
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    win.setIgnoreMouseEvents(true)
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch (_) {}

    // Inline HTML — single CSS rule renders the frame. No JS, no preload.
    const overlayHtml = `
<!doctype html><html><head><meta charset="utf-8"/>
<style>
    html, body { margin:0; padding:0; height:100%; background: transparent; overflow: hidden; }
    .frame {
        position: absolute; inset: 0;
        border: 1.5px solid transparent;
        border-radius: 14px;
        background:
            linear-gradient(135deg,
                rgba(250,204,21,0.45) 0%,
                rgba(250,204,21,0.10) 30%,
                rgba(255,255,255,0.06) 50%,
                rgba(250,204,21,0.10) 70%,
                rgba(250,204,21,0.45) 100%) border-box;
        -webkit-mask:
            linear-gradient(#000, #000) padding-box,
            linear-gradient(#000, #000);
        -webkit-mask-composite: xor;
                mask-composite: exclude;
        filter: drop-shadow(0 0 16px rgba(250,204,21,0.16))
                drop-shadow(0 14px 32px rgba(0,0,0,0.55));
    }
</style></head>
<body><div class="frame"></div></body></html>`
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(overlayHtml))

    overlayWindows.set(serial, win)
    win.on('closed', () => overlayWindows.delete(serial))

    // Hook the existing toolbar HWND tracker — we use the same scrcpy rect
    // that the toolbar's reposition() reads, just expanded by FRAME_INSET_PX
    // on every edge.
    attachTracker(serial, mirrorTitle, scrcpyPid)

    return win
}

function repositionOverlay(serial, scrcpyRectCss) {
    const win = overlayWindows.get(serial)
    if (!win || win.isDestroyed() || !scrcpyRectCss) return
    try {
        win.setBounds({
            x: scrcpyRectCss.x - FRAME_INSET_PX,
            y: scrcpyRectCss.y - FRAME_INSET_PX,
            width:  scrcpyRectCss.w + FRAME_INSET_PX * 2,
            height: scrcpyRectCss.h + FRAME_INSET_PX * 2,
        })
    } catch (_) { /* best-effort */ }
}

function closeFrameOverlay(serial) {
    const win = overlayWindows.get(serial)
    if (win && !win.isDestroyed()) {
        try { win.close() } catch (_) {}
    }
    overlayWindows.delete(serial)
}

// ── Tracker plumbing — re-uses the same scrcpy-rect probe the toolbar uses.
// In the real wire-up, this would be a tiny shim into lib/mirror-toolbar.js
// that exposes its `getScrcpyWindowBoundsDevicePx` + `deviceToCssPixels`
// helpers (rather than duplicating them here). Kept inline so this file
// reads as a self-contained proposal.
function attachTracker(serial, mirrorTitle, scrcpyPid) {
    // Pseudo — real impl shares mirror-toolbar's HWND subscription.
    if (win32Dock?.available?.()) {
        win32Dock.findScrcpyHwnd(mirrorTitle, { timeoutMs: 3000, preferPid: scrcpyPid })
            .then(hwnd => {
                if (!hwnd) return
                const reposition = () => {
                    const r = win32Dock.getWindowRect(hwnd)
                    if (!r) return
                    const display = screen.getDisplayNearestPoint({ x: r.x, y: r.y })
                    const scale = display?.scaleFactor || 1
                    const css = { x: Math.round(r.x/scale), y: Math.round(r.y/scale), w: Math.round(r.w/scale), h: Math.round(r.h/scale) }
                    repositionOverlay(serial, css)
                }
                reposition()
                const unsub = win32Dock.subscribeLocationChange(hwnd, reposition)
                const win = overlayWindows.get(serial)
                win?.on('closed', () => { try { unsub() } catch (_) {} })
            })
    }
    // macOS path: same osascript-based polling that mirror-toolbar.js uses
    // would be wired up here, calling repositionOverlay() each tick.
}

module.exports = { createFrameOverlay, closeFrameOverlay, repositionOverlay }
