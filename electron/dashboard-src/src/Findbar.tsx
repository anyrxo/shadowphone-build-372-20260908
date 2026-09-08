import type { SortKey } from './types'

interface Props {
  query: string
  onQuery: (q: string) => void
  chips: Record<string, boolean>
  onChip: (chip: string) => void
  sort: SortKey
  onSort: (s: SortKey) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  shownCount: number
  totalCount: number
  freshLabel: string
  updating: boolean
}

export default function Findbar({
  query, onQuery, chips, onChip, sort, onSort,
  onExpandAll, onCollapseAll,
  shownCount, totalCount, freshLabel, updating,
}: Props) {
  const hasQuery = query.length > 0
  const isFiltered = hasQuery || Object.values(chips).some(Boolean)

  return (
    <div className="controls">
      {/* Search input */}
      <div className="find-wrap">
        <span className="find-glyph">🔍</span>
        <input
          className="find-input"
          type="text"
          spellCheck={false}
          aria-label="Search fleet"
          placeholder="Search model · profile · @handle · serial…"
          value={query}
          onChange={e => onQuery(e.target.value)}
        />
        <button
          className={`find-x${hasQuery ? ' show' : ''}`}
          title="Clear search"
          aria-label="Clear search"
          onClick={() => onQuery('')}
          tabIndex={hasQuery ? 0 : -1}
        >
          &times;
        </button>
        {!hasQuery && <span className="find-kbd" aria-hidden="true">Ctrl F</span>}
      </div>

      {/* Filter chips */}
      <div className="fchips" role="group" aria-label="Filter accounts by status">
        <button
          className={`fchip${chips.scheduled ? ' on' : ''}`}
          data-chip="scheduled"
          aria-pressed={chips.scheduled}
          onClick={() => onChip('scheduled')}
        >▶ Scheduled</button>
        <button
          className={`fchip${chips.low ? ' on' : ''}`}
          data-chip="low"
          aria-pressed={chips.low}
          onClick={() => onChip('low')}
        >⚠ Low content</button>
        <button
          className={`fchip${chips.switchfailed ? ' on' : ''}`}
          data-chip="switchfailed"
          aria-pressed={chips.switchfailed}
          onClick={() => onChip('switchfailed')}
        >⚠ Switch-failed</button>
      </div>

      <span className="spc" />

      {/* Count */}
      <span className="find-count">
        {isFiltered
          ? <><b>{shownCount}</b> of {totalCount} accounts</>
          : <>{totalCount} account{totalCount !== 1 ? 's' : ''}</>
        }
      </span>

      {/* Sort */}
      <select
        className="find-sort"
        value={sort}
        onChange={e => onSort(e.target.value as SortKey)}
      >
        <option value="model">Sort: Model name (A→Z)</option>
        <option value="content">Sort: Total content (high→low)</option>
        <option value="low">Sort: Low-content first</option>
        <option value="scanned">Sort: Last scanned (newest)</option>
      </select>

      {/* Expand / collapse */}
      <div className="seg">
        <button className="seg-btn" aria-label="Expand all groups" onClick={onExpandAll}>⊕</button>
        <button className="seg-btn" aria-label="Collapse all groups" onClick={onCollapseAll}>⊖</button>
      </div>

      {/* Fresh indicator */}
      <span className={`find-fresh${updating ? ' updating' : ''}`}>
        {freshLabel}
      </span>
    </div>
  )
}
