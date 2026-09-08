// electron/lib/modules/ig_logout.js
// ── ig_logout ────────────────────────────────────────────────────
// Logs out of the active Instagram account via the in-app Settings > Log out flow.
// Handles save-login-info dialogs and multi-step logout confirmation dialogs.

const { sleep } = require('../local-modules-shared')

const IG_PKG = 'com.instagram.android'

async function waitForForeground(device, pkg, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const fg = device.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
            if (fg && fg.includes(pkg)) return true
        } catch {}
        await sleep(200)
    }
    return false
}

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        device.sendProgress(0, 'Opening Instagram...')
        // Poll for IG foreground vs fixed 1800ms (saves ~600-900ms typical).
        device.adb(['shell', 'monkey', '-p', IG_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
        await waitForForeground(device, IG_PKG)
        await device.dismissCommonPopups()

        device.sendProgress(15, 'Opening profile...')
        await device.getScreen()
        const profileTab = device.findElementByContentDesc('Profile') ||
                           device.findElementByResourceId('com.instagram.android:id/profile_tab')
        if (profileTab) await device.tap(profileTab.x, profileTab.y, 900)
        else await device.tap(1000, 2200, 900)

        device.sendProgress(30, 'Opening settings...')
        await device.getScreen()
        const menuBtn = device.findElementByContentDesc('Options') ||
                        device.findElementByResourceId('com.instagram.android:id/action_bar_overflow_icon')
        if (menuBtn) await device.tap(menuBtn.x, menuBtn.y, 700)
        else await device.tap(1020, 160, 700)

        await device.getScreen()
        const settingsBtn = device.findElementByText('Settings and privacy') ||
                            device.findElementByText('Settings and activity') ||
                            device.findElementByText('Settings')
        if (settingsBtn) await device.tap(settingsBtn.x, settingsBtn.y, 900)

        device.sendProgress(50, 'Scrolling to logout...')

        let logoutBtn = null
        for (let i = 0; i < 8; i++) {
            await device.getScreen()
            logoutBtn = device.findElementByText('Log out all accounts') ||
                        device.findElementByText('Log out')
            if (logoutBtn) break
            await device.scrollDown()
            await device.wait(420)
        }

        device.sendProgress(70, 'Logging out...')
        if (!logoutBtn) {
            await device.getScreen()
            logoutBtn = device.findElementByText('Log out all accounts') ||
                        device.findElementByText('Log out')
        }

        if (!logoutBtn) return { success: false, error: 'Could not find Log out button' }

        await device.tap(logoutBtn.x, logoutBtn.y, 900)
        device.sendProgress(82, 'Confirming logout...')

        const isLoggedOut = (xml) => {
            const lower = (xml || '').toLowerCase()
            return lower.includes('use another profile') ||
                   lower.includes('create new account') ||
                   lower.includes('username, email or mobile number') ||
                   lower.includes('phone number, username or email')
        }

        // Handle save login info + confirm logout dialogs
        for (let attempt = 0; attempt < 10; attempt++) {
            await device.getScreen()
            const lower = (device.currentScreen || '').toLowerCase()

            if (isLoggedOut(device.currentScreen)) {
                const elapsed = Date.now() - t0
                device.sendProgress(100, 'Logged out!')
                device.sendLog(`module=ig_logout step=done elapsed=${elapsed}ms`, 'INFO')
                return { success: true, data: { message: 'Logged out successfully', elapsed_ms: elapsed } }
            }

            let acted = false

            if (lower.includes('save your login info')) {
                const notNow = device.findElementByText('Not now') ||
                               device.findElementByText('Not Now')
                const save = device.findElementByText('Save')
                if (notNow) { await device.tap(notNow.x, notNow.y, 900); acted = true }
                else if (save) { await device.tap(save.x, save.y, 900); acted = true }
            }

            if (!acted && (lower.includes('log out of your account') || lower.includes('log out?'))) {
                // Tap confirm button — try resource IDs first, then text, then lowest match
                const confirm = device.findElementByResourceId('android:id/button1') ||
                                device.findElementByResourceId('com.instagram.android:id/button_positive')
                if (confirm) { await device.tap(confirm.x, confirm.y, 1100); acted = true }
                else {
                    for (const label of ['Log out', 'Log Out', 'LOG OUT']) {
                        const btn = device.findElementByText(label)
                        if (btn) { await device.tap(btn.x, btn.y, 1100); acted = true; break }
                    }
                    if (!acted) {
                        const candidates = [
                            ...device.findAllElementsByText('Log out'),
                            ...device.findAllElementsByText('Log Out'),
                        ]
                        if (candidates.length) {
                            candidates.sort((a, b) => b.y - a.y) // lowest on screen = button, not title
                            await device.tap(candidates[0].x, candidates[0].y, 1100)
                            acted = true
                        }
                    }
                }
            }

            if (!acted && lower.includes('logging out')) {
                await device.wait(900)
                acted = true
            }

            if (!acted) await device.wait(450)
        }

        return { success: false, error: 'Logout flow timed out before reaching logged-out screen' }
    } catch (error) {
        return { success: false, error: `IG logout failed: ${error.message}` }
    }
}
