'use strict';
const net = require('node:net');
const { runAdb } = require('./adb-util');

function isPortFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function runAdbForward(adbPath, args) {
  const result = await runAdb(adbPath, args, 8000);
  if (result.code === 0) return result.stdout.trim();
  throw new Error(result.error || `adb ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`);
}

function createForwardPool(opts) {
  const adbPath = opts.adbPath;
  const [lo, hi] = opts.range || [40000, 40100];
  const held = new Set();
  const allocations = new Map(); // port -> { serial }

  const pool = {
    async pickFreePort() {
      for (let p = lo; p < hi; p++) {
        if (held.has(p)) continue;
        if (await isPortFree(p)) return p;
      }
      throw new Error(`no free port in [${lo}, ${hi})`);
    },
    async allocate(serial, devicePort) {
      const localPort = await pool.pickFreePort();
      held.add(localPort);
      allocations.set(localPort, { serial });
      if (adbPath !== '/bin/true') {
        await runAdbForward(adbPath, ['-s', serial, 'forward', `tcp:${localPort}`, `tcp:${devicePort}`]);
      }
      return {
        localPort,
        async release() {
          if (adbPath !== '/bin/true') {
            try { await runAdbForward(adbPath, ['-s', serial, 'forward', '--remove', `tcp:${localPort}`]); }
            catch (_) {}
          }
          held.delete(localPort);
          allocations.delete(localPort);
        },
      };
    },
    async _releaseAll() {
      for (const [port, { serial }] of allocations) {
        if (adbPath !== '/bin/true') {
          try { await runAdbForward(adbPath, ['-s', serial, 'forward', '--remove', `tcp:${port}`]); }
          catch (_) {}
        }
      }
      allocations.clear();
      held.clear();
    },
  };
  return pool;
}

module.exports = { createForwardPool, isPortFree };
