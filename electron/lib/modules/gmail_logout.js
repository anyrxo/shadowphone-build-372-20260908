// electron/lib/modules/gmail_logout.js
// ── gmail_logout ─────────────────────────────────────────────────
// Removes a Google/Gmail account from the device via Android Settings > Accounts.
// Requires config.email — the full email address to remove.

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        const email = config.email || ''
        if (!email) return { success: false, error: 'Email is required' }

        device.sendProgress(0, 'Opening Settings...')
        device.shell('am start -a android.settings.SYNC_SETTINGS')
        // Settings activity launch is ~600-1100ms; 2000 was 2x overshoot.
        await device.wait(1100)
        await device.dismissCommonPopups()

        device.sendProgress(20, `Looking for ${email}...`)

        let found = false
        for (let i = 0; i < 5; i++) {
            await device.getScreen()
            const emailEl = device.findElementByText(email) ||
                            device.findElementByText(email.split('@')[0])
            if (emailEl) {
                await device.tap(emailEl.x, emailEl.y, 2000)
                found = true
                break
            }
            await device.scrollDown()
        }

        if (!found) return { success: false, error: `Could not find account: ${email}` }

        device.sendProgress(50, 'Opening account options...')
        await device.getScreen()

        const removeBtn = device.findElementByText('Remove account') ||
                          device.findElementByText('Remove')
        if (removeBtn) {
            await device.tap(removeBtn.x, removeBtn.y, 2000)
            await device.getScreen()
            const confirmBtn = device.findElementByText('Remove account') ||
                               device.findElementByText('Remove') ||
                               device.findElementByText('OK')
            if (confirmBtn) {
                await device.tap(confirmBtn.x, confirmBtn.y, 3000)
            }
            const elapsed = Date.now() - t0
            device.sendProgress(100, `Gmail ${email} removed!`)
            device.sendLog(`module=gmail_logout step=done email=${email} elapsed=${elapsed}ms`, 'INFO')
            return { success: true, data: { email, removed: true, elapsed_ms: elapsed } }
        }

        return { success: false, error: 'Could not find Remove account option' }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
