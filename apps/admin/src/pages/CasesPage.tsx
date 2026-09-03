import { useEffect, useMemo, useState } from 'react'
import { api, STATUS_LABELS, ZONES, type CaseListItem, type Me, type UserRow, atLeast } from '../lib/api'
import { urgencyOf } from '../lib/sla'
import {
  Button,
  Card,
  Chip,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Table,
  Td,
  TextInput,
  Th,
  Tr,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { ExportButton } from '../components/ExportButton'
import { useToast } from '../components/Toast'

/** Dashboard cards link in with ?sla=…; the labels must match the cards. */
const SLA_FILTERS: Record<string, string> = {
  overdue: 'Overdue',
  at_risk: 'Due within 3 days',
  on_track: 'Within SLA window',
  closed: 'Closed',
}

type SortKey = 'created' | 'due' | 'status'
type SortDir = 'asc' | 'desc'

interface Filters {
  status: string
  zone: string
  /** '' | 'me' | 'none' | a user id. */
  assignee: string
  requestType: string
  from: string
  to: string
  search: string
  sla: string
  /** '' | 'high'. */
  priority: string
  tag: string
  /** True hides actively snoozed cases. */
  hideSnoozed: boolean
  sort: SortKey
  dir: SortDir
  page: number
  pageSize: number
}

const DEFAULTS: Filters = {
  status: '', zone: '', assignee: '', requestType: '', from: '', to: '',
  search: '', sla: '', priority: '', tag: '', hideSnoozed: false,
  sort: 'created', dir: 'desc', page: 1, pageSize: 25,
}

/** Filters from the URL hash, so a link lands pre-filtered and refresh keeps the view. */
function readHash(): Filters {
  const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const num = (k: string, fallback: number) => {
    const n = Number(q.get(k))
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    status: q.get('status') ?? '',
    zone: q.get('zone') ?? '',
    assignee: q.get('assignee') ?? '',
    requestType: q.get('type') ?? '',
    from: q.get('from') ?? '',
    to: q.get('to') ?? '',
    search: q.get('q') ?? '',
    sla: q.get('sla') ?? '',
    priority: q.get('priority') ?? '',
    tag: q.get('tag') ?? '',
    hideSnoozed: q.get('snoozed') === 'hide',
    sort: (['created', 'due', 'status'].includes(q.get('sort') ?? '') ? q.get('sort') : 'created') as SortKey,
    dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
    page: num('page', 1),
    pageSize: [25, 50, 100].includes(num('size', 25)) ? num('size', 25) : 25,
  }
}

function writeHash(f: Filters) {
  const q = new URLSearchParams()
  if (f.status) q.set('status', f.status)
  if (f.zone) q.set('zone', f.zone)
  if (f.assignee) q.set('assignee', f.assignee)
  if (f.requestType) q.set('type', f.requestType)
  if (f.from) q.set('from', f.from)
  if (f.to) q.set('to', f.to)
  if (f.search) q.set('q', f.search)
  if (f.sla) q.set('sla', f.sla)
  if (f.priority) q.set('priority', f.priority)
  if (f.tag) q.set('tag', f.tag)
  if (f.hideSnoozed) q.set('snoozed', 'hide')
  if (f.sort !== 'created' || f.dir !== 'desc') { q.set('sort', f.sort); q.set('dir', f.dir) }
  if (f.page > 1) q.set('page', String(f.page))
  if (f.pageSize !== 25) q.set('size', String(f.pageSize))
  const qs = q.toString()
  // replaceState rather than assigning location.hash: filters are one view
  // evolving, not a trail of history entries the Back button must replay.
  history.replaceState(null, '', `#/cases${qs ? `?${qs}` : ''}`)
}

export function CasesPage({ me }: { me: Me }) {
  const [items, setItems] = useState<CaseListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [f, setF] = useState<Filters>(readHash)
  const [error, setError] = useState('')
  const [requestTypes, setRequestTypes] = useState<string[]>([])
  // Whether rows are stale while a refetch runs: rows stay visible, dimmed,
  // rather than collapsing to a skeleton on every filter keystroke.
  const [fetching, setFetching] = useState(false)
  const [people, setPeople] = useState<UserRow[] | null>(null)
  // Bulk selection and the keyboard cursor. Selection is ids so it survives a
  // sort flip; the cursor is an index because it describes the visible rows.
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [cursor, setCursor] = useState(-1)
  const [bulkNote, setBulkNote] = useState('')

  // One updater so every change lands in the URL too.
  const patch = (p: Partial<Filters>) => {
    setF((prev) => {
      const next = { ...prev, ...p }
      // Any change of filter resets to the first page; a change of page does not.
      if (!('page' in p)) next.page = 1
      writeHash(next)
      return next
    })
  }

  useEffect(() => {
    api.get<string[]>('/internal/cases/request-types')
      .then(setRequestTypes)
      .catch(() => setRequestTypes([]))
  }, [])

  // Listing users is admin/zone_manager only; a 403 just hides the selector.
  useEffect(() => {
    if (!atLeast(me.role, 'zone_manager')) return
    api.get<UserRow[]>('/internal/admin/users')
      .then((rows) => setPeople(rows.filter((u) => u.active)))
      .catch(() => setPeople(null))
  }, [me.role])

  // Debounced server search: the whole record, not the loaded page.
  const [searchDraft, setSearchDraft] = useState(f.search)
  useEffect(() => {
    const t = setTimeout(() => {
      setF((prev) => {
        if (prev.search === searchDraft.trim()) return prev
        const next = { ...prev, search: searchDraft.trim(), page: 1 }
        writeHash(next)
        return next
      })
    }, 300)
    return () => clearTimeout(t)
  }, [searchDraft])

  const query = useMemo(() => {
    const q = new URLSearchParams()
    if (f.status) q.set('status', f.status)
    if (f.zone) q.set('zone', f.zone)
    if (f.assignee) q.set('assigneeId', f.assignee === 'me' ? me.id : f.assignee)
    if (f.requestType) q.set('requestType', f.requestType)
    if (f.from) q.set('from', f.from)
    if (f.to) q.set('to', f.to)
    if (f.search) q.set('search', f.search)
    if (f.sla) q.set('slaState', f.sla)
    if (f.priority) q.set('priority', f.priority)
    if (f.tag) q.set('tag', f.tag)
    if (f.hideSnoozed) q.set('snoozed', 'hide')
    if (f.sort !== 'created' || f.dir !== 'desc') { q.set('sort', f.sort); q.set('dir', f.dir) }
    return q
  }, [f, me.id])

  // Same filters as the table, so the file matches what is on screen.
  const exportQuery = query.toString()

  useEffect(() => {
    setFetching(true)
    const q = new URLSearchParams(query)
    q.set('page', String(f.page))
    q.set('pageSize', String(f.pageSize))
    let stale = false
    api
      .get<{ items: CaseListItem[]; total: number }>(`/internal/cases?${q}`)
      .then((r) => {
        if (stale) return
        setItems(r.items)
        setTotal(r.total)
        setError('')
        setSelected(new Set())
        setCursor(-1)
        // Left behind for the detail page's prev/next arrows: the queue as
        // the operator saw it when they stepped into a case.
        try {
          sessionStorage.setItem('dsr-case-nav', JSON.stringify({ ids: r.items.map((i) => i.id) }))
        } catch { /* storage full or blocked — navigation just degrades */ }
      })
      .catch((e) => { if (!stale) setError(String(e)) })
      .finally(() => { if (!stale) setFetching(false) })
    return () => { stale = true }
  }, [query, f.page, f.pageSize])

  // j/k/arrows walk the queue, Enter opens, x toggles selection. Only when no
  // control has focus: typing an email into the search box must never navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return
      if (!items || items.length === 0) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((i) => Math.min(items.length - 1, i + 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        setCursor((i) => {
          if (i >= 0 && items[i]) window.location.hash = `#/cases/${items[i].id}`
          return i
        })
      } else if (e.key === 'x') {
        setCursor((i) => {
          if (i >= 0 && items[i]) {
            const id = items[i].id
            setSelected((prev) => {
              const next = new Set(prev)
              if (!next.delete(id)) next.add(id)
              return next
            })
          }
          return i
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items])

  const pages = Math.max(1, Math.ceil(total / f.pageSize))
  const filtersOn = Boolean(
    f.status || f.zone || f.assignee || f.requestType || f.from || f.to || f.search ||
    f.priority || f.tag || f.hideSnoozed,
  )

  const sortToggle = (key: SortKey) => {
    if (f.sort === key) patch({ dir: f.dir === 'asc' ? 'desc' : 'asc' })
    else patch({ sort: key, dir: key === 'due' ? 'asc' : 'desc' })
  }

  return (
    <>
      {f.sla && (
        <div className="mb-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-ink/30 bg-brand-soft px-3.5 py-2.5">
            <Icon name="filter" size={14} className="text-brand-ink" />
            <span className="text-[13px] text-ink">
              Showing only <strong>{SLA_FILTERS[f.sla] ?? f.sla}</strong> cases
            </span>
            <button
              type="button"
              onClick={() => patch({ sla: '' })}
              className="ml-auto cursor-pointer rounded-md px-2 py-1 text-[12px] font-medium text-brand-ink transition-colors hover:bg-brand/10"
            >
              Clear filter
            </button>
          </div>
        </div>
      )}

      <PageHeader
        title="Cases"
        subtitle={`${total} request${total === 1 ? '' : 's'} in scope`}
        actions={
          <ExportButton
            href={`/internal/cases/export.csv?${exportQuery}`}
            label="Export CSV"
          />
        }
      />

      {/* ------------------------------ filters ----------------------------- */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* The two questions every operator asks first, one click each. */}
        <div role="group" aria-label="Quick filters" className="flex gap-1">
          <QuickChip
            active={f.assignee === 'me'}
            onClick={() => patch({ assignee: f.assignee === 'me' ? '' : 'me' })}
          >
            My cases
          </QuickChip>
          <QuickChip
            active={f.assignee === 'none'}
            onClick={() => patch({ assignee: f.assignee === 'none' ? '' : 'none' })}
          >
            Unassigned
          </QuickChip>
          <QuickChip
            active={f.priority === 'high'}
            onClick={() => patch({ priority: f.priority === 'high' ? '' : 'high' })}
          >
            High priority
          </QuickChip>
          <QuickChip
            active={f.hideSnoozed}
            onClick={() => patch({ hideSnoozed: !f.hideSnoozed })}
          >
            Hide snoozed
          </QuickChip>
        </div>

        {f.tag && (
          <span className="flex items-center gap-1 rounded-lg bg-brand-soft px-2 py-1 text-[12px] font-medium text-brand-ink ring-1 ring-brand-ink/30">
            tag: {f.tag}
            <button
              type="button"
              aria-label={`Clear tag filter ${f.tag}`}
              onClick={() => patch({ tag: '' })}
              className="cursor-pointer"
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        )}

        <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden="true" />

        <div className="relative">
          <Icon name="search" size={14} className="pointer-events-none absolute inset-y-0 left-2.5 my-auto text-faint" />
          <TextInput
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Reference, email, source ID…"
            aria-label="Search cases"
            className="w-56 pl-8"
          />
        </div>

        <Select
          value={f.status}
          onChange={(e) => patch({ status: e.target.value })}
          aria-label="Status filter"
          className="w-36"
        >
          <option value="">Any status</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>

        {requestTypes.length > 0 && (
          <Select
            value={f.requestType}
            onChange={(e) => patch({ requestType: e.target.value })}
            aria-label="Request type filter"
            className="w-40"
          >
            <option value="">Any type</option>
            {requestTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        )}

        {(atLeast(me.role, 'admin') || me.role === 'auditor') && (
          <Select
            value={f.zone}
            onChange={(e) => patch({ zone: e.target.value })}
            aria-label="Zone filter"
            className="w-28"
          >
            <option value="">All zones</option>
            {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
          </Select>
        )}

        {people && people.length > 0 && (
          <Select
            value={f.assignee === 'me' || f.assignee === 'none' ? '' : f.assignee}
            onChange={(e) => patch({ assignee: e.target.value })}
            aria-label="Assignee filter"
            className="w-40"
          >
            <option value="">Any assignee</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}

        <label className="flex items-center gap-1.5 text-[12px] text-faint">
          From
          <TextInput
            type="date"
            value={f.from}
            onChange={(e) => patch({ from: e.target.value })}
            aria-label="Created from"
            className="w-[8.5rem]"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-faint">
          To
          <TextInput
            type="date"
            value={f.to}
            onChange={(e) => patch({ to: e.target.value })}
            aria-label="Created to"
            className="w-[8.5rem]"
          />
        </label>

        {filtersOn && (
          <button
            type="button"
            onClick={() => { setSearchDraft(''); patch({ ...DEFAULTS, sla: f.sla }) }}
            className="cursor-pointer text-[12px] font-medium text-muted transition-colors hover:text-ink"
          >
            Reset
          </button>
        )}
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          people={people}
          meId={me.id}
          onDone={(msg) => {
            setSelected(new Set())
            setBulkNote(msg)
            patch({ page: f.page }) // refetch without moving
          }}
          ids={[...selected]}
          onClear={() => setSelected(new Set())}
        />
      )}
      {bulkNote && (
        <p className="mb-3 text-[12px] text-muted" role="status">{bulkNote}</p>
      )}

      <Card bleed>
        {items === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={filtersOn ? 'filter' : 'inbox'}
            title={filtersOn ? 'No cases match these filters' : 'No cases yet'}
            hint={
              filtersOn
                ? 'Try widening the search, status or zone filter.'
                : 'Verified submissions from the public forms appear here automatically.'
            }
            action={
              filtersOn ? (
                <Button
                  variant="secondary"
                  onClick={() => { setSearchDraft(''); patch({ ...DEFAULTS, sla: f.sla }) }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          /* A queue is a table: one row per case, the same columns every time,
             so the eye scans down a column instead of re-reading a card. */
          <div className={fetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <Table
              caption="Cases matching the current filters"
              head={
                <>
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all rows on this page"
                      checked={items.length > 0 && items.every((c) => selected.has(c.id))}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(items.map((c) => c.id)) : new Set())
                      }
                      className="cursor-pointer accent-brand"
                    />
                  </Th>
                  <Th className="w-[13.5rem]">Reference</Th>
                  <SortTh label="Status" active={f.sort === 'status'} dir={f.dir} onClick={() => sortToggle('status')} className="w-[9.5rem]" />
                  <Th>Requester</Th>
                  <Th className="w-[9.5rem]">Request type</Th>
                  <Th className="w-[9rem]">Assignee</Th>
                  <Th className="w-[8.5rem]">Pending on</Th>
                  <SortTh label="Created" active={f.sort === 'created'} dir={f.dir} onClick={() => sortToggle('created')} className="w-[7.5rem]" />
                  <SortTh label="Due" active={f.sort === 'due'} dir={f.dir} onClick={() => sortToggle('due')} className="w-[8.5rem]" />
                </>
              }
            >
              {items.map((c, i) => (
                <CaseRow
                  key={c.id}
                  c={c}
                  active={i === cursor}
                  selected={selected.has(c.id)}
                  onSelect={(on) =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (on) next.add(c.id)
                      else next.delete(c.id)
                      return next
                    })
                  }
                  onTagClick={(t) => patch({ tag: t })}
                />
              ))}
            </Table>
          </div>
        )}
      </Card>

      {(pages > 1 || total > 25) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12px] text-faint">
            <span className="mr-3 hidden lg:inline">
              <kbd className="rounded border border-line px-1">j</kbd>/<kbd className="rounded border border-line px-1">k</kbd> move ·{' '}
              <kbd className="rounded border border-line px-1">x</kbd> select ·{' '}
              <kbd className="rounded border border-line px-1">⏎</kbd> open
            </span>
            Showing <span className="mono">{Math.min((f.page - 1) * f.pageSize + 1, total)}</span>–
            <span className="mono">{Math.min(f.page * f.pageSize, total)}</span> of <span className="mono">{total}</span>
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={String(f.pageSize)}
              onChange={(e) => patch({ pageSize: Number(e.target.value) })}
              aria-label="Rows per page"
              className="w-24"
            >
              {[25, 50, 100].map((n) => <option key={n} value={n}>{n} rows</option>)}
            </Select>
            <Button variant="secondary" icon="chevronLeft" disabled={f.page <= 1} onClick={() => patch({ page: f.page - 1 })} aria-label="Previous page" />
            <span className="mono px-1 text-[12px] text-muted">{f.page} / {pages}</span>
            <Button variant="secondary" icon="chevronRight" disabled={f.page >= pages} onClick={() => patch({ page: f.page + 1 })} aria-label="Next page" />
          </div>
        </div>
      )}
    </>
  )
}

/** One case in the queue. */
function CaseRow({
  c,
  active,
  selected,
  onSelect,
  onTagClick,
}: {
  c: CaseListItem
  active: boolean
  selected: boolean
  onSelect: (on: boolean) => void
  onTagClick: (tag: string) => void
}) {
  const urgency = urgencyOf(c.status, c.dueAt)
  const snoozed = c.snoozedUntil && new Date(c.snoozedUntil) > new Date()
  return (
    <Tr
      onClick={() => { window.location.hash = `#/cases/${c.id}` }}
      className={active ? 'ring-1 ring-inset ring-brand-ink/50 bg-brand-soft/40' : ''}
    >
      <Td className="align-top">
        <input
          type="checkbox"
          aria-label={`Select ${c.caseRef}`}
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onSelect(e.target.checked)}
          className="cursor-pointer accent-brand"
        />
      </Td>
      <Td className="align-top">
        {/* A real link, so middle-click and ctrl-click open a tab; the row
            click stays for the common case. */}
        <a
          href={`#/cases/${c.id}`}
          onClick={(e) => e.stopPropagation()}
          className="mono block whitespace-nowrap text-[12.5px] font-semibold text-brand-ink hover:underline"
        >
          {c.caseRef}
        </a>
        <span className="mono block text-[10.5px] text-faint">{c.formKey}</span>
      </Td>

      <Td className="align-top">
        <StatusBadge status={c.status} />
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
          {c.zoneId}
          {/* A record from another system, not a case being worked here. */}
          {c.source === 'import' && (
            <span
              title="Imported from another system — kept as a record, not worked here"
              className="inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-medium text-muted ring-1 ring-line"
            >
              <Icon name="upload" size={9} />
              Imported
            </span>
          )}
          {/* Closed is not the end of the story: whether the answer reached
              the requester is what a regulator asks about. */}
          {c.status === 'closed' && c.progress && c.progress !== 'Closed' && (
            <span
              className={`inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-medium ring-1 ${
                c.progress === 'Closed — report not sent'
                  ? 'text-warning ring-warning/40'
                  : 'text-muted ring-line'
              }`}
            >
              {c.progress}
            </span>
          )}
          {c.isAppeal && (
            <span className="inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-medium text-muted ring-1 ring-line">
              <Icon name="refresh" size={9} />
              Appeal
            </span>
          )}
          {c.priority === 'high' && (
            <span className="inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-semibold text-danger ring-1 ring-danger/40">
              <Icon name="alert" size={9} />
              High
            </span>
          )}
          {snoozed && (
            <span
              title={`Snoozed until ${String(c.snoozedUntil).slice(0, 10)}`}
              className="inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-medium text-muted ring-1 ring-line"
            >
              <Icon name="clock" size={9} />
              Snoozed
            </span>
          )}
          {(c.tags ?? []).map((t) => (
            <button
              key={t}
              type="button"
              title={`Show only cases tagged ${t}`}
              onClick={(e) => { e.stopPropagation(); onTagClick(t) }}
              className="cursor-pointer rounded bg-sunken px-1 py-px text-[10px] text-muted ring-1 ring-line hover:text-ink"
            >
              {t}
            </button>
          ))}
        </span>
      </Td>

      <Td className="min-w-0 align-top">
        <span className="block truncate text-[12.5px] text-ink">{c.requesterEmail}</span>
        <span className="block text-[11px] text-faint">{c.country ?? '—'}</span>
      </Td>

      <Td className="align-top">
        <span className="flex flex-wrap gap-1">
          {c.requestTypes.slice(0, 2).map((t) => (
            <Chip key={t}>
              <span className="block max-w-[8rem] truncate" title={t}>{t}</span>
            </Chip>
          ))}
          {c.requestTypes.length > 2 && <Chip>+{c.requestTypes.length - 2}</Chip>}
        </span>
      </Td>

      <Td className="align-top text-[12px] text-muted">
        {c.assigneeName ?? (c.assigneeId ? 'Assigned' : <span className="text-faint">Unassigned</span>)}
      </Td>

      <Td className="align-top text-[12px] text-muted">
        {c.pendingOn
          ? `${c.pendingOn}${c.pendingParty === 'internal' ? ' (internal)' : ''}`
          : '—'}
      </Td>

      <Td className="tabular align-top text-[12px] text-muted">
        {c.createdAt.slice(0, 10)}
      </Td>

      <Td className="align-top">
        <span
          className={`tabular flex items-center gap-1 text-[12px] ${
            urgency.tone === 'danger'
              ? 'font-semibold text-danger'
              : urgency.tone === 'warning'
                ? 'font-medium text-warning'
                : 'text-muted'
          }`}
        >
          {urgency.overdue && <Icon name="alert" size={11} className="shrink-0" />}
          {urgency.atRisk && !urgency.overdue && <Icon name="clock" size={11} className="shrink-0" />}
          {c.status === 'closed' ? (c.closedAt ? c.closedAt.slice(0, 10) : '—') : c.dueAt ? urgency.text : 'none'}
        </span>
        {c.status !== 'closed' && c.dueAt && (
          <span className="tabular block text-[10.5px] text-faint">{c.dueAt.slice(0, 10)}</span>
        )}
      </Td>
    </Tr>
  )
}

/**
 * The action bar for a selection. Assignment is the one queue action worth
 * doing in bulk — triage after a colleague leaves, or after an import.
 * Each case still goes through the single-assign path server-side, so a
 * failure names the case instead of aborting the batch.
 */
function BulkBar({
  count,
  ids,
  people,
  meId,
  onDone,
  onClear,
}: {
  count: number
  ids: string[]
  people: UserRow[] | null
  meId: string
  onDone: (msg: string) => void
  onClear: () => void
}) {
  const toast = useToast()
  const [assignee, setAssignee] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (target: string) => {
    setBusy(true)
    try {
      const r = await api.post<{ assigned: number; results: { ok: boolean; error?: string }[] }>(
        '/internal/cases/bulk-assign',
        { ids, assigneeId: target },
      )
      const failed = r.results.filter((x) => !x.ok)
      if (failed.length === 0) {
        toast.success(`${r.assigned} case${r.assigned === 1 ? '' : 's'} assigned`)
        onDone('')
      } else {
        onDone(
          `${r.assigned} assigned, ${failed.length} skipped — ${failed[0].error ?? 'see audit log'}`,
        )
      }
    } catch (e) {
      toast.error('Bulk assignment failed', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-ink/30 bg-brand-soft px-3.5 py-2">
      <span className="text-[13px] font-medium text-ink">{count} selected</span>
      {people && people.length > 0 ? (
        <>
          <Select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            aria-label="Assign selected cases to"
            className="w-44"
          >
            <option value="">Assign to…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Button
            variant="primary"
            icon="userPlus"
            loading={busy}
            disabled={!assignee}
            onClick={() => void run(assignee)}
          >
            Assign
          </Button>
        </>
      ) : (
        <Button variant="primary" icon="userPlus" loading={busy} onClick={() => void run(meId)}>
          Assign to me
        </Button>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto cursor-pointer text-[12px] font-medium text-muted hover:text-ink"
      >
        Clear selection
      </button>
    </div>
  )
}

/** A column header that carries the sort state. */
function SortTh({
  label,
  active,
  dir,
  onClick,
  className = '',
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  className?: string
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`whitespace-nowrap px-4 py-2.5 font-medium ${className}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`flex cursor-pointer items-center gap-1 uppercase tracking-wider transition-colors hover:text-ink ${active ? 'text-ink' : ''}`}
      >
        {label}
        <Icon
          name={active ? 'chevronDown' : 'chevronsUpDown'}
          size={11}
          className={active && dir === 'asc' ? 'rotate-180' : ''}
        />
      </button>
    </th>
  )
}

/** A one-click preset that reads as on or off at a glance. */
function QuickChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 ${
        active
          ? 'bg-brand-soft text-brand-ink ring-1 ring-brand-ink/30'
          : 'text-muted ring-1 ring-line hover:bg-sunken hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}
