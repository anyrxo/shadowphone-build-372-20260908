'use strict';
/**
 * Feature 1: Wireless Add-Phone Wizard — IPC handlers.
 *
 * Registers pair:code / pair:connect / pair:qr-start / pair:qr-cancel, each
 * wrapped try/catch → { ok:false, error } exactly like the provision:* one-
 * liners in main.js. Progress for the async QR flow (and slow connect-port
 * discovery) streams to the renderer over the 'pair-progress' channel.
 *
 * Deps (integrator wires these at the init site in createWindow):
 *   getAdbPath()          - resolves the bundled adb path (never bare 'adb')
 *   mainWindow            - BrowserWindow for progress + devices broadcast
 *   getConnectedDevices() - optional; refresh the fleet after a successful pair
 *   broadcastDevices(d)   - optional; push the refreshed list to all surfaces
 */

const { ipcMain } = require('electron');
const wp = require('../lib/wireless-pair');

// Single in-flight QR session. { cancelled } is flipped by pair:qr-cancel /
// window close so the background poll bails without touching a dead window.
let _qr = null;

function initPairingHandlers(deps = {}) {
  const getAdbPath = typeof deps.getAdbPath === 'function' ? deps.getAdbPath : () => 'adb';
  const getWin = () => deps.mainWindow;

  const progress = (payload) => {
    const w = getWin();
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('pair-progress', payload); } catch (_) { /* window gone */ }
    }
  };

  // After a successful connect, refresh + broadcast the devices list so the
  // fleet/UI reflects the new phone immediately (mirrors the adb-connect
  // pattern in main.js). Best-effort — never fails the pair.
  const refreshDevices = async (endpoint) => {
    try {
      if (typeof deps.getConnectedDevices === 'function' && typeof deps.broadcastDevices === 'function') {
        const devices = await deps.getConnectedDevices();
        if (devices) deps.broadcastDevices(devices);
        return;
      }
      const w = getWin();
      if (w && !w.isDestroyed()) w.webContents.send('devices-updated', { endpoint });
    } catch (_) { /* best effort */ }
  };

  // (a) 6-digit — pair only. Renderer follows up with pair:connect.
  ipcMain.handle('pair:code', async (_e, args = {}) => {
    try {
      const { host, port, code } = args;
      return await wp.pairWithCode(getAdbPath(), host, port, code);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // (a) 6-digit — connect. `port` optional: when absent we discover it
  // (mDNS on-LAN, else a tailnet connect-scan; scan can take up to ~2 min).
  ipcMain.handle('pair:connect', async (_e, args = {}) => {
    try {
      const { ip, port, hintPort } = args;
      let connectPort = port;
      if (!connectPort) {
        progress({ phase: 'discover', message: `Finding the wireless-debugging port for ${ip}… (slow over the tailnet)` });
        const disc = await wp.discoverConnectPort(getAdbPath(), ip, { hintPort });
        if (!disc.ok) return disc;
        connectPort = disc.port;
        progress({ phase: 'discover', message: `Found connect port ${connectPort} (${disc.via})` });
      }
      const res = await wp.connect(getAdbPath(), ip, connectPort);
      if (res.ok) {
        progress({ phase: 'connected', ok: true, endpoint: res.endpoint, message: `Connected to ${res.endpoint}` });
        await refreshDevices(res.endpoint);
      }
      return res;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // (b) QR — hand the payload back immediately so the renderer can draw the
  // QR, then drive wait → pair → connect in the background over 'pair-progress'.
  ipcMain.handle('pair:qr-start', async () => {
    try {
      const session = wp.createQrSession();
      _qr = { cancelled: false };
      const mine = _qr;

      (async () => {
        progress({ phase: 'qr-wait', message: 'Waiting for the phone to scan the QR…' });
        const svc = await wp.waitForPairingService(getAdbPath(), session.name, { isCancelled: () => mine.cancelled });
        if (mine.cancelled) return;
        if (!svc.ok) { progress({ phase: 'error', ok: false, error: svc.error }); return; }

        progress({ phase: 'pairing', message: `Phone found at ${svc.ip}:${svc.port} — pairing…` });
        const paired = await wp.pairWithCode(getAdbPath(), svc.ip, svc.port, session.password);
        if (mine.cancelled) return;
        if (!paired.ok) { progress({ phase: 'error', ok: false, error: paired.error }); return; }

        progress({ phase: 'discover', message: 'Paired — finding the connect port…' });
        const disc = await wp.discoverConnectPort(getAdbPath(), svc.ip, {});
        if (mine.cancelled) return;
        if (!disc.ok) { progress({ phase: 'error', ok: false, error: disc.error }); return; }

        const res = await wp.connect(getAdbPath(), svc.ip, disc.port);
        if (mine.cancelled) return;
        if (res.ok) {
          progress({ phase: 'connected', ok: true, endpoint: res.endpoint, message: `Connected to ${res.endpoint}` });
          await refreshDevices(res.endpoint);
        } else {
          progress({ phase: 'error', ok: false, error: res.error });
        }
      })().catch(err => progress({ phase: 'error', ok: false, error: err?.message || String(err) }));

      return { ok: true, payload: session.payload, name: session.name };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('pair:qr-cancel', async () => {
    if (_qr) _qr.cancelled = true;
    _qr = null;
    return { ok: true };
  });
}

module.exports = { initPairingHandlers };
