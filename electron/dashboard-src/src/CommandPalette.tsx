import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { ModelGroup } from './types'

interface CmdAction {
  sec: string
  ico: string
  label: string
  hint?: string
  run: () => void
}

interface Props {
  open: boolean
  onClose: () => void
  allGroups: ModelGroup[]
  // static action handlers
  onRefresh: () => void
  onDetectAccounts: () => void
  onAddProfile: () => void
  onBulkCreate: () => void
  onFetchStats: () => void
  onValidateFolders: () => void
  onOpenPhones: () => void
  onOpenSchedule: () => void
  onOpenAnalytics: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  // model jump
  onJumpToModel: (model: string) => void
}

// Fuzzy scorer: returns -1 (no match) or a score >= 0
function fuzzyScore(q: string, text: string): number {
  if (!q) return 0
  const t = text.toLowerCase()
  q = q.toLowerCase()
  let ti = 0, score = 0, run = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = -1
    for (let j = ti; j < t.length; j++) { if (t[j] === ch) { found = j; break } }
    if (found === -1) return -1
    run = (found === ti) ? run + 1 : 0
    score += 1 + run * 2
    if (found === 0 || /[^a-z0-9]/.test(t[found - 1])) score += 4
    ti = found + 1
  }
  score -= (t.length - q.length) * 0.05
  return score
}

// Highlight matching chars with <mark class="find-hit">
function highlight(label: string, q: string): React.ReactNode[] {
  if (!q) return [label]
  const tLow = label.toLowerCase()
  const qLow = q.toLowerCase()
  const hits = new Set<number>()
  let ti = 0
  for (let qi = 0; qi < qLow.length; qi++) {
    for (let j = ti; j < tLow.length; j++) {
      if (tLow[j] === qLow[qi]) { hits.add(j); ti = j + 1; break }
    }
  }
  const nodes: React.ReactNode[] = []
  let i = 0
  while (i < label.length) {
    if (hits.has(i)) {
      nodes.push(<mark key={i} className="find-hit">{label[i]}</mark>)
    } else {
      const last = nodes[nodes.length - 1]
      if (typeof last === 'string') { nodes[nodes.length - 1] = last + label[i] }
      else nodes.push(label[i])
    }
    i++
  }
  return nodes
}

export default function CommandPalette({
  open, onClose, allGroups,
  onRefresh, onDetectAccounts, onAddProfile, onBulkCreate, onFetchStats,
  onValidateFolders, onOpenPhones, onOpenSchedule, onOpenAnalytics,
  onExpandAll, onCollapseAll, onJumpToModel,
}: Props) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const restoreFocusRef = useRef<Element | null>(null)

  const staticActions = useMemo<CmdAction[]>(() => [
    { sec: 'Actions', ico: '↻', label: 'Refresh fleet',           run: onRefresh },
    { sec: 'Actions', ico: '↻', label: 'Detect Accounts',         run: onDetectAccounts },
    { sec: 'Actions', ico: '+', label: 'Add Profile',              run: onAddProfile },
    { sec: 'Actions', ico: '+', label: 'Bulk Create',              run: onBulkCreate },
    { sec: 'Actions', ico: '⬇', label: 'Fetch Stats',              run: onFetchStats },
    { sec: 'Actions', ico: '📁', label: 'Set Up Content Folders',  run: onValidateFolders },
    { sec: 'Actions', ico: '⚙', label: 'Open Phones / Settings',  run: onOpenPhones },
    { sec: 'View',    ico: '📅', label: 'Open Schedule',           run: onOpenSchedule },
    { sec: 'View',    ico: '📈', label: 'Open Analytics',          run: onOpenAnalytics },
    { sec: 'View',    ico: '⊕', label: 'Expand all groups',        run: onExpandAll },
    { sec: 'View',    ico: '⊖', label: 'Collapse all groups',      run: onCollapseAll },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [onRefresh, onDetectAccounts, onAddProfile, onBulkCreate, onFetchStats,
      onValidateFolders, onOpenPhones, onOpenSchedule, onOpenAnalytics,
      onExpandAll, onCollapseAll])

  const modelActions = useMemo<CmdAction[]>(() =>
    allGroups.map(g => ({
      sec: 'Jump to model',
      ico: '↳',
      label: g.model,
      hint: `${g.accountCount} ${g.accountCount === 1 ? 'acct' : 'accts'}`,
      run: () => onJumpToModel(g.model),
    }))
  , [allGroups, onJumpToModel])

  const items = useMemo<CmdAction[]>(() => {
    const all = [...staticActions, ...modelActions]
    if (!query.trim()) return all
    return all
      .map(a => ({ a, s: fuzzyScore(query.trim(), a.label) }))
      .filter(x => x.s >= 0)
      .sort((x, y) => y.s - x.s)
      .map(x => x.a)
  }, [query, staticActions, modelActions])

  // Clamp active index when items list changes
  const clampedActive = Math.min(activeIdx, Math.max(0, items.length - 1))

  // On open: save focus, clear query, reset active
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement
      setQuery('')
      setActiveIdx(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    } else {
      const back = restoreFocusRef.current as HTMLElement | null
      restoreFocusRef.current = null
      if (back && document.body.contains(back)) setTimeout(() => back.focus(), 0)
    }
  }, [open])

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector(`[data-i="${clampedActive}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [clampedActive, items])

  const setActive = useCallback((i: number) => {
    const n = items.length
    if (!n) return
    setActiveIdx(((i % n) + n) % n)
  }, [items.length])

  const runItem = useCallback((i: number) => {
    const it = items[i]
    if (!it) return
    onClose()
    it.run()
  }, [items, onClose])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); setActive(clampedActive + 1) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(clampedActive - 1) }
    else if (e.key === 'Home')      { e.preventDefault(); setActive(0) }
    else if (e.key === 'End')       { e.preventDefault(); setActive(items.length - 1) }
    else if (e.key === 'Enter')     { e.preventDefault(); runItem(clampedActive) }
    else if (e.key === 'Escape')    { e.preventDefault(); onClose() }
  }, [clampedActive, items.length, setActive, runItem, onClose])

  if (!open) return null

  // Render list with section headers
  const listNodes: React.ReactNode[] = []
  let lastSec: string | null = null
  if (items.length === 0) {
    listNodes.push(
      <div key="empty" className="cmdk-empty">No matching commands</div>
    )
  } else {
    items.forEach((it, i) => {
      // Only group by section when NOT searching. Under an active fuzzy query the
      // list is sorted by score, interleaving sections — emitting a header per
      // section change would push duplicate keys (sec-Actions, etc.) AND show
      // repeated headers. A flat scored list reads better while searching.
      if (!query.trim() && it.sec !== lastSec) {
        listNodes.push(
          <li key={`sec-${it.sec}`} className="cmdk-sec" role="presentation">{it.sec}</li>
        )
        lastSec = it.sec
      }
      const isActive = i === clampedActive
      listNodes.push(
        <li
          key={`item-${i}`}
          className={`cmdk-item${isActive ? ' active' : ''}`}
          role="option"
          id={`cmdkItem${i}`}
          data-i={i}
          aria-selected={isActive}
          onMouseMove={() => { if (i !== clampedActive) setActive(i) }}
          onClick={() => runItem(i)}
        >
          <span className="cmdk-ico" aria-hidden="true">{it.ico || '›'}</span>
          <span className="cmdk-label">{highlight(it.label, query.trim())}</span>
          {it.hint && <span className="cmdk-sub">{it.hint}</span>}
        </li>
      )
    })
  }

  return (
    <div
      className="cfg-overlay cmdk-overlay show"
      aria-hidden={false}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="cmdk" role="dialog" aria-modal={true} aria-label="Command palette" onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); inputRef.current?.focus() } }}>
        <div className="cmdk-inputwrap">
          <span className="cmdk-glyph" aria-hidden="true">&#9889;</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Type a command or jump to a model…"
            role="combobox"
            aria-expanded={true}
            aria-controls="cmdkList"
            aria-autocomplete="list"
            aria-activedescendant={items.length ? `cmdkItem${clampedActive}` : undefined}
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
            onKeyDown={onKeyDown}
          />
          <span className="cmdk-kbd" aria-hidden="true">ESC</span>
        </div>
        <ul id="cmdkList" ref={listRef} className="cmdk-list" role="listbox" aria-label="Commands">
          {listNodes}
        </ul>
        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd>&#8593;</kbd><kbd>&#8595;</kbd> navigate</span>
          <span><kbd>&#8629;</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
          <span className="cmdk-foot-sp" />
          <span><kbd>&#8984;K</kbd> / <kbd>Ctrl K</kbd></span>
        </div>
      </div>
    </div>
  )
}
