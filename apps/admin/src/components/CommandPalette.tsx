import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Kbd } from './ui'
import { useTheme } from '../lib/theme'
import { api, type CaseListItem, type Me } from '../lib/api'

interface Command {
  id: string
  label: string
  hint?: string
  icon: string
  group: string
  run: () => void
}

/** Cmd/Ctrl-K launcher: jump to a page, switch theme, or open a case by ref. */
export function CommandPalette({
  open,
  onClose,
  me,
}: {
  open: boolean
  onClose: () => void
  me: Me
}) {
  const { setChoice, resolved } = useTheme()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [cases, setCases] = useState<CaseListItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    inputRef.current?.focus()
  }, [open])

  // Case search runs server-side, debounced, only while the palette is open.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    const id = window.setTimeout(() => {
      api
        .get<{ items: CaseListItem[] }>(`/internal/cases?pageSize=6`)
        .then((r) => setCases(r.items))
        .catch(() => setCases([]))
    }, q ? 180 : 0)
    return () => window.clearTimeout(id)
  }, [open, query])

  const go = (hash: string) => () => {
    window.location.hash = hash
    onClose()
  }

  const commands: Command[] = useMemo(() => {
    const nav: Command[] = [
      { id: 'n-dash', label: 'Dashboard', icon: 'grid', group: 'Navigate', run: go('#/') },
      { id: 'n-cases', label: 'Cases', icon: 'inbox', group: 'Navigate', run: go('#/cases') },
      { id: 'n-tpl', label: 'Templates', icon: 'file', group: 'Navigate', run: go('#/templates') },
    ]
    if (['super_admin', 'admin', 'zone_manager'].includes(me.role)) {
      nav.push({ id: 'n-forms', label: 'Forms & SLAs', icon: 'panelLeft', group: 'Navigate', run: go('#/forms') })
      nav.push({ id: 'n-team', label: 'Team & assignment', icon: 'users', group: 'Navigate', run: go('#/team') })
    }
    if (['super_admin', 'admin', 'auditor'].includes(me.role)) {
      nav.push({ id: 'n-audit', label: 'Audit log', icon: 'shield', group: 'Navigate', run: go('#/audit') })
    }
    if (me.role === 'super_admin') {
      nav.push({ id: 'n-set', label: 'Settings', icon: 'settings', group: 'Navigate', run: go('#/settings') })
    }

    const actions: Command[] = [
      {
        id: 'a-theme',
        label: resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: resolved === 'dark' ? 'sun' : 'moon',
        group: 'Actions',
        run: () => {
          setChoice(resolved === 'dark' ? 'light' : 'dark')
          onClose()
        },
      },
      {
        id: 'a-system',
        label: 'Match system theme',
        icon: 'monitor',
        group: 'Actions',
        run: () => {
          setChoice('system')
          onClose()
        },
      },
      {
        id: 'a-signout',
        label: 'Sign out',
        icon: 'logout',
        group: 'Actions',
        run: async () => {
          await api.post('/internal/auth/logout')
          location.reload()
        },
      },
    ]

    const caseCmds: Command[] = cases.map((c) => ({
      id: `c-${c.id}`,
      label: c.caseRef,
      hint: `${c.zoneId} · ${c.requesterEmail}`,
      icon: 'inbox',
      group: 'Recent cases',
      run: go(`#/cases/${c.id}`),
    }))

    return [...nav, ...actions, ...caseCmds]
  }, [me.role, resolved, setChoice, cases, onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    )
  }, [commands, query])

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (c + 1) % Math.max(1, filtered.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (c - 1 + filtered.length) % Math.max(1, filtered.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      filtered[cursor]?.run()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  let lastGroup = ''

  return (
    <div
      className="anim-fade fixed inset-0 z-[90] flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-[3px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="anim-pop w-full max-w-lg overflow-hidden rounded-xl border border-line bg-raised"
        style={{ boxShadow: 'var(--shadow-lg)' }}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Icon name="search" size={16} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, cases and actions…"
            aria-label="Command palette search"
            className="min-h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5" role="listbox">
          {filtered.length === 0 && (
            <p className="px-3 py-8 text-center text-[13px] text-faint">No matches for “{query}”</p>
          )}
          {filtered.map((c, i) => {
            const showGroup = c.group !== lastGroup
            lastGroup = c.group
            return (
              <div key={c.id}>
                {showGroup && (
                  <p className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                    {c.group}
                  </p>
                )}
                <button
                  role="option"
                  aria-selected={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={c.run}
                  className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                    i === cursor ? 'bg-brand-soft text-ink' : 'text-muted hover:bg-sunken'
                  }`}
                >
                  <Icon name={c.icon} size={15} className="shrink-0" />
                  <span className={c.group === 'Recent cases' ? 'mono' : ''}>{c.label}</span>
                  {c.hint && <span className="ml-auto truncate pl-3 text-[11px] text-faint">{c.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>

        <footer className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
        </footer>
      </div>
    </div>
  )
}
