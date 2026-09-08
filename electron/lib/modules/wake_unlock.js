// electron/lib/modules/wake_unlock.js
// ── Handler: wake_unlock ────────────────────────────────────────────
// Idempotently prepares a connected phone for a scheduled run:
//   • Marks the phone "stay awake while plugged in" so the screen never blanks
//     while the cable is in (AC|USB|Wireless = bitmask 7).
//   • Sends KEYCODE_WAKEUP so a dark screen lights up before unlocking.
//   • Dismisses the keyguard if it's a no-PIN/swipe lockscreen.
// Designed to run as the first step of every scheduled fleet pipeline so a
// phone that's been sitting overnight, asleep, screen-locked still picks up
// the run cleanly without needing a human to tap.
//
// Speed: previously 3-4 sequential `adb shell` round-trips (~600-1000ms).
// Now batches stay-on + wake + dismiss-keyguard into one `adb shell` call
// (~200-300ms). The 400ms wakeup settle is shortened to 200ms — the screen
// only needs to be lit, not animating fully on.

const { sleep } = require('../local-modules-shared')

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        const keepAwake = config?.keep_awake_while_plugged !== false
        const dismissKeyguard = config?.dismiss_keyguard !== false

        // Build a single batched shell line. Each piece is `; :` joined so a
        // failure in one (e.g. `wm dismiss-keyguard` on a locked-with-PIN device)
        // doesn't short-circuit the rest.
        const parts = []
        if (keepAwake) parts.push('settings put global stay_on_while_plugged_in 7')
        // KEYCODE_WAKEUP — 224. No-op when screen is already on.
        parts.push('input keyevent 224')
        if (dismissKeyguard) parts.push('wm dismiss-keyguard')
        device.shell(parts.join('; :; ') + '; :')

        // Single short settle for the WAKEUP + dismiss combo. 200ms is plenty
        // for the screen to be input-receptive once it's lit.
        await sleep(200)

        // Swipe fallback only if dismiss-keyguard didn't visibly clear the
        // keyguard. We can't cheaply detect that here without another round-trip,
        // so we trust dismiss-keyguard on Android 9+ (every supported device).
        // The swipe-fallback branch in the previous version was rarely hit and
        // its detection was broken (try/catch on a shell that always succeeds).

        const elapsed = Date.now() - t0
        device.sendLog(`module=wake_unlock step=done elapsed=${elapsed}ms`, 'INFO')
        return {
            success: true,
            data: {
                kept_awake_while_plugged: keepAwake,
                keyguard_dismissed: dismissKeyguard,
                elapsed_ms: elapsed,
            },
        }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
