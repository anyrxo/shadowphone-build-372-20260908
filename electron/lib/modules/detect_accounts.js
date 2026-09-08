// electron/lib/modules/detect_accounts.js
// ── Handler: detect_accounts ──────────────────────────────────────
// Opens Instagram's account switcher and returns only verified account rows.
//
// Speed: previously 3000ms launch + 1500ms profile-tap + 1000ms drawer-tap +
// 500ms drawer-wait. Now polls for IG foreground, drops the redundant 500ms
// post-tap wait (getScreen already gates rendering).

const { sleep, parseUiNodes, isInstagramNotificationPermission } = require('../local-modules-shared')
const { parseAccountSwitcher, readProfileUsername } = require('../account-switcher-parser')
const { detectVerificationState, verificationOutcome } = require('./account_insights')

const IG_PKG = 'com.instagram.android'
const PROFILE_TAB_ID = 'com.instagram.android:id/profile_tab'
const ACCOUNT_TOGGLE_ID = 'com.instagram.android:id/action_bar_username_container'

function exactControl(xml, resourceIds, labels = []) {
    const nodes = parseUiNodes(xml).filter(node => node.attrs.enabled !== 'false' && node.attrs.class !== 'android.widget.EditText')
    const idMatch = nodes.find(node => resourceIds.includes(node.attrs['resource-id']))
    const labelMatch = nodes.find(node => [node.attrs.text, node.attrs['content-desc']].some(value =>
        labels.some(label => String(value || '').trim().toLowerCase() === label.toLowerCase())))
    return (idMatch || labelMatch)?.center || null
}

function settingsBack(xml) {
    const nodes = parseUiNodes(xml)
    const knownTitle = nodes.some(node => {
        const label = String(node.attrs.text || node.attrs['content-desc'] || '').trim().toLowerCase()
        return ['settings and activity', 'settings and privacy'].includes(label)
            || (node.attrs['resource-id'] === 'com.instagram.android:id/action_bar_title'
                && ['account status', 'features', "features you can't use", 'monetization', 'content and message removals', 'recommendation eligibility', 'availability to people under 18'].includes(label))
    })
    const statusSearch = nodes.some(node => node.attrs.class === 'android.widget.EditText'
        && String(node.attrs.text || '').toLowerCase() === 'account status')
        && exactControl(xml, [], ['Account Status'])
    return knownTitle || statusSearch
        ? exactControl(xml, ['com.instagram.android:id/action_bar_button_back'], ['Back']) : null
}

function isVerifiedFreshInstagramScreen(xml) {
    const screen = String(xml || '')
    const hasMarker = (marker) => new RegExp(`(?:text|content-desc)="${marker}"`, 'i').test(screen)
    const joinScreen = hasMarker('Join Instagram')
        && hasMarker('Get started')
        && hasMarker('I already have a profile')
    const createScreen = hasMarker('Create new account')
        && ['Log in', 'Log into existing account', 'username, email'].some(hasMarker)
    return joinScreen || createScreen
}

async function verificationBlock(device, xml) {
    const state = detectVerificationState(xml)
    if (!state) return null
    let activeAccount = String(xml || '').match(/(?:text|content-desc)="Confirm you(?:'|’|&#39;|&apos;)re human to use your account,\s*([A-Za-z0-9_.]{1,30})"/i)?.[1]?.toLowerCase() || null
    try {
        const menu = state.type === 'suspended' && device.findElementByContentDesc?.('Menu')
        if (menu) {
            await device.tap(menu.x, menu.y, 500)
            const menuXml = await device.getScreen()
            activeAccount = String(menuXml || '').match(/(?:text|content-desc)="Log out ([A-Za-z0-9_.]{2,30})"/i)?.[1]?.toLowerCase() || null
            await device.back()
        }
    } catch {
        // The blocker itself is authoritative even if its optional menu cannot open.
    }
    return verificationOutcome(state, { verified: false, active_account: activeAccount })
}

async function waitForForeground(device, pkg, timeoutMs = 3000) {
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

async function closeVerifiedSwitcher(device, parsed, activeAccount, t0) {
    if (!parsed.accounts.length) {
        return { success: false, code: 'ACCOUNT_SWITCHER_UNVERIFIED', error: 'Instagram displayed an account switcher without readable account rows. Its account count is unknown.' }
    }
    const active = parsed.active || activeAccount || null
    const accounts = active && !parsed.accounts.includes(active)
        ? [active, ...parsed.accounts]
        : parsed.accounts
    await device.back()
    const elapsed = Date.now() - t0
    device.sendLog(`module=detect_accounts step=done count=${accounts.length} elapsed=${elapsed}ms`, 'INFO')
    return {
        success: true,
        data: {
            accounts,
            count: accounts.length,
            active_account: active,
            verified: true,
            elapsed_ms: elapsed,
        },
    }
}

module.exports = async (device, config = {}) => {
    const t0 = Date.now()
    try {
        device.sendLog('Launching Instagram...', 'INFO')
        device.adb(['shell', 'monkey', '-p', IG_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
        await waitForForeground(device, IG_PKG, 800)

        device.sendLog('Dismissing popups...', 'INFO')
        await device.dismissCommonPopups()

        let initialXml = await device.getScreen()
        if (!initialXml) return { success: false, code: 'SCREEN_UNREADABLE', error: 'Instagram screen could not be read after dismissing popups.' }
        if (isInstagramNotificationPermission(initialXml)) {
            return { success: false, code: 'PERMISSION_DIALOG_BLOCKED', error: 'Instagram notification permission is still blocking account detection.' }
        }
        if (!await waitForForeground(device, IG_PKG, 800)) {
            device.sendLog('Restoring Instagram after popup dismissal...', 'INFO')
            device.adb(['shell', 'monkey', '-p', IG_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
            if (!await waitForForeground(device, IG_PKG)) {
                return { success: false, code: 'INSTAGRAM_NOT_FOREGROUND', error: 'Instagram could not be restored to the foreground for account detection.' }
            }
            initialXml = await device.getScreen()
            if (!initialXml) return { success: false, code: 'SCREEN_UNREADABLE', error: 'Instagram screen could not be read after relaunching.' }
            if (isInstagramNotificationPermission(initialXml)) {
                return { success: false, code: 'PERMISSION_DIALOG_BLOCKED', error: 'Instagram notification permission is still blocking account detection.' }
            }
        }
        device.sendLog('Navigating to profile tab...', 'INFO')
        const initialBlock = await verificationBlock(device, initialXml)
        if (initialBlock) return initialBlock
        if (isVerifiedFreshInstagramScreen(initialXml)) {
            const elapsed = Date.now() - t0
            device.sendLog(`module=detect_accounts step=fresh_profile count=0 elapsed=${elapsed}ms`, 'INFO')
            return {
                success: true,
                data: {
                    accounts: [],
                    count: 0,
                    active_account: null,
                    verified: true,
                    fresh_signup: true,
                    profile_state: 'fresh',
                    elapsed_ms: elapsed,
                },
            }
        }
        const initialSwitcher = parseAccountSwitcher(initialXml || device.currentScreen)
        if (initialSwitcher.verified) {
            device.sendLog('Account switcher is already open; reading it directly...', 'INFO')
            return closeVerifiedSwitcher(device, initialSwitcher, null, t0)
        }
        let profileTab = exactControl(initialXml, [PROFILE_TAB_ID])
        for (let backSteps = 0; !profileTab && !readProfileUsername(initialXml) && backSteps < 4; backSteps++) {
            const back = settingsBack(initialXml)
            if (!back) break
            device.sendLog('Returning from Instagram settings to the profile...', 'INFO')
            await device.tap(back.x, back.y, 450)
            initialXml = await device.getScreen()
            if (!initialXml) return { success: false, code: 'SCREEN_UNREADABLE', error: 'Instagram screen could not be read while returning from settings.' }
            const block = await verificationBlock(device, initialXml)
            if (block) return block
            profileTab = exactControl(initialXml, [PROFILE_TAB_ID])
        }
        let profileXml = initialXml
        if (!readProfileUsername(profileXml)) {
            if (!profileTab) return { success: false, code: 'INSTAGRAM_NAVIGATION_UNVERIFIED', error: 'Instagram is open, but the profile navigation control is unavailable on this page. Open your own Instagram profile to check account capacity.' }
            await device.tap(profileTab.x, profileTab.y, 900)
            profileXml = await device.getScreen()
        }
        if (!profileXml) return { success: false, code: 'SCREEN_UNREADABLE', error: 'Instagram profile screen could not be read.' }
        const profileBlock = await verificationBlock(device, profileXml)
        if (profileBlock) return profileBlock
        const activeAccount = readProfileUsername(profileXml)
        if (!activeAccount) {
            return { success: false, code: 'INSTAGRAM_NAVIGATION_UNVERIFIED', error: 'Instagram did not open the signed-in account profile. Open your own Instagram profile to check account capacity.' }
        }
        profileTab = exactControl(profileXml, [PROFILE_TAB_ID])

        device.sendLog('Opening account switcher...', 'INFO')
        let switcherXml = profileXml
        if (profileTab) {
            device.shell(`input swipe ${profileTab.x} ${profileTab.y} ${profileTab.x} ${profileTab.y} 800`)
            await sleep(400)
            switcherXml = await device.getScreen()
            const longPressBlock = await verificationBlock(device, switcherXml)
            if (longPressBlock) return longPressBlock
        }
        let parsed = parseAccountSwitcher(switcherXml)
        if (!parsed.verified) {
            device.sendLog('Profile-tab switcher unavailable; trying the username menu...', 'INFO')
            if (!readProfileUsername(switcherXml)) {
                const back = settingsBack(switcherXml)
                if (!back) return { success: false, code: 'ACCOUNT_SWITCHER_UNVERIFIED', error: 'Instagram account switcher could not be verified.' }
                await device.tap(back.x, back.y, 250)
                switcherXml = await device.getScreen()
                const backBlock = await verificationBlock(device, switcherXml)
                if (backBlock) return backBlock
            }
            if (readProfileUsername(switcherXml) !== activeAccount) return { success: false, code: 'INSTAGRAM_NAVIGATION_UNVERIFIED', error: 'Instagram left the verified account profile before opening its account list.' }
            const accountToggle = exactControl(switcherXml, [ACCOUNT_TOGGLE_ID, 'com.instagram.android:id/action_bar_title', 'com.instagram.android:id/action_bar_username'])
            if (!accountToggle) return { success: false, code: 'ACCOUNT_SWITCHER_UNVERIFIED', error: 'The verified Instagram profile did not display an account menu control.' }
            await device.tap(accountToggle.x, accountToggle.y, 450)
            switcherXml = await device.getScreen()
            const switcherBlock = await verificationBlock(device, switcherXml)
            if (switcherBlock) return switcherBlock
            parsed = parseAccountSwitcher(switcherXml)
        }
        if (!parsed.verified) {
            await device.back()
            return { success: false, error: 'Instagram account switcher could not be verified.' }
        }

        device.sendLog('Going back...', 'INFO')
        return closeVerifiedSwitcher(device, parsed, activeAccount, t0)
    } catch (error) {
        return { success: false, error: error.message }
    }
}
