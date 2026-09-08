// electron/lib/modules/airplane_toggle.js
// ── Handler: airplane_toggle ────────────────────────────────────────────
// Toggle, enable, disable, or query airplane mode on the device.
// Supports actions: 'toggle', 'on', 'ensure_on', 'off', 'ensure_off', 'status'.
//
// Speed: previously waited a fixed `wait_seconds` (default 5s) after every
// state change. On the Setup row this fires twice (ON then OFF) per phone per
// account, costing 16s wall-clock for ~zero benefit — radio settle on
// GrapheneOS is sub-second for the cmd connectivity path. Default lowered
// to 1.2s (still 2× the observed settle), capped per the action.
//
// `ensure_on` / `ensure_off` now short-circuit (no settle wait) when the
// radio is already in the target state — was previously costing 5s for
// a no-op.

const { sleep } = require('../local-modules-shared')

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        const action = config.action || 'toggle'
        const supportedActions = new Set(['toggle', 'on', 'ensure_on', 'off', 'ensure_off', 'status'])
        if (!supportedActions.has(action)) {
            return { success: false, error: `Unknown action: ${action}` }
        }
        // Default lowered from 5s -> 1.2s. Honor explicit caller overrides.
        // (toggle's OFF-half historically slept a fixed 3s — same logic applies.)
        const wait_seconds = Number(config.wait_seconds ?? 1.2)
        if (!Number.isFinite(wait_seconds) || wait_seconds < 0) {
            return { success: false, error: 'wait_seconds must be a non-negative number' }
        }

        const readStatus = () => device.shell('cmd connectivity airplane-mode').toLowerCase().includes('enabled')
        const wasOn = readStatus()

        let finalIsOn = wasOn
        let waited = 0

        if (action === 'status') {
            const elapsed = Date.now() - t0
            device.sendLog(`module=airplane_toggle step=status elapsed=${elapsed}ms`, 'INFO')
            return { success: true, data: { airplane_mode: wasOn, action, previous: wasOn, elapsed_ms: elapsed } }
        }

        if (action === 'toggle') {
            device.shell('cmd connectivity airplane-mode enable')
            await sleep(wait_seconds * 1000)
            if (!readStatus()) throw new Error('Airplane mode did not enable')
            device.shell('cmd connectivity airplane-mode disable')
            // OFF-half: was fixed 3s; share the same wait knob.
            await sleep(wait_seconds * 1000)
            waited = wait_seconds * 2
            finalIsOn = readStatus()
            if (finalIsOn) throw new Error('Airplane mode did not disable')
        } else if (action === 'on' || action === 'ensure_on') {
            if (!wasOn) {
                device.shell('cmd connectivity airplane-mode enable')
                await sleep(wait_seconds * 1000)
                waited = wait_seconds
            }
            finalIsOn = readStatus()
            if (!finalIsOn) throw new Error('Airplane mode did not enable')
        } else if (action === 'off' || action === 'ensure_off') {
            if (wasOn) {
                device.shell('cmd connectivity airplane-mode disable')
                await sleep(wait_seconds * 1000)
                waited = wait_seconds
            }
            finalIsOn = readStatus()
            if (finalIsOn) throw new Error('Airplane mode did not disable')
        }

        const elapsed = Date.now() - t0
        device.sendLog(`module=airplane_toggle step=${action} waited=${waited}s elapsed=${elapsed}ms`, 'INFO')
        return { success: true, data: { airplane_mode: finalIsOn, action, previous: wasOn, elapsed_ms: elapsed } }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
