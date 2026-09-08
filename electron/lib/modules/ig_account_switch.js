// electron/lib/modules/ig_account_switch.js
// ── Handler: ig_account_switch ────────────────────────────────────
// Switches the active Instagram account via the in-app account switcher.
// Requires an exact username so callers can prove the foreground account.
//
// Speed: previously fixed 3000ms launch + 1500ms profile-tap + 1000ms drawer-tap
// + 500ms + 1500ms target-tap. Tap waits cut to the minimum that still lets IG
// render the next screen (profile transitions are ~600-900ms typical).

const { sleep } = require('../local-modules-shared')
const { parseNodes } = require('./account_insights')

const IG_PKG = 'com.instagram.android'
const PROFILE_TAB = { x: 972, y: 2274 }
const PROFILE_TAB_ID = 'com.instagram.android:id/profile_tab'

function normalizeUsername(value) {
    const username = String(value ?? '').trim().replace(/^@+/, '').toLowerCase()
    return /^[a-z0-9._]{1,30}$/.test(username) ? username : ''
}

function readActiveUsername(xml) {
    const nodes = parseNodes(xml || '')
    const profileReady = nodes.some(node => (
        (node.k === 'text' && (node.t === 'Edit profile' || node.t === 'Share profile'))
        || (node.k === 'content-desc' && node.t.toLowerCase().includes('professional dashboard entry point'))
    ))
    if (!profileReady) return null

    const handle = nodes.find(node => (
        node.k === 'text'
        && node.y1 < 210
        && node.cx > 300
        && node.cx < 780
        && /^[a-zA-Z0-9_.]{1,30}$/.test(node.t)
    ))
    return handle ? normalizeUsername(handle.t) || null : null
}

async function waitForActiveUsername(device) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const xml = await device.getScreen()
        const username = readActiveUsername(xml || device.currentScreen)
        if (username) return username
        if (attempt < 5) await sleep(300)
    }
    return null
}

function findExactUsernameElement(device, targetUsername) {
    const exact = (device.findElementByExactText && device.findElementByExactText(targetUsername))
        || (device.findElementByExactContentDesc && device.findElementByExactContentDesc(targetUsername))
    if (exact) return exact

    const nodes = parseNodes(device.currentScreen || '')
    const target = nodes.find(node => (
        (node.k === 'text' || node.k === 'content-desc')
        && normalizeUsername(node.t) === targetUsername
    ))
    return target ? { x: target.cx, y: target.cy } : null
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

async function dismissPreForegroundInstagramPermission(device) {
    await device.getScreen()
    const xml = String(device.currentScreen || '')
    const low = xml.toLowerCase().replace(/[’‘]/g, "'")
    if (!low.includes('permissioncontroller') || !low.includes('instagram') || !low.includes('notifications')) {
        return false
    }
    const deny = (device.findElementByExactText && (
        device.findElementByExactText("Don't allow")
        || device.findElementByExactText('Don’t allow')
    )) || (device.findElementByText && (
        device.findElementByText("Don't allow")
        || device.findElementByText('Don’t allow')
    ))
    if (!deny) return false
    await device.tap(deny.x, deny.y, 500)
    return true
}

function isVerificationRequired(device) {
    const xml = String(device.currentScreen || '')
        .toLowerCase()
        .replace(/[’‘]/g, "'")
    let focus = ''
    try {
        focus = device.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
    } catch {}
    return /challengeactivity/i.test(String(focus || ''))
        || xml.includes("confirm you're human")
        || xml.includes('confirm you are human')
        || xml.includes('challenge required')
        || xml.includes("confirm it's you")
        || xml.includes('help us confirm')
        || xml.includes('verify your identity')
}

function verificationFailure(targetUsername, stage) {
    return {
        success: false,
        error: 'verification_required',
        code: 'verification_required',
        data: {
            verification_required: true,
            target_username: targetUsername,
            stage,
        },
    }
}

module.exports = async (device, config = {}) => {
    const t0 = Date.now()
    try {
        const configuredUsername = [config.username, config.account_username, config.target_username]
            .find(value => String(value ?? '').trim())
        const targetUsername = normalizeUsername(configuredUsername)
        if (!targetUsername) {
            return { success: false, error: 'An exact target username is required for Instagram account switching.' }
        }

        device.sendLog('Launching Instagram...', 'INFO')
        // Skip the fixed 3s — poll for foreground instead. Saves ~1-1.5s typical.
        device.adb(['shell', 'monkey', '-p', IG_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
        let foreground = await waitForForeground(device, IG_PKG, 800)
        if (!foreground && await dismissPreForegroundInstagramPermission(device)) {
            device.sendLog('Dismissed Android notification permission; relaunching Instagram...', 'INFO')
            device.adb(['shell', 'monkey', '-p', IG_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
            foreground = await waitForForeground(device, IG_PKG, 5000)
        }
        if (!foreground) {
            return { success: false, error: 'Instagram foreground could not be verified before account switching.' }
        }

        await device.getScreen()
        if (isVerificationRequired(device)) {
            return verificationFailure(targetUsername, 'before_popup_dismissal')
        }

        device.sendLog('Dismissing popups...', 'INFO')
        await device.dismissCommonPopups()

        await device.getScreen()
        if (isVerificationRequired(device)) {
            return verificationFailure(targetUsername, 'before_profile_navigation')
        }

        device.sendLog('Navigating to profile tab...', 'INFO')
        const initialProfileTab = device.findElementByResourceId(PROFILE_TAB_ID)
        if (!initialProfileTab) {
            return { success: false, error: 'Could not find the exact Instagram profile tab before account switching.' }
        }
        await device.tap(initialProfileTab.x, initialProfileTab.y, 900)

        const activeBefore = await waitForActiveUsername(device)
        if (isVerificationRequired(device)) {
            return verificationFailure(targetUsername, 'before_switcher_open')
        }
        if (!activeBefore) {
            return { success: false, error: 'Could not verify the active Instagram account before switching.' }
        }
        if (activeBefore === targetUsername) {
            device.sendLog('Dismissing popups after the active profile loaded...', 'INFO')
            await device.dismissCommonPopups()
            await device.getScreen()
            if (isVerificationRequired(device)) {
                return verificationFailure(targetUsername, 'after_active_profile_popup_dismissal')
            }
            const activeConfirmed = await waitForActiveUsername(device)
            if (activeConfirmed !== targetUsername) {
                return {
                    success: false,
                    error: `Instagram account verification changed after popup handling: expected @${targetUsername}, found @${activeConfirmed || 'unknown'}.`,
                }
            }
            const elapsed = Date.now() - t0
            device.sendLog(`module=ig_account_switch step=done active=@${targetUsername} switched=false elapsed=${elapsed}ms`, 'INFO')
            return {
                success: true,
                data: {
                    target_username: targetUsername,
                    active_username: activeBefore,
                    switched: false,
                    verified: true,
                    elapsed_ms: elapsed,
                },
            }
        }

        device.sendLog('Opening account switcher...', 'INFO')
        device.shell(`input swipe ${PROFILE_TAB.x} ${PROFILE_TAB.y} ${PROFILE_TAB.x} ${PROFILE_TAB.y} 800`)
        await sleep(400)
        await device.getScreen()

        const userEl = findExactUsernameElement(device, targetUsername)
        if (!userEl) {
            await device.back()
            return { success: false, error: `Username not found in account switcher: @${targetUsername}` }
        }
        await device.tap(userEl.x, userEl.y, 1200)

        await device.getScreen()
        if (isVerificationRequired(device)) {
            return verificationFailure(targetUsername, 'after_target_selection')
        }

        device.sendLog('Dismissing popups after switch...', 'INFO')
        await device.dismissCommonPopups()

        await device.getScreen()
        if (isVerificationRequired(device)) {
            return verificationFailure(targetUsername, 'after_popup_dismissal')
        }

        let activeAfter = readActiveUsername(device.currentScreen)
        if (!activeAfter) {
            const profileTab = device.findElementByResourceId(PROFILE_TAB_ID)
            if (!profileTab) {
                return { success: false, error: `Could not find the exact Instagram profile tab after switching to @${targetUsername}.` }
            }
            device.sendLog('Opening the active profile for exact verification...', 'INFO')
            await device.tap(profileTab.x, profileTab.y, 900)
            activeAfter = await waitForActiveUsername(device)
        }
        if (isVerificationRequired(device)) {
            return verificationFailure(targetUsername, 'before_final_verification')
        }
        if (!activeAfter) {
            return { success: false, error: `Could not verify the active Instagram account after switching to @${targetUsername}.` }
        }
        if (activeAfter !== targetUsername) {
            return {
                success: false,
                error: `Instagram account switch verification failed: expected @${targetUsername}, found @${activeAfter}.`,
            }
        }

        const elapsed = Date.now() - t0
        device.sendLog(`module=ig_account_switch step=done active=@${activeAfter} switched=true elapsed=${elapsed}ms`, 'INFO')
        return {
            success: true,
            data: {
                target_username: targetUsername,
                active_username: activeAfter,
                switched: true,
                verified: true,
                elapsed_ms: elapsed,
            },
        }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
