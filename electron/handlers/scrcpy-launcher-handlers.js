'use strict';
const { ipcMain, screen } = require('electron');
const { spawnScrcpyForDevice, computeGridPositions } = require('../lib/scrcpy-spawn-native');
const { getTailscaleDeniedReason, getTailscaleStatus } = require('../lib/tailscale-status');
const { runAdb } = require('../lib/adb-util');

function findAdbPath(getAdbPath) {
  if (typeof getAdbPath === 'function') {
    const p = getAdbPath();
    if (p) return p;
  }
  return 'adb';
}

async function adbConnect(adbPath, target) {
  const result = await runAdb(adbPath, ['connect', target], 5000);
  return { ok: result.code === 0, stdout: result.stdout.trim(), error: result.stderr || result.error || null };
}

async function tailscaleRouteDeniedReason() {
  try {
    return getTailscaleDeniedReason(await getTailscaleStatus());
  } catch (error) {
    return error?.message || 'Tailscale status unavailable';
  }
}

function initScrcpyLauncherHandlers(opts = {}) {
  const getAdbPath = opts.getAdbPath;
  const getPhones = opts.getPhones || (async () => []);
  const resourcesPath = opts.resourcesPath || process.resourcesPath;

  ipcMain.handle('scrcpy:launch', async (_evt, payload) => {
    const { tailnetIp, port = 5555, title, udid } = payload || {};
    if (!tailnetIp) return { ok: false, error: 'tailnetIp required' };
    const tailscaleError = await tailscaleRouteDeniedReason();
    if (tailscaleError) return { ok: false, error: `Tailscale route unavailable: ${tailscaleError}`, code: 'tailscale-unavailable' };
    const adbPath = findAdbPath(getAdbPath);
    const target = `${tailnetIp}:${port}`;
    const conn = await adbConnect(adbPath, target);
    if (!conn.ok) return { ok: false, error: `adb connect failed: ${conn.error || conn.stdout}` };
    const r = spawnScrcpyForDevice({ tailnetIp, port, title: title || udid || target, resourcesPath });
    if (!r.ok || !r.pid) {
      // scrcpy missing / spawn failed — surface it so the SPA can offer install
      // (via the existing check-scrcpy / install-scrcpy IPC) instead of showing
      // a false success with an empty mirror.
      return { ok: false, error: r.error || 'scrcpy launch failed', code: r.code || 'scrcpy-launch-failed' };
    }
    return { ok: true, pid: r.pid };
  });

  ipcMain.handle('scrcpy:launch-tiled-all', async () => {
    // 2.17.15: route every Tile All launch through launchScrcpyForSerial
    // (the shared launcher in system-handlers.js) so each phone gets:
    //   - adb-connect with auth recovery (2.17.14)
    //   - the docked sidebar toolbar
    //   - alreadyRunning detection (no duplicate scrcpy spawns)
    //   - tailnet/usb routing + bookkeeping
    // The old direct spawnScrcpyForDevice path bypassed all of that, so
    // Tile All produced naked mirrors with no sidebar.
    const tailscaleError = await tailscaleRouteDeniedReason();
    if (tailscaleError) return { ok: false, error: `Tailscale route unavailable: ${tailscaleError}`, code: 'tailscale-unavailable' };
    const phones = await getPhones();
    const tailnetPhones = phones.filter(p => p.tailnetIp);
    if (tailnetPhones.length === 0) return { ok: false, error: 'no phones on tailnet' };
    let shared = null;
    try { shared = require('./system-handlers').launchScrcpyForSerial; } catch (_) {}
    if (typeof shared !== 'function') {
      return { ok: false, error: 'shared launcher unavailable' };
    }
    const spawned = [];
    const failed = [];
    for (const ph of tailnetPhones) {
      const target = `${ph.tailnetIp}:${ph.port || 5555}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await shared(target);
        if (r?.success) spawned.push({ udid: ph.udid, target });
        else failed.push({ udid: ph.udid, target, error: r?.error || 'launch failed' });
      } catch (e) {
        failed.push({ udid: ph.udid, target, error: e?.message || String(e) });
      }
    }
    return { ok: spawned.length > 0, spawned, failed };
  });

  ipcMain.handle('tailscale:status', async () => {
    return await getTailscaleStatus();
  });
}

module.exports = { initScrcpyLauncherHandlers };
