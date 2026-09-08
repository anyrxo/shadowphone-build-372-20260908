/**
 * Portal IPC Handlers — ws-scrcpy fleet web portal.
 *
 * Spawns ONE ws-scrcpy server for the whole connected-phone fleet, fronted by
 * a token auth-proxy, exposed to VAs via a single cloudflared tunnel. Replaces
 * the old per-device portal-mirror-server.
 *
 *   VA browser → cloudflared (*.trycloudflare.com/?t=<token>)
 *              → portal-auth-proxy (token gate)
 *              → ws-scrcpy (loopback) → adb → phones
 */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')
const { ipcMain, app, shell } = require('electron')
const { startPortalAuthProxy } = require('../lib/portal-auth-proxy')
const { startCloudflaredTunnel, resolveCloudflaredPath, safeKill } = require('../lib/cloudflared-tunnel')
const { appAuthFetch } = require('../lib/app-auth-fetch')

let portal = null // { proxy, tunnelChild, tailnetBase, tunnelBase }
let getAdbPath = () => null
let getCurrentUserSession = () => null
let getLiveDevices = async () => []
let portalAppUrl = ''
let portalFetch = null

const PORTAL_PORT_FILE_NAME = 'portal-port.json'
function portalPortFile() {
  try { return path.join(app.getPath('userData'), PORTAL_PORT_FILE_NAME) }
  catch (_) { return null }
}
function readStickyPort() {
  try {
    const p = portalPortFile()
    if (!p || !fs.existsSync(p)) return 0
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Number(parsed.port) || 0
  } catch (_) { return 0 }
}
function writeStickyPort(port) {
  try {
    const p = portalPortFile()
    if (!p) return
    fs.writeFileSync(p, JSON.stringify({ port }))
  } catch (_) {}
}

// 2.14.22: detect Tailscale IP. Anyro + VAs share a tailnet, so
// when one is present we hand it to the renderer as the primary share
// URL — instant connect, no cloudflared handshake (5-15s) on every cold
// start. Cloudflared still spawns in background for off-tailnet access.
// Tailscale CGNAT range is 100.64.0.0/10 — first octet 100, second
// 64..127. Matches the detection in lib/portal-auth-proxy.js lan-links.
function detectTailscaleIp() {
  try {
    const ifaces = os.networkInterfaces() || {}
    for (const list of Object.values(ifaces)) {
      for (const addr of list || []) {
        if (addr.family !== 'IPv4' || addr.internal) continue
        const a = addr.address
        if (!a.startsWith('100.')) continue
        const second = parseInt(a.split('.')[1], 10)
        if (second >= 64 && second <= 127) return a
      }
    }
  } catch (_) { /* ignore */ }
  return null
}

// Read the desktop app's per-device nickname map so the Wizard can relabel
// "Pixel 6a" with the operator's chosen name. File is rewritten any time the
// user renames a device, and we re-read on every request so renames propagate
// without restarting the portal.
function readDeviceNicknames() {
  try {
    const p = path.join(app.getPath('userData'), 'device-nicknames.json')
    if (!fs.existsSync(p)) return {}
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch (_) { return {} }
}

// Build the public-facing URL for a given token (master or device-scoped).
function buildLink(tunnelBase, token) {
  return `${tunnelBase}/?t=${token}`
}

function portalSessionIdentity() {
  const session = getCurrentUserSession()
  const userId = typeof session?.userId === 'string' ? session.userId.trim() : ''
  const sessionToken = typeof session?.sessionToken === 'string' ? session.sessionToken.trim() : ''
  return { userId, sessionToken }
}

// Tenant identity only. The session TOKEN now legitimately rotates mid-flight
// (appAuthFetch re-mints a live Clerk JWT per request), so comparing tokens here
// would discard every inventory fetch that happened to straddle a re-mint. The
// guard's actual job — never serve tenant A's fleet after a switch to tenant B —
// is fully expressed by userId.
function samePortalSession(left, right) {
  return left.userId === right.userId
}

function normalizedIdentity(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function typedDeviceIdentity(device) {
  const hasStableProvenance = device != null && (
    Object.prototype.hasOwnProperty.call(device, 'stableHwSerial') ||
    Object.prototype.hasOwnProperty.call(device, 'stable_hw_serial')
  )
  const hardwareValues = [...new Set((hasStableProvenance
    ? [device?.stableHwSerial, device?.stable_hw_serial]
    : [device?.hwSerial, device?.hw_serial]
  ).map(normalizedIdentity).filter(Boolean))]
  return {
    serial: normalizedIdentity(device?.serial),
    hwSerial: hardwareValues.length === 1 ? hardwareValues[0] : '',
    hardwareConflict: hardwareValues.length > 1,
  }
}

function samePhysicalDevice(owned, live) {
  if (owned.hardwareConflict || live.hardwareConflict || !live.serial) return false
  if (owned.hwSerial && live.hwSerial) return owned.hwSerial === live.hwSerial
  return Boolean(owned.serial && owned.serial === live.serial)
}

async function listAuthorizedPortalDevices() {
  const session = portalSessionIdentity()
  if (!session.userId || !session.sessionToken || !portalAppUrl || typeof portalFetch !== 'function') return []
  if (!/^[A-Za-z0-9._~-]+$/.test(session.sessionToken)) return []

  try {
    // A stale snapshot token used to make the VA portal render an EMPTY fleet
    // with no error on every request (portal-auth-proxy.js:676/:824/:1201).
    // appAuthFetch mints per request and retries once on a 401; a persistent
    // auth failure now throws into the catch below, which still returns [].
    const response = await appAuthFetch(`${portalAppUrl.replace(/\/+$/, '')}/api/devices`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }, { fetchImpl: portalFetch, fallbackToken: session.sessionToken })
    if (!samePortalSession(session, portalSessionIdentity()) || !response?.ok) return []

    const payload = await response.json()
    if (!samePortalSession(session, portalSessionIdentity()) || !Array.isArray(payload?.data)) return []

    const ownedDevices = []
    for (const device of payload.data) {
      const rowUserId = typeof device?.user_id === 'string'
        ? device.user_id.trim()
        : typeof device?.userId === 'string' ? device.userId.trim() : ''
      if (rowUserId !== session.userId) continue
      const identity = typedDeviceIdentity(device)
      if (!identity.hardwareConflict && (identity.serial || identity.hwSerial)) ownedDevices.push(identity)
    }
    if (ownedDevices.length === 0) return []

    const liveDevices = await getLiveDevices()
    if (!samePortalSession(session, portalSessionIdentity()) || !Array.isArray(liveDevices)) return []

    return liveDevices
      .filter(device => device?.status === 'device' && ownedDevices.some(owned => samePhysicalDevice(owned, typedDeviceIdentity(device))))
      .map(device => ({ ...device, userId: session.userId }))
  } catch (_) {
    return []
  }
}

// Poll ws-scrcpy's loopback port until it answers, so we never tunnel a
// not-yet-listening server (the operator would see a dead link otherwise).
function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.destroy()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('ws-scrcpy did not start in time'))
        else setTimeout(tick, 400)
      })
      req.on('timeout', () => req.destroy())
    }
    tick()
  })
}

// 2.14.11: file logger for portal lifecycle. console.log from Electron main
// goes nowhere in a packaged app, so every prior "fix" was untestable from
// the user side. This writes every step of startPortal to portal.log so we
// can definitively see WHY startPortal didn't reach `portal = {...}`.
function plog(msg) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs')
    try { fs.mkdirSync(logDir, { recursive: true }) } catch (_) {}
    fs.appendFileSync(path.join(logDir, 'portal.log'),
      `[${new Date().toISOString()}] ${msg}\n`)
  } catch (_) {}
}

async function startPortal() {
  plog(`startPortal() called — portal=${portal ? 'EXISTS' : 'null'}`)
  if (portal) {
    plog(`startPortal short-circuit: returning existing portal url=${portal.url}`)
    return { running: true, url: portal.url }
  }
  const adbPath = getAdbPath()
  const userDataDir = app.getPath('userData')
  plog(`startPortal: adbPath=${adbPath} userDataDir=${userDataDir}`)

  // Logs directory — same one the brain uses. The ws-scrcpy launcher will
  // append a `ws-scrcpy.log` here capturing the server's stdout/stderr so we
  // can diagnose stream failures (the device-side scrcpy-server pushing is
  // a frequent silent-failure point; the previous build had no record of it).
  const logDir = path.join(userDataDir, 'logs')
  try { fs.mkdirSync(logDir, { recursive: true }) } catch (_) { /* exists */ }

  if (process.platform === 'win32') {
    // 2.14.10: reap orphaned cloudflared.exe from prior wizard runs.
    // Each wizard launch spawns a fresh cloudflared; if the previous wizard
    // crashed/quit without firing the exit handler, cloudflared survives
    // as a zombie and the new wizard's tunnel either fails to bind or
    // gets a different URL. Anyro's 2026-05-23 logs showed 2 cloudflared
    // procs accumulating per session.
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq cloudflared.exe" /FO CSV /NH`, { encoding: 'utf8', timeout: 4000 })
      const pids = [...new Set([...out.matchAll(/"cloudflared\.exe","(\d+)"/g)].map(m => parseInt(m[1])))]
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 2000, stdio: 'ignore' })
          console.log(`[portal] pre-clean: killed orphan cloudflared PID=${pid}`)
        } catch (_) {}
      }
    } catch (_) { /* tasklist missing — fine */ }
  }

  let proxy
  const cloudflaredDisabled = process.env.SP_DISABLE_CLOUDFLARED === '1'
  try {
    // userData stays per-user (good on Mac multi-user installs) and is
    // already writable.
    const uploadTempDir = path.join(userDataDir, 'wizard-uploads')
    try { fs.mkdirSync(uploadTempDir, { recursive: true }) } catch (_) { /* exists */ }
    plog(`startPortalAuthProxy...`)
    const stickyPort = readStickyPort()
    plog(`sticky port from disk: ${stickyPort || '(none — first launch or random)'}`)
    proxy = await startPortalAuthProxy({
      port: stickyPort,
      getNicknames: readDeviceNicknames,
      getDevices: listAuthorizedPortalDevices,
      getCurrentUserSession,
      adbPath,
      uploadTempDir,
    })
    plog(`startPortalAuthProxy OK: proxy.port=${proxy.port}`)
    if (proxy.port && proxy.port !== stickyPort) {
      writeStickyPort(proxy.port)
      plog(`sticky port saved: ${proxy.port}`)
    }
  } catch (err) {
    plog(`startPortal OUTER CATCH: ${err?.message || err}\n${err?.stack || ''}`)
    try { if (proxy) await proxy.close() } catch (_) { /* best effort */ }
    throw err
  }

  // 2.14.22: Tailscale truly primary. When a tailnet IP is available we
  // hand it to the renderer immediately as the share URL — no waiting on
  // cloudflared's 5-15s handshake at every cold start. Cloudflared still
  // spawns in the background (fire-and-forget) so off-tailnet staff get
  // a public URL via /sp-api/lan-links once it materializes, but no caller
  // is blocked on it. Cold start drops from 20-40s to ~3s for tailnet VAs.
  const tailscaleIp = detectTailscaleIp()
  const tailnetBase = tailscaleIp ? `http://${tailscaleIp}:${proxy.port}` : null
  if (tailscaleIp) {
    plog(`Tailscale primary: ${tailscaleIp}:${proxy.port}`)
  } else {
    plog(`no Tailscale share base (cloudflared will appear when ready)`)
  }

  portal = {
    proxy,
    tunnelChild: null,
    tailnetBase,
    tunnelBase: null,
    cloudflaredDisabled,
  }
  plog(`portal ASSIGNED — port=${proxy.port} (cloudflared async)`)

  if (!cloudflaredDisabled) {
    plog(`startCloudflaredTunnel (background, no await)...`)
    const cloudflaredPath = resolveCloudflaredPath({
      getResourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    })
    // Fire-and-forget. When the tunnel URL materializes we patch portal
    // so the next portal:status / lan-links call surfaces it as a
    // secondary share link. If it never materializes, no one waits.
    startCloudflaredTunnel({ port: proxy.port, cloudflaredPath, log: () => {} })
      .then(t => {
        if (!portal) { try { safeKill(t.child) } catch (_) {} ; return }
        portal.tunnelChild = t.child
        portal.tunnelBase = t.url
        plog(`cloudflared materialized: ${t.url} (background)`)
        t.child.once('exit', () => { stopPortal().catch(() => {}) })
      })
      .catch(err => plog(`cloudflared background start failed: ${err?.message || err}`))
  } else {
    plog(`cloudflared DISABLED via env`)
  }

  console.log(`[portal] ws-scrcpy fleet portal up on port ${proxy.port} (tailscale=${tailscaleIp ? 'yes' : 'no'})`)
  return { running: true }
}

async function stopPortal() {
  if (!portal) return { running: false }
  const p = portal
  portal = null
  try { safeKill(p.tunnelChild) } catch (_) { /* best effort */ }
  try { await p.proxy.close() } catch (_) { /* best effort */ }
  // 2.15.0: release adb forwards held by the forwarding pool
  try {
    if (p.proxy.forwardPool && p.proxy.forwardPool._releaseAll) {
      await p.proxy.forwardPool._releaseAll()
    }
  } catch (_) { /* best effort */ }
  // 2.14.21: drop fan-out registry. ws-scrcpy is about to die and any
  // restart picks a fresh upstreamPort, so the cached FanOuts now point
  // at a dead port. getFanOut handles this lazily, but eager cleanup
  // avoids holding stale WS sockets in the event loop between stop and
  // start.
  try { require('../lib/scrcpy-fanout')._resetForTests() } catch (_) { /* best effort */ }
  console.log('[portal] ws-scrcpy fleet portal stopped')
  return { running: false }
}

function initPortalHandlers(opts = {}) {
  if (typeof opts.getAdbPath === 'function') getAdbPath = opts.getAdbPath
  if (typeof opts.getCurrentUserSession === 'function') getCurrentUserSession = opts.getCurrentUserSession
  getLiveDevices = typeof opts.getLiveDevices === 'function' ? opts.getLiveDevices : async () => []
  portalAppUrl = typeof opts.appUrl === 'string' ? opts.appUrl.trim() : ''
  portalFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null

  ipcMain.handle('portal:start', async () => {
    plog(`IPC portal:start invoked from renderer`)
    try {
      const r = await startPortal()
      plog(`IPC portal:start returning ok=true running=${r.running}`)
      return { ok: true, ...r }
    } catch (err) {
      plog(`IPC portal:start FAILED: ${err?.message || err}`)
      console.error('[portal] start failed:', err?.message || err)
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('portal:stop', async () => {
    plog(`IPC portal:stop invoked`)
    return { ok: true, ...(await stopPortal()) }
  })

  ipcMain.handle('portal:status', async () => ({
    ok: true,
    running: !!portal,
  }))

  ipcMain.handle('portal:open-window', async (_e, args = {}) => {
    if (!portal) return { ok: false, error: 'Portal not started' }
    const serial = String(args.serial || '').trim()
    if (!serial) return { ok: false, error: 'serial required' }
    const base = portal.tailnetBase || portal.tunnelBase
    if (!base) return { ok: false, error: 'No Tailscale or tunnel URL is available' }
    try {
      const token = await portal.proxy.issueDeviceToken(serial, 'operator', { role: 'operator' })
      await shell.openExternal(buildLink(base, token))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  })

  // Issue a least-privilege VA link scoped to `serial`; other
  // devices are hidden from the device list (client-side filter) and any WS
  // upgrade carrying a different `udid` is rejected (server-side gate).
  ipcMain.handle('portal:issue-device-link', async (_e, args = {}) => {
    if (!portal) return { ok: false, error: 'Portal not started' }
    const serial = String(args.serial || '').trim()
    if (!serial) return { ok: false, error: 'serial required' }
    const base = portal.tailnetBase || portal.tunnelBase
    if (!base) return { ok: false, error: 'No Tailscale or tunnel URL is available' }
    const label = args.label ? String(args.label).slice(0, 80) : null
    try {
      const token = await portal.proxy.issueDeviceToken(serial, label, {
        role: 'va',
        capabilities: { view: true, control: true },
      })
      return { ok: true, url: buildLink(base, token), token, serial, label }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  })

  // List active tokens (master + device-scoped) for the Manage-links UI.
  ipcMain.handle('portal:list-tokens', async () => {
    if (!portal) return { ok: false, error: 'Portal not started' }
    const base = portal.tailnetBase || portal.tunnelBase
    if (!base) return { ok: false, error: 'No Tailscale or tunnel URL is available' }
    const items = portal.proxy.listTokens().filter(t => t.scope === 'device').map(t => ({
      token: t.token,
      url: buildLink(base, t.token),
      scope: t.scope,
      userId: t.userId,
      serial: t.serial,
      label: t.label,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      role: t.role,
      capabilities: t.capabilities,
      jti: t.jti,
      actorUserId: t.actorUserId,
      grantId: t.grantId,
      grantVersion: t.grantVersion,
    }))
    return { ok: true, tokens: items }
  })

  ipcMain.handle('portal:revoke-token', async (_e, args = {}) => {
    if (!portal) return { ok: false, error: 'Portal not started' }
    const token = String(args.token || '')
    const removed = portal.proxy.revokeToken(token)
    return { ok: removed, error: removed ? null : 'unknown token (or master cannot be revoked while portal runs)' }
  })

  console.log('[portal] handlers registered (ws-scrcpy fleet portal)')
}

// Called from main.js before-quit so we never leak ws-scrcpy / cloudflared.
async function shutdownPortal() {
  await stopPortal()
}

module.exports = {
  initPortalHandlers,
  shutdownPortal,
}
