const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const DEFAULT_MINIMUM_BALANCE = 0.42
const DEFAULT_MAX_SMS_PRICE = 0.50

function normalizeProvider(value) {
  const provider = String(value || 'smspool').trim().toLowerCase()
  return ['smspool', 'textverified'].includes(provider) ? provider : null
}

function normalizeMaxPrice(value) {
  if (value === undefined) return DEFAULT_MAX_SMS_PRICE
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.01 && value <= 100
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8 ? value : null
}

function resolveSmsProvider(deps, session, provider, credentials) {
  if (typeof deps.getSmsProvider === 'function') return deps.getSmsProvider(provider, session.tenantId, credentials)
  if (provider !== 'smspool') throw new Error('TextVerified is not configured')
  const apiKey = credentials?.apiKey || String(deps.getSmspoolKey?.({ optional: true, tenantId: session.tenantId }) || '').trim()
  return {
    provider, credentials: { apiKey }, configured: Boolean(apiKey),
    getBalance: (retry = false) => (retry ? deps.fetchBalance : deps.fetchBalanceOnce || deps.fetchBalance)(apiKey),
    getOrderStatus: orderId => deps.getSmspoolOrderStatus?.(apiKey, orderId),
  }
}
// How long a deliberate Create waits for a background pass to release the phone
// before giving up. Comfortably covers a companion pass's disruptive tail while
// staying short enough that the operator isn't left staring at a dead UI.
const LOCK_WAIT_MS = 45_000
const LOCK_WAIT_POLL_MS = 1_000
const PAID_ATTEMPT_STATE_FILE = 'account-creation-paid-attempts.json'

function normalizeSerial(value) {
  return String(value || '').trim()
}

function normalizeUserId(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function normalizeCountry(value) {
  const country = String(value || 'US').trim().toUpperCase()
  return country === 'US' || country === 'GB' ? country : null
}

function safeError(value, secrets = []) {
  let message = String(value || 'Account creation failed')
  for (const secret of secrets) {
    if (secret) message = message.split(String(secret)).join('[redacted]')
  }
  return message
    .replace(/(order(?:[_\s-]*id)?\s*[:=#]?\s*)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/(phone(?:[_\s-]*(?:number|no))?\s*[:=#]?\s*)\+?\d[\d\s()-]{6,}/gi, '$1[redacted]')
    .replace(/(sms(?:[_\s-]*code)?\s*[:=#]?\s*)\d{3,8}/gi, '$1[redacted]')
    .replace(/(password|api[_\s-]*key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
}

// The create path wrote NOTHING to launcher.log: eight failed submits across six
// releases left zero trace, which is exactly why "live profile could not be
// verified" and "clicking create just closes" could not be root-caused from the
// operator's machine. Never log a username, password or SMSPool key here — the
// detector cause is already run through safeError() before it reaches this.
function logCreate(event, data) {
  try { require('../lib/launcher-log').write(event, data) } catch (_) {}
}

function normalizeOperationId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : null
}

function createFilePaidAttemptStore(userDataPath, { sealState, openState } = {}) {
  const root = String(userDataPath || '').trim()
  if (!root) throw new Error('Account creation state path is unavailable')
  if (typeof sealState !== 'function' || typeof openState !== 'function') {
    throw new Error('Encrypted account creation state is unavailable')
  }
  const filePath = path.join(root, PAID_ATTEMPT_STATE_FILE)

  const load = () => {
    if (!fs.existsSync(filePath)) return { version: 1, attempts: {} }
    const plaintext = openState(fs.readFileSync(filePath))
    const parsed = JSON.parse(String(plaintext || ''))
    if (!parsed || typeof parsed !== 'object' || !parsed.attempts || typeof parsed.attempts !== 'object'
      || Array.isArray(parsed.attempts) || (parsed.receipts != null && (typeof parsed.receipts !== 'object' || Array.isArray(parsed.receipts)))) {
      throw new Error('Account creation state is invalid')
    }
    return parsed
  }

  const persist = data => {
    fs.mkdirSync(root, { recursive: true })
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    const encrypted = sealState(JSON.stringify(data))
    if (!Buffer.isBuffer(encrypted)) throw new Error('Encrypted account creation state is invalid')
    fs.writeFileSync(tempPath, encrypted)
    fs.renameSync(tempPath, filePath)
  }

  return {
    filePath,
    entries() { return Object.entries(load().attempts) },
    getReceipt(operationId) {
      const id = normalizeOperationId(operationId)
      return id ? load().receipts?.[id] || null : null
    },
    get(serial) {
      return load().attempts[normalizeSerial(serial)] || null
    },
    put(serial, attempt) {
      const data = load()
      data.attempts[normalizeSerial(serial)] = { ...attempt }
      persist(data)
    },
    clear(serial, credentialReservationId, tenantId, outcome, hardwareId) {
      const data = load()
      const key = normalizeSerial(serial)
      const current = data.attempts[key]
      if (!current) return
      if (
        current.credentialReservationId !== credentialReservationId
        || current.tenantId !== tenantId
      ) {
        throw new Error('Account creation state changed before it could be cleared')
      }
      if (current.operationId) {
        const operationId = normalizeOperationId(current.operationId)
        if (!operationId || !['released', 'not_started', 'created'].includes(outcome)) throw new Error('A confirmed terminal outcome is required')
        const receipt = {
          operationId, tenantId, hardwareId: current.hardwareId || hardwareId,
          userId: normalizeUserId(current.userId), outcome,
          reservationIdHash: createHash('sha256').update(credentialReservationId).digest('hex'),
          completedAt: Date.now(),
        }
        if (!receipt.hardwareId || receipt.userId == null) throw new Error('Receipt identity is unavailable')
        const existing = data.receipts?.[operationId]
        if (existing && (existing.tenantId !== receipt.tenantId || existing.hardwareId !== receipt.hardwareId
          || existing.userId !== receipt.userId || existing.reservationIdHash !== receipt.reservationIdHash
          || existing.outcome !== receipt.outcome)) throw new Error('Operation receipt already belongs to a different outcome')
        data.receipts = { ...data.receipts, [operationId]: existing || receipt }
      }
      delete data.attempts[key]
      persist(data)
    },
  }
}

function defaultPaidAttemptStore(deps) {
  if (deps.paidAttemptStore) return deps.paidAttemptStore
  let userDataPath = String(deps.userDataPath || '').trim()
  if (!userDataPath) {
    try { userDataPath = String(require('electron').app?.getPath('userData') || '').trim() } catch (_) {}
  }
  return createFilePaidAttemptStore(userDataPath, {
    sealState: deps.sealState,
    openState: deps.openState,
  })
}

function getAuthenticatedSession(deps) {
  let session
  try { session = deps.getCurrentUserSession?.() } catch (_) { return null }
  const tenantId = String(session?.userId || '').trim()
  const sessionToken = String(session?.sessionToken || '').trim()
  return tenantId && sessionToken ? { ...session, tenantId, sessionToken } : null
}

function unauthorizedResult() {
  return {
    success: false,
    code: 'UNAUTHORIZED',
    retryable: false,
    error: 'Sign in to ShadowPhone before managing account creation.',
  }
}

async function phoneProfileError(deps, serial, userId, session) {
  try {
    if (await deps.isPhoneProfileAuthorized?.(serial, userId, session) === true) return null
  } catch (error) {
    if (error?.code === 'PHONE_CONNECTION_UNAVAILABLE') {
      return {
        success: false,
        code: 'PHONE_CONNECTION_UNAVAILABLE',
        retryable: true,
        error: 'The phone connection could not be verified. Wait for the connection to recover, then retry.',
      }
    }
  }
  return {
    success: false,
    code: 'PHONE_PROFILE_UNAUTHORIZED',
    retryable: false,
    error: 'This phone profile is not available to the signed-in ShadowPhone tenant.',
  }
}

function preflightError(result, minimumBalance) {
  const providerLabel = result.provider === 'textverified' ? 'TextVerified' : 'SMSPool'
  if (!result.serial) return 'Select a connected phone.'
  if (result.userId == null) return 'Select a valid Android profile.'
  if (!result.smspoolConfigured) return `Add your ${providerLabel} key${result.provider === 'textverified' ? ' and API username' : ''} in Settings before creating an account.`
  if (result.currentUserId == null) return 'The active Android profile could not be verified.'
  if (result.currentUserId !== result.userId) {
    return `Requested profile ${result.userId}, but active profile ${result.currentUserId} is on the phone.`
  }
  if (!result.instagramReady) return `Instagram is not ready on Android profile ${result.userId}.`
  if (!result.brainReady) return 'The local automation brain is not ready.'
  // "another action" is only honest for a FOREIGN lock. When the lock is this
  // service's own in-flight create, saying "another action" made the operator's
  // own Create look like a conflict with someone else.
  if (result.phoneBusy) {
    return result.accountCreationRunning
      ? 'Account creation is already running on this phone.'
      : 'This phone is running another action.'
  }
  if (!Number.isFinite(result.balance)) return `${providerLabel} balance is unavailable. No number was purchased.`
  if (result.priceRequired && !Number.isFinite(result.priceUsd)) return `${providerLabel} pricing is unavailable. No number was purchased.`
  if (Number.isFinite(result.priceUsd) && result.priceUsd > result.maxPriceUsd) return `${providerLabel} price exceeds your ${result.maxPriceUsd.toFixed(2)} limit. No number was purchased.`
  if (Number.isFinite(result.priceUsd)) minimumBalance = result.priceUsd
  if (result.balance < minimumBalance) {
    return `${providerLabel} balance is ${result.balance.toFixed(2)}; at least ${minimumBalance.toFixed(2)} is required.`
  }
  return null
}

function validateStartInput(input) {
  const serial = normalizeSerial(input?.serial)
  const userId = normalizeUserId(input?.userId)
  const password = String(input?.password || '')
  if (!serial) return 'Select a connected phone.'
  if (userId == null) return 'Select a valid Android profile.'
  if (password.length < 8) return 'Use a password with at least 8 characters.'
  if (!normalizeProvider(input?.provider)) return 'Choose SMSPool or TextVerified.'
  if (normalizeMaxPrice(input?.maxPriceUsd) == null) return 'Set an SMS price limit from $0.01 to $100 with at most two decimal places.'
  if (!normalizeCountry(input?.country)) return 'Choose country US or GB.'
  if (input?.operationId != null && !normalizeOperationId(input.operationId)) return 'Account creation operation identity is invalid.'
  if (normalizeProvider(input?.provider) === 'textverified' && normalizeCountry(input?.country) !== 'US') return 'TextVerified supports US numbers in this flow.'
  return null
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '')
}

function normalizeAccountId(value) {
  const accountId = String(value || '').trim()
  return accountId && accountId.length <= 256 && !/\s/.test(accountId) ? accountId : null
}

function normalizeAccountUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').trim().toLowerCase()
}

// Transient infrastructure hiccups (ADB lane saturation, server churn, a lost
// uiautomator idle race) must self-heal instead of failing the whole creation
// flow. Each class also carries the sentence the OPERATOR reads: the old single
// message — "Live profile capacity could not be verified" — was emitted for every
// one of these and read as "your profile isn't live" while the phone was
// connected, pinned and showing Instagram. It named the wrong thing entirely.
const DETECTOR_CAUSE_CLASSES = [
  {
    code: 'ADB_GUARD_COOLDOWN',
    test: /circuit is open/i,
    reason: "the phone's ADB link is cooling down after repeated command timeouts",
  },
  {
    code: 'ADB_LANE_SATURATED',
    test: /capacity is full|queue is full|shut down|shutting down/i,
    reason: "the phone's ADB lane was saturated",
  },
  {
    code: 'ADB_TRANSPORT_FLAP',
    test: /timed out|daemon|closed|device offline|device '[^']*' not found|protocol fault|connection reset/i,
    reason: "the phone's ADB connection dropped mid-read",
  },
  {
    code: 'SCREEN_UNREADABLE',
    test: /could not verify the active instagram account|switcher could not be verified|uiautomator|window_dump|not idle/i,
    reason: "Instagram's screen never settled long enough to read",
  },
]

function classifyDetectorCause(cause) {
  const text = String(cause || '')
  return DETECTOR_CAUSE_CLASSES.find(entry => entry.test.test(text)) || null
}

const CAPACITY_ATTEMPTS = 3
const CAPACITY_RETRY_DELAY_MS = 1200
// Hard ceiling on how long the probe may spend fighting infrastructure before it
// gives the operator an honest answer. Comfortably outlasts the ADB guard's 15s
// cooldown (the old fixed 1.2s/2.4s ladder was ~4x too short to ever clear it,
// so every retry landed inside the cooldown and a HEALTHY phone was reported
// unverified) while staying far inside the operator's patience.
const CAPACITY_TOTAL_BUDGET_MS = 45_000

function adbGuardStats(deps) {
  try {
    const stats = deps.getAdbProcessStats
      ? deps.getAdbProcessStats()
      : require('../lib/adb-util').getAdbProcessStats()
    return stats && typeof stats === 'object' ? stats : null
  } catch (_) {
    return null
  }
}

// Driving Instagram while the shared ADB guard is open is pointless: every adb
// call is refused synchronously for the whole cooldown. Wait it out instead of
// spending retries on a guaranteed failure.
async function waitOutAdbGuard(deps, budgetMs) {
  const deadline = Date.now() + Math.max(0, Number(budgetMs) || 0)
  let waitedMs = 0
  while (Date.now() < deadline) {
    const stats = adbGuardStats(deps)
    if (!stats || stats.circuitOpen !== true) break
    const remaining = Number(stats.cooldownRemainingMs)
    const step = Math.min(
      2000,
      Math.max(250, Number.isFinite(remaining) && remaining > 0 ? remaining + 250 : 1000),
      Math.max(1, deadline - Date.now()),
    )
    await new Promise(resolve => setTimeout(resolve, step))
    waitedMs += step
  }
  return waitedMs
}

async function getProfileAccountCapacity(deps, serial, userId) {
  const retryDelayMs = Number.isFinite(deps.capacityRetryDelayMs)
    ? Number(deps.capacityRetryDelayMs)
    : CAPACITY_RETRY_DELAY_MS
  const budgetUntil = Date.now() + (Number.isFinite(deps.capacityBudgetMs)
    ? Number(deps.capacityBudgetMs)
    : CAPACITY_TOTAL_BUDGET_MS)
  let accounts
  let detectorCause = ''
  let detectorClass = null
  let guardWaitedMs = 0
  for (let attempt = 0; attempt < CAPACITY_ATTEMPTS; attempt++) {
    guardWaitedMs += await waitOutAdbGuard(deps, budgetUntil - Date.now())
    try {
      accounts = await deps.detectInstagramAccounts?.(serial, userId)
      break
    } catch (error) {
      if (error?.code === 'verification_required' || error?.data?.verification_required === true || error?.data?.manual_action_required === true) {
        return {
          accountCount: null,
          slotsRemaining: null,
          accountCapacityVerified: false,
          code: 'verification_required',
          error: 'Instagram requires manual account verification. Complete the check on the phone or choose another profile. No SMS number was purchased.',
          data: {
            verification_required: true,
            verification_type: error?.data?.verification_type || 'verification',
            reason: error?.data?.reason || 'identity_verification_required',
            manual_action_required: true,
            recovery_required: false,
          },
        }
      }
      detectorCause = safeError(error?.message || error)
        .replace(/\s*<[\s\S]*$/, '')
        .trim()
        .slice(0, 160)
      accounts = null
      detectorClass = classifyDetectorCause(detectorCause)
      if (attempt >= CAPACITY_ATTEMPTS - 1 || !detectorClass || Date.now() >= budgetUntil) break
      // A guard cooldown is waited out at the top of the next attempt; adding a
      // fixed backoff on top of it only burns the operator's time.
      if (detectorClass.code !== 'ADB_GUARD_COOLDOWN' && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)))
      }
    }
  }
  if (!Array.isArray(accounts)) {
    return {
      accountCount: null,
      slotsRemaining: null,
      accountCapacityVerified: false,
      code: 'PROFILE_ACCOUNT_CAPACITY_UNVERIFIED',
      detectorCode: detectorClass ? detectorClass.code : 'DETECTOR_FAILED',
      guardWaitedMs,
      error: (detectorClass
        ? `Instagram could not be read on Android profile ${userId} — ${detectorClass.reason}.`
        : `Instagram accounts could not be read on Android profile ${userId}.`)
        + ' No SMS number was purchased and nothing changed on the phone. Press Create again.'
        + (detectorCause ? ` ${detectorCause}` : ''),
    }
  }
  const accountCount = new Set(accounts.map(normalizeAccountUsername).filter(Boolean)).size
  if (accountCount >= 5) {
    return {
      accountCount,
      slotsRemaining: 0,
      accountCapacityVerified: true,
      code: 'PROFILE_ACCOUNT_LIMIT_REACHED',
      error: `Android profile ${userId} already has 5 Instagram accounts. Switch to a different profile or create a new one.`,
    }
  }
  return {
    accountCount,
    slotsRemaining: 5 - accountCount,
    accountCapacityVerified: true,
    code: null,
    error: null,
  }
}

function createAccountCreationService(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('account creation dependencies required')
  const minimumBalance = Number.isFinite(deps.minimumBalance)
    ? Number(deps.minimumBalance)
    : DEFAULT_MINIMUM_BALANCE
  const capacityDeadlineMs = Number.isFinite(deps.capacityDeadlineMs)
    ? Number(deps.capacityDeadlineMs)
    : 25_000
  const rawPaidAttemptStore = defaultPaidAttemptStore(deps)
  const hardwareBySerial = new Map()
  const stateFailure = error => error?.code === 'UNAUTHORIZED' ? unauthorizedResult() : {
    success: false,
    code: 'PAID_ATTEMPT_STATE_UNAVAILABLE',
    retryable: false,
    error: 'Phone identity or account creation state could not be verified. Preserve the recovery state before retrying.',
  }
  async function bindPaidAttemptStore(serial, session, expectedHardwareId) {
    const assertSession = () => {
      if (getAuthenticatedSession(deps)?.tenantId !== session.tenantId) {
        throw Object.assign(new Error('Sign-in changed'), { code: 'UNAUTHORIZED' })
      }
    }
    const resolve = async alias => {
      assertSession()
      const hardwareId = String(await deps.resolveHardwareId?.(alias, session) || '').trim()
      assertSession()
      if (!/^[A-Za-z0-9._-]+$/.test(hardwareId) || /^(null|unknown|undefined)$/i.test(hardwareId)) {
        throw new Error('Hardware identity is unavailable')
      }
      return hardwareId
    }
    const hardwareId = await resolve(serial)
    if (expectedHardwareId && hardwareId !== expectedHardwareId) throw new Error('Hardware identity changed')
    hardwareBySerial.set(serial, hardwareId)
    const find = async () => {
      assertSession()
      const direct = await Promise.resolve(rawPaidAttemptStore.get(hardwareId))
      const entries = typeof rawPaidAttemptStore.entries === 'function'
        ? await Promise.resolve(rawPaidAttemptStore.entries())
        : [[hardwareId, direct], ...(serial === hardwareId ? [] : [[serial, await Promise.resolve(rawPaidAttemptStore.get(serial))]])]
      assertSession()
      let found = null
      for (const [key, attempt] of entries) {
        if (!attempt) continue
        if (typeof attempt !== 'object' || Array.isArray(attempt)) throw new Error('Invalid recovery state')
        // Legacy records have no immutable hardware binding. Resolve their old
        // transport; an unavailable or ambiguous mapping cannot authorize retry.
        const bound = attempt.hardwareId || (key === hardwareId ? hardwareId : await resolve(key))
        if (typeof bound !== 'string' || !/^[A-Za-z0-9._-]+$/.test(bound)
          || /^(null|unknown|undefined)$/i.test(bound) || (key === hardwareId && bound !== hardwareId)) {
          throw new Error('Invalid hardware recovery binding')
        }
        if (bound !== hardwareId) continue
        if (found) throw new Error('Ambiguous recovery state')
        found = { key, attempt }
      }
      assertSession()
      return found
    }
    return {
      hardwareId,
      get: async () => (await find())?.attempt || null,
      recordOrder: async (reservationId, orderId) => {
        // This capability belongs only to the original dispatched request. It
        // preserves its recovery evidence after sign-out without borrowing a new session.
        const current = await Promise.resolve(rawPaidAttemptStore.get(hardwareId))
        if (!current || current.hardwareId !== hardwareId || current.tenantId !== session.tenantId
          || current.credentialReservationId !== reservationId) throw new Error('Recovery state changed')
        const orderIdHash = createHash('sha256').update(orderId).digest('hex')
        await Promise.resolve(rawPaidAttemptStore.put(hardwareId, { ...current, orderId, orderIdHash }))
      },
      put: async (_serial, attempt) => {
        const existing = await find()
        if (existing && (existing.attempt.tenantId !== attempt.tenantId
          || existing.attempt.credentialReservationId !== attempt.credentialReservationId)) {
          throw new Error('Recovery state changed')
        }
        // Keep a legacy key until its exact reservation is reconciled; adding
        // hardwareId makes future reconnects independent of the old transport.
        return rawPaidAttemptStore.put(existing?.key || hardwareId, { ...attempt, hardwareId })
      },
      clear: async (_serial, reservationId, tenantId, unstarted = false, outcome) => {
        // A sign-out can happen after the unpaid reservation was written. Its
        // creator may clean up that exact new record without borrowing the new
        // tenant's authority; dispatched attempts still require the live scope.
        const existing = unstarted
          ? { key: hardwareId, attempt: await Promise.resolve(rawPaidAttemptStore.get(hardwareId)) }
          : await find()
        if (!existing?.attempt) return
        if (unstarted && (tenantId !== session.tenantId || existing.attempt.tenantId !== tenantId
          || existing.attempt.hardwareId !== hardwareId || existing.attempt.credentialReservationId !== reservationId)) {
          throw new Error('Unpaid recovery state changed')
        }
        return rawPaidAttemptStore.clear(existing.key, reservationId, tenantId, outcome, hardwareId)
      },
    }
  }
  // serial -> { userId, startedAt } for creates THIS service is running. The
  // busy lock alone can't tell "my own create" from "a foreign action", which is
  // what made the badge report the operator's own run as a conflict.
  const activeRuns = new Map()

  // The badge preflight is advisory and must never out-live the operator's
  // patience: cap each probe instead of inheriting the create path's 3x retries.
  function withDeadline(value, timeoutMs, fallback) {
    let timer = null
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs) })
    return Promise.race([Promise.resolve(value).catch(() => fallback), deadline])
      .finally(() => { if (timer) clearTimeout(timer) })
  }

  // The capacity probe physically DRIVES Instagram on the phone (detect_accounts
  // via _runModuleLocal, which takes no mutex of its own) and it can run well past
  // the badge deadline — 3 internal attempts plus 1.2s/2.4s backoff. withDeadline()
  // abandons such a probe but cannot cancel it, so unguarded: the badge auto-retry
  // would start a SECOND detector while the first is still tapping IG, and an
  // abandoned probe would keep tapping after start() took the lock and began the
  // signup. Coalesce per (serial, profile): every caller joins the ONE live probe,
  // so at most one detector ever drives a phone and start() waits it out instead of
  // racing it. Entry is dropped on settle — a join always awaits a live probe,
  // never a cached count.
  const capacityProbes = new Map()

  // Returns { startedAt, promise } so callers can tell a probe THEY started from
  // one they merely joined, and how old it is.
  function startOrJoinCapacityProbe(serial, userId) {
    const key = `${serial}::${userId}`
    const inflight = capacityProbes.get(key)
    if (inflight) return inflight
    const entry = { startedAt: Date.now(), promise: null }
    entry.promise = Promise.resolve(getProfileAccountCapacity(deps, serial, userId))
      .finally(() => { if (capacityProbes.get(key) === entry) capacityProbes.delete(key) })
    capacityProbes.set(key, entry)
    return entry
  }

  function probeProfileAccountCapacity(serial, userId) {
    return startOrJoinCapacityProbe(serial, userId).promise
  }

  // The create path's capacity read. Joining the coalescer is what stops two
  // detectors tapping one phone, but returning a JOINED verdict verbatim is how a
  // healthy, connected, pinned phone reported "capacity could not be verified":
  // the badge's probe started seconds earlier with NO phone lock, raced whatever
  // else was driving the device, failed, and start() inherited that failure
  // without ever looking at the phone itself. Join the old probe (never race a
  // second detector onto the device), then — if that stale verdict failed and we
  // now hold the lock — re-probe exactly once under the lock. Money-safe: this
  // runs before any SMSPool purchase, and the re-probe replaces a false negative
  // rather than turning a real failure into a create.
  async function probeCapacityUnderLock(serial, userId, lockAcquiredAt) {
    const entry = startOrJoinCapacityProbe(serial, userId)
    const result = await entry.promise
    if (entry.startedAt >= lockAcquiredAt) return result
    if (!result || !result.code || result.code === 'PROFILE_ACCOUNT_LIMIT_REACHED') return result
    logCreate('create-ig:capacity-restale', { serial, userId, code: result.code, probeAgeMs: lockAcquiredAt - entry.startedAt })
    return startOrJoinCapacityProbe(serial, userId).promise
  }

  async function preflight(input) {
    const serial = normalizeSerial(input?.serial)
    const userId = normalizeUserId(input?.userId)
    const session = getAuthenticatedSession(deps)
    if (!session) {
      return {
        ...unauthorizedResult(),
        ok: false,
        ready: false,
        serial,
        userId,
        accountCount: null,
        slotsRemaining: null,
        accountCapacityVerified: false,
      }
    }
    const profileError = serial && userId != null ? await phoneProfileError(deps, serial, userId, session) : null
    if (profileError) {
      return {
        ...profileError,
        ok: false,
        ready: false,
        serial,
        userId,
        accountCount: null,
        slotsRemaining: null,
        accountCapacityVerified: false,
      }
    }
    const providerName = normalizeProvider(input?.provider)
    const maxPriceUsd = normalizeMaxPrice(input?.maxPriceUsd)
    if (!providerName || maxPriceUsd == null || !normalizeCountry(input?.country)
      || (providerName === 'textverified' && normalizeCountry(input?.country) !== 'US')) {
      return { ok: false, ready: false, code: 'INVALID_REQUEST', error: 'Choose a supported provider, country, and positive SMS price limit.' }
    }
    let smsProvider
    try { smsProvider = resolveSmsProvider(deps, session, providerName) } catch (_) {}
    const apiKey = smsProvider?.configured ? smsProvider.credentials.apiKey : ''

    const checkCapacity = input?.checkCapacity !== false
    // Read the lock ONCE and bail before any probe. While a run holds the phone
    // the answer cannot change, so probing would only burn adb calls, SMSPool
    // POSTs and — via the capacity detector, which takes no lock of its own —
    // drive Instagram on top of a live signup.
    const phoneBusy = serial ? deps.isPhoneBusy?.(serial) === true : false
    const selfRun = serial ? activeRuns.get(hardwareBySerial.get(serial) || serial) || null : null
    if (phoneBusy) {
      return {
        ok: true,
        ready: false,
        serial,
        userId,
        currentUserId: null,
        instagramReady: false,
        brainReady: false,
        phoneBusy: true,
        accountCreationRunning: Boolean(selfRun),
        accountCreationUserId: selfRun?.userId ?? null,
        smspoolConfigured: Boolean(apiKey),
        balance: null,
        accountCount: null,
        slotsRemaining: null,
        accountCapacityVerified: false,
        accountCapacityPending: true,
        code: 'PHONE_BUSY',
        error: selfRun
          ? 'Account creation is already running on this phone.'
          : 'This phone is running another action.',
      }
    }

    const balanceFn = () => smsProvider.getBalance()
    const [currentUserIdRaw, brain, instagramReady, balance, accountCapacity] = await Promise.all([
      serial && userId != null
        ? withDeadline(deps.getCurrentUserId(serial), 6000, null)
        : Promise.resolve(null),
      withDeadline(deps.getBrainStatus?.(), 6000, { running: false }),
      serial && userId != null
        ? withDeadline(deps.isInstagramReady(serial, userId), 6000, false)
        : Promise.resolve(false),
      apiKey
        ? withDeadline(balanceFn(apiKey), 6000, null)
        : Promise.resolve(null),
      checkCapacity && serial && userId != null
        // The badge is advisory. Its own deadline expiring is NOT a verdict about
        // the phone — it used to return the exact same sentence as a real detector
        // failure, so "the badge gave up" and "Instagram could not be read" were
        // indistinguishable in the UI and in support.
        ? withDeadline(probeProfileAccountCapacity(serial, userId), capacityDeadlineMs, {
          accountCount: null,
          slotsRemaining: null,
          accountCapacityVerified: false,
          code: 'PROFILE_ACCOUNT_CAPACITY_PENDING',
          detectorCode: 'BADGE_DEADLINE',
          error: 'Still reading Instagram on this profile — it is taking longer than usual. Nothing was purchased; Create re-checks it under the phone lock.',
        })
        : Promise.resolve({
          accountCount: null,
          slotsRemaining: null,
          accountCapacityVerified: false,
          code: null,
          error: null,
        }),
    ])
    const priceUsd = apiKey && smsProvider.getPrice
      ? await withDeadline(smsProvider.getPrice(normalizeCountry(input?.country), maxPriceUsd), 6000, null)
      : null
    const currentUserId = normalizeUserId(currentUserIdRaw)
    const result = {
      provider: providerName,
      providerConfigured: Boolean(apiKey),
      maxPriceUsd,
      priceUsd,
      priceRequired: Boolean(smsProvider?.getPrice),
      ok: true,
      ready: false,
      serial,
      userId,
      currentUserId,
      instagramReady: instagramReady === true,
      brainReady: brain?.running === true,
      phoneBusy,
      accountCreationRunning: Boolean(selfRun),
      smspoolConfigured: Boolean(apiKey),
      balance: Number.isFinite(balance) ? Number(balance) : null,
      accountCount: accountCapacity.accountCount,
      slotsRemaining: accountCapacity.slotsRemaining,
      accountCapacityVerified: accountCapacity.accountCapacityVerified,
      accountCapacityPending: !checkCapacity,
      code: null,
      error: null,
    }
    // PENDING is "the badge stopped waiting", not "the phone said no". Gating
    // `ready` on it disabled Create while the badge told the operator that Create
    // would re-check under the lock — instructing them to do the one thing the UI
    // had just made impossible. Create re-probes under the phone lock and still
    // refuses to buy a number if capacity cannot be read, so leaving the button
    // live here costs nothing and is money-safe.
    const capacityPending = accountCapacity.code === 'PROFILE_ACCOUNT_CAPACITY_PENDING'
    const baseError = preflightError(result, minimumBalance)
    if (accountCapacity.code && !capacityPending) {
      result.code = accountCapacity.code
      result.error = accountCapacity.error
      if (accountCapacity.data) result.data = accountCapacity.data
      result.ready = false
    } else if (capacityPending) {
      result.accountCapacityPending = true
      if (baseError) {
        result.error = baseError
        result.code = result.phoneBusy ? 'PHONE_BUSY' : 'PREFLIGHT_FAILED'
        result.ready = false
      } else {
        // Advisory: `error` carries the sentence the badge renders, `ready` stays
        // true so Create is pressable.
        result.code = accountCapacity.code
        result.error = accountCapacity.error
        result.ready = true
      }
    } else {
      result.error = baseError
      if (result.error) result.code = result.phoneBusy ? 'PHONE_BUSY' : 'PREFLIGHT_FAILED'
      result.ready = result.error == null
    }
    return result
  }

  async function status(input) {
    const serial = normalizeSerial(input?.serial)
    if (!serial) return { success: false, code: 'INVALID_REQUEST', pending: false, error: 'Select a connected phone.' }
    const session = getAuthenticatedSession(deps)
    if (!session) return { ...unauthorizedResult(), pending: false }
    let attempt, paidAttemptStore, receipt = null
    try {
      paidAttemptStore = await bindPaidAttemptStore(serial, session)
      attempt = await Promise.resolve(paidAttemptStore.get(serial))
      if (input?.operationId != null) {
        const stored = await rawPaidAttemptStore.getReceipt(input.operationId)
        if (getAuthenticatedSession(deps)?.tenantId !== session.tenantId) return { ...unauthorizedResult(), pending: false }
        if (stored?.tenantId === session.tenantId && stored.hardwareId === paidAttemptStore.hardwareId
          && stored.userId === normalizeUserId(input.userId)) {
          receipt = { operationId: stored.operationId, hardwareId: stored.hardwareId, userId: stored.userId,
            outcome: stored.outcome, completedAt: stored.completedAt }
        }
      }
    } catch (error) {
      return { ...stateFailure(error), pending: false }
    }
    // A sidebar recreated mid-create (scrcpy relaunch) has no ciRunning state of
    // its own — this is how it learns a run already owns the phone.
    const activeRun = activeRuns.get(paidAttemptStore.hardwareId) || null
    const running = { running: Boolean(activeRun), runningUserId: activeRun?.userId ?? null }
    if (!attempt) return { success: true, pending: false, serial, ...running, ...(input?.operationId != null ? { receipt } : {}) }
    if (String(attempt.tenantId || '') !== session.tenantId) {
      return {
        success: false,
        code: 'RECOVERY_STATE_MISMATCH',
        retryable: false,
        pending: false,
        error: 'The pending account-creation state belongs to a different authenticated tenant.',
      }
    }
    const attemptUserId = normalizeUserId(attempt.userId)
    const profileError = await phoneProfileError(deps, serial, attemptUserId, session)
    if (profileError) {
      return {
        ...profileError,
        pending: false,
      }
    }
    return {
      success: true,
      pending: true,
      serial,
      ...running,
      userId: attemptUserId,
      startedAt: Number(attempt.startedAt) || null,
      ...(input?.operationId != null ? { receipt } : {}),
      ...(attempt.phase === 'credentials_persisted' ? { credentialsPersisted: true } : {}),
    }
  }

  async function reconcile(input) {
    const action = String(input?.action || '')
    const serial = normalizeSerial(input?.serial)
    const userId = normalizeUserId(input?.userId)
    if (!serial || userId == null || !['created', 'released'].includes(action)) {
      return { success: false, code: 'INVALID_REQUEST', retryable: false, error: 'Choose a valid account-creation recovery action.' }
    }
    const session = getAuthenticatedSession(deps)
    if (!session) return unauthorizedResult()

    let attempt, paidAttemptStore
    try {
      paidAttemptStore = await bindPaidAttemptStore(serial, session)
      attempt = await Promise.resolve(paidAttemptStore.get(serial))
    } catch (error) {
      return stateFailure(error)
    }
    if (!attempt) {
      return { success: false, code: 'NO_PENDING_ACCOUNT_CREATION', retryable: false, error: 'There is no paid account-creation attempt to reconcile.' }
    }
    if (
      String(attempt.tenantId || '') !== session.tenantId
      || normalizeUserId(attempt.userId) !== userId
      || !attempt.credentialReservationId
    ) {
      return { success: false, code: 'RECOVERY_STATE_MISMATCH', retryable: false, error: 'The pending attempt does not match this Android profile.' }
    }
    const profileError = await phoneProfileError(deps, serial, userId, session)
    if (profileError) return profileError

    const credentialsAlreadyPersisted = attempt.phase === 'credentials_persisted'
    const persistedUsername = normalizeUsername(attempt.username)
    const persistedAccountId = normalizeAccountId(attempt.accountId)
    if (credentialsAlreadyPersisted && !persistedUsername) {
      return { success: false, code: 'RECOVERY_STATE_MISMATCH', retryable: false, error: 'The saved-account recovery state is incomplete.' }
    }
    if (credentialsAlreadyPersisted && action === 'released') {
      return {
        success: false,
        code: 'ACCOUNT_CREDENTIALS_ALREADY_PERSISTED',
        retryable: false,
        credentialsPersisted: true,
        error: 'Encrypted account credentials are already saved. Finish local cleanup instead of releasing the reservation.',
      }
    }

    const username = credentialsAlreadyPersisted
      ? persistedUsername
      : normalizeUsername(input?.username)
    const password = String(input?.password || '')
    const orderId = String(attempt.orderId || '').trim()
    if (action === 'created' && !credentialsAlreadyPersisted && (!username || password.length < 8)) {
      return { success: false, code: 'INVALID_REQUEST', retryable: false, error: 'Enter the exact observed username and its password.' }
    }
    if (action === 'released') {
      const storedOrderHash = createHash('sha256').update(orderId).digest('hex')
      if (!orderId || !attempt.orderIdHash || storedOrderHash !== attempt.orderIdHash) {
        return {
          success: false,
          code: 'SMSPOOL_ORDER_MISMATCH',
          retryable: false,
          manualActionRequired: true,
          error: 'The protected SMSPool order binding is unavailable or invalid. The paid state was not changed.',
        }
      }
    }

    const release = deps.acquirePhoneLock?.(serial)
    if (typeof release !== 'function') {
      return { success: false, code: 'PHONE_BUSY', retryable: true, error: 'This phone is running another action.' }
    }
    try {
      const lockedStore = await bindPaidAttemptStore(serial, session, paidAttemptStore.hardwareId)
      const lockedAttempt = await lockedStore.get(serial)
      if (!lockedAttempt || lockedAttempt.tenantId !== session.tenantId
        || lockedAttempt.credentialReservationId !== attempt.credentialReservationId
        || normalizeUserId(lockedAttempt.userId) !== userId) {
        return { success: false, code: 'RECOVERY_STATE_MISMATCH', retryable: false, error: 'The protected recovery state changed. Reopen recovery for this phone.' }
      }
      paidAttemptStore = lockedStore
      const exactUserId = normalizeUserId(await deps.getCurrentUserId(serial))
      if (exactUserId !== userId) {
        return {
          success: false,
          code: 'WRONG_PROFILE',
          retryable: true,
          error: `Requested profile ${userId}, but active profile ${exactUserId == null ? 'unknown' : exactUserId} is on the phone.`,
        }
      }

      if (action === 'created') {
        if (credentialsAlreadyPersisted) {
          try {
            await Promise.resolve(paidAttemptStore.clear(
              serial,
              String(attempt.credentialReservationId),
              session.tenantId,
              false,
              "created",
            ))
          } catch (_) {
            return {
              success: false,
              code: 'ACCOUNT_CREATED_STATE_RECONCILIATION_REQUIRED',
              retryable: false,
              username,
              credentialsPersisted: true,
              ...(persistedAccountId ? { accountId: persistedAccountId } : {}),
              error: `@${username} is saved, but local paid-attempt cleanup is still pending.`,
            }
          }
          try { await deps.returnInstagramHome?.(serial) } catch (_) {}
          return {
            success: true,
            reconciled: 'created',
            username,
            credentialsPersisted: true,
            ...(persistedAccountId ? { accountId: persistedAccountId } : {}),
          }
        }

        let accounts
        try {
          accounts = await deps.detectInstagramAccounts?.(serial, userId)
        } catch (_) {
          accounts = null
        }
        const observed = Array.isArray(accounts)
          ? accounts.map(normalizeUsername).filter(Boolean)
          : []
        if (!observed.some(account => account.toLowerCase() === username.toLowerCase())) {
          return {
            success: false,
            code: 'ACCOUNT_IDENTITY_UNVERIFIED',
            retryable: false,
            manualActionRequired: true,
            error: `@${username} was not observed in Instagram on profile ${userId}. The paid state was preserved.`,
          }
        }
        const persisted = await deps.scaffold?.(
          serial,
          userId,
          username,
          password,
          String(attempt.credentialReservationId),
        )
        if (persisted?.credentialsPersisted !== true) {
          return {
            success: false,
            code: 'ACCOUNT_CREATED_UNPERSISTED',
            retryable: false,
            error: `@${username} was observed, but encrypted credential persistence was not confirmed.`,
          }
        }
        const accountId = normalizeAccountId(persisted.accountId)
        try {
          await Promise.resolve(paidAttemptStore.put(serial, {
            ...attempt,
            phase: 'credentials_persisted',
            username,
            ...(accountId ? { accountId } : {}),
            credentialsPersistedAt: Date.now(),
          }))
        } catch (_) {
          return {
            success: false,
            code: 'ACCOUNT_CREATED_RECOVERY_STATE_WRITE_FAILED',
            retryable: false,
            manualActionRequired: true,
            username,
            credentialsPersisted: true,
            ...(accountId ? { accountId } : {}),
            error: `@${username} was saved, but local recovery state could not be updated. Re-enter the exact username and password to reconcile.`,
          }
        }
        try {
          await Promise.resolve(paidAttemptStore.clear(
            serial,
            String(attempt.credentialReservationId),
            session.tenantId,
            false,
            "created",
          ))
        } catch (_) {
          return {
            success: false,
            code: 'ACCOUNT_CREATED_STATE_RECONCILIATION_REQUIRED',
            retryable: false,
            username,
            credentialsPersisted: true,
            ...(accountId ? { accountId } : {}),
            error: `@${username} was saved, but local paid-attempt state still needs reconciliation.`,
          }
        }
        try { await deps.returnInstagramHome?.(serial) } catch (_) {}
        return {
          success: true,
          reconciled: 'created',
          username,
          credentialsPersisted: true,
          ...(accountId ? { accountId } : {}),
        }
      }

      let provider
      try {
        const originalProvider = resolveSmsProvider(deps, session, attempt.smsProvider || 'smspool', attempt.providerCredentials)
        provider = originalProvider.configured ? await originalProvider.getOrderStatus(orderId) : null
      } catch (_) {
        provider = null
      }
      if (provider?.safeToRelease !== true) {
        return {
          success: false,
          code: 'SMSPOOL_OUTCOME_UNVERIFIED',
          retryable: false,
          manualActionRequired: true,
          error: 'The SMS provider did not prove this order was cancelled or refunded. The paid state was preserved.',
        }
      }
      const released = await deps.scaffold?.releaseCredentialReservation?.(
        String(attempt.credentialReservationId),
      )
      if (released?.credentialReservationReleased !== true) {
        return {
          success: false,
          code: 'CREDENTIAL_RESERVATION_RELEASE_UNCONFIRMED',
          retryable: false,
          error: 'SMSPool proved a safe outcome, but encrypted credential reservation release was not confirmed.',
        }
      }
      await Promise.resolve(paidAttemptStore.clear(
        serial,
        String(attempt.credentialReservationId),
        session.tenantId,
        false,
        "released",
      ))
      return { success: true, reconciled: 'released', providerStatus: String(provider.status || 'released') }
    } catch (error) {
      return {
        success: false,
        code: 'ACCOUNT_CREATION_RECONCILIATION_FAILED',
        retryable: false,
        error: safeError(error?.message || error, [password, orderId]),
      }
    } finally {
      release()
    }
  }

  async function start(input) {
    const invalid = validateStartInput(input)
    if (invalid) return { success: false, code: 'INVALID_REQUEST', retryable: false, error: invalid }

    const serial = normalizeSerial(input.serial)
    const userId = normalizeUserId(input.userId)
    const password = String(input.password)
    const country = normalizeCountry(input.country)
    const providerName = normalizeProvider(input.provider)
    const maxPriceUsd = normalizeMaxPrice(input.maxPriceUsd)
    const requestedUsername = normalizeUsername(input.username)
    const operationId = normalizeOperationId(input.operationId)
    const requestedDisplayName = String(input.displayName || '').trim()
    logCreate('create-ig:start', {
      serial,
      userId,
      country,
      hasUsername: Boolean(requestedUsername),
      hasDisplayName: Boolean(requestedDisplayName),
    })
    const session = getAuthenticatedSession(deps)
    if (!session) return unauthorizedResult()
    const profileError = await phoneProfileError(deps, serial, userId, session)
    if (profileError) return profileError
    let paidAttemptStore, hardwareId
    async function paidStateError() {
      if (getAuthenticatedSession(deps)?.tenantId !== session.tenantId) return unauthorizedResult()
      let outstandingPaidAttempt
      try {
        paidAttemptStore = await bindPaidAttemptStore(serial, session, hardwareId)
        hardwareId = paidAttemptStore.hardwareId
        outstandingPaidAttempt = await Promise.resolve(paidAttemptStore.get(serial))
      } catch (error) {
        return stateFailure(error)
      }
      if (getAuthenticatedSession(deps)?.tenantId !== session.tenantId) return unauthorizedResult()
      if (outstandingPaidAttempt) {
        if (String(outstandingPaidAttempt.tenantId || '') !== session.tenantId) {
          return {
            success: false,
            code: 'RECOVERY_STATE_MISMATCH',
            retryable: false,
            manualActionRequired: true,
            error: 'A protected paid attempt belongs to another authenticated tenant on this executor.',
          }
        }
        return {
          success: false,
          code: 'ACCOUNT_CREATION_OUTCOME_UNCERTAIN',
          retryable: false,
          manualActionRequired: true,
          error: 'A previous paid account-creation attempt needs reconciliation before another number can be purchased.',
        }
      }
      if (operationId) {
        let receipt
        try { receipt = await rawPaidAttemptStore.getReceipt(operationId) }
        catch (error) { return stateFailure(error) }
        if (getAuthenticatedSession(deps)?.tenantId !== session.tenantId) return unauthorizedResult()
        if (receipt) return { success: false, code: 'ACCOUNT_CREATION_OPERATION_SETTLED', retryable: false,
          error: 'This exact account creation operation was already settled. Review its recorded outcome before starting a new operation.' }
      }
      return null
    }
    const initialPaidStateError = await paidStateError()
    if (initialPaidStateError) return initialPaidStateError

    // Background housekeeping (the companion pass, a sweep) can hold this phone
    // for a short while. Instantly failing an operator's deliberate Create with
    // "This phone is running another action." made the app look broken — the
    // work was seconds away from finishing. Wait a bounded moment for the phone
    // instead, then explain WHAT still holds it rather than dead-ending.
    const lockWaitMs = Number.isFinite(deps.lockWaitMs) ? Number(deps.lockWaitMs) : LOCK_WAIT_MS
    const lockPollMs = Number.isFinite(deps.lockWaitPollMs) ? Number(deps.lockWaitPollMs) : LOCK_WAIT_POLL_MS
    // Signal the mirror sidebar that a run is in-flight so its orphan reaper /
    // scrcpy-exit teardown keep the panel (and the operator's open Create modal)
    // alive for the whole create — a mid-flow adb transport flap must not vanish
    // it. This is claimed BEFORE the lock wait on purpose: while v3.6.6 waits up
    // to 45s for a background pass to release the phone, the panel used to be
    // completely unprotected, and a mirror death in that window destroyed the
    // sidebar with the modal inside it ("clicking create just closes").
    // Best-effort: in non-electron test contexts the require throws and is a no-op.
    const setSidebarBusy = busy => {
      try { require('../lib/mirror-toolbar').setToolbarBusy(serial, busy) } catch (_) {}
    }
    setSidebarBusy(true)
    const tryAcquireLock = () => {
      try {
        const acquired = deps.acquirePhoneLock?.(serial)
        return typeof acquired === 'function' ? acquired : null
      } catch (_) {
        return null
      }
    }
    const lockWaitStartedAt = Date.now()
    let release = tryAcquireLock()
    if (typeof release !== 'function') {
      const waitDeadline = lockWaitStartedAt + lockWaitMs
      while (typeof release !== 'function' && Date.now() < waitDeadline) {
        await new Promise(resolve => setTimeout(resolve, lockPollMs))
        release = tryAcquireLock()
      }
    }
    logCreate('create-ig:lock', {
      serial,
      userId,
      acquired: typeof release === 'function',
      waitedMs: Date.now() - lockWaitStartedAt,
    })
    if (typeof release !== 'function') {
      const holder = activeRuns.get(hardwareId)
      const heldForS = holder ? Math.round((Date.now() - holder.startedAt) / 1000) : null
      setSidebarBusy(false)
      return {
        success: false,
        code: 'PHONE_BUSY',
        retryable: true,
        error: holder
          ? `Account creation is already running on this phone (started ${heldForS}s ago).`
          : `This phone is still busy with background maintenance after ${Math.round(lockWaitMs / 1000)}s. It should clear shortly — press Create again.`,
      }
    }
    // Paired with the delete in the finally below: this is what lets preflight()
    // and status() name the lock holder as OUR OWN create instead of "another
    // action". Registered after the lock so it can never outlive it.
    const lockAcquiredAt = Date.now()
    activeRuns.set(hardwareId, { userId, startedAt: lockAcquiredAt })

    let credentialReservationId = null
    let paidAttemptPersisted = false
    let paidModuleDispatched = false
    try {
      // Another attempt may have left durable recovery state while we waited.
      const lockedPaidStateError = await paidStateError()
      if (lockedPaidStateError) return lockedPaidStateError
      const exactUserId = normalizeUserId(await deps.getCurrentUserId(serial))
      if (exactUserId !== userId) {
        return {
          success: false,
          code: 'WRONG_PROFILE',
          retryable: true,
          error: `Requested profile ${userId}, but active profile ${exactUserId == null ? 'unknown' : exactUserId} is on the phone.`,
        }
      }

      let smsProvider
      try { smsProvider = resolveSmsProvider(deps, session, providerName) } catch (_) {}
      const apiKey = smsProvider?.configured ? smsProvider.credentials.apiKey : ''
      const [brain, instagramReady, balance, accountCapacity] = await Promise.all([
        Promise.resolve(deps.getBrainStatus?.()).catch(() => ({ running: false })),
        Promise.resolve(deps.isInstagramReady(serial, userId)).catch(() => false),
        apiKey
          ? Promise.resolve(smsProvider.getBalance(true)).catch(() => null)
          : Promise.resolve(null),
        // Same coalescer as the badge: if a preflight probe the badge already
        // abandoned is still driving IG, join it rather than opening a second
        // detector on top of the signup we are about to start — but never accept
        // a failure it produced before this create owned the phone.
        probeCapacityUnderLock(serial, userId, lockAcquiredAt),
      ])
      logCreate('create-ig:capacity', {
        serial,
        userId,
        verified: accountCapacity.accountCapacityVerified === true,
        accountCount: accountCapacity.accountCount,
        code: accountCapacity.code || null,
        detectorCode: accountCapacity.detectorCode || null,
        guardWaitedMs: accountCapacity.guardWaitedMs || 0,
      })
      if (accountCapacity.code) {
        return {
          success: false,
          retryable: accountCapacity.code === 'PROFILE_ACCOUNT_CAPACITY_UNVERIFIED',
          ...accountCapacity,
        }
      }

      const pinnedUserId = normalizeUserId(await deps.getCurrentUserId(serial))
      if (pinnedUserId !== userId) {
        return {
          success: false,
          code: 'WRONG_PROFILE',
          retryable: true,
          error: `Requested profile ${userId}, but active profile ${pinnedUserId == null ? 'unknown' : pinnedUserId} is on the phone.`,
        }
      }
      const priceUsd = apiKey && smsProvider.getPrice
        ? await withDeadline(smsProvider.getPrice(country, maxPriceUsd), 10000, null)
        : null
      const boundary = {
        provider: providerName,
        maxPriceUsd,
        priceUsd,
        priceRequired: Boolean(smsProvider?.getPrice),
        serial,
        userId,
        currentUserId: pinnedUserId,
        // A flaky `pm list packages` (adb hiccup mid-create) used to report
        // "Instagram is not ready on Android profile N" and abort — even though
        // the capacity detector had just OPENED Instagram and read the account
        // switcher on this exact profile. That successful detection is far
        // stronger proof IG is ready than the package check, so trust it: if
        // capacity was verified, IG is reachable regardless of the package probe.
        instagramReady: instagramReady === true || accountCapacity.accountCapacityVerified === true,
        brainReady: brain?.running === true,
        phoneBusy: false,
        smspoolConfigured: Boolean(apiKey),
        balance: Number.isFinite(balance) ? Number(balance) : null,
      }
      const boundaryError = preflightError(boundary, minimumBalance)
      if (boundaryError) {
        return { success: false, code: 'PREFLIGHT_FAILED', retryable: true, error: boundaryError }
      }

      const scaffold = deps.scaffold
      if (
        typeof scaffold !== 'function'
        || scaffold.supportsCredentialPersistence !== true
        || typeof scaffold.preflightCredentialPersistence !== 'function'
        || typeof scaffold.releaseCredentialReservation !== 'function'
      ) {
        return {
          success: false,
          code: 'SECURE_CREDENTIAL_PERSISTENCE_UNAVAILABLE',
          retryable: true,
          error: 'Account creation is blocked because encrypted credential persistence is unavailable.',
        }
      }

      let persistencePreflight
      try {
        persistencePreflight = await scaffold.preflightCredentialPersistence(serial, String(userId), password)
      } catch (error) {
        persistencePreflight = { ok: false, error: error?.message || error }
      }
      if (
        !persistencePreflight
        || persistencePreflight.credentialPersistenceReady !== true
        || !persistencePreflight.credentialReservationId
      ) {
        return {
          success: false,
          code: 'SECURE_CREDENTIAL_PERSISTENCE_UNAVAILABLE',
          retryable: true,
          error: safeError(
            persistencePreflight?.error || 'Encrypted credential reservation was not confirmed.',
            [password, apiKey],
          ),
        }
      }
      credentialReservationId = String(persistencePreflight.credentialReservationId)

      const releaseCredentialReservation = async () => {
        try {
          return await scaffold.releaseCredentialReservation(credentialReservationId)
        } catch (error) {
          return { ok: false, credentialReservationReleased: false, error: error?.message || error }
        }
      }
      const clearPaidAttempt = async outcome => {
        await Promise.resolve(paidAttemptStore.clear(serial, credentialReservationId, session.tenantId, !paidModuleDispatched, outcome))
        paidAttemptPersisted = false
      }

      if (getAuthenticatedSession(deps)?.tenantId !== session.tenantId) {
        await releaseCredentialReservation()
        return unauthorizedResult()
      }
      const runId = `account_creation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      try {
        await Promise.resolve(paidAttemptStore.put(serial, {
          tenantId: session.tenantId,
          ...(operationId ? { operationId } : {}),
          smsProvider: providerName,
          providerCredentials: { ...smsProvider.credentials },
          maxPriceUsd,
          serial,
          userId,
          runId,
          credentialReservationId,
          startedAt: Date.now(),
        }))
        paidAttemptPersisted = true
      } catch (_) {
        const releaseResult = await releaseCredentialReservation()
        if (releaseResult?.credentialReservationReleased === true) {
          return {
            success: false,
            code: 'PAID_ATTEMPT_STATE_UNAVAILABLE',
            retryable: true,
            error: 'The paid attempt could not be recorded durably. No account-creation module was started.',
          }
        }
        return {
          success: false,
          code: 'CREDENTIAL_RESERVATION_RELEASE_UNCONFIRMED',
          retryable: false,
          error: 'The paid attempt did not start, but encrypted credential reservation release was not confirmed.',
        }
      }

      const persistCredentials = async (username) => {
        let accountId = null
        try {
          const result = await scaffold(serial, userId, username, password, credentialReservationId)
          if (result?.credentialsPersisted !== true) {
            return { credentialsPersisted: false, statePersisted: false }
          }
          accountId = normalizeAccountId(result.accountId)
        } catch (_) {
          return { credentialsPersisted: false, statePersisted: false }
        }

        try {
          const current = await Promise.resolve(paidAttemptStore.get(serial))
          if (
            !current
            || current.credentialReservationId !== credentialReservationId
            || current.tenantId !== session.tenantId
          ) {
            throw new Error('Account creation state changed before credential finalize')
          }
          await Promise.resolve(paidAttemptStore.put(serial, {
            ...current,
            phase: 'credentials_persisted',
            username,
            ...(accountId ? { accountId } : {}),
            credentialsPersistedAt: Date.now(),
          }))
          return { credentialsPersisted: true, statePersisted: true, ...(accountId ? { accountId } : {}) }
        } catch (_) {
          return { credentialsPersisted: true, statePersisted: false, ...(accountId ? { accountId } : {}) }
        }
      }

      const verifyExactAccountIdentity = async (username) => {
        const exactUsername = normalizeUsername(username)
        if (!exactUsername) {
          return {
            success: false,
            code: 'ACCOUNT_IDENTITY_UNVERIFIED',
            retryable: false,
            manualActionRequired: true,
            error: 'Instagram did not return an exact account username. The paid state was preserved.',
          }
        }
        const currentSession = getAuthenticatedSession(deps)
        if (!currentSession || currentSession.tenantId !== session.tenantId) {
          return unauthorizedResult()
        }
        const exactUserId = normalizeUserId(await deps.getCurrentUserId(serial))
        if (exactUserId !== userId) {
          return {
            success: false,
            code: 'WRONG_PROFILE',
            retryable: false,
            manualActionRequired: true,
            error: `Requested profile ${userId}, but active profile ${exactUserId == null ? 'unknown' : exactUserId} is on the phone. The paid state was preserved.`,
          }
        }
        let accounts
        try {
          accounts = await deps.detectInstagramAccounts?.(serial, userId)
        } catch (_) {
          accounts = null
        }
        const observed = Array.isArray(accounts)
          ? accounts.map(normalizeUsername).filter(Boolean)
          : []
        if (!observed.some(account => account.toLowerCase() === exactUsername.toLowerCase())) {
          return {
            success: false,
            code: 'ACCOUNT_IDENTITY_UNVERIFIED',
            retryable: false,
            manualActionRequired: true,
            error: `@${exactUsername} was not observed in Instagram on profile ${userId}. The paid state was preserved.`,
          }
        }
        return { success: true, username: exactUsername }
      }

      if (getAuthenticatedSession(deps)?.tenantId !== session.tenantId) {
        const releaseResult = await releaseCredentialReservation()
        if (releaseResult?.credentialReservationReleased !== true) {
          return {
            success: false, code: 'CREDENTIAL_RESERVATION_RELEASE_UNCONFIRMED', retryable: false,
            error: 'Sign-in changed before account creation started. No SMS request was sent, but encrypted credential reservation release was not confirmed.',
          }
        }
        try {
          await clearPaidAttempt("not_started")
        } catch (_) {
          return {
            success: false, code: 'PAID_ATTEMPT_STATE_UNAVAILABLE', retryable: false,
            error: 'Sign-in changed before account creation started. No SMS request was sent, but protected local state could not be cleared.',
          }
        }
        return unauthorizedResult()
      }

      let moduleResult
      let orderWrites = Promise.resolve()
      let orderWriteFailed = false
      const drainOrderWrites = async () => {
        let tail
        do { tail = orderWrites; await tail } while (tail !== orderWrites)
      }
      paidModuleDispatched = true
      try {
        moduleResult = await deps.runModuleWs({
          runId,
          moduleId: 'account_creation_phone',
          deviceId: serial,
          profileId: String(userId),
          moduleConfig: {
            target_user_id: String(userId),
            ig_username: requestedUsername,
            ig_name: requestedDisplayName,
            password,
            sms_provider: providerName,
            sms_max_price_usd: maxPriceUsd,
            ...(providerName === 'textverified'
              ? { textverified_api_key: apiKey, textverified_api_username: smsProvider.credentials.apiUsername }
              : { smspool_api_key: apiKey }),
            smspool_country: country,
          },
        }, release.ownerToken, {
          onAccountCreationOrder(orderIdValue) {
            const orderId = String(orderIdValue || '').trim()
            if (!orderId || orderId.length > 256 || /\s/.test(orderId)) return
            // Progress callbacks are synchronous; drain their durable writes
            // before accepting a result or releasing the phone lock.
            orderWrites = orderWrites.then(async () => {
              await paidAttemptStore.recordOrder(credentialReservationId, orderId)
            }).catch(() => { orderWriteFailed = true })
            return orderWrites
          },
        })
        await drainOrderWrites()
        if (orderWriteFailed) throw new Error('Protected order persistence failed')
      } catch (_) {
        await drainOrderWrites()
        return {
          success: false,
          code: 'ACCOUNT_CREATION_OUTCOME_UNCERTAIN',
          retryable: false,
          manualActionRequired: true,
          error: 'The paid account-creation request lost contact with the local automation brain. Reconcile the phone and SMSPool before retrying.',
        }
      }

      const recoveryData = moduleResult?.data || moduleResult?.result || {}
      if (
        moduleResult?.success !== true
        && recoveryData.credential_reservation_release_safe === true
        && recoveryData.paid_order_created === false
      ) {
        const releaseResult = await releaseCredentialReservation()
        if (releaseResult?.credentialReservationReleased !== true) {
          return {
            success: false,
            code: 'CREDENTIAL_RESERVATION_RELEASE_UNCONFIRMED',
            retryable: false,
            error: 'Account creation did not start, but encrypted credential reservation release was not confirmed.',
          }
        }
        try {
          await clearPaidAttempt("not_started")
        } catch (_) {
          return {
            success: false,
            code: 'PAID_ATTEMPT_STATE_UNAVAILABLE',
            retryable: false,
            error: 'The encrypted reservation was released, but local paid-attempt state could not be cleared.',
          }
        }
        return {
          success: false,
          code: String(moduleResult?.code || 'ACCOUNT_CREATION_FAILED'),
          retryable: moduleResult?.retryable === true || recoveryData.retryable === true,
          error: safeError(moduleResult?.error, [password, apiKey]),
        }
      }

      if (!moduleResult?.success) {
        const identityUnverified = moduleResult?.code === 'ig_profile_identity_mismatch'
          || (
            recoveryData.credentials_should_persist === true
            && recoveryData.account_identity_verified !== true
          )
        if (identityUnverified) {
          return {
            success: false,
            code: moduleResult?.code === 'ig_profile_identity_mismatch'
              ? 'ig_profile_identity_mismatch'
              : 'ACCOUNT_IDENTITY_UNVERIFIED',
            retryable: false,
            manualActionRequired: true,
            error: safeError(
              moduleResult?.error || 'The open Instagram profile did not match the requested account. Reconcile the phone before retrying.',
              [password, apiKey],
            ),
          }
        }
        if (recoveryData.credentials_should_persist === true) {
          const recoveryUsername = String(
            recoveryData.account_username || recoveryData.username || '',
          ).trim().replace(/^@/, '')
          const identity = await verifyExactAccountIdentity(recoveryUsername)
          if (identity.success !== true) return identity
          const persisted = await persistCredentials(identity.username)
          if (persisted.credentialsPersisted !== true) {
            return {
              success: false,
              code: 'ACCOUNT_CREATED_UNPERSISTED',
              retryable: false,
              username: identity.username,
              error: `@${identity.username} needs manual recovery, and encrypted credential persistence was not confirmed.`,
            }
          }
          if (persisted.statePersisted !== true) {
            return {
              success: false,
              code: 'ACCOUNT_CREATED_RECOVERY_STATE_WRITE_FAILED',
              retryable: false,
              manualActionRequired: true,
              username: identity.username,
              credentialsPersisted: true,
              ...(persisted.accountId ? { accountId: persisted.accountId } : {}),
              error: `@${identity.username} was saved, but local recovery state could not be updated. Re-enter the exact username and password to reconcile.`,
            }
          }
          try {
            await clearPaidAttempt("created")
          } catch (_) {
            return {
              success: false,
              code: 'ACCOUNT_CREATED_STATE_RECONCILIATION_REQUIRED',
              retryable: false,
              username: identity.username,
              credentialsPersisted: true,
              ...(persisted.accountId ? { accountId: persisted.accountId } : {}),
              error: `@${identity.username} was saved, but local paid-attempt state still needs reconciliation.`,
            }
          }
          return {
            success: false,
            code: String(moduleResult?.code || 'INSTAGRAM_MANUAL_ACTION_REQUIRED'),
            retryable: false,
            manualActionRequired: recoveryData.manual_action_required === true,
            username: identity.username,
            credentialsPersisted: true,
            ...(persisted.accountId ? { accountId: persisted.accountId } : {}),
            error: safeError(moduleResult?.error || 'Finish the remaining Instagram step on the phone.'),
          }
        }
        return {
          success: false,
          code: 'ACCOUNT_CREATION_OUTCOME_UNCERTAIN',
          retryable: false,
          manualActionRequired: true,
          error: 'The paid account-creation outcome is not proven safe to retry. Reconcile the phone and SMSPool before another attempt.',
        }
      }

      const username = String(
        moduleResult?.data?.account_username
          || moduleResult?.data?.username
          || '',
      )
        .trim()
        .replace(/^@/, '')
      if (recoveryData.account_identity_verified !== true) {
        return {
          success: false,
          code: 'ACCOUNT_IDENTITY_UNVERIFIED',
          retryable: false,
          manualActionRequired: true,
          error: 'Instagram creation completed without exact account identity proof. The paid state was preserved.',
        }
      }
      const identity = await verifyExactAccountIdentity(username)
      if (identity.success !== true) return identity

      const persisted = await persistCredentials(identity.username)
      if (persisted.credentialsPersisted !== true) {
        return {
          success: false,
          code: 'ACCOUNT_CREATED_UNPERSISTED',
          retryable: false,
          username: identity.username,
          error: `@${identity.username} was created, but encrypted credential persistence was not confirmed. Recover this account before retrying.`,
        }
      }
      if (persisted.statePersisted !== true) {
        return {
          success: false,
          code: 'ACCOUNT_CREATED_RECOVERY_STATE_WRITE_FAILED',
          retryable: false,
          manualActionRequired: true,
          username: identity.username,
          credentialsPersisted: true,
          ...(persisted.accountId ? { accountId: persisted.accountId } : {}),
          error: `@${identity.username} was saved, but local recovery state could not be updated. Re-enter the exact username and password to reconcile.`,
        }
      }

      try {
        await clearPaidAttempt("created")
      } catch (_) {
        return {
          success: false,
          code: 'ACCOUNT_CREATED_STATE_RECONCILIATION_REQUIRED',
          retryable: false,
          username: identity.username,
          credentialsPersisted: true,
          ...(persisted.accountId ? { accountId: persisted.accountId } : {}),
          error: `@${identity.username} was saved, but local paid-attempt state still needs reconciliation.`,
        }
      }
      try { await deps.returnInstagramHome?.(serial) } catch (_) {}
      return {
        success: true,
        username: identity.username,
        credentialsPersisted: true,
        ...(persisted.accountId ? { accountId: persisted.accountId } : {}),
      }
    } catch (error) {
      if (paidModuleDispatched || paidAttemptPersisted || credentialReservationId) {
        return {
          success: false,
          code: 'ACCOUNT_CREATION_OUTCOME_UNCERTAIN',
          retryable: false,
          manualActionRequired: true,
          error: 'Account creation entered a recoverable paid state. Reconcile the phone and encrypted credential reservation before retrying.',
        }
      }
      return {
        success: false,
        code: 'ACCOUNT_CREATION_FAILED',
        retryable: false,
        error: safeError(error?.message || error, [password]),
      }
    } finally {
      // Clear busy in the finally so it releases on throw/reject too — a deferred
      // close (mirror genuinely gone during the run) is honored here behind the
      // grace window, and a live mirror is left untouched.
      setSidebarBusy(false)
      activeRuns.delete(hardwareId)
      release()
    }
  }

  // Every create outcome is logged — success, failure code and elapsed time — so
  // a failed submit is never again invisible in launcher.log. Deliberately logs
  // NO error text on the throw path: nothing here may risk echoing a password.
  const startWithTelemetry = async input => {
    const startedAt = Date.now()
    try {
      const result = await start(input)
      logCreate('create-ig:result', {
        serial: normalizeSerial(input?.serial),
        userId: normalizeUserId(input?.userId),
        success: result?.success === true,
        code: result?.code || null,
        detectorCode: result?.detectorCode || null,
        retryable: result?.retryable === true,
        manualActionRequired: result?.manualActionRequired === true,
        elapsedMs: Date.now() - startedAt,
      })
      return result
    } catch (_) {
      logCreate('create-ig:result', {
        serial: normalizeSerial(input?.serial),
        success: false,
        code: 'START_THREW',
        elapsedMs: Date.now() - startedAt,
      })
      throw _
    }
  }

  return { preflight, status, reconcile, start: startWithTelemetry }
}

function registerAccountCreationHandlers(ipcMain, deps) {
  const service = createAccountCreationService(deps)
  const trusted = handler => async (event, input) => {
    let trustedSender = false
    try { trustedSender = deps.isTrustedIpcSender?.(event, input) === true } catch (_) {}
    if (!trustedSender || !getAuthenticatedSession(deps)) return unauthorizedResult()
    return handler(input)
  }
  ipcMain.handle('account-creation:preflight', trusted(service.preflight))
  ipcMain.handle('account-creation:status', trusted(service.status))
  ipcMain.handle('account-creation:reconcile', trusted(service.reconcile))
  ipcMain.handle('account-creation:start', trusted(service.start))
  return service
}

module.exports = {
  DEFAULT_MINIMUM_BALANCE,
  createFilePaidAttemptStore,
  createAccountCreationService,
  registerAccountCreationHandlers,
}
