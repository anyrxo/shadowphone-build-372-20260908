// electron/lib/modules/random_delay.js
// ── Handler: random_delay ───────────────────────────────────────────
// Waits a random number of seconds between min_seconds and max_seconds.
// Anti-detection jitter — DO NOT cap or shorten the chosen duration.
//
// Speed note: same as delay.js — for ≤3s waits, skip the per-second
// progress loop and sleep once.

const { sleep } = require('../local-modules-shared')

module.exports = async (device, config) => {
    try {
        const min_seconds = Math.max(0, Number(config.min_seconds ?? 3))
        const max_seconds = Math.max(min_seconds, Number(config.max_seconds ?? 10))
        const seconds = Math.floor(Math.random() * (max_seconds - min_seconds + 1)) + min_seconds

        if (seconds <= 3) {
            device.sendProgress(0, `Random delay 0s/${seconds}s`)
            await sleep(seconds * 1000)
            device.sendProgress(100, `Random delay ${seconds}s/${seconds}s`)
        } else {
            for (let i = 1; i <= seconds; i++) {
                await sleep(1000)
                device.sendProgress(Math.floor((i / seconds) * 100), `Random delay ${i}s/${seconds}s`)
            }
        }
        return { success: true, data: { waited_seconds: seconds, min: min_seconds, max: max_seconds } }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
