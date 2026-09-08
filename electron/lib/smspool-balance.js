// Reads the live smspool account balance. parseBalance is pure (tested);
// fetchBalance does the POST. Matches igdisc/run-fleet.sh's balance check.
const https = require('https')
const SMSPOOL_REQUEST_TIMEOUT_MS = 10_000

function parseBalance(text) {
  try {
    const v = parseFloat(JSON.parse(text).balance)
    return Number.isFinite(v) ? v : null
  } catch (_) { return null }
}

function parseOrderStatus(text) {
  try {
    const payload = JSON.parse(text)
    const raw = String(payload?.status ?? '').toLowerCase()
    const statuses = {
      '1': 'pending',
      '2': 'expired',
      '3': 'completed',
      '4': 'resend',
      '5': 'cancelled',
      '6': 'refunded',
      '7': 'processing',
      '8': 'activating',
    }
    const status = statuses[raw] || raw || 'unavailable'
    return { safeToRelease: status === 'cancelled' || status === 'refunded', status }
  } catch (_) {
    return { safeToRelease: false, status: 'unavailable' }
  }
}

function postForm(path, body, parse, fallback, timeoutMs = SMSPOOL_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Number(timeoutMs)
      : SMSPOOL_REQUEST_TIMEOUT_MS
    let settled = false
    let hardDeadline = null
    const finish = value => {
      if (settled) return
      settled = true
      if (hardDeadline) clearTimeout(hardDeadline)
      resolve(value)
    }
    const req = https.request({
      host: 'api.smspool.net', path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        const statusCode = Number(res.statusCode || 0)
        finish(statusCode >= 200 && statusCode < 300 ? parse(data) : fallback)
      })
      res.on('error', () => finish(fallback))
    })
    req.on('error', () => finish(fallback))
    const abort = () => {
      finish(fallback)
      req.destroy()
    }
    hardDeadline = setTimeout(abort, deadlineMs)
    req.setTimeout(deadlineMs, abort)
    req.write(body)
    req.end()
  })
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// A single balance POST returns null on ANY transient failure (timeout, network
// blip, non-2xx) — indistinguishable from a real read. But null NEVER means "$0"
// (a genuine zero balance parses to the finite number 0), so null is always a
// failed fetch. It flaked mid-create ("SMSPool balance is unavailable") seconds
// after the preflight had read $2.27, aborting the run. Retry on null a few
// times before giving up; a successful read (any finite number) returns at once.
async function _fetchBalanceWithRetry(onceFn, backoffMs = [800, 1600]) {
  for (let attempt = 0; attempt < backoffMs.length + 1; attempt++) {
    const balance = await onceFn()
    if (Number.isFinite(balance)) return balance
    if (attempt < backoffMs.length) await _delay(backoffMs[attempt])
  }
  return null
}

function fetchBalance(apiKey, timeoutMs) {
  const body = 'key=' + encodeURIComponent(apiKey || '')
  return _fetchBalanceWithRetry(() => postForm('/request/balance', body, parseBalance, null, timeoutMs))
}

// Single-attempt read for the CREATE-IG BADGE only. The badge is advisory — a
// null just says "recheck" — so stacking the 3x retry above an already-retrying
// caller only multiplies wall time and SMSPool POSTs. The create path keeps
// fetchBalance (retrying), where a false null would abort a paid run.
function fetchBalanceOnce(apiKey, timeoutMs) {
  const body = 'key=' + encodeURIComponent(apiKey || '')
  return postForm('/request/balance', body, parseBalance, null, timeoutMs)
}

function getOrderStatus(apiKey, orderId, timeoutMs) {
  const body = 'key=' + encodeURIComponent(apiKey || '') + '&orderid=' + encodeURIComponent(orderId || '')
  return postForm('/sms/check', body, parseOrderStatus, { safeToRelease: false, status: 'unavailable' }, timeoutMs)
}

module.exports = {
  SMSPOOL_REQUEST_TIMEOUT_MS,
  parseBalance,
  parseOrderStatus,
  fetchBalance,
  fetchBalanceOnce,
  getOrderStatus,
  _fetchBalanceWithRetry,
}
