// Persistent state for bulk account creation. Atomic writes (tmp + rename).
const fs = require('fs'); const path = require('path')
const { createHash } = require('node:crypto')

function storePath(userDataPath, tenantId, serial) {
  if (!tenantId) return path.join(userDataPath, 'bulk-creation.json')
  const scope = createHash('sha256').update(JSON.stringify([tenantId, serial])).digest('hex')
  return path.join(userDataPath, `bulk-creation-${scope}.json`)
}

function load(userDataPath, tenantId, serial) {
  let data
  try { data = JSON.parse(fs.readFileSync(storePath(userDataPath, tenantId, serial), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return { profiles: {}, runs: {} }
    throw new Error('Bulk account creation state could not be verified.')
  }
  if (!data || typeof data.profiles !== 'object' || !data.profiles || Array.isArray(data.profiles)
    || typeof data.runs !== 'object' || !data.runs || Array.isArray(data.runs)) {
    throw new Error('Bulk account creation state could not be verified.')
  }
  return data
}

function persist(userDataPath, data, tenantId, serial) {
  const p = storePath(userDataPath, tenantId, serial); const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, p)
}

function key(serial, userId) { return serial + '::' + String(userId) }

function _bump(data, serial, userId, patch, now) {
  const k = key(serial, userId)
  const prev = data.profiles[k] || {}
  data.profiles[k] = { ...prev, attempts: (prev.attempts || 0) + 1, lastAttemptAt: now, ...patch }
}

function markSuccess(data, serial, userId, handle, now) {
  _bump(data, serial, userId, { lastResult: 'success', cooldownUntil: null, lastHandle: handle, credentialReservationId: null }, now)
}

function markCreatedUnpersisted(data, serial, userId, handle, now) {
  _bump(data, serial, userId, { lastResult: 'created-unpersisted', cooldownUntil: null, lastHandle: handle }, now)
}

function markCreatedManualAction(data, serial, userId, handle, now) {
  _bump(data, serial, userId, { lastResult: 'created-manual-action', cooldownUntil: null, lastHandle: handle, credentialReservationId: null }, now)
}

function markInFlightPaid(data, serial, userId, credentialReservationId, now) {
  const k = key(serial, userId)
  const prev = data.profiles[k] || {}
  data.profiles[k] = {
    ...prev,
    lastResult: 'in-flight-paid',
    lastAttemptAt: now,
    cooldownUntil: null,
    credentialReservationId,
  }
}

function markRetryable(data, serial, userId, now) {
  _bump(data, serial, userId, { lastResult: 'retryable', cooldownUntil: null, credentialReservationId: null }, now)
}

function markOutcomeUncertain(data, serial, userId, now, handle) {
  _bump(data, serial, userId, {
    lastResult: 'outcome-uncertain',
    cooldownUntil: null,
    ...(handle ? { lastHandle: handle } : {}),
  }, now)
}

function markCooled(data, serial, userId, now, cooldownMs) {
  _bump(data, serial, userId, { lastResult: 'cooled', cooldownUntil: now + cooldownMs }, now)
}

// Profile already has an IG account (registry was stale / IG opened logged-in).
// Not a failure and not eligible for retry — record without a cooldown.
function markHasAccount(data, serial, userId, now) {
  _bump(data, serial, userId, { lastResult: 'has-account', cooldownUntil: null }, now)
}

function takeName(run) {
  return (run.nameCursor < run.nameList.length) ? run.nameList[run.nameCursor++] : ''
}

function returnName(run, name) {
  if (name && run.nameCursor > 0) run.nameCursor--
}

function isInterrupted(run) { return !!(run && run.active && !run.finishedAt) }

module.exports = {
  storePath, load, persist, key, markSuccess, markCreatedUnpersisted,
  markCreatedManualAction, markInFlightPaid, markRetryable, markOutcomeUncertain,
  markCooled, markHasAccount, takeName, returnName,
  isInterrupted,
}
