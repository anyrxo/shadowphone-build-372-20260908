'use strict';
/**
 * 2.16.7: persistent launcher diagnostic log.
 *
 * Writes timestamped events to <userData>/logs/launcher.log so when a VA
 * says "Launch did nothing", they can DM us the log file to triage.
 *
 * Append-only, ~5MB cap (rotated by truncate-to-2.5MB), best-effort. NO
 * crashes if logging itself fails — the launcher must never abort because
 * its own log was unwritable.
 */

const fs = require('node:fs');
const path = require('node:path');

let logPath = null;
let initialized = false;

const MAX_BYTES = 5 * 1024 * 1024;
const TRIM_TO = 2.5 * 1024 * 1024;

function init(app) {
  if (initialized) return logPath;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'launcher.log');
    initialized = true;
    write('boot', { version: app.getVersion(), pid: process.pid, platform: process.platform });
  } catch (e) {
    console.warn('[launcher-log] init failed:', e?.message || e);
  }
  return logPath;
}

function trimIfBig() {
  try {
    const st = fs.statSync(logPath);
    if (st.size > MAX_BYTES) {
      const buf = fs.readFileSync(logPath);
      // Keep the most-recent TRIM_TO bytes (drop oldest entries).
      fs.writeFileSync(logPath, buf.slice(buf.length - TRIM_TO));
    }
  } catch (_) {}
}

function write(event, data) {
  if (!logPath) return;
  try {
    const payload = { t: new Date().toISOString(), event, ...data };
    const line = JSON.stringify(payload) + '\n';
    fs.appendFileSync(logPath, line);
    if (Math.random() < 0.01) trimIfBig();
    // 2.16.57: also push to any open toolbar live-log panels.
    try {
      const mt = require('./mirror-toolbar');
      if (typeof mt.broadcastLiveLog === 'function') mt.broadcastLiveLog(payload);
    } catch (_) {}
  } catch (_) {}
}

function getLogPath() {
  return logPath;
}

function getLogsDir() {
  return logPath ? path.dirname(logPath) : null;
}

module.exports = { init, write, getLogPath, getLogsDir };
