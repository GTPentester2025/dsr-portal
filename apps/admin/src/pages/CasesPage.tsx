import { useEffect, useMemo, useState } from 'react'
import { api, STATUS_LABELS, ZONES, type CaseListItem, type Me, atLeast } from '../lib/api'
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

/** Dashboard cards link in with ?sla=…; the labels must match the cards. */
const SLA_FILTERS: Record<string, string> = {
  overdue: 'Overdue',
  at_risk: 'Due within 3 days',
  on_track: 'Within SLA window',
  closed: 'Closed',
}

export function CasesPage({ me }: { me: Me }) {
  const [items, setItems] = useState<CaseListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [zone, setZone] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  // Read once from the URL so a drill-down link lands pre-filtered and the
  // filter stays visible and dismissable rather than silently applied.
  const [slaState, setSlaState] = useState(
    () => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('sla') ?? '',
  )
  const pageSize = 25

  // Same filters as the table, so the file matches what is on screen.
  const exportQuery = useMemo(() => {
    const q = new URLSearchParams()
    if (status) q.set('status', status)
    if (zone) q.set('zone', zone)
    if (slaState) q.set('slaState', slaState)
    return q.toString()
  }, [status, zone, slaState])

  useEffect(() => {
    setItems(null)
    const q = new URLSearchParams()
    if (status) q.set('status', status)
    if (zone) q.set('zone', zone)
    if (slaState) q.set('slaState', slaState)
    q.set('page', String(page))
    q.set('pageSize', String(pageSize))
    api
      .get<{ items: CaseListItem[]; total: number }>(`/internal/cases?${q}`)
      .then((r) => { setItems(r.items); setTotal(r.total) })
      .catch((e) => setError(String(e)))
  }, [status, zone, slaState, page])

  // Client-side refine on the loaded page; server filters handle the rest.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !items) return items
    return items.filter(
      (c) =>
        c.caseRef.toLowerCase().includes(q) ||
        c.requesterEmail.toLowerCase().includes(q) ||
        c.requestTypes.join(' ').toLowerCase().includes(q),
    )
  }, [items, query])

  const pages = Math.max(1, Math.ceil(total / pageSize))
  const filtersOn = Boolean(status || zone || query)

  return (
    <>
      {slaState && (
        <div className="mb-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-ink/30 bg-brand-soft px-3.5 py-2.5">
            <Icon name="filter" size={14} className="text-brand-ink" />
            <span className="text-[13px] text-ink">
              Showing only <strong>{SLA_FILTERS[slaState] ?? slaState}</strong> cases
            </span>
            <button
              type="button"
              onClick={() => {
                setSlaState('')
                setPage(1)
                window.location.hash = '#/cases'
              }}
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
          <>
            <ExportButton
              href={`/internal/cases/export.csv?${exportQuery}`}
              label="Export CSV"
            />
            <div className="relative">
              <Icon name="search" size={14} className="pointer-events-none absolute inset-y-0 left-2.5 my-auto text-faint" />
              <TextInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter this page…"
                aria-label="Filter cases"
                className="w-48 pl-8"
              />
            </div>
            <Select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1) }}
              aria-label="Status filter"
              className="w-40"
            >
              <option value="">Any status</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            {(atLeast(me.role, 'admin') || me.role === 'auditor') && (
              <Select
                value={zone}
                onChange={(e) => { setZone(e.target.value); setPage(1) }}
                aria-label="Zone filter"
                className="w-32"
              >
                <option value="">All zones</option>
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            )}
          </>
        }
      />

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <Card bleed>
        {items === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10" />)}
          </div>
        ) : shown && shown.length === 0 ? (
          <EmptyState
            icon={filtersOn ? 'filter' : 'inbox'}
            title={filtersOn ? 'No cases match these filters' : 'No cases yet'}
            hint={
              filtersOn
                ? 'Try widening the status or zone filter.'
                : 'Verified submissions from the public forms appear here automatically.'
            }
            action={
              filtersOn ? (
                <Button
                  variant="secondary"
                  onClick={() => { setStatus(''); setZone(''); setQuery(''); setPage(1) }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          /* A queue is a table: one row per case, the same columns every time,
             so the eye scans down a column instead of re-reading a card. */
          <Table
            caption="Cases matching the current filters"
            head={
              <>
                <Th className="w-[14.5rem]">Reference</Th>
                <Th className="w-[9rem]">Status</Th>
                <Th>Requester</Th>
                <Th className="w-[10rem]">Request type</Th>
                <Th className="w-[9rem]">Pending on</Th>
                <Th className="w-[8rem]">Created</Th>
                <Th className="w-[9rem]">Due</Th>
              </>
            }
          >
            {(shown ?? []).map((c) => {
              const overdue = c.dueAt && new Date(c.dueAt) < new Date() && c.status !== 'closed'
              return (
                <Tr key={c.id} onClick={() => { window.location.hash = `#/cases/${c.id}` }}>
                  <Td className="align-top">
                    <span className="mono block whitespace-nowrap text-[12.5px] font-semibold text-brand-ink">
                      {c.caseRef}
                    </span>
                    <span className="mono block text-[10.5px] text-faint">{c.formKey}</span>
                  </Td>

                  <Td className="align-top">
                    <StatusBadge status={c.status} />
                    <span className="mt-1 block text-[11px] text-faint">{c.zoneId}</span>
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
                        overdue ? 'font-semibold text-danger' : 'text-muted'
                      }`}
                    >
                      {overdue && <Icon name="alert" size={11} className="shrink-0" />}
                      {c.dueAt ? c.dueAt.slice(0, 10) : 'none'}
                    </span>
                  </Td>
                </Tr>
              )
            })}
          </Table>
        )}
      </Card>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-[12px] text-faint">
            Showing <span className="mono">{(page - 1) * pageSize + 1}</span>–
            <span className="mono">{Math.min(page * pageSize, total)}</span> of <span className="mono">{total}</span>
          </p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" icon="chevronLeft" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page" />
            <span className="mono px-1 text-[12px] text-muted">{page} / {pages}</span>
            <Button variant="secondary" icon="chevronRight" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page" />
          </div>
        </div>
      )}
    </>
  )
}

/** A label/value pair in the case row. Kept narrow so four fit across. */
