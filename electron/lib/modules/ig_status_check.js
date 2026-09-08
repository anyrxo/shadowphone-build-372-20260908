// electron/lib/modules/ig_status_check.js
// ── ig_status_check — Account Status page reader ─────────────────
// Navigates to Instagram's Account Status page and reads the status of
// Categories and detail text must be visible before their status can be reported.

const { sleep, parseUiNodes } = require('../local-modules-shared')
const { readProfileUsername } = require('../account-switcher-parser')
const { detectVerificationState, verificationOutcome } = require('./account_insights')

function normalizeLabel(value) {
    return String(value || '').replace(/[\u2018\u2019]/g, "'").replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&').trim().toLowerCase()
}

function findControl(xml, labels, resourceId) {
    const nodes = parseUiNodes(xml).filter(node => node.attrs.enabled !== 'false' && node.attrs.class !== 'android.widget.EditText')
    const exactId = resourceId && nodes.find(node => node.attrs['resource-id'] === resourceId)
    const matches = nodes.filter(node => labels.some(label =>
        [node.attrs.text, node.attrs['content-desc']].some(value => normalizeLabel(value) === normalizeLabel(label))))
    return (exactId || matches.find(node => node.attrs.clickable === 'true') || matches[0])?.center || null
}

module.exports = async (device, config) => {
    const readScreen = async () => {
        const xml = await device.getScreen()
        const state = detectVerificationState(xml)
        if (state) throw Object.assign(new Error('verification_required'), {
            verificationOutcome: verificationOutcome(state, { action: 'ig_status_check', overall: 'blocked' }),
        })
        return xml
    }
    const STATUS_ITEMS = [
        {
            key: 'removed_content',
            label: 'Removed content and messaging issues',
            aliases: ['Content and message removals'],
            ok: ['not affected right now', 'thank you for following our community'],
            flagged: ['violation', 'issue found', 'you are at risk of losing'],
        },
        {
            key: 'reach_limits',
            label: 'Limits to your reach',
            aliases: ['Recommendation eligibility'],
            ok: ["don't have limits", 'no limits to your account', 'can be recommended'],
            flagged: ['cannot be recommended', 'not available to people under'],
        },
        {
            key: 'features',
            label: "Features you can't use",
            aliases: ['Features'],
            ok: ['can use all instagram features', 'you have access to features'],
            flagged: ['following feature', 'commenting feature', 'going live feature', 'features have been disabled'],
        },
        {
            key: 'monetization',
            label: 'Monetization',
            ok: ['eligible to monetize', 'you can monetize', 'monetization is available'],
            flagged: ['unable to monetize', 'policy violation', 'not eligible', 'ineligible', "you'll need to resolve"],
        },
        {
            key: 'age_limits',
            label: 'Availability to people under 18',
            optional: true,
            ok: [],
            flagged: ['not available to people under 18'],
        },
    ]
    const labelsFor = item => [item.label, ...(item.aliases || [])]
    const visibleText = xml => [...new Set(parseUiNodes(xml).flatMap(node =>
        [node.attrs.text, node.attrs['content-desc']].filter(Boolean)))].join('\n')
    const isStatusOverview = xml => Boolean(findControl(xml, ['Account Status']))
        && STATUS_ITEMS.filter(item => findControl(xml, labelsFor(item))).length >= 2
    const isKnownSettingsScreen = xml => isStatusOverview(xml)
        || Boolean(findControl(xml, ['Settings and activity', 'Settings and privacy']))
        || (Boolean(findControl(xml, ['Account Status'])) && parseUiNodes(xml).some(node =>
            node.attrs.class === 'android.widget.EditText' && normalizeLabel(node.attrs.text) === 'account status'))
        || parseUiNodes(xml).some(node => node.attrs['resource-id'] === 'com.instagram.android:id/action_bar_title'
            && ['Account Status', ...STATUS_ITEMS.flatMap(labelsFor)].some(label => normalizeLabel(node.attrs.text) === normalizeLabel(label)))

    const t0 = Date.now()
    try {
        device.sendProgress(5, 'Launching Instagram...')
        device.adb(['shell', 'am', 'start', '-n', 'com.instagram.android/com.instagram.mainactivity.InstagramMainActivity'])
        // Poll for IG foreground instead of fixed 3s (saves ~1-1.5s typical).
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
            try {
                const fg = device.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
                if (fg && fg.includes('com.instagram.android')) break
            } catch {}
            await sleep(200)
        }

        let initialXml = await readScreen()
        if (!initialXml) return { success: false, error: 'Instagram screen could not be read. Open Instagram and retry Account Status.' }
        await device.dismissCommonPopups()
        initialXml = await readScreen()
        if (!initialXml) return { success: false, error: 'Instagram screen could not be read after dismissing popups. Retry Account Status.' }

        device.sendProgress(15, 'Opening profile tab...')
        let profileTab = findControl(initialXml, ['Profile'], 'com.instagram.android:id/profile_tab')
        for (let backSteps = 0; !profileTab && backSteps < 4; backSteps++) {
            if (!isKnownSettingsScreen(initialXml)) break
            const back = findControl(initialXml, ['Back'], 'com.instagram.android:id/action_bar_button_back')
            if (!back) break
            await device.tap(back.x, back.y, 500)
            initialXml = await readScreen()
            if (!initialXml) return { success: false, error: 'Instagram screen could not be read while returning to your profile. Open your Instagram profile and retry Account Status.' }
            profileTab = findControl(initialXml, ['Profile'], 'com.instagram.android:id/profile_tab')
        }
        if (!profileTab) return { success: false, error: 'Instagram profile tab was not found. Open your own Instagram profile and retry Account Status.' }
        await device.tap(profileTab.x, profileTab.y, 800)

        device.sendProgress(25, 'Opening settings menu...')
        const xml = await readScreen()
        const username = readProfileUsername(xml)
        if (!username) return { success: false, error: 'Could not verify the signed-in Instagram profile. Open your own profile and retry Account Status.' }
        const hamburger = findControl(xml, ['Options', 'Open Menu', 'Menu'], 'com.instagram.android:id/action_bar_menu')
        if (!hamburger) return { success: false, error: 'Instagram profile menu was not found. Open your own profile and retry Account Status.' }
        await device.tap(hamburger.x, hamburger.y, 800)

        device.sendProgress(35, 'Scrolling to Account Status...')
        let statusPos = null
        // Check current screen first before scrolling — saves one full
        // swipe+getScreen cycle (~1100ms) when Account Status is already visible.
        let settingsXml = await readScreen()
        if (!settingsXml) return { success: false, error: 'Instagram settings screen could not be read. Retry Account Status.' }
        statusPos = findControl(settingsXml, ['Account Status'])
        const searchPos = !statusPos && findControl(settingsXml, ['Search'])
        if (searchPos) {
            await device.tap(searchPos.x, searchPos.y, 500)
            settingsXml = await readScreen()
            const searchInput = parseUiNodes(settingsXml).find(node => node.attrs.class === 'android.widget.EditText' && node.attrs.enabled !== 'false')
            if (!searchInput) return { success: false, error: 'Instagram settings search did not open. Open Account Status in Instagram and retry.' }
            await device.tap(searchInput.center.x, searchInput.center.y, 100)
            await device.inputText('Account status')
            await sleep(500)
            settingsXml = await readScreen()
            statusPos = findControl(settingsXml, ['Account Status'])
        }
        for (let i = 0; !statusPos && i < 5; i++) {
            // Tighter swipe settle (700 -> 500) — the menu list scrolls
            // smoothly and renders fast on Graphene.
            await device.swipe(540, 1600, 540, 700, 350, 500)
            settingsXml = await readScreen()
            if (!settingsXml) return { success: false, error: 'Instagram settings screen could not be read. Retry Account Status.' }
            statusPos = findControl(settingsXml, ['Account Status'])
        }
        if (!statusPos) {
            return { success: false, error: "Could not find 'Account Status' in the menu." }
        }

        device.sendProgress(45, 'Opening Account Status page...')
        await device.tap(statusPos.x, statusPos.y, 1500)

        let mainXml = await readScreen()
        if (!isStatusOverview(mainXml)) return { success: false, error: 'The Account Status page could not be verified. Open Account Status in Instagram and retry.' }

        const categories = STATUS_ITEMS.filter(item => !item.optional || findControl(mainXml, labelsFor(item)))
            .map(item => ({ ...item, label: labelsFor(item).find(label => findControl(mainXml, [label])) || item.label }))
        const overviewText = visibleText(mainXml)
        const monetizationWarning = normalizeLabel(overviewText).includes("your activity doesn't follow our monetization policies")

        const items = []
        for (let i = 0; i < categories.length; i++) {
            const category = categories[i]
            const { key, label, ok, flagged } = category
            device.sendProgress(50 + Math.floor(i * 40 / categories.length), `Checking ${label}...`)

            if (key === 'monetization' && monetizationWarning) {
                const detail = normalizeLabel(overviewText).includes('established presence')
                    ? 'Your activity does not follow Instagram monetization policies. Established presence requires review.'
                    : 'Your activity does not follow Instagram monetization policies. Review the affected monetization tools in Instagram.'
                items.push({ key, label, status: 'flagged', detail })
                continue
            }

            if (i > 0) mainXml = await readScreen()
            if (!isStatusOverview(mainXml)) {
                items.push({ key, label, status: 'unknown', reason: 'Account Status overview was not readable after returning from the previous category.' })
                continue
            }
            const pos = findControl(mainXml, labelsFor(category))
            if (!pos) {
                items.push({ key, label, status: 'unknown', reason: 'This category was not displayed on the Account Status page.' })
                continue
            }

            await device.tap(pos.x, pos.y, 1500)
            const subXml = await readScreen()
            const lower = normalizeLabel(visibleText(subXml))
            const stayedOnOverview = isStatusOverview(subXml)

            let status = 'unknown'
            let reason = !subXml ? 'The category screen could not be read.'
                : stayedOnOverview ? 'Instagram stayed on the overview without readable status text. Icon-only indicators could not be verified.'
                    : !findControl(subXml, labelsFor(category)) ? 'Instagram did not show the selected category page.' : null
            if (!reason) {
                for (const sig of flagged) {
                    if (lower.includes(sig)) { status = 'flagged'; break }
                }
                if (status === 'unknown') {
                    for (const sig of ok) {
                        if (lower.includes(sig)) { status = 'ok'; break }
                    }
                }
                if (status === 'unknown') reason = 'Instagram did not show a recognized status for this category.'
            }

            items.push({ key, label, status, ...(reason ? { reason } : {}) })
            if (!stayedOnOverview) {
                await device.back()
                await sleep(500)
            }
        }

        const statuses = items.map(i => i.status)
        // Growth-critical: these 2 determine if posting should be blocked
        const GROWTH_KEYS = new Set(['removed_content', 'reach_limits'])
        const growthItems = items.filter(i => GROWTH_KEYS.has(i.key))
        const growthFlagged = growthItems.some(i => i.status === 'flagged')
        const unknownItems = items.filter(item => item.status === 'unknown')
        const flaggedItems = items.filter(item => item.status === 'flagged')
        const overall = growthFlagged ? 'flagged'
            : unknownItems.length === items.length ? 'unknown'
                : unknownItems.length === 0 && flaggedItems.length === 0 ? 'ok' : 'partial'
        const okCount = statuses.filter(s => s === 'ok').length

        // Return to home. Back-nav animations on IG are ~250-300ms — the
        // 500+400ms sleeps were overshooting. 300+300 is sufficient.
        device.sendProgress(92, 'Returning to home...')
        await device.back()
        await sleep(300)
        await device.back()
        await sleep(300)
        const homeXml = await readScreen()
        const homeTab = findControl(homeXml, ['Home'], 'com.instagram.android:id/feed_tab')
        if (homeTab) await device.tap(homeTab.x, homeTab.y, 500)

        const elapsed = Date.now() - t0
        const warning = flaggedItems.map(item => `${item.label} requires review${item.detail ? `: ${item.detail}` : '.'}`).join(' ')
        const hasIconOnlyStatus = unknownItems.some(item => item.reason.includes('Icon-only'))
        const guidance = hasIconOnlyStatus
            ? 'View these statuses on the phone in Instagram Account Status; their icon-only indicators could not be read.'
            : 'Open Account Status in Instagram and retry.'
        const summary = unknownItems.length
            ? `Account Status incomplete: could not verify ${unknownItems.map(item => item.label).join(', ')}. ${guidance}`
            : `Status check complete — ${items.length}/${items.length} categories verified, ${okCount} OK`
        const message = [warning, summary].filter(Boolean).join(' ')
        device.sendProgress(100, message)
        for (const item of unknownItems) device.sendLog(`${item.label}: ${item.reason}`, 'WARNING')
        device.sendLog(`module=ig_status_check step=done overall=${overall} elapsed=${elapsed}ms`, unknownItems.length ? 'WARNING' : 'INFO')
        return {
            success: unknownItems.length === 0,
            ...(unknownItems.length ? { code: 'ACCOUNT_STATUS_INCOMPLETE', error: message } : {}),
            data: {
                action: 'ig_status_check',
                username,
                overall,
                items,
                checked_at: new Date().toISOString(),
                message,
                elapsed_ms: elapsed,
            },
        }
    } catch (error) {
        if (error.verificationOutcome) return error.verificationOutcome
        return { success: false, error: `Status check failed: ${error.message}` }
    }
}
