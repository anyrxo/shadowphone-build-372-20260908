/**
 * scrcpy-spawn.js — Single source of truth for scrcpy spawn args + recovery shell pipeline.
 *
 * Embeds a sp_build=<version> marker in the scrcpy cmdline so the wizard can
 * detect stale args and respawn when it updates.
 */

const path = require('path');
const pkg = require(path.join(__dirname, '..', 'package.json'));

const SCRCPY_VERSION = '3.3.4';
const SCRCPY_PORT = 8886;
const SCRCPY_PORT_HEX = SCRCPY_PORT.toString(16).toUpperCase().padStart(4, '0');
const BUILD_ID = pkg.version;

// ws-scrcpy convention: no .jar extension. JVM doesn't care about extensions;
// matching ws-scrcpy's adbkit sync target so the host's normal-flow push and
// our force-respawn push land on the same file.
const SERVER_PATH = `/data/local/tmp/scrcpy-server`;
const ENTRY = 'com.genymobile.scrcpy.Server';

function getArgs() {
  return [
    `port_number=${SCRCPY_PORT}`,
    'listen_on_all_interfaces=true',
    'cleanup=false',
    // 2.14.1: stay_awake=true tells scrcpy to hold a partial wake lock on
    // the device so the screen / encoder doesn't suspend during idle
    // periods. Without this, phones go to lockscreen + scrcpy's display
    // capture stalls, which staff see as a "frozen" stream. The desktop
    // app's local-mirror flow uses this same arg — pinning explicitly
    // so the wizard's stream stays alive 24/7 while the wizard is open.
    'stay_awake=true',
    // send_codec_meta=true pushes SPS/PPS to each new client on connect.
    // Combined with the fan-out's last-keyframe replay, new browsers
    // get a decodable starting point in <100ms.
    'send_codec_meta=true',
    `sp_build=${BUILD_ID}`,
  ];
}

function buildSpawnCommand() {
  const args = getArgs().join(' ');
  const healthPattern = `sp_build=${BUILD_ID}`;
  const lockFile = '/data/local/tmp/scrcpy.sp.lock';
  const portHex = SCRCPY_PORT_HEX;

  // 2.14.2 recovery shell pipeline. Field-found from Nur's diagnostic
  // bundle: previous logic short-circuited on ANY sp_build match, so it
  // never cleaned up DUPLICATES of our own build (saw 2x sp_build=2.14.1
  // processes per device, plus stale 2.12.x leftovers, plus the desktop
  // app's scrcpy 3.1 mirror — 5+ JVMs per device × 3 devices triggered
  // system_server OOM and DeadSystemException in scrcpy's display thread).
  //
  // Selectivity matters: the desktop app's LOCAL mirror runs scrcpy 3.1
  // in scid-mode (no TCP port, abstract socket only). We MUST NOT kill
  // it — that's what staff see in the ShadowPhone window. We only kill
  // port-mode scrcpy (anything with `port_number=` in its cmdline), so
  // wizard + desktop-mirror can coexist on the same device.
  //
  //   1. Acquire process lock so concurrent spawns don't race.
  //   2. Health-check: EXACTLY one port-mode scrcpy that matches our
  //      build → no respawn needed. Any other count (0, 2+, mixed
  //      versions) → kill all port-mode scrcpy and respawn fresh.
  //   3. Wait for the port to actually be free in /proc/net/tcp.
  //   4. Spawn with retry.
  return [
    `set -e`,
    `LOCK="${lockFile}"`,
    // 2.14.15: stale-lock recovery for 24/7 VA usage. If a previous spawn
    // shell crashed without running the EXIT trap (kill -9, OOM, adb-shell
    // SIGKILL), the lock dir is orphaned. Every subsequent RUN_COMMAND
    // gets stuck on "lock busy" forever.
    //
    // Strategy: wait up to 5s for the lock (legit spawns finish in <3s).
    // If still held after 5s, force-rmdir and retry ONCE. The legit-spawn
    // happy path completes well under 5s so the force-clean only fires
    // for genuinely orphaned locks. Total recovery latency: ~5s vs ∞.
    `acquire_lock() { i=0; while [ $i -lt 50 ]; do if mkdir "$LOCK" 2>/dev/null; then return 0; fi; i=$((i+1)); sleep 0.1; done; rmdir "$LOCK" 2>/dev/null; if mkdir "$LOCK" 2>/dev/null; then echo "lock force-recovered" >&2; return 0; fi; return 1; }`,
    `release_lock() { rmdir "$LOCK" 2>/dev/null || true; }`,
    `trap release_lock EXIT`,
    `acquire_lock || { echo "lock busy"; exit 0; }`,
    // 2.14.13: pgrep -f instead of ps -A -o pid,cmd.
    // 2.14.15: anchor regex to "^app_process" so pgrep doesn't match SHELL
    // processes whose cmdline contains "com.genymobile.scrcpy.Server" as
    // a literal argument (e.g. the very pgrep command itself, or a
    // parallel RUN_COMMAND from ws-scrcpys retries). Field-found
    // 2026-05-23: false-positive PORT_COUNT=1 from a parallel shell made
    // singleton check claim "scrcpy ok singleton listen=0" when ZERO
    // actual scrcpy was running — wizard then declared healthy and ws-
    // scrcpy got 4011 connection refused → black tile.
    // app_process cmdline always starts with "app_process" (no path
    // prefix on Android). Shell cmdlines start with "sh" or "/system/bin/sh".
    // 2.14.15: || true on pgrep so empty-match (exit 1) doesn't trigger
    // `set -e` and abort the whole script BEFORE spawn ever runs. This was
    // THE bug — every clean-device spawn exited 1 silently, scrcpy never
    // launched, ws-scrcpy retried forever, black tile.
    `PORT_PIDS=$(pgrep -f "^app_process / ${ENTRY}.*port_number=" 2>/dev/null || true)`,
    `HEALTHY_PIDS=$(pgrep -f "^app_process / ${ENTRY}.*${healthPattern}" 2>/dev/null || true)`,
    `PORT_COUNT=$(echo $PORT_PIDS | wc -w)`,
    `HEALTHY_COUNT=$(echo $HEALTHY_PIDS | wc -w)`,
    // 2.14.3: also check if port 8886 is actually LISTENING (TCP state 0A).
    `LISTEN_COUNT=$(awk '$2 ~ /:${portHex}$/ && $4 == "0A"' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l)`,
    // 2.14.19: process-age-aware singleton check. Pure HEALTHY=1+PORT=1
    // (2.14.15) wrongly treated zombie scrcpy as healthy — Anyro's live
    // diagnostic 2026-05-23 showed scrcpy alive but port not bound
    // ("Address already in use" from TIME_WAIT). Pure LISTEN required
    // (2.14.3) wrongly killed fresh spawns mid-bind (1-2s window).
    //
    // Compromise: if our singleton exists AND port is LISTENING → OK fast.
    // If singleton exists AND port not LISTENING → check process age:
    //   - age < 10s: give it more time, exit OK (spawn-in-progress)
    //   - age >= 10s: zombie, fall through to kill+respawn
    // Single-element compound: prevents `.join('; ')` from putting `;`
    // after `then` (which sh rejects as syntax error).
    `if [ "$HEALTHY_COUNT" = "1" ] && [ "$PORT_COUNT" = "1" ]; then if [ "$LISTEN_COUNT" -ge "1" ]; then echo "scrcpy ok singleton listening ${healthPattern}"; exit 0; fi; HPID=$(echo $HEALTHY_PIDS | awk '{print $1}'); AGE=$(($(date +%s) - $(stat -c %Y /proc/$HPID 2>/dev/null || echo 0))); if [ "$AGE" -lt "10" ]; then echo "scrcpy singleton binding age=\${AGE}s ${healthPattern}"; exit 0; fi; echo "scrcpy singleton ZOMBIE age=\${AGE}s (alive but not bound) — recovering"; fi`,
    // Kill all port-mode scrcpy (duplicates of ours + stale versions).
    `for pid in $PORT_PIDS; do kill -9 "$pid" 2>/dev/null || true; done`,
    // 2.14.14: SHORT port-free wait (3s) so the whole shell finishes well
    // under ws-scrcpy's adb-shell timeout. Field-found 2026-05-23: the
    // 15s wait + bind verify made the shell exceed 20s sometimes,
    // ws-scrcpy SIGKILL'd it with exit 137, scrcpy spawn left in
    // half-state. A truly stale scrcpy that won't release in 3s is a
    // bigger problem the cooldown logic will retry. 3s catches most
    // common cases without timeout risk.
    `j=0; while [ $j -lt 30 ]; do if [ "$(awk '$2 ~ /:${portHex}$/' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l)" = "0" ]; then break; fi; j=$((j+1)); sleep 0.1; done`,
    // 2.14.14: background-detach the spawn via `setsid nohup ... &`
    // so the adb shell parent can return IMMEDIATELY. Previously we
    // slept 2s then verified bind, putting the shell at ~5-22s total
    // runtime — past ws-scrcpy's adb-shell kill threshold. Now the
    // shell exits in <1s. Bind verification moves to a separate adb
    // shell call from the host (verifyScrcpyBound below).
    `(setsid nohup sh -c 'CLASSPATH=${SERVER_PATH} app_process / ${ENTRY} ${SCRCPY_VERSION} ${args} >/data/local/tmp/ws_scrcpy.log 2>&1' >/dev/null 2>&1 </dev/null &) 2>/dev/null || (nohup sh -c 'CLASSPATH=${SERVER_PATH} app_process / ${ENTRY} ${SCRCPY_VERSION} ${args} >/data/local/tmp/ws_scrcpy.log 2>&1' >/dev/null 2>&1 </dev/null &)`,
    `echo "scrcpy spawn launched ${healthPattern} port_count_was=$PORT_COUNT listen_count_was=$LISTEN_COUNT"`,
  ].join('; ');
}

// Push the bundled scrcpy-server jar from the wizard install onto the
// device. ws-scrcpy normally handles this via adbkit sync, but force-
// respawn doesn't go through ws-scrcpy. Pushing explicitly ensures the
// next spawn always loads the wizard's current jar — covers the case
// where a previous wizard build left a stale jar from a different
// scrcpy fork that didn't recognize the current spawn args.
async function pushScrcpyJar(adbPath, serial, resourcesPath) {
  const fs = require('fs');
  const path = require('path');
  // Resolve jar location: packaged Electron exposes resourcesPath, dev
  // mode falls back to the in-tree vendor path. The bundled fork ships
  // the binary as `scrcpy-server.jar`, but its own loader expects
  // `scrcpy-server` on the device (matching adbkit sync target). Try
  // both names so we work across fork variants.
  const candidateNames = ['scrcpy-server', 'scrcpy-server.jar'];
  const baseSegments = ['ws-scrcpy', 'dist', 'vendor', 'Genymobile', 'scrcpy', 'server'];
  let jarPath = null;
  for (const name of candidateNames) {
    const candidate = resourcesPath
      ? path.join(resourcesPath, ...baseSegments, name)
      : path.resolve(__dirname, '..', 'vendor', ...baseSegments, name);
    if (fs.existsSync(candidate)) { jarPath = candidate; break; }
  }
  if (!jarPath) {
    return { pushed: false, reason: 'jar_missing', candidatesChecked: candidateNames };
  }
  const { runAdb } = require('./adb-util');
  // 2.14.2: kill port-mode scrcpy BEFORE pushing the jar. Nur's bundle
  // showed `adb push` returning exit 1 — Android can refuse to overwrite
  // a binary whose code segment is mmap'd by a live process. Killing
  // first means the path is free for overwrite.
  try {
    // 2.14.13: pgrep -f, see scrcpy-spawn.js buildSpawnCommand note.
    await runAdb(adbPath, ['-s', serial, 'shell',
      `for pid in $(pgrep -f "${ENTRY}.*port_number=" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done`,
    ], 4000);
  } catch (_) { /* benign — push will fail loudly if the kill didn't work */ }
  const r = await runAdb(adbPath, ['-s', serial, 'push', jarPath, SERVER_PATH], 10_000);
  return { pushed: r.code === 0, jarPath, code: r.code };
}

// 2.14.14: separate host-side bind verification. buildSpawnCommand now
// detaches the spawn so the shell exits in <1s (well under ws-scrcpy's
// adb-shell timeout). Caller can poll this to confirm the scrcpy
// actually bound port 8886 within an expected window.
async function verifyScrcpyBound(adbPath, serial, timeoutMs = 8000) {
  const { runAdb } = require('./adb-util');
  const portHex = SCRCPY_PORT_HEX;
  const healthPattern = `sp_build=${BUILD_ID}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await runAdb(adbPath, ['-s', serial, 'shell',
        `LISTEN=$(awk '$2 ~ /:${portHex}$/ && $4 == "0A"' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l); ` +
        `HEALTHY=$(pgrep -f "${healthPattern}" 2>/dev/null | wc -l); ` +
        `echo "listen=$LISTEN healthy=$HEALTHY"`,
      ], 3000);
      const out = (r.stdout || '').trim();
      const listenMatch = out.match(/listen=(\d+)/);
      const healthyMatch = out.match(/healthy=(\d+)/);
      if (listenMatch && healthyMatch) {
        const listen = parseInt(listenMatch[1]);
        const healthy = parseInt(healthyMatch[1]);
        if (listen >= 1 && healthy >= 1) {
          return { bound: true, msToBind: Date.now() - start, listen, healthy };
        }
      }
    } catch (_) { /* try again */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return { bound: false, msToBind: Date.now() - start };
}

module.exports = {
  SCRCPY_VERSION,
  SCRCPY_PORT,
  SCRCPY_PORT_HEX,
  BUILD_ID,
  SERVER_PATH,
  getArgs,
  buildSpawnCommand,
  pushScrcpyJar,
  verifyScrcpyBound,
};
