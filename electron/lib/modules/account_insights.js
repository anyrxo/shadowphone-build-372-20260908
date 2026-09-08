// desktop/lib/modules/account_insights.js
// ── Handler: account_insights ─────────────────────────────────────────────────
// Navigates the IG Professional Dashboard → Insights and scrapes Overview /
// Content / Audience via uiautomator dump-parse (NOT OCR — every value is in the
// dump text). Detects business-vs-personal: a profile with NO "Professional
// dashboard entry point" is a PERSONAL account and is flagged + skipped.
//
// Selectors live-discovered + the parser perfected on a real phone 2026-05-31
// (eileenswrld@user24, 1080x2400) via brain/scripts/ig_insights_probe.py — this
// is the JS port that runs LOCALLY from the dashboard (no runtime Python),
// driven by a LocalDevice (adb) exactly like detect_accounts.js.

const { sleep, parseStatsFromXml, parseStatNumber } = require('../local-modules-shared')

const IG_PKG = 'com.instagram.android'
// tap centers (1080x2400) — see memory reference-ig-professional-dashboard
const PROFILE_TAB    = { x: 972, y: 2274 }
const PRO_DASH_ENTRY = { x: 259, y: 790 }
const INSIGHTS_DRILL = { x: 540, y: 508 }
const TAB = { overview: { x: 180, y: 331 }, content: { x: 540, y: 331 }, audience: { x: 900, y: 331 } }
const PRO_DASH_DESC = 'professional dashboard entry point'

// ── pure parsers (exported for unit testing) ──────────────────────────────────

// Parse each <node .../> element WHOLE so text AND content-desc are both captured
// (uiautomator emits text= before content-desc=; a single combined regex would
// swallow the second). An element can yield a text node and/or a content-desc node.
function parseNodes(xml) {
    const out = []
    const re = /<node\b[^>]*?\/?>/g
    let el
    while ((el = re.exec(xml || '')) !== null) {
        const s = el[0]
        const b = s.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
        if (!b) continue
        const x1 = +b[1], y1 = +b[2], x2 = +b[3], y2 = +b[4]
        const cx = (x1 + x2) >> 1, cy = (y1 + y2) >> 1
        for (const [kind, attr] of [['text', 'text'], ['content-desc', 'content-desc']]) {
            const mv = s.match(new RegExp(attr + '="([^"]*)"'))
            if (mv && mv[1].trim()) out.push({ k: kind, t: mv[1], cx, cy, y1, x1 })
        }
    }
    return out
}

function texts(nodes) { return nodes.filter(n => n.k === 'text') }
function hasDesc(nodes, desc) {
    const d = desc.toLowerCase()
    return nodes.some(n => n.k === 'content-desc' && n.t.toLowerCase().includes(d))
}
// Center {x,y} of a content-desc node, so we tap the ACTUAL element, not a
// hardcoded coord. Profile layouts vary (extra "Add banners"/"name & bio" rows
// shift the Professional-dashboard button) — a fixed coord taps the wrong thing.
function descCenter(nodes, desc) {
    const d = desc.toLowerCase()
    const n = nodes.find(x => x.k === 'content-desc' && x.t.toLowerCase().includes(d))
    return n ? { x: n.cx, y: n.cy } : null
}
// The foreground account's @handle from the profile title bar (top-center text
// node, e.g. "jocelynbuns" at y1~128, cx~525). Used to VERIFY ig_account_switch
// actually landed on the target — else we'd scrape whoever is foreground and
// store their stats under the wrong handle (observed: 2 accounts, identical data).
function foregroundHandle(nodes) {
    const n = nodes.find(x => x.k === 'text' && x.y1 < 210 && x.cx > 300 && x.cx < 780
        && /^[a-zA-Z0-9_.]{2,30}$/.test(x.t))
    return n ? n.t : null
}

function parseProfileStats(xml) {
    const parsed = parseStatsFromXml(xml || '') || {}
    const normalized = value => value == null ? null : parseStatNumber(value)
    let posts = parsed.posts
    if (posts == null) {
        for (const match of String(xml || '').matchAll(/<node\b[^>]*>/gi)) {
            const node = match[0]
            if (!/resource-id="[^"]*post_count_value"/i.test(node)) continue
            posts = node.match(/text="([^"]+)"/i)?.[1] ?? null
            break
        }
    }
    return {
        followers: normalized(parsed.followers),
        following: normalized(parsed.following),
        posts: normalized(posts),
    }
}

function verificationPromptLabels(xml) {
    const stack = [], labels = []
    let navigationVisible = false
    for (const match of String(xml || '').matchAll(/<\/?node\b[^>]*>/gi)) {
        const tag = match[0]
        if (/^<\//.test(tag)) { stack.pop(); continue }
        const attrs = Object.fromEntries(Array.from(tag.matchAll(/([\w:-]+)=(["'])(.*?)\2/gs), pair => [pair[1], pair[3]]))
        const id = String(attrs['resource-id'] || '').toLowerCase()
        const parent = stack[stack.length - 1]
        const content = parent?.content || /row_feed_|feed_timeline|feed_recycler|comment|caption|profile_header|direct_text|direct_thread|chat_thread|message_text|story.*text|reel.*text/.test(id)
            || attrs.class === 'android.widget.EditText' || attrs['visible-to-user'] === 'false'
        const prompt = parent?.prompt || /challenge|checkpoint|bloks_container|dialog_container|bottom_sheet_container/.test(id)
        if (attrs.selected === 'true' && /(?:feed|profile|reels|search)_tab$/.test(id)) navigationVisible = true
        if (!content) {
            for (const value of [attrs.text, attrs['content-desc']]) {
                if (value) labels.push({ prompt, text: value.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/&apos;|&#39;|&#x27;/g, "'") })
            }
        }
        if (!/\/\s*>$/.test(tag)) stack.push({ content, prompt })
    }
    // An instruction over a visible feed must belong to a challenge/modal surface.
    return labels.filter(label => !navigationVisible || label.prompt).map(label => label.text)
}

function detectVerificationState(xml) {
    const labels = verificationPromptLabels(xml)
    const screen = labels.join(' ')
    if (screen.includes('we suspended your account')
        || screen.includes('permanently disable your account')
        || screen.includes('your account has been disabled')) {
        return { required: true, type: 'suspended', reason: 'account_suspended' }
    }
    if (labels.some(label => /^(?:(?:take|record|upload) a (?:video )?selfie\b|video selfie verification\b|face verification\b)/.test(label))) {
        return { required: true, type: 'selfie', reason: 'selfie_verification_required' }
    }
    if (labels.some(label => /^confirm (?:you're|you are) human\b/.test(label))) {
        return { required: true, type: 'human', reason: 'human_verification_required' }
    }
    if (screen.includes('confirm your identity')
        || screen.includes('help us confirm')
        || screen.includes('enter security code') || screen.includes('verify your identity')
        || screen.includes("confirm it's you") || screen.includes('challenge required')) {
        return { required: true, type: 'verification', reason: 'identity_verification_required' }
    }
    return null
}

function verificationOutcome(state, data = {}) {
    const guidance = state.type === 'suspended'
        ? 'Instagram suspended this account. Review it manually on the phone or choose another account.'
        : state.type === 'selfie'
            ? 'Instagram requires a selfie or face check. Complete it manually on the phone or choose another account.'
            : state.type === 'human'
                ? 'Instagram requires human confirmation. Complete it manually on the phone or choose another account.'
                : 'Instagram requires account verification. Complete it manually on the phone or choose another account.'
    return {
        success: false,
        code: 'verification_required',
        error: `verification_required: ${guidance}`,
        verification_required: true,
        data: {
            ...data,
            verification_required: true,
            verification_type: state.type,
            reason: state.reason,
            manual_action_required: true,
            recovery_required: false,
        },
    }
}
// Switch the foreground IG account via the RELIABLE in-app switcher: long-press the
// profile tab to open the account-switcher sheet (same mechanism detect_accounts
// uses), then tap the target username row. The shared ig_account_switch module taps
// the hamburger/Settings menu instead, which silently no-ops — so account_insights
// self-corrects here when it lands on the wrong account.
async function switchToAccount(device, target) {
    device.shell(`input swipe ${PROFILE_TAB.x} ${PROFILE_TAB.y} ${PROFILE_TAB.x} ${PROFILE_TAB.y} 800`)
    await sleep(1700)
    await device.getScreen()
    // Exact match first (content-desc, then text) so a prefix-colliding handle
    // ('jocelyn' vs 'jocelynbuns') can't tap the wrong row; fall back to the
    // substring finder so we never regress when an exact row isn't present.
    const el = (device.findElementByExactContentDesc && device.findElementByExactContentDesc(target))
            || (device.findElementByExactText && device.findElementByExactText(target))
            || (device.findElementByText ? device.findElementByText(target) : null)
    if (el) {
        await device.tap(el.x, el.y, 1600)
        await device.dismissCommonPopups()
        return true
    }
    await device.back(); await sleep(400)   // close the sheet if the target isn't listed
    return false
}

// '256,142'->256142 ; '253K'->253000 ; '2.4K'->2400 ; '+3,204'->3204 ; '10.5%'->10.5 ; else null
function num(raw) {
    let s = String(raw).trim()
    const pct = s.endsWith('%')
    s = s.replace(/%/g, '').replace(/\+/g, '').replace(/,/g, '').trim()
    let mult = 1
    const last = s.slice(-1).toUpperCase()
    if (last === 'K') { mult = 1000; s = s.slice(0, -1) }
    else if (last === 'M') { mult = 1e6; s = s.slice(0, -1) }
    if (s === '' || isNaN(Number(s))) return null
    const v = Number(s) * mult
    return (pct || (s.includes('.') && mult === 1)) ? Math.round(v * 100) / 100 : Math.round(v)
}

function valueBelow(tnodes, label, maxDy = 130, xTol = 140) {
    let best = null, bestDy = Infinity
    for (const n of tnodes) {
        const dy = n.cy - label.cy
        if (dy > 0 && dy <= maxDy && Math.abs(n.cx - label.cx) <= xTol && num(n.t) !== null && dy < bestDy) {
            best = n; bestDy = dy
        }
    }
    return best
}
function valueRight(tnodes, label, maxDy = 75) {
    let best = null, bestX = -1
    for (const n of tnodes) {
        if (Math.abs(n.cy - label.cy) <= maxDy && n.cx > label.cx && num(n.t) !== null && n.cx > bestX) {
            best = n; bestX = n.cx
        }
    }
    return best
}

const CARD_LABELS = ['Views', 'Net followers', 'Interactions', 'Accounts reached',
    'Accounts engaged', 'Profile activity', 'Profile visits', 'Viewers']
const CONTENT_TYPES = ['Reels', 'Stories', 'Posts', 'Live videos', 'Carousels']
const AGE_BANDS = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+']
const AGE_RE = /^\d+[hdwm]$/
const LOC_SKIP = new Set(['Women', 'Men', 'Overview', 'Content', 'Audience', 'Countries', 'Cities',
    'Top locations', 'Followers', 'Non-followers', 'Follower active times',
    'Follower growth over time', 'Overall', 'Follows', 'Unfollows', 'Gender',
    'Age range', 'Top content by follows', 'See all'])

function parseOverview(t) {
    const out = { metrics: {}, views_by_type: {} }
    for (const lbl of CARD_LABELS) for (const n of t.filter(x => x.t === lbl)) {
        const v = valueBelow(t, n) || valueRight(t, n)
        if (v && out.metrics[lbl] === undefined) out.metrics[lbl] = num(v.t)
    }
    for (const n of t) if (CONTENT_TYPES.includes(n.t)) {
        const v = valueRight(t, n)
        if (v && out.views_by_type[n.t] === undefined) out.views_by_type[n.t] = num(v.t)
    }
    return out
}

function parseAudience(t) {
    const out = { gender: {}, age: {}, countries: {} }
    // Followers = the big number directly BELOW the "Followers" header label — NOT
    // any 3-digit number near the top (that grabbed a "Top content by follows"
    // thumbnail count, e.g. 508). The audience header is the only "Followers" label;
    // "Top content by follows" / "Follows"/"Unfollows" use different text.
    const folLabels = t.filter(x => x.t === 'Followers').sort((a, b) => a.y1 - b.y1)
    for (const fl of folLabels) {
        const v = valueBelow(t, fl, 170, 220)
        if (v) { out.followers = num(v.t); break }
    }
    for (const n of t) {
        const m = n.t.match(/^([+\-]?\d+(\.\d+)?)%\s+since\s+(.+)/)
        if (m && out.growth_pct === undefined) { out.growth_pct = Number(m[1]); out.growth_since = m[3] }
    }
    for (const g of ['Women', 'Men']) for (const n of t.filter(x => x.t === g)) {
        const v = valueRight(t, n); if (v && out.gender[g] === undefined) out.gender[g] = num(v.t)
    }
    for (const band of AGE_BANDS) for (const n of t.filter(x => x.t === band)) {
        const v = valueRight(t, n); if (v && out.age[band] === undefined) out.age[band] = num(v.t)
    }
    for (const n of t) {
        if (n.t.length >= 4 && /^[A-Z][A-Za-z .'&-]+$/.test(n.t) && !LOC_SKIP.has(n.t)) {
            const v = valueRight(t, n)
            if (v && v.t.endsWith('%') && out.countries[n.t] === undefined) out.countries[n.t] = num(v.t)
        }
    }
    return out
}

// ── LEGACY "Views" insights layout (creator/small-business: a single scrolling
// donut screen with NO Overview/Content/Audience tabs). Different, simpler field
// set. Reuses num/valueBelow/valueRight. Live-discovered 2026-05-31 on jocelynbuns.
const LEGACY_SKIP = new Set(['Top cities', 'Top countries', 'Audience', 'Followers',
    'Non-followers', 'Accounts reached', 'Profile activity', 'Profile visits',
    'External link taps', 'Views', 'Last 30 days'])
const LEGACY_NAME_RE = /^[A-Z][A-Za-z .&-]+$/

function parseLegacyInsights(t) {
    const out = { top_cities: {}, top_countries: {} }
    for (const n of t.filter(x => x.t === 'Views')) {
        const v = valueBelow(t, n, 140, 160)
        if (v && out.views === undefined) out.views = num(v.t)
    }
    for (const lbl of t.filter(x => x.t === 'Followers')) {
        const v = valueRight(t, lbl)
        if (v && v.t.endsWith('%') && out.followers_pct === undefined) out.followers_pct = num(v.t)
    }
    for (const lbl of t.filter(x => x.t === 'Non-followers')) {
        const v = valueRight(t, lbl)
        if (v && v.t.endsWith('%') && out.non_followers_pct === undefined) out.non_followers_pct = num(v.t)
    }
    for (const lbl of t.filter(x => x.t === 'Accounts reached')) {
        const v = valueRight(t, lbl)
        if (v && !v.t.endsWith('%') && out.accounts_reached === undefined) out.accounts_reached = num(v.t)
    }
    for (const lbl of t.filter(x => x.t === 'Profile visits')) {
        const v = valueRight(t, lbl)
        if (v && !v.t.endsWith('%') && out.profile_visits === undefined) out.profile_visits = num(v.t)
    }
    for (const lbl of t.filter(x => x.t === 'External link taps')) {
        const v = valueRight(t, lbl)
        if (v && !v.t.endsWith('%') && out.external_link_taps === undefined) out.external_link_taps = num(v.t)
    }
    // Top cities: name (left card, cx<760) paired with the % in the shared %-column
    // (cx 760-960) on the same row. NOTE: "Top countries" is a SEPARATE card scrolled
    // off horizontally — its real % isn't in a vertical dump (pairing country names
    // with the cities %-column gives WRONG numbers), so we deliberately skip it here
    // rather than store misleading data. Cities + the headline metrics are reliable.
    const cityPct = t.filter(x => x.t.endsWith('%') && num(x.t) !== null && x.cx > 760 && x.cx < 960)
    const rowPct = (name) => cityPct.find(p => p.cy - name.cy > 0 && p.cy - name.cy <= 60)
    const cityLabel = t.find(x => x.t === 'Top cities')
    if (cityLabel) for (const n of t) {
        if (n.cx >= 760 || n.cy <= cityLabel.cy || n.t.endsWith('%')) continue
        if (!LEGACY_NAME_RE.test(n.t) || LEGACY_SKIP.has(n.t)) continue
        const pv = rowPct(n)
        if (pv && out.top_cities[n.t] === undefined) out.top_cities[n.t] = num(pv.t)
    }
    return out
}

function detectInsightsLayout(t) {
    const has = (s) => t.some(n => n.t === s)
    if (has('Overview') && has('Content')) return 'tabbed'
    if (has('Accounts reached') && has('Non-followers')) return 'legacy'
    return 'unknown'
}

function parseContent(t) {
    const posts = []
    for (const n of t) {
        if (n.t !== 'Views') continue
        let val = null
        for (const x of t) {
            const dy = n.cy - x.cy
            if (dy > 0 && dy <= 70 && Math.abs(x.cx - n.cx) <= 120 && num(x.t) !== null) { val = x; break }
        }
        if (!val) continue
        const band = t.filter(x => Math.abs(x.cy - val.cy) <= 80 && x.cx < 760 && x !== val)
        const ageNode = band.find(x => AGE_RE.test(x.t))
        const caps = band.filter(x => !AGE_RE.test(x.t) && num(x.t) === null && x.t.length > 2).map(x => x.t)
        const caption = caps.length ? caps.reduce((a, b) => (b.length > a.length ? b : a)) : ''
        const age = ageNode ? ageNode.t : ''
        posts.push({ views: num(val.t), caption, age, sig: caption + '|' + age + '|' + num(val.t) })
    }
    return { posts }
}

// Deep-merge parsed dict PER SCROLL (never merge raw nodes across scrolls — positions
// shift). Scalars: first real value wins. Lists: extend + dedupe by sig.
function mergeParsed(acc, next) {
    for (const k of Object.keys(next)) {
        const v = next[k]
        if (Array.isArray(v)) {
            const cur = acc[k] || (acc[k] = [])
            const sigs = new Set(cur.map(p => p.sig))
            for (const item of v) if (!sigs.has(item.sig)) { cur.push(item); sigs.add(item.sig) }
        } else if (v && typeof v === 'object') {
            mergeParsed(acc[k] || (acc[k] = {}), v)
        } else if (acc[k] === undefined || acc[k] === null || acc[k] === 0 || acc[k] === '') {
            acc[k] = v
        }
    }
    return acc
}

// ── live scrape (drives the device) ───────────────────────────────────────────
async function scrapeTab(device, tab, parser, scrolls, opts = {}) {
    const passes = opts.passes || 1
    const settle = opts.settle || 2600
    device.shell(`input tap ${tab.x} ${tab.y}`)
    await sleep(settle)
    const acc = {}
    // A cold IG lazy-loads charts/bars: the first scroll-down dumps each section
    // while it's still a skeleton, then it loads after we've scrolled below it and
    // never gets re-dumped (gender/middle-age/followers go missing while the bottom
    // — countries — captures fine). A SECOND pass scrolls back over now-loaded
    // content; mergeParsed keeps the first non-empty, so the 2nd pass fills the gaps.
    for (let pass = 0; pass < passes; pass++) {
        // ALWAYS start a pass at the ABSOLUTE top. IG can open a tab deep-scrolled
        // (mirroring the prior tab's offset — observed: Audience opens at the bottom),
        // so fling up HARD with big swipes; extra swipes at the top are no-ops. Then
        // settle so the header (Followers/growth) paints before the first dump.
        for (let k = 0; k < scrolls + 10; k++) { device.shell('input swipe 540 700 540 2000 250'); await sleep(140) }
        await sleep(pass === 0 ? settle : 2600)
        for (let i = 0; i <= scrolls; i++) {
            await device.getScreen()
            mergeParsed(acc, parser(texts(parseNodes(device.currentScreen || ''))))
            if (i < scrolls) { device.shell('input swipe 540 1650 540 930 450'); await sleep(1500) }
        }
    }
    if (acc.posts) acc.post_count = acc.posts.length
    return acc
}

async function waitForForeground(device, pkg, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const fg = device.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
            if (fg && fg.includes(pkg)) return true
        } catch {}
        await sleep(200)
    }
    return false
}

// Trace to stdout (npm log) so a run can be watched live WITHOUT extra uiautomator
// dumps — reuses the module's own dumps, so no dump contention with the scrape.
const _trace = (m) => { if (process.env.SP_INSIGHTS_TRACE) console.log('[insights-trace] ' + m) }

// Poll the profile screen until it has actually RENDERED: the title-bar @handle is
// present AND either the Professional-dashboard entry (business) or an Edit/Share
// profile marker (personal) is visible. A cold relaunch under fleet load can leave
// the profile half-loaded at a fixed sleep, so the gate + handle verification read a
// blank screen (observed live: eileenswrld read @? → false "personal"). Returns the
// parsed nodes once ready (or the last dump on timeout — best-effort).
async function waitForProfileReady(device, timeoutMs = 9000) {
    const deadline = Date.now() + timeoutMs
    let nodes = []
    while (Date.now() < deadline) {
        await device.getScreen()
        nodes = parseNodes(device.currentScreen || '')
        if (detectVerificationState(device.currentScreen)) return nodes
        const ready = foregroundHandle(nodes) && (hasDesc(nodes, PRO_DASH_DESC)
            || nodes.some(n => n.k === 'text' && (n.t === 'Edit profile' || n.t === 'Share profile')))
        if (ready) return nodes
        await sleep(600)
    }
    return nodes
}

module.exports = async (device, config = {}) => {
    const t0 = Date.now()
    try {
        device.sendLog('account_insights: launching IG + opening profile…', 'INFO')
        // COLD relaunch: force-stop first so IG resets to the Home feed (bottom nav
        // present). A warm `monkey` launch resumes the LAST screen — if that's a deep
        // screen (e.g. Insights left over from a prior account/run) the profile tab
        // isn't on it, the tap misses, and the business gate dumps the wrong screen →
        // false "personal". Cold start makes the profile tab deterministically present.
        // The active IG account (set by ig_account_switch) persists across force-stop.
        device.adb(['shell', 'am', 'force-stop', IG_PKG])
        await sleep(900)
        device.adb(['shell', 'monkey', '-p', IG_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
        await waitForForeground(device, IG_PKG)
        await sleep(1600)                       // let the Home feed + bottom nav settle
        let verification = detectVerificationState(await device.getScreen())
        if (verification) return verificationOutcome(verification, { elapsed_ms: Date.now() - t0 })
        await device.dismissCommonPopups()
        verification = detectVerificationState(await device.getScreen())
        if (verification) return verificationOutcome(verification, { elapsed_ms: Date.now() - t0 })
        device.shell(`input tap ${PROFILE_TAB.x} ${PROFILE_TAB.y}`)
        await sleep(1200)

        // Business-vs-personal gate. Wait for the profile to actually RENDER (handle +
        // dashboard/edit marker) rather than a fixed sleep — a half-loaded cold-relaunch
        // profile read @? and misfired the gate to "personal" (e.g. eileenswrld).
        let profNodes = await waitForProfileReady(device)
        _trace(`profile ready: handle=@${foregroundHandle(profNodes) || '?'} business=${hasDesc(profNodes, PRO_DASH_DESC)}`)

        verification = detectVerificationState(device.currentScreen)
        if (verification) {
            return verificationOutcome(verification, { elapsed_ms: Date.now() - t0 })
        }

        // Verify we're on the EXPECTED IG account. The shared ig_account_switch
        // taps the Settings menu (not the switcher) and silently no-ops — so two
        // accounts on one profile once stored IDENTICAL stats. Self-correct via the
        // reliable long-press switcher, re-verify, and bail rather than mis-attribute.
        if (config.expect_account) {
            const want = String(config.expect_account).toLowerCase()
            let fg = foregroundHandle(profNodes)
            _trace(`expect @${config.expect_account} — foreground @${fg || '?'}`)
            if (fg && fg.toLowerCase() !== want) {
                device.sendLog(`account_insights: foreground @${fg} != @${config.expect_account} — switching in-app`, 'INFO')
                _trace(`MISMATCH — switching in-app to @${config.expect_account}`)
                const sw = await switchToAccount(device, config.expect_account)
                await sleep(1500)
                await device.getScreen()
                profNodes = parseNodes(device.currentScreen || '')   // re-dump after the switch
                verification = detectVerificationState(device.currentScreen)
                if (verification) {
                    return verificationOutcome(verification, { elapsed_ms: Date.now() - t0 })
                }
                fg = foregroundHandle(profNodes)
                _trace(`after switch (found=${sw}) — foreground @${fg || '?'}`)
            }
            if (fg && fg.toLowerCase() !== want) {
                device.sendLog(`account_insights: still on @${fg} after switch — skipping (won't mis-attribute)`, 'INFO')
                return { success: true, data: { account_mismatch: true, expected: String(config.expect_account), foreground: fg, reason: 'ig_switch_failed', elapsed_ms: Date.now() - t0 } }
            }
        }

        if (!foregroundHandle(profNodes)) {
            return {
                success: true,
                data: {
                    is_business: null,
                    insights_unavailable: true,
                    reason: 'profile_not_ready',
                    elapsed_ms: Date.now() - t0,
                },
            }
        }

        const profile = parseProfileStats(device.currentScreen || '')

        if (!hasDesc(profNodes, PRO_DASH_DESC)) {
            device.sendLog('account_insights: no Professional dashboard → PERSONAL account, skipping', 'INFO')
            return {
                success: true,
                data: {
                    is_business: false,
                    skipped: true,
                    reason: 'personal_account',
                    profile,
                    profileFollowers: profile.followers,
                    elapsed_ms: Date.now() - t0,
                },
            }
        }

        // Tap the dashboard button at its ACTUAL bounds (layout-robust), not a fixed
        // coord — eileenxreels-type profiles have an extra banners/name row that
        // shifts it, and a hardcoded tap lands on "Add banners" → wrong screen.
        const entry = descCenter(profNodes, PRO_DASH_DESC) || PRO_DASH_ENTRY
        device.shell(`input tap ${entry.x} ${entry.y}`); await sleep(3000)
        device.shell(`input tap ${INSIGHTS_DRILL.x} ${INSIGHTS_DRILL.y}`); await sleep(3000)

        const data = {
            is_business: true,
            profile,
            profileFollowers: profile.followers,
        }
        // Branch on the insights layout. NEW = tabbed Professional Dashboard;
        // LEGACY = single scrolling Views donut screen (creator/small-business).
        await device.getScreen()
        const layout = detectInsightsLayout(texts(parseNodes(device.currentScreen || '')))
        _trace(`drill-in layout = ${layout}`)
        if (layout === 'unknown') {
            // Drill-in didn't land on an insights screen (a mis-tap, a slow load, or
            // an account whose dashboard has no insights yet). Don't scrape garbage —
            // flag it so the sweep can surface/retry instead of storing wrong data.
            device.sendLog('account_insights: NOT on an insights screen after drill-in — skipping (nav_unrecognized)', 'INFO')
            return { success: true, data: { is_business: true, insights_unavailable: true, reason: 'nav_unrecognized', elapsed_ms: Date.now() - t0 } }
        }
        if (layout === 'legacy') {
            device.sendLog('account_insights: LEGACY Views layout - single-screen scrape', 'INFO')
            data.layout = 'legacy'
            const acc = {}
            for (let k = 0; k < 12; k++) { device.shell('input swipe 540 700 540 2000 250'); await sleep(140) }
            await sleep(2600)
            for (let i = 0; i <= 6; i++) {
                await device.getScreen()
                mergeParsed(acc, parseLegacyInsights(texts(parseNodes(device.currentScreen || ''))))
                if (i < 6) { device.shell('input swipe 540 1650 540 930 450'); await sleep(1500) }
            }
            data.legacy = acc
        } else {
            data.layout = 'tabbed'
            const want = config.tabs || ['overview', 'content', 'audience']
        if (want.includes('overview')) data.overview = await scrapeTab(device, TAB.overview, parseOverview, 5, { settle: 3200 })
        if (want.includes('content')) data.content = await scrapeTab(device, TAB.content, parseContent, 6)
        // Audience is the heaviest (chart + gender/age/locations/active-times) and
        // lazy-loads on a cold IG → two passes so the second sweeps fully-loaded content.
        if (want.includes('audience')) data.audience = await scrapeTab(device, TAB.audience, parseAudience, 8, { passes: 2, settle: 4800 })
        }

        // leave IG clean for the next step in the sweep
        for (let i = 0; i < 4; i++) { await device.back(); await sleep(700) }

        data.elapsed_ms = Date.now() - t0
        device.sendLog(`account_insights: scraped (business) followers=${data.audience?.followers ?? '?'} views=${data.overview?.metrics?.Views ?? '?'}`, 'INFO')
        return { success: true, data }
    } catch (error) {
        return { success: false, error: error.message }
    }
}

// exported for unit testing the pure parsers
Object.assign(module.exports, {
    parseNodes, texts, hasDesc, num, valueBelow, valueRight,
    parseOverview, parseAudience, parseContent, mergeParsed,
    parseLegacyInsights, detectInsightsLayout, parseProfileStats, detectVerificationState, verificationOutcome,
})
