import type { PulseStats, InsightsAgg } from './types'
import { fmtK, relTime } from './utils'

interface Props {
  stats: PulseStats
  insights?: InsightsAgg | null
}

export default function FleetPulse({ stats, insights }: Props) {
  const { live, idle, low, fail, total, models, profiles, ready, noDevices } = stats

  // Real insights take over the Followers/Views tiles once any account has been
  // fetched; otherwise fall back to the '—' placeholder + a fetch hint.
  const hasInsights = !!insights && insights.fetchedCount > 0
  const followersText = hasInsights ? fmtK(insights!.followers) : '—'
  const viewsText = hasInsights ? fmtK(insights!.views) : '—'
  const fresh = hasInsights && insights!.newestTs ? relTime(insights!.newestTs) : ''
  const partial = hasInsights && insights!.fetchedCount < insights!.totalCount
    ? `${insights!.fetchedCount}/${insights!.totalCount} fetched`
    : ''

  const delta = hasInsights ? insights!.followersDelta : null
  const deltaDir = delta == null ? '' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  const deltaText = delta == null
    ? ''
    : `${delta > 0 ? '▲' : delta < 0 ? '▼' : '▪'} ${fmtK(Math.abs(delta))}`

  return (
    <section className="pulse" aria-label="Fleet status">
      {/* Hero — live count */}
      <div className="pulse-hero">
        <span className="ph-num">{live}</span>
        <div className="ph-meta">
          <span className="ph-label">Live accounts</span>
          {noDevices ? (
            <span className="ph-sub" style={{ color: 'var(--tert)' }}>Connect a phone to get started</span>
          ) : (
            <span className="ph-sub">
              of <b>{total}</b> · <b>{models}</b> model{models !== 1 ? 's' : ''} · <b>{profiles}</b> profile{profiles !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Bar + legend */}
      <div className="pulse-bar-wrap">
        <div className="health-bar">
          {total > 0 && live > 0 && (
            <div className="hb-seg live" style={{ width: `${(live / total) * 100}%` }} />
          )}
          {total > 0 && idle > 0 && (
            <div className="hb-seg idle" style={{ width: `${(idle / total) * 100}%` }} />
          )}
          {total > 0 && low > 0 && (
            <div className="hb-seg low" style={{ width: `${(low / total) * 100}%` }} />
          )}
        </div>
        <div className="health-legend">
          <span className="hl live">
            <i /><span className="n">{live}</span> live
          </span>
          <span className="hl idle">
            <i /><span className="n">{idle}</span> idle
          </span>
          {low > 0 && (
            <span className="hl low">
              <i /><span className="n">{low}</span> low content
            </span>
          )}
          {fail > 0 && (
            <span className="hl fail">
              <i>⚠</i><span className="n">{fail}</span> switch-failed
            </span>
          )}
        </div>
      </div>

      {/* KPI stats */}
      <div className="pulse-stats">
        <div className="pstat">
          <span className="pv">
            {followersText}
            {deltaText && <span className={`pdelta ${deltaDir}`} title="net follower change vs ~24h ago">{deltaText}</span>}
          </span>
          <span className="pl">Followers</span>
          <span className="psub">{hasInsights ? (fresh ? `updated ${fresh}` : ' ') : 'fetch stats to populate'}</span>
        </div>
        <div className="pstat">
          <span className="pv">{viewsText}</span>
          <span className="pl">Views</span>
          <span className="psub">{hasInsights ? (partial || (fresh ? `updated ${fresh}` : ' ')) : ' '}</span>
        </div>
        <div className="pstat">
          <span className="pv">{ready}</span>
          <span className="pl">Ready</span>
          <span className="psub">content queued</span>
        </div>
      </div>
    </section>
  )
}
