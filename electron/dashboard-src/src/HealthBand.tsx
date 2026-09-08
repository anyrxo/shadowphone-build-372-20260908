import type { ExceptionSet, IssueType, Exception } from './exceptions'
import { ISSUE_BUCKET, getSeverity } from './exceptions'
import IssueChip from './IssueChip'

interface HealthBandProps {
  ex: ExceptionSet
  active: Set<IssueType>
  onToggle: (t: IssueType) => void
  onClear: () => void
  onRetimeClick?: (e: Exception) => void
  onRetimeAll?: (collisions: Exception[]) => void
  onFillClick?: (e: Exception) => void
  onAddScheduleClick?: (e: Exception) => void
  // Pre-computed runway label per account key (e.g. '~6h left'), for starving accounts.
  runwayByKey?: Map<string, string>
}

const CHIP_ORDER = ['collision', 'missed', 'starving', 'noSchedule', 'idle', 'stale'] as const

// Display label per issue type (defaults to capitalized type; noSchedule needs a space).
const CHIP_LABEL: Partial<Record<IssueType, string>> = {
  noSchedule: 'No schedule',
}

export default function HealthBand({
  ex,
  active,
  onToggle,
  onClear,
  onRetimeClick,
  onRetimeAll,
  onFillClick,
  onAddScheduleClick,
  runwayByKey,
}: HealthBandProps) {
  const { active: activeCount, firingSoon, needYou } = ex.summary

  // Quick-fix surfaces the active bucket only when its handler is wired.
  // Sort deterministically so the list is stable and scannable.
  const retimeExceptions = active.has('collision') && onRetimeClick
    ? [...ex.collisions].sort((a, b) => {
        const s = (a.serial ?? '').localeCompare(b.serial ?? '')
        if (s !== 0) return s
        return (a.slotTime ?? '').localeCompare(b.slotTime ?? '')
      })
    : []
  const fillExceptions = active.has('starving') && onFillClick
    ? [...ex.starving].sort((a, b) => (a.handle ?? '').localeCompare(b.handle ?? ''))
    : []
  const addScheduleExceptions = active.has('noSchedule') && onAddScheduleClick
    ? [...ex.noSchedule].sort((a, b) => (a.handle ?? '').localeCompare(b.handle ?? ''))
    : []

  const isFilterActive = active.size > 0

  return (
    <div className="cc-health" role="region" aria-label="Fleet health and filters">
      {/* Summary row: left side counts, right side clear button */}
      <div className="cc-health-summary" aria-live="polite" aria-atomic="true">
        <div className="cc-health-counts">
          <span className="cc-health-count cc-health-count-active">
            <span className="cc-health-count-icon">✓</span>
            <span className="cc-health-count-num">{activeCount}</span>
            <span className="cc-health-count-text">active</span>
          </span>
          <span className="cc-health-count cc-health-count-firing">
            <span className="cc-health-count-icon">●</span>
            <span className="cc-health-count-num">{firingSoon}</span>
            <span className="cc-health-count-text">firing soon</span>
          </span>
          <span className="cc-health-count cc-health-count-need">
            <span className="cc-health-count-icon">⚠</span>
            <span className="cc-health-count-num">{needYou}</span>
            <span className="cc-health-count-text">need you</span>
          </span>
        </div>
        {isFilterActive && (
          <button className="cc-health-clear" onClick={onClear} aria-label="Clear all filters">
            Clear
          </button>
        )}
      </div>

      {/* Severity chip row: one toggle per issue type */}
      <div className="cc-health-chips">
        {CHIP_ORDER.map((type) => {
          const bucket = ex[ISSUE_BUCKET[type]]
          const count = bucket.length
          const isActive = active.has(type)

          // Hide chip if count is 0 AND filter is not active
          if (count === 0 && !isActive) return null

          const label = CHIP_LABEL[type] ?? type.charAt(0).toUpperCase() + type.slice(1)

          return (
            <IssueChip
              key={type}
              type={type}
              label={label}
              count={count}
              severity={getSeverity(type)}
              active={isActive}
              onClick={() => onToggle(type)}
            />
          )
        })}
      </div>

      {/* Quick-fix row: shown only when an actionable filter is active */}
      {isFilterActive && (retimeExceptions.length > 0 || fillExceptions.length > 0 || addScheduleExceptions.length > 0) && (
        <div className="cc-health-fixrow">
          {retimeExceptions.length > 0 && (
            <div className={`cc-health-fixgroup cc-health-fixgroup-collisions${retimeExceptions.length > 3 ? ' cc-health-fixgroup-grid' : ''}`}>
              <span className="cc-health-fixlabel">Collisions ({retimeExceptions.length}):</span>
              {onRetimeAll && (
                <button
                  className="cc-health-fix cc-health-fix-retimeall"
                  onClick={() => onRetimeAll(retimeExceptions)}
                  title={`Resolve all ${retimeExceptions.length} collisions in one preview`}
                >
                  ⚡ Retime all ({retimeExceptions.length})
                </button>
              )}
              {retimeExceptions.map((e) => (
                <button
                  key={`${e.key}::${e.slotTime ?? ''}`}
                  className="cc-health-fix cc-health-fix-retime"
                  onClick={() => onRetimeClick?.(e)}
                  title={`Retime collision at ${e.slotTime}`}
                >
                  <span className="cc-health-fix-handle">@{e.handle}</span>
                  {e.slotTime && <span className="cc-health-fix-time">{e.slotTime}</span>}
                </button>
              ))}
            </div>
          )}
          {fillExceptions.length > 0 && (
            <div className={`cc-health-fixgroup cc-health-fixgroup-starving${fillExceptions.length > 3 ? ' cc-health-fixgroup-grid' : ''}`}>
              <span className="cc-health-fixlabel">Needs content ({fillExceptions.length}):</span>
              {fillExceptions.map((e) => {
                const runway = runwayByKey?.get(e.key)
                return (
                  <button
                    key={e.key}
                    className="cc-health-fix cc-health-fix-fill"
                    onClick={() => onFillClick?.(e)}
                    title={runway ? `@${e.handle} · ⏳ ${runway} · open content folder` : `Open content folder for @${e.handle}`}
                  >
                    <span className="cc-health-fix-handle">@{e.handle}</span>
                    {runway && <span className="cc-health-runway">⏳ {runway}</span>}
                  </button>
                )
              })}
            </div>
          )}
          {addScheduleExceptions.length > 0 && (
            <div className={`cc-health-fixgroup cc-health-fixgroup-noSchedule${addScheduleExceptions.length > 3 ? ' cc-health-fixgroup-grid' : ''}`}>
              <span className="cc-health-fixlabel">No schedule ({addScheduleExceptions.length}):</span>
              {addScheduleExceptions.map((e) => (
                <button
                  key={e.key}
                  className="cc-health-fix cc-health-fix-addschedule"
                  onClick={() => onAddScheduleClick?.(e)}
                  title={`Add a default posting slot for @${e.handle}`}
                >
                  <span className="cc-health-fix-handle">@{e.handle}</span>
                  <span className="cc-health-fix-add">+ Add schedule</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
