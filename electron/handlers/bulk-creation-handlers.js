const { BrowserWindow } = require('electron')
const sel = require('../lib/bulk-creation-select')
const store = require('../lib/bulk-creation-store')
const { createBulkCreator, normalizeConfig } = require('../lib/bulk-account-creator')

function registerBulkCreationHandlers(ipcMain, deps) {
  const emit = (ev, payload, tenantId) => {
    const session = deps.getCurrentUserSession?.()
    if (session?.userId !== tenantId || !session.sessionToken) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window || window.isDestroyed()) continue
      try {
        if (deps.isTrustedIpcSender?.({ sender: window.webContents }) === true) {
          window.webContents.send('bulk:progress', { ev, ...payload })
        }
      } catch (_) {}
    }
  }
  const creator = createBulkCreator({ ...deps, emit })
  const trusted = handler => async (event, input = {}) => {
    const session = deps.getCurrentUserSession?.()
    if (!session?.userId || !session.sessionToken || deps.isTrustedIpcSender?.(event, input) !== true) {
      return { ok: false, code: 'UNAUTHORIZED', error: 'Sign in before managing bulk account creation.' }
    }
    if (typeof input.serial !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.serial)) {
      return { ok: false, code: 'INVALID_REQUEST', error: 'Select a connected phone.' }
    }
    try {
      const tenantId = String(session.userId)
      const hardwareId = await deps.resolveHardwareId?.(input.serial, { ...session, tenantId })
      const current = deps.getCurrentUserSession?.()
      if (current?.userId !== tenantId || !current.sessionToken) return { ok: false, code: 'UNAUTHORIZED', error: 'Sign-in changed. Reopen bulk creation.' }
      if (!hardwareId) return { ok: false, code: 'PHONE_IDENTITY_UNAVAILABLE', error: 'The connected phone hardware could not be verified.' }
      return await handler(input, tenantId, hardwareId)
    }
    catch (_) { return { ok: false, code: 'BULK_STATE_UNAVAILABLE', error: 'Bulk state or profile discovery could not be verified.' } }
  }

  ipcMain.handle('bulk:preview', trusted(async ({ serial, config }, tenantId, hardwareId) => {
    const normalized = normalizeConfig(config)
    if (!normalized) return { ok: false, code: 'INVALID_REQUEST', error: 'Choose valid provider, country and price limits.' }
    const registry = await deps.getRegistry()
    if (deps.getCurrentUserSession?.()?.userId !== tenantId) return { ok: false, code: 'UNAUTHORIZED', error: 'Sign-in changed. Reopen bulk creation.' }
    if (!registry?.ok) return { ok: false, error: 'Phone profiles could not be discovered.' }
    const data = store.load(deps.userDataPath, tenantId, hardwareId)
    const legacy = store.load(deps.userDataPath)
    const all = sel.qualifyingProfiles(registry.registry, serial)
    const blocked = new Set(['success', 'has-account', 'created-unpersisted', 'created-manual-action', 'outcome-uncertain', 'in-flight-paid'])
    const available = all.filter(p => {
      const key = sel.keyOf(hardwareId, p.userId)
      return !blocked.has(data.profiles[key]?.lastResult) && !blocked.has(legacy.profiles[key]?.lastResult)
    })
    const cooled = available.filter(p => sel.isCooled(data.profiles[sel.keyOf(hardwareId, p.userId)], Date.now()))
    const ready = available.filter(p => !sel.isCooled(data.profiles[sel.keyOf(hardwareId, p.userId)], Date.now()))
    const count = Math.min(ready.length, normalized.maxCount ?? ready.length)
    return { ok: true, qualifying: ready, cooled, estCount: count,
      estSpend: +(count * normalized.maxPriceUsd).toFixed(2), balance: null }
  }))
  ipcMain.handle('bulk:start', trusted(({ serial, config, resume }, tenantId, hardwareId) => creator.beginRun(serial, config, resume === true, tenantId, hardwareId)))
  ipcMain.handle('bulk:stop', trusted(({ serial }, tenantId, hardwareId) => creator.stopRun(serial, tenantId, hardwareId)))
  ipcMain.handle('bulk:status', trusted(({ serial }, tenantId, hardwareId) => creator.getStatus(serial, tenantId, hardwareId)))
  return creator
}

module.exports = { registerBulkCreationHandlers }
