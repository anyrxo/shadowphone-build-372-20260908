// Pure selection / rotation / cooldown helpers for bulk account creation.
// No I/O — unit-tested in isolation.

function keyOf(serial, userId) { return serial + '::' + String(userId) }

// Flatten the model registry to qualifying profiles for ONE phone.
// Registry shape: registry.devices[serial].profiles[userId] = { name, accounts:{handle:{}} }
// Qualifying = a profile that needs an account: ZERO IG accounts and NOT the
// device Owner (userId 0). One IG account per GrapheneOS profile, so a profile
// that already has one is "done" (don't create a second).
function qualifyingProfiles(registry, serial) {
  const dev = registry && registry.devices && registry.devices[serial]
  if (!dev || !dev.profiles) return []
  const out = []
  for (const [userId, p] of Object.entries(dev.profiles)) {
    if (String(userId) === '0') continue   // device Owner — never create an account here
    const accountCount = Object.keys((p && p.accounts) || {}).length
    if (accountCount === 0) out.push({ serial, userId: String(userId), name: p.name, accountCount })
  }
  return out
}

function isCooled(entry, now) {
  return !!(entry && entry.cooldownUntil && entry.cooldownUntil > now)
}

// Least-recently-attempted first (never-attempted = 0 => first), skipping cooled.
function pickNextProfile(qualifying, profilesState, now) {
  const eligible = qualifying.filter(p => !isCooled(profilesState[keyOf(p.serial, p.userId)], now))
  if (!eligible.length) return null
  eligible.sort((a, b) => {
    const ea = profilesState[keyOf(a.serial, a.userId)]
    const eb = profilesState[keyOf(b.serial, b.userId)]
    return ((ea && ea.lastAttemptAt) || 0) - ((eb && eb.lastAttemptAt) || 0)
  })
  return eligible[0]
}

// Returns a stop reason string, or null to keep going.
// `pickable` = 1 if a profile can be attempted THIS tick, else 0.
// `opts.cooledRemaining` = how many qualifying profiles exist but are currently
// cooling — so a run that merely cooled everything transiently does NOT report
// the success-implying 'all-qualifying-done' (which makes the operator stop early
// thinking the phone is exhausted). It returns 'all-cooling' instead, a resumable
// state, not a completion.
function nextStopReason(pickable, balance, config, opts) {
  // Unknown balance (fetch flaked / non-2xx / unparseable) must STOP, not proceed:
  // the floor guard is exactly the case we can't afford to disengage and keep
  // buying numbers blind. Distinct reason so it's not conflated with a real floor.
  if (balance == null) return 'balance-unknown'
  if (balance < config.balanceFloor) return 'balance-floor'
  if (pickable === 0) {
    if (opts && opts.cooledRemaining > 0) return 'all-cooling'
    return 'all-qualifying-done'
  }
  return null
}

module.exports = { keyOf, qualifyingProfiles, isCooled, pickNextProfile, nextStopReason }
