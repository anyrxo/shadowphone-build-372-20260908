'use strict';
/**
 * 2.16.11: in-app self-diagnostic.
 *
 * Collects everything support needs to triage a "Launch did nothing"
 * report from a VA into a single object the Fleet panel can render +
 * copy to clipboard. Same content support would otherwise have to
 * walk a VA through over Slack.
 */

const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { runAdb } = require('./adb-util');

function safe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback === undefined ? `error: ${e?.message || e}` : fallback; }
}

function runQuick(bin, args, timeoutMs = 4000, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        const cap = opts.fullOutput ? 200_000 : 4000;
        resolve({
          code: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
          stdout: (stdout || '').slice(0, cap),
          stderr: (stderr || '').slice(0, 1000),
          error: error && !Number.isInteger(error.code) ? String(error.message || error) : null,
        });
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', error: String(e?.message || e) });
    }
  });
}

function findTailscaleBin() {
  const candidates = [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const c of candidates) if (safe(() => fs.existsSync(c), false)) return c;
  return null;
}

async function collect(opts = {}) {
  const adbPath = opts.adbPath || null;
  const appVersion = opts.appVersion || 'unknown';
  const launcherLogPath = opts.launcherLogPath || null;
  // 2.16.54: optional accessors so the tray-driven path can include
  // Clerk auth + per-phone reachability + sidebar registry counts.
  const getCurrentSession = opts.getCurrentSession || null;
  const getKnownPhones = opts.getKnownPhones || null;

  const report = {
    timestamp: new Date().toISOString(),
    shadowphone: {
      version: appVersion,
      pid: process.pid,
      electronVersion: process.versions.electron || null,
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      memMb: Math.round(os.totalmem() / 1024 / 1024),
    },
    network: {
      tailnetIp: null,
      interfaces: [],
    },
    tailscale: {
      binary: findTailscaleBin(),
      statusTextExit: null,
      statusTextHead: null,
      statusJsonOk: false,
      statusJsonState: null,
      peerCountAndroidOnline: null,
      probeMs: null,
    },
    adb: {
      binary: adbPath,
      devicesExit: null,
      devicesHead: null,
    },
    processes: {
      scrcpy: [],
      tailscaled: [],
      protonvpn: [],
    },
    launcherLog: {
      path: launcherLogPath,
      tail: [],
    },
    clerk: { signedIn: false, userId: null, email: null, tokenLen: 0 },
    phoneAccess: [],
    hints: [],
  };

  // Network interfaces — find any 100.x.x.x (CGNAT/tailnet range)
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const a of ifaces[name] || []) {
        if (a.family === 'IPv4' && !a.internal) {
          report.network.interfaces.push({ iface: name, ip: a.address });
          if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) && !report.network.tailnetIp) {
            report.network.tailnetIp = a.address;
          }
        }
      }
    }
  } catch (_) {}

  // Tailscale CLI checks
  if (report.tailscale.binary) {
    const t0 = Date.now();
    // Tailscale JSON output exceeds 4KB with 5+ peers — Nur's machine had
    // 8 peers and the truncated JSON failed to parse → boot-diagnostic
    // misleadingly logged "tailscaleJsonState:null" even though the CLI
    // itself worked fine. Use fullOutput to capture the entire payload.
    const [text, json] = await Promise.all([
      runQuick(report.tailscale.binary, ['status'], 4000).then(result => {
        report.tailscale.probeMs = Date.now() - t0;
        return result;
      }),
      runQuick(report.tailscale.binary, ['status', '--json'], 5000, { fullOutput: true }),
    ]);
    report.tailscale.statusTextExit = text.code;
    report.tailscale.statusTextHead = (text.stdout || text.stderr || '').slice(0, 400);
    if (json.code === 0) {
      try {
        const obj = JSON.parse(json.stdout);
        report.tailscale.statusJsonOk = true;
        report.tailscale.statusJsonState = obj.BackendState || null;
        let count = 0;
        for (const k of Object.keys(obj.Peer || {})) {
          const p = obj.Peer[k];
          if ((p.OS || '').toLowerCase() === 'android' && p.Online) count++;
        }
        report.tailscale.peerCountAndroidOnline = count;
      } catch (_) {}
    }
  }

  // ADB
  if (adbPath && safe(() => fs.existsSync(adbPath), false)) {
    const r = await runAdb(adbPath, ['devices', '-l'], 4000);
    report.adb.devicesExit = r.code;
    report.adb.devicesHead = (r.stdout || r.stderr || r.error || '').slice(0, 1000);
  }

  // Process snapshot via tasklist (Win) / ps (Mac/Linux)
  try {
    if (process.platform === 'win32') {
      const t = await runQuick('tasklist', ['/FO', 'CSV', '/NH'], 5000, { fullOutput: true });
      const rows = (t.stdout || '').split(/\r?\n/);
      for (const row of rows) {
        const m = row.match(/^"([^"]+)","(\d+)"/);
        if (!m) continue;
        const [, name, pid] = m;
        const lname = name.toLowerCase();
        if (lname === 'scrcpy.exe') report.processes.scrcpy.push(Number(pid));
        if (lname === 'tailscaled.exe') report.processes.tailscaled.push(Number(pid));
        if (lname.startsWith('protonvpn')) report.processes.protonvpn.push({ name, pid: Number(pid) });
      }
    } else {
      const r = await runQuick('ps', ['-A', '-o', 'pid,comm'], 4000);
      for (const line of (r.stdout || '').split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const [, pid, comm] = m;
        const cl = comm.toLowerCase();
        if (cl.includes('scrcpy')) report.processes.scrcpy.push(Number(pid));
        if (cl.includes('tailscaled') || cl.includes('tailscale')) report.processes.tailscaled.push(Number(pid));
        if (cl.includes('protonvpn')) report.processes.protonvpn.push({ name: comm, pid: Number(pid) });
      }
    }
  } catch (_) {}

  // 2.16.54: Clerk session — without this Supabase sync silently no-ops
  if (getCurrentSession) {
    try {
      const s = getCurrentSession() || {};
      report.clerk = {
        signedIn: !!s.sessionToken,
        userId: s.userId || null,
        email: s.email || null,
        tokenLen: (s.sessionToken || '').length,
      };
    } catch (_) {}
  }

  // 2.16.54: per-phone reachability — answers "can ShadowPhone actually
  // talk to phone X from this PC right now". Ping + adb connect attempt.
  if (getKnownPhones && adbPath) {
    let phones = [];
    try { phones = await Promise.resolve(getKnownPhones()) || []; } catch (_) {}
    for (const p of phones) {
      const ip = p.tailnetIp || p.tailnet_ip || p.ip || null;
      const name = p.nickname || p.peerName || p.display_name || p.name || ip || '(unknown)';
      const entry = { name, ip, ping: null, adbConnect: null };
      if (ip) {
        const ping = await runQuick('ping', process.platform === 'win32'
          ? ['-n', '1', '-w', '1500', ip]
          : ['-c', '1', '-W', '2', ip], 3000);
        entry.ping = ping.code === 0 ? 'OK' : `FAIL (exit ${ping.code})`;
        const connect = await runAdb(adbPath, ['connect', `${ip}:5555`], 5000);
        entry.adbConnect = (connect.stdout || connect.stderr || connect.error || '').trim().slice(0, 120) || `(exit ${connect.code})`;
      } else {
        entry.ping = 'no-ip';
        entry.adbConnect = 'no-ip';
      }
      report.phoneAccess.push(entry);
    }
  }

  // Launcher log tail
  if (launcherLogPath && safe(() => fs.existsSync(launcherLogPath), false)) {
    try {
      const raw = fs.readFileSync(launcherLogPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      report.launcherLog.tail = lines.slice(-30);
    } catch (e) {
      report.launcherLog.tail = [`failed to read: ${e?.message || e}`];
    }
  }

  // Hints — surfacing the most common root causes
  if (report.processes.protonvpn.length > 0) {
    report.hints.push('ProtonVPN is running — its Kill Switch silently blocks Tailscale on Windows. Disable: ProtonVPN → Settings → Connection → Kill Switch → Off.');
  }
  if (report.tailscale.binary && !report.network.tailnetIp) {
    report.hints.push('Tailscale binary installed but no 100.x.x.x on any network interface — daemon is not connected. Open Tailscale tray icon → Log in / Reconnect.');
  }
  if (!report.tailscale.binary) {
    report.hints.push('Tailscale is not installed. Get it from https://tailscale.com/download then sign in with the auth key your owner DM-ed you.');
  }
  if (report.processes.tailscaled.length > 1) {
    report.hints.push('Multiple tailscaled processes running — restart Tailscale fully (Quit from tray, relaunch) to clean up dual-daemon state.');
  }
  if (report.tailscale.statusTextExit !== 0 && report.tailscale.statusJsonOk) {
    report.hints.push('Tailscale text CLI is wedged but JSON works — ShadowPhone uses JSON. This is benign.');
  }
  if (report.tailscale.statusJsonState && report.tailscale.statusJsonState !== 'Running') {
    report.hints.push(`Tailscale BackendState is "${report.tailscale.statusJsonState}" instead of "Running". Sign in via the Tailscale tray icon.`);
  }
  if (report.tailscale.peerCountAndroidOnline === 0 && report.network.tailnetIp) {
    report.hints.push('Tailscale is up but ZERO Android peers visible — owner has not added you to the right ACL, OR the phones are off / lost WiFi. Ask owner to check Tailscale admin panel.');
  }
  if (!adbPath || (report.adb.devicesExit !== 0 && report.adb.devicesExit !== null)) {
    report.hints.push('adb binary not found or failing — ShadowPhone bundles its own at %APPDATA%\\\\shadowphone-desktop\\\\adb\\\\adb.exe. Re-install ShadowPhone if missing.');
  }

  return report;
}

function formatReport(report) {
  const lines = [];
  lines.push('========== SHADOWPHONE DIAGNOSTIC ==========');
  lines.push(`time: ${report.timestamp}`);
  lines.push(`shadowphone: v${report.shadowphone.version} (electron ${report.shadowphone.electronVersion}, pid ${report.shadowphone.pid})`);
  lines.push(`system: ${report.system.platform} ${report.system.arch} ${report.system.release} · ${report.system.memMb}MB RAM · up ${Math.round(report.system.uptimeSec/3600)}h`);
  lines.push(`hostname: ${report.system.hostname}`);
  lines.push('');
  lines.push(`tailnet IP on iface: ${report.network.tailnetIp || 'NONE — tailscale not connected'}`);
  lines.push(`interfaces (non-loopback):`);
  for (const i of report.network.interfaces) lines.push(`  - ${i.iface}: ${i.ip}`);
  lines.push('');
  lines.push(`tailscale binary: ${report.tailscale.binary || 'NOT INSTALLED'}`);
  if (report.tailscale.binary) {
    lines.push(`tailscale status text exit: ${report.tailscale.statusTextExit} (${report.tailscale.probeMs}ms)`);
    lines.push(`tailscale status json: ${report.tailscale.statusJsonOk ? `OK, state=${report.tailscale.statusJsonState}` : 'FAILED'}`);
    lines.push(`android peers online: ${report.tailscale.peerCountAndroidOnline ?? 'unknown'}`);
    if (report.tailscale.statusTextHead) lines.push(`tailscale status head:\n  ${report.tailscale.statusTextHead.replace(/\n/g, '\n  ')}`);
  }
  lines.push('');
  lines.push(`adb binary: ${report.adb.binary || 'unknown'}`);
  lines.push(`adb devices exit: ${report.adb.devicesExit}`);
  if (report.adb.devicesHead) lines.push(`adb devices:\n  ${report.adb.devicesHead.replace(/\n/g, '\n  ')}`);
  lines.push('');
  lines.push(`processes: scrcpy=${report.processes.scrcpy.length} (${report.processes.scrcpy.join(',') || 'none'})`);
  lines.push(`processes: tailscaled=${report.processes.tailscaled.length} (${report.processes.tailscaled.join(',') || 'none'})`);
  lines.push(`processes: protonvpn=${report.processes.protonvpn.length}`);
  lines.push('');
  lines.push(`Clerk signed in: ${report.clerk?.signedIn ? 'YES' : 'NO'}` + (report.clerk?.email ? ` (${report.clerk.email})` : ''));
  if (!report.clerk?.signedIn) lines.push('  → cloud sync features (schedules, captions, account list) will not work until you sign in via the dashboard window.');
  lines.push('');
  if (report.phoneAccess?.length) {
    lines.push('phone access tests:');
    for (const ph of report.phoneAccess) {
      lines.push(`  • ${ph.name} (${ph.ip || 'no-ip'}): ping=${ph.ping} | adb=${ph.adbConnect}`);
    }
  } else {
    lines.push('phone access tests: (none — no phones known locally; sync from cloud or add via Add Phone)');
  }
  lines.push('');
  if (report.hints.length > 0) {
    lines.push('HINTS:');
    for (const h of report.hints) lines.push(`  → ${h}`);
  } else {
    lines.push('HINTS: (none — everything looks healthy)');
  }
  lines.push('');
  lines.push('launcher log tail (most recent):');
  for (const l of report.launcherLog.tail) lines.push(`  ${l.length > 250 ? l.slice(0, 250) + '…' : l}`);
  lines.push('========== END ==========');
  return lines.join('\n');
}

// 2.16.12: mask sensitive fields in the report so VAs/operators can
// safely paste it into chat without leaking their tailnet topology.
function maskReport(text) {
  if (!text) return text;
  let t = text;
  // Tailnet IPs (100.64.0.0/10 CGNAT range)
  t = t.replace(/100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}/g, '100.x.x.x');
  // IPv6 tailnet (fd7a:...)
  t = t.replace(/fd7a:[0-9a-f:]+/gi, 'fd7a:[redacted]');
  // Emails
  t = t.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
  // Tailscale node/disco/machine keys (hex blobs in status output)
  t = t.replace(/(node|public|disco|mach)key:[0-9a-f]+/gi, '$1key:[redacted]');
  // Long hex IDs (ADB serials, device IDs) — keep first 4 chars for triage
  t = t.replace(/\b([0-9A-F]{4})([0-9A-F]{8,})\b/gi, '$1[redacted-id]');
  return t;
}

module.exports = { collect, formatReport, maskReport, findTailscaleBin };
