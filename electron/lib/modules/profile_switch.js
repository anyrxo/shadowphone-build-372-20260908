// electron/lib/modules/profile_switch.js
// ── Handler: profile_switch ────────────────────────────────────────────
// Switches between Android user profiles on the device.
// Supports actions: 'switch' (default), 'list'.
// When switching: optionally resets IP via airplane mode and completes GrapheneOS setup wizard.

const { sleep, safeUserId, isGrapheneSetupWizardVisible, completeGrapheneSetupWizard } = require('../local-modules-shared')

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        const action = config.action || 'switch'
        const rawTargetProfile = config.target_profile
        const target_profile = rawTargetProfile == null || String(rawTargetProfile).trim() === ''
            ? null
            : safeUserId(rawTargetProfile)
        const reset_ip = config.reset_ip !== false

        if (action === 'switch' && target_profile === null) {
            return {
                success: false,
                error: rawTargetProfile == null || String(rawTargetProfile).trim() === ''
                    ? 'target_profile is required for profile switch'
                    : `Invalid target_profile (must be a non-negative integer): ${JSON.stringify(rawTargetProfile)}`,
            }
        }

        if (action === 'list') {
            // Batch both reads into a single adb shell round-trip
            // (saves ~150-250ms over two separate `device.shell` calls).
            const combined = device.shell('pm list users; echo "---CUR---"; am get-current-user')
            const [listSection = '', curSection = ''] = combined.split('---CUR---')
            const profiles = []
            const regex = /UserInfo\{(\d+):([^:]+):/g
            let match
            while ((match = regex.exec(listSection)) !== null) {
                const rawName = match[2]
                profiles.push({ id: match[1], name: (rawName === 'null' && match[1] === '0') ? 'Owner' : rawName })
            }
            const current_user = parseInt(curSection.trim())
            return { success: true, data: { profiles, count: profiles.length, current_user } }
        }

        if (action === 'switch') {
            let ip_reset = false
            let setup_wizard = null
            const shouldCompleteSetup = config.complete_setup_wizard !== false
            // A brand-new Android user triggers first-boot initialization + setup wizard
            // before am get-current-user reflects the new user. Allow more poll attempts.
            const isNewProfile = config.is_new_profile === true
            if (reset_ip) {
                // Airplane ON + start the switch in a single shell line — the
                // switch-user kernel call doesn't actually need the radio to
                // be off, it just needs to be off before any network reaches
                // the new user's apps. Combining saves ~120-250ms of round-trip
                // and removes the fixed 1200ms settle that was protecting only
                // the (already-fast) airplane state-change.
                device.sendProgress(10, 'Airplane ON + switching...')
                // am start-user FIRST: a secondary GrapheneOS user stopped on reboot
                // sits at State:-1, where `am switch-user` silently no-ops (wrong-account
                // bug). start-user is idempotent for an already-running user.
                device.shell(`cmd connectivity airplane-mode enable; am start-user ${target_profile}; am switch-user ${target_profile}`)
            } else {
                device.sendProgress(35, `Switching to profile ${target_profile}...`)
                device.sendLog(`Switching to user ${target_profile}`, 'INFO')
                // am start-user FIRST (State:-1 stopped-user fix; idempotent if already running).
                device.shell(`am start-user ${target_profile}; am switch-user ${target_profile}`)
            }

            // Poll at 300ms cadence. Existing profiles settle in 4-8s (30 attempts = 9s).
            // A brand-new profile triggers first-boot init which can take 15-30s, so
            // use 80 attempts (24s) to give the new user container time to become active.
            const pollAttempts = isNewProfile ? 80 : 30
            let switched = false
            let current_user = NaN
            for (let attempt = 0; attempt < pollAttempts; attempt++) {
                await sleep(300)
                const currentOutput = device.shell('am get-current-user').trim()
                current_user = parseInt(currentOutput)
                if (current_user === parseInt(target_profile)) {
                    switched = true
                    break
                }
            }

            if (!switched) {
                if (reset_ip) {
                    try { device.shell('cmd connectivity airplane-mode disable') } catch {}
                }
                return {
                    success: false,
                    data: { target: target_profile, current_user, ip_reset },
                    error: `Failed to switch to user ${target_profile}`
                }
            }

            if (shouldCompleteSetup) {
                device.sendProgress(58, 'Checking GrapheneOS setup wizard...')
                setup_wizard = await completeGrapheneSetupWizard(device)
                if (setup_wizard.detected) {
                    device.sendLog(
                        setup_wizard.completed
                            ? `GrapheneOS setup wizard completed (${setup_wizard.steps.join(' > ') || 'no taps needed'})`
                            : `GrapheneOS setup wizard needs attention: ${setup_wizard.reason || 'unknown'}`,
                        setup_wizard.completed ? 'INFO' : 'WARN'
                    )
                }
                // Batch 5 separate `adb shell` calls into one round-trip.
                // Each individual shell was ~120-250ms; consolidating saves
                // ~500-1000ms per profile switch.
                try {
                    device.shell([
                        'settings put secure user_setup_complete 1',
                        'settings put secure location_mode 0',
                        'am force-stop org.grapheneos.setupwizard',
                        'am force-stop app.grapheneos.setupwizard',
                        'am force-stop com.google.android.setupwizard',
                    ].join('; :; ') + '; :')
                } catch {}
                try { await device.home() } catch {}

                setup_wizard = {
                    ...setup_wizard,
                    completed: !(await isGrapheneSetupWizardVisible(device)),
                    verified_after_bypass: true,
                }
                if (setup_wizard.completed) setup_wizard.reason = null
                if (!setup_wizard.completed) {
                    if (reset_ip) {
                        try { device.shell('cmd connectivity airplane-mode disable') } catch {}
                    }
                    return {
                        success: false,
                        data: { target: target_profile, current_user, ip_reset, setup_wizard },
                        error: `Profile ${target_profile} switched, but GrapheneOS setup wizard is still visible`
                    }
                }
            }

            if (reset_ip) {
                // Airplane OFF + final user verify in one round-trip. Drop the
                // fixed 1200ms — the radio coming back is detectable downstream
                // by vpn_connect's own polling loop. Keep a small 400ms gate so
                // any next step sees the airplane state already updated.
                device.sendProgress(70, 'Airplane OFF (fresh IP)...')
                const combined = device.shell('cmd connectivity airplane-mode disable; echo "---CUR---"; am get-current-user')
                const curSection = combined.split('---CUR---')[1] || ''
                current_user = parseInt(curSection.trim())
                await sleep(400)
                ip_reset = true
            } else {
                const currentOutput = device.shell('am get-current-user').trim()
                current_user = parseInt(currentOutput)
            }

            const success = current_user === parseInt(target_profile)
            const elapsed = Date.now() - t0
            device.sendLog(`module=profile_switch step=done target=${target_profile} elapsed=${elapsed}ms`, 'INFO')

            return {
                success,
                data: { target: target_profile, current_user, ip_reset, setup_wizard, elapsed_ms: elapsed },
                error: success ? null : `Failed to switch to user ${target_profile}`
            }
        }

        return { success: false, error: `Unknown action: ${action}` }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
