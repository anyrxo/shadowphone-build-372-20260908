'use strict';
/**
 * Feature 1: Wireless Add-Phone pairing — Android-11 `adb pair` + `adb connect`
 * so a phone joins the fleet FULLY wirelessly (no USB, no `adb tcpip 5555`).
 *
 * Two flows, both pure functions that take the resolved adbPath (never bare
 * `adb`) and spawn via that path — inheriting process.env unchanged so the
 * app's ANDROID_ADB_SERVER_PORT=5137 is honoured automatically:
 *
 *  (a) 6-digit pairing code (the TAILNET path — unicast TCP, works across
 *      Tailscale):
 *        pairWithCode(adbPath, host, pairPort, code)   → `adb pair`
 *        discoverConnectPort(adbPath, ip, {hintPort})  → find the connect port
 *        connect(adbPath, ip, connectPort)             → `adb connect`
 *
 *  (b) QR pairing (LAN-only — mDNS is link-local and does NOT cross the
 *      tailnet). The host shows a `WIFI:T:ADB;S:<name>;P:<pw>;;` QR; the phone
 *      scans it and starts advertising `_adb-tls-pairing._tcp`; the host finds
 *      that service via the bundled adb's `adb mdns services`, then pairs using
 *      the QR password as the pairing code and connects — reusing pairWithCode:
 *        createQrSession()                             → { name, password, payload }
 *        waitForPairingService(adbPath, name, opts)    → { ip, port } once scanned
 *
 * mdns output rows look like:
 *   adb-XYZ._adb-tls-connect._tcp.  _adb-tls-connect._tcp  100.x.y.z:43771
 */

const crypto = require('node:crypto');
const { runAdb: runManagedAdb } = require('./adb-util');

const CONNECT_SUCCESS = /connected to|already connected/i;
const PAIR_SUCCESS = /successfully paired/i;

// Mirror phone-provision.js runAdb: spawn the resolved adb, resolve a plain
// {code,stdout,stderr} record, never throw. env is inherited unchanged.
function runAdb(adbPath, args, timeoutMs) {
  return runManagedAdb(adbPath, args, timeoutMs || 10000).then(result => ({
    ...result,
    code: result.code ?? -1,
    stdout: result.stdout.trim(),
    stderr: `${result.stderr || result.error || ''}${result.timedOut ? '\n[timeout]' : ''}`.trim(),
  }));
}

// ── Input validation (system boundary — the renderer feeds these) ───────────

function isValidHost(h) {
  return typeof h === 'string' && h.length > 0 && h.length < 256 && /^[A-Za-z0-9.\-]+$/.test(h);
}

function isValidPort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// Manual pairing codes are 6 digits. QR-generated passwords are longer hex
// strings — both are accepted here (adb takes the code as an arg either way).
function isValidCode(c) {
  return typeof c === 'string' && /^[A-Za-z0-9]{6,64}$/.test(c);
}

// ── (a) 6-digit flow ────────────────────────────────────────────────────────

/**
 * `adb pair <host>:<pairPort> <code>` — host:pairPort + code are read off the
 * phone's Settings → Developer options → Wireless debugging → "Pair device
 * with pairing code" dialog. Works across the tailnet (unicast TCP).
 */
async function pairWithCode(adbPath, host, port, code) {
  if (!isValidHost(host)) return { ok: false, error: `Invalid pairing IP/host: "${host}"` };
  if (!isValidPort(port)) return { ok: false, error: `Invalid pairing port: "${port}" (must be 1-65535)` };
  if (!isValidCode(code)) return { ok: false, error: 'Invalid pairing code — expected the 6-digit code shown on the phone.' };

  const r = await runAdb(adbPath, ['pair', `${host}:${port}`, String(code)], 20000);
  const out = `${r.stdout}\n${r.stderr}`;
  if (PAIR_SUCCESS.test(out)) return { ok: true, host, port: Number(port), output: r.stdout.trim() };
  // adb prints "Failed: <reason>" on a bad code / expired dialog / wrong port.
  const reason = (r.stdout || r.stderr || 'adb pair failed').split('\n').filter(Boolean).pop() || 'adb pair failed';
  return { ok: false, error: reason.trim() };
}

/**
 * Find the phone's *connect* port (distinct from the pairing port, which closes
 * after pairing). Tries mDNS first (LAN-only — free when on the same subnet),
 * then falls back to a TCP connect-scan over the tailnet.
 */
async function discoverConnectPort(adbPath, ip, opts = {}) {
  if (!isValidHost(ip)) return { ok: false, error: `Invalid IP/host: "${ip}"` };

  // 1. mDNS — instant when the PC and phone share a LAN.
  const r = await runAdb(adbPath, ['mdns', 'services'], 5000);
  if (r.code === 0 && r.stdout) {
    for (const line of r.stdout.split('\n')) {
      if (!/_adb-tls-connect/.test(line)) continue;
      const m = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
      if (m && m[1] === ip) return { ok: true, port: Number(m[2]), via: 'mdns' };
    }
  }

  // 2. Tailnet fallback — mDNS never crosses Tailscale, so connect-scan the
  //    Android ephemeral range (hint-guided; a cold sweep is 50-120s).
  const { scanForAdbPort } = require('./companion-discovery');
  const port = await scanForAdbPort(ip, { hintPort: opts.hintPort });
  if (port) return { ok: true, port, via: 'scan' };

  return {
    ok: false,
    error: `Couldn't find the wireless-debugging port for ${ip}. Read "IP address & Port" off the phone's Wireless debugging screen and enter it in the "Connect endpoint" field.`,
  };
}

/**
 * `adb connect <ip>:<port>`. Success regex matches the same strings the
 * existing adb-connect handler checks (main.js).
 */
async function connect(adbPath, ip, port) {
  if (!isValidHost(ip)) return { ok: false, error: `Invalid IP/host: "${ip}"` };
  if (!isValidPort(port)) return { ok: false, error: `Invalid connect port: "${port}" (must be 1-65535)` };

  const endpoint = `${ip}:${port}`;
  const r = await runAdb(adbPath, ['connect', endpoint], 8000);
  const out = `${r.stdout}\n${r.stderr}`;
  if (CONNECT_SUCCESS.test(out)) return { ok: true, endpoint, output: r.stdout.trim() };
  return { ok: false, endpoint, error: (r.stdout || r.stderr || 'adb connect failed').trim() };
}

// ── (b) QR flow ─────────────────────────────────────────────────────────────

/**
 * Build a QR pairing session. The payload is the standard Android
 * "Pair device with QR code" string. The phone reads S (service name) + P
 * (password); after scanning it advertises `<name>._adb-tls-pairing._tcp` and
 * expects the pairing handshake authenticated with <password>.
 */
function createQrSession() {
  const name = `ADB_WIFI_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(8).toString('hex'); // 16-char shared secret
  const payload = `WIFI:T:ADB;S:${name};P:${password};;`;
  return { name, password, payload };
}

/**
 * Poll `adb mdns services` until the phone (having scanned our QR) advertises
 * an `_adb-tls-pairing` service whose instance name matches our session name.
 * Returns { ip, port } — the pairing endpoint to hand to pairWithCode with the
 * QR password as the code. LAN-only.
 */
async function waitForPairingService(adbPath, name, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const intervalMs = opts.intervalMs || 1500;
  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isCancelled()) return { ok: false, cancelled: true, error: 'cancelled' };
    const r = await runAdb(adbPath, ['mdns', 'services'], 5000);
    if (r.code === 0 && r.stdout) {
      for (const line of r.stdout.split('\n')) {
        if (!/_adb-tls-pairing/.test(line)) continue;
        if (!line.includes(name)) continue; // instance name is the first token
        const m = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
        if (m) return { ok: true, ip: m[1], port: Number(m[2]) };
      }
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  return {
    ok: false,
    error: `No phone scanned the QR within ${Math.round(timeoutMs / 1000)}s. QR pairing needs this PC and the phone on the SAME Wi-Fi/LAN (it can't cross the tailnet). Use the 6-digit code flow for a tailnet phone.`,
  };
}

module.exports = {
  pairWithCode,
  discoverConnectPort,
  connect,
  createQrSession,
  waitForPairingService,
  // exported for the handler's own validation / reuse
  isValidHost,
  isValidPort,
  isValidCode,
};
