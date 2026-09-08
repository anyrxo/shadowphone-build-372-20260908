// Empty/loading/error state components

export function Skeleton() {
  return (
    <>
      {[0, 1, 2].map(i => (
        <div key={i} className="skel-group">
          <div className="skel-line w1" />
          <div className="skel-line w2" />
          <div className="skel-line w3" />
        </div>
      ))}
    </>
  )
}

export function FirstRun({ onOpenPhones }: { onOpenPhones: () => void }) {
  return (
    <div className="empty firstrun">
      <div className="fr-mark">◇</div>
      <h2 className="fr-h">No phones connected yet</h2>
      <p className="fr-sub">
        Add a device, then scan it to pull in its profiles and Instagram accounts.
      </p>
      <ol className="fr-steps">
        <li>
          <span className="fr-num">1</span>
          <span>Open <b>Settings → Phones</b> and connect your device via USB or Tailscale.</span>
        </li>
        <li>
          <span className="fr-num">2</span>
          <span>Come back here and click <b>Scan Fleet</b> to detect profiles and accounts.</span>
        </li>
      </ol>
      <button id="frConnect" className="mdbtn yellow" onClick={onOpenPhones}>
        ⚙ Open Phones panel
      </button>
    </div>
  )
}

export function NoMatch({ query }: { query: string }) {
  return (
    <div className="empty">
      No accounts match &ldquo;{query}&rdquo;.
    </div>
  )
}

export function LoadingState() {
  return <div className="empty loading">Loading fleet…</div>
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-card">
      <div className="ec-icon">⚠</div>
      <div className="ec-msg">{message}</div>
      <button className="ec-retry" onClick={onRetry}>↺ Retry</button>
    </div>
  )
}
