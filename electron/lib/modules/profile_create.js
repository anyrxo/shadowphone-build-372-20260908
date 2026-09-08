// electron/lib/modules/profile_create.js
// ── Handler: profile_create ───────────────────────────────────────────
// Creates a new Android user profile on the device.
// Validates the profile name to prevent shell injection before calling pm create-user.

const { safeProfileName, quoteAndroidShell } = require('../local-modules-shared')

module.exports = async (device, config) => {
    try {
        const raw_name = config.profile_name || config.name || `Profile_${Date.now()}`
        const profile_name = safeProfileName(raw_name)
        if (profile_name === null) {
            return {
                success: false,
                error: `Invalid profile_name. Use letters, digits, space, _, -, . (max 64 chars). Got: ${JSON.stringify(raw_name)}`,
            }
        }

        device.sendLog(`Creating profile: ${profile_name}`, 'INFO')
        // Use single-quote wrapping via quoteAndroidShell so embedded
        // metacharacters survive the on-device sh re-eval. The validator
        // above also blocks the obvious injection patterns, so this is
        // belt-and-braces.
        const output = device.shell(`pm create-user ${quoteAndroidShell(profile_name)}`)

        const match = output.match(/id\s+(\d+)/)
        if (!match) {
            return { success: false, error: `Failed to create profile: ${output}` }
        }

        const profile_id = match[1]
        return { success: true, data: { profile_id, name: profile_name } }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
