'use strict';
/**
 * wireless-adb-reconciler.js — keep wireless ADB armed on USB-attached phones.
 *
 * The problem it solves:
 *   Android wipes `service.adb.tcp.port` back to USB-only on EVERY reboot.
 *   After a phone reboots it's visible on Tailscale but `adb connect <ip>:5555`
 *   fails because nothing is listening on 5555. `adb tcpip 5555` re-arms it,
 *   but that command can ONLY be issued over USB — a Tailnet/VPS controller
 *   physically can't do it. Making it persistent needs root (stock Pixels: no).
 *
 *   ShadowPhone re-armed wireless ADB only (a) in the Add Phone wizard (manual)
 *   and (b) reactively when a mirror launch was refused. Neither fires on its
 *   own after a reboot, so operators running phones from a VPS would see them
 *   stuck offline until someone touched the USB host.
 *
 * What this does:
 *   On the machine the phones are USB-plugged into, every RECONCILE_MS:
 *     1. `adb devices -l` → physical USB serials only (skip 100.x:port TCP rows)
 *     2. read `service.adb.tcp.port` per device
 *     3. if it's not 5555, fire `adb -s <serial> tcpip 5555` to re-arm
 *     4. read the phone's 100.x tailnet IP and `adb connect <ip>:5555`
 *     5. report each re-armed phone (serial + tailnet IP) via onRearm() so the
 *        caller can broadcast the live address to operator/VPS instances.
 *
 * Safety:
 *   - USB-only: `tcpip` is never sent to a network transport (it can't work).
 *   - State-based, not timer-blind: only fires `tcpip` when the port is
 *     actually wrong, so a healthy phone is never disturbed mid-session.
 *   - A per-serial cooldown prevents hammering a phone that keeps reporting a
 *     bad port (e.g. mid-reboot) every tick.
 *   - Best-effort throughout; a single phone failing never stops the sweep,
 *     and reconciler errors never crash the app.
 */

const { runAdb } = require('./adb-util');

const RECONCILE_MS = 30_000;     // sweep cadence
const REARM_COOLDOWN_MS = 20_000; // min gap between re-arm attempts per serial
const ADB_TIMEOUT_MS = 6_000;
const SWEEP_CONCURRENCY = 4;     // max phones reconciled in parallel (bounds adb load)
// Persistent-failure backoff. A genuinely-down tailnet peer (Tailscale off /
// phone rebooting for minutes) used to be hammered every ~5s via the accelerated
// retry, each `adb connect` timing out at 6s — which SATURATED the shared adb
// queue (64 waiting) and tripped the circuit breaker, wedging the whole server
// (including healthy USB phones). Now the per-serial cooldown grows with the
// consecutive-failure count so a dead peer is probed ever more sparsely instead
// of flooded, and the accelerated retry is used ONLY for the first failure.
const MAX_BACKOFF_MS = 5 * 60_000;
const ACCEL_RETRY_MAX = 1; // only the first failure gets the fast ~5s retry

// Tailnet reachability gate. Even with the v3.6.1 backoff in place the app still
// probed a peer it could KNOW is unreachable: with Tailscale DOWN on the PC (the
// operator's ProtonVPN kill-switch blocks it) every `adb connect 100.x:5555`
// burns its full 6s timeout, forever — 51% of launcher.log was connect-failed
// spam, which buries real errors. The gate is a TTL-cached POLL re-derived every
// sweep (never a latch), so recovery needs no external event: the first sweep
// after Tailscale returns relinks. USB work is deliberately NOT gated.
let _tailnetGateImpl = null;      // test seam (see _setTailnetGateForTest)
let _tailnetDownStreak = 0;       // consecutive down verdicts (announce hysteresis)
let _tailnetAnnounced = false;    // "Tailscale is down" surfaced ONCE per outage

async function _tailnetRoutable() {
  try {
    const impl = _tailnetGateImpl || require('./tailscale-status').isTailnetRoutable;
    const verdict = await impl();
    if (verdict && verdict.ok === false) {
      return { ok: false, reason: verdict.reason || 'Tailscale is unavailable' };
    }
    return { ok: true, reason: null };
  } catch (_) {
    return { ok: true, reason: null }; // fail-open — a gate error must never strand a phone
  }
}

let _timer = null;
let _running = false;             // re-entrancy guard (a slow sweep must not overlap)
const _lastRearmAt = new Map();   // serial -> ts of last tcpip attempt
const _failStreak = new Map();    // serial -> consecutive connect failures (drives backoff)
const _unauthorizedLogged = new Set(); // serials we've already warned are unauthorized (log once)
const _retryTimers = new Map();   // serial -> accelerated-retry timer handle (post-connect-fail)

// Effective cooldown for a serial: base 20s, doubling per consecutive failure up
// to 5min. Resets to base the moment a connect succeeds.
function _cooldownFor(serial) {
  const fails = _failStreak.get(serial) || 0;
  if (fails <= 0) return REARM_COOLDOWN_MS;
  return Math.min(REARM_COOLDOWN_MS * (2 ** fails), MAX_BACKOFF_MS);
}

// Skip ALL reconciler adb when the shared adb process manager is already wedged:
// adding more `connect`/`disconnect`/`getprop` to a saturated queue or an open
// circuit is what caused the runaway in the first place. Let the watchdog's
// bounded restart clear it, then resume.
function _adbWedged() {
  try {
    const stats = require('./adb-util').getAdbProcessStats;
    const s = typeof stats === 'function' ? stats() : null;
    if (!s) return false;
    return s.circuitOpen === true || (s.queued || 0) >= 16;
  } catch (_) { return false; }
}

function _isNetworkSerial(s) {
  return /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s || '');
}

function _adb(adbPath, args, timeoutMs = ADB_TIMEOUT_MS) {
  return runAdb(adbPath, args, timeoutMs).then(result => ({
    ...result,
    code: result.code ?? -1,
    stdout: result.stdout.trim(),
    stderr: `${result.stderr || result.error || ''}${result.timedOut ? '\n[timeout]' : ''}`.trim(),
  }));
}

async function _usbSerials(adbPath) {
  // `adb devices -l` can transiently fail (code != 0 / timeout) while the adb
  // server is restarting — a common occurrence right after a phone reboots or
  // when another tool kills/respawns the server. Returning [] on the first
  // miss would silently skip the ENTIRE sweep that tick. Retry once (the second
  // call also starts the server if the first one's job was just to spawn it).
  let r = await _adb(adbPath, ['devices', '-l']);
  if (r.code !== 0) {
    await new Promise(res => setTimeout(res, 750));
    r = await _adb(adbPath, ['devices', '-l']);
    if (r.code !== 0) return [];
  }
  const out = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0] || !parts[1]) continue;            // empty / header rows
    if (_isNetworkSerial(parts[0])) continue;        // USB physical serials only
    // Keep ALL physical rows (device / offline / unauthorized) so the reconciler
    // can recover stalled transports instead of silently ignoring them.
    out.push({ serial: parts[0], state: parts[1] });
  }
  return out;
}

async function _tailnetIp(adbPath, serial) {
  const r = await _adb(adbPath, ['-s', serial, 'shell', 'ip', '-4', 'addr', 'show']);
  if (r.code !== 0) return null;
  const m = /inet (100\.\d+\.\d+\.\d+)\//.exec(r.stdout);
  return m ? m[1] : null;
}

// After a connect failure, schedule a single accelerated retry for this serial
// in ~5s rather than waiting for the next 30s periodic tick. If a timer is
// already pending for this serial, leave it alone (don't stack). Safe: purely
// additive, no DB writes, no scrcpy interference. The _running guard is skipped
// intentionally because this path is a targeted single-serial call, not a full
// sweep, and it shares the same _lastRearmAt cooldown.
function _scheduleAcceleratedRetry(adbPath, serial, opts, state) {
  if (_retryTimers.has(serial)) return; // already queued
  const t = setTimeout(async () => {
    _retryTimers.delete(serial);
    if (!_timer) return; // reconciler was stopped — abort silently
    try {
      const rearmed = [];
      // Re-evaluate the (TTL-cached, single-flight) tailnet gate: this path
      // bypasses reconcileOnce, and Tailscale may have dropped in the ~5s since
      // the failure. Cheap — a cached verdict costs nothing.
      const gate = await _tailnetRoutable();
      await _reconcileSerial(
        adbPath,
        serial,
        { log: opts.log, onRearm: opts.onRearm, rearmed, tailnetOk: gate.ok !== false },
        state,
      );
    } catch (_) { /* best-effort; periodic tick will cover it */ }
  }, 5_000);
  if (t.unref) t.unref(); // don't hold the event loop
  _retryTimers.set(serial, t);
}

// Is this phone currently a HEALTHY adb twin? A stale 'offline'/'unauthorized'
// row (left behind after the phone re-IP'd or the relay flapped) still contains
// the `ip:<port>` token, so a substring test would falsely conclude the link is
// up and skip the reconnect. Require the row to be in 'device' state.
//
// Port-agnostic by design: the watchdog (_reconnectViaCompanion /
// companion-discovery) and the device-handlers WiFi-toggle rescan move a phone
// to an ephemeral 32768-61000 twin, NOT a fixed :5555. Matching only `${ip}:5555`
// here made the reconciler blind to that healthy twin and re-fire a redundant
// `adb connect <ip>:5555` every cooldown, fighting the ephemeral-port model
// (twin oscillation / connect-failed spam). Match ANY `${ip}:<port>` 'device' row.
function _hasHealthyTwin(devicesStdout, ip) {
  for (const line of String(devicesStdout || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    // token like `100.x.x.x:<anyPort>` in 'device' state = live twin, regardless of port.
    if (parts[0] && parts[0].startsWith(`${ip}:`) && parts[1] === 'device') return true;
  }
  return false;
}

// Does an `adb connect` result indicate a live link? Same success test used
// across the codebase (main.js, device-watchdog.js, phone-provision.js, ...).
function _connectOk(c) {
  return /connected to|already connected/i.test((c && c.stdout || '') + '\n' + (c && c.stderr || ''));
}

// Reconcile a single USB serial. Pushes any re-arm/relink onto `rearmed` and
// fires onRearm. Self-contained + best-effort so it can run concurrently with
// its siblings without one phone's failure aborting the others.
//
// `state` is the row state from `adb devices` ('device' | 'offline' |
// 'unauthorized'). Only 'device' rows run the normal arm flow; the others get
// a targeted recovery (offline) or a once-per-serial warning (unauthorized).
async function _reconcileSerial(adbPath, serial, { log, onRearm, rearmed, tailnetOk = true }, state = 'device') {
  // Recover phones the normal flow would never see: a stalled USB transport
  // ('offline') or one whose USB-debugging prompt hasn't been accepted
  // ('unauthorized'). Both are guarded so they can't disturb a healthy phone.
  if (state === 'offline') {
    const now = Date.now();
    if (now - (_lastRearmAt.get(serial) || 0) < REARM_COOLDOWN_MS) return;
    _lastRearmAt.set(serial, now);
    try {
      // Targeted reconnect only kicks THIS stalled transport (unlike the bare
      // `adb reconnect` the watchdog uses). Don't chain getprop — the transport
      // won't be ready yet; let the next sweep pick it up as 'device' and arm.
      await _adb(adbPath, ['-s', serial, 'reconnect']);
      if (log) log('wireless-adb:usb-reconnect', { serial });
    } catch (_) { /* best-effort; next sweep retries after cooldown */ }
    return;
  }
  if (state === 'unauthorized') {
    // Host can't clear this (the user must accept the on-phone prompt), so warn
    // once and never retry — retrying would just spam the log.
    if (!_unauthorizedLogged.has(serial)) {
      _unauthorizedLogged.add(serial);
      if (log) log('wireless-adb:unauthorized', { serial });
    }
    return;
  }
  if (state !== 'device') return; // unknown/transient state — skip safely

  // Recovered to a usable state — let a future 'unauthorized' warn again.
  _unauthorizedLogged.delete(serial);

  try {
    const portRes = await _adb(adbPath, ['-s', serial, 'shell', 'getprop', 'service.adb.tcp.port']);
    const port = (portRes.stdout || '').trim();
    if (port === '5555') {
      // Already armed — but the tailnet adb LINK can still drop (relay flap /
      // idle timeout) while the port stays 5555, leaving the phone USB-only and
      // its WiFi toggle "unavailable". Re-establish the link if the tailnet twin
      // isn't currently a HEALTHY adb device. Only acts when actually
      // disconnected, so it stays quiet when the link is healthy.
      try {
        // Tailnet unroutable → skip the whole relink probe. NEUTRAL SKIP: no
        // `ip -4 addr show`, no second `devices` read, no disconnect/connect, and
        // critically no _lastRearmAt write / _failStreak bump / accelerated retry
        // / connect-failed log. A gated sweep must leave the v3.6.1 backoff state
        // exactly as it found it so the first sweep after Tailscale returns
        // relinks immediately instead of MAX_BACKOFF_MS (5 min) later.
        if (!tailnetOk) return;
        const ip = await _tailnetIp(adbPath, serial);
        if (ip) {
          // Cooldown (shared with the tcpip branch, which it's mutually
          // exclusive with): on a persistently-down link the phone keeps its
          // 100.x IP but never re-links, so without this the relink would fire
          // a few adb calls per phone every tick indefinitely. Short-circuit
          // before the `devices` read too.
          const now = Date.now();
          if (now - (_lastRearmAt.get(serial) || 0) < _cooldownFor(serial)) return;
          if (_adbWedged()) return; // don't pile onto a saturated/open-circuit adb
          const devs = await _adb(adbPath, ['devices']);
          if (!_hasHealthyTwin(devs.stdout, ip)) {
            _lastRearmAt.set(serial, now);
            // If a STALE twin (offline / wrong-IP leftover) is squatting the
            // slot, drop it first so `connect` re-resolves cleanly to the
            // current IP instead of being a no-op against a dead entry.
            if (String(devs.stdout || '').includes(`${ip}:5555`)) {
              await _adb(adbPath, ['disconnect', `${ip}:5555`]);
            }
            const c = await _adb(adbPath, ['connect', `${ip}:5555`]);
            const ok = _connectOk(c);
            if (ok) {
              _failStreak.delete(serial); // recovered — reset backoff
              if (log) log('wireless-adb:relink', { serial, tailnetIp: ip, port: 5555 });
              const entry = { serial, tailnetIp: ip, port: 5555 };
              rearmed.push(entry);
              if (typeof onRearm === 'function') { try { onRearm(entry); } catch (_) {} }
            } else {
              // Connect failed (relay flap / stale IP / still rebooting / peer
              // genuinely down). Grow the backoff so a persistently-dead peer is
              // probed ever more sparsely instead of hammered every ~5s (which
              // used to flood the shared adb queue and wedge the server). Keep
              // the cooldown SET (don't delete it) and only fast-retry the very
              // first failure.
              const fails = (_failStreak.get(serial) || 0) + 1;
              _failStreak.set(serial, fails);
              if (fails <= ACCEL_RETRY_MAX) {
                _scheduleAcceleratedRetry(adbPath, serial, { log, onRearm }, 'device');
              }
              if (log) log('wireless-adb:connect-failed', { serial, tailnetIp: ip, stdout: c.stdout || '', stderr: c.stderr || '' });
            }
          }
        }
      } catch (_) { /* keep sweeping the rest of the fleet */ }
      return;
    }

    // Cooldown: don't re-fire tcpip on the same serial every tick while it's
    // settling (e.g. mid-reboot the prop reads empty for a while). Backoff-aware
    // so a persistently-failing phone is retried ever more sparsely.
    const now = Date.now();
    const last = _lastRearmAt.get(serial) || 0;
    if (now - last < _cooldownFor(serial)) return;
    if (_adbWedged()) return; // don't pile onto a saturated/open-circuit adb
    _lastRearmAt.set(serial, now);

    if (log) log('wireless-adb:rearm-attempt', { serial, currentPort: port || '(empty)' });

    const tcpip = await _adb(adbPath, ['-s', serial, 'tcpip', '5555']);
    // tcpip exits 0 even when it prints to stderr; treat non-throw as armed.
    await new Promise(r => setTimeout(r, 1500)); // let adbd restart in TCP mode

    if (!tailnetOk) {
      // `tcpip 5555` above is a LOCAL USB op and always worth doing — its whole
      // value is that the phone is instantly linkable the moment Tailscale comes
      // back. Only the tailnet half is deferred, again with no streak bump.
      if (log) log('wireless-adb:rearmed-link-deferred', { serial, tcpipStderr: tcpip.stderr || null });
      return;
    }

    const ip = await _tailnetIp(adbPath, serial);
    let ok = false;
    let connectRes = null;
    if (ip) {
      connectRes = await _adb(adbPath, ['connect', `${ip}:5555`]);
      ok = _connectOk(connectRes);
    }

    if (ok) {
      _failStreak.delete(serial); // recovered — reset backoff
      if (log) log('wireless-adb:rearmed', { serial, tailnetIp: ip, port: 5555, connected: true, tcpipStderr: tcpip.stderr || null });
      const entry = { serial, tailnetIp: ip, port: 5555 };
      rearmed.push(entry);
      if (typeof onRearm === 'function') {
        try { onRearm(entry); } catch (_) {}
      }
    } else {
      // tcpip may have armed the port, but the link isn't up yet (no tailnet IP,
      // or the connect failed because adbd hasn't finished restarting / IP is
      // stale). Don't broadcast 'available'. Grow the backoff (keep the cooldown
      // SET) so a persistently-down phone is probed sparsely instead of every
      // ~5s, and only fast-retry the first failure — the old delete+accel loop
      // flooded the adb queue and wedged the whole server.
      const fails = (_failStreak.get(serial) || 0) + 1;
      _failStreak.set(serial, fails);
      if (fails <= ACCEL_RETRY_MAX) {
        _scheduleAcceleratedRetry(adbPath, serial, { log, onRearm }, 'device');
      }
      if (log) log('wireless-adb:connect-failed', { serial, tailnetIp: ip || null, connected: false, tcpipStderr: tcpip.stderr || null, stdout: connectRes && connectRes.stdout || '', stderr: connectRes && connectRes.stderr || '' });
    }
  } catch (err) {
    if (log) log('wireless-adb:rearm-error', { serial, error: err && err.message || String(err) });
    // keep sweeping the rest of the fleet
  }
}

/**
 * One reconcile pass. Returns an array of { serial, tailnetIp } for phones
 * that were re-armed this pass (so the caller can broadcast the address).
 */
async function reconcileOnce(adbPath, { log, onRearm, hasRunningScrcpyForSerial, isPhoneBusy } = {}) {
  const rearmed = [];
  if (!adbPath) return rearmed;

  // Skip the entire sweep while the shared adb process manager is wedged. Even
  // the initial `adb devices` enumeration would just add to a saturated queue /
  // bounce off an open circuit. The whole runaway that wedged the server started
  // with this reconciler flooding it; let the watchdog's bounded restart clear
  // it first, then resume next tick.
  if (_adbWedged()) {
    if (log) log('wireless-adb:sweep-skipped-adb-wedged', {});
    return rearmed;
  }

  // Tailnet gate — evaluated ONCE per sweep (TTL-cached + single-flight, so this
  // is free) and passed down to every serial. Deliberately placed AFTER the
  // wedged guard and BEFORE _usbSerials so the USB half of the sweep
  // (`adb devices -l`, `-s S reconnect`, the unauthorized warn-once, `getprop`,
  // `tcpip 5555`) is byte-for-byte unaffected while Tailscale is down.
  const gate = await _tailnetRoutable();
  const tailnetOk = gate.ok !== false;
  if (!tailnetOk) {
    _tailnetDownStreak += 1;
    // Skip from the FIRST down verdict (skipping is free), but announce only on
    // the second consecutive one (~60s) so a Tailscale flap can't toast-storm.
    if (_tailnetDownStreak >= 2 && !_tailnetAnnounced) {
      _tailnetAnnounced = true;
      if (log) log('wireless-adb:tailnet-down', {
        reason: gate.reason,
        message: 'Tailscale is down — wireless phones paused. USB phones are unaffected.',
      });
    }
  } else if (_tailnetDownStreak > 0) {
    // Down -> up edge. Clear the backoff IN THIS SWEEP: after a long outage every
    // serial's streak is pinned at MAX_BACKOFF_MS, so without this "resume the
    // moment Tailscale returns" would silently mean "resume 5 minutes later".
    _tailnetDownStreak = 0;
    _tailnetAnnounced = false;
    _failStreak.clear();
    _lastRearmAt.clear();
    if (log) log('wireless-adb:tailnet-restored', {});
  }

  let serials;
  try {
    serials = await _usbSerials(adbPath);
  } catch (_) {
    return rearmed; // adb itself unavailable — nothing USB to reconcile
  }
  if (!serials.length) return rearmed;

  // Don't reconcile a phone that currently has an active scrcpy mirror. The
  // re-arm flow can fire `adb tcpip`/`disconnect`/`connect` which forces a USB
  // re-enumeration and tears the live mirror's transport out mid-session. The
  // moment the mirror closes, the next 30s tick reconciles this serial freely,
  // so the post-reboot recovery path is preserved.
  if (typeof hasRunningScrcpyForSerial === 'function') {
    serials = serials.filter(row => {
      try { return !hasRunningScrcpyForSerial(row.serial); } catch (_) { return true; }
    });
    if (!serials.length) return rearmed;
  }

  // Don't reconcile a phone with an active automation run. The re-arm flow's
  // tcpip/disconnect/connect forces a USB re-enumeration that tears the transport
  // out mid-run (the same profile/transport-disruption class). Headless runs have
  // no scrcpy mirror, so the filter above misses them — this catches them via the
  // shared per-phone busy lock. Recovery of already-offline phones still proceeds
  // (a busy phone is, by definition, reachable).
  if (typeof isPhoneBusy === 'function') {
    serials = serials.filter(row => {
      try { return !isPhoneBusy(row.serial); } catch (_) { return true; }
    });
    if (!serials.length) return rearmed;
  }

  // Reconcile in bounded-concurrency waves rather than strictly sequentially.
  // Each serial does up to ~5 adb calls @ up to 6s each; on a large fleet a
  // serial loop can blow past RECONCILE_MS, and then the re-entrancy guard
  // silently DROPS the next tick(s) — phones go un-reconciled. A small worker
  // pool keeps the wall-clock sweep ~fleet/CONCURRENCY shorter so cadence holds
  // as the fleet grows, while still capping simultaneous adb load. Each worker
  // is fully isolated (best-effort), so concurrency can't let one phone abort
  // another's reconcile.
  const queue = serials.slice();
  const worker = async () => {
    for (;;) {
      const row = queue.shift();
      if (row === undefined) return;
      await _reconcileSerial(adbPath, row.serial, { log, onRearm, rearmed, tailnetOk }, row.state);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(SWEEP_CONCURRENCY, serials.length); i++) workers.push(worker());
  await Promise.all(workers);

  return rearmed;
}

/**
 * Start the periodic reconciler. Idempotent — calling twice is a no-op.
 *   getAdbPath: () => string   (required)
 *   log:        (event, data) => void   (optional; e.g. launcher-log.write)
 *   onRearm:    ({serial, tailnetIp}) => void  (optional; broadcast hook)
 *   intervalMs: override sweep cadence (optional)
 *   hasRunningScrcpyForSerial: (serial) => bool  (optional; skip phones with a
 *     live mirror so re-arm USB re-enumeration can't tear a session's transport)
 */
function start({ getAdbPath, log, onRearm, intervalMs, hasRunningScrcpyForSerial, isPhoneBusy } = {}) {
  if (_timer) return;
  if (typeof getAdbPath !== 'function') {
    throw new Error('wireless-adb-reconciler.start requires getAdbPath()');
  }
  const period = intervalMs || RECONCILE_MS;

  const tick = async () => {
    if (_running) return; // previous sweep still going — skip this tick
    _running = true;
    try {
      await reconcileOnce(getAdbPath(), { log, onRearm, hasRunningScrcpyForSerial, isPhoneBusy });
    } catch (_) {
      // never let a sweep error kill the loop
    } finally {
      _running = false;
    }
  };

  // First sweep shortly after startup (let adb/devices settle), then periodic.
  _timer = setInterval(tick, period);
  if (_timer.unref) _timer.unref(); // don't hold the event loop / block quit
  setTimeout(tick, 5_000);
  if (log) log('wireless-adb:reconciler-started', { intervalMs: period });
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _running = false;
  _lastRearmAt.clear();
  _unauthorizedLogged.clear();
  _tailnetDownStreak = 0;
  _tailnetAnnounced = false;
  for (const t of _retryTimers.values()) { try { clearTimeout(t); } catch (_) {} }
  _retryTimers.clear();
}

// Test seam: inject the tailnet routability verdict. Pass null to restore the
// real (TTL-cached) tailscale-status helper. Deliberately does NOT touch the
// down-streak — swapping the impl must be able to model a real up-edge.
function _setTailnetGateForTest(impl) {
  _tailnetGateImpl = typeof impl === 'function' ? impl : null;
}

module.exports = {
  start, stop, reconcileOnce,
  // test seams
  _cooldownFor, _adbWedged, _failStreak, MAX_BACKOFF_MS, REARM_COOLDOWN_MS,
  _lastRearmAt, _setTailnetGateForTest,
};
