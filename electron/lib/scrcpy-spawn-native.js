'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// 2.16.0: locate scrcpy.exe across packaged + dev locations.
// In packaged builds, electron-builder lays our extraResources at
// process.resourcesPath. In dev (npm start), we use the in-repo path.
function findScrcpyBinary(opts) {
  const resPath = (opts && opts.resourcesPath) || process.resourcesPath || '';
  const candidates = [
    path.join(resPath, 'scrcpy', 'scrcpy.exe'),
    path.join(resPath, 'python-brain', 'scrcpy.exe'),
    path.join(__dirname, '..', 'python-bundle', 'scrcpy.exe'),
    path.join(__dirname, '..', 'python', 'scrcpy.exe'),
  ];
  // Windows: scoop / winget / choco installs scrcpy but doesn't always shim it onto
  // PATH. Glob the common parent dirs (no shell wildcards — we expand manually).
  if (process.platform === 'win32') {
    const home = process.env.LOCALAPPDATA || '';
    const parents = [
      path.join(home, 'Microsoft', 'WinGet', 'Packages'),
      path.join(home, 'Programs', 'scrcpy'),
      'C:\\ProgramData\\chocolatey\\lib\\scrcpy\\tools',
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'scoop', 'apps', 'scrcpy', 'current') : '',
    ].filter(Boolean);
    for (const parent of parents) {
      if (!fs.existsSync(parent)) continue;
      // Direct match (chocolatey, scoop).
      const direct = path.join(parent, 'scrcpy.exe');
      if (fs.existsSync(direct)) { candidates.push(direct); continue; }
      // Nested match (winget: <parent>/<Genymobile.scrcpy_...>/scrcpy-win64-vX.Y/scrcpy.exe,
      // %LOCALAPPDATA%/Programs/scrcpy/scrcpy-win64-vX.Y/scrcpy.exe).
      try {
        for (const child of fs.readdirSync(parent)) {
          if (child.toLowerCase().includes('scrcpy')) {
            const nested = path.join(parent, child, 'scrcpy.exe');
            if (fs.existsSync(nested)) { candidates.push(nested); continue; }
            // Two levels deep for winget's versioned subfolder.
            try {
              for (const grand of fs.readdirSync(path.join(parent, child))) {
                if (grand.toLowerCase().startsWith('scrcpy-')) {
                  const deep = path.join(parent, child, grand, 'scrcpy.exe');
                  if (fs.existsSync(deep)) candidates.push(deep);
                }
              }
            } catch {}
          }
        }
      } catch {}
    }
  }
  // 2.17.8: Mac path resolution — homebrew + macports + bundled.
  if (process.platform === 'darwin') {
    const macCandidates = [
      // Bundled (if we ship scrcpy in extraResources for Mac)
      path.join(resPath, 'scrcpy', 'scrcpy'),
      path.join(resPath, 'scrcpy.app', 'Contents', 'MacOS', 'scrcpy'),
      // Apple Silicon homebrew
      '/opt/homebrew/bin/scrcpy',
      // Intel homebrew
      '/usr/local/bin/scrcpy',
      // MacPorts
      '/opt/local/bin/scrcpy',
      // User homedir homebrew (rare but possible)
      process.env.HOME ? path.join(process.env.HOME, 'homebrew', 'bin', 'scrcpy') : '',
    ].filter(Boolean);
    for (const c of macCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Fall back to PATH lookup.
  return process.platform === 'win32' ? 'scrcpy' : 'scrcpy';
}

// 2.17.8: detect if scrcpy is reachable on this machine. Returns
// { found: bool, binary: string|null, source: 'bundled'|'homebrew'|'path'|'missing' }.
// Used by Mac launch path to decide whether to surface an install prompt.
function detectScrcpyAvailability(opts) {
  const bin = findScrcpyBinary(opts || {});
  if (bin !== 'scrcpy' && bin && fs.existsSync(bin)) {
    let source = 'path';
    if (bin.includes('homebrew') || bin.startsWith('/opt/homebrew') || bin.startsWith('/usr/local')) source = 'homebrew';
    else if (bin.startsWith('/opt/local')) source = 'macports';
    else if (bin.includes('resources') || bin.includes('python-bundle')) source = 'bundled';
    return { found: true, binary: bin, source };
  }
  // Try PATH lookup via `which`/`where`
  try {
    const { spawnSync } = require('node:child_process');
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, ['scrcpy'], { encoding: 'utf8', timeout: 2000 });
    if (r.status === 0 && r.stdout) {
      const found = String(r.stdout).split(/\r?\n/)[0].trim();
      if (found && fs.existsSync(found)) {
        return { found: true, binary: found, source: 'path' };
      }
    }
  } catch (_) {}
  return { found: false, binary: null, source: 'missing' };
}

function buildScrcpyArgs(opts) {
  const args = ['-s', `${opts.tailnetIp}:${opts.port || 5555}`];
  if (opts.title) args.push('--window-title', opts.title);
  if (opts.position) {
    args.push(`--window-x=${opts.position.x}`);
    args.push(`--window-y=${opts.position.y}`);
    args.push(`--window-width=${opts.position.w}`);
    args.push(`--window-height=${opts.position.h}`);
  }
  return args;
}

function computeGridPositions(count, opts) {
  const screenW = opts.screenWidth || 1920;
  const tileW = opts.tileW || 400;
  const tileH = opts.tileH || 900;
  const cols = Math.max(1, Math.floor(screenW / tileW));
  const positions = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    positions.push({ x: c * tileW, y: r * tileH, w: tileW, h: tileH });
  }
  return positions;
}

function spawnScrcpyForDevice(opts) {
  // 2.21.x: resolve the binary the SAME way detectScrcpyAvailability does so a
  // missing scrcpy fails loudly instead of spawn()'ing the bare 'scrcpy' string
  // (which async-errors with pid:undefined and looked like success). Fresh
  // Windows users have no bundled scrcpy — without this they clicked Launch and
  // nothing happened.
  const det = detectScrcpyAvailability({ resourcesPath: opts.resourcesPath });
  if (!det.found) {
    return { ok: false, pid: null, code: 'scrcpy-missing', error: 'scrcpy is not installed' };
  }
  const bin = det.binary;
  const args = buildScrcpyArgs(opts);
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  // detached+stdio:ignore means a failed exec emits an async 'error' with no
  // listener, which would crash the process. Log + swallow it.
  child.on('error', (err) => {
    console.error('[scrcpy-spawn-native] scrcpy spawn failed:', err.message);
  });
  child.unref();
  return { ok: true, pid: child.pid, bin, args };
}

module.exports = { findScrcpyBinary, buildScrcpyArgs, computeGridPositions, spawnScrcpyForDevice, detectScrcpyAvailability };
