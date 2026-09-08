// PhoneTimeLane — a compact 24h micro-timeline stripe for ONE phone. Renders one
// tick per slot of every account on the phone, positioned by minute-of-day, so the
// operator SEES clustering/collisions at a glance instead of reading HH:MM lists.
// Presentational + pure: no state, no IPC, no clock tick. nowMin is sampled once
// per render by the parent (or here once) — the now-line is static per render.

import { useMemo } from 'react'
import type { NormalizedProfile, Slot } from './types'
import { parseHm } from './exceptions'

interface PhoneLike {
  serial: string
  profiles: NormalizedProfile[]
}

interface Props {
  phone: PhoneLike
  slotsByHandle: Record<string, Slot[]>
  collisionTimesByKey: Map<string, string[]>
  onPick: (serial: string, handle: string, slotTime: string) => void
  nowMin?: number // minutes-of-day for the "now" marker; sampled once if omitted
}

const EMPTY: Slot[] = []
const HOUR_TICKS = [0, 6, 12, 18, 24]

// minute-of-day for an 'HH:MM[:SS]' string, or null if unparseable.
function minutesOf(time: string): number | null {
  const hm = parseHm(time)
  if (!hm) return null
  return parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10)
}

interface Tick {
  key: string
  handle: string
  time: string // normalized HH:MM
  min: number
  status: string
  collide: boolean
  cluster: number // how many ticks share this exact minute on this phone
}

export default function PhoneTimeLane({ phone, slotsByHandle, collisionTimesByKey, onPick, nowMin }: Props) {
  const ticks = useMemo<Tick[]>(() => {
    const out: Tick[] = []
    const perMinute = new Map<number, number>()
    for (const p of phone.profiles) {
      for (const a of p.accounts) {
        const collisionTimes = collisionTimesByKey.get(a.key)
        for (const s of (slotsByHandle[a.handle.toLowerCase()] || EMPTY)) {
          const min = minutesOf(s.time)
          if (min == null) continue
          const norm = parseHm(s.time) as string
          const collide = !!collisionTimes && collisionTimes.includes(norm)
          perMinute.set(min, (perMinute.get(min) || 0) + 1)
          // out.length = slot ordinal → unique even when one account has two slots
          // that normalize to the same HH:MM (e.g. 09:00:00 and 09:00:30).
          out.push({ key: `${a.key}::${norm}::${out.length}`, handle: a.handle, time: norm, min, status: s.status, collide, cluster: 0 })
        }
      }
    }
    for (const t of out) t.cluster = perMinute.get(t.min) || 1
    return out
  }, [phone, slotsByHandle, collisionTimesByKey])

  // Sample "now" once on mount (still prop-overridable) so the gold line doesn't
  // jump on every data refresh. Hooks must run before the early return below.
  const sampledNow = useMemo(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }, [])

  if (ticks.length === 0) {
    return <div className="cc-time-lane is-empty">no scheduled posts</div>
  }

  const now = nowMin ?? sampledNow

  return (
    <div className="cc-time-lane" role="img" aria-label={`24-hour posting timeline for ${phone.serial}`}>
      <div className="cc-time-lane-rule" aria-hidden="true">
        {HOUR_TICKS.map(h => (
          <span className="cc-time-hour" key={h} style={{ left: `${(h / 24) * 100}%` }} data-h={h}>
            <span className="cc-time-hour-label">{h}</span>
          </span>
        ))}
      </div>
      {ticks.map(t => {
        const collideTxt = t.collide ? ' · collision' : ''
        const clusterTxt = t.cluster > 1 ? ` · ${t.cluster} at this time` : ''
        return (
          <button
            type="button"
            key={t.key}
            className={`cc-time-tick is-${t.status}${t.collide ? ' is-collide' : ''}${t.cluster > 1 ? ' is-cluster' : ''}`}
            style={{ left: `${(t.min / 1440) * 100}%` }}
            title={`@${t.handle} ${t.time} · ${t.status}${collideTxt}${clusterTxt}`}
            onClick={() => onPick(phone.serial, t.handle, t.time)}
          />
        )
      })}
      {now >= 0 && now <= 1440 && (
        <div className="cc-time-now" aria-hidden="true" style={{ left: `${(now / 1440) * 100}%` }} />
      )}
    </div>
  )
}
