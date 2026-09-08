'use strict';
const path = require('node:path');
const { Tray, Menu, nativeImage, shell, screen, BrowserWindow } = require('electron');
const { spawnScrcpyForDevice, computeGridPositions } = require('./scrcpy-spawn-native');
const { getTailscaleDeniedReason, getTailscaleStatus } = require('./tailscale-status');
const { runAdb } = require('./adb-util');

// Module-level opts ref populated by initScrcpyTray so sendToMainWindow
// can prefer the explicit accessor over the url-heuristic fallback.
let _trayOpts = null

// Null-safe helper that sends an IPC event to the main web window (the
// renderer loaded at /desktop). Prefers opts.getMainWindow() when wired
// (avoids the url-heuristic that misses non-file:// BrowserWindows that
// might not yet have a URL). Falls back to the existing non-file:// loop
// so nothing breaks if the accessor is absent.
function sendToMainWindow(channel, payload) {
  try {
    const w = _trayOpts?.getMainWindow?.()
    if (w && !w.isDestroyed()) { w.webContents.send(channel, payload); return }
  } catch (_) {}
  // fallback: existing non-file:// heuristic
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w || w.isDestroyed()) continue
      try {
        const url = w.webContents.getURL() || ''
        // Exclude local-file windows (fleet-panel, mirror-toolbar, dashboards)
        if (url.startsWith('file://')) continue
        w.webContents.send(channel, payload)
      } catch (_) {}
    }
  } catch (_) {}
}

let trayRef = null;
const TCP_ADB_TARGET = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/;

function isTailnetRoute(phone) {
  const identifier = String(phone?.udid || phone?.serial || '');
  return Boolean(phone?.tailnetIp || phone?.transport === 'tailscale' || TCP_ADB_TARGET.test(identifier));
}

async function _adbConnectOnce(adbPath, target, timeoutMs) {
      const result = await runAdb(adbPath, ['connect', target], timeoutMs);
      const err = result.code === 0 ? null : new Error(result.error || result.stderr || `ADB exited with ${result.code}`);
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      const combined = (stdout + '\n' + stderr).toLowerCase();
      let ok = false;
      let reason = null;
      // Daemon-starting noise is normal; ignore it when classifying.
      const meaningful = combined
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && !/^\* daemon/.test(s))
        .join('\n');
      if (err && !meaningful) {
        // execFile failed AND no meaningful output beyond daemon noise.
        reason = `adb spawn failed: ${(err.message || '').split('\n')[0].slice(0, 200)}`;
      } else if (/failed to authenticate|unauthorized/i.test(meaningful)) {
        // 2.17.13: phone hasn't whitelisted this PC's adb RSA key yet.
        // The phone shows an "Allow USB debugging from this computer?"
        // popup the first time a new client connects — needs a physical
        // tap on the phone screen. Without this detection, we returned
        // ok:true and spawned scrcpy which died with "Device is
        // unauthorized" 200ms later.
        reason = 'unauthorized — phone needs the "Allow USB debugging?" popup tapped. Wake the phone, look at its screen, tap "Always allow from this computer", then click Launch again.';
      } else if (/already connected|connected to/i.test(meaningful)) {
        ok = true;
      } else if (/actively refused|connection refused|(\b|^)10061\b/i.test(meaningful)) {
        reason = `refused — phone rebooted? \`adb tcpip 5555\` resets on reboot. Plug USB + re-run Add Phone wizard to re-enable wireless ADB.`;
      } else if (/no route to host|host unreachable|unreachable/i.test(meaningful)) {
        reason = `host unreachable — phone is offline OR Tailscale dropped on it. Open Tailscale on the phone and tap Connect.`;
      } else if (/timed out|timeout/i.test(meaningful)) {
        reason = `timed out (${timeoutMs}ms) — phone slow to respond; will retry`;
      } else if (/failed to connect|cannot connect/i.test(meaningful)) {
        // Most common cold-cache case: ".*cannot connect to 100.x.x.x:5555: ..."
        const line = meaningful.split('\n').find(l => /failed to connect|cannot connect/.test(l)) || meaningful.split('\n')[0];
        reason = `connection failed: ${line.slice(0, 200)} — check phone is on tailnet (try Diagnose)`;
      } else if (err) {
        // execFile errored but we have some meaningful output — surface that.
        reason = meaningful.split('\n')[0].slice(0, 200) || err.message.split('\n')[0].slice(0, 200);
      } else {
        // No output, no error → optimistic
        ok = true;
      }
      return { ok, stdout, stderr, reason };
}

async function adbConnect(adbPath, target) {
  // 2.17.4: retry once on timeout — first connect often gets bitten by the
  // cold adb-daemon spawn taking 3-4s on Windows. Bumped timeout 5s→8s
  // and a single 6s retry covers the daemon warm-up window cleanly.
  let res = await _adbConnectOnce(adbPath, target, 8000);
  if (res.ok) return res;
  if (res.reason && /timed out|adb spawn failed/i.test(res.reason)) {
    res = await _adbConnectOnce(adbPath, target, 6000);
  }
  return res;
}

async function buildMenuTemplate({ getPhones, getAdbPath, resourcesPath, onShowApp }) {
  const phones = await getPhones();
  const tsStatus = await getTailscaleStatus();
  const tailscaleDeniedReason = getTailscaleDeniedReason(tsStatus);
  const tailnetPhones = tailscaleDeniedReason ? [] : phones.filter(p => p.tailnetIp);
  const offTailnet = phones.filter(p => !p.tailnetIp);
  let tsLabel;
  if (!tailscaleDeniedReason) {
    tsLabel = `Tailscale: online (${tsStatus.peers?.length || 0} peers)`;
  } else {
    const friendly = tsStatus.backendState === 'Starting' ? 'starting…'
                   : tsStatus.backendState === 'NeedsLogin' ? 'logged out — open Tailscale to sign in'
                   : tsStatus.backendState === 'Stopped' ? 'daemon stopped'
                   : tailscaleDeniedReason;
    tsLabel = `Tailscale: ${friendly}`;
  }

  const template = [
    { label: 'ShadowPhone', enabled: false },
    { type: 'separator' },
    { label: tsLabel, click: () => shell.openExternal('https://login.tailscale.com/admin/machines') },
    { type: 'separator' },
  ];

  if (tailnetPhones.length > 0) {
    template.push({
      label: `Tile All (${tailnetPhones.length})`,
      click: () => tileAll({ phones: tailnetPhones, getAdbPath, resourcesPath }),
    });
    template.push({ type: 'separator' });
    for (const ph of tailnetPhones) {
      template.push({
        label: `Launch ${ph.nickname || ph.udid}  ·  ${ph.tailnetIp}`,
        click: () => launchOne({ phone: ph, getAdbPath, resourcesPath }),
      });
    }
  } else {
    template.push({ label: 'No phones on tailnet', enabled: false });
  }

  if (offTailnet.length > 0) {
    template.push({ type: 'separator' });
    template.push({ label: `Off-tailnet: ${offTailnet.length}`, enabled: false });
  }

  template.push({ type: 'separator' });
  template.push({ label: 'Open ShadowPhone window', click: () => onShowApp?.() });
  // 2.16.53: bulk pull all team data from cloud so a fresh VA install
  // gets every phone/profile/account/captions scaffolded immediately.
  // 2.16.54: one-click "why can't I see my phones" report. Captures
  // tailscale + adb + per-phone ping + Clerk session + log tail, writes
  // to a paste-able .txt file with sensitive bits masked, opens it.
  template.push({
    label: '🩺 Diagnose phone access (paste this in Slack)',
    click: async () => {
      try {
        const { dialog, shell, app } = require('electron');
        const fs = require('node:fs');
        const path = require('node:path');
        const diagnostics = require('./diagnostics');
        const launcherLog = require('./launcher-log');

        const mainRef = global.__sp_mainExports || {};
        const adbPath = (mainRef.getAdbPath?.()) || null;
        const phones = (await getPhones?.()) || [];

        const report = await diagnostics.collect({
          adbPath,
          appVersion: app.getVersion(),
          launcherLogPath: launcherLog.getLogPath?.(),
          getCurrentSession: mainRef.getCurrentSession || (() => null),
          getKnownPhones: () => phones,
        });
        const masked = diagnostics.maskReport(diagnostics.formatReport(report));

        const dir = path.join(app.getPath('userData'), 'logs');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(dir, `diagnostic-${stamp}.txt`);
        try { fs.writeFileSync(file, masked, 'utf8'); } catch (_) {}

        await dialog.showMessageBox({
          type: 'info',
          title: 'Diagnostic report ready',
          message: 'Report saved to:\n' + file,
          detail: 'Opening it now. Paste the contents in Slack so we can see exactly what is failing. Sensitive bits (tailnet IPs, emails, keys) are masked.',
          buttons: ['Open report'],
          defaultId: 0,
        });
        try { shell.openPath(file); } catch (_) {}
      } catch (e) {
        try { require('electron').dialog.showErrorBox('Diagnostics failed', e?.message || String(e)); } catch (_) {}
      }
    },
  });
  template.push({
    label: '☁ Sync from cloud (load all team data)',
    click: async () => {
      try {
        const { ipcMain, dialog, BrowserWindow } = require('electron');
        // Bypass IPC since this runs in main — call the handler directly via electron-ipcMain emit
        const handlers = require('../handlers/sidebar-content-handlers');
        const preview = await handlers._bulkSyncPreview?.() || (async () => {
          // Fallback: invoke via fake event since we exported only init
          return new Promise((resolve) => {
            const result = { ok: false, error: 'preview not exposed' };
            resolve(result);
          });
        })();
        const counts = preview?.counts;
        const summary = counts
          ? `Phones: ${counts.phones}\nProfiles: ${counts.profiles}\nAccounts: ${counts.accounts}\nDefaults files: ${counts.defaults}\nSchedules: ${counts.schedules}`
          : 'Could not read cloud data — are you signed in?';
        const r = await dialog.showMessageBox({
          type: 'question',
          title: 'Sync sidebar from cloud',
          message: 'Pull team data and scaffold local folders?',
          detail: summary + '\n\nThis creates missing folders + writes captions/comments/schedules. It does NOT overwrite local videos/images.',
          buttons: ['Sync everything', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        if (r.response !== 0) return;
        const result = await handlers._bulkSyncFromCloud?.();
        const wc = counts
          ? `Synced ${result?.counts?.accounts || 0} accounts, ${result?.counts?.defaultsWritten || 0} default files, ${result?.counts?.schedules || 0} schedules.`
          : 'Sync complete.';
        dialog.showMessageBox({ type: 'info', title: 'Sync complete', message: wc, buttons: ['OK'] });
      } catch (e) {
        try { require('electron').dialog.showErrorBox('Sync failed', e?.message || String(e)); } catch (_) {}
      }
    },
  });
  // 2.16.7: easy way for VAs to DM the launcher log when something breaks.
  template.push({
    label: 'Open logs folder',
    click: () => {
      try {
        const dir = require('./launcher-log').getLogsDir();
        if (dir) shell.openPath(dir);
      } catch (e) { console.warn('[tray] open logs failed:', e?.message || e); }
    },
  });
  template.push({ label: 'Quit', role: 'quit' });
  return template;
}

// 2.16.1: route through the shared launchScrcpyForSerial path so tray-launched
// mirrors get the docked toolbar + tailnet routing + bookkeeping that the
// auto-mirror flow gets. Falls back to the bare spawnScrcpyForDevice path
// when the shared launcher isn't wired (initialisation order edge cases).
function getSharedLauncher() {
  try {
    const { launchScrcpyForSerial } = require('../handlers/system-handlers');
    return typeof launchScrcpyForSerial === 'function' ? launchScrcpyForSerial : null;
  } catch (_) {
    return null;
  }
}

async function launchOne({ phone, getAdbPath, resourcesPath }) {
  const log = (() => { try { return require('./launcher-log'); } catch (_) { return { write: () => {} }; } })();
  const shared = getSharedLauncher();
  const adbPath = (typeof getAdbPath === 'function' && getAdbPath()) || 'adb';

  log.write('launchOne:start', {
    phone: { udid: phone?.udid, nickname: phone?.nickname, tailnetIp: phone?.tailnetIp, port: phone?.port, transport: phone?.transport },
    sharedAvailable: !!shared,
    adbPath,
  });

  if (isTailnetRoute(phone)) {
    const tailscaleDeniedReason = getTailscaleDeniedReason(await getTailscaleStatus());
    if (tailscaleDeniedReason) {
      log.write('launchOne:tailscale-denied', { tailnetIp: phone.tailnetIp, error: tailscaleDeniedReason });
      return {
        success: false,
        error: `Tailscale route unavailable: ${tailscaleDeniedReason}`,
        code: 'tailscale-unavailable',
      };
    }
  }

  // 2.17.8: pre-flight scrcpy availability check. On macOS, scrcpy is NOT
  // bundled — users install via homebrew. If missing, surface a clear
  // structured error so the renderer/tray can prompt for install. Without
  // this, Mac users saw "nothing happens" when clicking Launch.
  if (process.platform === 'darwin') {
    try {
      const { detectScrcpyAvailability } = require('./scrcpy-spawn-native');
      const det = detectScrcpyAvailability({ resourcesPath });
      if (!det.found) {
        log.write('launchOne:scrcpy-missing-mac', { detected: det });
        const { detectHomebrew } = require('./scrcpy-mac-installer');
        const brew = detectHomebrew();
        const errMsg = brew.found
          ? 'scrcpy is not installed. Open Terminal and run: brew install scrcpy — then click Launch again.'
          : 'scrcpy is missing AND Homebrew isn\'t installed. Install Homebrew from https://brew.sh, then run: brew install scrcpy';
        return {
          success: false,
          error: errMsg,
          code: 'mac-scrcpy-missing',
          needsBrew: !brew.found,
          installCommand: brew.found ? 'brew install scrcpy' : '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install scrcpy',
        };
      }
      log.write('launchOne:scrcpy-found-mac', { binary: det.binary, source: det.source });
    } catch (e) {
      log.write('launchOne:mac-preflight-failed', { error: e?.message || String(e) });
    }
  }

  if (phone.tailnetIp) {
    let target = `${phone.tailnetIp}:${phone.port || 5555}`;

    // 2.21.7: opportunistic Companion health check BEFORE the preflight.
    // Catches users like AJ who clicked Launch on a phone whose Companion
    // is missing — we install it now so the post-recovery (random TLS
    // port) and WiFi-cycle paths all become autonomous from this point
    // forward. Non-blocking on failure; preflight will still run.
    try {
      const ai = global.companionAutoInstaller;
      if (ai && typeof ai.ensureForDevice === 'function') {
        // Quick try via the cached target. If it's not reachable, we
        // can still try the UDID — installCompanion works over USB OR
        // tailnet identically as long as adb sees the device.
        const dev = (await runAdb(adbPath, ['devices'], 3000)).stdout;
        const seenAsTcp = new RegExp(`${phone.tailnetIp}:\\d+\\s+device`).test(dev);
        const seenAsUsb = phone.udid && new RegExp(`^${phone.udid}\\s+device`, 'm').test(dev);
        if (seenAsUsb) {
          // Fast path — direct USB device; skip the check unless it's been a while
          await ai.ensureForDevice(phone.udid).catch(() => {});
        } else if (seenAsTcp) {
          await ai.ensureForDevice(target).catch(() => {});
        }
      }
    } catch (_) { /* non-fatal */ }

    // 2.16.11: pre-flight reachability check — surface "phone unreachable"
    // BEFORE spawning scrcpy (which dies silently). Saves the operator
    // from clicking Launch and watching nothing happen.
    const reach = await new Promise((resolve) => {
      const net = require('node:net');
      const socket = new net.Socket();
      const timer = setTimeout(() => { try { socket.destroy(); } catch (_) {} resolve({ ok: false, error: 'timeout (3s)' }); }, 3000);
      socket.once('connect', () => { clearTimeout(timer); try { socket.destroy(); } catch (_) {} resolve({ ok: true }); });
      socket.once('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err?.code || err?.message || 'unknown' }); });
      try { socket.connect(phone.port || 5555, phone.tailnetIp); }
      catch (e) { clearTimeout(timer); resolve({ ok: false, error: e?.message || String(e) }); }
    });
    log.write('launchOne:preflight', { target, reachable: reach.ok, error: reach.error });
    if (!reach.ok) {
      // 2.17.9: ECONNREFUSED on a tailnet:5555 specifically means the phone
      // is reachable but `adb tcpip 5555` was never enabled (or got wiped
      // by a reboot). If the SAME phone is USB-connected right now, we can
      // auto-fix by firing `adb tcpip 5555` over USB then retrying the
      // tailnet connect. No wizard re-run needed.
      // 2.21.3: extend to TIMEOUT too — when Android moves the wireless
      // ADB TLS port (every reboot + every WiFi cycle), connect attempts
      // to the stale cached port now time out instead of returning
      // ECONNREFUSED. Without this widening, AJ's exact failure mode
      // (airplane_on toggle → port shifts → timeout 3s on :5555 → no
      // auto-recovery) is unrecoverable.
      const refused = /ECONNREFUSED|refused|timeout/i.test(String(reach.error || ''));
      if (refused) {
        // 2.17.18: BEFORE trying adb tcpip over USB, verify a USB-attached
        // device actually exists with that serial. On VPS users (Nur),
        // there's no USB at all — phone.udid is just the cloud nickname
        // ("Pixel 6a # 3"), not a real adb serial. Without this check,
        // we'd fire `adb -s "Pixel 6a # 3" tcpip 5555` which silently
        // failed and surfaced the confusing "still refusing" toast.
        log.write('launchOne:auto-fix-attempt', { target, reason: 'ECONNREFUSED — trying adb tcpip 5555 over USB' });
        const usbDevicesResult = await runAdb(adbPath, ['devices'], 3000);
        const usbDevices = (() => {
          // 2.18.17: use `adb devices -l` is overkill — plain `adb devices`
          // emits serial<TAB>state<TAB>extra-attrs. We want USB-only serials
          // (no host:port targets like 100.x.x.x:5555). The previous
          // !l.includes(':') filter was applied to the WHOLE LINE, which on
          // modern adb (transport_id, product, model attrs) contains colons
          // in the attr keys ("product:oriole", "device:oriole",
          // "transport_id:1") — so USB devices got rejected as "wifi". Apply
          // the colon check only to the serial token (col 0), not the whole
          // line, so we filter out wifi targets without dropping real USB.
            // 2.18.19: `adb devices` emits `<serial>\t<state>` with a TAB,
            // not a space. The 2.18.18 regex `/ device\b/` required a literal
            // space and was failing on every modern adb (live-verified
            // 2026-05-26 with hex dump: 0x09 between serial and "device").
            // Split into tokens and check token[1] === 'device' to be
            // separator-agnostic. Also strip the trailing CRLF on Windows
            // that .trim() handles. Exclude TCP/IP entries (serial like
            // "100.x.y.z:5555") by rejecting tokens that contain a colon.
            const serials = usbDevicesResult.stdout.split('\n').slice(1)
              .map(l => l.trim())
              .filter(Boolean)
              .map(l => l.split(/\s+/))
              .filter(tokens => tokens.length >= 2 && tokens[1] === 'device')
              .map(tokens => tokens[0])
              .filter(s => s && !s.includes(':'));
            return serials;
        })();
        const usbSerial = phone.udid && usbDevices.includes(phone.udid)
          ? phone.udid
          : (usbDevices.length === 1 ? usbDevices[0] : null);
        log.write('launchOne:auto-fix-usb-scan', { target, usbDevices, chosen: usbSerial });
        if (usbDevices.length === 0) {
          // 2.19.15: before giving up, try ADB mDNS discovery. On Android
          // 11+ with Wireless Debugging enabled (different from the legacy
          // `adb tcpip 5555` toggle — survives reboots), the phone
          // advertises itself via _adb-tls-connect._tcp.local. We probe
          // mdns to see if the phone is reachable that way and, if so,
          // adb-connect via the advertised host:port.
          let mdnsHit = null;
          try {
            const mdnsOut = (await runAdb(adbPath, ['mdns', 'services'], 5000)).stdout;
            // Output lines look like:
            //   adb-XYZ._adb-tls-connect._tcp.   _adb-tls-connect._tcp   192.168.1.42:43771
            // Match any host:port to try. Prefer one with our tailnet IP if listed,
            // otherwise take the first non-loopback host:port.
            const candidates = [];
            for (const line of mdnsOut.split('\n')) {
              const m = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
              if (m) candidates.push(`${m[1]}:${m[2]}`);
            }
            const tailIp = target.split(':')[0];
            mdnsHit = candidates.find(c => c.startsWith(tailIp + ':')) || candidates[0] || null;
            log.write('launchOne:auto-fix-mdns', { target, candidates, chosen: mdnsHit });
          } catch (e) {
            log.write('launchOne:auto-fix-mdns-error', { target, error: e?.message || String(e) });
          }
          if (mdnsHit) {
            // Try connecting via mDNS — if the phone has Wireless Debugging
            // paired previously, this just works.
            const mdnsConnect = await runAdb(adbPath, ['connect', mdnsHit], 5000);
            const connectOut = `${mdnsConnect.stdout}\n${mdnsConnect.stderr}`;
            const connected = /connected to|already connected/i.test(connectOut);
            log.write('launchOne:auto-fix-mdns-connect', { mdnsHit, connected, out: connectOut.slice(0, 200) });
            if (connected) {
              // Update preflight target and re-test reachability via mDNS host:port.
              // The rest of launchOne will use the original target for scrcpy
              // since adb-server now knows the phone via both routes — adb is
              // happy resolving either serial.
              log.write('launchOne:auto-fix-mdns-recovered', { target, via: mdnsHit });
              // Skip the rest of the auto-fix block, jump back to launch flow.
              // We do this by setting reach.ok = true equivalent via continuing;
              // the easiest way: just proceed by falling through to the launch
              // block below, but the wrapping `if (!reach.ok)` already encloses
              // us. Use a flag to bypass the error return.
              reach.ok = true;
            }
          }
          if (!reach.ok) {
            // 2.21.3: Tailnet port scan fallback. Android 11+ assigns the
            // wireless ADB TLS port randomly on every reboot/wifi cycle,
            // and AJ's exact failure mode was scrcpy:closed → port shifted
            // → :5555 ECONNREFUSED → mDNS doesn't traverse Tailscale →
            // dead. Companion would respond on :8765 if installed but
            // AJ's pre-2.20.0 wizard never installed it. Direct TCP scan
            // of the Android ephemeral range proves reachability AND
            // finds the port in one pass — works without Companion.
            try {
              const { scanForAdbPort } = require('./companion-discovery');
              const tailIp = target.split(':')[0];
              const hintPort = Number(target.split(':')[1]) || null;
              log.write('launchOne:auto-fix-scan-start', { target, hint: hintPort });
              const found = await scanForAdbPort(tailIp, {
                hintPort,
                overallTimeoutMs: 60_000,
              });
              if (found) {
                const newTarget = `${tailIp}:${found}`;
                log.write('launchOne:auto-fix-scan-hit', { target, newTarget });
                // adb-connect to the discovered port. scrcpy will use it
                // because we update phone.port + target below.
                const scanConnect = await runAdb(adbPath, ['connect', newTarget], 5000);
                const connectOut = `${scanConnect.stdout}\n${scanConnect.stderr}`;
                const connected = /connected to|already connected/i.test(connectOut);
                log.write('launchOne:auto-fix-scan-connect', { newTarget, connected });
                if (connected) {
                  phone.port = found;
                  target = newTarget;
                  reach.ok = true;
                }
              }
            } catch (e) {
              log.write('launchOne:auto-fix-scan-error', { error: e?.message || String(e) });
            }
          }
          if (!reach.ok) {
            // VPS / headless case — no USB on this machine + mDNS didn't help
            // + Tailnet port scan found nothing.
            const msg = `Phone ${target} is offline (was the phone rebooted?). Wireless ADB doesn't survive Android reboots. This machine has no USB, Wireless Debugging mDNS isn't advertised, and a Tailnet port scan found no ADB listener. Two fixes: (1) enable Android Developer Options → Wireless Debugging on the phone (survives reboots), then re-pair from this machine, OR (2) plug the phone into any computer with adb once + run \`adb tcpip 5555\`.`;
            log.write('launchOne:auto-fix-no-usb', { target });
            return { success: false, error: msg, code: 'phone-needs-rewifi-remote', target, reachError: reach.error };
          }
        }
        if (usbSerial) {
          try {
            await runAdb(adbPath, ['-s', usbSerial, 'tcpip', '5555'], 6000);
            // Give the phone ~2.5s to start listening on the new port.
            await new Promise((r) => setTimeout(r, 2500));
            // Retry the TCP reach test
            const retry = await new Promise((resolve) => {
              const net = require('node:net');
              const sock = new net.Socket();
              const t = setTimeout(() => { try { sock.destroy(); } catch (_) {} resolve({ ok: false, error: 'timeout' }); }, 3000);
              sock.once('connect', () => { clearTimeout(t); try { sock.destroy(); } catch (_) {} resolve({ ok: true }); });
              sock.once('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e?.code || e?.message || 'unknown' }); });
              try { sock.connect(phone.port || 5555, phone.tailnetIp); } catch (e) { clearTimeout(t); resolve({ ok: false, error: e?.message || String(e) }); }
            });
            log.write('launchOne:auto-fix-retry', { target, ok: retry.ok, error: retry.error });
            if (retry.ok) {
              // Auto-fix worked — fall through to adb-connect + spawn
            } else {
              const msg = `Phone ${target} still refusing after auto-tcpip retry. Plug phone in via USB + run Add Phone wizard.`;
              log.write('launchOne:auto-fix-failed', { target, error: retry.error });
              return { success: false, error: msg, code: 'phone-needs-rewifi', target, autoFixed: false };
            }
          } catch (e) {
            log.write('launchOne:auto-fix-exception', { target, error: e?.message || String(e) });
            const msg = `Phone ${target}: ${reach.error}. Plug USB + re-run Add Phone wizard step 5.`;
            return { success: false, error: msg, code: 'phone-needs-rewifi', target, reachError: reach.error };
          }
        } else {
          // No USB serial known — surface manual fix path.
          const msg = `Phone ${target} refused connection (adb tcpip 5555 not enabled). Plug USB + re-run Add Phone wizard step 5.`;
          return { success: false, error: msg, code: 'phone-needs-rewifi', target, reachError: reach.error };
        }
      } else {
        const msg = `Phone ${target} not reachable: ${reach.error}. Check phone is on + Tailscale active.`;
        log.write('launchOne:unreachable', { target, error: reach.error });
        return { success: false, error: msg, code: 'phone-unreachable', target, reachError: reach.error };
      }
    }

    let connectRes = await adbConnect(adbPath, target);
    log.write('launchOne:adbConnect', { target, ok: connectRes.ok, reason: connectRes.reason, stdout: connectRes.stdout?.slice(0, 200) });

    // 2.17.14: AUTO-RECOVERY for unauthorized phones. The first connect
    // often returns "failed to authenticate" because the popup was either
    // never shown or dismissed. We:
    //   1. disconnect + reconnect to force a fresh popup on the phone
    //   2. poll `adb devices` for up to 60s waiting for state -> 'device'
    //   3. if it flips, retry the connect and continue to scrcpy spawn
    //   4. emit progress to the renderer so it can show "waiting for tap on phone X"
    if (!connectRes.ok && /unauthorized|authenticate/i.test(connectRes.reason || '')) {
      log.write('launchOne:auth-recovery-start', { target });
      // Step 1: disconnect → reconnect → fresh popup
      await runAdb(adbPath, ['disconnect', target], 4000);
      await new Promise((r) => setTimeout(r, 600));
      connectRes = await adbConnect(adbPath, target);
      log.write('launchOne:auth-recovery-reconnect', { target, ok: connectRes.ok, reason: connectRes.reason });

      // Step 2: if STILL unauthorized, poll for up to 60s for the user to tap Allow
      if (!connectRes.ok && /unauthorized|authenticate/i.test(connectRes.reason || '')) {
        const deadline = Date.now() + 60_000;
        let authorized = false;
        // Tell fleet panel AND the main web window to show the "tap Allow on phone X" overlay
        try {
          const fp = require('./fleet-panel');
          const w = fp.getFleetPanelWindow && fp.getFleetPanelWindow();
          const authWaitPayload = { target, phone: phone.nickname || phone.udid, timeoutMs: 60_000 };
          fp.broadcastToFleetPanel('phone-auth-wait', authWaitPayload);
          sendToMainWindow('phone-auth-wait', authWaitPayload);
          log.write('launchOne:auth-wait-modal-broadcast', { target, fleetPanelOpen: !!w });
        } catch (e) {
          log.write('launchOne:auth-wait-modal-error', { target, error: e?.message || String(e) });
        }
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          // Re-query device state via `adb devices`
          const devicesResult = await runAdb(adbPath, ['devices'], 3000);
          const devState = devicesResult.stdout.split('\n').find(line => line.includes(target)) || '';
          if (/\bdevice\b/.test(devState) && !/unauthorized/.test(devState)) {
            authorized = true;
            log.write('launchOne:auth-recovery-success', { target, waitMs: 60000 - (deadline - Date.now()) });
            break;
          }
        }
        if (authorized) {
          // Re-run adb connect to confirm + continue
          connectRes = await adbConnect(adbPath, target);
          try {
            const authDoneOk = { target, phone: phone.nickname || phone.udid, ok: true };
            require('./fleet-panel').broadcastToFleetPanel('phone-auth-done', authDoneOk);
            sendToMainWindow('phone-auth-done', authDoneOk);
            log.write('launchOne:auth-done-broadcast', { target, ok: true });
          } catch (e) {
            log.write('launchOne:auth-done-broadcast-error', { target, error: e?.message || String(e) });
          }
        } else {
          log.write('launchOne:auth-recovery-timeout', { target });
          try {
            const authDoneTimeout = { target, phone: phone.nickname || phone.udid, ok: false, reason: 'timeout' };
            require('./fleet-panel').broadcastToFleetPanel('phone-auth-done', authDoneTimeout);
            sendToMainWindow('phone-auth-done', authDoneTimeout);
            log.write('launchOne:auth-done-broadcast', { target, ok: false });
          } catch (e) {
            log.write('launchOne:auth-done-broadcast-error', { target, error: e?.message || String(e) });
          }
        }
      }
    }

    if (!connectRes.ok) {
      // 2.16.12+: bail with a structured, actionable error so the Fleet
      // panel can show the right call-to-action.
      const isRefused = /refused/i.test(connectRes.reason || '');
      const isAuth = /unauthorized|authenticate/i.test(connectRes.reason || '');
      let code = 'adb-connect-failed';
      if (isRefused) code = 'phone-needs-rewifi';
      else if (isAuth) code = 'phone-needs-auth';
      return {
        success: false,
        error: `ADB connect to ${target} failed: ${connectRes.reason}`,
        code,
        target,
        adbReason: connectRes.reason,
      };
    }
    if (shared) {
      log.write('launchOne:invoking-shared', { target });
      const r = await shared(target);
      log.write('launchOne:shared-result', { target, result: r });
      return r;
    }
    log.write('launchOne:bare-spawn', { target });
    const r = spawnScrcpyForDevice({
      tailnetIp: phone.tailnetIp,
      port: phone.port || 5555,
      title: phone.nickname || phone.udid || target,
      resourcesPath,
    });
    if (!r.ok || !r.pid) {
      log.write('launchOne:scrcpy-missing', { target, code: r.code, error: r.error });
      return {
        success: false,
        error: r.error || 'scrcpy is not installed — install scrcpy, then click Launch again.',
        code: r.code || 'scrcpy-launch-failed',
        target,
      };
    }
    return { success: true, pid: r.pid, bin: r.bin, target };
  }

  if (shared && phone.udid) {
    log.write('launchOne:invoking-shared-usb', { udid: phone.udid });
    const r = await shared(phone.udid);
    log.write('launchOne:shared-result-usb', { udid: phone.udid, result: r });
    return r;
  }
  log.write('launchOne:bare-spawn-usb-fallback', { phone });
  const r = spawnScrcpyForDevice({
    title: phone.nickname || phone.udid,
    resourcesPath,
  });
  if (!r.ok || !r.pid) {
    log.write('launchOne:scrcpy-missing-usb', { udid: phone?.udid, code: r.code, error: r.error });
    return {
      success: false,
      error: r.error || 'scrcpy is not installed — install scrcpy, then click Launch again.',
      code: r.code || 'scrcpy-launch-failed',
    };
  }
  return { success: true, pid: r.pid, bin: r.bin };
}

async function tileAll({ phones, getAdbPath, resourcesPath }) {
  // 2.16.5: route every phone through launchOne so they ALL get the
  // adb-connect-first-then-launchScrcpyForSerial path (toolbar attaches).
  // The auto-tile layout inside system-handlers.js handles per-phone window
  // positions AND now accounts for the docked toolbar width via the
  // SIDEBAR_RESERVE_PX constant — so sidebars no longer overlap their
  // phones.
  const results = [];
  for (const ph of phones) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await launchOne({ phone: ph, getAdbPath, resourcesPath }));
  }
  return results;
}

async function refreshTrayMenu(opts) {
  if (!trayRef) return;
  try {
    const template = await buildMenuTemplate(opts);
    trayRef.setContextMenu(Menu.buildFromTemplate(template));
  } catch (e) {
    // Tray refresh failures are non-fatal — phone list comes back next refresh.
    console.error('[scrcpy-tray] refresh failed:', e.message);
  }
}

function initScrcpyTray(opts) {
  _trayOpts = opts
  const iconPath = opts.iconPath || path.join(__dirname, '..', 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  // Windows: 16x16 from the 512x512 source ends up muddy. Use 16x16 on Windows
  // for taskbar fit; macOS/Linux honour higher resolution.
  const sized = icon.isEmpty()
    ? nativeImage.createEmpty()
    : icon.resize({ width: process.platform === 'win32' ? 16 : 22 });
  trayRef = new Tray(sized);
  trayRef.setToolTip('ShadowPhone — native scrcpy launcher (2.16.0)');
  trayRef.on('click', () => opts.onShowApp?.());

  refreshTrayMenu(opts);
  const interval = setInterval(() => refreshTrayMenu(opts), 15_000);
  trayRef.on('destroyed', () => clearInterval(interval));
  console.log('[scrcpy-tray] initialized — look for ShadowPhone icon in the system tray (^ arrow, bottom-right)');
  return trayRef;
}

module.exports = { initScrcpyTray, refreshTrayMenu, tileAll, launchOne };
