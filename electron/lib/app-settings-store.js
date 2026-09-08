const fs = require('node:fs')
const path = require('node:path')

const SECRET_SETTINGS = new Set(['smspool_api_key', 'textverified_api_key', 'textverified_api_username'])
const PUBLIC_SETTINGS = new Set([
  'react_dashboard',
  'scrcpy_quality',
  'usb_vps_allowed_ips',
  'usb_vps_allowed_node_ids',
  'usb_vps_bridge',
  'usb_vps_required_tags',
])

function createAppSettingsStore({ settingsPath, safeStorage }) {
  function readSettings() {
    if (!fs.existsSync(settingsPath)) return {}
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
        throw new SyntaxError('Settings file must contain an object')
      }
      return settings
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      const corruptPath = `${settingsPath}.corrupt-${Date.now()}`
      fs.renameSync(settingsPath, corruptPath)
      try { fs.chmodSync(corruptPath, 0o600) } catch {}
      console.warn(`[Settings] Quarantined malformed settings file: ${corruptPath}`)
      return {}
    }
  }

  function writeSettings(settings) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2))
      fs.renameSync(temporaryPath, settingsPath)
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
    }
  }

  function assertSecretSetting(key) {
    if (!SECRET_SETTINGS.has(key)) {
      throw new Error(`Unsupported secret setting: ${key}`)
    }
  }

  function assertPublicSetting(key) {
    if (!PUBLIC_SETTINGS.has(key)) {
      throw new Error(`Unsupported public setting: ${key}`)
    }
  }

  function assertEncryptionAvailable() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable')
    }
  }

  function encryptSecret(value) {
    assertEncryptionAvailable()
    return safeStorage.encryptString(value).toString('base64')
  }

  function secretBucket(settings, userId) {
    // Legacy access remains explicit for migration tooling, never authenticated IPC.
    if (userId === undefined) return settings
    if (typeof userId !== 'string' || !userId.trim() || userId.length > 256
      || ['__proto__', 'constructor', 'prototype'].includes(userId)) {
      throw new Error('A valid signed-in user is required for provider settings')
    }
    const scopedKey = `user:${userId}`
    if (!settings.user_secrets) settings.user_secrets = {}
    if (!Object.hasOwn(settings.user_secrets, scopedKey)) settings.user_secrets[scopedKey] = {}
    return settings.user_secrets[scopedKey]
  }

  function getSecret(key, userId) {
    assertSecretSetting(key)
    const settings = readSettings()
    const secrets = secretBucket(settings, userId)
    const encryptedKey = `${key}_encrypted`

    if (typeof secrets[encryptedKey] === 'string' && secrets[encryptedKey]) {
      assertEncryptionAvailable()
      return safeStorage
        .decryptString(Buffer.from(secrets[encryptedKey], 'base64'))
    }

    if (typeof secrets[key] === 'string' && secrets[key]) {
      const plaintext = secrets[key]
      secrets[encryptedKey] = encryptSecret(plaintext)
      delete secrets[key]
      writeSettings(settings)
      return plaintext
    }

    return ''
  }

  function setSecret(key, value, userId) {
    assertSecretSetting(key)
    const settings = readSettings()
    const secrets = secretBucket(settings, userId)
    secrets[`${key}_encrypted`] = encryptSecret(value)
    delete secrets[key]
    writeSettings(settings)
  }

  function clearSecret(key, userId) {
    assertSecretSetting(key)
    const settings = readSettings()
    const secrets = secretBucket(settings, userId)
    delete secrets[key]
    delete secrets[`${key}_encrypted`]
    writeSettings(settings)
  }

  function getPublicSetting(key) {
    assertPublicSetting(key)
    return readSettings()[key]
  }

  function setPublicSetting(key, value) {
    assertPublicSetting(key)
    const settings = readSettings()
    settings[key] = value
    writeSettings(settings)
  }

  function getRendererSetting(key, userId) {
    if (SECRET_SETTINGS.has(key)) {
      return { configured: Boolean(getSecret(key, userId)) }
    }
    return getPublicSetting(key)
  }

  return {
    clearSecret,
    getPublicSetting,
    getRendererSetting,
    getSecret,
    setPublicSetting,
    setSecret,
  }
}

module.exports = {
  createAppSettingsStore,
}
