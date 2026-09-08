import { fmtK, highlight } from './utils'
import type { ModelGroup as ModelGroupType } from './types'
import ProfileCard from './ProfileCard'

interface Props {
  group: ModelGroupType
  collapsed: boolean
  onToggle: () => void
  query: string
  selected: Set<string>
  onSelectToggle: (key: string) => void
}

export default function ModelGroup({ group, collapsed, onToggle, query, selected, onSelectToggle }: Props) {
  const { model, accountCount, profiles } = group

  // Count scheduled and total for the health mini-bar
  const allAccounts = profiles.flatMap(p => p.accounts)
  const liveCount = allAccounts.filter(a => a.scheduleActive).length
  const lowCount  = allAccounts.filter(a => a.counts.lowContent).length
  const totalReady = allAccounts.reduce((n, a) => n + a.counts.remaining, 0)

  const pct = liveCount > 0 && accountCount > 0
    ? Math.round((liveCount / accountCount) * 100)
    : 0

  const initial = model[0]?.toUpperCase() ?? '?'

  return (
    <div className={`model-group${collapsed ? ' collapsed' : ''}`} data-model={model}>
      {/* Header — click to collapse */}
      <div
        className="model-head"
        data-act="collapse"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onToggle()}
      >
        <span className="chev">▼</span>
        <span className="mmedal" aria-hidden="true">{initial}</span>
        <span
          className="mname"
          dangerouslySetInnerHTML={{ __html: highlight(model, query) }}
        />
        <span className="mcount">{accountCount} IG{accountCount !== 1 ? 's' : ''}</span>
        <span className="mspacer" />
        <span className="mmeta">
          <span className="mm-health" title={`${liveCount} of ${accountCount} scheduled`}>
            <span className="mm-bar"><i style={{ width: `${pct}%` }} /></span>
            {liveCount}/{accountCount} live
          </span>
          <span>
            {profiles.length} phone{profiles.length !== 1 ? 's' : ''} · {fmtK(totalReady)} ready
          </span>
          {lowCount > 0 && (
            <span className="mm-low">{lowCount} low</span>
          )}
        </span>
      </div>

      {/* Body — profiles */}
      <div className="model-body">
        {profiles.map(p => (
          <ProfileCard
            key={`${p.serial}::${p.profileId}`}
            profile={p}
            query={query}
            selected={selected}
            onSelectToggle={onSelectToggle}
          />
        ))}
      </div>
    </div>
  )
}
