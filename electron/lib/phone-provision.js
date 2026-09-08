'use strict';
/**
 * 2.16.2: In-app phone provisioning — turns the bootstrap-phone-tailscale.ps1
 * script into a sequence of IPC handlers the Fleet panel wizard calls.
 *
 * Flow (orchestrated by the renderer one step at a time):
 *  1. detectUsbPhones()         → list ADB-visible devices, classify each
 *                                 as already-on-tailnet vs needs-provisioning
 *  2. installTailscale(udid)    → sideload Tailscale APK via adb install
 *                                 (falls back to Play Store deep link if
 *                                 sideload fails)
 *  3. openTailscaleApp(udid)    → am start the Tailscale activity so user
 *                                 can sign in on the phone
 *  4. waitForTailnetIp(udid)    → poll up to 180s for a 100.x.x.x address
 *                                 on the phone's interfaces
 *  5. enableWifiAdb(udid)       → adb tcpip 5555 + verify with
 *                                 `adb connect <ip>:5555`
 *  6. exemptBattery(udid)       → cmd appops to allow Tailscale to run
 *                                 unrestricted in the background
 */

const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { acquireModuleRunMutex } = require('./schedule-engine');
const { runAdb: runManagedAdb } = require('./adb-util');

const TAILSCALE_PACKAGE = 'com.tailscale.ipn';
const TAILSCALE_APK_URL = 'https://pkgs.tailscale.com/stable/tailscale-1.96.3.apk';
const ADB_KEYBOARD_PACKAGE = 'com.android.adbkeyboard';
const ADB_KEYBOARD_COMPONENT = 'com.android.adbkeyboard/.AdbIME';
const ADB_KEYBOARD_SHA256 = '41a8a0996d7397a2390d1ca16a75cb66c4a7bdaa89cf4e63600a4d3fb346fbbb';
const LEGACY_ADB_KEYBOARD_SHA256 = 'e698adea5633135a067b038f9a0cf41baa4de09888713a81593fb2b9682cdc59';
const ADB_KEYBOARD_ARTIFACT_REQUIREMENTS = Object.freeze({
  packageName: ADB_KEYBOARD_PACKAGE,
  componentName: ADB_KEYBOARD_COMPONENT,
  broadcastPackage: ADB_KEYBOARD_PACKAGE,
  receiverSenderPermission: 'android.permission.DUMP',
  releaseSigned: true,
  debuggable: false,
  replacementRequired: true,
  bundledArtifactComplies: false,
});
const _adbKeyboardReady = new Set();
const _adbKeyboardTasks = new Map();

function runAdb(adbPath, args, timeoutMs) {
  return runManagedAdb(adbPath, args, timeoutMs || 10000).then(result => ({
    ...result,
    code: result.code ?? -1,
    stdout: result.stdout.trim(),
    stderr: `${result.stderr || result.error || ''}${result.timedOut ? '\n[timeout]' : ''}`.trim(),
  }));
}

function _resolveAdbKeyboardApk() {
  const candidates = [
    path.join(process.resourcesPath || '', 'helpers', 'ADBKeyboard.apk'),
    path.join(__dirname, '..', 'vendor', 'helpers', 'ADBKeyboard.apk'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function _fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function _resultFailed(result) {
  return !result || result.code !== 0 || /Failure|INSTALL_FAILED/i.test(`${result.stdout || ''}\n${result.stderr || ''}`);
}

async function _adbKeyboardPackageState(run, adbPath, udid) {
  const prefix = ['-s', udid];
  const packagePath = await run(adbPath, [...prefix, 'shell', 'pm', 'path', ADB_KEYBOARD_PACKAGE], 5000);
  const apkPath = String(packagePath.stdout || '').split(/\r?\n/)
    .map(line => line.replace(/^package:/, '').trim())
    .find(Boolean) || null;
  if (!apkPath) return { installed: false, apkPath: null, hash: null };
  const digest = await run(adbPath, [...prefix, 'shell', 'sha256sum', apkPath], 5000);
  const hash = String(digest.stdout || '').trim().match(/^([a-fA-F0-9]{64})\b/)?.[1]?.toLowerCase() || null;
  return { installed: true, apkPath, hash };
}

async function _snapshotAdbKeyboardProfiles(run, adbPath, udid) {
  const prefix = ['-s', udid];
  const usersResult = await run(adbPath, [...prefix, 'shell', 'pm', 'list', 'users'], 8000);
  if (_resultFailed(usersResult)) throw new Error('Could not enumerate Android users');
  const userIds = [...String(usersResult.stdout || '').matchAll(/UserInfo\{(\d+):/g)].map(match => match[1]);
  if (userIds.length === 0) throw new Error('No Android users were returned');

  const profiles = [];
  for (const userId of userIds) {
    const [installed, defaultIme, enabledImes] = await Promise.all([
      run(adbPath, [...prefix, 'shell', 'pm', 'list', 'packages', '--user', userId, ADB_KEYBOARD_PACKAGE], 5000),
      run(adbPath, [...prefix, 'shell', 'settings', '--user', userId, 'get', 'secure', 'default_input_method'], 5000),
      run(adbPath, [...prefix, 'shell', 'settings', '--user', userId, 'get', 'secure', 'enabled_input_methods'], 5000),
    ]);
    const defaultValue = String(defaultIme.stdout || '').trim();
    const enabledValue = String(enabledImes.stdout || '').trim();
    profiles.push({
      userId,
      installed: String(installed.stdout || '').includes(`package:${ADB_KEYBOARD_PACKAGE}`),
      defaultIme: defaultValue === 'null' ? '' : defaultValue,
      helperEnabled: enabledValue.includes(ADB_KEYBOARD_COMPONENT),
      helperDefault: defaultValue === ADB_KEYBOARD_COMPONENT,
    });
  }
  return profiles;
}

async function _exposeAdbKeyboardToMissingProfiles(run, adbPath, udid, profiles) {
  const prefix = ['-s', udid];
  let exposed = 0;
  for (const profile of profiles) {
    if (profile.installed) continue;
    const result = await run(adbPath, [
      ...prefix, 'shell', 'pm', 'install-existing', '--user', profile.userId, ADB_KEYBOARD_PACKAGE,
    ], 10000);
    if (_resultFailed(result)) throw new Error(`ADBKeyboard could not be exposed to user ${profile.userId}`);
    exposed += 1;
  }
  return exposed;
}

async function _installAdbKeyboardForProfiles(run, adbPath, udid, apkPath, profiles) {
  const prefix = ['-s', udid];
  const baseUser = profiles.find(profile => profile.userId === '0')?.userId || profiles[0]?.userId;
  if (!baseUser) throw new Error('No Android user is available for installation');
  const install = await run(adbPath, [...prefix, 'install', '--user', baseUser, apkPath], 90000);
  if (_resultFailed(install)) throw new Error('Compatible ADBKeyboard installation failed');

  for (const profile of profiles) {
    if (profile.userId !== baseUser) {
      const expose = await run(adbPath, [
        ...prefix, 'shell', 'pm', 'install-existing', '--user', profile.userId, ADB_KEYBOARD_PACKAGE,
      ], 10000);
      if (_resultFailed(expose)) throw new Error(`ADBKeyboard could not be exposed to user ${profile.userId}`);
    }
    if (profile.helperEnabled || profile.helperDefault) {
      const enabled = await run(adbPath, [
        ...prefix, 'shell', 'ime', 'enable', '--user', profile.userId, ADB_KEYBOARD_COMPONENT,
      ], 5000);
      if (_resultFailed(enabled)) throw new Error(`ADBKeyboard enabled state could not be restored for user ${profile.userId}`);
    }
    if (profile.helperDefault) {
      const selected = await run(adbPath, [
        ...prefix, 'shell', 'ime', 'set', '--user', profile.userId, ADB_KEYBOARD_COMPONENT,
      ], 5000);
      if (_resultFailed(selected)) throw new Error(`ADBKeyboard default state could not be restored for user ${profile.userId}`);
    }
  }
}

async function _rollbackAdbKeyboard(run, adbPath, udid, backupPath, profiles, legacyHash) {
  const prefix = ['-s', udid];
  try {
    await run(adbPath, [...prefix, 'uninstall', ADB_KEYBOARD_PACKAGE], 30000);
    await _installAdbKeyboardForProfiles(
      run,
      adbPath,
      udid,
      backupPath,
      profiles.filter(profile => profile.installed),
    );
    const restored = await _adbKeyboardPackageState(run, adbPath, udid);
    return restored.hash === legacyHash;
  } catch {
    return false;
  }
}

async function _ensureAdbKeyboard(adbPath, udid, opts) {
  const run = opts.runAdb || runAdb;
  const apkPath = opts.apkPath || _resolveAdbKeyboardApk();
  const expectedHash = String(opts.expectedHash || ADB_KEYBOARD_SHA256).toLowerCase();
  const legacyHash = String(opts.legacyHash || LEGACY_ADB_KEYBOARD_SHA256).toLowerCase();
  if (!apkPath || !fs.existsSync(apkPath)) {
    return { ok: false, code: 'ADB_KEYBOARD_BUNDLE_MISSING', error: 'Compatible ADBKeyboard is missing from the desktop bundle' };
  }
  if (_fileSha256(apkPath) !== expectedHash) {
    return { ok: false, code: 'ADB_KEYBOARD_BUNDLE_INVALID', error: 'Bundled ADBKeyboard failed integrity verification' };
  }

  const state = await _adbKeyboardPackageState(run, adbPath, udid);
  if (state.hash === expectedHash) {
    try {
      const profiles = await _snapshotAdbKeyboardProfiles(run, adbPath, udid);
      const exposed = await _exposeAdbKeyboardToMissingProfiles(run, adbPath, udid, profiles);
      return {
        ok: true,
        action: exposed > 0 ? 'exposed-compatible' : 'already-compatible',
        hash: expectedHash,
        profiles: profiles.length,
        exposed,
      };
    } catch {
      return { ok: false, code: 'ADB_KEYBOARD_EXPOSURE_FAILED', error: 'Compatible ADBKeyboard could not be exposed to every Android profile' };
    }
  }
  if (state.installed && state.hash !== legacyHash) {
    return { ok: false, code: 'ADB_KEYBOARD_UNKNOWN_INSTALL', error: 'Unknown ADBKeyboard build detected; automatic replacement was refused' };
  }

  const profiles = await _snapshotAdbKeyboardProfiles(run, adbPath, udid);
  const prefix = ['-s', udid];
  let backupPath = null;
  if (state.installed) {
    const tempDir = opts.tempDir || path.join(os.tmpdir(), 'shadowphone-adbkeyboard-rollback');
    fs.mkdirSync(tempDir, { recursive: true });
    backupPath = path.join(tempDir, `legacy-${createHash('sha256').update(`${udid}-${Date.now()}`).digest('hex').slice(0, 12)}.apk`);
    const pulled = await run(adbPath, [...prefix, 'pull', state.apkPath, backupPath], 30000);
    if (_resultFailed(pulled) || !fs.existsSync(backupPath) || _fileSha256(backupPath) !== legacyHash) {
      return { ok: false, code: 'ADB_KEYBOARD_BACKUP_FAILED', error: 'Legacy ADBKeyboard backup could not be verified; migration was not started' };
    }
  }

  try {
    if (state.installed) {
      const removed = await run(adbPath, [...prefix, 'uninstall', ADB_KEYBOARD_PACKAGE], 30000);
      if (_resultFailed(removed)) throw new Error('Legacy ADBKeyboard uninstall failed');
    }
    await _installAdbKeyboardForProfiles(run, adbPath, udid, apkPath, profiles);
    const verified = await _adbKeyboardPackageState(run, adbPath, udid);
    if (verified.hash !== expectedHash) throw new Error('Compatible ADBKeyboard hash did not verify after installation');
    if (backupPath) fs.unlinkSync(backupPath);
    return { ok: true, action: state.installed ? 'migrated-legacy' : 'installed-compatible', hash: expectedHash, profiles: profiles.length };
  } catch {
    const rollbackOk = backupPath
      ? await _rollbackAdbKeyboard(run, adbPath, udid, backupPath, profiles, legacyHash)
      : false;
    if (!state.installed) {
      await run(adbPath, [...prefix, 'uninstall', ADB_KEYBOARD_PACKAGE], 30000).catch(() => null);
    }
    return {
      ok: false,
      code: state.installed ? 'ADB_KEYBOARD_MIGRATION_FAILED' : 'ADB_KEYBOARD_INSTALL_FAILED',
      error: state.installed
        ? 'Compatible ADBKeyboard migration failed'
        : 'Compatible ADBKeyboard installation failed',
      rollback_ok: rollbackOk,
    };
  }
}

async function ensureAdbKeyboard(adbPath, udid, opts = {}) {
  const run = opts.runAdb || runAdb;
  const serial = await run(adbPath, ['-s', udid, 'shell', 'getprop', 'ro.serialno'], 5000);
  const hardwareId = String(serial?.stdout || '').trim();
  if (serial?.code !== 0 || !/^[A-Za-z0-9._:-]+$/.test(hardwareId) || /^(null|unknown|undefined)$/i.test(hardwareId)) {
    return { ok: false, code: 'HARDWARE_IDENTITY_UNVERIFIED', error: 'Physical phone identity could not be verified' };
  }

  let release = null;
  if (opts.hardwareLease?.hardwareKey !== hardwareId) {
    try {
      release = await acquireModuleRunMutex(hardwareId).wait;
    } catch (error) {
      return { ok: false, code: error?.code || 'MODULE_ABORTED', error: error?.message || 'ADBKeyboard ensure was cancelled' };
    }
  }

  try {
    if (opts.useCache !== false && _adbKeyboardReady.has(hardwareId)) return { ok: true, action: 'cached-compatible' };
    if (opts.useCache !== false && _adbKeyboardTasks.has(hardwareId)) return await _adbKeyboardTasks.get(hardwareId);
    const task = _ensureAdbKeyboard(adbPath, udid, opts).then(result => {
      if (result.ok && opts.useCache !== false) _adbKeyboardReady.add(hardwareId);
      return result;
    }).finally(() => _adbKeyboardTasks.delete(hardwareId));
    if (opts.useCache !== false) _adbKeyboardTasks.set(hardwareId, task);
    return await task;
  } finally {
    release?.();
  }
}

async function getDeviceProp(adbPath, udid, prop) {
  const r = await runAdb(adbPath, ['-s', udid, 'shell', 'getprop', prop], 4000);
  return r.code === 0 ? r.stdout.trim() : '';
}

async function getTailnetIp(adbPath, udid) {
  const r = await runAdb(adbPath, ['-s', udid, 'shell', 'ip', '-4', 'addr', 'show'], 4000);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split('\n')) {
    const m = /inet (100\.\d+\.\d+\.\d+)\//.exec(line);
    if (m) return m[1];
  }
  return null;
}

async function detectUsbPhones(adbPath) {
  const r = await runAdb(adbPath, ['devices', '-l'], 5000);
  if (r.code !== 0) return { ok: false, error: r.stderr || 'adb devices failed', phones: [] };
  const phones = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0] || parts[1] !== 'device') continue;
    const udid = parts[0];
    // Skip TCP entries — only physical USB connections matter for provisioning.
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(udid)) continue;
    const [model, brand, tsInstalled, tailnetIp] = await Promise.all([
      getDeviceProp(adbPath, udid, 'ro.product.model'),
      getDeviceProp(adbPath, udid, 'ro.product.brand'),
      runAdb(adbPath, ['-s', udid, 'shell', 'pm', 'list', 'packages', TAILSCALE_PACKAGE], 4000)
        .then(r => r.stdout.includes(TAILSCALE_PACKAGE)),
      getTailnetIp(adbPath, udid),
    ]);
    phones.push({
      udid,
      model: model || 'Unknown',
      brand: brand || 'Android',
      tailscaleInstalled: tsInstalled,
      tailnetIp: tailnetIp,
      ready: !!tailnetIp,  // already provisioned if it has a 100.x.x.x IP
    });
  }
  return { ok: true, phones };
}

async function downloadApk(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const handler = (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return https.get(res.headers.location, handler).on('error', reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(destPath, () => {});
        return reject(new Error(`download status ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    };
    https.get(url, handler).on('error', (err) => {
      file.close(); fs.unlink(destPath, () => {}); reject(err);
    });
  });
}

async function installTailscale(adbPath, udid, opts = {}) {
  // First check if already installed.
  const check = await runAdb(adbPath, ['-s', udid, 'shell', 'pm', 'list', 'packages', TAILSCALE_PACKAGE], 4000);
  if (check.stdout.includes(TAILSCALE_PACKAGE)) {
    return { ok: true, alreadyInstalled: true };
  }
  // Try sideload first — fastest, no Play Store dance.
  const tmpDir = path.join(require('os').tmpdir(), 'shadowphone-apks');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
  const apkPath = path.join(tmpDir, 'tailscale.apk');
  if (!fs.existsSync(apkPath) || (opts.forceRedownload && fs.statSync(apkPath).size < 1_000_000)) {
    try { await downloadApk(TAILSCALE_APK_URL, apkPath); }
    catch (e) {
      // Sideload fails or APK URL invalid (versions get pulled) — fall back
      // to opening Play Store on the phone for manual install.
      await runAdb(adbPath, [
        '-s', udid, 'shell', 'am', 'start',
        '-a', 'android.intent.action.VIEW',
        '-d', `market://details?id=${TAILSCALE_PACKAGE}`,
      ], 8000);
      return { ok: true, method: 'play-store', manual: true,
        hint: 'Play Store opened on the phone — tap INSTALL, then come back here and click Continue.' };
    }
  }
  // Install the APK.
  const install = await runAdb(adbPath, ['-s', udid, 'install', '-r', apkPath], 90000);
  if (install.code !== 0 || /Failure/i.test(install.stdout + install.stderr)) {
    // Sideload rejected — fall back to Play Store.
    await runAdb(adbPath, [
      '-s', udid, 'shell', 'am', 'start',
      '-a', 'android.intent.action.VIEW',
      '-d', `market://details?id=${TAILSCALE_PACKAGE}`,
    ], 8000);
    return { ok: true, method: 'play-store', manual: true,
      hint: `Sideload failed (${(install.stderr || install.stdout).split('\n')[0]}). Play Store opened — tap INSTALL.` };
  }
  return { ok: true, method: 'sideload', manual: false };
}

async function openTailscaleApp(adbPath, udid) {
  const r = await runAdb(adbPath, [
    '-s', udid, 'shell', 'am', 'start',
    '-n', `${TAILSCALE_PACKAGE}/.ui.MainActivity`,
  ], 6000);
  if (r.code !== 0) return { ok: false, error: r.stderr || 'am start failed' };
  return { ok: true };
}

async function waitForTailnetIp(adbPath, udid, opts = {}) {
  const timeoutMs = opts.timeoutMs || 180_000;
  const intervalMs = opts.intervalMs || 2000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await getTailnetIp(adbPath, udid);
    if (ip) return { ok: true, ip };
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok: false, error: `Timed out after ${Math.round(timeoutMs/1000)}s. Make sure Tailscale on the phone shows "Connected".` };
}

async function enableWifiAdb(adbPath, udid, tailnetIp) {
  const tcpip = await runAdb(adbPath, ['-s', udid, 'tcpip', '5555'], 5000);
  // tcpip returns 0 even on success-with-stderr; verify by connect.
  await new Promise(r => setTimeout(r, 1500)); // give adbd a moment to restart
  const connect = await runAdb(adbPath, ['connect', `${tailnetIp}:5555`], 5000);
  if (!/already connected|connected to/.test(connect.stdout + connect.stderr)) {
    return { ok: false, error: `adb connect to ${tailnetIp}:5555 failed: ${connect.stdout || connect.stderr}` };
  }
  return { ok: true };
}

async function exemptBattery(adbPath, udid) {
  // Tailscale Android bug 14095: stock battery optimizer kills the service.
  // Setting RUN_ANY_IN_BACKGROUND to allow keeps it alive.
  await runAdb(adbPath, [
    '-s', udid, 'shell', 'cmd', 'appops', 'set',
    TAILSCALE_PACKAGE, 'RUN_ANY_IN_BACKGROUND', 'allow',
  ], 5000);
  // Also try the modern Doze whitelist (requires DUMP permission on some ROMs).
  await runAdb(adbPath, [
    '-s', udid, 'shell', 'dumpsys', 'deviceidle', 'whitelist', `+${TAILSCALE_PACKAGE}`,
  ], 5000).catch(() => {});
  return { ok: true };
}

/**
 * Install ShadowPhone Companion APK on the connected phone. Grants
 * WRITE_SECURE_SETTINGS so the companion's BootReceiver can re-assert
 * adb_wifi_enabled = 1 at every boot. Idempotent — adb install -r
 * accepts already-installed packages.
 *
 * Path resolution: looks for the bundled APK at
 *   <electron-resources>/vendor/companion/shadowphone-companion.apk
 * Falls back to a dev path when running from source.
 */
async function installCompanion(adbPath, udid) {
    const path = require('path')
    const fs = require('fs')

    const candidates = [
        path.join(process.resourcesPath || '', 'vendor', 'companion', 'shadowphone-companion.apk'),
        path.join(__dirname, '..', 'vendor', 'companion', 'shadowphone-companion.apk'),
    ]
    const apkPath = candidates.find(p => fs.existsSync(p))
    if (!apkPath) {
        return {
            ok: false,
            error: 'companion APK not found in vendor bundle — build pipeline issue',
            checked: candidates,
        }
    }

    const pkg = 'io.shadowphone.companion'
    const args = ['-s', udid]
    const run = async (cmd) => {
        const result = await runManagedAdb(adbPath, cmd, 30000)
        return {
            ok: result.code === 0,
            stdout: result.stdout,
            stderr: result.stderr,
            err: result.code === 0 ? null : new Error(result.error || result.stderr || 'adb failed'),
        }
    }

    // 1. Install to OWNER profile (user 0) — Companion's job is to write
    //    Settings.Global.adb_wifi_enabled at boot, which is a system-wide
    //    key. We need the BootReceiver to fire on owner-profile boot, not
    //    on whichever secondary GrapheneOS user happens to be foreground
    //    when the wizard runs. `--user 0` pins it. Same shape as Tailscale
    //    living on the owner profile only.
    const install = await run([...args, 'install', '-r', '--user', '0', apkPath])
    if (!install.ok || /Failure/i.test(install.stdout)) {
        return {
            ok: false,
            step: 'install',
            error: (install.stderr || install.stdout || 'install failed').slice(0, 400),
        }
    }

    // 2. Grant WRITE_SECURE_SETTINGS for user 0 specifically. Silently
    //    fails if Android < 11 or grant restricted on this firmware;
    //    we surface the warning but treat the wizard step as partial.
    const grant = await run([...args, 'shell', 'pm', 'grant', '--user', '0', pkg,
        'android.permission.WRITE_SECURE_SETTINGS'])

    // 3. Launch BootHelperActivity to (a) write the setting now and
    //    (b) un-stick the app from Android's stopped state. Without
    //    this an Activity launch, a headless app NEVER receives
    //    BOOT_COMPLETED on subsequent reboots — Android's stopped-state
    //    rule blocks broadcasts to apps the user has never launched.
    //    Verified live 2026-05-27 on Pixel 6 / Android 16. The Activity
    //    runs enableWirelessDebugging in onCreate then finishes; user
    //    sees nothing (Theme.NoDisplay).
    await run([...args, 'shell', 'am', 'start-activity', '--user', '0',
        '-n', `${pkg}/.BootHelperActivity`])

    // 4. Verify by reading the (system-wide) setting back. No --user
    //    needed for `settings get global` — Settings.Global is per-device.
    await new Promise(r => setTimeout(r, 1500))  // settle delay
    const verify = await run([...args, 'shell', 'settings', 'get', 'global',
        'adb_wifi_enabled'])
    const value = String(verify.stdout || '').trim()
    const enabled = value === '1'

    // 5. Probe the Companion's port-broadcast HTTP service over Tailnet.
    //    Failure isn't fatal — surface as a warning so the wizard tells
    //    the user reboot-recovery may not be autonomous.
    let broadcastOk = false
    let broadcastError = null
    let advertisedPort = null
    try {
        const ipR = await run([...args, 'shell', 'ip', '-4', 'addr', 'show'])
        const tailnetIp = ((ipR.stdout || '').match(/100\.\d+\.\d+\.\d+/) || [])[0]
        if (tailnetIp) {
            // probeCompanion accepts adbPort=0 as "alive but port unknown"
            // (Android 16 SELinux blocks the Companion from reading the
            // adb TLS port — desktop scanner finds it instead). Either a
            // numeric adbPort OR a clean 200 with adbPort=0 = service up.
            const { probeCompanion } = require('./companion-discovery')
            const r = await probeCompanion(tailnetIp, { timeoutMs: 3000 })
            broadcastOk = true
            advertisedPort = r.adbPort || null
        } else {
            broadcastError = 'no tailnet IP — Tailscale not connected yet'
        }
    } catch (e) {
        broadcastError = e?.message || String(e)
    }

    return {
        ok: enabled,
        installed: true,
        granted: grant.ok && !/Failure/i.test(grant.stdout + grant.stderr),
        adb_wifi_enabled: value,
        broadcastOk,
        broadcastError,
        advertisedPort,
        warning: enabled
            ? (broadcastOk ? null
                : `companion installed but port-broadcast service didn't respond: ${broadcastError || 'unknown'}. Reboot-recovery may need manual reconnect.`)
            : (grant.ok
                ? 'companion installed but adb_wifi_enabled not flipping — does this Android build expose Wireless Debugging?'
                : `pm grant failed: ${(grant.stderr || grant.stdout).slice(0, 200)}`),
    }
}

/**
 * 2.21.11: Provision Tailscale on every secondary user profile.
 *
 * The scalability bug Nur's claude correctly diagnosed: Android only runs
 * the foreground user's VPN. When ShadowPhone switches from user 0 to a
 * secondary IG profile (e.g. user 14), user 0's Tailscale tunnel tears
 * down and the phone leaves the tailnet entirely. SaaS desktop loses
 * adb-over-tailscale access to the phone until ShadowPhone switches
 * back to user 0.
 *
 * Fix: install Tailscale on EVERY user profile + auto-grant VPN consent
 * + set always-on VPN. Each user gets its own Tailscale instance on its
 * own auth state. After this provisioning step the phone stays on
 * tailnet across any profile switch — whichever user is foreground has
 * its own running Tailscale tunnel.
 *
 * Cost: each user counts as a separate device on the tailnet. 25
 * profiles per phone × 3 phones = 75 devices. Within Tailscale free
 * tier (100 devices) for a single farm; paid plans handle 100+.
 *
 * Auth caveat: each user's Tailscale needs to be SIGNED IN once. We can
 * auto-grant VPN consent via appops but the OAuth sign-in requires
 * either: (a) manual sign-in per user (one-time, takes ~15s per user),
 * OR (b) a pre-shared Tailscale auth key (tskey-...) injected via the
 * `tailscale://login/<authkey>` deep link. Option (b) is fully
 * autonomous if the operator has an auth-key generated in the Tailscale
 * admin panel.
 */
async function listSecondaryUsers(adbPath, udid) {
  const r = await runAdb(adbPath, ['-s', udid, 'shell', 'pm', 'list', 'users'], 5000);
  if (r.code !== 0) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = /UserInfo\{(\d+):/.exec(line);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    if (id !== 0) out.push(id);
  }
  return out;
}

async function _isTailscaleInstalled(adbPath, udid, userId) {
  const r = await runAdb(adbPath, ['-s', udid, 'shell', 'pm', 'list', 'packages',
    '--user', String(userId), TAILSCALE_PACKAGE], 4000);
  return r.stdout.includes(TAILSCALE_PACKAGE);
}

async function _setAlwaysOnVpn(adbPath, udid, userId) {
  // settings put global always_on_vpn_app <pkg> ties Android's VPN keepalive
  // to Tailscale for this user. Without lockdown so a momentary VPN drop
  // doesn't break IG's network access (lockdown causes Instagram to flag
  // suspicious-network on reconnect).
  await runAdb(adbPath, ['-s', udid, 'shell', 'settings', '--user', String(userId),
    'put', 'global', 'always_on_vpn_app', TAILSCALE_PACKAGE], 4000);
  await runAdb(adbPath, ['-s', udid, 'shell', 'settings', '--user', String(userId),
    'put', 'global', 'always_on_vpn_lockdown', '0'], 4000);
}

async function _grantVpnConsent(adbPath, udid, userId) {
  // appops ACTIVATE_VPN bypasses the per-user VPN consent dialog so the
  // first time Tailscale starts on this user it doesn't pop a modal.
  await runAdb(adbPath, ['-s', udid, 'shell', 'cmd', 'appops', 'set',
    '--user', String(userId), TAILSCALE_PACKAGE, 'ACTIVATE_VPN', 'allow'], 4000);
  // Battery exempt so VPN survives Doze.
  await runAdb(adbPath, ['-s', udid, 'shell', 'cmd', 'appops', 'set',
    TAILSCALE_PACKAGE, 'RUN_ANY_IN_BACKGROUND', 'allow'], 4000);
}

async function _launchTailscaleWithAuthKey(adbPath, udid, userId, authKey) {
  // tailscale://login/<authkey> deep-link autosigns Tailscale to the
  // tailnet associated with that key. Tailscale Android handles this via
  // its registered URL handler. Auth key is one-time-use (or reusable
  // depending on how it was generated in the admin panel).
  if (!authKey) return { ok: false, error: 'no auth key provided' };
  const url = `tailscale://login/${authKey}`;
  const r = await runAdb(adbPath, ['-s', udid, 'shell', 'am', 'start-activity',
    '--user', String(userId),
    '-a', 'android.intent.action.VIEW',
    '-d', url], 8000);
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Provision Tailscale on every secondary user profile on this phone.
 * Returns per-user status so the caller can report any failures.
 *
 * authKey: optional Tailscale auth key (tskey-...). If absent, Tailscale
 * is installed + always-on configured but each user's sign-in is left
 * to the operator (manual one-time tap per profile).
 */
/**
 * 2.21.13: Proactive Tailscale heartbeat — revive a dead Tailscale process
 * even when phone is foregrounded on a secondary user.
 *
 * The refined behavior Nur's claude documented: always-on VPN keeps a
 * RUNNING tunnel alive across user switches, BUT if Tailscale gets killed
 * (Android OOM, app crash, ShadowPhone update force-stop), it WON'T
 * auto-restart on the foreground secondary user — only when user 0
 * comes back or the phone reboots. With ShadowPhone constantly switching
 * profiles, this means phones sit dead on tailnet for hours.
 *
 * Trick: `am start-service --user 0 -n <pkg>/<service>` starts user 0's
 * service in BACKGROUND, regardless of which user is foreground. Android
 * allows cross-user service starts when invoked via adb shell (uid 2000).
 * That wakes Tailscale without disrupting the secondary user's foreground IG.
 *
 * Triple-pronged revival (any one works):
 *   1. am start-service --user 0 com.tailscale.ipn/.IPNService
 *   2. monkey -p com.tailscale.ipn --user 0 (fallback that simulates launcher click)
 *   3. am start-foreground-service --user 0 (Android 13+ pathway)
 */
async function ensureTailscaleRunning(adbPath, udid) {
  // Is Tailscale's process alive on user 0?
  const psR = await runAdb(adbPath, ['-s', udid, 'shell',
    'ps', '-A', '-o', 'PID,USER,NAME'], 4000);
  const lines = psR.stdout.split('\n');
  let alive = false;
  for (const line of lines) {
    // u0_aNN format = user 0's app processes
    if (line.includes('com.tailscale.ipn') && line.includes('u0_a')) {
      alive = true;
      break;
    }
  }
  if (alive) return { ok: true, action: 'already-running' };

  // Try Intent revival paths in order of preference.
  const attempts = [];

  // 1. Start the IPN service directly on user 0.
  let r = await runAdb(adbPath, ['-s', udid, 'shell',
    'am', 'start-service', '--user', '0',
    '-n', 'com.tailscale.ipn/.IPNService'], 6000);
  attempts.push({ method: 'start-service IPNService', code: r.code,
                  stdout: r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 200) });

  await new Promise(s => setTimeout(s, 1500));
  const recheck1 = await runAdb(adbPath, ['-s', udid, 'shell',
    'ps', '-A', '-o', 'NAME'], 3000);
  if (recheck1.stdout.includes('com.tailscale.ipn')) {
    return { ok: true, action: 'revived-via-start-service', attempts };
  }

  // 2. monkey launcher click on user 0.
  r = await runAdb(adbPath, ['-s', udid, 'shell',
    'monkey', '-p', 'com.tailscale.ipn', '--user', '0',
    '-c', 'android.intent.category.LAUNCHER', '1'], 6000);
  attempts.push({ method: 'monkey launcher', code: r.code,
                  stdout: r.stdout.slice(0, 200) });

  await new Promise(s => setTimeout(s, 1500));
  const recheck2 = await runAdb(adbPath, ['-s', udid, 'shell',
    'ps', '-A', '-o', 'NAME'], 3000);
  if (recheck2.stdout.includes('com.tailscale.ipn')) {
    return { ok: true, action: 'revived-via-monkey', attempts };
  }

  // 3. start-foreground-service (Android 13+).
  r = await runAdb(adbPath, ['-s', udid, 'shell',
    'am', 'start-foreground-service', '--user', '0',
    '-n', 'com.tailscale.ipn/.IPNService'], 6000);
  attempts.push({ method: 'start-foreground-service', code: r.code,
                  stdout: r.stdout.slice(0, 200) });

  await new Promise(s => setTimeout(s, 2000));
  const recheck3 = await runAdb(adbPath, ['-s', udid, 'shell',
    'ps', '-A', '-o', 'NAME'], 3000);
  if (recheck3.stdout.includes('com.tailscale.ipn')) {
    return { ok: true, action: 'revived-via-foreground-service', attempts };
  }

  // 4. LAST RESORT: transient switch to user 0 + back. Live-validated as
  // the only revival path that works when phone is foregrounded on a
  // secondary user with Tailscale dead — paths 1-3 are all blocked by
  // Android's per-app service-export rules. This briefly interrupts the
  // foreground IG profile but recovers in ~10s; the secondary user's
  // app state is preserved across the switch.
  //
  // The Owner swap is guarded: it requires the caller's phone-lock
  // ownerToken (so it can never fire on a phone a run/sweep/switch is
  // touching) and the guard owns the capture/restore — a persisted
  // obligation plus a verified start-user/switch-user restore, closing
  // the hole where one adb flake at restore time stranded the phone
  // on Owner and the next pass read current-user=0 and never restored.
  const opts = arguments[2] || {};
  if (opts.allowTransientSwitch !== false) {
    const scheduleEngine = require('./schedule-engine');
    if (!scheduleEngine.isPhoneLockOwnerToken(opts.ownerToken, udid)) {
      return { ok: false, action: 'transient-switch-blocked-no-lock', attempts };
    }
    const execAdb = (adbArgs, timeoutMs) =>
      runAdb(adbPath, adbArgs, timeoutMs).then(r => r.stdout || '');
    const sw = await scheduleEngine.guardedSwitchUser({
      execAdb, serial: udid, targetUser: '0', intent: 'maintenance', ownerToken: opts.ownerToken,
    });
    if (!sw.success) {
      // The switch may have half-landed after registering its obligation.
      if (sw.restoreTo) await scheduleEngine.completeRestore({ execAdb, serial: udid });
      return { ok: false, action: 'transient-switch-blocked', code: sw.code, attempts };
    }
    attempts.push({ method: 'transient-switch-to-0', originalUser: sw.restoreTo });
    // Settle: the guard verified get-current-user=0, give the foreground a
    // moment to catch up before injecting the launcher click.
    await new Promise(s => setTimeout(s, 2000));
    // Explicitly monkey-launch Tailscale. Live-tested: always-on VPN
    // alone does NOT auto-start Tailscale on user-0 foreground return.
    // monkey works because user 0 is foreground (the per-user
    // foreground-only rule blocked it earlier from secondary users).
    await runAdb(adbPath, ['-s', udid, 'shell',
      'monkey', '-p', 'com.tailscale.ipn',
      '-c', 'android.intent.category.LAUNCHER', '1'], 6000);
    // Poll for the process to come up — up to 12s.
    let aliveAfterSwitch = false;
    for (let i = 0; i < 6; i++) {
      await new Promise(s => setTimeout(s, 2000));
      const recheck = await runAdb(adbPath, ['-s', udid, 'shell',
        'ps', '-A'], 4000);
      if (recheck.stdout.includes('com.tailscale.ipn')) {
        aliveAfterSwitch = true;
        break;
      }
    }
    // Verified restore. Tailscale's session persists across the switch
    // (verified live) so the foreground secondary user gets tailnet for
    // free. On failure completeRestore keeps the obligation, so the next
    // companion pass retries the restore before any further owner swaps.
    const restored = await scheduleEngine.completeRestore({ execAdb, serial: udid });
    if (!restored.success) {
      return { ok: false, action: 'transient-switch-restore-pending', attempts };
    }
    if (aliveAfterSwitch) {
      return { ok: true, action: 'revived-via-transient-switch', attempts, originalUser: restored.restoredTo };
    }
  }

  return { ok: false, action: 'all-revivals-failed', attempts };
}

async function provisionTailscaleAllUsers(adbPath, udid, opts = {}) {
  const authKey = opts.authKey || process.env.TAILSCALE_AUTH_KEY || '';
  // 2.21.12: include user 0 too. AJ's Mac never had always-on set on user 0
  // (only Nur's farm did, and only because Nur's claude set it manually).
  // Without this, the OWNER profile's Tailscale tunnel dies when phone
  // backgrounds (Doze, screen off, low memory), so even WITHOUT a profile
  // switch the phone can leave the tailnet — that was AJ's actual scenario.
  const users = [0, ...await listSecondaryUsers(adbPath, udid)];
  const results = [];

  for (const userId of users) {
    const status = { userId, installed: false, granted: false, alwaysOn: false, authed: false };
    try {
      if (!await _isTailscaleInstalled(adbPath, udid, userId)) {
        const r = await runAdb(adbPath, ['-s', udid, 'shell', 'pm', 'install-existing',
          '--user', String(userId), TAILSCALE_PACKAGE], 8000);
        status.installed = r.code === 0 && /installed for user/.test(r.stdout);
      } else {
        status.installed = true;
      }

      await _grantVpnConsent(adbPath, udid, userId);
      status.granted = true;

      await _setAlwaysOnVpn(adbPath, udid, userId);
      status.alwaysOn = true;

      if (authKey) {
        const r = await _launchTailscaleWithAuthKey(adbPath, udid, userId, authKey);
        status.authed = r.ok;
        status.authDetail = (r.stdout || r.stderr || '').slice(0, 200);
      }
    } catch (e) {
      status.error = e?.message || String(e);
    }
    results.push(status);
  }

  return {
    ok: results.every(r => r.installed && r.granted && r.alwaysOn),
    users: results,
    needsManualAuth: !authKey,
  };
}

module.exports = {
  detectUsbPhones,
  installTailscale,
  openTailscaleApp,
  waitForTailnetIp,
  enableWifiAdb,
  exemptBattery,
  installCompanion,
  ensureAdbKeyboard,
  provisionTailscaleAllUsers,
  listSecondaryUsers,
  ensureTailscaleRunning,
  ADB_KEYBOARD_ARTIFACT_REQUIREMENTS,
};
