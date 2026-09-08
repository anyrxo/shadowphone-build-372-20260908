/**
 * session-token-minter.js — mints a LIVE Clerk session JWT on demand.
 *
 * INCIDENT (2026-07-25, v3.6.7): a Create IG run died on the bare word
 * "Unauthorized" at 11:16 with the phone connected and SMSPool funded. The
 * main process was reading `currentUserSession.sessionToken` as a synchronous
 * SNAPSHOT refreshed on a 45s interval, against a Clerk JWT that lives ~60s and
 * was minted WITHOUT `{ skipCache: true }` (so Clerk handed back a cached token
 * with as little as ~10s of life). The snapshot was therefore expired for a
 * large fraction of wall-clock time, and nothing on the path retried.
 *
 * This module replaces "read whatever we cached last" with "mint immediately
 * before use", while keeping every existing synchronous reader working.
 *
 * Hard rules, each load-bearing:
 *  - NEVER return-and-write null, NEVER clear sessionToken. On any failure the
 *    last-known token is returned unchanged. account-creation-handlers.js
 *    getAuthenticatedSession (:105-111) is a truthiness gate that is re-checked
 *    AFTER the SMSPool purchase (verifyExactAccountIdentity :966-969); nulling
 *    the token there would turn a paid, already-created Instagram account into
 *    a plain "sign in" error with retryable:false and no paid-state language.
 *  - Every mint is forced (`skipCache: true`), so a mint can never hand back a
 *    token with less life than the freshness window — which also makes forced
 *    and unforced mints equivalent, so ONE shared single-flight promise is
 *    correct for both.
 *  - The tenant is captured before minting and re-checked before write-back, so
 *    a `clear-user-session` racing a mint cannot resurrect a dead token.
 */
'use strict'

// A token with more than this much life left is used as-is: no renderer round
// trip. Comfortably larger than a request's own latency budget.
const FRESH_WINDOW_MS = 20_000
// The renderer can be mid-navigation or wedged; never block a paid run on it.
const MINT_TIMEOUT_MS = 4_000

// Decode the JWT payload's `exp`. Unparseable => treat as already expired, so
// we mint rather than optimistically reuse something we cannot reason about.
function _expiresInMs(token, nowMs) {
  if (!token || typeof token !== 'string') return 0
  const parts = token.split('.')
  if (parts.length < 2) return 0
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const exp = Number(payload && payload.exp)
    if (!Number.isFinite(exp)) return 0
    return (exp * 1000) - nowMs
  } catch (_) {
    return 0
  }
}

function createSessionTokenMinter({
  getSession,
  setSession,
  mintFromRenderer,
  now = Date.now,
  mintTimeoutMs = MINT_TIMEOUT_MS,
  freshWindowMs = FRESH_WINDOW_MS,
}) {
  let inflight = null

  function getCachedSessionToken() {
    let session = null
    try { session = getSession && getSession() } catch (_) { return null }
    const token = session && session.sessionToken
    return typeof token === 'string' && token ? token : null
  }

  function _currentTenant() {
    try {
      const session = getSession && getSession()
      return (session && session.userId) || null
    } catch (_) { return null }
  }

  async function _mint() {
    const tenant = _currentTenant()
    const previous = getCachedSessionToken()

    let timer = null
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), mintTimeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })

    let minted = null
    try {
      minted = await Promise.race([
        Promise.resolve().then(() => mintFromRenderer({ skipCache: true })),
        timedOut,
      ])
    } catch (_) {
      minted = null
    } finally {
      if (timer) clearTimeout(timer)
    }

    // Tenant guard: a sign-out or account switch landed while we were minting.
    // Drop the minted token AND refuse to hand back the old tenant's — but never
    // write anything, so the stored snapshot the synchronous gates read is
    // untouched (that is what the "never write null" rule protects).
    if (_currentTenant() !== tenant) return null

    // A failed mint can fall back only within the tenant that started it.
    if (!minted || typeof minted !== 'string') return previous

    try { setSession(minted) } catch (_) {}
    return minted
  }

  async function getFreshSessionToken({ force = false } = {}) {
    if (!_currentTenant()) return null

    const cached = getCachedSessionToken()
    if (!force && cached && _expiresInMs(cached, now()) > freshWindowMs) return cached

    // Single-flight. Also fixes the 45s keep-alive stacking one executeJavaScript
    // call per tick forever against a wedged renderer.
    if (!inflight) {
      inflight = _mint().finally(() => { inflight = null })
    }
    return inflight
  }

  return { getFreshSessionToken, getCachedSessionToken }
}

module.exports = { createSessionTokenMinter, _expiresInMs, FRESH_WINDOW_MS, MINT_TIMEOUT_MS }
