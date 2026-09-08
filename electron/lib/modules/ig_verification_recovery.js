const { LocalDevice } = require('../local-modules-shared')
const airplaneToggle = require('./airplane_toggle')
const profileSwitch = require('./profile_switch')
const igLauncher = require('./ig_launcher')

function requireSuccess(result, step) {
    if (!result?.success) {
        throw new Error(`${step}: ${result?.error || 'failed'}`)
    }
    return result
}

async function recoverInstagramVerification(options = {}, overrides = {}) {
    const serial = String(options.serial || '').trim()
    if (!serial) return { success: false, error: 'serial_required' }

    const targetProfile = String(options.targetProfile ?? '').trim()
    if (!/^\d+$/.test(targetProfile)) {
        return {
            success: false,
            error: targetProfile ? 'target_profile_invalid' : 'target_profile_required',
        }
    }

    const deps = {
        createDevice: (deviceSerial) => new LocalDevice(deviceSerial),
        airplaneToggle,
        profileSwitch,
        igLauncher,
        ...overrides,
    }
    const device = deps.createDevice(serial)
    let airplaneMayBeOn = false
    let result

    try {
        airplaneMayBeOn = true
        requireSuccess(
            await deps.airplaneToggle(device, { action: 'ensure_on' }),
            'airplane_on',
        )
        const onStatus = requireSuccess(
            await deps.airplaneToggle(device, { action: 'status' }),
            'airplane_on_status',
        )
        if (onStatus.data?.airplane_mode !== true) {
            throw new Error('airplane_on_not_verified')
        }

        requireSuccess(
            await deps.profileSwitch(device, {
                action: 'switch',
                target_profile: targetProfile,
                reset_ip: false,
                complete_setup_wizard: options.completeSetupWizard !== false,
            }),
            'profile_switch',
        )
        const activeUser = String(device.shell('am get-current-user') || '').trim()
        if (activeUser !== targetProfile) {
            throw new Error(`profile_switch_not_verified: expected ${targetProfile}, got ${activeUser || 'unknown'}`)
        }

        requireSuccess(
            await deps.airplaneToggle(device, { action: 'ensure_off' }),
            'airplane_off',
        )
        const offStatus = requireSuccess(
            await deps.airplaneToggle(device, { action: 'status' }),
            'airplane_off_status',
        )
        if (offStatus.data?.airplane_mode !== false) {
            throw new Error('airplane_off_not_verified')
        }
        airplaneMayBeOn = false

        const launch = requireSuccess(
            await deps.igLauncher(device, { cold_launch: true, require_home: true }),
            'instagram_launch',
        )
        if (!launch.data?.on_instagram || !launch.data?.on_home || launch.data?.verification_required) {
            throw new Error('instagram_safe_home_not_verified')
        }

        result = {
            success: true,
            data: {
                serial,
                target_profile: targetProfile,
                current_user: activeUser,
                recovery: 'completed',
            },
        }
    } catch (error) {
        result = { success: false, error: error.message, data: { serial, target_profile: targetProfile } }
    } finally {
        if (airplaneMayBeOn) {
            try {
                requireSuccess(
                    await deps.airplaneToggle(device, { action: 'ensure_off' }),
                    'airplane_cleanup',
                )
                const cleanupStatus = requireSuccess(
                    await deps.airplaneToggle(device, { action: 'status' }),
                    'airplane_cleanup_status',
                )
                if (cleanupStatus.data?.airplane_mode !== false) {
                    throw new Error('airplane_cleanup_not_verified')
                }
            } catch (cleanupError) {
                result = {
                    success: false,
                    error: `${result?.error || 'recovery_failed'}; ${cleanupError.message}`,
                    data: { serial, target_profile: targetProfile, airplane_cleanup_failed: true },
                }
            }
        }
    }

    return result
}

async function run(device, config = {}) {
    return recoverInstagramVerification({
        serial: device?.deviceId,
        targetProfile: config.target_profile ?? config.targetProfile,
        completeSetupWizard: config.complete_setup_wizard,
    }, {
        createDevice: () => device,
    })
}

module.exports = run
module.exports.recoverInstagramVerification = recoverInstagramVerification
