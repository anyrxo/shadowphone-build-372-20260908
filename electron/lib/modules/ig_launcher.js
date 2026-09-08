// electron/lib/modules/ig_launcher.js
// ── Handler: ig_launcher ──────────────────────────────────────────
// Launches Instagram, dismisses common popups, and confirms the app is open.
//
// Speed: previously fixed 3000ms wait after launchApp, then a second wait
// via dismissCommonPopups's per-popup getScreen calls. Now polls for the
// IG foreground process every 200ms with a 3s ceiling — typical cold-launch
// is 1.2-2s on Graphene, so we save 1-1.8s most runs without weakening the
// detection (we re-confirm with a getScreen + textOnScreen check).

const { sleep } = require('../local-modules-shared')

const IG_PKG = 'com.instagram.android'
const LAUNCH_TIMEOUT_MS = 3000
const LAUNCH_POLL_MS = 200

async function waitForForeground(device, pkg) {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    while (Date.now() < deadline) {
        try {
            const fg = device.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
            if (fg && fg.includes(pkg)) return true
        } catch { /* keep polling */ }
        await sleep(LAUNCH_POLL_MS)
    }
    return false
}

function isVerificationRequired(device, focus) {
    const xml = String(device.currentScreen || '').toLowerCase().replace(/’/g, "'").replace(/‘/g, "'")
    return /challengeactivity/i.test(String(focus || ''))
        || xml.includes("confirm you're human")
        || xml.includes('confirm you are human')
}

function isHomeScreen(device) {
    const xml = String(device.currentScreen || '')
    const selectedHomeTab = /<node\b(?=[^>]*(?:resource-id="com\.instagram\.android:id\/feed_tab"|content-desc="[^"]*Home[^"]*"))(?=[^>]*selected="true")[^>]*>/i.test(xml)
    const selectedOtherTab = /<node\b(?=[^>]*resource-id="com\.instagram\.android:id\/(?:clips|search|profile)_tab")(?=[^>]*selected="true")[^>]*>/i.test(xml)
    const explicitHomeFeedSurface = /content-desc="Instagram Home Feed"/i.test(xml)
    const homeFeedEvidence = /content-desc="[^"]*Instagram Home Feed[^"]*"/i.test(xml)
        || xml.includes('com.instagram.android:id/row_feed_view_group_buttons')
        || device.textOnScreen('Your story')
    return !selectedOtherTab && homeFeedEvidence && (selectedHomeTab || explicitHomeFeedSurface)
}

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        device.sendLog('Launching Instagram...', 'INFO')
        if (config.cold_launch === true) {
            device.adb(['shell', 'am', 'force-stop', IG_PKG])
            await sleep(300)
        }
        // Fire the launch without the 3000ms blocking wait
        device.adb(['shell', 'monkey', '-p', IG_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
        // Poll for foreground (most launches settle in ~1-2s, saves ~1-2s)
        const foreground = await waitForForeground(device, IG_PKG)
        if (!foreground) {
            return { success: false, error: 'instagram_foreground_not_verified' }
        }

        await device.getScreen()
        let focus = device.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
        if (isVerificationRequired(device, focus)) {
            return {
                success: false,
                error: 'verification_required',
                code: 'verification_required',
                data: { verification_required: true, on_instagram: true, on_home: false },
            }
        }

        device.sendLog('Dismissing common popups...', 'INFO')
        const popups_dismissed = await device.dismissCommonPopups()

        await device.getScreen()
        focus = device.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
        if (isVerificationRequired(device, focus)) {
            return {
                success: false,
                error: 'verification_required',
                code: 'verification_required',
                data: { verification_required: true, on_instagram: true, on_home: false, popups_dismissed },
            }
        }
        const on_instagram = device.textOnScreen('Your story') ||
                             device.textOnScreen('Instagram') ||
                             device.textOnScreen('Reels') ||
                             device.textOnScreen('Home')
        const on_home = isHomeScreen(device)

        if (!on_instagram || (config.require_home === true && !on_home)) {
            return {
                success: false,
                error: on_instagram ? 'instagram_home_not_verified' : 'instagram_surface_not_verified',
                data: { on_instagram, on_home, verification_required: false, popups_dismissed },
            }
        }

        const elapsed = Date.now() - t0
        device.sendLog(`module=ig_launcher step=done on_ig=${on_instagram} elapsed=${elapsed}ms`, 'INFO')
        return { success: true, data: { on_instagram, on_home, verification_required: false, popups_dismissed, elapsed_ms: elapsed } }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
