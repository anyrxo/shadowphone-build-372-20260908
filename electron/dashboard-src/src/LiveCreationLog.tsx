// Live ops log — bottom-right panel that streams module-progress (account
// creation + basic ops + posting) live into the dashboard. Fed by the
// module-progress IPC broadcast (module-handlers.js sendModuleProgress), the
// same transport the mirror-toolbar LIVE pane uses. Self-contained: no props.
import { useEffect, useRef, useState } from 'react'
import { useIpcEvent } from './ipc'

type Line = { id: number; mod: string; lvl: string; msg: string }

// module-progress payload shape emitted by module-handlers.js
type ModulePayload = {
  runId?: string
  moduleId?: string
  type?: 'log' | 'progress'
  message?: string
  percent?: number
  level?: string
  status?: string
}

const MAX_LINES = 200

function shortMod(mod: string): string {
  return (mod || 'run').replace(/_/g, ' ').replace(/\bws\b/i, '').trim() || 'run'
}

export default function LiveCreationLog() {
  const [lines, setLines] = useState<Line[]>([])
  const [open, setOpen] = useState(true)
  const [visible, setVisible] = useState(false)
  const seq = useRef(0)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useIpcEvent('module-progress', (payload: unknown) => {
    const p = (payload || {}) as ModulePayload
    const raw = String(p.message ?? '').trim()
    if (!raw) return
    const msg = p.type === 'progress' && typeof p.percent === 'number'
      ? `${p.percent}%  ${raw}`
      : raw
    const lvl = p.status === 'error' ? 'error' : (p.level || 'info')
    setLines((prev) => {
      const next = [...prev, { id: seq.current++, mod: shortMod(p.moduleId || ''), lvl, msg }]
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
    setVisible(true)
  })

  // Auto-scroll to newest line while expanded.
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [lines, open])

  if (!visible) return null

  const gold = 'var(--gold, #d4af37)'
  const red = 'var(--red, #ff5d5d)'

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        width: 380,
        maxWidth: 'calc(100vw - 32px)',
        zIndex: 9000,
        background: 'var(--panel, #0e0e10)',
        border: '1px solid var(--border, #26262b)',
        borderRadius: 10,
        boxShadow: '0 8px 30px rgba(0,0,0,0.55)',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        overflow: 'hidden',
      }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          cursor: 'pointer',
          background: 'var(--panel-2, #141417)',
          borderBottom: open ? '1px solid var(--border, #26262b)' : 'none',
          userSelect: 'none',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: gold, boxShadow: `0 0 6px ${gold}` }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: gold, letterSpacing: 0.3 }}>LIVE LOG</span>
        <span style={{ fontSize: 11, color: 'var(--muted, #8a8a92)' }}>{lines.length}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button
            onClick={(e) => { e.stopPropagation(); setLines([]) }}
            style={{ background: 'none', border: 'none', color: 'var(--muted, #8a8a92)', cursor: 'pointer', fontSize: 11 }}
          >
            clear
          </button>
          <span style={{ color: 'var(--muted, #8a8a92)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
        </span>
      </div>
      {open && (
        <div
          ref={bodyRef}
          style={{
            maxHeight: 260,
            overflowY: 'auto',
            padding: '6px 10px',
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          {lines.map((l) => (
            <div key={l.id} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: l.lvl === 'error' ? red : 'var(--text, #d8d8dc)' }}>
              <span style={{ color: 'var(--muted, #8a8a92)' }}>[{l.mod}]</span> {l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
