// electron/lib/modules/profile_delete.js
// ── Handler: profile_delete ───────────────────────────────────────────
// Deletes an Android user profile from the device.
// Refuses to delete the owner profile (user 0).
// Validates profile_id to prevent shell injection before calling pm remove-user.

const { safeUserId } = require('../local-modules-shared')

module.exports = async (device, config) => {
    try {
        const rawProfileId = config.profile_id || config.target_profile

        if (!rawProfileId) {
            return { success: false, error: 'profile_id or target_profile is required' }
        }

        const profile_id = safeUserId(rawProfileId)
        if (profile_id === null) {
            return { success: false, error: `Invalid profile_id (must be a non-negative integer): ${JSON.stringify(rawProfileId)}` }
        }

        if (profile_id === '0') {
            return { success: false, error: 'Cannot delete owner profile (user 0)' }
        }

        device.sendLog(`Deleting profile ${profile_id}`, 'INFO')
        const output = device.shell(`pm remove-user ${profile_id}`)

        return { success: true, data: { profile_id, output } }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
