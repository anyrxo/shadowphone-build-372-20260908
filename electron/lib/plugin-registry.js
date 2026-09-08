'use strict';
/**
 * Feature 3 — YAML per-device plugin registry.
 *
 * Reads/writes <userData>/shadowphone/plugins.yaml: a hand-editable list of
 * external commands ("plugins") an operator can fire against a specific
 * phone from the Fleet panel picker (scrcpy is the seeded default; anything
 * else — custom scripts, other tools — is added by opening "Edit config").
 *
 * Mirrors the persisted-JSON pattern already used in device-handlers.js
 * (device-nicknames.json / device-transport.json): first-run-tolerant load,
 * lazy directory creation, best-effort writes. Uses js-yaml because the
 * schema is nested (args[], platforms[]) and meant to be hand-edited by the
 * operator directly in the file — a flat JSON blob is worse for that.
 *
 * Pure module: no ipcMain, no electron BrowserWindow/app-lifecycle wiring.
 * electron/handlers/plugin-handlers.js is the IPC-facing layer on top of this.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const yaml = require('js-yaml');
const { app } = require('electron');

const PLUGINS_DIRNAME = 'shadowphone';
const PLUGINS_FILENAME = 'plugins.yaml';

// {scrcpy} / {adb} are resolved at RUN time via the deps the caller injects
// (getScrcpyPath / getAdbPath) — never baked into the yaml as an absolute
// path, since that path is machine- and OS-specific and can move (reinstall,
// bundled-binary version bump).
const DEFAULT_CONFIG = {
  plugins: [
    {
      id: 'scrcpy-mirror',
      label: 'Mirror (scrcpy)',
      command: '{scrcpy}',
      args: ['-s', '{device.id}', '--window-title', '{device.name}'],
      platforms: ['win32', 'darwin', 'linux'],
      requires_running: false,
      mode: 'detached',
      shortcut: 'M',
    },
  ],
};

const DEFAULT_HEADER =
  '# ShadowPhone plugin registry — one entry per external command.\n' +
  '# Available template vars in "command" and each "args" item:\n' +
  '#   {device.id}   -> phone udid (USB) or tailnetIp:port (tailnet transport)\n' +
  '#   {device.name} -> phone nickname (falls back to udid if unset)\n' +
  '#   {scrcpy}      -> the bundled/detected scrcpy binary on THIS machine\n' +
  '#   {adb}         -> the resolved adb binary on THIS machine\n' +
  '#\n' +
  '# Fields per plugin:\n' +
  '#   id, label       - identifier + display name shown in the picker\n' +
  '#   command, args   - the process to spawn (args is a list)\n' +
  '#   platforms       - which process.platform values this plugin supports\n' +
  '#                     (win32 / darwin / linux); omit or leave empty for all\n' +
  '#   requires_running - true if this is a long-lived process the picker should\n' +
  '#                     treat as "already running" instead of double-launching\n' +
  '#                     (e.g. a persistent stream/tail). false = fire-and-forget.\n' +
  '#   mode            - "detached" (default, own window/process group, e.g. scrcpy)\n' +
  '#                     or "inherit" (shares this app\'s stdio — short-lived CLI tools)\n' +
  '#   shortcut        - optional single-key shortcut hint shown in the picker UI\n\n';

function getPluginsPath() {
  return path.join(app.getPath('userData'), PLUGINS_DIRNAME, PLUGINS_FILENAME);
}

function ensureDir(filePath) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch (_) { /* already exists */ }
}

function normalizePlugins(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(p => p && typeof p === 'object' && p.id && p.command)
    .map(p => ({
      id: String(p.id),
      label: String(p.label || p.id),
      command: String(p.command),
      args: Array.isArray(p.args) ? p.args.map(String) : [],
      platforms: Array.isArray(p.platforms) && p.platforms.length
        ? p.platforms.map(String)
        : ['win32', 'darwin', 'linux'],
      requires_running: !!p.requires_running,
      mode: p.mode === 'inherit' ? 'inherit' : 'detached',
      shortcut: p.shortcut ? String(p.shortcut) : null,
    }));
}

function writeDefault(filePath) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, DEFAULT_HEADER + yaml.dump(DEFAULT_CONFIG, { lineWidth: -1 }), 'utf8');
  return DEFAULT_CONFIG.plugins;
}

/**
 * Load the registry, creating a default (with a scrcpy entry) on first run.
 * Tolerant of a missing/unreadable/corrupt file — always returns a usable
 * { plugins: [] } shape so the picker UI has something to render even if the
 * on-disk yaml is broken (operator hand-edited it and made a typo).
 */
function load() {
  const filePath = getPluginsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { plugins: normalizePlugins(writeDefault(filePath)), path: filePath };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw);
    return { plugins: normalizePlugins(parsed && parsed.plugins), path: filePath };
  } catch (err) {
    console.warn('[plugin-registry] failed to load plugins.yaml, falling back to defaults:', err?.message || err);
    return {
      plugins: normalizePlugins(DEFAULT_CONFIG.plugins),
      path: filePath,
      error: err?.message || String(err),
    };
  }
}

function save(config) {
  const filePath = getPluginsPath();
  ensureDir(filePath);
  const plugins = normalizePlugins(config && config.plugins);
  fs.writeFileSync(filePath, DEFAULT_HEADER + yaml.dump({ plugins }, { lineWidth: -1 }), 'utf8');
  return { plugins, path: filePath };
}

/**
 * Resolve {device.id} the same way scrcpy-tray.launchOne picks a transport
 * target: tailnet ip:port when the phone has one, else the USB udid.
 */
function deviceIdFor(phone) {
  if (!phone) return '';
  if (phone.tailnetIp) return `${phone.tailnetIp}:${phone.port || 5555}`;
  return phone.udid || '';
}

function expandTemplate(str, vars) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\{device\.id\}/g, vars.deviceId || '')
    .replace(/\{device\.name\}/g, vars.deviceName || '')
    .replace(/\{scrcpy\}/g, vars.scrcpyPath || 'scrcpy')
    .replace(/\{adb\}/g, vars.adbPath || 'adb');
}

/**
 * Resolve a plugin's command + args against a specific phone, filling
 * {device.id} / {device.name} / {scrcpy} / {adb} tokens. Returns
 * { ok:false, error } (never throws) if the plugin doesn't support this OS.
 */
function resolveCommand(plugin, phone, deps = {}) {
  if (!plugin) return { ok: false, error: 'unknown plugin' };
  if (plugin.platforms.length && !plugin.platforms.includes(process.platform)) {
    return { ok: false, error: `plugin "${plugin.id}" is not enabled for ${process.platform}` };
  }
  const vars = {
    deviceId: deviceIdFor(phone),
    deviceName: (phone && (phone.nickname || phone.udid)) || '',
    scrcpyPath: (typeof deps.getScrcpyPath === 'function' && deps.getScrcpyPath()) || 'scrcpy',
    adbPath: (typeof deps.getAdbPath === 'function' && deps.getAdbPath()) || 'adb',
  };
  return {
    ok: true,
    command: expandTemplate(plugin.command, vars),
    args: plugin.args.map(a => expandTemplate(a, vars)),
  };
}

/**
 * Spawn a plugin's command against a phone.
 *  - mode 'detached' (default, e.g. scrcpy): fire-and-forget, own process
 *    group, stdio ignored — same shape as scrcpy-spawn-native.spawnScrcpyForDevice.
 *  - mode 'inherit': shares this app's stdio — for short-lived CLI tools
 *    whose output is useful in the app's own console; still never awaited.
 * Returns { ok:false, error } instead of throwing on an unsupported platform
 * or a spawn failure so callers (IPC handlers) can surface it directly.
 */
function run(plugin, phone, deps = {}) {
  const resolved = resolveCommand(plugin, phone, deps);
  if (!resolved.ok) return resolved;

  const spawnOpts = plugin.mode === 'inherit'
    ? { stdio: 'inherit' }
    : { detached: true, stdio: 'ignore', windowsHide: true };

  let child;
  try {
    child = spawn(resolved.command, resolved.args, spawnOpts);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  // detached+stdio:ignore async-errors with no listener otherwise (the same
  // footgun scrcpy-spawn-native.js guards against) — log + swallow so a
  // missing/misconfigured plugin binary can't crash the app.
  child.on('error', (err) => {
    console.error(`[plugin-registry] plugin "${plugin.id}" spawn failed:`, err.message);
  });
  if (plugin.mode !== 'inherit') child.unref();
  return { ok: true, pid: child.pid, command: resolved.command, args: resolved.args, child };
}

module.exports = {
  getPluginsPath,
  load,
  save,
  deviceIdFor,
  resolveCommand,
  run,
  DEFAULT_CONFIG,
};
