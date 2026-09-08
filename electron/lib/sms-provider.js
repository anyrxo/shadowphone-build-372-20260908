const smspool = require('./smspool-balance')

function createSmsProvider({ provider, credentials = {}, fetchImpl = globalThis.fetch }) {
  if (!['smspool', 'textverified'].includes(provider)) throw new Error('Unsupported SMS provider')
  const apiKey = String(credentials.apiKey || '').trim()
  const apiUsername = String(credentials.apiUsername || '').trim()
  const configured = Boolean(apiKey && (provider === 'smspool' || apiUsername))
  let bearerPromise

  async function jsonRequest(url, options = {}) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('SMS provider request failed')
    return response.json()
  }

  async function textverifiedRequest(route, body) {
    if (!configured) throw new Error('TextVerified credentials are not configured')
    if (!bearerPromise) {
      bearerPromise = jsonRequest('https://www.textverified.com/api/pub/v2/auth', {
        method: 'POST', headers: { 'X-API-KEY': apiKey, 'X-API-USERNAME': apiUsername },
      }).then(data => {
        if (typeof data.token !== 'string' || !data.token) throw new Error('TextVerified authentication failed')
        return data.token
      })
    }
    const token = await bearerPromise
    return jsonRequest('https://www.textverified.com/api/pub/v2/' + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }

  return {
    provider,
    credentials: { apiKey, ...(provider === 'textverified' ? { apiUsername } : {}) },
    configured,
    async getBalance(retry = false) {
      if (!configured) return null
      if (provider === 'smspool') return (retry ? smspool.fetchBalance : smspool.fetchBalanceOnce)(apiKey)
      const data = await textverifiedRequest('account/me')
      return typeof data.currentBalance === 'number' && Number.isFinite(data.currentBalance)
        ? data.currentBalance : null
    },
    async getPrice(country) {
      if (!configured) return null
      if (provider === 'smspool') {
        const data = await jsonRequest('https://api.smspool.net/request/pricing', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ key: apiKey, service: '457', country }).toString(),
        })
        if (!Array.isArray(data)) return null
        const prices = data.map(row => Number(row.price)).filter(price => Number.isFinite(price) && price > 0)
        return prices.length ? Math.min(...prices) : null
      }
      if (country !== 'US') return null
      const services = await textverifiedRequest('services?numberType=mobile&reservationType=verification')
      const service = Array.isArray(services) && services.find(item =>
        String(item.serviceName || '').toLowerCase() === 'instagram'
        && ['sms', 'smsAndVoiceCombo'].includes(item.capability))
      if (!service) return null
      const data = await textverifiedRequest('pricing/verifications', {
        serviceName: service.serviceName, areaCode: false, carrier: false,
        numberType: 'mobile', capability: 'sms',
      })
      return typeof data.price === 'number' && Number.isFinite(data.price) && data.price > 0 ? data.price : null
    },
    async getOrderStatus(orderId) {
      if (!configured) return { safeToRelease: false, status: 'unavailable' }
      if (provider === 'smspool') return smspool.getOrderStatus(apiKey, orderId)
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(String(orderId))) return { safeToRelease: false, status: 'unavailable' }
      const data = await textverifiedRequest('verifications/' + encodeURIComponent(orderId))
      return {
        safeToRelease: ['verificationCanceled', 'verificationRefunded'].includes(data.state),
        status: String(data.state || 'unavailable'),
      }
    },
  }
}

module.exports = { createSmsProvider }
