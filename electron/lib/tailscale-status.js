'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');

function findTailscaleBinary() {
  const candidates = [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return 'tailscale';
}

function emptyStatus(error, backendState = 'Unknown') {
  return {
    ok: false,
    transportReady: false,
    healthState: backendState === 'NeedsLogin' ? 'blocked' : 'unavailable',
    health: [],
    healthIssues: [],
    backendState,
    self: { online: false, ip: null, dnsName: null },
    peers: [],
    error,
  };
}

function normalizeBackendState(value) {
  return ['Running', 'NeedsLogin', 'Starting', 'Stopped'].includes(value) ? value : 'Unknown';
}

function firstIp(value) {
  if (!Array.isArray(value)) return null;
  const ips = value.filter(ip => typeof ip === 'string' && net.isIP(ip));
  return ips.find(ip => net.isIP(ip) === 4) || ips[0] || null;
}

function classifyHealth(message) {
  const normalized = String(message || '').trim();
  const lower = normalized.toLowerCase();
  if (lower.includes('approv')) {
    return { code: 'device_approval', message: normalized, blocking: true };
  }
  if (/\bkeys?\b/.test(lower)) {
    const code = /expired|expiry|re-auth|reauth/.test(lower) ? 'key_expired' : 'authentication';
    return { code, message: normalized, blocking: true };
  }
  if (/\b(?:re-?auth(?:entication|orization)?|auth(?:entication|orization)?|log[ -]?in|credentials?|revok(?:e|ed|es|ing|ation))\b/.test(lower)) {
    return { code: 'authentication', message: normalized, blocking: true };
  }
  if (/^tailscale (?:can(?:not|['’]t)|is unable to) reach the configured dns servers?\.?(?: internet connectivity may be affected\.?)?$/i.test(normalized)) {
    return { code: 'dns', message: normalized, blocking: false };
  }
  return { code: 'other', message: normalized, blocking: true };
}

function hasExpiredNodeKey(selfNode) {
  if (selfNode?.Expired === true) return true;
  if (typeof selfNode?.KeyExpiry !== 'string' || !selfNode.KeyExpiry.trim()) return false;
  const expiryTime = Date.parse(selfNode.KeyExpiry);
  return Number.isFinite(expiryTime) && expiryTime <= Date.now();
}

function getTailscaleDeniedReason(status) {
  if (!status || typeof status !== 'object') return 'Tailscale status unavailable';
  if (status.backendState === 'NeedsLogin') return 'Tailscale login required';
  if (status.backendState === 'Starting') return 'Tailscale is starting';
  if (status.backendState === 'Stopped') return 'Tailscale is stopped';
  if (status.backendState !== 'Running') return status.error || 'Tailscale state is unknown';
  if (status.error) return status.error;
  if (!status.self?.online) return status.error || 'Tailscale self is offline';
  if (!status.self?.ip) return status.error || 'Tailscale has no self IP';
  if (status.healthState === 'blocked') {
    return status.healthIssues?.find(issue => issue?.blocking)?.message || 'Tailscale health is blocking access';
  }
  if (status.transportReady === false) return 'Tailscale transport is unavailable';
  if (status.transportReady !== true && status.ok !== true) return 'Tailscale status is unusable';
  return null;
}

function parseTailscaleStatus(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || ''));
  } catch (error) {
    return emptyStatus(`invalid Tailscale JSON: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return emptyStatus('invalid Tailscale JSON: expected an object');
  }

  const backendState = normalizeBackendState(data.BackendState);
  const selfNode = data.Self && typeof data.Self === 'object' ? data.Self : null;
  const self = {
    online: selfNode?.Online === true,
    ip: firstIp(selfNode?.TailscaleIPs) || firstIp(data.TailscaleIPs),
    dnsName: typeof selfNode?.DNSName === 'string' && selfNode.DNSName ? selfNode.DNSName : null,
  };
  const peerNodes = Array.isArray(data.Peer)
    ? data.Peer
    : data.Peer && typeof data.Peer === 'object'
      ? Object.values(data.Peer)
      : [];
  const peers = peerNodes
    .filter(peer => peer && typeof peer === 'object')
    .map(peer => ({
      id: peer.ID || null,
      ip: firstIp(peer.TailscaleIPs),
      name: peer.HostName || peer.DNSName || null,
      dnsName: peer.DNSName || null,
      os: peer.OS || null,
      online: peer.Online === true,
      active: peer.Active === true,
    }));

  const health = Array.isArray(data.Health)
    ? data.Health.map(message => typeof message === 'string' ? message.trim() : '').filter(Boolean)
    : [];
  const healthIssues = health.map(classifyHealth);
  if (hasExpiredNodeKey(selfNode) && !healthIssues.some(issue => issue.code === 'key_expired')) {
    healthIssues.push({ code: 'key_expired', message: 'Tailscale node key is expired', blocking: true });
  }
  const blockingHealth = healthIssues.find(issue => issue.blocking);
  const baseTransportReady = backendState === 'Running' && Boolean(selfNode) && self.online && Boolean(self.ip);
  let healthState = 'healthy';
  if (backendState === 'NeedsLogin' || blockingHealth) healthState = 'blocked';
  else if (!baseTransportReady) healthState = 'unavailable';
  else if (health.length > 0) healthState = 'degraded';

  const result = {
    ok: baseTransportReady && healthState === 'healthy',
    transportReady: baseTransportReady && !blockingHealth,
    healthState,
    health,
    healthIssues,
    backendState,
    self,
    peers,
    error: null,
  };
  if (backendState === 'Running' && !selfNode) result.error = 'Tailscale status missing Self';
  else if (blockingHealth) result.error = blockingHealth.message;
  else result.error = getTailscaleDeniedReason(result);
  result.ok = result.error === null && healthState === 'healthy';
  return result;
}

function getTailscaleStatus(options = {}) {
  const config = typeof options === 'number' ? { timeoutMs: options } : options;
  const timeoutMs = config.timeoutMs ?? 4000;
  const spawnImpl = config.spawnImpl || spawn;
  const binary = config.binary || findTailscaleBinary();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(binary, ['status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve(emptyStatus(error?.message || 'Tailscale binary missing'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish(emptyStatus('Tailscale status timed out'));
    }, timeoutMs);
    child.on('error', error => {
      const message = error?.code === 'ENOENT' ? 'Tailscale binary missing' : error?.message || 'Tailscale command failed';
      finish(emptyStatus(message));
    });
    child.on('close', (code) => {
      const parsed = stdout.trim() ? parseTailscaleStatus(stdout) : null;
      if (parsed && (code === 0 || ['NeedsLogin', 'Starting', 'Stopped'].includes(parsed.backendState))) {
        finish(parsed);
        return;
      }
      if (code !== 0) {
        finish(emptyStatus(stderr.trim() || `tailscale status exited ${code}`));
        return;
      }
      finish(parsed || emptyStatus('Tailscale returned empty JSON'));
    });
  });
}

// ── Tailnet reachability gate ────────────────────────────────────────────────
// Incident (2026-07, operator's PC): Tailscale was DOWN the whole session (a
// ProtonVPN kill-switch blocks it), every boot-diagnostic logged tailnetIp=null,
// and yet the wireless reconciler / device-watchdog kept firing
// `adb connect 100.116.5.79:5555` — each burning a full 6s ADB timeout, forever.
// 14,586 of 28,567 launcher.log lines (51%) were connect-failed spam, and in
// 3.6.0 that flood saturated the shared adb queue -> circuit open -> the whole
// adb server wedged, taking a healthy USB phone down with it.
//
// A PEER-level check is not enough and never was: with the daemon Stopped,
// `tailscale status --json` STILL reports the hammered peer Online=true (verified
// live), so device-watchdog's `peerOnline === false` test at _attemptReconnect
// never fires in this scenario. The DAEMON-level predicate below is the
// authoritative one; peer online-ness is only a strict `=== false` refinement.
const LOCAL_IFACE_MEMO_MS = 2_000;
// == RECONCILE_MS in wireless-adb-reconciler: exactly one CLI probe per sweep
// while down, so resume latency is <= one sweep.
const TAILNET_STATUS_TTL_DOWN_MS = 30_000;
// A stale-healthy read costs at most one 6s connect per serial per sweep — i.e.
// today's behavior — so the up-TTL can be longer and halve the spawn rate.
const TAILNET_STATUS_TTL_UP_MS = 60_000;
const TAILNET_STATUS_TIMEOUT_MS = 4_000;
// 100.64.0.0/10 is CGNAT — routable ONLY through the Tailscale adapter. Same
// regex the boot diagnostic already uses (diagnostics.js) to print tailnetIp.
const TAILNET_CGNAT_RE = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

let _ifaceMemo = { at: 0, value: false, primed: false };
let _statusCache = { at: 0, status: null, ttlMs: TAILNET_STATUS_TTL_DOWN_MS };
let _statusInFlight = null;

// Tier 0 — free. Absence of a 100.64/10 address on this PC is one-way proof that
// every `adb connect 100.x:*` will burn its full timeout, so a "down" verdict can
// be reached without spawning a single process.
function hasLocalTailnetAddress(options = {}) {
  const nowFn = options.now || Date.now;
  const osImpl = options.osImpl || os;
  const at = nowFn();
  if (_ifaceMemo.primed && at - _ifaceMemo.at < LOCAL_IFACE_MEMO_MS) return _ifaceMemo.value;
  let found = false;
  try {
    const ifaces = osImpl.networkInterfaces() || {};
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (!addr || addr.internal) continue;
        if (addr.family !== 'IPv4' && addr.family !== 4) continue;
        if (TAILNET_CGNAT_RE.test(String(addr.address || ''))) { found = true; break; }
      }
      if (found) break;
    }
  } catch (_) { found = false; }
  _ifaceMemo = { at, value: found, primed: true };
  return found;
}

// TTL + single-flight wrapper around getTailscaleStatus(). Single-flight matters:
// the reconciler sweeps SWEEP_CONCURRENCY=4 phones at once and the watchdog ticks
// every 5s — without it the "cheap" gate would spawn more processes than it saves.
function getTailscaleStatusCached(options = {}) {
  const nowFn = options.now || Date.now;
  const at = nowFn();
  const ttlMs = options.ttlMs ?? _statusCache.ttlMs;
  if (_statusCache.status && at - _statusCache.at < ttlMs) return Promise.resolve(_statusCache.status);
  if (_statusInFlight) return _statusInFlight;
  const inFlight = getTailscaleStatus({
    timeoutMs: options.timeoutMs ?? TAILNET_STATUS_TIMEOUT_MS,
    spawnImpl: options.spawnImpl,
    binary: options.binary,
  }).then(status => {
    _statusCache = {
      at: nowFn(),
      status,
      ttlMs: status && status.transportReady === true ? TAILNET_STATUS_TTL_UP_MS : TAILNET_STATUS_TTL_DOWN_MS,
    };
    return status;
  }).finally(() => {
    if (_statusInFlight === inFlight) _statusInFlight = null;
  });
  _statusInFlight = inFlight;
  return inFlight;
}

// POSITIVE evidence that the local daemon cannot carry traffic. Deliberately
// NOT getTailscaleDeniedReason(): that one is the UI predicate and denies on any
// health string, and classifyHealth() marks every unrecognized Health message
// blocking:true — so a fully Running, fully working tailnet reporting a routine
// warning ("peers are advertising routes but --accept-routes is false", "an
// update is available", ...) would read as down and strand every wireless phone
// indefinitely. Parse failures, non-zero CLI exits and timeouts all land on
// backendState 'Unknown' and are likewise ignored: with a 100.x address on the
// NIC the link is probably fine, and probing costs at most today's behavior.
// Returns null when there is no proof the daemon is down.
function getTailnetDaemonDownReason(status) {
  if (!status || typeof status !== 'object') return null;
  if (status.backendState === 'NeedsLogin') return 'Tailscale login required';
  if (status.backendState === 'Starting') return 'Tailscale is starting';
  if (status.backendState === 'Stopped') return 'Tailscale is stopped';
  if (status.backendState !== 'Running') return null; // 'Unknown' — CLI noise, fail open
  if (status.self && status.self.online === false) return 'Tailscale self is offline';
  if (status.self && !status.self.ip) return 'Tailscale has no self IP';
  return null;
}

// Is it worth spending an `adb connect 100.x:*` right now?
// Returns { ok, reason }. `reason` is operator-facing when ok === false.
async function isTailnetRoutable(options = {}) {
  if (!hasLocalTailnetAddress(options)) {
    return { ok: false, reason: 'Tailscale is not connected (no 100.x address on this PC)' };
  }
  let status;
  try {
    status = await getTailscaleStatusCached(options);
  } catch (_) {
    return { ok: true, reason: null };
  }
  const down = getTailnetDaemonDownReason(status);
  if (down) return { ok: false, reason: down };
  return { ok: true, reason: null };
}

// Daemon-level first, then a STRICT peer refinement. `undefined`/missing peer
// means "unknown", not "offline" — same strictness as device-watchdog's
// `peerOnline === false` test — so an incomplete peer list never blocks a probe.
async function isTailnetPeerReachable(ip, options = {}) {
  const routable = await isTailnetRoutable(options);
  if (!routable.ok) return routable;
  if (!ip) return { ok: true, reason: null };
  let status;
  try {
    status = await getTailscaleStatusCached(options);
  } catch (_) {
    return { ok: true, reason: null };
  }
  const peer = (status?.peers || []).find(entry => entry && entry.ip === ip);
  if (peer && peer.online === false) return { ok: false, reason: `Tailscale peer ${ip} is offline` };
  return { ok: true, reason: null };
}

// Test seam only — drops the interface memo and the status TTL cache.
function _resetTailnetGateCache() {
  _ifaceMemo = { at: 0, value: false, primed: false };
  _statusCache = { at: 0, status: null, ttlMs: TAILNET_STATUS_TTL_DOWN_MS };
  _statusInFlight = null;
}

module.exports = {
  findTailscaleBinary,
  getTailscaleDeniedReason,
  getTailnetDaemonDownReason,
  getTailscaleStatus,
  parseTailscaleStatus,
  hasLocalTailnetAddress,
  getTailscaleStatusCached,
  isTailnetRoutable,
  isTailnetPeerReachable,
  TAILNET_CGNAT_RE,
  TAILNET_STATUS_TTL_DOWN_MS,
  TAILNET_STATUS_TTL_UP_MS,
  _resetTailnetGateCache,
};
