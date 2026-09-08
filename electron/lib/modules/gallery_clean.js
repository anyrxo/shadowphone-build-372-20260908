// electron/lib/modules/gallery_clean.js
// ── Handler: gallery_clean ──────────────────────────────────────────
// Deletes media files from common gallery directories on the device.
// Supports 'full' mode (delete all files), 'selective' mode (delete files older
// than keep_days), and 'exact' mode (delete only explicitly named MediaStore rows).
// Also clears the MediaStore so the Gallery app shows as empty.
//
// Speed: previously made 12+ separate `adb shell` round-trips (~3s).
// Now batches all dir cleans into a single shell command (~400ms).
//
// Multi-user: previously read `am get-current-user` from the shell which
// always returns user 0 (the shell user), not the IG user. Result:
// MediaStore deletes never ran for user 24+. Now reads target_user from
// config (preferred) and falls back to `am get-current-user` only when
// no target is given.

const { quoteAndroidShell, safeUserId } = require('../local-modules-shared')

module.exports = async (device, config) => {
    const t0 = Date.now()
    try {
        const mode = config.mode || 'full'
        const include_instagram = config.include_instagram !== false
        const include_whatsapp = config.include_whatsapp || false
        const keep_days = config.keep_days || 0
        // Caller may pass the IG user (24+) explicitly. fleet-steps.tsx
        // doesn't currently — but should for multi-profile correctness.
        const explicitUser = config.target_user != null ? String(config.target_user).trim() : ''

        // Resolve target user FIRST so we can fold MediaStore deletes into
        // the same shell round-trip as the filesystem cleans.
        let targetUser = safeUserId(explicitUser)
        if (explicitUser && !targetUser) throw new Error('target_user must be a numeric Android user ID')
        if (!targetUser) {
            const currentUserRaw = await device.shell('am get-current-user')
            targetUser = safeUserId(currentUserRaw) || '0'
        }
        const userFlag = targetUser && targetUser !== '0' ? ` --user ${targetUser}` : ''

        // Multi-root find — one `find` traverses all dirs at once instead of
        // spawning N. For `full` mode we use -maxdepth 1 to match the prior
        // behavior. The `Camera/Screenshots` subdir purge stays as a separate
        // `rm -rf` line (find -delete doesn't recurse into subdirs at depth 1).
        //
        // Dirs are built from /storage/emulated/<targetUser>/, not /sdcard/.
        // /sdcard always resolves to the SHELL user's storage (user 0) because
        // device.shell runs as shell — so cleaning profile 19 used to delete
        // user 0's DCIM/Download while the MediaStore deletes below were --user
        // scoped. That is cross-profile destruction, and it is also why step 5
        // of the 2026-07-26 run reported "dirs=7 PASSED" about the wrong user.
        // For user 0 the path is identical (/sdcard is a symlink to it).
        const storageRoot = `/storage/emulated/${targetUser || '0'}`
        const baseDirs = [
            `${storageRoot}/DCIM`,
            `${storageRoot}/DCIM/Camera`,
            `${storageRoot}/Pictures`,
            `${storageRoot}/Download`,
            `${storageRoot}/Movies`,
            `${storageRoot}/ShadowPhone/content`,
        ]
        if (include_instagram) baseDirs.push(`${storageRoot}/Pictures/Instagram`)
        if (include_whatsapp) baseDirs.push(`${storageRoot}/WhatsApp/Media`)

        const allLines = []
        let exactNames = []
        if (mode === 'full') {
            // Single multi-root find. -maxdepth 1 mirrors old per-dir behavior.
            // Non-existent dirs are silently ignored by find.
            allLines.push(`find ${baseDirs.join(' ')} -maxdepth 1 -type f -delete 2>/dev/null`)
            // Recursive purge of Camera + Screenshots subdirs across the roots.
            const recursiveTargets = baseDirs.flatMap(d => [`${d}/Camera/*`, `${d}/Screenshots/*`])
            allLines.push(`rm -rf ${recursiveTargets.join(' ')} 2>/dev/null`)
        } else if (mode === 'selective') {
            allLines.push(`find ${baseDirs.join(' ')} -type f -mtime +${keep_days} -delete 2>/dev/null`)
        } else if (mode === 'exact') {
            const requested = Array.isArray(config.filenames) ? config.filenames : []
            exactNames = [...new Set(requested.map(value => String(value || '').trim()).filter(Boolean))]
            if (exactNames.length === 0) throw new Error('Exact gallery cleanup requires at least one filename')
            if (exactNames.some(name => name === '.' || name === '..' || !/^[A-Za-z0-9._-]+$/.test(name))) {
                throw new Error('Exact gallery cleanup received an unsafe filename')
            }
        } else {
            throw new Error(`Unsupported gallery cleanup mode: ${mode}`)
        }

        // Fold MediaStore deletes into the same round-trip. Exact cleanup must
        // retain its predicate so an avatar change cannot erase unrelated media.
        const mediaUris = [
            'content://media/external/images/media',
            'content://media/external/video/media',
            'content://media/external/downloads',
        ]
        if (mode === 'exact') {
            for (const name of exactNames) {
                const where = quoteAndroidShell(`_display_name='${name}'`)
                for (const uri of mediaUris) {
                    allLines.push(`content delete${userFlag} --uri ${uri} --where ${where} 2>/dev/null`)
                }
            }
        } else {
            for (const uri of mediaUris) {
                allLines.push(`content delete${userFlag} --uri ${uri} 2>/dev/null`)
            }
        }

        // `; :` between commands so individual failures don't short-circuit.
        await device.shell(allLines.join('; :; ') + '; :')

        const elapsed = Date.now() - t0
        device.sendLog(`module=gallery_clean step=done dirs=${baseDirs.length} user=${targetUser || '0'} elapsed=${elapsed}ms`, 'INFO')
        return {
            success: true,
            data: {
                mode,
                dirs_cleaned: mode === 'exact' ? 0 : baseDirs.length,
                files_deleted: mode === 'exact' ? exactNames.length : undefined,
                target_user: targetUser || '0',
                elapsed_ms: elapsed,
            },
        }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
