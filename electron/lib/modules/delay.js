// electron/lib/modules/delay.js
// ── Handler: delay ──────────────────────────────────────────────────
// Waits a fixed number of seconds, reporting progress at most once per second.
//
// Speed note: the wait is the wait — no shortcut there. But the previous
// implementation woke setTimeout every second to report progress even for
// 2-3 second delays, which adds zero value and burns event-loop slots
// across a 30+ phone fleet. For delays ≤3s we now just sleep once and
// report 0 + 100. Longer delays still tick once per second.

const { sleep } = require('../local-modules-shared')

module.exports = async (device, config) => {
    try {
        const seconds = Math.max(0, Number(config.seconds ?? 5))
        if (seconds <= 3) {
            device.sendProgress(0, `Delayed 0s/${seconds}s`)
            await sleep(seconds * 1000)
            device.sendProgress(100, `Delayed ${seconds}s/${seconds}s`)
        } else {
            for (let i = 1; i <= seconds; i++) {
                await sleep(1000)
                device.sendProgress(Math.floor((i / seconds) * 100), `Delayed ${i}s/${seconds}s`)
            }
        }
        return { success: true, data: { waited_seconds: seconds } }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
