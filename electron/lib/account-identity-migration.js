'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { normalizeHandle } = require('./account-switcher-parser')

function readJson(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
        if (fallback !== null && error.code === 'ENOENT') return fallback
        throw error
    }
}

function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(temp, file)
}

function identityKey(locator, handle = locator.handle) {
    return [locator.serial, String(locator.userId), locator.platform || 'instagram', normalizeHandle(handle)].join('::')
}

function accountEntry(registry, locator, handle) {
    return registry.devices?.[locator.serial]?.profiles?.[String(locator.userId)]?.accounts?.[handle]
}

function beginIdentityChange(registryPath, locator, requestedHandle, now = Date.now) {
    const oldHandle = normalizeHandle(locator.handle)
    const nextHandle = normalizeHandle(requestedHandle)
    if (!oldHandle || !nextHandle) throw new Error('A valid old and requested Instagram handle are required.')

    const registry = readJson(registryPath)
    if (!accountEntry(registry, locator, oldHandle)) {
        throw new Error(`Instagram account @${oldHandle} was not found in the fleet registry.`)
    }

    const key = identityKey(locator, oldHandle)
    const pending = {
        key,
        serial: locator.serial,
        userId: String(locator.userId),
        platform: locator.platform || 'instagram',
        oldHandle,
        requestedHandle: nextHandle,
        startedAt: now(),
        status: 'pending',
    }
    registry.pendingIdentityChanges = registry.pendingIdentityChanges || {}
    registry.pendingIdentityChanges[key] = pending
    writeJsonAtomic(registryPath, registry)
    return pending
}

function failIdentityChange(registryPath, key, error, now = Date.now) {
    const registry = readJson(registryPath)
    const pending = registry.pendingIdentityChanges?.[key]
    if (!pending) return false
    registry.pendingIdentityChanges[key] = {
        ...pending,
        status: 'failed',
        error: String(error || 'Instagram username change failed.'),
        finishedAt: now(),
    }
    writeJsonAtomic(registryPath, registry)
    return true
}

function listFiles(root, base = root) {
    if (!fs.existsSync(root)) return []
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(root, entry.name)
        if (entry.isDirectory()) return listFiles(full, base)
        return [{ full, relative: path.relative(base, full) }]
    })
}

function assertNoContentConflicts(oldDir, newDir) {
    if (!fs.existsSync(oldDir) || !fs.existsSync(newDir)) return
    for (const file of listFiles(oldDir)) {
        const target = path.join(newDir, file.relative)
        if (!fs.existsSync(target)) continue
        if (!fs.readFileSync(file.full).equals(fs.readFileSync(target))) {
            throw new Error(`Content conflict prevents account rename: ${file.relative}`)
        }
    }
}

function migrateContent(accountRoot, oldHandle, newHandle) {
    const root = path.resolve(accountRoot)
    const oldDir = path.resolve(root, oldHandle)
    const newDir = path.resolve(root, newHandle)
    if (path.dirname(oldDir) !== root || path.dirname(newDir) !== root) {
        throw new Error('Account content path escaped its profile folder.')
    }
    if (!fs.existsSync(oldDir)) return

    assertNoContentConflicts(oldDir, newDir)
    if (!fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir)
        return
    }

    for (const file of listFiles(oldDir)) {
        const target = path.join(newDir, file.relative)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (!fs.existsSync(target)) fs.renameSync(file.full, target)
    }
    fs.rmSync(oldDir, { recursive: true, force: true })
}

function rewriteInsightAccount(line, newHandle) {
    if (!line.trim()) return ''
    try {
        const row = JSON.parse(line)
        row.account = newHandle
        return JSON.stringify(row)
    } catch {
        return line
    }
}

function migrateInsights(userDataPath, oldHandle, newHandle) {
    const dir = path.join(userDataPath, 'insights')
    const oldSeries = path.join(dir, `${oldHandle}.jsonl`)
    const newSeries = path.join(dir, `${newHandle}.jsonl`)
    if (fs.existsSync(oldSeries)) {
        const oldLines = fs.readFileSync(oldSeries, 'utf8').split(/\r?\n/)
            .map((line) => rewriteInsightAccount(line, newHandle))
            .filter(Boolean)
        const newLines = fs.existsSync(newSeries)
            ? fs.readFileSync(newSeries, 'utf8').split(/\r?\n/).filter(Boolean)
            : []
        fs.writeFileSync(newSeries, [...new Set([...newLines, ...oldLines])].join('\n') + '\n', 'utf8')
        fs.unlinkSync(oldSeries)
    }

    const oldLatest = path.join(dir, `${oldHandle}.latest.json`)
    const newLatest = path.join(dir, `${newHandle}.latest.json`)
    if (fs.existsSync(oldLatest)) {
        const latest = readJson(oldLatest)
        latest.account = newHandle
        if (!fs.existsSync(newLatest)) writeJsonAtomic(newLatest, latest)
        fs.unlinkSync(oldLatest)
    }
}

function migrateSchedules(userDataPath, locator, oldHandle, newHandle, serialAliases) {
    const file = path.join(userDataPath, 'sidebar-schedules.json')
    const schedules = readJson(file, {})
    const aliases = new Set((serialAliases || [locator.serial]).map(String))
    const suffix = `::${locator.userId}::${locator.platform || 'instagram'}::${oldHandle}`

    for (const [key, row] of Object.entries({ ...schedules })) {
        if (!key.endsWith(suffix)) continue
        const serial = key.slice(0, -suffix.length)
        if (!aliases.has(serial)) continue
        const nextKey = `${serial}::${locator.userId}::${locator.platform || 'instagram'}::${newHandle}`
        if (schedules[nextKey] && JSON.stringify(schedules[nextKey]) !== JSON.stringify(row)) {
            throw new Error(`Schedule conflict prevents account rename: ${nextKey}`)
        }
        schedules[nextKey] = {
            ...row,
            account: row.account ? newHandle : row.account,
            account_id: newHandle,
            account_username: row.account_username ? newHandle : row.account_username,
        }
        delete schedules[key]
    }
    writeJsonAtomic(file, schedules)
}

function commitIdentityChange(options) {
    const {
        registryPath,
        userDataPath,
        accountRoot,
        locator,
        verifiedHandle,
        serialAliases,
    } = options
    const oldHandle = normalizeHandle(locator.handle)
    const newHandle = normalizeHandle(verifiedHandle)
    const key = identityKey(locator, oldHandle)
    const registry = readJson(registryPath)
    const pending = registry.pendingIdentityChanges?.[key]

    if (!pending) throw new Error('No pending Instagram identity change was found.')
    if (newHandle !== pending.requestedHandle) {
        throw new Error(`Verified Instagram handle @${newHandle || 'unknown'} did not match requested @${pending.requestedHandle}.`)
    }

    const profile = registry.devices?.[locator.serial]?.profiles?.[String(locator.userId)]
    const oldAccount = profile?.accounts?.[oldHandle]
    if (!profile || !oldAccount) throw new Error(`Instagram account @${oldHandle} was not found during migration.`)
    if (profile.accounts[newHandle] && newHandle !== oldHandle) {
        throw new Error(`Fleet registry already contains @${newHandle} on this Android profile.`)
    }

    const oldDir = path.join(accountRoot, oldHandle)
    const newDir = path.join(accountRoot, newHandle)
    assertNoContentConflicts(oldDir, newDir)

    registry.pendingIdentityChanges[key] = { ...pending, status: 'committing' }
    writeJsonAtomic(registryPath, registry)

    migrateContent(accountRoot, oldHandle, newHandle)
    migrateInsights(userDataPath, oldHandle, newHandle)
    migrateSchedules(userDataPath, locator, oldHandle, newHandle, serialAliases)

    profile.accounts[newHandle] = { ...oldAccount, handle: newHandle }
    if (newHandle !== oldHandle) delete profile.accounts[oldHandle]
    delete registry.pendingIdentityChanges[key]
    writeJsonAtomic(registryPath, registry)

    return {
        oldHandle,
        newHandle,
        migrated: ['content', 'insights', 'schedules', 'registry'],
    }
}

async function recoverPendingIdentityChanges(options) {
    const {
        registryPath,
        userDataPath,
        serial,
        userId,
        platform = 'instagram',
        verifiedHandles,
        resolveAccountRoot,
        serialAliases,
    } = options
    const verified = new Set((verifiedHandles || []).map(normalizeHandle).filter(Boolean))
    const initial = readJson(registryPath)
    const pending = Object.values(initial.pendingIdentityChanges || {}).filter((entry) => (
        entry
        && entry.serial === serial
        && String(entry.userId) === String(userId)
        && (entry.platform || 'instagram') === platform
        && ['pending', 'committing'].includes(entry.status)
        && verified.has(entry.requestedHandle)
    ))
    const recovered = []
    const failed = []

    for (const entry of pending) {
        try {
            const accountRoot = await resolveAccountRoot(entry)
            if (!accountRoot) throw new Error('The account content folder could not be resolved.')
            const result = commitIdentityChange({
                registryPath,
                userDataPath,
                accountRoot,
                locator: {
                    serial: entry.serial,
                    userId: entry.userId,
                    platform: entry.platform,
                    handle: entry.oldHandle,
                },
                verifiedHandle: entry.requestedHandle,
                serialAliases,
            })
            recovered.push({ oldHandle: result.oldHandle, newHandle: result.newHandle })
        } catch (error) {
            failed.push({
                oldHandle: entry.oldHandle,
                newHandle: entry.requestedHandle,
                error: error?.message || String(error),
            })
        }
    }

    return { registry: readJson(registryPath), recovered, failed }
}

module.exports = {
    beginIdentityChange,
    commitIdentityChange,
    failIdentityChange,
    recoverPendingIdentityChanges,
}
