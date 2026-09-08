/**
 * Profile Management IPC Handlers
 * Handles GrapheneOS profile switching, listing, and management
 */

const { ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')

let mainWindow = null
let executeADB = null
// Captured inside initProfileHandlers so bulk creation (and any other caller)
// can invoke the switch-profile logic directly without a renderer IPC round-trip.
let _switchProfile = null

// Per-device profile nickname store. Shape: { [serial]: { [profileId]: name } }
// Used because GrapheneOS shell can't actually rename profiles (no MANAGE_USERS,
// no Settings UI rename action, only "Delete yourself" on the target side which
// is destructive). Local override is the safe and predictable path.
let profileNicknames = {}
let profileNicknamesPath = null

const OWNER_PROFILE_ID = '0'
const PROFILE_ESSENTIAL_PACKAGES = [
    'com.instagram.android',
    'com.google.android.gm',
    'com.google.android.gms',
    'com.google.android.apps.docs',
    'com.android.vending',
    'com.android.adbkeyboard',
    'ch.protonvpn.android',
]

function loadProfileNicknames(app) {
    try {
        profileNicknamesPath = path.join(app.getPath('userData'), 'profile-nicknames.json')
        if (fs.existsSync(profileNicknamesPath)) {
            const raw = fs.readFileSync(profileNicknamesPath, 'utf8')
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
                profileNicknames = parsed
                const total = Object.values(profileNicknames).reduce(
                    (n, v) => n + (v && typeof v === 'object' ? Object.keys(v).length : 0),
                    0,
                )
                console.log(`[Profile] Loaded ${total} profile nicknames across ${Object.keys(profileNicknames).length} devices`)
            }
        }
    } catch (err) {
        console.warn('[Profile] Failed to load nicknames:', err?.message || err)
        profileNicknames = {}
    }
}

function saveProfileNicknames() {
    if (!profileNicknamesPath) return
    try {
        fs.writeFileSync(profileNicknamesPath, JSON.stringify(profileNicknames, null, 2), 'utf8')
    } catch (err) {
        console.warn('[Profile] Failed to save nicknames:', err?.message || err)
    }
}

function getProfileNickname(serial, profileId) {
    const bucket = profileNicknames[serial]
    if (!bucket) return null
    const value = bucket[String(profileId)]
    return value && typeof value === 'string' && value.trim() ? value.trim() : null
}

function buildProfileDisplayName(serial, profileId, originalName) {
    const nickname = getProfileNickname(serial, profileId)
    if (nickname) return nickname
    if (originalName && originalName.trim() && originalName !== 'null') return originalName
    return `Profile ${profileId}`
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}


function parseUsersList(output) {
    const users = []
    for (const line of String(output || '').split('\n')) {
        const match = line.match(/UserInfo\{(\d+):([^:]+):/)
        if (!match) continue
        const [, id, rawName] = match
        const trimmed = rawName.trim()
        users.push({
            id: String(id),
            name: (trimmed === 'Primary' || trimmed === 'null' || id === '0') ? 'Owner' : trimmed,
            rawName: trimmed,
        })
    }
    return users
}

function normalizeProfileId(value) {
    if (value === null || value === undefined) return null
    const profileId = String(value).trim()
    return /^\d+$/.test(profileId) ? profileId : null
}

function ownerProfileProtectedResult() {
    return {
        success: false,
        code: 'OWNER_PROFILE_PROTECTED',
        phase: 'validation',
        error: 'Owner profile (user 0) cannot be switched to, renamed, or deleted',
    }
}

function findCreatedProfileId(createOutput, usersOutput) {
    if (!/success/i.test(String(createOutput || ''))) return null
    const users = parseUsersList(usersOutput).filter((user) => user.id !== OWNER_PROFILE_ID)
    const parsedId = normalizeProfileId(String(createOutput || '').match(/user id (\d+)/i)?.[1])
    if (parsedId && users.some((user) => user.id === parsedId)) return parsedId
    return null
}

function findSafeProfileId(usersOutput, excludedProfileId) {
    const excludedId = normalizeProfileId(excludedProfileId)
    return parseUsersList(usersOutput)
        .find((user) => user.id !== OWNER_PROFILE_ID && user.id !== excludedId)?.id || null
}

function buildDurableProfileSwitchCommands(profileId, prefix = 'sp-switch') {
    const targetId = normalizeProfileId(profileId)
    if (targetId === null) throw new Error('A numeric profile ID is required')

    const logFile = `/data/local/tmp/${prefix}.log`
    const scriptFile = `/data/local/tmp/${prefix}.sh`
    const safetyFile = `/data/local/tmp/${prefix}-safety.sh`
    const mainScript = [
        `date +%s.%3N > ${logFile}`,
        `echo START switch-to-${targetId} >> ${logFile}`,
        `cmd connectivity airplane-mode enable 2>> ${logFile}`,
        'sleep 1',
        `echo AIRPLANE_ON >> ${logFile}`,
        `am start-user ${targetId} >> ${logFile} 2>&1`,
        `echo START_USER_EXIT=$? >> ${logFile}`,
        `am switch-user ${targetId} >> ${logFile} 2>&1`,
        `echo SWITCH_CMD_EXIT=$? >> ${logFile}`,
        'sleep 2',
        `cmd connectivity airplane-mode disable 2>> ${logFile}`,
        `echo DONE >> ${logFile}`,
    ].join(' ; ')
    const safetyScript = [
        'sleep 30',
        'cmd connectivity airplane-mode disable',
        `echo SAFETY_NET_FIRED $(date +%s) >> ${logFile}`,
    ].join(' ; ')
    const mainEncoded = Buffer.from(mainScript).toString('base64')
    const safetyEncoded = Buffer.from(safetyScript).toString('base64')

    return {
        logFile,
        writeCommand: `echo ${mainEncoded} | base64 -d > ${scriptFile} && echo ${safetyEncoded} | base64 -d > ${safetyFile} && chmod 755 ${scriptFile} ${safetyFile}`,
        spawnCommand: `setsid sh ${safetyFile} </dev/null >/dev/null 2>&1 & setsid sh ${scriptFile} </dev/null >/dev/null 2>&1 &`,
    }
}


function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toInputText(value) {
    return String(value)
        .replace(/ /g, '%s')
        .replace(/['"]/g, '')
        .replace(/&/g, 'and')
}

function quoteAndroidShell(value) {
    const escaped = String(value).replace(/'/g, "'\\''")
    return `'${escaped}'`
}

function profileNameMatches(user, expectedName) {
    return user && (user.name === expectedName || user.rawName === expectedName)
}

async function waitForProfileName(serial, targetUserId, expectedName, attempts = 6, wait = sleep) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const users = parseUsersList(await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users']))
        const renamed = users.find((user) => user.id === targetUserId && profileNameMatches(user, expectedName))
        if (renamed) return renamed
        await wait(700)
    }
    return null
}

// 2.16.23: GrapheneOS doesn't expose `pm rename-user` or `cmd user set-user-name`,
// so we drive the Settings → System → Users screen with uiautomator. Caller
// MUST have already switched the phone to `targetUserId` (only "You" can be
// renamed via that flow — Owner can rename others from Owner's own session
// too, but for symmetry we always rename via the target user's own session).
async function renameUserViaSettings(serial, targetUserId, newName, dependencies = {}) {
    // 2.17.22: log every step + always force-stop Settings on the way out.
    // Previously some error paths returned without force-stopping → dialog
    // stayed open on phone, operator was confused why "renamed" toast lied.
    const log = dependencies.log || (() => { try { return require('../lib/launcher-log') } catch (_) { return { write: () => {} } } })()
    const wait = dependencies.wait || sleep
    log.write('rename:start', { serial, targetUserId, newName })
    const finalize = async (result) => {
        try { await executeADB(['-s', serial, 'shell', 'am', 'force-stop', 'com.android.settings'], 4000) } catch (_) {}
        log.write('rename:end', { serial, targetUserId, ok: !!result.ok, error: result.error || null })
        return result
    }

    // 2.16.25: defensive ordering. Force-stop Settings FIRST so the wake +
    // swipe-to-unlock can't accidentally interact with a stale Settings UI
    // (which we've seen in field — the swipe was dragging Settings widgets
    // and triggering the action-bar overflow menu).
    try { await executeADB(['-s', serial, 'shell', 'am', 'force-stop', 'com.android.settings'], 4000) } catch (_) {}
    await wait(300)

    // Wake + dismiss keyguard (best-effort — no-PIN profiles only).
    try { await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '224'], 3000) } catch (_) {}
    await wait(300)
    try { await executeADB(['-s', serial, 'shell', 'input', 'swipe', '540', '1800', '540', '800', '200'], 3000) } catch (_) {}
    await wait(800)

    // 2.16.25: verify foreground user IS the target before opening Settings.
    // If a stale prior switch left us on the wrong user, am start --user
    // would fire into a misaligned context (the bug from 2.16.24).
    try {
        const beforeRaw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
        const beforeId = String(beforeRaw || '').trim()
        if (beforeId !== String(targetUserId)) {
            return finalize({ ok: false, error: `phone is on user ${beforeId} but rename target is ${targetUserId} — switch first` })
        }
    } catch (_) { /* don't block on verification failure */ }

    // 2.16.24 explicit numeric userId — opens Settings inside target's own
    // session where target shows as "You" and is renamable. With --user
    // current we'd hit user 0's settings and the target would show as
    // "Delete X from this device".
    try {
        await executeADB(['-s', serial, 'shell', 'am', 'start',
            '--user', String(targetUserId),
            '-a', 'android.settings.USER_SETTINGS'], 6000)
    } catch (e) {
        return finalize({ ok: false, error: `failed to open Users settings: ${e?.message || e}` })
    }
    await wait(2500)
    log.write('rename:opened-settings', { serial, targetUserId })

    // 3. Dump → verify we're actually on Users page AND find the "You" row.
    let xml = await dumpUiXml(serial)
    // Settings hasn't fully rendered yet? Retry once after a longer wait.
    if (!/text="Users"/.test(String(xml)) || !/text="You \(/.test(String(xml))) {
        await wait(2000)
        xml = await dumpUiXml(serial)
    }
    let youM = String(xml).match(/text="You \(([^)]+)\)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (!youM) {
        // Dump first 200 chars of visible text for diagnosis.
        const visibleTexts = (String(xml).match(/text="([^"]{1,30})"/g) || []).slice(0, 8).join(' | ')
        return finalize({ ok: false, error: `You(...) row not found in Settings. Visible: ${visibleTexts}` })
    }
    const currentName = youM[1]
    const youX = Math.round((Number(youM[2]) + Number(youM[4])) / 2)
    const youY = Math.round((Number(youM[3]) + Number(youM[5])) / 2)
    await executeADB(['-s', serial, 'shell', 'input', 'tap', String(youX), String(youY)], 3000)
    await wait(1500)

    // 4. Dialog open — DELETE-menu safeguard FIRST.
    xml = await dumpUiXml(serial)
    if (/Delete [^<]+ from this device/i.test(String(xml))) {
        try { await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '4'], 3000) } catch (_) {}
        await wait(200)
        try { await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '4'], 3000) } catch (_) {}
        await wait(200)
        try { await executeADB(['-s', serial, 'shell', 'am', 'force-stop', 'com.android.settings'], 4000) } catch (_) {}
        return finalize({ ok: false, error: 'tapped row opened Delete menu — aborted and force-stopped Settings.' })
    }
    log.write('rename:dialog-open', { serial, targetUserId, currentName })

    // 2.16.26: locate the EditText with two-layer fallback. Bounds and text
    // attribute order is non-deterministic in uiautomator dumps, so first
    // try the original text-then-bounds regex, then fall back to finding
    // ANY EditText element (the User info dialog only has one). On error
    // paths from here on, press BACK to dismiss the dialog so the phone
    // doesn't get stuck on a half-open rename popup.
    const dismissDialog = async () => {
        try { await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '4'], 3000) } catch (_) {}
        await wait(200)
        try { await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '4'], 3000) } catch (_) {}
    }
    const esc = currentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let editM = String(xml).match(new RegExp(`text="${esc}"[^>]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`))
    if (!editM) {
        // Try the reverse attribute order (bounds before text).
        editM = String(xml).match(new RegExp(`bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*?text="${esc}"`))
    }
    if (!editM) {
        // Fall back to ANY EditText element. The User info dialog has only
        // one EditText so this is safe.
        const anyEdit = String(xml).match(/<node\s+[^>]*class="android\.widget\.EditText"[^>]*\/>/)
        if (anyEdit) {
            const boundsM = anyEdit[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
            if (boundsM) editM = boundsM
        }
    }
    if (!editM) {
        await dismissDialog()
        return finalize({ ok: false, error: 'rename dialog EditText not found — dialog may not have opened correctly. Dismissed.' })
    }
    log.write('rename:edittext-found', { serial, targetUserId, bounds: editM.slice(1).join(',') })
    const ex = Math.round((Number(editM[1]) + Number(editM[3])) / 2)
    const ey = Math.round((Number(editM[2]) + Number(editM[4])) / 2)
    await executeADB(['-s', serial, 'shell', 'input', 'tap', String(ex), String(ey)], 3000)
    await wait(400)

    // Clear exactly the visible value in one `input` process. The previous
    // remote shell loop spawned 60 child processes and regularly exceeded its
    // eight-second ADB timeout on a busy phone.
    const deleteKeys = Array.from({ length: [...currentName].length }, () => '67')
    await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '123', ...deleteKeys], 8000)
    await wait(400)

    // Type new name (spaces → %s per `input text` escape rules).
    const typed = toInputText(newName)
    await executeADB(['-s', serial, 'shell', 'input', 'text', typed], 5000)
    await wait(700)

    // 5. Re-dump for fresh OK bounds — the IME push shifts the dialog up,
    //    so the OK position from xml2 (before keyboard) is wrong by ~400px.
    const xml3 = await dumpUiXml(serial)
    const typedEditNode = String(xml3).match(/<node\s+[^>]*class="android\.widget\.EditText"[^>]*\/?\s*>/)
    const typedValue = typedEditNode?.[0].match(/\btext="([^"]*)"/)?.[1]
    if (typedValue !== newName) {
        await dismissDialog()
        return finalize({ ok: false, error: `rename dialog EditText typed value did not match "${newName}"` })
    }
    const okM = String(xml3).match(/text="OK"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (!okM) {
        await dismissDialog()
        return finalize({ ok: false, error: 'OK button not found after typing — dismissed dialog.' })
    }
    log.write('rename:tapping-ok', { serial, targetUserId, newName, ok: { x: Math.round((Number(okM[1]) + Number(okM[3])) / 2), y: Math.round((Number(okM[2]) + Number(okM[4])) / 2) } })
    const okx = Math.round((Number(okM[1]) + Number(okM[3])) / 2)
    const oky = Math.round((Number(okM[2]) + Number(okM[4])) / 2)
    await executeADB(['-s', serial, 'shell', 'input', 'tap', String(okx), String(oky)], 3000)
    await wait(1500)

    // 6. Verify via pm list users.
    const verified = await waitForProfileName(serial, targetUserId, newName, 5, wait)
    return finalize({ ok: !!verified, currentName, newName, error: verified ? null : 'rename submitted but pm list users still shows old name' })
}

async function tryRenameProfileWithUserService(serial, targetUserId, trimmedName) {
    const commands = [
        `cmd user set-user-name ${targetUserId} ${quoteAndroidShell(trimmedName)}`,
        `pm rename-user ${targetUserId} ${quoteAndroidShell(trimmedName)}`,
    ]

    for (const command of commands) {
        try {
            await executeADB(['-s', serial, 'shell', command], 15000)
            const renamed = await waitForProfileName(serial, targetUserId, trimmedName, 5)
            if (renamed) return renamed
        } catch (error) {
            console.log(`[Profile] ${command.split(' ').slice(0, 3).join(' ')} fallback needed: ${error.message}`)
        }
    }

    return null
}

function getCenterFromXml(xml, candidates) {
    const haystack = String(xml || '')
    for (const candidate of candidates) {
        const pattern = candidate instanceof RegExp
            ? candidate
            : new RegExp(`${candidate}[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i')
        const match = haystack.match(pattern)
        if (!match) continue
        const x1 = Number(match[1]), y1 = Number(match[2]), x2 = Number(match[3]), y2 = Number(match[4])
        if ([x1, y1, x2, y2].every(Number.isFinite)) {
            return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
        }
    }
    return null
}

async function dumpUiXml(serial) {
    const dumpPath = '/data/local/tmp/sp_rename_dump.xml'
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            // Wake screen + dismiss keyguard before dumping
            if (attempt === 0) {
                await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '224'], 5000).catch(() => {}) // wake
                await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '82'], 5000).catch(() => {}) // unlock
                await sleep(1000)
            }
            const output = await executeADB([
                '-s', serial, 'shell',
                `rm -f ${dumpPath}; uiautomator dump ${dumpPath} && cat ${dumpPath}`
            ], 20000)
            if (output && String(output).includes('<node')) return output
        } catch (e) {
            console.log(`[Profile] UI dump attempt ${attempt + 1}/5 failed: ${e.message}`)
        }
        await sleep(2000)
    }
    return ''
}

async function dumpUiXmlFast(serial) {
    const dumpPath = '/data/local/tmp/sp_setup_wizard_dump.xml'
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (attempt === 0) {
                await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '224'], 3000).catch(() => {})
                await executeADB(['-s', serial, 'shell', 'input', 'keyevent', '82'], 3000).catch(() => {})
            }
            const output = await executeADB([
                '-s', serial, 'shell',
                `rm -f ${dumpPath}; uiautomator dump ${dumpPath} >/dev/null && cat ${dumpPath}`
            ], 12000)
            if (output && String(output).includes('<node')) return output
        } catch (e) {
            console.log(`[Profile] Fast UI dump attempt ${attempt + 1}/3 failed: ${e.message}`)
        }
        await sleep(500)
    }
    return ''
}

function parseBounds(bounds) {
    const match = String(bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (!match) return null
    const x1 = Number(match[1]), y1 = Number(match[2]), x2 = Number(match[3]), y2 = Number(match[4])
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null
    return {
        x: Math.round((x1 + x2) / 2),
        y: Math.round((y1 + y2) / 2),
        x1, y1, x2, y2,
    }
}

function parseUiNodes(xml) {
    const nodes = []
    const nodeRegex = /<node\b[^>]*>/gi
    const attrRegex = /([\w:-]+)="([^"]*)"/g
    let nodeMatch
    while ((nodeMatch = nodeRegex.exec(String(xml || ''))) !== null) {
        const raw = nodeMatch[0]
        const attrs = {}
        let attrMatch
        while ((attrMatch = attrRegex.exec(raw)) !== null) {
            attrs[attrMatch[1]] = attrMatch[2]
        }
        const center = parseBounds(attrs.bounds)
        if (center) nodes.push({ raw, attrs, center })
    }
    return nodes
}

function findControlCenter(xml, labels, resourceIds = []) {
    const normalizedLabels = labels.map(label => String(label).trim().toLowerCase()).filter(Boolean)
    const normalizedIds = resourceIds.map(id => String(id).trim().toLowerCase()).filter(Boolean)
    const nodes = parseUiNodes(xml)

    const exactLabel = nodes.find(node => {
        const text = String(node.attrs.text || '').trim().toLowerCase()
        const desc = String(node.attrs['content-desc'] || '').trim().toLowerCase()
        return normalizedLabels.includes(text) || normalizedLabels.includes(desc)
    })
    if (exactLabel) return exactLabel.center

    const idMatch = nodes.find(node => {
        const resourceId = String(node.attrs['resource-id'] || '').trim().toLowerCase()
        return normalizedIds.some(id => resourceId === id || resourceId.endsWith(`/${id}`) || resourceId.includes(id))
    })
    if (idMatch) return idMatch.center

    return null
}

function isGrapheneSetupWizardXml(xml) {
    const lower = String(xml || '').toLowerCase()
    return lower.includes('welcome to grapheneos')
        || lower.includes('grapheneos setup')
        || lower.includes('location services')
        || lower.includes('set a pin')
        || lower.includes('skip setup for pin')
        || lower.includes('fingerprint unlock')
        || lower.includes('restore apps')
        || lower.includes("you're all set")
        || lower.includes('app.grapheneos.setupwizard')
        || lower.includes('org.grapheneos.setupwizard')
}

function isGrapheneSetupWizardActivity(output) {
    const lower = String(output || '').toLowerCase()
    return lower.includes('setupwizard')
        || lower.includes('setup_wizard')
        || lower.includes('app.grapheneos.setupwizard')
        || lower.includes('org.grapheneos.setupwizard')
        || lower.includes('com.google.android.setupwizard')
}

async function isGrapheneSetupWizardVisible(serial) {
    const xml = await dumpUiXmlFast(serial)
    if (isGrapheneSetupWizardXml(xml)) return true

    try {
        const windowDump = await executeADB(['-s', serial, 'shell', 'dumpsys', 'window'], 8000)
        const focusLines = String(windowDump || '')
            .split(/\r?\n/)
            .filter(line => /mCurrentFocus|mFocusedApp|topResumedActivity|setupwizard/i.test(line))
            .join('\n')
        return isGrapheneSetupWizardActivity(focusLines)
    } catch {
        return false
    }
}

const SETUP_WIZARD_NEXT_IDS = [
    'next',
    'next_button',
    'sud_layout_next',
    'sud_navbar_next',
    'app.grapheneos.setupwizard:id/next',
    'app.grapheneos.setupwizard:id/next_button',
    'app.grapheneos.setupwizard:id/sud_layout_next',
    'app.grapheneos.setupwizard:id/sud_navbar_next',
    'org.grapheneos.setupwizard:id/next',
    'org.grapheneos.setupwizard:id/next_button',
    'com.google.android.setupwizard:id/suc_layout_next',
    'com.google.android.setupwizard:id/sud_layout_next',
]

const SETUP_WIZARD_SKIP_IDS = [
    'skip',
    'skip_button',
    'sud_layout_skip',
    'sud_navbar_skip',
    'app.grapheneos.setupwizard:id/skip',
    'app.grapheneos.setupwizard:id/skip_button',
    'app.grapheneos.setupwizard:id/sud_layout_skip',
    'org.grapheneos.setupwizard:id/skip',
    'org.grapheneos.setupwizard:id/skip_button',
    'com.google.android.setupwizard:id/suc_layout_skip',
    'com.google.android.setupwizard:id/sud_layout_skip',
]

async function getScreenSize(serial) {
    try {
        const output = await executeADB(['-s', serial, 'shell', 'wm', 'size'], 5000)
        const match = String(output || '').match(/Physical size:\s*(\d+)x(\d+)/i)
        if (match) return { width: Number(match[1]), height: Number(match[2]) }
    } catch {}
    return { width: 1080, height: 2400 }
}

async function tapSetupWizardControl(serial, xml, labels, fallbackRatio = null, resourceIds = []) {
    const center = findControlCenter(xml, labels, resourceIds)
    if (center) {
        await executeADB(['-s', serial, 'shell', 'input', 'tap', String(center.x), String(center.y)], 5000)
        await sleep(450)
        return { tapped: true, label: labels[0], x: center.x, y: center.y, exact: true }
    }

    if (!fallbackRatio) return { tapped: false }
    const size = await getScreenSize(serial)
    const x = Math.round(size.width * fallbackRatio.x)
    const y = Math.round(size.height * fallbackRatio.y)
    await executeADB(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], 5000)
    await sleep(450)
    return { tapped: true, label: labels[0], x, y, exact: false }
}

async function completeGrapheneSetupWizard(serial, profileId, maxSteps = 8) {
    const steps = []
    let detected = false

    for (let i = 0; i < maxSteps; i++) {
        let xml = await dumpUiXmlFast(serial)
        const lower = xml.toLowerCase()
        const wizardVisible = isGrapheneSetupWizardXml(xml)

        if (!wizardVisible) {
            if (await isGrapheneSetupWizardVisible(serial)) {
                detected = true
                const action = await tapSetupWizardControl(
                    serial,
                    xml,
                    ['Next', 'Continue', 'Get started', 'Start', 'Done', 'Skip'],
                    { x: 0.86, y: 0.91 },
                    SETUP_WIZARD_NEXT_IDS
                )
                if (!action?.tapped) return { detected, completed: false, steps, reason: 'wizard_visible_no_xml_button' }
                steps.push(action.exact ? action.label : `${action.label} fallback`)
                await sleep(700)
                continue
            }
            return { detected, completed: true, steps }
        }
        detected = true

        if (mainWindow) {
            mainWindow.webContents.send('profile-switch-progress', {
                step: 'setup_wizard',
                profileId,
                detail: `Wizard step ${i + 1}`,
            })
        }

        let action = null
        if (lower.includes('location services')) {
            if (lower.includes('sud_items_switch') && lower.includes('checked="true"')) {
                const toggle = findControlCenter(xml, [], ['sud_items_switch'])
                if (toggle) {
                    await executeADB(['-s', serial, 'shell', 'input', 'tap', String(toggle.x), String(toggle.y)], 5000)
                    steps.push('Disable location')
                    await sleep(350)
                    xml = await dumpUiXmlFast(serial) || xml
                }
            }
            action = await tapSetupWizardControl(serial, xml, ['Next'], { x: 0.86, y: 0.91 }, SETUP_WIZARD_NEXT_IDS)
        } else if (lower.includes('set a pin')) {
            action = await tapSetupWizardControl(serial, xml, ['Skip'], { x: 0.1, y: 0.63 }, SETUP_WIZARD_SKIP_IDS)
        } else if (lower.includes('skip setup for pin') || lower.includes('fingerprint unlock')) {
            action = await tapSetupWizardControl(serial, xml, ['Skip'], { x: 0.828, y: 0.58 }, SETUP_WIZARD_SKIP_IDS)
        } else if (lower.includes('restore apps')) {
            action = await tapSetupWizardControl(serial, xml, ['Skip'], { x: 0.1, y: 0.908 }, SETUP_WIZARD_SKIP_IDS)
        } else if (lower.includes("you're all set") || lower.includes('you&apos;re all set')) {
            action = await tapSetupWizardControl(serial, xml, ['Start', 'Done', 'Finish'], { x: 0.86, y: 0.91 }, ['start_button', 'done_button', ...SETUP_WIZARD_NEXT_IDS])
        } else {
            action = await tapSetupWizardControl(
                serial,
                xml,
                ['Next', 'Continue', 'Get started', 'Start', 'Done', 'Skip'],
                { x: 0.86, y: 0.91 },
                [...SETUP_WIZARD_NEXT_IDS, 'done_button', ...SETUP_WIZARD_SKIP_IDS]
            )
        }

        if (!action?.tapped) {
            return { detected, completed: false, steps, reason: 'button_not_found' }
        }
        steps.push(action.exact ? action.label : `${action.label} fallback`)
    }

    const completed = !(await isGrapheneSetupWizardVisible(serial))
    return { detected, completed, steps, reason: completed ? null : 'max_steps_reached' }
}

// NOTE: the previous Settings-UI rename flow (~140 lines) was removed in
// favor of local nickname overrides + opportunistic service-path attempts
// in the rename-profile IPC handler below. GrapheneOS's Settings UI does
// not expose a rename action — tapping "You (Name)" on the target side
// shows a "Delete yourself?" confirmation and the old OK-fallback regex
// (android:id/button1) would have hit DELETE, wiping the user's profile.
// Never reintroduce that path without a strict screen-class guard.
//
// Legacy stub kept only because some module bundlers cache references —
// callers should use ipcMain `rename-profile` instead.
async function renameProfile(serial, userId, newName) {
    const targetUserId = String(userId).trim()
    const trimmedName = String(newName || '').trim()
    if (!targetUserId) return { success: false, error: 'Profile selection is required' }
    if (!trimmedName) return { success: false, error: 'New name is required' }

    // Best-effort service path only; never UI automation.
    const renamedByService = await tryRenameProfileWithUserService(serial, targetUserId, trimmedName)
    if (renamedByService) {
        return { success: true, output: `Renamed profile to ${trimmedName}` }
    }
    return { success: false, error: 'GrapheneOS shell cannot rename users. Use ipcMain handle rename-profile for local nickname override.' }
}


/**
 * Initialize profile handlers with dependencies
 */
function initProfileHandlers(window, adbExecutor, app, dependencies = {}) {
    mainWindow = window
    executeADB = adbExecutor
    if (app && typeof app.getPath === 'function') {
        loadProfileNicknames(app)
    }
    registerProfileHandlers(dependencies)
}

/**
 * Register all profile-related IPC handlers
 */
function registerProfileHandlers(dependencies = {}) {
    const wait = dependencies.wait || sleep
    // Get list of GrapheneOS profiles from device. Each profile now carries
    // its on-device `originalName` plus an optional local `nickname` override
    // and a derived `displayName` (nickname > originalName > "Profile <id>").
    // The renderer should prefer `displayName` for UI; `id` remains the
    // authoritative identifier for am switch-user.
    ipcMain.handle('get-device-profiles', async (event, serial) => {
        try {
            const output = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'])
            const profiles = []

            // Get current user ID first
            const currentOutput = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'])
            const currentUserId = currentOutput.trim()

            // Parse UserInfo{id:name:flags} format
            const lines = output.split('\n')
            for (const line of lines) {
                if (line.includes('UserInfo{')) {
                    const match = line.match(/UserInfo\{(\d+):([^:]+):/)
                    if (match) {
                        const profileId = match[1]
                        if (profileId === OWNER_PROFILE_ID) continue
                        const rawName = match[2].trim()
                        const originalName = (rawName === 'null' && profileId === '0') ? 'Owner' : rawName
                        const nickname = getProfileNickname(serial, profileId)
                        const displayName = buildProfileDisplayName(serial, profileId, originalName)
                        profiles.push({
                            id: profileId,
                            // Keep `name` for backward compat with renderer code that hasn't
                            // migrated yet. It now reflects displayName so legacy dropdowns
                            // automatically show the friendly label.
                            name: displayName,
                            originalName,
                            nickname,
                            displayName,
                            isCurrent: profileId === currentUserId
                        })
                    }
                }
            }

            return {
                success: true,
                profiles,
                currentUserId,
                count: profiles.length
            }
        } catch (error) {
            return { success: false, error: error.message, profiles: [] }
        }
    })

    // Get current active profile
    ipcMain.handle('get-current-profile', async (event, serial) => {
        try {
            console.log(`[Profile] Getting current profile for device: ${serial}`)
            const userId = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'])
            const currentId = userId.trim()

            // Get the profile name
            const output = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'])
            let currentProfile = { id: currentId, name: 'Unknown' }

            const lines = output.split('\n')
            for (const line of lines) {
                const match = line.match(/UserInfo\{(\d+):([^:}]+)/)
                if (match && match[1] === currentId) {
                    const rawName = match[2].trim()
                    const cleanName = (rawName === 'Primary' || rawName === 'null' || match[1] === '0') ? 'Owner' : rawName
                    currentProfile = { id: match[1], name: cleanName }
                    break
                }
            }

            console.log(`[Profile] Current profile: ${currentProfile.name} (ID: ${currentId})`)
            return {
                success: true,
                profile: currentProfile,
                userId: currentId
            }
        } catch (error) {
            console.error('[Profile] Error getting current profile:', error)
            return { success: false, error: error.message, profile: null }
        }
    })

    // 2.16.13: helper — for TAILNET-connected phones, the per-step adb calls
    // break the moment airplane mode goes ON (Tailscale dies → adb-over-
    // tailnet dies → every command after fails to reach the phone and the
    // phone stays stuck in airplane mode forever). Solution: send the whole
    // airplane-on/switch/airplane-off sequence as ONE backgrounded shell
    // script on the phone. adb exits immediately, the script keeps running
    // locally on Android. When airplane goes back off, Tailscale reconnects
    // and adb is reachable again.
    function isTailnetSerial(serial) {
        return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)
    }

    async function reconnectTailnetAdb(serial, timeoutMs = 25000) {
        const deadline = Date.now() + timeoutMs
        let lastErr = null
        while (Date.now() < deadline) {
            try {
                // Re-establish the TCP adb connection (Tailscale may have just
                // come back; old connection went stale during airplane-on).
                await executeADB(['connect', serial], 3000).catch((e) => { lastErr = e })
                const out = await executeADB(['-s', serial, 'shell', 'echo', 'pong'], 2500)
                if (String(out).trim().endsWith('pong')) return true
            } catch (e) { lastErr = e }
            // 2.16.16: 500ms poll (was 1000ms) — catch the reconnect window
            // ~1s sooner on average, ~3s sooner worst case.
            await sleep(500)
        }
        console.warn(`[Profile] reconnectTailnetAdb timeout after ${timeoutMs}ms:`, lastErr?.message || lastErr)
        return false
    }

    // Switch profile with airplane mode workflow
    // isNewProfile: set true immediately after pm create-user so the
    // verify window is extended to cover the ~25-30s GrapheneOS first-boot
    // init, and the curtain stays up long enough to hide the transient Owner
    // state that would otherwise be visible mid-init.
    async function switchProfile({ serial, profileId: _profileId, completeSetupWizard, isNewProfile, phoneLockOwnerToken }) {
        // Normalize to string so `=== profileId` comparisons against ADB output (always strings)
        // work regardless of whether the caller passes a number or a string.
        const profileId = normalizeProfileId(_profileId)
        if (profileId === OWNER_PROFILE_ID) return ownerProfileProtectedResult()
        if (profileId === null) {
            return { success: false, code: 'INVALID_PROFILE_ID', phase: 'validation', error: 'A numeric non-Owner profile ID is required' }
        }
        let releasePhoneLock = null
        try {
            const scheduleEngine = require('../lib/schedule-engine')
            const alreadyOwned = scheduleEngine.isPhoneLockOwnerToken(phoneLockOwnerToken, serial)
            if (!alreadyOwned) {
                releasePhoneLock = scheduleEngine.acquirePhoneLock(serial)
                if (!releasePhoneLock) {
                    return { success: false, code: 'PHONE_BUSY', error: 'This phone is already running another automation. Profile switch was not started.' }
                }
            }
        } catch (error) {
            return { success: false, code: 'PHONE_COORDINATOR_UNAVAILABLE', error: error.message }
        }
        try {
            // Mark fleet activity so the companion/Tailscale owner-swap is
            // suppressed across this switch (and the create sequence that
            // follows it) — closes the pre-run window the busy counts miss.
            try { require('./module-handlers').bumpActivity() } catch (_) {}
            console.log(`[Profile] Switching to profile ID: ${profileId} on device: ${serial}`)
            const overTailnet = isTailnetSerial(serial)
            console.log(`[Profile] Transport: ${overTailnet ? 'tailnet (bundled-script mode)' : 'USB (per-step mode)'}`)

            // Notify frontend that switch is starting
            if (mainWindow) {
                mainWindow.webContents.send('profile-switch-progress', { step: 'airplane_on', profileId })
            }

            let verified = false

            if (overTailnet) {
                // ===== BUNDLED-SCRIPT PATH (tailnet phones) =====
                // Subshell + & + disown survives parent shell exit on Android
                // toybox (nohup was unreliable). Output goes to a phone-side
                // log we read back after reconnect so we can SEE what actually
                // ran instead of guessing why verification failed.
                //
                // 2.16.16: mark scrcpy as "respawning" BEFORE the script fires
                // so when the TCP-over-tailnet connection dies (airplane on),
                // scrcpy's process-close handler doesn't tear down the toolbar.
                // Then show a curtain over the dying scrcpy area so the
                // operator sees "switching profile…" instead of a black hole.
                let sysHandlers = null
                try { sysHandlers = require('./system-handlers') } catch (_) {}
                let curtain = null
                try { curtain = require('../lib/switch-curtain') } catch (_) {}
                if (sysHandlers?.markRespawning) sysHandlers.markRespawning(serial)
                if (curtain && sysHandlers) {
                    try {
                        await curtain.show({
                            serial,
                            scrcpyTitle: sysHandlers.getScrcpyTitleForSerial?.(serial),
                            scrcpyPid: sysHandlers.getScrcpyPidForSerial?.(serial),
                            profileLabel: `user ${profileId}`,
                            // New profiles: first-boot init keeps am get-current-user
                            // returning 0 for ~25-30s.  Extend the max-alive cap so
                            // the curtain stays up through that window and the operator
                            // never sees the transient Owner blip.
                            maxAliveMs: isNewProfile ? 35000 : undefined,
                        })
                    } catch (e) { console.warn('[Profile] curtain show failed (non-fatal):', e?.message || e) }
                }

                const durableSwitch = buildDurableProfileSwitchCommands(profileId)
                const { logFile } = durableSwitch
                // 2.21.14: AJ-fix. The previous `( ... ) &` detach was killed
                // by `am switch-user`'s process-group cleanup BEFORE the
                // airplane-off step ran, stranding phones in airplane mode
                // with the workflow collapsed.
                //
                // Architecture:
                //   1. Main script: airplane-on, switch-user, airplane-off
                //      — runs via `setsid sh` to detach from adb shell session,
                //      so am switch-user can't kill it as part of process-
                //      group cleanup
                //   2. Safety script: independent setsid process that waits
                //      30s then force-disables airplane mode. Even if main
                //      script dies anywhere, this catches it.
                //   3. main.js follow-up (further down) re-asserts via USB
                //      if Tailnet reconnect fails

                console.log('[Profile] Writing main + safety scripts to phone + setsid-detach…')
                try {
                    // Android sh can't chain `&&` immediately after `&`,
                    // so we do file-write in one call (with `&&` only between
                    // synchronous commands) then spawn the detached processes
                    // in a separate call (only `;` separators after `&`).
                    await executeADB(['-s', serial, 'shell', durableSwitch.writeCommand], 6000)
                    await executeADB(['-s', serial, 'shell', durableSwitch.spawnCommand], 6000)
                } catch (e) {
                    console.warn('[Profile] bundled-script send failed (continuing):', e.message)
                }

                // 2.16.16: ~5s for the script to finish (1+2s sleeps + run
                // overhead). Tailscale typically reconnects within 2-4s after
                // airplane-off — total wall time ~7-9s vs old ~13-17s.
                if (mainWindow) {
                    mainWindow.webContents.send('profile-switch-progress', { step: 'switching', profileId })
                }
                console.log('[Profile] Waiting for phone to come back on tailnet…')
                const back = await reconnectTailnetAdb(serial, 25000)
                // Pull the on-phone log so we can diagnose verification failures.
                if (back) {
                    try {
                        const phoneLog = await executeADB(['-s', serial, 'shell', `cat ${logFile} 2>/dev/null`], 4000)
                        console.log('[Profile] Phone-side switch log:\n' + String(phoneLog).split('\n').map(l => '  | ' + l).join('\n'))
                    } catch (_) {}
                }
                if (!back) {
                    // 2.21.14: AJ recovery. Phone didn't come back — likely
                    // stuck in airplane mode because the detached switch
                    // script got killed. The on-phone safety-net should
                    // fire at +30s, but we ALSO try direct USB recovery
                    // here (if cable is plugged) to cut the wait time.
                    console.warn('[Profile] Tailnet did not reconnect in 25s — attempting USB recovery')
                    try {
                        const devicesOut = await executeADB(['devices'], 5000)
                        const usbSerial = (devicesOut || '').split('\n').slice(1)
                            .map(l => l.trim().split(/\s+/))
                            .filter(p => p.length >= 2 && p[1] === 'device' && !p[0].includes(':'))
                            .map(p => p[0])
                            .find(s => s) || null
                        if (usbSerial) {
                            console.log(`[Profile] USB phone ${usbSerial} available, force-disabling airplane`)
                            await executeADB(['-s', usbSerial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], 6000)
                            // Wait additional 15s for Tailnet to come back post-recovery
                            await sleep(8000)
                            const back2 = await reconnectTailnetAdb(serial, 15000)
                            if (back2) {
                                console.log('[Profile] USB-recovery succeeded — Tailnet back')
                            } else {
                                console.warn('[Profile] USB-recovery fired but Tailnet still unreachable — phone may need reboot')
                            }
                        } else {
                            console.warn('[Profile] No USB cable — waiting for on-phone safety-net (~30s from script start)')
                            // Give the safety-net up to 35s more before giving up
                            await sleep(15000)
                            const back2 = await reconnectTailnetAdb(serial, 20000)
                            if (back2) {
                                console.log('[Profile] Safety-net fired — Tailnet recovered')
                            }
                        }
                    } catch (e) {
                        console.warn('[Profile] USB recovery attempt failed:', e?.message || e)
                    }

                    // Re-check after recovery attempts
                    const finalCheck = await reconnectTailnetAdb(serial, 3000)
                    if (!finalCheck) {
                        try { curtain?.hide(serial) } catch (_) {}
                        try { sysHandlers?.unmarkRespawning?.(serial) } catch (_) {}
                        if (mainWindow) {
                            mainWindow.webContents.send('profile-switched', { profileId, success: false, error: 'tailnet did not reconnect after switch + recovery' })
                        }
                        return { success: false, error: `Phone ${serial} not reachable after switch + recovery. On-phone safety-net should auto-recover within 30s of script start. If not, plug USB + run "adb shell cmd connectivity airplane-mode disable".` }
                    }
                    // Recovery worked — fall through to verification
                }
                console.log('[Profile] Phone reachable again — verifying current user')

                // 2.16.18: extended verify window — was 12×500ms=6s, now
                // 20×500ms=10s. The bundled script's airplane-off + tailnet
                // recovery can run ahead of Android actually committing the
                // user switch on a busy phone, so we'd see the OLD user for
                // 2-8s before Android caught up. 10s avoids the false-fail
                // toast Anyro was hitting.
                // isNewProfile: first-boot init keeps am get-current-user
                // returning 0 for ~25-30s; use 80×300ms=24s so we don't
                // time-out and arm the redundant fallback switch.
                const verifyAttempts = isNewProfile ? 80 : 20
                const verifySleepMs = isNewProfile ? 300 : 500
                let lastUserSeen = null
                for (let attempt = 0; attempt < verifyAttempts; attempt++) {
                    try {
                        const currentUser = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                        lastUserSeen = currentUser.trim()
                        if (lastUserSeen === profileId) { verified = true; break }
                    } catch (_) {}
                    await sleep(verifySleepMs)
                }

                // Fallback: if the bundled script's am switch-user didn't take
                // (locked user, race with airplane-off, etc.) but the phone IS
                // now reachable, fire am switch-user directly one more time.
                // SKIP for new profiles: the primary loop already covers 24s of
                // first-boot init. A bare am switch-user here would fire while
                // GrapheneOS is mid-init, causing the Owner→new-profile bounce
                // the operator sees. The bundled script already ran start-user +
                // switch-user; trust it and let init complete on its own.
                if (!verified && !isNewProfile) {
                    console.log(`[Profile] Bundled switch didn't take (still on user ${lastUserSeen}). Firing direct am switch-user as fallback…`)
                    try {
                        await executeADB(['-s', serial, 'shell', 'am', 'switch-user', profileId], 5000)
                        // 2.16.18: 20×750ms=15s for the fallback — gives slow
                        // Pixel 6a's user-session activation enough time.
                        for (let attempt = 0; attempt < 20; attempt++) {
                            await sleep(750)
                            try {
                                const currentUser = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                                lastUserSeen = currentUser.trim()
                                if (lastUserSeen === profileId) { verified = true; break }
                            } catch (_) {}
                        }
                    } catch (e) {
                        console.warn('[Profile] direct switch-user fallback failed:', e?.message || e)
                    }
                } else if (!verified && isNewProfile) {
                    console.log(`[Profile] New profile init still running (am get-current-user=${lastUserSeen}) — skipping bare fallback to avoid double-switch bounce`)
                }

                // 2.16.18: one last best-effort poll AFTER the auto-respawn
                // gap finishes. Sometimes Android only commits the foreground
                // user once scrcpy reconnects and pings the new user session.
                if (!verified) {
                    try {
                        await sleep(1500)
                        const currentUser = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                        lastUserSeen = currentUser.trim()
                        if (lastUserSeen === profileId) {
                            verified = true
                            console.log('[Profile] Switch verified on late-poll after scrcpy respawn')
                        }
                    } catch (_) {}
                }

                // New-profile bounce fix: do NOT respawn scrcpy / drop the curtain
                // while the phone is still on Owner. The 24s verify loop can exhaust
                // mid-init (first-boot can run ~25-30s); if we reconnect scrcpy now
                // the operator sees Owner, THEN watches init foreground the new user
                // — the visible Owner→new-profile bounce. Hold the curtain and keep
                // polling until the new user is actually foregrounded (or the 35s
                // curtain cap is about to fire), so scrcpy only reconnects once the
                // new profile is on screen.
                if (!verified && isNewProfile) {
                    // Use an independent deadline rather than a budget relative to switchStartedAt.
                    // switchStartedAt is set before reconnect_wait (~7-25s) + verify_loop (up to 24s)
                    // + late_poll (1.5s), so Date.now()-switchStartedAt is already >=32s when this
                    // block is first reached in the exact failure case — the original budget check
                    // expired before the loop ever ran. A fresh 32s deadline always gives this loop
                    // its full window regardless of how long the earlier phases took.
                    const holdDeadline = Date.now() + 32000 // stay under the 35s curtain max-alive
                    while (!verified && Date.now() < holdDeadline) {
                        await sleep(700)
                        try {
                            const cu = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                            lastUserSeen = cu.trim()
                            if (lastUserSeen === profileId) {
                                verified = true
                                console.log('[Profile] New profile foregrounded after init — proceeding to respawn scrcpy')
                            }
                        } catch (_) {}
                    }
                    if (!verified) console.log(`[Profile] New profile still not foregrounded at hold budget (am get-current-user=${lastUserSeen}) — respawning scrcpy anyway`)
                }

                // 2.16.14: auto-respawn scrcpy + sidebar. The airplane-on phase
                // killed the scrcpy stream (network dropped), which closed the
                // sidebar (owned-window relationship). Operator shouldn't have
                // to re-click Launch every time they switch profile. Re-fire
                // the shared launcher — its dedupe sees the dead process and
                // spawns fresh, then mirror-toolbar re-attaches the sidebar.
                try {
                    const { launchScrcpyForSerial } = require('./system-handlers')
                    if (typeof launchScrcpyForSerial === 'function') {
                        console.log('[Profile] Auto-respawning scrcpy + sidebar for', serial)
                        // 2.16.58: don't let a hung launchScrcpy promise pin
                        // the curtain open. Cap at 12s — long enough for the
                        // normal happy path, short enough that operators don't
                        // sit staring at a stuck spinner.
                        await Promise.race([
                            launchScrcpyForSerial(serial),
                            new Promise((resolve) => setTimeout(() => {
                                console.warn('[Profile] launchScrcpyForSerial took >12s — proceeding without await')
                                resolve()
                            }, 12000)),
                        ])
                    }
                } catch (e) {
                    console.warn('[Profile] auto-respawn failed (non-fatal):', e?.message || e)
                }
                // 2.16.16: tear down curtain + clear respawn guard now that the
                // fresh scrcpy has spawned. Small delay so the new window has
                // time to paint before we yank the cover off.
                // 2.16.58: also catches the case where launchScrcpyForSerial
                // races past its deadline — the max-alive timer in
                // switch-curtain.js is the final safety net.
                setTimeout(() => {
                    try { curtain?.hide(serial) } catch (_) {}
                    try { sysHandlers?.unmarkRespawning?.(serial) } catch (_) {}
                }, 600)
            } else {
                // ===== ORIGINAL PER-STEP PATH (USB phones) =====
                console.log('[Profile] Step 1: Enabling airplane mode...')
                await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'])
                await sleep(1200)

                if (mainWindow) {
                    mainWindow.webContents.send('profile-switch-progress', { step: 'switching', profileId })
                }

                console.log(`[Profile] Step 2: Switching to user ${profileId}...`)
                // Start the user first — a stopped GrapheneOS user (State:-1, e.g.
                // after a reboot) won't foreground from `am switch-user` alone.
                // Idempotent — no-op if the user is already running.
                try { await executeADB(['-s', serial, 'shell', 'am', 'start-user', profileId]) } catch (_) {}
                await executeADB(['-s', serial, 'shell', 'am', 'switch-user', profileId])

                // isNewProfile: widen to 80×300ms=24s so first-boot init
                // completes before we declare the switch unverified.
                console.log('[Profile] Waiting for profile switch to verify...')
                const usbVerifyAttempts = isNewProfile ? 80 : 20
                const usbVerifySleepMs = isNewProfile ? 300 : 500
                for (let attempt = 0; attempt < usbVerifyAttempts; attempt++) {
                    await sleep(usbVerifySleepMs)
                    const currentUser = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'])
                    if (currentUser.trim() === profileId) {
                        verified = true
                        console.log(`[Profile] Switch verified on attempt ${attempt + 1}`)
                        break
                    }
                }
            }

            // Step 2.5: Bypass GrapheneOS setup wizard if requested (new profile).
            //
            // FAST PATH first: write user_setup_complete=1 + send HOME + force-stop
            // the wizard package. This works on freshly-created GrapheneOS profiles
            // and takes <1s. Only fall back to the slow tap-driven automation
            // (`completeGrapheneSetupWizard`, 20-60s) if the bypass fails to
            // clear the wizard.
            let wizardResult = null
            if (completeSetupWizard && verified) {
                if (mainWindow) {
                    mainWindow.webContents.send('profile-switch-progress', { step: 'setup_wizard', profileId, detail: 'Bypassing wizard' })
                }

                const t0 = Date.now()

                // 1) Settings-database bypass — fast, no input injection needed.
                // --user <profileId> on every command: during first-boot init
                // `am get-current-user` can still report Owner, and a userless
                // command targets the FOREGROUND user's context — writing
                // Owner's settings and (worse) `am start HOME` pulling Owner to
                // the foreground, which is the visible Owner blip after create.
                try {
                    console.log('[Profile] Bypass: marking setup complete via settings…')
                    await executeADB(['-s', serial, 'shell', 'settings', '--user', profileId, 'put', 'secure', 'user_setup_complete', '1'])
                    await executeADB(['-s', serial, 'shell', 'settings', '--user', profileId, 'put', 'secure', 'location_mode', '0'])
                } catch (err) {
                    console.warn('[Profile] settings put failed (continuing):', err.message)
                }

                // 2) Dismiss to HOME + force-stop the wizard package(s).
                try {
                    await executeADB(['-s', serial, 'shell', 'am', 'start', '--user', profileId, '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'])
                    await executeADB(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']).catch(() => {})
                } catch (err) {
                    console.warn('[Profile] HOME intent failed:', err.message)
                }
                for (const pkg of ['org.grapheneos.setupwizard', 'app.grapheneos.setupwizard', 'com.google.android.setupwizard']) {
                    try { await executeADB(['-s', serial, 'shell', 'am', 'force-stop', '--user', profileId, pkg]) } catch {}
                }

                // 3) Verify the wizard is gone. Poll briefly so we don't wait
                //    for the full 500ms sleep we used to do unconditionally.
                let stillVisible = true
                for (let attempt = 0; attempt < 5; attempt++) {
                    stillVisible = await isGrapheneSetupWizardVisible(serial)
                    if (!stillVisible) break
                    await sleep(150)
                }
                console.log(`[Profile] Bypass ${stillVisible ? 'INCOMPLETE' : 'OK'} after ${Date.now() - t0}ms`)

                wizardResult = {
                    detected: true,
                    completed: !stillVisible,
                    steps: ['settings-bypass'],
                    reason: stillVisible ? 'bypass_insufficient' : null,
                    verifiedAfterBypass: true,
                    bypassMs: Date.now() - t0,
                }

                // 4) Slow fallback: if the bypass left the wizard visible, run
                //    the tap-driven automation. Most fresh profiles never reach
                //    this branch on GrapheneOS — the settings bypass is enough.
                if (stillVisible) {
                    console.log('[Profile] Bypass insufficient, falling back to tap-driven wizard automation…')
                    if (mainWindow) {
                        mainWindow.webContents.send('profile-switch-progress', { step: 'setup_wizard', profileId, detail: 'Tap-driven fallback' })
                    }
                    const tapResult = await completeGrapheneSetupWizard(serial, profileId)
                    wizardResult = {
                        ...wizardResult,
                        ...tapResult,
                        completed: !(await isGrapheneSetupWizardVisible(serial)),
                        steps: [...(wizardResult.steps || []), ...(tapResult?.steps || [])],
                    }
                    if (wizardResult.completed) wizardResult.reason = null
                }

                if (!wizardResult.completed) {
                    console.log('[Profile] Setup wizard still visible after bypass + tap fallback')
                    await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'])
                    if (mainWindow) {
                        mainWindow.webContents.send('profile-switched', { profileId, success: false, wizardResult })
                    }
                    return {
                        success: false,
                        error: `Profile ${profileId} switched, but GrapheneOS setup wizard is still visible`,
                        profileId,
                        wizardResult,
                    }
                }

                console.log(`[Profile] Setup wizard cleared in ${wizardResult.bypassMs}ms (fast path${wizardResult.steps.length > 1 ? ' + tap fallback' : ''})`)
                if (mainWindow) {
                    mainWindow.webContents.send('profile-switch-progress', { step: 'setup_complete', profileId })
                }
            }

            if (!verified) {
                console.log('[Profile] Switch NOT verified — disabling airplane mode and aborting')
                // Best-effort airplane-off. Tailnet path already did it via bundled
                // script (or it failed); USB path needs this explicit call.
                if (!overTailnet) {
                    try { await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable']) } catch (_) {}
                }
                if (mainWindow) {
                    mainWindow.webContents.send('profile-switched', { profileId, success: false })
                }
                return { success: false, error: `Profile switch to ${profileId} could not be verified` }
            }

            // Step 3: Confirmed on target profile — safe to disable airplane mode.
            // 2.16.13: tailnet path's bundled script ALREADY ran airplane-off
            // (we wouldn't be here otherwise — reconnectTailnetAdb required
            // Tailscale to be back). Skip the redundant call in that case.
            if (mainWindow) {
                mainWindow.webContents.send('profile-switch-progress', { step: 'airplane_off', profileId })
            }
            if (overTailnet) {
                console.log('[Profile] Step 3: tailnet — airplane-off already ran via bundled script, skipping')
            } else {
                console.log('[Profile] Step 3: Switch verified, disabling airplane mode...')
                await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'])
                for (let i = 0; i < 8; i++) {
                    await sleep(150)
                    try {
                        const out = await executeADB(['-s', serial, 'shell', 'settings', 'get', 'global', 'airplane_mode_on'])
                        if (out.trim() === '0') break
                    } catch { /* keep polling */ }
                }
            }

            // Notify completion
            if (mainWindow) {
                mainWindow.webContents.send('profile-switched', { profileId, success: true })
            }

            console.log(`[Profile] Switch complete. Verified: ${verified}`)
            return { success: verified, profileId, wizardResult }
        } catch (error) {
            console.error('[Profile] Error switching profile:', error)

            // Try to disable airplane mode even if switch failed
            try {
                await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'])
            } catch (e) { /* ignore */ }

            return { success: false, error: error.message }
        } finally {
            if (releasePhoneLock) releasePhoneLock()
        }
    }
    _switchProfile = switchProfile
    ipcMain.handle('switch-profile', async (event, args) => switchProfile(args))

    // Create a new profile on the device + install apps
    ipcMain.handle('create-profile', async (event, serial, name, options) => {
        const copyAllApps = options?.copyAllApps === true

        try {
            console.log(`[Profile] Creating profile "${name}" on device: ${serial} (copyAllApps=${copyAllApps})`)
            const output = await executeADB(['-s', serial, 'shell', 'pm', 'create-user', '--profileOf', '0', name])
            console.log(`[Profile] Create output: ${output}`)

            const listOutput = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'])
            const userId = findCreatedProfileId(output, listOutput)
            if (!userId) {
                return {
                    success: false,
                    phase: 'verification',
                    error: output.toLowerCase().includes('success')
                        ? 'Profile creation returned success, but no numeric profile ID could be verified in pm list users'
                        : (output.trim() || 'Failed to create profile'),
                }
            }

            // Install apps into the new profile
            if (userId) {
                let appsToInstall = []

                if (copyAllApps) {
                    // List ALL packages from owner profile (user 0)
                    console.log(`[Profile] Listing all packages from main profile...`)
                    try {
                        const pkgOutput = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'packages', '--user', '0'])
                        appsToInstall = pkgOutput
                            .split('\n')
                            .map(line => line.trim().replace('package:', ''))
                            .filter(pkg => pkg.length > 0)
                        console.log(`[Profile] Found ${appsToInstall.length} packages on main profile`)
                    } catch (listErr) {
                        console.log(`[Profile] ⚠️ Failed to list packages, falling back to essentials: ${listErr.message}`)
                    }
                }

                // Fall back to essential apps if copyAllApps is off or listing failed
                if (appsToInstall.length === 0) {
                    appsToInstall = [...PROFILE_ESSENTIAL_PACKAGES]
                }

                console.log(`[Profile] Installing ${appsToInstall.length} apps for user ${userId}...`)
                let installed = 0
                for (const pkg of appsToInstall) {
                    try {
                        const installOut = await executeADB([
                            '-s', serial, 'shell', 'pm', 'install-existing', '--user', userId, pkg
                        ])
                        if (installOut && !installOut.toLowerCase().includes('error')) {
                            installed++
                        }
                    } catch (err) {
                        // Silently skip — common for system packages that can't be cloned
                    }
                }
                console.log(`[Profile] Installed ${installed}/${appsToInstall.length} apps for user ${userId}`)
            }

            return { success: true, phase: 'complete', userId, name }
        } catch (error) {
            console.error('[Profile] Error creating profile:', error)
            return { success: false, error: error.message }
        }
    })

    // Delete a profile from the device
    ipcMain.handle('delete-profile', async (event, serial, userId) => {
        const log = dependencies.log || (() => { try { return require('../lib/launcher-log') } catch (_) { return { write: () => {} } } })()
        const targetId = normalizeProfileId(userId)
        if (targetId === OWNER_PROFILE_ID) return ownerProfileProtectedResult()
        if (targetId === null) {
            return { success: false, code: 'INVALID_PROFILE_ID', phase: 'validation', error: 'A numeric non-Owner profile ID is required' }
        }
        // Fail closed on the shared per-phone lock: a human deleting a profile
        // must not owner-flip a phone that a run/sweep/switch is touching.
        let scheduleEngine
        let releasePhoneLock = null
        try {
            scheduleEngine = require('../lib/schedule-engine')
            releasePhoneLock = scheduleEngine.acquirePhoneLock(serial)
            if (!releasePhoneLock) {
                return { success: false, code: 'PHONE_BUSY', error: 'This phone is already running another automation. Profile deletion was not started.' }
            }
        } catch (error) {
            return { success: false, code: 'PHONE_COORDINATOR_UNAVAILABLE', error: error.message }
        }
        try {
            log.write('delete-profile:start', { serial, targetId })

            const currentUserRaw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
            const currentUserId = normalizeProfileId(currentUserRaw)
            if (currentUserId === null) {
                return { success: false, phase: 'current_user', error: 'Could not determine the active Android profile; deletion was not attempted' }
            }
            log.write('delete-profile:current-user', { serial, targetId, currentUserId })

            const deletingActiveProfile = currentUserId === targetId
            let safeProfileId = null
            if (deletingActiveProfile) {
                const usersBefore = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'])
                safeProfileId = findSafeProfileId(usersBefore, targetId)
                if (!safeProfileId) {
                    return { success: false, phase: 'safe_profile', error: 'No safe non-Owner profile is available after this deletion' }
                }

                log.write('delete-profile:owner-transition-start', {
                    serial,
                    targetId,
                    safeProfileId,
                    reason: 'Android cannot remove the active user',
                })
                const overTailnet = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)
                if (overTailnet) {
                    const durableOwnerSwitch = buildDurableProfileSwitchCommands(OWNER_PROFILE_ID, 'sp-delete-owner')
                    await executeADB(['-s', serial, 'shell', durableOwnerSwitch.writeCommand], 6000)
                    await executeADB(['-s', serial, 'shell', durableOwnerSwitch.spawnCommand], 6000)
                    if (!(await reconnectTailnetAdb(serial, 25000))) {
                        return { success: false, phase: 'owner_transition', error: 'Phone did not reconnect after the durable Owner transition; deletion was not attempted' }
                    }
                } else {
                    await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'], 5000)
                    await wait(1000)
                    // Human-intent Owner transition through the guard: verified
                    // start-user → switch-user → poll (the outer loop below is
                    // the belt on top of the guard's own verification).
                    await scheduleEngine.guardedSwitchUser({
                        execAdb: (adbArgs, timeoutMs) => executeADB(adbArgs, timeoutMs),
                        serial,
                        targetUser: OWNER_PROFILE_ID,
                        intent: 'human',
                        wait,
                    })
                    await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], 5000)
                }

                let onOwner = false
                for (let attempt = 0; attempt < 20; attempt++) {
                    try {
                        const c = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 3000)
                        if (String(c || '').trim() === OWNER_PROFILE_ID) { onOwner = true; break }
                    } catch (_) {}
                    await wait(750)
                }
                log.write('delete-profile:owner-transition-verified', { serial, targetId, safeProfileId, onOwner })
                if (!onOwner) {
                    return { success: false, phase: 'owner_transition', error: `Couldn't verify the temporary Owner transition before deleting profile ${targetId}` }
                }
                await wait(1500)
            }

            console.log(`[Profile] Deleting profile ID ${targetId} on device: ${serial}`)
            const output = await executeADB(['-s', serial, 'shell', 'pm', 'remove-user', targetId])
            console.log(`[Profile] Delete output: ${output}`)
            if (!String(output).toLowerCase().includes('success')) {
                log.write('delete-profile:result', { serial, targetId, success: false, output: String(output).trim().slice(0, 200) })
                return { success: false, phase: 'remove', error: String(output).trim() || `Failed to delete profile ${targetId}` }
            }

            const usersAfter = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'])
            const removalVerified = !parseUsersList(usersAfter).some((user) => user.id === targetId)
            log.write('delete-profile:removal-verified', { serial, targetId, removalVerified })
            if (!removalVerified) {
                return { success: false, phase: 'verification', error: `Android reported success, but profile ${targetId} is still enumerated` }
            }

            if (deletingActiveProfile) {
                const switchToSafeProfile = dependencies.switchProfile || switchProfile
                log.write('delete-profile:safe-transition-start', { serial, targetId, safeProfileId })
                // Pass our held lock's ownerToken so the safe restore can never
                // PHONE_BUSY against this handler's own lock and strand the
                // phone on Owner.
                const switchResult = await switchToSafeProfile({ serial, profileId: safeProfileId, phoneLockOwnerToken: releasePhoneLock.ownerToken })
                if (!switchResult?.success) {
                    return {
                        success: false,
                        deleted: true,
                        phase: 'safe_transition',
                        error: `Profile ${targetId} was deleted, but switching to safe profile ${safeProfileId} failed: ${switchResult?.error || 'unknown error'}`,
                    }
                }
                const finalUserRaw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                const finalUserId = normalizeProfileId(finalUserRaw)
                const safeTransitionVerified = finalUserId === safeProfileId && finalUserId !== OWNER_PROFILE_ID
                log.write('delete-profile:safe-transition-verified', { serial, targetId, safeProfileId, finalUserId, safeTransitionVerified })
                if (!safeTransitionVerified) {
                    return { success: false, deleted: true, phase: 'safe_transition', error: `Profile ${targetId} was deleted, but the phone did not leave Owner for safe profile ${safeProfileId}` }
                }
            }

            log.write('delete-profile:result', { serial, targetId, success: true, safeProfileId, output: String(output).trim().slice(0, 200) })
            return { success: true, phase: 'complete', output: String(output).trim(), safeProfileId }
        } catch (error) {
            console.error('[Profile] Error deleting profile:', error)
            log.write('delete-profile:error', { serial, userId, error: error?.message || String(error) })
            return { success: false, error: error.message }
        } finally {
            releasePhoneLock()
        }
    })

    // Rename a profile on the device (GrapheneOS).
    //
    // Real talk: GrapheneOS shell can't rename users. `cmd user set-user-name`
    // doesn't exist; `pm rename-user` rejects with SecurityException because
    // shell lacks MANAGE_USERS; the Settings UI doesn't expose a rename action
    // (Owner side has Switch/Delete only; target side's "You (Name)" row is a
    // "Delete yourself" prompt — destructive).
    //
    // So: store the rename locally per device+profile-id. The renderer's
    // get-device-profiles call merges these into displayName so every dropdown
    // shows the user's chosen name. The on-device name stays as-is.
    // Best-effort: still try the two service paths in case a future Android
    // version permits them — if either succeeds the on-device name updates too.
    ipcMain.handle('rename-profile', async (event, serial, userId, newName) => {
        try {
            const targetUserId = normalizeProfileId(userId)
            const trimmedName = String(newName || '').trim()
            if (targetUserId === OWNER_PROFILE_ID) return ownerProfileProtectedResult()
            if (!targetUserId) return { success: false, error: 'Profile selection is required' }
            if (!trimmedName) return { success: false, error: 'New name is required' }
            if (/['"&]/.test(trimmedName)) {
                return { success: false, error: 'Profile names cannot contain apostrophes, quotes, or ampersands.' }
            }

            console.log(`[Profile] Renaming profile ID ${targetUserId} to "${trimmedName}" on device: ${serial} (local nickname)`)

            // 2.16.23: REAL on-device rename via Settings UI automation.
            // GrapheneOS doesn't expose `cmd user set-user-name` or
            // `pm rename-user` — both return "Unknown command". The only
            // working path is Settings → Users → "You (name)" → edit dialog.
            // Requires the phone to be on the target user, since the dialog
            // only appears for "You".
            let onDeviceRenamed = false
            let renameDetail = ''
            const renameLog = dependencies.log || (() => { try { return require('../lib/launcher-log') } catch (_) { return { write: () => {} } } })()
            try {
                const currentUserRaw = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 4000)
                const currentUserId = String(currentUserRaw || '').trim()
                if (currentUserId !== targetUserId) {
                    console.log(`[Profile] Rename: phone is on user ${currentUserId}, switching to ${targetUserId} first…`)
                    const overTailnet = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)
                    if (overTailnet) {
                        const script = [
                            'cmd connectivity airplane-mode enable',
                            'sleep 1',
                            // start-user first: a stopped secondary target won't foreground from a bare switch-user.
                            `am start-user ${targetUserId}`,
                            `am switch-user ${targetUserId}`,
                            'sleep 2',
                            'cmd connectivity airplane-mode disable',
                        ].join(' ; ')
                        try { await executeADB(['-s', serial, 'shell', `(${script}) </dev/null >/dev/null 2>&1 &`], 6000) } catch (_) {}
                        // Wait for tailnet reconnect.
                        for (let attempt = 0; attempt < 30; attempt++) {
                            try {
                                await executeADB(['connect', serial], 3000).catch(() => {})
                                const out = await executeADB(['-s', serial, 'shell', 'echo', 'pong'], 2500)
                                if (String(out).trim().endsWith('pong')) break
                            } catch (_) {}
                            await sleep(500)
                        }
                    } else {
                        try {
                            await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'], 5000)
                            await sleep(1000)
                            // start-user first: a stopped secondary target won't foreground from a bare switch-user.
                            await executeADB(['-s', serial, 'shell', 'am', 'start-user', targetUserId], 5000).catch(() => {})
                            await executeADB(['-s', serial, 'shell', 'am', 'switch-user', targetUserId], 5000)
                            await sleep(2500)
                            await executeADB(['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], 5000)
                        } catch (_) {}
                    }
                    // 2.16.25: poll until am get-current-user actually matches
                    // targetUserId. Without this, we'd race into Settings while
                    // Android was still committing the user switch — leading to
                    // the "Delete X from this device" misfire Anyro saw.
                    let switched = false
                    for (let attempt = 0; attempt < 20; attempt++) {
                        try {
                            const c = await executeADB(['-s', serial, 'shell', 'am', 'get-current-user'], 3000)
                            if (String(c || '').trim() === targetUserId) { switched = true; break }
                        } catch (_) {}
                        await sleep(750)
                    }
                    if (!switched) {
                        return { success: false, error: `couldn't switch to user ${targetUserId} for rename — phone may be locked or unreachable` }
                    }
                    // Extra settle time for the home screen + system services
                    // to finish initializing the new user's session.
                    await sleep(2500)
                }

                const renameRes = await renameUserViaSettings(serial, targetUserId, trimmedName, {
                    log: renameLog,
                    wait,
                })
                onDeviceRenamed = !!renameRes.ok
                renameDetail = renameRes.error || ''
                if (onDeviceRenamed) {
                    console.log(`[Profile] On-device rename via Settings UI succeeded: ${renameRes.currentName} → ${trimmedName}`)
                } else {
                    console.warn(`[Profile] On-device rename via Settings UI failed: ${renameDetail}`)
                }
            } catch (err) {
                try { await executeADB(['-s', serial, 'shell', 'am', 'force-stop', 'com.android.settings'], 4000) } catch (_) {}
                renameLog.write('rename:end', {
                    serial,
                    targetUserId,
                    ok: false,
                    error: err?.message || String(err),
                })
                console.warn('[Profile] rename-via-settings exception; nickname was not persisted:', err?.message || err)
                renameDetail = err?.message || String(err)
            }

            // 2.17.22: surface on-device failure honestly. Previously this
            // always returned success:true (because local nickname always
            // works) → renderer showed "renamed" toast even when the on-
            // device dialog was stuck open. Now if on-device fails, return
            // success:false with the real reason so the operator knows to
            // investigate (and the toast doesn't lie).
            if (!onDeviceRenamed) {
                return {
                    success: false,
                    phase: 'device_rename',
                    error: `on-device rename failed: ${renameDetail || 'unknown'}`,
                    local: false,
                    userId: targetUserId,
                    name: trimmedName,
                }
            }

            if (!profileNicknames[serial]) profileNicknames[serial] = {}
            profileNicknames[serial][targetUserId] = trimmedName
            saveProfileNicknames()
            // 2.18.6: also rename the local content folder to match. Looks
            // up by profileId (stable key in each profile folder's _meta.json)
            // so it works regardless of what the folder was named before.
            // Best-effort: failure here doesn't fail the rename overall.
            let folderRenameResult = null
            try {
                const { renameProfileFolderForId } = require('../lib/content-paths')
                const contentRoot = require('path').join(app.getPath('userData'), 'Content')
                folderRenameResult = renameProfileFolderForId(contentRoot, targetUserId, trimmedName)
                require('../lib/launcher-log').write('rename:folder-sync', {
                    serial, targetUserId, newName: trimmedName, result: folderRenameResult,
                })
            } catch (e) {
                require('../lib/launcher-log').write('rename:folder-sync-error', {
                    serial, targetUserId, error: e?.message || String(e),
                })
            }

            return {
                success: true,
                output: `Renamed profile ${targetUserId} to "${trimmedName}" (on-device + local${folderRenameResult?.ok ? ' + folder' : ''})`,
                userId: targetUserId,
                name: trimmedName,
                folderRenamed: !!folderRenameResult?.ok,
                folderNewPath: folderRenameResult?.newPath || null,
            }
        } catch (error) {
            console.error('[Profile] Error renaming profile:', error)
            return { success: false, error: error.message }
        }
    })

    // Get profile nickname overrides for a specific device.
    ipcMain.handle('get-profile-nicknames', async (event, serial) => {
        const bucket = profileNicknames[serial] || {}
        return { ...bucket }
    })

    // Set or clear a single profile nickname (empty string clears the override).
    ipcMain.handle('set-profile-nickname', async (event, serial, profileId, nickname) => {
        if (!serial || !profileId) return { success: false, error: 'serial and profileId are required' }
        if (normalizeProfileId(profileId) === OWNER_PROFILE_ID) return ownerProfileProtectedResult()
        const trimmed = typeof nickname === 'string' ? nickname.trim() : ''
        if (!profileNicknames[serial]) profileNicknames[serial] = {}
        if (trimmed) {
            profileNicknames[serial][String(profileId)] = trimmed
        } else {
            delete profileNicknames[serial][String(profileId)]
            if (Object.keys(profileNicknames[serial]).length === 0) delete profileNicknames[serial]
        }
        saveProfileNicknames()
        return { success: true, nickname: trimmed || null }
    })

    // Get profiles (alias for backward compatibility). Now merges nickname
    // overrides too so any old callsite reading `name` shows the friendly label.
    ipcMain.handle('get-profiles', async (event, serial) => {
        try {
            console.log(`[Profile] Getting profiles for device: ${serial}`)
            const output = await executeADB(['-s', serial, 'shell', 'pm', 'list', 'users'])

            const profiles = []
            const lines = output.split('\n')

            for (const line of lines) {
                const match = line.match(/UserInfo\{(\d+):([^:}]+)/)
                if (match) {
                    const [, id, name] = match
                    if (id === OWNER_PROFILE_ID) continue
                    const originalName = (name === 'Primary' || name === 'null' || id === '0') ? 'Owner' : name
                    const displayName = buildProfileDisplayName(serial, id, originalName)
                    profiles.push({
                        id,
                        name: displayName,
                        originalName,
                        nickname: getProfileNickname(serial, id),
                        displayName,
                    })
                }
            }

            console.log(`[Profile] Found ${profiles.length} profiles:`, profiles.map(p => p.displayName).join(', '))
            return profiles
        } catch (error) {
            console.error('[Profile] Error getting profiles:', error)
            return []
        }
    })
}

module.exports = {
    initProfileHandlers,
    switchProfile: (args) => _switchProfile(args),
    buildDurableProfileSwitchCommands,
    findCreatedProfileId,
    findSafeProfileId,
    normalizeProfileId,
}
