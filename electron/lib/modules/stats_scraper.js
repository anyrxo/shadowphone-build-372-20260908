// electron/lib/modules/stats_scraper.js
// ── stats_scraper ────────────────────────────────────────────────
// Scrapes follower/following/post counts from an Instagram profile screen.
// If config.target_username is set, searches for that user first.
// Otherwise navigates to the currently logged-in account's profile.
// Queues the result into the pending snapshots buffer for Supabase flush.

const { parseStatsFromXml, queueStatsSnapshot, sleep } = require('../local-modules-shared')

const IG_PKG = 'com.instagram.android'

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

module.exports = async (device, config) => {
    const t0 = Date.now()
    const targetUsername = (config.target_username || '').trim()

    try {
        device.sendProgress(0, 'Opening Instagram...')
        // Poll for IG foreground instead of fixed 3s. Saves ~1-1.5s typical.
        device.adb(['shell', 'monkey', '-p', IG_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
        await waitForForeground(device, IG_PKG)
        await device.dismissCommonPopups()

        if (targetUsername) {
            // Search for target user
            device.sendProgress(20, `Searching for @${targetUsername}...`)
            await device.getScreen()
            const searchTab = device.findElementByContentDesc('Search and Explore') ||
                              device.findElementByContentDesc('Search')
            // 2000 -> 1100 post-tap (Search tab transition is ~700-1000ms)
            if (searchTab) await device.tap(searchTab.x, searchTab.y, 1100)
            else await device.tap(324, 2274, 1100)

            await device.getScreen()
            const searchBar = device.findElementByResourceId('com.instagram.android:id/action_bar_search_edit_text')
            if (searchBar) {
                await device.tap(searchBar.x, searchBar.y, 600)
                await device.inputText(targetUsername)
                // 2000 -> 1200; IG's search autocomplete fires keystroke-by-keystroke
                // so the first results land within ~800-1200ms.
                await device.wait(1200)
            }

            // Tap first result. Profile load needs the full wait — keep 2000.
            await device.tap(540, 500, 2000)
        } else {
            // Navigate to own profile. Profile-tab transition ~700-1000ms.
            device.sendProgress(20, 'Going to profile...')
            await device.tap(972, 2274, 1200)
        }

        device.sendProgress(50, 'Reading stats...')
        await device.getScreen()

        // Try to detect the username from the profile screen if not provided
        let resolvedUsername = targetUsername
        if (!resolvedUsername && device.currentScreen) {
            const xml = device.currentScreen
            // Method 1: Profile picture content-desc (e.g. "username's profile picture")
            let um = xml.match(/content-desc="([a-zA-Z0-9_.]{2,30})'s profile picture"/i)
            // Method 2: Action bar title resource-id
            if (!um) um = xml.match(/text="([a-zA-Z0-9_.]{2,30})"[^>]*resource-id="com\.instagram\.android:id\/action_bar_title"/i)
                || xml.match(/resource-id="com\.instagram\.android:id\/action_bar_title"[^>]*text="([a-zA-Z0-9_.]{2,30})"/i)
            // Method 3: Scan full XML for username-like text elements.
            // The username on IG profile appears as a standalone text node that looks like
            // a valid IG handle (2-30 chars, only a-z 0-9 . _), near the top of the screen.
            if (!um) {
                const uiLabels = new Set(['Create', 'Home', 'Search', 'Reels', 'Profile', 'Share',
                    'posts', 'post', 'followers', 'following', 'friends', 'Edit', 'Threads',
                    'Explore', 'Messages', 'Settings', 'Share', 'Notifications', 'Activity',
                    'Instagram', 'Camera', 'Your story', 'Discover', 'Switch', 'Log',
                    'Not Now', 'Not now', 'OK', 'Cancel', 'Skip', 'Done', 'Next', 'Back',
                    'null', 'Owner', 'Dismiss'])
                const candidates = []
                const re = /text="([a-zA-Z][a-zA-Z0-9_.]{1,29})"[^>]*bounds="\[(\d+),(\d+)\]/g
                let m
                while ((m = re.exec(xml)) !== null) {
                    const val = m[1]
                    const y = parseInt(m[3])
                    // Must be in the top half of screen (y < 1200) and not a UI label
                    if (y < 1200 && !uiLabels.has(val) && val.length >= 3) {
                        candidates.push({ val, y })
                    }
                }
                // Pick the topmost username-like text
                if (candidates.length > 0) {
                    candidates.sort((a, b) => a.y - b.y)
                    um = [null, candidates[0].val]
                }
            }
            if (um) resolvedUsername = um[1]
        }

        const parsed = parseStatsFromXml(device.currentScreen)
        const stats = {
            username: resolvedUsername || 'current',
            followers: parsed?.followers || null,
            following: parsed?.following || null,
            posts: parsed?.posts || null,
        }

        // Queue for Supabase flush (passive analytics capture)
        if (parsed && stats.username && stats.username !== 'current') {
            queueStatsSnapshot(stats.username, parsed, device.deviceId, {
                profile_id: config.profile_id ?? null,
                run_id: config.run_id ?? null,
                module_id: config.module_id ?? 'stats_scraper',
            })
        }

        const elapsed = Date.now() - t0
        device.sendProgress(100, 'Stats scraped!')
        device.sendLog(`module=stats_scraper step=done user=${stats.username} elapsed=${elapsed}ms`, 'INFO')
        return { success: true, data: { ...stats, elapsed_ms: elapsed } }
    } catch (error) {
        return { success: false, error: `Stats scraper failed: ${error.message}` }
    }
}
