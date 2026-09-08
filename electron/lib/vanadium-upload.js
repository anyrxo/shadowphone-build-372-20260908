'use strict';
/**
 * Self-contained Vanadium HTTP upload for the per-mirror toolbar.
 *
 * Why: `adb push /sdcard/DCIM/...` always lands in user 0's media store,
 * regardless of which Android user is currently in front. Files pushed
 * that way are INVISIBLE to whichever profile is actually being used
 * (Instagram for that profile can't see them).
 *
 * The Vanadium trick: stage the file on the host, set up `adb reverse`
 * so the phone's localhost reaches the host, then `am start` Vanadium
 * (GrapheneOS's default browser) at the local URL. Vanadium runs AS THE
 * ACTIVE USER and saves the download to that user's Downloads/Gallery.
 *
 * portal-auth-proxy.js already does this for the web wizard. This module
 * is the SAME flow extracted into a standalone IPC handler the docked
 * toolbar can call directly — no portal dependency, no auth tokens.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('os');
const crypto = require('node:crypto');
const { runAdb: runManagedAdb } = require('./adb-util');
const { mediaMimeType } = require('./media-mime');

const FILE_TTL_MS = 10 * 60 * 1000;
const fileStore = new Map(); // token -> { filePath, filename, bytes, expiresAt }
let server = null;
let serverPort = 0;
let cleanupInterval = null;

function runAdb(adbPath, args, timeoutMs) {
  return runManagedAdb(adbPath, args, timeoutMs || 8000).then(result => ({
    ...result,
    code: result.code ?? -1,
    stderr: `${result.stderr || result.error || ''}${result.timedOut ? '\n[adb timeout]' : ''}`,
  }));
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'));
  // Allow letters, digits, dot, dash, underscore. Replace everything else.
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file';
}

function ensureServer() {
  if (server && server.listening) return Promise.resolve(serverPort);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      // Path: /sp-vanadium/<token>/<filename>
      const m = /^\/sp-vanadium\/([A-Za-z0-9_-]+)\/(.+)$/.exec(req.url || '');
      if (!m) { res.writeHead(404); return res.end('not found'); }
      const [, token, encName] = m;
      const filename = decodeURIComponent(encName);
      const entry = fileStore.get(token);
      if (!entry || entry.expiresAt < Date.now() || entry.filename !== filename) {
        res.writeHead(404); return res.end('expired or unknown');
      }
      let st;
      try { st = fs.statSync(entry.filePath); }
      catch (_) { res.writeHead(404); return res.end('file gone'); }
      res.writeHead(200, {
        // Chromium files the download under this Content-Type and MediaProvider
        // keeps it on the row, so octet-stream left every .mov mislabeled for the
        // brain's video posting guard. content-disposition stays — it is what
        // forces the download path.
        'content-type': mediaMimeType(filename),
        'content-length': st.size,
        'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'cache-control': 'no-store',
      });
      fs.createReadStream(entry.filePath).pipe(res);
    });
    server.on('error', reject);
    // Bind to 127.0.0.1 — adb reverse routes phone's loopback to ours.
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      if (!cleanupInterval) {
        cleanupInterval = setInterval(() => {
          const now = Date.now();
          for (const [tok, entry] of fileStore) {
            if (entry.expiresAt < now) {
              try { fs.unlinkSync(entry.filePath); } catch (_) {}
              fileStore.delete(tok);
            }
          }
        }, 60_000);
        cleanupInterval.unref();
      }
      resolve(serverPort);
    });
  });
}

async function uploadFile({ adbPath, serial, localPath }) {
  if (!adbPath) return { success: false, error: 'adb path not configured' };
  if (!serial) return { success: false, error: 'serial required' };
  if (!localPath || !fs.existsSync(localPath)) return { success: false, error: 'local file not found' };

  const filename = sanitizeFilename(path.basename(localPath));
  const token = crypto.randomBytes(12).toString('base64url');
  const tmpDir = path.join(os.tmpdir(), 'shadowphone-vanadium');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
  const stagedPath = path.join(tmpDir, `${token}-${filename}`);

  // Copy (not move) so the original stays put on the host.
  try { fs.copyFileSync(localPath, stagedPath); }
  catch (e) { return { success: false, error: `stage failed: ${e.message}` }; }
  const bytes = fs.statSync(stagedPath).size;

  const port = await ensureServer();
  fileStore.set(token, { filePath: stagedPath, filename, bytes, expiresAt: Date.now() + FILE_TTL_MS });

  // adb reverse: phone's 127.0.0.1:<port> → host 127.0.0.1:<port>.
  // Re-running an existing reverse just updates it.
  const reverse = await runAdb(adbPath, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], 5000);
  if (reverse.code !== 0) {
    fileStore.delete(token);
    try { fs.unlinkSync(stagedPath); } catch (_) {}
    return { success: false, error: `adb reverse failed: ${(reverse.stderr || '').trim() || 'unknown'}` };
  }

  const url = `http://127.0.0.1:${port}/sp-vanadium/${token}/${encodeURIComponent(filename)}`;
  // am start with VIEW intent → Vanadium (default browser on GrapheneOS).
  // Use --user current so it launches in the active Android user's context.
  const launch = await runAdb(adbPath, [
    '-s', serial, 'shell', 'am', 'start',
    '--user', 'current',
    '-a', 'android.intent.action.VIEW',
    '-d', url,
  ], 8000);
  if (launch.code !== 0) {
    fileStore.delete(token);
    try { fs.unlinkSync(stagedPath); } catch (_) {}
    return { success: false, error: `am start failed: ${(launch.stderr || '').trim() || 'unknown'}` };
  }

  return {
    success: true,
    filename,
    bytes,
    url,
    hint: 'Vanadium is downloading on the phone — accept the download prompt if it appears',
  };
}

module.exports = { uploadFile };
