// Schedule helpers — mirrors logic from models-dashboard.html

export const SCHED_STEPS = [
  { id: 'wake_unlock',       label: 'Wake & Unlock' },
  { id: 'airplane_on',       label: 'Airplane Mode ON' },
  { id: 'switch_profile',    label: 'Switch Profile' },
  { id: 'airplane_off',      label: 'Airplane Mode OFF' },
  { id: 'vpn_connect',       label: 'VPN Connect' },
  { id: 'clean_gallery',     label: 'Clean Gallery' },
  { id: 'push_content',      label: 'Push Content' },
  { id: 'ig_switch_account', label: 'Switch IG Account' },
]

export const SCHED_MODULES = [
  { id: 'ig_pre_engage',   label: 'Pre-Engagement' },
  { id: 'ig_pre_stories',  label: 'Pre-Engagement (Stories)' },
  { id: 'ig_status_check', label: 'Account Status Check' },
  { id: 'ig_post',         label: 'Post' },
  { id: 'ig_post_story',   label: 'Post Story' },
  { id: 'ig_post_trial',   label: 'Post Trial Reel' },
  { id: 'ig_post_engage',  label: 'Post-Engagement' },
  { id: 'ig_post_stories', label: 'Post-Engagement (Stories)' },
  { id: 'ig_repost',       label: 'Cascade Repost' },
]

const SIDEBAR_OWNED_IDS = new Set([
  ...SCHED_STEPS.map((s) => s.id),
  ...SCHED_MODULES.map((m) => m.id),
])

export const SLOT_KINDS = ['reel', 'trial_reel', 'image', 'story'] as const

function normTime(t: string): string {
  const s = String(t || '')
  if (/^\d{2}:\d{2}$/.test(s)) return `${s}:00`
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s
  return ''
}

export interface SlotDraft {
  time: string
  content_type: string
}

export interface ConfigurePatch {
  is_active: boolean
  slots: { time: string; content_type: string }[]
  disabled_steps: string[]
}

export function buildConfigurePatch(opts: {
  isActive: boolean
  slots: SlotDraft[]
  enabledIds: Set<string>
  existingDisabled: string[]
}): ConfigurePatch {
  const normalizedSlots = (opts.slots || [])
    .map((s) => ({
      time: normTime(s.time),
      content_type: SLOT_KINDS.includes(s.content_type as typeof SLOT_KINDS[number]) ? s.content_type : 'reel',
    }))
    .filter((s) => s.time)
  const preservedNonSidebar = (opts.existingDisabled || []).filter(
    (id) => !SIDEBAR_OWNED_IDS.has(id)
  )
  const sidebarDisabled = [...SIDEBAR_OWNED_IDS].filter((id) => !opts.enabledIds.has(id))
  return {
    is_active: !!opts.isActive,
    slots: normalizedSlots,
    disabled_steps: [...preservedNonSidebar, ...sidebarDisabled],
  }
}

/** nextSlotIndex — mirrors _nextSlotIndex from models-dashboard.html */
export function nextSlotIndex(row: { slots?: { time?: string }[] }, nowMs: number): number {
  const slots = row && Array.isArray(row.slots) ? row.slots : []
  if (!slots.length) return 0
  const todayBase = new Date(nowMs)
  todayBase.setHours(0, 0, 0, 0)
  const todayMs = todayBase.getTime()
  let bestIdx = 0
  let bestMs = Infinity
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]
    const m = String((s && s.time) || '').match(/^(\d{1,2}):(\d{2})/)
    if (!m) continue
    const hh = parseInt(m[1], 10)
    const mm = parseInt(m[2], 10)
    if (hh > 23 || mm > 59) continue
    let fireMs = todayMs + (hh * 60 + mm) * 60 * 1000
    if (fireMs < nowMs) fireMs += 24 * 60 * 60 * 1000
    if (fireMs < bestMs) { bestMs = fireMs; bestIdx = i }
  }
  return bestIdx
}
