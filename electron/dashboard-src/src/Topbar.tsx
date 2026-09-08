// Topbar — wordmark + action buttons matching v3.2.13 models-dashboard.html

interface Props {
  onAnalytics: () => void
  onSchedule: () => void
  onRefresh: () => void
  onAddProfile: () => void
  onBulkCreate: () => void
  onSettings: () => void
  onFetchStats: () => void
  onDetectAccounts: () => void
  onValidateFolders: () => void
  onOpenPalette: () => void
  sweepBusy?: boolean
}

export default function Topbar({
  onAnalytics, onSchedule, onRefresh, onAddProfile, onBulkCreate,
  onSettings, onFetchStats, onDetectAccounts, onValidateFolders, onOpenPalette, sweepBusy,
}: Props) {
  return (
    <div className="topbar">
      <div className="wordmark">
        <span className="bm" aria-hidden="true" />
        <span className="wm-name">ShadowPhone</span>
        <span className="wm-sep">/</span>
        <span className="wm-page">Fleet</span>
      </div>
      <div className="spacer" />
      <div className="actions">
        <button
          className="mdbtn icon"
          id="topsearch"
          title="Command palette (Ctrl K)"
          aria-label="Command palette"
          onClick={onOpenPalette}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.5" /><path d="M11 11l3.4 3.4" strokeLinecap="round" /></svg>
        </button>
        <button
          className="mdbtn"
          id="addProfileBtn"
          title="Add a new GrapheneOS profile to the phone"
          onClick={onAddProfile}
        >
          <span className="gl">&#43;</span> Add Profile
        </button>
        <button
          className="mdbtn"
          id="bulkCreateBtn"
          title="Bulk-create IG accounts across all qualifying profiles"
          onClick={onBulkCreate}
        >
          <span className="gl">&#9889;</span> Bulk Create
        </button>
        <button
          className="mdbtn ghost"
          id="scanBtn"
          title="Switch to each profile and detect its Instagram accounts"
          disabled={sweepBusy}
          onClick={onDetectAccounts}
        >
          <span className="gl">&#8635;</span> Detect Accounts
        </button>
        <button
          className="mdbtn ghost"
          id="validateFoldersBtn"
          title="Create any missing content folders for every account"
          onClick={onValidateFolders}
        >
          <span className="gl">&#128193;</span> Set Up Content Folders
        </button>
        <span className="tb-div" aria-hidden="true" />
        <button
          className="mdbtn"
          id="scheduleBtn"
          title="Fleet schedule overview — every account's posting slots across the day/week at a glance"
          onClick={onSchedule}
        >
          <span className="gl">&#128197;</span> Schedule
        </button>
        <button
          className="mdbtn"
          id="fetchStatsBtn"
          title="Scrape IG Professional Dashboard insights for every account"
          disabled={sweepBusy}
          onClick={onFetchStats}
        >
          <span className="gl">&#128202;</span> Fetch Stats
        </button>
        <button
          className="mdbtn"
          id="analyticsBtn"
          title="Fleet growth analytics — followers, views and engagement over time"
          onClick={onAnalytics}
        >
          <span className="gl">&#128200;</span> Analytics
        </button>
        <button
          className="mdbtn icon"
          id="refreshBtn"
          title="Reload the fleet registry"
          aria-label="Refresh"
          onClick={onRefresh}
        >
          &#8635;
        </button>
        <button
          className="mdbtn icon"
          id="settingsBtn"
          title="Settings — smspool API key, etc."
          aria-label="Settings"
          onClick={onSettings}
        >
          &#9881;
        </button>
      </div>
    </div>
  )
}
