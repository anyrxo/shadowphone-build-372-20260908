'use strict';

function parseHwndBuffer(buf) {
  if (!buf || buf.length === 0) return 0n;
  if (buf.length >= 8) return buf.readBigUInt64LE(0);
  if (buf.length === 4) return BigInt(buf.readUInt32LE(0));
  // Pad short buffer to 4 bytes
  const padded = Buffer.alloc(4);
  buf.copy(padded);
  return BigInt(padded.readUInt32LE(0));
}

const isWin = process.platform === 'win32';

let koffi = null;
let user32 = null;
let bound = null;
let loadError = null;

function loadKoffi() {
  if (koffi || loadError) return;
  if (!isWin) { loadError = 'non-win32'; return; }
  try {
    koffi = require('koffi');
    // Define callback prototype before binding — required for koffi.register() in v3
    koffi.proto('int __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)');
    koffi.proto('void __stdcall WINEVENTPROC(void *hWinEventHook, uint32 event, void *hwnd, int32 idObject, int32 idChild, uint32 idEventThread, uint32 dwmsEventTime)');
    user32 = koffi.load('user32.dll');
    bound = {
      EnumWindows:           user32.func('int __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)'),
      GetWindowTextW:        user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ uint16_t *lpString, int nMaxCount)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)'),
      IsWindowVisible:       user32.func('int __stdcall IsWindowVisible(void *hWnd)'),
      GetWindowRect:         user32.func('int __stdcall GetWindowRect(void *hWnd, _Out_ int32 *lpRect)'),
      GetWindowLongPtrW:     user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)'),
      SetWindowLongPtrW:     user32.func('intptr_t __stdcall SetWindowLongPtrW(void *hWnd, int nIndex, intptr_t dwNewLong)'),
      SetParent:             user32.func('void* __stdcall SetParent(void *hWndChild, void *hWndNewParent)'),
      SetWindowPos:          user32.func('int __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)'),
      SetWinEventHook:       user32.func('void* __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, void *hmodWinEventProc, void *pfnWinEventProc, uint32 idProcess, uint32 idThread, uint32 dwFlags)'),
      UnhookWinEvent:        user32.func('int __stdcall UnhookWinEvent(void *hWinEventHook)'),
    };
  } catch (e) {
    loadError = e?.message || String(e);
    koffi = null;
    user32 = null;
    bound = null;
  }
}

function available() {
  loadKoffi();
  return !!bound;
}

// Constants from WinUser.h
const GWL_STYLE = -16;
const GWLP_HWNDPARENT = -8;  // Sets OWNER (not parent) for top-level windows
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_CAPTION = 0x00C00000;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
const EVENT_SYSTEM_FOREGROUND = 0x0003;
const WINEVENT_OUTOFCONTEXT = 0x0000;

function getElectronHwnd(electronWindow) {
  if (!electronWindow || typeof electronWindow.getNativeWindowHandle !== 'function') return 0n;
  try {
    const buf = electronWindow.getNativeWindowHandle();
    return parseHwndBuffer(buf);
  } catch (_) {
    return 0n;
  }
}

function hwndToPtr(hwnd) {
  // koffi expects void* (pointer); BigInt → Number is lossy for large addresses,
  // but on x64 Windows HWNDs are 32-bit values upcast to 64-bit. Real HWND
  // values in practice fit in 32 bits.
  if (typeof hwnd === 'bigint') return koffi.as(Number(hwnd), 'void *');
  return koffi.as(hwnd, 'void *');
}

function getWindowRect(hwnd) {
  loadKoffi();
  if (!bound || !hwnd) return null;
  const rect = [0, 0, 0, 0]; // [left, top, right, bottom]
  const ok = bound.GetWindowRect(hwndToPtr(hwnd), rect);
  if (!ok) return null;
  const [L, T, R, B] = rect;
  if (R - L < 1 || B - T < 1) return null;
  return { x: L, y: T, w: R - L, h: B - T };
}

function enumWindowsOnce(opts = {}) {
  // 2.19.7: opts.includeHidden — by default we still filter to visible windows
  // (90%+ of callers want only on-screen targets), but findScrcpyHwnd needs to
  // see scrcpy windows BEFORE they become visible. On Tailscale-attached
  // phones scrcpy boots adb -> push server -> first frame in 3-5s; during
  // that window the scrcpy HWND exists but IsWindowVisible is still false,
  // so the visible-only filter missed it and dock fell back to PowerShell
  // tracking with theoretical coords. Anyro hit this 2026-05-26 — toolbar
  // overlapping the mirror because PS tracker hadn't run yet.
  loadKoffi();
  if (!bound) return [];
  const includeHidden = !!opts.includeHidden;
  const results = [];
  const cb = koffi.register(
    (hwnd, _lParam) => {
      if (!includeHidden && !bound.IsWindowVisible(hwnd)) return 1;
      const buf = Buffer.alloc(512);  // 256 UTF-16 chars
      const n = bound.GetWindowTextW(hwnd, buf, 256);
      if (n > 0) {
        const title = buf.slice(0, n * 2).toString('utf16le');
        results.push({ hwnd, title });
      }
      return 1; // keep enumerating
    },
    'WNDENUMPROC *'
  );
  try { bound.EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return results;
}

async function findScrcpyHwnd(title, opts = {}) {
  loadKoffi();
  if (!bound || !title) return null;
  // 2.19.7: bump default timeout 3000 -> 8000. On Tailscale-attached phones
  // scrcpy's window-visible event lands ~3-5s after spawn (ADB connect +
  // server push + first frame). The old 3s timeout often expired before
  // visibility, dock fell back to PowerShell tracker, and the toolbar
  // showed at theoretical coords (overlapping the mirror) until tracker's
  // first poll repositioned it. Anyro hit this on 2026-05-26.
  const timeoutMs = opts.timeoutMs || 8000;
  const intervalMs = 200;
  const deadline = Date.now() + timeoutMs;
  const preferPid = opts.preferPid || null;
  // Self-exclusion: the Electron toolbar BrowserWindow must never be mistaken
  // for scrcpy. Title heuristic covers the runtime title ('Toolbar · NICK'),
  // but in the pre-renderer-JS window the toolbar's static HTML <title> is
  // 'Mirror toolbar' — so also exclude that literal. The PID check below is
  // the title-agnostic real fix; this is cheap belt-and-suspenders.
  const isNotScrcpy = (w) =>
    w.title.startsWith('Toolbar') ||
    w.title.startsWith('Toolbar ') ||
    w.title.startsWith('Toolbar·') ||
    w.title === 'Mirror toolbar' ||
    w.title.startsWith('Mirror toolbar');
  while (Date.now() < deadline) {
    // 2.19.7: include hidden windows when we have a preferPid — the scrcpy
    // window may exist but not yet be IsWindowVisible. PID match still
    // identifies it correctly. For title-only matching we keep the
    // visible-only default to avoid grabbing some background scrcpy
    // process from a prior session.
    // Title-agnostic self-exclusion: any window owned by THIS Electron main
    // process (process.pid) is one of our BrowserWindows (toolbar/fleet), never
    // scrcpy — scrcpy is a separately spawned process. This holds even before
    // the toolbar's renderer JS has set its runtime title, so the static
    // 'Mirror toolbar' window can't be matched as a scrcpy candidate.
    const selfPidOut = [0];
    const wins = enumWindowsOnce({ includeHidden: !!preferPid }).filter(w => {
      if (isNotScrcpy(w)) return false;
      try {
        bound.GetWindowThreadProcessId(hwndToPtr(w.hwnd), selfPidOut);
        if (selfPidOut[0] === process.pid) return false;
      } catch (_) {}
      return true;
    });
    // 2.16.6: prefer match by PID when caller knows the scrcpy spawn PID.
    // Eliminates the stale-HWND bug where an old scrcpy from a previous
    // session got matched first because EnumWindows returned it before
    // the newly-spawned one.
    if (preferPid) {
      const pidOut = [0];
      for (const w of wins) {
        try {
          bound.GetWindowThreadProcessId(hwndToPtr(w.hwnd), pidOut);
          if (pidOut[0] === preferPid) return w.hwnd;
        } catch (_) {}
      }
    }
    // Title-based fallback (with NEWEST-HWND tie-break).
    let candidates = wins.filter(w => w.title === title);
    if (candidates.length === 0) {
      const parts = title.split(' ');
      const tail = parts[parts.length - 1];
      if (tail && tail.length >= 4) {
        candidates = wins.filter(w => w.title.endsWith(tail));
      }
    }
    // 2.x: IPv4 fallback for wireless / `adb connect <ip>:<port>` devices.
    // scrcpy's window title for a TCP device drifts between the resolved
    // "<peer> · <ip>" form and the raw "<ip>:<port>" form for the SAME window,
    // so a caller searching with one form misses a window titled with the other
    // — the tail match above only catches the "<peer> · <ip>" → bare-<ip> case,
    // NOT a search for raw "<ip>:<port>" (the _ensureSidebarForRunning sidebar
    // re-create passes the raw serial while scrcpy is titled "<peer> · <ip>",
    // so dock failed and the sidebar showed undocked/behind the mirror). Both
    // forms carry the same IPv4 — match on that.
    if (candidates.length === 0) {
      const ipOf = (s) => (String(s).match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/) || [])[0];
      const wantIp = ipOf(title);
      if (wantIp) candidates = wins.filter(w => ipOf(w.title) === wantIp);
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const ah = typeof a.hwnd === 'bigint' ? Number(a.hwnd) : Number(a.hwnd);
        const bh = typeof b.hwnd === 'bigint' ? Number(b.hwnd) : Number(b.hwnd);
        return bh - ah; // highest HWND first = most-recently-created window
      });
      return candidates[0].hwnd;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

function dockAsChild(childHwnd, parentHwnd) {
  loadKoffi();
  if (!bound || !childHwnd || !parentHwnd) return false;
  try {
    const child = hwndToPtr(childHwnd);
    const parent = hwndToPtr(parentHwnd);
    // 1. Read current style
    const oldStyle = bound.GetWindowLongPtrW(child, GWL_STYLE);
    // 2. Strip WS_POPUP, add WS_CHILD. Use bitwise ops on Number; Win32
    // style values fit in 32 bits so this is safe even on x64.
    const cleared = (Number(oldStyle) & ~WS_POPUP) >>> 0;
    const newStyle = (cleared | WS_CHILD) >>> 0;
    bound.SetWindowLongPtrW(child, GWL_STYLE, newStyle);
    // 3. Reparent
    bound.SetParent(child, parent);
    // 4. Force frame refresh so the style change takes visible effect
    bound.SetWindowPos(child, null, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    return true;
  } catch (e) {
    console.warn('[win32-dock] dockAsChild failed:', e?.message || e);
    return false;
  }
}

// 2.16.1: dockAsOwned uses GWLP_HWNDPARENT to make the toolbar an OWNED
// (not child) window of scrcpy. Key difference from SetParent + WS_CHILD:
// the toolbar stays a top-level window with screen-absolute coordinates
// (no clipping to scrcpy's client area), so it can sit OUTSIDE scrcpy's
// bounds. Owner semantics still give us: closing scrcpy closes toolbar,
// minimizing scrcpy minimizes toolbar (Win7+), toolbar always above scrcpy.
function dockAsOwned(ownedHwnd, ownerHwnd) {
  loadKoffi();
  if (!bound || !ownedHwnd || !ownerHwnd) return false;
  try {
    const owned = hwndToPtr(ownedHwnd);
    // No style swap needed — GWLP_HWNDPARENT changes ownership without
    // touching WS_POPUP / WS_CHILD. The toolbar stays a top-level popup.
    bound.SetWindowLongPtrW(owned, GWLP_HWNDPARENT, Number(ownerHwnd));
    // MSDN: after SetWindowLongPtrW you MUST call SetWindowPos(SWP_FRAMECHANGED)
    // to force DWM to revalidate the compositor surface for the new owner chain.
    // Without this the swap chain stays stale → black window (backgroundColor only).
    // dockAsChild already does this with the same flags; this brings dockAsOwned
    // in line with it.
    bound.SetWindowPos(owned, null, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    return true;
  } catch (e) {
    console.warn('[win32-dock] dockAsOwned failed:', e?.message || e);
    return false;
  }
}

// Move a top-level window to absolute screen coords (DEVICE pixels) WITHOUT
// resizing, re-z-ordering, or activating it. Used to drag the scrcpy mirror by
// the same delta the user dragged the toolbar header. No-op (returns false) if
// the binding is unavailable or the hwnd is missing — matches the defensive
// guard style of the other helpers so non-win32 / missing-koffi paths degrade
// gracefully instead of throwing.
function moveWindow(hwnd, x, y) {
  loadKoffi();
  if (!bound || !hwnd) return false;
  try {
    const ok = bound.SetWindowPos(hwndToPtr(hwnd), null, x | 0, y | 0, 0, 0,
      SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    return !!ok;
  } catch (e) {
    console.warn('[win32-dock] moveWindow failed:', e?.message || e);
    return false;
  }
}

function subscribeLocationChange(parentHwnd, onChange) {
  loadKoffi();
  if (!bound || !parentHwnd) return () => {};
  const pidOut = [0];
  bound.GetWindowThreadProcessId(hwndToPtr(parentHwnd), pidOut);
  const pid = pidOut[0] || 0;

  // The hook fires EVENT_OBJECT_LOCATIONCHANGE for EVERY object in the target
  // process — caret/cursor/child-control moves included — which at fleet scale
  // is an FFI storm. Filter to top-level window events for the scrcpy window
  // itself: idObject===OBJID_WINDOW(0) && idChild===CHILDID_SELF(0) drops
  // caret/cursor/child events, and gating on hwnd===parentHwnd drops moves of
  // any other top-level window in the process. We don't read the rect here —
  // reposition() (mirror-toolbar.js) ignores any passed rect and re-reads
  // getWindowRect(scrcpyHwnd) itself, so a read here is pure waste and was
  // also reading the wrong object. The 1s safety poll covers any missed move,
  // so suppressing child events cannot cause drift.
  const OBJID_WINDOW = 0;
  const CHILDID_SELF = 0;
  const parentPtrNum = typeof parentHwnd === 'bigint' ? Number(parentHwnd) : Number(parentHwnd);
  const cb = koffi.register(
    (_hook, _event, hwnd, idObject, idChild /*, _idEventThread, _dwmsEventTime*/) => {
      try {
        if (idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF) return;
        const hwndNum = typeof hwnd === 'bigint' ? Number(hwnd) : Number(hwnd);
        if (hwndNum !== parentPtrNum) return;
        onChange();
      } catch (_) { /* swallow */ }
    },
    'WINEVENTPROC *'
  );

  const hook = bound.SetWinEventHook(
    EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE,
    null, cb,
    pid, 0,
    WINEVENT_OUTOFCONTEXT
  );

  let active = !!hook;
  if (!active) {
    try { koffi.unregister(cb); } catch (_) {}
    return () => {};
  }
  return function unsubscribe() {
    if (!active) return;
    active = false;
    try { bound.UnhookWinEvent(hook); } catch (_) {}
    try { koffi.unregister(cb); } catch (_) {}
  };
}

// Fires onForeground whenever a window belonging to `pid` becomes the
// foreground window. Used by the mirror sidebar to ride the scrcpy window's
// z-order (raise itself when the mirror is focused) WITHOUT owner-docking —
// GWLP_HWNDPARENT onto scrcpy's D3D window group makes the Electron window's
// DWM swap-chain never present (permanent black sidebar, see 3a58749e).
function subscribeForeground(pid, onForeground) {
  loadKoffi();
  if (!bound || !pid) return () => {};
  const OBJID_WINDOW = 0;
  const CHILDID_SELF = 0;
  const cb = koffi.register(
    (_hook, _event, _hwnd, idObject, idChild /*, _idEventThread, _dwmsEventTime*/) => {
      try {
        if (idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF) return;
        onForeground();
      } catch (_) { /* swallow */ }
    },
    'WINEVENTPROC *'
  );
  const hook = bound.SetWinEventHook(
    EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
    null, cb,
    pid, 0,
    WINEVENT_OUTOFCONTEXT
  );
  let active = !!hook;
  if (!active) {
    try { koffi.unregister(cb); } catch (_) {}
    return () => {};
  }
  return function unsubscribe() {
    if (!active) return;
    active = false;
    try { bound.UnhookWinEvent(hook); } catch (_) {}
    try { koffi.unregister(cb); } catch (_) {}
  };
}

module.exports = {
  parseHwndBuffer,
  available,
  getElectronHwnd,
  getWindowRect,
  findScrcpyHwnd,
  dockAsChild,
  dockAsOwned,
  moveWindow,
  subscribeLocationChange,
  subscribeForeground,
};
