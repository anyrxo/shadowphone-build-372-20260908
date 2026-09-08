#!/usr/bin/env node
// check-brain-fresh.js
//
// Freshness guard for the PyInstaller-frozen local brain.
//
// electron/python-bundle/server.exe is git-TRACKED and shipped verbatim by
// extraResources. A LOCAL `electron-builder` (or any build that skipped the
// PyInstaller freeze) would package a weeks-stale binary, so source .py fixes
// silently never reach users. This guard fails the build LOUDLY when the
// bundled brain does not match current source. It NEVER auto-rebuilds —
// rebuilding needs Python + PyInstaller, which may be absent.
//
// Two modes (same hash logic for both, so producer and checker can never drift):
//   node scripts/check-brain-fresh.js --write   after a fresh freeze: writes
//                                                python-bundle/.brain-manifest
//   node scripts/check-brain-fresh.js           (default) verifies the bundled
//                                                brain matches current source;
//                                                exit 1 if stale/missing
//
// Also wired as electron-builder `beforePack` (Windows only) so packaging a
// stale brain aborts before the installer is produced.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const electronDir = path.resolve(__dirname, '..');
const pyDir = path.join(electronDir, 'python');
const bundleDir = path.join(electronDir, 'python-bundle');
const manifestPath = path.join(bundleDir, '.brain-manifest');

// Build output and the local freeze venv are never frozen source.
const SKIP_DIRS = new Set(['.build-venv', 'build', 'dist', '__pycache__', '.pytest_cache']);
// Non-.py inputs that still change what the freeze produces.
const EXTRA_SOURCES = ['requirements.txt', 'server.spec'];

// Every .py the freeze pulls in, not just the entrypoint. Test modules are
// excluded: server.spec does not bundle them, so they would force pointless
// rebuilds.
function collectSourceFiles(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(path.join(dir, entry.name), found);
      continue;
    }
    if (!entry.name.endsWith('.py') || entry.name.startsWith('test_')) continue;
    found.push(path.join(dir, entry.name));
  }
  return found;
}

// Sorted, python/-relative list of everything the freeze is built from.
// Exported: a hash is only as good as the file set under it, and the file set is
// what was wrong. This used to be server.py + requirements.txt ONLY, which left
// python/lib/** and python/modules/** — the bulk of the brain — outside the
// guard. That is how the 2026-07-27 posting_progression_guards.py fix (the
// _GENERATED_MEDIA_NAME arity relaxation the desktop's two-segment
// sp_<sha>_<pathhash>_<transferhash> filenames depend on) hashed identical to a
// server.exe frozen on 2026-07-24 and was reported "fresh" — shipping a brain
// that rejects every name the desktop mints, at post time, after the transfer
// had already verified.
function frozenSourceFiles() {
  return [
    ...EXTRA_SOURCES.map((name) => path.join(pyDir, name)).filter((p) => fs.existsSync(p)),
    ...collectSourceFiles(pyDir, []),
  ].map((file) => path.relative(pyDir, file).split(path.sep).join('/'));
}

// SHA-256 over every frozen source file, path included so a rename cannot hash
// identical. Same routine backs --write and the check, so they always agree.
function computeSourceHash() {
  const h = crypto.createHash('sha256');
  for (const relative of frozenSourceFiles()) {
    h.update(relative);
    h.update('\0');
    h.update(fs.readFileSync(path.join(pyDir, relative)));
  }
  return h.digest('hex');
}

function writeManifest() {
  if (!fs.existsSync(bundleDir)) fs.mkdirSync(bundleDir, { recursive: true });
  const manifest = {
    algo: 'sha256',
    sourceHash: computeSourceHash(),
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('Wrote brain manifest:', manifestPath);
  console.log('  sourceHash:', manifest.sourceHash);
}

const STALE_HINT =
  "run electron/scripts/build-python-brain.ps1 or build via CI";

// Throws on any mismatch so callers (CLI + electron-builder hook) abort loudly.
function assertFresh() {
  const exe = ['server.exe', 'server']
    .map((n) => path.join(bundleDir, n))
    .find((p) => fs.existsSync(p));
  if (!exe) {
    throw new Error(
      `bundled brain is missing (no server.exe in ${bundleDir}) vs current source — ${STALE_HINT}`
    );
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `bundled brain is STALE (no .brain-manifest) vs current source — ${STALE_HINT}`
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`.brain-manifest is unreadable (${e.message}) — ${STALE_HINT}`);
  }
  const current = computeSourceHash();
  if (manifest.sourceHash !== current) {
    throw new Error(
      `bundled brain is STALE vs current source — manifest ${manifest.sourceHash} != source ${current} — ${STALE_HINT}`
    );
  }
  console.log('Bundled brain is fresh (matches current source hash).');
}

// electron-builder beforePack hook. Only enforce when packing Windows — the
// frozen exe / manifest are Windows-only; other platforms are handled by their
// own pipelines and must not trip this guard.
module.exports = async function beforePack(context) {
  if (context && context.electronPlatformName && context.electronPlatformName !== 'win32') return;
  assertFresh();
};
module.exports.frozenSourceFiles = frozenSourceFiles;

if (require.main === module) {
  try {
    if (process.argv.includes('--write')) writeManifest();
    else assertFresh();
  } catch (e) {
    console.error('ERROR: ' + e.message);
    process.exit(1);
  }
}
