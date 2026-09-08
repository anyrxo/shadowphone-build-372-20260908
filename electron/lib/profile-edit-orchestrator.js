'use strict'

const { normalizeHandle } = require('./account-switcher-parser')

function isOk(result) {
    return !!result && result.ok !== false && !result.error
}

function failureStatus(result, fallback = 'failed') {
    const value = `${result?.code || ''} ${result?.error || ''}`.toLowerCase()
    if (/verification|required|checkpoint|challenge|manual.action/.test(value)) return 'checkpoint'
    return result?.status || fallback
}

function buildPrimaryConfig(request, stagedPicture) {
    const config = {}
    const completed = []

    if (stagedPicture) {
        config.profile_picture = stagedPicture.stagedFileName
        config.picture_path = request.picturePath
        config.set_profile_picture = true
        completed.push('profile_picture')
    }
    if (Object.hasOwn(request, 'name') && String(request.name || '').trim()) {
        config.name = String(request.name).trim()
        completed.push('name')
    }
    if (Object.hasOwn(request, 'bio') && String(request.bio || '').trim()) {
        config.bio = String(request.bio)
        completed.push('bio')
    }
    if (request.switch_to_professional) {
        config.switch_to_professional = true
        config.account_type = 'business'
        const category = String(request.professional_category || request.category || '').trim()
        if (category) config.professional_category = category
        completed.push('professional')
    }

    return { config, completed }
}

async function runProfileEdit(request, deps) {
    const userId = String(request?.userId ?? '').trim()
    const account = normalizeHandle(request?.account)
    if (!request?.serial || !/^\d+$/.test(userId) || !account) {
        return {
            success: false,
            status: 'invalid_request',
            error: 'Phone serial, Android user ID, and Instagram account are required.',
        }
    }

    const username = request.username ? normalizeHandle(request.username) : null
    if (request.username && !username) {
        return { success: false, status: 'invalid_request', error: 'The requested Instagram username is invalid.' }
    }

    const serial = await deps.resolveSerial(request.serial)
    if (!serial) {
        return { success: false, status: 'not_found', error: 'No connected phone was resolved.' }
    }

    const userResult = await deps.ensureUser(serial, userId)
    if (!isOk(userResult)) {
        return {
            success: false,
            status: 'identity_mismatch',
            error: userResult?.error || `Android user ${userId} could not be verified.`,
        }
    }

    const accountResult = await deps.ensureAccount(serial, userId, account)
    if (!isOk(accountResult)) {
        return {
            success: false,
            status: 'identity_mismatch',
            error: accountResult?.error || `Instagram account @${account} could not be verified.`,
        }
    }

    let stagedPicture = null
    if (request.picturePath) {
        stagedPicture = await deps.stagePicture({ ...request, serial, userId, account })
        if (!stagedPicture?.success) {
            return {
                success: false,
                status: 'failed',
                failed: 'profile_picture',
                completed: [],
                error: stagedPicture?.error || 'The profile picture could not be staged on the phone.',
            }
        }
        const stagedAccount = await deps.ensureAccount(serial, userId, account)
        if (!isOk(stagedAccount)) {
            return {
                success: false,
                status: 'identity_mismatch',
                failed: 'profile_picture',
                completed: [],
                error: stagedAccount?.error || `Instagram account @${account} could not be re-verified after staging.`,
            }
        }
    }

    const primary = buildPrimaryConfig(request, stagedPicture)
    const completed = []
    const warnings = []
    if (Object.keys(primary.config).length) {
        const result = await deps.runBrain({ serial, userId, account, config: primary.config })
        if (!result?.success) {
            const resultFields = result?.data?.results || {}
            const resultKey = {
                profile_picture: 'picture_changed',
                name: 'name',
                bio: 'bio',
                professional: 'switch_to_professional',
            }
            const partialCompleted = primary.completed.filter((field) => resultFields[resultKey[field]] === true)
            const failed = primary.completed.find((field) => resultFields[resultKey[field]] === false)
                || primary.completed.find((field) => !partialCompleted.includes(field))
            return {
                success: false,
                status: partialCompleted.length ? 'partial' : failureStatus(result),
                failed,
                completed: partialCompleted,
                error: result?.error || 'Instagram rejected the profile edit.',
            }
        }
        completed.push(...primary.completed)
    }

    if (username && username !== account) {
        const pending = await deps.beginRename({ ...request, serial, userId, account, username })
        const renameResult = await deps.runBrain({ serial, userId, account, config: { username } })
        if (!renameResult?.success) {
            const error = renameResult?.error || 'Instagram rejected the username change.'
            await deps.failRename({ pending, error, serial, userId, account, username })
            return {
                success: false,
                status: completed.length ? 'partial' : failureStatus(renameResult),
                failed: 'username',
                completed,
                error,
            }
        }

        const verified = await deps.verifyHandle(serial, userId, username)
        if (!isOk(verified)) {
            const error = verified?.error || `Instagram did not confirm @${username}.`
            await deps.failRename({ pending, error, serial, userId, account, username })
            return {
                success: false,
                status: completed.length ? 'partial' : 'identity_mismatch',
                failed: 'username',
                completed,
                error,
            }
        }

        const commitResult = await deps.commitRename({
            pending,
            serial,
            userId,
            account,
            username,
            verifiedHandle: normalizeHandle(verified.handle) || username,
        })
        if (commitResult?.cloud && !commitResult.cloud.success) {
            warnings.push(
                `Instagram and local files were updated, but cloud mapping failed: ${commitResult.cloud.error || 'unknown error'}`,
            )
        }
        completed.push('username')
    }

    if (!completed.length) {
        return { success: false, status: 'invalid_request', completed, error: 'No profile changes were requested.' }
    }

    return {
        success: true,
        status: warnings.length ? 'partial_sync' : 'success',
        completed,
        account: username || account,
        ...(warnings.length ? { warnings } : {}),
    }
}

module.exports = { buildPrimaryConfig, runProfileEdit }
