import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import {
  Card, Chip, EmptyState, PageHeader, Select, Skeleton, Table, Td, Th, Tr, TextInput,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { ExportButton } from '../components/ExportButton'

interface AuditRow {
  id: number
  actor_id: string | null
  actor_type: string
  action: string
  entity_type: string
  entity_id: string | null
  zone_id: string | null
  before: unknown
  after: unknown
  source_ip: string | null
  created_at: string
}

/** Colour-codes the action family so scanning a long trail is quick. */
function actionTone(action: string): 'neutral' | 'brand' | 'positive' | 'warning' | 'danger' {
  if (action.includes('failed') || action.includes('delete')) return 'danger'
  if (action.includes('created') || action.includes('login')) return 'positive'
  if (action.includes('settings') || action.includes('config')) return 'warning'
  if (action.includes('view')) return 'neutral'
  return 'brand'
}

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [entityType, setEntityType] = useState('')
  const [query, setQuery] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    setRows(null)
    const q = entityType ? `?entityType=${entityType}` : ''
    api.get<AuditRow[]>(`/internal/admin/audit-log${q}`).then(setRows).catch((e) => setErr(String(e)))
  }, [entityType])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !rows) return rows
    return rows.filter(
      (r) =>
        r.action.toLowerCase().includes(q) ||
        r.entity_type.toLowerCase().includes(q) ||
        (r.source_ip ?? '').includes(q) ||
        JSON.stringify(r.after ?? '').toLowerCase().includes(q),
    )
  }, [rows, query])

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every view, change, send and configuration edit — append-only and tamper-resistant."
        actions={<>
            <ExportButton href="/internal/admin/audit-log/export.csv" />
            
          <>
            <div className="relative">
              <Icon name="search" size={14} className="pointer-events-none absolute inset-y-0 left-2.5 my-auto text-faint" />
              <TextInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter entries…"
                aria-label="Filter audit entries"
                className="w-48 pl-8"
              />
            </div>
            <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-label="Entity filter" className="w-40">
              <option value="">All entities</option>
              <option value="case">Cases</option>
              <option value="user">Users</option>
              <option value="template">Templates</option>
              <option value="settings">Settings</option>
              <option value="zone">Zone config</option>
            </Select>
          </>
        </>}
      />

      {err && <p className="mb-3 text-sm text-danger">{err}</p>}

      <Card bleed>
        {rows === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-9" />)}
          </div>
        ) : shown && shown.length === 0 ? (
          <EmptyState icon="shield" title="No entries match" hint="Widen the filters to see more of the trail." />
        ) : (
          <Table
            head={<><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th><Th>Zone</Th><Th>Change</Th><Th>Source IP</Th></>}
          >
            {(shown ?? []).map((r) => (
              <Tr key={r.id}>
                <Td><span className="mono whitespace-nowrap text-[11px] text-muted">{new Date(r.created_at).toLocaleString()}</span></Td>
                <Td>
                  <span className="text-[12px] capitalize text-muted">{r.actor_type}</span>
                  {r.actor_id && <span className="mono ml-1 text-[11px] text-faint">{r.actor_id.slice(0, 8)}</span>}
                </Td>
                <Td><Chip tone={actionTone(r.action)}>{r.action}</Chip></Td>
                <Td>
                  <span className="text-[12px] text-muted">{r.entity_type}</span>
                  {r.entity_id && <span className="mono ml-1 text-[11px] text-faint">{String(r.entity_id).slice(0, 8)}</span>}
                </Td>
                <Td>{r.zone_id ? <Chip>{r.zone_id}</Chip> : null}</Td>
                <Td className="max-w-sm">
                  {r.before != null && (
                    <div className="mono truncate text-[11px] text-danger" title={JSON.stringify(r.before)}>
                      − {JSON.stringify(r.before)}
                    </div>
                  )}
                  {r.after != null && (
                    <div className="mono truncate text-[11px] text-positive" title={JSON.stringify(r.after)}>
                      + {JSON.stringify(r.after)}
                    </div>
                  )}
                </Td>
                <Td><span className="mono text-[11px] text-faint">{r.source_ip ?? '—'}</span></Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}
