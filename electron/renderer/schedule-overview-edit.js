// Inline slot editor opened from the Fleet Schedule overview — schedule directly
// from the dashboard (no need to open each phone's mirror toolbar). Pure DOM: all
// IPC is injected via `deps` so this module stays renderer-only and unit-testable.
// Reuses the existing schedule:get / schedule:save / schedule:run-now handlers.

const CONTENT_TYPES = ['reel', 'image', 'story', 'trial_reel']

// Normalize a UI time ('H:MM' / 'HH:MM') to the stored 'HH:MM:SS', or '' if invalid.
export function normTime(t) {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})/)
    if (!m) return ''
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10)
    if (hh > 23 || mm > 59) return ''
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00'
}

// Build the schedule:save patch from editor state. Preserves id + disabled_steps
// from the loaded row so saving from the overview doesn't drop the account's toggles.
export function buildPatch(row, slots, isActive) {
    return {
        id: (row && row.id) || undefined,
        is_active: !!isActive,
        slots: slots.map(s => ({ time: normTime(s.time), content_type: s.content_type })).filter(s => s.time),
        disabled_steps: Array.isArray(row && row.disabled_steps) ? row.disabled_steps : [],
    }
}

// Coalescing saver: collapses rapid edits into serialized saves without dropping
// any. While a save is in flight, further triggers set a pending flag; when the
// in-flight save settles, exactly one follow-up save runs with the latest state.
// (A naive "skip if already saving" drops the second of a quick time-then-type edit.)
export function makeCoalescedSaver(saveFn) {
    let saving = false
    let pending = false
    function trigger() {
        if (saving) { pending = true; return }
        saving = true; pending = false
        Promise.resolve(saveFn()).catch(() => {}).finally(() => { saving = false; if (pending) trigger() })
    }
    return trigger
}

function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
}

// Mount the editor for one account into `host`.
//   ctx  = { serial, account, androidUser, user }
//   deps = { load(): Promise<{row}>, save(patch): Promise, runNow(slotIndex): Promise,
//            refresh(): void, close(): void }
export async function openScheduleEditor(host, ctx, deps) {
    host.textContent = ''
    const card = el('div', 'sov-ed')

    const head = el('div', 'sov-ed-head')
    head.appendChild(el('div', 'sov-ed-title', ctx.user || ctx.account))
    head.appendChild(el('div', 'sov-ed-sub', ctx.serial + (ctx.androidUser ? ' · user ' + ctx.androidUser : '')))
    const x = el('button', 'sov-ed-close', '✕'); x.type = 'button'
    x.addEventListener('click', () => deps.close())
    head.appendChild(x)
    card.appendChild(head)

    const body = el('div', 'sov-ed-body')
    card.appendChild(body)
    host.appendChild(card)

    let row = {}
    let slots = []
    let isActive = false
    body.textContent = 'Loading…'
    try {
        const res = await deps.load()
        row = (res && res.row) || {}
        slots = (Array.isArray(row.slots) ? row.slots : []).map(s => ({
            time: String(s.time || '').slice(0, 5),
            content_type: CONTENT_TYPES.includes(s.content_type) ? s.content_type : 'reel',
        }))
        isActive = !!row.is_active
    } catch (e) {
        body.textContent = 'Could not load this account’s schedule: ' + ((e && e.message) || e)
        return
    }

    // Coalesce concurrent edits so a quick time-then-type change never drops the
    // second save. buildPatch reads the LATEST slots/isActive each time the saver
    // fires, so the follow-up save captures changes made during the in-flight one.
    const persist = makeCoalescedSaver(() =>
        Promise.resolve(deps.save(buildPatch(row, slots, isActive)))
            .then(() => deps.refresh())
            .catch(err => console.warn('[schedule-edit] save failed:', err && err.message))
    )

    function render() {
        body.textContent = ''

        const toggle = el('button', 'sov-ed-toggle' + (isActive ? ' is-on' : ''), isActive ? '● Active' : '○ Paused')
        toggle.type = 'button'
        toggle.addEventListener('click', () => { isActive = !isActive; persist(); render() })
        body.appendChild(toggle)

        const listEl = el('div', 'sov-ed-slots')
        if (!slots.length) listEl.appendChild(el('div', 'sov-ed-empty', 'No slots yet — add one below.'))
        slots.forEach((s, i) => {
            const r = el('div', 'sov-ed-slot')
            const time = document.createElement('input')
            time.type = 'time'; time.className = 'sov-ed-time'; time.value = s.time
            time.addEventListener('change', () => { s.time = time.value; persist() })
            const sel = document.createElement('select'); sel.className = 'sov-ed-type'
            CONTENT_TYPES.forEach(ct => {
                const o = document.createElement('option'); o.value = ct; o.textContent = ct
                if (ct === s.content_type) o.selected = true
                sel.appendChild(o)
            })
            sel.addEventListener('change', () => { s.content_type = sel.value; persist() })
            const run = el('button', 'sov-ed-run', '▶'); run.type = 'button'; run.title = 'Run this slot now'
            run.addEventListener('click', async () => {
                run.disabled = true; run.textContent = '…'
                try {
                    const res = await deps.runNow(i)
                    run.textContent = (res && res.ok) ? '✓' : '✕'
                    run.title = (res && res.ok) ? 'Firing now…' : ('Could not run: ' + ((res && res.error) || 'unknown'))
                } catch (e) { run.textContent = '✕'; run.title = 'Run failed: ' + ((e && e.message) || e) }
                setTimeout(() => { if (run.isConnected) { run.textContent = '▶'; run.title = 'Run this slot now'; run.disabled = false } }, 2200)
            })
            const del = el('button', 'sov-ed-del', '✕'); del.type = 'button'; del.title = 'Delete slot'
            del.addEventListener('click', () => { slots.splice(i, 1); persist(); render() })
            r.append(time, sel, run, del)
            listEl.appendChild(r)
        })
        body.appendChild(listEl)

        const add = el('button', 'sov-ed-add', '+ Add slot'); add.type = 'button'
        add.addEventListener('click', () => { slots.push({ time: '12:00', content_type: 'reel' }); persist(); render() })
        body.appendChild(add)

        body.appendChild(el('div', 'sov-ed-note', 'Changes save automatically. The scheduler picks them up on its next tick.'))
    }
    render()
}
