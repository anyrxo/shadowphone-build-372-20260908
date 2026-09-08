const sel = require('./bulk-creation-select')
const store = require('./bulk-creation-store')
const { randomBytes, randomUUID } = require('node:crypto')

const TERMINAL_RESULTS = new Set(['success', 'has-account', 'created-unpersisted', 'created-manual-action', 'outcome-uncertain', 'in-flight-paid'])
const PAID_RESULTS = new Set(['created-unpersisted', 'created-manual-action', 'outcome-uncertain', 'in-flight-paid'])

function generateAccountPassword() { return `Sp!9${randomBytes(18).toString('base64url')}` }

function normalizeConfig(input = {}) {
  const provider = input.provider || 'smspool'
  const country = input.country || 'US'
  const maxPriceUsd = Number(input.maxPriceUsd ?? 0.5)
  const balanceFloor = Number(input.balanceFloor ?? 0.5)
  const cooldownHours = Number(input.cooldownHours ?? 24)
  const maxCount = input.maxCount == null ? null : Number(input.maxCount)
  if (!['smspool', 'textverified'].includes(provider) || !['US', 'GB'].includes(country)
    || (provider === 'textverified' && country !== 'US')
    || !Number.isFinite(maxPriceUsd) || maxPriceUsd < 0.01 || maxPriceUsd > 100
    || Math.abs(maxPriceUsd * 100 - Math.round(maxPriceUsd * 100)) >= 1e-8
    || !Number.isFinite(balanceFloor) || balanceFloor < 0 || balanceFloor > 100000
    || !Number.isInteger(cooldownHours) || cooldownHours < 1 || cooldownHours > 168
    || (maxCount != null && (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 1000))) return null
  const nameList = input.nameList ?? []
  if (!Array.isArray(nameList) || nameList.length > 1000
    || nameList.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.]{1,30}$/.test(name))) return null
  return { provider, country, maxPriceUsd, balanceFloor, cooldownHours, maxCount, nameList: [...nameList] }
}

function createBulkCreator(deps) {
  const { userDataPath, accountCreationService: service } = deps
  const now = deps.now || Date.now
  const runners = new Map()
  function sessionMatches(tenantId) {
    const session = deps.getCurrentUserSession?.()
    return Boolean(tenantId && session?.userId === tenantId && session.sessionToken)
  }
  const failure = (code, error) => ({ ok: false, code, error })
  function readState(serial, tenantId) { return store.load(userDataPath, tenantId, serial) }
  function save(serial, tenantId, data) { store.persist(userDataPath, data, tenantId, serial) }

  function admit(serial, input, resume, tenantId, hardwareId) {
    if (!sessionMatches(tenantId)) return failure('UNAUTHORIZED', 'Sign in before managing bulk account creation.')
    if (typeof serial !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(serial)) return failure('INVALID_REQUEST', 'Select a connected phone.')
    const config = normalizeConfig(input)
    if (!config) return failure('INVALID_REQUEST', 'Choose a supported SMS provider/country, a $0.01–$100 price limit with at most two decimals, and valid run limits.')
    if (!service?.start || !service?.status || !service?.preflight) return failure('ACCOUNT_CREATION_SERVICE_UNAVAILABLE', 'Protected account creation is unavailable. Restart ShadowPhone after updating.')
    if (runners.has(hardwareId)) return failure('BULK_ALREADY_RUNNING', 'A bulk run is already active for this phone.')
    let data, legacy
    try { data = readState(hardwareId, tenantId); legacy = store.load(userDataPath) }
    catch (_) { return failure('BULK_STATE_UNAVAILABLE', 'Bulk state could not be verified. Preserve the state file and recover it before retrying.') }
    const existing = data.runs[hardwareId]
    const canResume = resume && store.isInterrupted(existing)
    const run = canResume ? existing : {
      startedAt: now(), nameList: config.nameList, nameCursor: 0, attempted: [], created: [], failed: [],
      totals: { created: 0, cooled: 0, fail: 0 },
    }
    run.active = true; run.finishedAt = null; run.config = config; run.reason = null
    data.runs[hardwareId] = run
    try { save(hardwareId, tenantId, data) }
    catch (_) { return failure('BULK_STATE_UNAVAILABLE', 'Bulk state could not be saved. No attempt was started.') }
    const ctrl = { tenantId, hardwareId, stop: false, data, run, config, legacy }
    runners.set(hardwareId, ctrl)
    return { ok: true, ctrl }
  }

  async function execute(serial, ctrl) {
    const { tenantId, hardwareId, data, run, config, legacy } = ctrl
    const emit = (ev, payload) => deps.emit?.(ev, { serial, ...payload }, tenantId)
    let reason = null
    const recovery = (userId, code = 'account-creation-outcome-uncertain') => {
      run.recoveryUserId = userId == null ? null : Number(userId)
      emit('profile', { userId, phase: 'manual-reconciliation-required', error: 'Recover this exact phone profile in Create IG Account before another attempt.' })
      return code
    }
    async function sharedStatus() {
      try { return await service.status({ serial }) }
      catch (_) { return null }
    }
    try {
      for (const [key, value] of Object.entries(legacy.profiles)) {
        if (!PAID_RESULTS.has(value?.lastResult)) continue
        const boundary = key.lastIndexOf('::')
        const legacySerial = key.slice(0, boundary)
        let legacyHardware = legacySerial
        if (legacySerial !== serial && legacySerial !== hardwareId) {
          try { legacyHardware = await deps.resolveHardwareId?.(legacySerial, { ...deps.getCurrentUserSession?.(), tenantId }) }
          catch (_) { legacyHardware = null }
        }
        if (!legacyHardware || legacySerial === serial || legacyHardware === hardwareId) {
          reason = recovery(key.slice(boundary + 2), 'legacy-paid-recovery-required')
          break
        }
      }
      while (!ctrl.stop && !reason) {
        if (!sessionMatches(tenantId)) { reason = 'session-changed'; break }
        const pending = await sharedStatus()
        if (!sessionMatches(tenantId)) { reason = 'session-changed'; break }
        if (!pending?.success) { reason = 'recovery-status-unavailable'; break }
        if (pending.pending || pending.running) { reason = recovery(pending.userId ?? pending.runningUserId); break }
        const registry = await deps.getRegistry()
        if (!registry?.ok) { reason = 'profile-discovery-unavailable'; break }
        const qualifying = sel.qualifyingProfiles(registry.registry, serial)
        const unresolved = qualifying.find(p => PAID_RESULTS.has(data.profiles[sel.keyOf(hardwareId, p.userId)]?.lastResult))
        if (unresolved) {
          const marker = data.profiles[sel.keyOf(hardwareId, unresolved.userId)]
          let proof
          if (marker.operationId) {
            try { proof = await service.status({ serial, userId: unresolved.userId, operationId: marker.operationId }) }
            catch (_) {}
          }
          if (!sessionMatches(tenantId)) { reason = 'session-changed'; break }
          const receipt = proof?.receipt
          if (!proof?.success || proof.pending || proof.running || receipt?.operationId !== marker.operationId
            || receipt?.hardwareId !== hardwareId || String(receipt?.userId) !== unresolved.userId
            || !['released', 'not_started', 'created'].includes(receipt?.outcome)) {
            reason = recovery(unresolved.userId)
            break
          }
          if (receipt.outcome === 'created') {
            store.markHasAccount(data, hardwareId, unresolved.userId, now())
            run.totals.skipped = (run.totals.skipped || 0) + 1
          } else store.markRetryable(data, hardwareId, unresolved.userId, now())
          delete data.profiles[sel.keyOf(hardwareId, unresolved.userId)].operationId
          run.recoveryUserId = null
          save(hardwareId, tenantId, data)
          continue
        }
        const candidates = qualifying.filter(p => {
          const key = sel.keyOf(hardwareId, p.userId)
          return !run.attempted.includes(key) && !TERMINAL_RESULTS.has(data.profiles[key]?.lastResult) && !TERMINAL_RESULTS.has(legacy.profiles[key]?.lastResult)
        })
        const profile = sel.pickNextProfile(candidates.map(p => ({ ...p, serial: hardwareId })), data.profiles, now())
        if (!profile) {
          reason = qualifying.some(p => sel.isCooled(data.profiles[sel.keyOf(hardwareId, p.userId)], now())) ? 'all-cooling' : 'all-qualifying-done'
          break
        }
        if (config.maxCount && run.totals.created >= config.maxCount) { reason = 'max-count'; break }
        const session = deps.getCurrentUserSession?.()
        const authorized = await deps.isPhoneProfileAuthorized?.(serial, Number(profile.userId), { ...session, tenantId })
        if (!sessionMatches(tenantId)) { reason = 'session-changed'; break }
        if (authorized !== true) { reason = 'phone-profile-unauthorized'; break }
        if (ctrl.stop) break
        const release = deps.acquirePhoneLock?.(serial)
        if (typeof release !== 'function') { reason = 'phone-busy'; break }
        run.currentUserId = profile.userId
        emit('profile', { userId: profile.userId, name: profile.name, phase: 'switching' })
        let switched
        try { switched = await deps.switchProfile({ serial, profileId: profile.userId, completeSetupWizard: true }, release.ownerToken) }
        finally { release() }
        if (!sessionMatches(tenantId)) { reason = 'session-changed'; break }
        if (ctrl.stop) break
        if (switched?.success !== true) {
          store.markCooled(data, hardwareId, profile.userId, now(), 3600000)
          run.totals.cooled++
          run.attempted.push(sel.keyOf(hardwareId, profile.userId))
          emit('profile', { userId: profile.userId, phase: 'cooled', error: 'Profile switching failed; no account creation started.' })
          save(hardwareId, tenantId, data)
          continue
        }
        const input = { serial, userId: profile.userId, provider: config.provider, country: config.country, maxPriceUsd: config.maxPriceUsd }
        const preflight = await service.preflight(input)
        if (!sessionMatches(tenantId)) { reason = 'session-changed'; break }
        if (ctrl.stop) break
        if (!preflight?.ready || !Number.isFinite(preflight.balance)) { reason = 'preflight-failed'; break }
        if (preflight.balance < config.balanceFloor) { reason = 'balance-floor'; break }
        // Bulk creates one account on an empty profile; an uncertain badge cannot
        // prove emptiness even though single-account creation permits more slots.
        if (preflight.accountCapacityVerified !== true) { reason = 'profile-capacity-unverified'; break }
        if (preflight.accountCount !== 0) {
          store.markHasAccount(data, hardwareId, profile.userId, now())
          run.totals.skipped = (run.totals.skipped || 0) + 1
          emit('profile', { userId: profile.userId, phase: 'has-account' })
          save(hardwareId, tenantId, data)
          continue
        }
        const username = store.takeName(run)
        const operationId = randomUUID()
        run.attempted.push(sel.keyOf(hardwareId, profile.userId))
        store.markInFlightPaid(data, hardwareId, profile.userId, null, now())
        data.profiles[sel.keyOf(hardwareId, profile.userId)].operationId = operationId
        save(hardwareId, tenantId, data)
        emit('profile', { userId: profile.userId, phase: 'creating', username })
        let result
        try { result = await service.start({ ...input, operationId, username, password: generateAccountPassword() }) }
        catch (_) { result = null }
        if (result?.success === true && result.credentialsPersisted === true && result.username) {
          store.markSuccess(data, hardwareId, profile.userId, result.username, now())
          run.totals.created++
          run.created.push({ userId: profile.userId, handle: result.username, at: now() })
          emit('profile', { userId: profile.userId, phase: 'created', handle: result.username })
        } else {
          run.totals.fail++
          const status = sessionMatches(tenantId) ? await sharedStatus() : null
          if (!status?.success || status.pending || result?.success === true || result?.credentialsPersisted === true || result?.manualActionRequired === true || !result) {
            store.markOutcomeUncertain(data, hardwareId, profile.userId, now())
            reason = recovery(status?.userId ?? profile.userId)
          } else {
            // The protected service confirms there is no outstanding paid state.
            // Stop instead of automatically retrying a rejected purchase/signup.
            if (result.code === 'ig_finalize_rejected' && result.retryable !== true) {
              store.markCooled(data, hardwareId, profile.userId, now(), config.cooldownHours * 3600000)
              run.totals.cooled++
            } else store.markRetryable(data, hardwareId, profile.userId, now())
            store.returnName(run, username)
            reason = 'account-creation-not-started'
            emit('profile', { userId: profile.userId, phase: 'aborted', error: result.error || 'Account creation did not complete. Review the exact profile before restarting.' })
          }
          run.failed.push({ userId: profile.userId, reason, at: now() })
        }
        save(hardwareId, tenantId, data)
      }
      if (ctrl.stop && !reason) reason = 'stopped'
    } catch (_) {
      reason = 'bulk-state-or-service-unavailable'
    } finally {
      run.active = false; run.finishedAt = now(); run.reason = reason || 'done'; run.currentUserId = null
      try { save(hardwareId, tenantId, data) }
      catch (_) { reason = 'bulk-state-unavailable' }
      runners.delete(hardwareId)
      emit('run-complete', { reason: reason || 'done', totals: run.totals, recoveryUserId: run.recoveryUserId ?? null })
    }
    return { ok: true, reason: reason || 'done', totals: run.totals }
  }

  async function startRun(serial, config, resume, tenantId, hardwareId = serial) {
    const admitted = admit(serial, config, resume, tenantId, hardwareId)
    return admitted.ok ? execute(serial, admitted.ctrl) : admitted
  }
  function beginRun(serial, config, resume, tenantId, hardwareId = serial) {
    const admitted = admit(serial, config, resume, tenantId, hardwareId)
    if (!admitted.ok) return admitted
    Promise.resolve().then(() => execute(serial, admitted.ctrl)).catch(() => {})
    return { ok: true }
  }
  function stopRun(serial, tenantId, hardwareId = serial) {
    const ctrl = runners.get(hardwareId)
    if (!sessionMatches(tenantId) || (ctrl && ctrl.tenantId !== tenantId)) return failure('UNAUTHORIZED', 'Sign in to the tenant that started this run.')
    if (!ctrl) return failure('BULK_NOT_RUNNING', 'No active run.')
    ctrl.stop = true
    return { ok: true }
  }
  function getStatus(serial, tenantId, hardwareId = serial) {
    const ctrl = runners.get(hardwareId)
    if (!sessionMatches(tenantId) || (ctrl && ctrl.tenantId !== tenantId)) return failure('UNAUTHORIZED', 'Sign in to the tenant that started this run.')
    try {
      const run = readState(hardwareId, tenantId).runs[hardwareId]
      return { ok: true, active: Boolean(ctrl), interrupted: store.isInterrupted(run) && !ctrl, totals: run?.totals || null,
        current: run?.currentUserId ?? null, reason: run?.reason || null, recoveryUserId: run?.recoveryUserId ?? null }
    } catch (_) { return failure('BULK_STATE_UNAVAILABLE', 'Bulk state could not be verified.') }
  }
  return { startRun, beginRun, stopRun, getStatus }
}

module.exports = { createBulkCreator, generateAccountPassword, normalizeConfig }
