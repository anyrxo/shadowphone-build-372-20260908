/**
 * app-auth-fetch.js — the ONE authenticated fetch for main-process → Next.js API calls.
 *
 * INCIDENT (2026-07-25, v3.6.7): "Create IG Account" died on the bare word
 * "Unauthorized" — the raw 401 body of /api/accounts, surfaced verbatim to the
 * operator. Two independent causes:
 *
 *   A) lib/schedule-client.js pointed at the APEX host (shadowphone.io, no www)
 *      while vercel.json 308-redirects apex → www. Node 22/undici DELETES both
 *      Authorization and Cookie across that cross-origin hop, so every request
 *      arrived at www with zero credentials. Fixed at the URL; `redirect:'error'`
 *      below is the permanent guard so a host misconfiguration can never again
 *      masquerade as an expired sign-in.
 *   B) The token came from a synchronous snapshot refreshed on a 45s interval
 *      against a ~60s Clerk JWT, with no retry anywhere. Fixed by minting
 *      immediately before use (session-token-minter.js) plus ONE forced re-mint
 *      retry on a 401.
 *
 * Why retrying exactly one 401 is safe, including for non-idempotent POSTs:
 * every desktop-hit Next route resolves auth and returns { error:'Unauthorized' }
 * BEFORE getSupabase() / request.json() / any insert|update|upsert (see
 * app/api/accounts/route.ts:107-110 GET and :214-217 POST). An HTTP 401
 * therefore proves zero side effects occurred, so the retry cannot double-insert
 * a credential reservation, double-create an account, or double-claim a queue
 * run. That invariant is pinned by lib/__tests__/api-401-precedes-side-effects.test.js.
 * Nothing else is ever retried — not timeouts, not network errors, not 5xx —
 * because those are exactly the cases where a write may have landed.
 */
'use strict'

const SESSION_EXPIRED_MESSAGE =
  'ShadowPhone sign-in expired — open the ShadowPhone dashboard window, sign in again, then retry.'

class AuthExpiredError extends Error {
  constructor(message = SESSION_EXPIRED_MESSAGE) {
    super(message)
    this.name = 'AuthExpiredError'
    this.code = 'SESSION_EXPIRED'
    this.status = 401
  }
}

let _getFreshSessionToken = null

function initAppAuth({ getFreshSessionToken } = {}) {
  _getFreshSessionToken = typeof getFreshSessionToken === 'function' ? getFreshSessionToken : null
}

function isAppAuthReady() {
  return typeof _getFreshSessionToken === 'function'
}

function _hasAuthorizationHeader(headers) {
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === 'authorization') return true
  }
  return false
}

function _withCredentials(init, token) {
  const headers = { ...(init.headers || {}) }
  // Never clobber a caller-supplied Authorization — the runtime queue sends
  // `ModuleJWT <token>` (main.js:398-403) and that header is the actual
  // authority for those routes. Only add the __session cookie in that case.
  if (!_hasAuthorizationHeader(headers)) headers.Authorization = `Bearer ${token}`
  headers.Cookie = `__session=${token}`
  // Cause A guard: an authenticated request must never be silently replayed at
  // another origin with its credentials stripped.
  return { ...init, headers, redirect: 'error' }
}

function _isRedirectRejection(error) {
  const message = `${(error && error.message) || ''} ${(error && error.cause && error.cause.message) || ''}`
  return message.toLowerCase().includes('redirect')
}

async function _send(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init)
  } catch (error) {
    if (_isRedirectRejection(error)) {
      const blocked = new Error(
        `Blocked a redirect for ${url}. The desktop app must call the canonical host directly — a redirect strips the session credentials.`,
      )
      blocked.code = 'API_REDIRECT_BLOCKED'
      throw blocked
    }
    throw error
  }
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] injection point for unit tests
 * @param {string}   [options.fallbackToken] used ONLY when initAppAuth() has not
 *   run (unit tests, or a handler module loaded outside the Electron main
 *   process). In that mode the behaviour is exactly the pre-fix snapshot
 *   behaviour — never better, never worse. main.js always calls initAppAuth().
 */
async function appAuthFetch(url, init = {}, { fetchImpl = globalThis.fetch, fallbackToken = null } = {}) {
  const mint = _getFreshSessionToken || (fallbackToken ? async () => fallbackToken : null)
  if (!mint) {
    throw new Error('app-auth-fetch: initAppAuth({ getFreshSessionToken }) has not run')
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('app-auth-fetch: no fetch implementation is available')
  }

  const token = await mint()
  const first = await _send(fetchImpl, url, _withCredentials(init, token || ''))
  if (!first || first.status !== 401) return first

  // Exactly one retry, exactly on 401, with a forced re-mint.
  const forced = await mint({ force: true })
  const second = await _send(fetchImpl, url, _withCredentials(init, forced || ''))
  if (second && second.status === 401) throw new AuthExpiredError()
  return second
}

const _identityRequests = new WeakMap()

function identityUnavailable(failureClass, status = null) {
  return Object.assign(new Error('ShadowPhone sign-in verification is temporarily unavailable.'), {
    code: 'SESSION_VERIFICATION_UNAVAILABLE', retryable: true, failureClass, status,
  })
}

async function verifySessionIdentity(userId, token, {
  fetchImpl = globalThis.fetch,
  apiBaseUrl = 'https://www.shadowphone.io',
  onFailure = () => {},
} = {}) {
  if (typeof userId !== 'string' || !userId.trim() || typeof token !== 'string' || !token.trim() || typeof fetchImpl !== 'function') return false
  let url
  try { url = new URL('/api/module-token', apiBaseUrl).toString() } catch (_) { return false }
  let pending = _identityRequests.get(fetchImpl)
  if (!pending) { pending = new Map(); _identityRequests.set(fetchImpl, pending) }
  const key = JSON.stringify([url, userId, token])
  if (pending.has(key)) return pending.get(key)
  const request = (async () => {
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: 'Bearer ' + token, Cookie: '__session=' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
      if (!response?.ok) {
        const status = Number(response?.status) || null
        onFailure({ failureClass: 'http', status })
        if (status === 408 || status === 429 || (status >= 500 && status < 600)) throw identityUnavailable('http', status)
        return false
      }
      const identity = await response.json()
      if (identity.authenticated !== true || identity.userId !== userId) {
        onFailure({ failureClass: 'identity', status: null })
        return false
      }
      return { userId, email: typeof identity.email === 'string' ? identity.email : null }
    } catch (error) {
      if (error?.code === 'SESSION_VERIFICATION_UNAVAILABLE') throw error
      const failureClass = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : (error instanceof SyntaxError ? 'response' : 'network')
      onFailure({ failureClass, status: null })
      throw identityUnavailable(failureClass)
    }
  })()
  pending.set(key, request)
  try { return await request } finally { pending.delete(key) }
}

module.exports = {
  verifySessionIdentity,
  initAppAuth,
  isAppAuthReady,
  appAuthFetch,
  AuthExpiredError,
  SESSION_EXPIRED_MESSAGE,
}
