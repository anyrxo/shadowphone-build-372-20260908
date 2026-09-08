// Fleet Schedule Overview renderer (DOM). Read-first, fleet-wide schedule view:
// every account's posting slots at a glance, grouped phone → account.
//
// All schedule math lives in the PURE model (schedule-overview-model.js) — this
// file only builds DOM from the already-computed model + runs a 1s clock that
// moves the Day "now" line and refreshes the next-fire countdown in place. No
// inline math, no Electron, no innerHTML injection of dynamic text (createElement
// + textContent only — model values are account names / times that mustn't be
// re-parsed as markup).
//
// Style matches the other split renderer modules (schedule-ui.js, live-logs.js):
// ESM, createElement DOM build, semantic class names, a structural signature so
// the 1s tick updates text in place instead of re-painting the whole tree.

// content_type → chip modifier (CSS colors them per spec: reel=gold, story=violet,
// image=sky, trial_reel=amber). Unknown types fall back to reel (matches the model).
const CONTENT_MOD = { reel: 'reel', story: 'story', image: 'image', trial_reel: 'trial' }
const DAY_MS = 24 * 60 * 60 * 1000

// The live-clock handle + last render live module-scoped (one overview per window).
let _clock = null          // setInterval handle for the 1s tick
let _root = null           // the .sov-root we last rendered into (clock target)
let _model = null          // last model passed to renderScheduleOverview (clock reads it)

function fmtHHMM(ms) {
    const d = new Date(ms)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// Short countdown for the next-fire KPI: "in 3h 12m", "in 4m", "now".
function fmtCountdown(ms) {
    if (ms <= 0) return 'now'
    const totalMin = Math.floor(ms / 60000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    if (h > 0) return 'in ' + h + 'h ' + m + 'm'
    return 'in ' + m + 'm'
}

// Fraction (0..1) of the local day elapsed at `nowMs` — the Day axis is 0..24h,
// so this is the horizontal position of a slot at `time` or of the now-line.
function dayFraction(ms) {
    const d = new Date(ms)
    const start = new Date(ms)
    start.setHours(0, 0, 0, 0)
    return (ms - start.getTime()) / DAY_MS
}

// Map a slot to its left% on the Day axis. Prefer the model's nextFireMs when it
// lands today (so jitter shows); otherwise position by the bare HH:MM so a slot
// whose next fire rolled to tomorrow still sits at its nominal hour.
function slotDayLeft(slot, nowMs) {
    if (slot.nextFireMs != null) {
        const sameDay = new Date(slot.nextFireMs).toDateString() === new Date(nowMs).toDateString()
        if (sameDay) return dayFraction(slot.nextFireMs) * 100
    }
    const m = String(slot.time || '').match(/^(\d{1,2}):(\d{2})/)
    if (!m) return 0
    return ((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 1440) * 100
}

function slotChip(serial, acct, slot, slotIndex, handlers, nowMs, positioned) {
    // Only a real onSlotClick makes the chip an interactive button; otherwise it's
    // a plain div (read-first overview — no misleading clickable affordance).
    const interactive = typeof handlers?.onSlotClick === 'function'
    const chip = document.createElement(interactive ? 'button' : 'div')
    if (interactive) chip.type = 'button'
    chip.className = 'sov-slot sov-slot--' + (CONTENT_MOD[slot.content_type] || 'reel')
        + ' sov-slot--' + slot.status
    chip.dataset.idx = String(slotIndex)
    if (positioned) chip.style.left = slotDayLeft(slot, nowMs).toFixed(3) + '%'

    const t = document.createElement('span')
    t.className = 'sov-slot-time'
    t.textContent = String(slot.time || '').slice(0, 5)
    chip.appendChild(t)

    const k = document.createElement('span')
    k.className = 'sov-slot-kind'
    k.textContent = slot.content_type
    chip.appendChild(k)

    const bits = [slot.content_type, slot.status]
    if (slot.nextFireMs != null) bits.push('next ' + fmtHHMM(slot.nextFireMs))
    if (slot.jitterMin > 0) bits.push('±' + slot.jitterMin + 'm')
    chip.title = bits.join(' · ')

    if (interactive) {
        chip.addEventListener('click', (e) => {
            e.stopPropagation()
            handlers.onSlotClick(serial, acct.account, acct.user, slotIndex)
        })
    }
    return chip
}

// One account row (Day view): chips are absolutely placed on the 0..24h axis.
function accountRow(serial, acct, handlers, nowMs) {
    const row = document.createElement('div')
    row.className = 'sov-row'
    if (!acct.isActive) row.classList.add('sov-row--paused')
    if (acct.flagged) row.classList.add('sov-row--flagged')

    const interactive = typeof handlers?.onAccountClick === 'function'
    const label = document.createElement(interactive ? 'button' : 'div')
    if (interactive) label.type = 'button'
    label.className = 'sov-acct'
    label.textContent = acct.user
    label.title = acct.account + (acct.isActive ? '' : ' · paused') + (acct.flagged ? ' · flagged' : '')
    if (interactive) {
        label.classList.add('sov-acct--editable')
        label.addEventListener('click', () => handlers.onAccountClick(serial, acct))
    }
    row.appendChild(label)

    const track = document.createElement('div')
    track.className = 'sov-track'
    acct.slots.forEach((slot, i) => track.appendChild(slotChip(serial, acct, slot, i, handlers, nowMs, true)))
    row.appendChild(track)
    return row
}

// 24-hour ruler + the now-line. The now-line element carries id sovNowLine so the
// 1s clock can move it without rebuilding the Day view.
function buildDay(model, handlers, nowMs) {
    const day = document.createElement('div')
    day.className = 'sov-day'

    const axis = document.createElement('div')
    axis.className = 'sov-axis'
    for (let h = 0; h <= 24; h += 3) {
        const tick = document.createElement('span')
        tick.className = 'sov-axis-tick'
        tick.style.left = ((h / 24) * 100).toFixed(3) + '%'
        tick.textContent = String(h).padStart(2, '0') + ':00'
        axis.appendChild(tick)
    }
    day.appendChild(axis)

    const grid = document.createElement('div')
    grid.className = 'sov-grid'

    const nowLine = document.createElement('div')
    nowLine.className = 'sov-nowline'
    nowLine.id = 'sovNowLine'
    nowLine.style.left = (dayFraction(nowMs) * 100).toFixed(3) + '%'
    grid.appendChild(nowLine)

    for (const phone of model.phones) {
        const group = document.createElement('div')
        group.className = 'sov-phone'
        const head = document.createElement('div')
        head.className = 'sov-phone-head'
        const nm = (handlers && handlers.serialToName && handlers.serialToName[phone.serial]) || phone.serial
        head.textContent = nm
        if (nm !== phone.serial) head.title = phone.serial
        group.appendChild(head)
        for (const acct of phone.accounts) group.appendChild(accountRow(phone.serial, acct, handlers, nowMs))
        grid.appendChild(group)
    }
    day.appendChild(grid)
    return day
}

function buildKpis(totals, nowMs) {
    const wrap = document.createElement('div')
    wrap.className = 'sov-kpis'

    const kpi = (label, value, mod) => {
        const box = document.createElement('div')
        box.className = 'sov-kpi' + (mod ? ' sov-kpi--' + mod : '')
        const v = document.createElement('div')
        v.className = 'sov-kpi-val'
        v.textContent = value
        const l = document.createElement('div')
        l.className = 'sov-kpi-label'
        l.textContent = label
        box.appendChild(v)
        box.appendChild(l)
        return box
    }

    wrap.appendChild(kpi('active accounts', totals.activeAccounts + ' / ' + totals.accounts))
    wrap.appendChild(kpi('slots / day', String(totals.slotsPerDay)))

    // Next fire KPI carries ids so the 1s clock refreshes the countdown in place.
    const nf = document.createElement('div')
    nf.className = 'sov-kpi sov-kpi--next'
    const nfv = document.createElement('div')
    nfv.className = 'sov-kpi-val'
    nfv.id = 'sovNextFireVal'
    const nfl = document.createElement('div')
    nfl.className = 'sov-kpi-label'
    nfl.id = 'sovNextFireLabel'
    if (totals.nextFire) {
        nfv.textContent = fmtCountdown(totals.nextFire.atMs - nowMs)
        nfl.textContent = 'next: ' + totals.nextFire.account
    } else {
        nfv.textContent = '—'
        nfl.textContent = 'next fire'
    }
    nf.appendChild(nfv)
    nf.appendChild(nfl)
    wrap.appendChild(nf)

    wrap.appendChild(kpi('flagged', String(totals.flagged), totals.flagged ? 'alert' : ''))
    wrap.appendChild(kpi('collisions', String(totals.collisions), totals.collisions ? 'alert' : ''))
    return wrap
}

// Render the whole overview into `container`. Idempotent: clears + rebuilds.
// handlers = { onAccountClick(serial, account, user), onSlotClick(serial, account, user, slotIndex) }.
export function renderScheduleOverview(container, model, handlers) {
    if (!container) return
    _model = model
    _root = null
    container.textContent = ''

    const root = document.createElement('div')
    root.className = 'sov-root'

    const bar = document.createElement('div')
    bar.className = 'sov-bar'
    bar.appendChild(buildKpis(model.totals, Date.now()))
    root.appendChild(bar)

    const empty = !model.phones.length || model.totals.slotsPerDay === 0
    if (empty) {
        const e = document.createElement('div')
        e.className = 'sov-empty'
        e.textContent = "No schedules yet — add slots from a phone's Schedule panel."
        root.appendChild(e)
    } else {
        const allPaused = model.totals.activeAccounts === 0
        if (allPaused) {
            const banner = document.createElement('div')
            banner.className = 'sov-banner'
            banner.style.cssText = 'padding:8px 16px;color:var(--md-tert);font-size:0.85rem;text-align:center;'
            banner.textContent = 'All accounts paused — activate one to resume auto-posting.'
            root.appendChild(banner)
        }
        root.appendChild(buildDay(model, handlers, Date.now()))
    }

    container.appendChild(root)
    _root = root
}

// Recompute the soonest upcoming nextFireMs across all active accounts in _model
// at the given nowMs. Returns { account, atMs } or null — same shape as
// totals.nextFire but re-evaluated live so the 1s tick can detect when the
// previously-soonest fire has passed and a different account is now next.
function recomputeNextFire(nowMs) {
    if (!_model) return null
    let best = null
    for (const phone of _model.phones) {
        for (const acct of phone.accounts) {
            if (!acct.isActive) continue
            for (const slot of acct.slots) {
                if (slot.nextFireMs == null) continue
                // Prefer a fire still in the future; only fall back to past when nothing else found.
                if (best == null || slot.nextFireMs < best.atMs) {
                    best = { account: acct.user, atMs: slot.nextFireMs }
                }
            }
        }
    }
    return best
}

// 1s tick: moves the Day now-line + refreshes the next-fire countdown text in
// place (no DOM rebuild — the 30s data refresh owns structural updates). Cheap:
// one style write + two textContent writes per tick. Idempotent start.
export function startOverviewClock() {
    if (_clock) return
    _clock = setInterval(() => {
        const now = Date.now()
        const line = document.getElementById('sovNowLine')
        if (line) line.style.left = (dayFraction(now) * 100).toFixed(3) + '%'
        const nfv = document.getElementById('sovNextFireVal')
        const nfl = document.getElementById('sovNextFireLabel')
        if (nfv && nfl) {
            const nf = recomputeNextFire(now)
            if (nf) {
                nfv.textContent = fmtCountdown(nf.atMs - now)
                nfl.textContent = 'next: ' + nf.account
            } else {
                nfv.textContent = '—'
                nfl.textContent = 'next fire'
            }
        }
    }, 1000)
}

export function stopOverviewClock() {
    if (_clock) { clearInterval(_clock); _clock = null }
}
