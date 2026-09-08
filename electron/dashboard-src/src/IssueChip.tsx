import type { IssueType, Severity } from './exceptions'

const ICON_MAP: Record<IssueType, string> = {
  collision: '⛔',
  missed: '🔴',
  starving: '🟠',
  noSchedule: '🚫',
  idle: '⚪',
  stale: '⏳',
}

interface IssueChipProps {
  type: IssueType
  label: string
  count: number
  severity: Severity
  active: boolean
  onClick: () => void
}

export default function IssueChip({ type, label, count, severity, active, onClick }: IssueChipProps) {
  return (
    <button
      role="button"
      aria-pressed={active}
      onClick={onClick}
      className={`cc-health-chip cc-health-chip-${severity}${active ? ' cc-health-chip-active' : ''}`}
      title={`Filter by ${label} (${count} issue${count !== 1 ? 's' : ''})`}
    >
      <span className="cc-health-chip-icon">{ICON_MAP[type]}</span>
      <span className="cc-health-chip-label">{label}</span>
      <span className="cc-health-chip-count">{count}</span>
    </button>
  )
}
