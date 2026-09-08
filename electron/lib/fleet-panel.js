'use strict';
const path = require('node:path');
const { BrowserWindow, shell } = require('electron');

let fleetWin = null;

function openFleetPanel(opts = {}) {
  if (fleetWin && !fleetWin.isDestroyed()) {
    fleetWin.show();
    fleetWin.focus();
    // Already open — still honor a request to surface the Settings view.
    if (opts.openSettings) {
      try { fleetWin.webContents.executeJavaScript('window.openSettingsModal && window.openSettingsModal()'); } catch (_) {}
    }
    return fleetWin;
  }
  fleetWin = new BrowserWindow({
    width: 520,
    height: 640,
    title: 'ShadowPhone Fleet',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'fleet-panel-preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  });
  // Security: deny in-Electron popups. target=_blank / window.open for an
  // external link (e.g. the tailscale.com link in fleet-panel.html) opens in
  // the system browser instead. Mirrors mainWindow's handler in main.js.
  fleetWin.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      }
    } catch (_) {
      // Malformed URL â€” ignore
    }
    return { action: 'deny' };
  });
  // Security: this is a static local page â€” block any navigation off file://
  // so injected content can never point this nodeIntegration window at a
  // remote origin.
  fleetWin.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  fleetWin.loadFile(path.join(__dirname, '..', 'fleet-panel.html'),
    opts.openSettings ? { query: { openSettings: '1' } } : undefined);
  fleetWin.on('closed', () => { fleetWin = null; });
  return fleetWin;
}

function getFleetPanelWindow() {
  return fleetWin && !fleetWin.isDestroyed() ? fleetWin : null;
}

function broadcastToFleetPanel(channel, payload) {
  const w = getFleetPanelWindow();
  if (w) { try { w.webContents.send(channel, payload); } catch (_) {} }
}

module.exports = { openFleetPanel, getFleetPanelWindow, broadcastToFleetPanel };
