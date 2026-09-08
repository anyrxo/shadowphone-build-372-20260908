/**
 * lib/scheduler-drawer.js — PROPOSAL (not wired)
 *
 * Companion to lib/mirror-toolbar.js. When the operator clicks the
 * "expand" button on the schedule header in the toolbar, the toolbar
 * window widens by SCHED_DRAWER_WIDTH pixels (in addition to the logs
 * panel width, if open) and the schedule UI re-flows into a wider 3-col
 * horizontal layout (STEPS | IG MODULES | POST SLOTS).
 *
 * Why
 * ───
 * The 156-px sidebar is brutal for the scheduler's 8 steps + 9 IG modules
 * + slot grid + countdown + run/save/pause. Scrolling vertically through
 * every toggle is annoying. A wider, horizontal drawer gives back
 * real-estate without needing a separate window.
 *
 * How it ships
 * ────────────
 * 1. mirror-toolbar.html's existing JS sets body[data-sched-drawer="open"]
 *    on the toolbar's webContents (already done).
 * 2. That JS calls window.toolbar.toggleSchedulerPanel(true|false) — a new
 *    IPC method (see ipc additions below).
 * 3. The main process resizes the toolbar BrowserWindow's width:
 *      toolbarWindow.setBounds({ x, y, width: w + delta, height })
 *    where delta = SCHED_DRAWER_WIDTH = 540 px.
 * 4. On close, restore width.
 * 5. Window repositioning continues to work via the existing HWND tracker
 *    — we only changed the width.
 *
 * Constants
 * ─────────
 *   SCHED_DRAWER_WIDTH = 540 px (matches the CSS rule in mirror-toolbar.html)
 *
 * IPC additions
 * ─────────────
 *   toolbar-preload.js
 *     window.toolbar.toggleSchedulerPanel(open: boolean) → Promise<{ok:true}>
 *   handlers/system-handlers.js (or a new schedule-drawer-handlers.js)
 *     ipcMain.handle('toolbar:toggle-scheduler-panel', (e, open) => …)
 *
 * No other DOM ids or IPC methods are added. The drawer's CSS-only
 * implementation in mirror-toolbar.html means the visual swap works in
 * the iframe preview even without the IPC wired — the only thing that's
 * missing in the preview is the actual window resize.
 *
 * Failure modes / edge cases
 * ──────────────────────────
 * - If the toolbar window can't grow (screen edge), the main process
 *   should shift the window left first, then widen. The existing dock
 *   code already handles this for the logs panel — copy that pattern.
 * - When BOTH logs panel + scheduler drawer are open, total width is
 *   156 + 360 + 540 = 1056 px. On a 1280-px screen with a 360-wide
 *   scrcpy mirror to the left, that hits the right edge. Either: (a)
 *   make logs + drawer mutually exclusive (closing logs when drawer
 *   opens), or (b) let the operator open both and accept the squeeze.
 *   Both are valid product choices — recommend (a) for first ship.
 */

const SCHED_DRAWER_WIDTH = 540

let baselineWidth = null  // remembered width before drawer opened, restored on close

async function toggleSchedulerPanel(toolbarWindow, open) {
    if (!toolbarWindow || toolbarWindow.isDestroyed()) return { ok: false, reason: 'no-window' }
    const cur = toolbarWindow.getBounds()
    if (open) {
        if (baselineWidth == null) baselineWidth = cur.width
        const delta = SCHED_DRAWER_WIDTH
        // Try to widen in place; if not enough room, shift left.
        const display = require('electron').screen.getDisplayNearestPoint({ x: cur.x, y: cur.y })
        const workArea = display.workArea
        let newX = cur.x
        const desiredRight = cur.x + cur.width + delta
        if (desiredRight > workArea.x + workArea.width) {
            newX = Math.max(workArea.x, workArea.x + workArea.width - cur.width - delta)
        }
        toolbarWindow.setBounds({ x: newX, y: cur.y, width: cur.width + delta, height: cur.height })
    } else {
        if (baselineWidth != null) {
            toolbarWindow.setBounds({ x: cur.x, y: cur.y, width: baselineWidth, height: cur.height })
            baselineWidth = null
        } else {
            toolbarWindow.setBounds({ x: cur.x, y: cur.y, width: cur.width - SCHED_DRAWER_WIDTH, height: cur.height })
        }
    }
    return { ok: true, open }
}

module.exports = { toggleSchedulerPanel, SCHED_DRAWER_WIDTH }
