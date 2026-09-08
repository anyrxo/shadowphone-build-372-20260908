// electron/lib/modules/list_profiles.js
// ── Handler: list_profiles ────────────────────────────────────────────
// Lists all Android user profiles on the device plus the currently active user.
//
// Speed: previously made 2 separate `adb shell` round-trips (~240-500ms).
// Now batches into one shell call (~120-250ms saved per call).

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        const combined = device.shell('pm list users; echo "---CUR---"; am get-current-user')
        const [listSection = '', curSection = ''] = combined.split('---CUR---')

        const profiles = []
        const regex = /UserInfo\{(\d+):([^:]+):/g
        let match
        while ((match = regex.exec(listSection)) !== null) {
            const rawName = match[2]
            profiles.push({ id: match[1], name: (rawName === 'null' && match[1] === '0') ? 'Owner' : rawName })
        }

        const current_user = parseInt(curSection.trim())
        const elapsed = Date.now() - t0
        device.sendLog(`module=list_profiles step=done count=${profiles.length} elapsed=${elapsed}ms`, 'INFO')

        return { success: true, data: { profiles, count: profiles.length, current_user, elapsed_ms: elapsed } }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
