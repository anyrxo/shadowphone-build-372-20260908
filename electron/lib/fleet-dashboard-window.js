'use strict';
// Opens the sp-core models-dashboard.html as a per-device child window.
// Clone of lib/fleet-panel.js — separate nodeIntegration window (the dashboard's
// inline require('electron')/require('./lib/...') calls need no preload bridge),
// leaving prod's hardened remote-SPA main window untouched. Per-device scope is
// passed via --sp-serial and filtered in the HTML's load().
//
// v3.2.20 CUTOVER: the React dashboard is now the DEFAULT. Kill-switches to the
// classic HTML one:  env SP_REACT_DASHBOARD=0  OR  app-setting react_dashboard:false
// (the Fleet → Settings toggle, now default-on). env SP_REACT_DASHBOARD=1 forces React.
const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, shell, app } = require('electron');

function _isReactDash() {
  if (process.env.SP_REACT_DASHBOARD === '1') return true;
  if (process.env.SP_REACT_DASHBOARD === '0') return false; // env kill-switch → classic HTML
  try {
    const p = path.join(app.getPath('userData'), 'app-settings.json');
    if (!fs.existsSync(p)) return true; // no settings yet → React (default)
    const v = JSON.parse(fs.readFileSync(p, 'utf8') || '{}')['react_dashboard'];
    return v !== false && v !== 'false'; // only an EXPLICIT false reverts to classic
  } catch (_) { return true; }
}

let win = null;
let winMode = null; // 'react' | 'html' the cached window was built in

function openModelsDashboard({ serial } = {}) {
  const REACT_DASH = _isReactDash();
  const mode = REACT_DASH ? 'react' : 'html';
  if (win && !win.isDestroyed()) {
    if (winMode === mode) { win.show(); win.focus(); return win; }
    // Mode changed (operator flipped the Settings toggle) — recreate so the NEW
    // UI actually loads, instead of re-showing the stale window. This is the
    // "ticked the toggle + Save did nothing" fix: the cached window was reused.
    try { win.destroy(); } catch (_) {}
    win = null;
  }
  winMode = mode;
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: serial ? `Models — ${serial}` : 'Models Dashboard',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      additionalArguments: serial ? [`--sp-serial=${serial}`] : [],
    },
  });
  // Defense-in-depth navigation guards (mirrors mainWindow in main.js:680/703).
  // This window runs nodeIntegration:true, so any navigation to an attacker
  // origin would be a direct RCE pivot. Lock it to the local dashboard file and
  // shunt external links to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });
  const dashUrl = REACT_DASH
    ? require('node:url').pathToFileURL(path.join(__dirname, '..', 'renderer', 'models-dashboard-app', 'index.html')).href
    : require('node:url').pathToFileURL(path.join(__dirname, '..', 'models-dashboard.html')).href;
  win.webContents.on('will-navigate', (event, url) => {
    if (url === dashUrl) return; // allow self/reload
    event.preventDefault();
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url);
    } catch {}
  });
  if (REACT_DASH) {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'models-dashboard-app', 'index.html'));
  } else {
    win.loadFile(path.join(__dirname, '..', 'models-dashboard.html'));
  }
  win.on('closed', () => { win = null; winMode = null; });
  return win;
}

// ── Universal "Command Center" — fleet-wide, NOT device-scoped ────────────────
// A SEPARATE window (so it coexists with per-device drill-down dashboards) that
// opens the SAME React app with no --sp-serial and a --sp-universal=1 flag. The
// app renders the phone→profile→account Command Center instead of the per-device
// list. Always React (the Command Center is a React-only surface).
let universalWin = null;

function openUniversalDashboard() {
  if (universalWin && !universalWin.isDestroyed()) {
    universalWin.show();
    universalWin.focus();
    return universalWin;
  }
  const reactIndex = path.join(__dirname, '..', 'renderer', 'models-dashboard-app', 'index.html');
  if (!fs.existsSync(reactIndex)) {
    try {
      require('electron').dialog.showErrorBox('Command Center unavailable',
        'The dashboard build is missing (renderer/models-dashboard-app). Rebuild or reinstall the app.');
    } catch (_) {}
    return null;
  }
  universalWin = new BrowserWindow({
    width: 1480,
    height: 960,
    title: 'ShadowPhone — Command Center',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      additionalArguments: ['--sp-universal=1'],
    },
  });
  const dashUrl = require('node:url').pathToFileURL(reactIndex).href;
  universalWin.webContents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url); } catch {}
    return { action: 'deny' };
  });
  universalWin.webContents.on('will-navigate', (event, url) => {
    if (url === dashUrl) return;
    event.preventDefault();
    try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url); } catch {}
  });
  universalWin.loadFile(reactIndex);
  universalWin.on('closed', () => { universalWin = null; });
  return universalWin;
}

const creationWindows = new Map();

function openCreateIgAccount({ serial, userId } = {}) {
  if (typeof serial !== 'string' || !serial.trim() || !/^\d+$/.test(String(userId ?? ''))) {
    return { ok: false, error: 'Choose a connected phone and an existing profile.' };
  }
  userId = String(userId);
  const existing = creationWindows.get(serial);
  if (existing && !existing.window.isDestroyed()) {
    existing.window.show();
    existing.window.focus();
    return existing.userId === userId
      ? { ok: true }
      : { ok: false, error: `Account creation is open for profile ${existing.userId}. Finish or close that form first.` };
  }
  const reactIndex = path.join(__dirname, '..', 'renderer', 'models-dashboard-app', 'index.html');
  if (!fs.existsSync(reactIndex)) return { ok: false, error: 'Account creation is unavailable. Rebuild or reinstall the desktop app.' };
  const context = { serial, userId, name: `Profile ${userId}`, accountCount: 0 };
  const creationWindow = new BrowserWindow({
    width: 540, height: 860, minWidth: 480, minHeight: 600,
    title: `Create Instagram account — ${serial} / ${userId}`,
    backgroundColor: '#0a0a0a', autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false, nodeIntegration: true, sandbox: false,
      additionalArguments: [`--sp-create-ig=${encodeURIComponent(JSON.stringify(context))}`],
    },
  });
  creationWindows.set(serial, { window: creationWindow, userId });
  const dashUrl = require('node:url').pathToFileURL(reactIndex).href;
  creationWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  creationWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== dashUrl) event.preventDefault();
  });
  creationWindow.on('closed', () => {
    if (creationWindows.get(serial)?.window === creationWindow) creationWindows.delete(serial);
  });
  creationWindow.loadFile(reactIndex);
  return { ok: true };
}

function getDashboardWebContentsIds() {
  return [win, universalWin, ...Array.from(creationWindows.values(), item => item.window)]
    .filter(window => window && !window.isDestroyed())
    .map(window => window.webContents.id);
}

module.exports = { openModelsDashboard, openUniversalDashboard, openCreateIgAccount, getDashboardWebContentsIds };
