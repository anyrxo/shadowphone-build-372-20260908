function normalizeHandle(value) {
    const handle = String(value || '').trim().replace(/^@+/, '').toLowerCase()
    return /^[a-z0-9._]{1,30}$/.test(handle) ? handle : null
}

function parseAttributes(tag) {
    return Object.fromEntries(
        [...String(tag || '').matchAll(/([\w:-]+)="([^"]*)"/g)]
            .map((match) => [match[1], match[2]]),
    )
}

function isAccountRow(attrs) {
    return /(?:row_user_primary_name|account_switcher.*(?:username|primary_name))/i
        .test(attrs['resource-id'] || '')
}

function parseAccountSwitcher(xml) {
    const source = String(xml || '')
    const nodes = [...source.matchAll(/<node\b[^>]*>/gi)]
        .map((match) => parseAttributes(match[0]))
    const modernSheet = /(?:text|content-desc)="Add Instagram account"/i.test(source)
        && /(?:text|content-desc)="(?:Go to Accounts Center|Dismiss)"/i.test(source)
    const rows = nodes.filter((attrs) => (
        isAccountRow(attrs)
        || (modernSheet
            && attrs.class === 'android.view.ViewGroup'
            && attrs.clickable === 'true'
            && normalizeHandle(attrs['content-desc']))
    ))

    const verified = /Switch accounts|account switcher/i.test(source) || modernSheet || rows.length > 0
    if (!verified) return { verified: false, active: null, accounts: [] }

    const accounts = [...new Set(
        rows
            .map((attrs) => normalizeHandle(attrs.text || attrs['content-desc']))
            .filter(Boolean),
    )]
    const activeRow = rows.find((attrs) => attrs.selected === 'true' || attrs.checked === 'true')

    return {
        verified: true,
        active: normalizeHandle(activeRow?.text || activeRow?.['content-desc']),
        accounts,
    }
}

function readProfileUsername(xml) {
    const source = String(xml || '')
    const profileReady = /(?:text|content-desc)="(?:Edit profile|Share profile)"/i.test(source)
        || /content-desc="[^"]*professional dashboard entry point/i.test(source)
    if (!profileReady) return null

    const title = [...source.matchAll(/<node\b[^>]*>/gi)]
        .map((match) => parseAttributes(match[0]))
        .find((attrs) => /(?:action_bar_title|action_bar_username)$/i.test(attrs['resource-id'] || ''))

    return normalizeHandle(title?.text || title?.['content-desc'])
}

module.exports = { normalizeHandle, parseAccountSwitcher, readProfileUsername }
