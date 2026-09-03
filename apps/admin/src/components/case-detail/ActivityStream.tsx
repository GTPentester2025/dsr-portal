import { useId, useMemo, useState } from 'react'
import { STATUS_LABELS, type CaseDetail } from '../../lib/api'
import { EmptyState, Table, Th } from '../ui'
import { Icon } from '../Icon'
import { RichTextPreview } from '../RichText'

export type HistoryEntry = CaseDetail['history'][number]
export type EmailEntry = CaseDetail['emails'][number]
export type AuditEntry = NonNullable<CaseDetail['activity']>[number]

export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super administrator',
  admin: 'Administrator',
  zone_manager: 'Zone manager',
  approver: 'Approver',
  auditor: 'Auditor',
}

type StreamKind = 'status' | 'email' | 'system'

const KIND_META: Record<StreamKind, { label: string; icon: string; colour: string }> = {
  status: { label: 'Status', icon: 'edit', colour: 'var(--t-gold-1)' },
  email: { label: 'Email', icon: 'mail', colour: 'var(--t-info)' },
  system: { label: 'System', icon: 'database', colour: 'var(--t-faint)' },
}

/** Audit actions that already have a richer entry of their own. */
const FOLDED_ACTIONS = new Set(['case.status_change', 'case.email_sent'])

const AUDIT_LABELS: Record<string, string> = {
  'case.created': 'Case created',
  'case.view': 'Case opened',
  'case.auto_assigned': 'Assigned automatically',
  'case.reassigned': 'Reassigned',
  'case.unassigned_escalated': 'Escalated while unassigned',
  'case.exported_pdf': 'Exported as PDF',
  'case.emailed_externally': 'Forwarded outside the portal',
  'attachment.recorded': 'File attached',
  'attachment.downloaded': 'File downloaded',
  'sla.extended': 'Deadline extended',
  'sla.escalated': 'SLA escalation raised',
  'sla.paused': 'Clock paused',
  'sla.resumed': 'Clock resumed',
  'case.commented': 'Internal note added',
  'case.priority_changed': 'Priority changed',
  'case.tagged': 'Tags changed',
  'case.snoozed': 'Follow-up date changed',
  'case.report_published': 'Outcome report published',
  'case.report_accessed': 'Outcome report read',
  'case.appealed': 'Appeal raised',
  'case.appeal_decided': 'Appeal decided',
  'case.deleted': 'Case deleted',
}

const ACTOR_TYPES: Record<string, string> = {
  system: 'System',
  public: 'Requester',
}

type StreamItem = {
  key: string
  at: number
  kind: StreamKind
  /** Short label shown in the Event column. */
  summary: React.ReactNode
  actor: string
  failed?: boolean
  history?: HistoryEntry
  email?: EmailEntry
  /** The audit row for this event, whether it is its own row or folded in. */
  audit?: AuditEntry
}

const fmtWhen = (ms: number) => {
  const d = new Date(ms)
  return { date: d.toLocaleDateString(), time: d.toLocaleTimeString() }
}

/**
 * One chronological record of everything that happened to the case.
 *
 * `audit_log` also records `case.status_change` and `case.email_sent`, so
 * merging it in wholesale would list every event twice. Those rows are folded
 * into the status/email entry they describe instead, which is what lets the
 * expanded panel show the originating IP and the before/after payload without
 * a second, near-duplicate row underneath.
 */
export function ActivityStream({
  history,
  emails,
  activity,
  openKeys,
  onToggle,
  onToggleAll,
}: {
  history: HistoryEntry[]
  emails: EmailEntry[]
  activity: AuditEntry[]
  openKeys: Set<string>
  onToggle: (key: string) => void
  onToggleAll: (keys: string[]) => void
}) {
  const [scope, setScope] = useState<'all' | StreamKind>('all')
  const [showViews, setShowViews] = useState(false)

  const { items, viewCount } = useMemo(() => {
    const folded = activity.filter((a) => FOLDED_ACTIONS.has(a.action))
    const standalone = activity.filter((a) => !FOLDED_ACTIONS.has(a.action))

    // Same request writes both rows, so the timestamps sit within a second or
    // two of each other. Nearest match inside a small window, consumed once.
    const taken = new Set<number>()
    const pair = (action: string, at: number): AuditEntry | undefined => {
      let best: AuditEntry | undefined
      let bestGap = 5000
      for (const a of folded) {
        if (a.action !== action || taken.has(a.id)) continue
        const gap = Math.abs(new Date(a.created_at).getTime() - at)
        if (gap < bestGap) { best = a; bestGap = gap }
      }
      if (best) taken.add(best.id)
      return best
    }

    const out: StreamItem[] = []

    for (const h of history) {
      const at = new Date(h.createdAt).getTime()
      out.push({
        key: `h-${h.id}`,
        at,
        kind: 'status',
        actor: h.actorName ?? (h.actorId ? 'Unknown user' : 'System'),
        history: h,
        audit: pair('case.status_change', at),
        summary: (
          <>
            {h.fromStatus && h.fromStatus !== h.toStatus && (
              <span className="text-muted">
                {STATUS_LABELS[h.fromStatus] ?? h.fromStatus} →{' '}
              </span>
            )}
            <span className="font-medium text-ink">
              {STATUS_LABELS[h.toStatus] ?? h.toStatus}
            </span>
          </>
        ),
      })
    }

    for (const e of emails) {
      const at = new Date(e.createdAt).getTime()
      out.push({
        key: `e-${e.id}`,
        at,
        kind: 'email',
        actor: 'Privacy team',
        email: e,
        failed: e.status !== 'sent',
        audit: pair('case.email_sent', at),
        summary: <span className="text-ink">{e.subject}</span>,
      })
    }

    for (const a of standalone) {
      out.push({
        key: `a-${a.id}`,
        at: new Date(a.created_at).getTime(),
        kind: 'system',
        actor: a.actor_name ?? ACTOR_TYPES[a.actor_type] ?? 'Unknown',
        audit: a,
        summary: (
          <span className="text-ink">{AUDIT_LABELS[a.action] ?? a.action}</span>
        ),
      })
    }

    out.sort((x, y) => y.at - x.at)
    return {
      items: out,
      viewCount: standalone.filter((a) => a.action === 'case.view').length,
    }
  }, [history, emails, activity])

  // Counts must describe what the filter would actually show, so they follow
  // the page-view toggle rather than the raw totals.
  const inScope = items.filter((i) => showViews || i.audit?.action !== 'case.view')
  const visible = inScope.filter((i) => scope === 'all' || i.kind === scope)

  const counts = {
    all: inScope.length,
    status: inScope.filter((i) => i.kind === 'status').length,
    email: inScope.filter((i) => i.kind === 'email').length,
    system: inScope.filter((i) => i.kind === 'system').length,
  }

  const anyOpen = openKeys.size > 0

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div role="group" aria-label="Filter activity" className="flex flex-wrap gap-1">
          {([
            ['all', `All (${counts.all})`],
            ['status', `Status (${counts.status})`],
            ['email', `Emails (${counts.email})`],
            ['system', `System (${counts.system})`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
              className={`cursor-pointer rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-150 ${
                scope === value
                  ? 'bg-brand-soft text-brand-ink'
                  : 'text-muted hover:bg-sunken hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          {viewCount > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={showViews}
                onChange={(e) => setShowViews(e.target.checked)}
                className="cursor-pointer accent-brand"
              />
              Page views ({viewCount})
            </label>
          )}
          {visible.length > 0 && (
            <button
              type="button"
              onClick={() => onToggleAll(visible.map((i) => i.key))}
              className="cursor-pointer text-[12px] font-medium text-muted transition-colors hover:text-ink"
            >
              {anyOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={items.length === 0 ? 'Nothing has happened yet' : 'No entries match this filter'}
          hint={
            items.length === 0
              ? 'Status changes, messages and recorded actions appear here.'
              : 'Choose a different filter to see the rest of the record.'
          }
        />
      ) : (
        <Table
          caption="Everything recorded against this case, newest first"
          head={
            <>
              <Th className="w-[11.5rem]">When</Th>
              <Th>Event</Th>
              <Th className="w-[11rem]">Actor</Th>
              <Th className="w-10">
                <span className="sr-only">Details</span>
              </Th>
            </>
          }
        >
          {visible.map((item) => (
            <ActivityRow
              key={item.key}
              item={item}
              open={openKeys.has(item.key)}
              onToggle={() => onToggle(item.key)}
            />
          ))}
        </Table>
      )}
    </>
  )
}

function ActivityRow({
  item,
  open,
  onToggle,
}: {
  item: StreamItem
  open: boolean
  onToggle: () => void
}) {
  const panelId = useId()
  const meta = KIND_META[item.kind]
  const when = fmtWhen(item.at)

  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-line/70 transition-colors duration-150 ${
          open ? 'bg-sunken/50' : 'hover:bg-sunken/60'
        }`}
      >
        <td className="px-4 py-2.5 align-top">
          <span className="tabular block text-[12.5px] text-ink">{when.date}</span>
          <span className="tabular block text-[11px] text-faint">{when.time}</span>
        </td>

        <td className="px-4 py-2.5 align-top">
          <span className="flex items-start gap-2">
            <span
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
              style={{ background: meta.colour, color: 'var(--t-on-brand)' }}
              aria-hidden="true"
            >
              <Icon name={meta.icon} size={10} />
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-faint">
                {meta.label}
              </span>
              <span className="block break-words text-[13px]">{item.summary}</span>
              {item.failed && (
                <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-danger">
                  <Icon name="alert" size={11} /> Delivery failed
                </span>
              )}
            </span>
          </span>
        </td>

        <td className="px-4 py-2.5 align-top text-[12.5px] text-muted">{item.actor}</td>

        <td className="px-2 py-2.5 align-top">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${open ? 'Hide' : 'Show'} details for ${meta.label} on ${when.date} ${when.time}`}
            onClick={(e) => { e.stopPropagation(); onToggle() }}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <Icon
              name="chevronDown"
              size={14}
              className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            />
          </button>
        </td>
      </tr>

      {open && (
        <tr className="border-b border-line/70 bg-sunken/30">
          <td colSpan={4} className="px-4 pb-4 pt-1">
            <div id={panelId} role="region" aria-label={`${meta.label} detail`} className="anim-fade">
              <ActivityDetail item={item} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** Audit before/after payloads are arbitrary JSON; render them readably. */
function ChangeBlock({ label, value }: { label: string; value: unknown }) {
  const entries =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>)
      : [['value', value] as [string, unknown]]
  return (
    <div className="rounded-md border border-line bg-surface p-2">
      <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-faint">{label}</p>
      {entries.map(([k, v]) => (
        <p key={k} className="flex gap-1.5 text-[11px]">
          <span className="shrink-0 text-faint">{k}</span>
          <span className="mono min-w-0 flex-1 break-words text-muted">
            {typeof v === 'object' ? JSON.stringify(v) : String(v)}
          </span>
        </p>
      ))}
    </div>
  )
}

/** Everything held about one entry, as a record rather than a paragraph. */
function ActivityDetail({ item }: { item: StreamItem }) {
  const { email: e, history: h, audit: a } = item
  const rows: { label: string; value: string; mono?: boolean }[] = []

  if (e) {
    if (e.fromAddr) rows.push({ label: 'From', value: e.fromAddr, mono: true })
    rows.push({ label: 'To', value: e.toAddrs.join(', '), mono: true })
    if (e.ccAddrs?.length) rows.push({ label: 'Cc', value: e.ccAddrs.join(', '), mono: true })
    if (e.bccAddrs?.length) rows.push({ label: 'Bcc', value: e.bccAddrs.join(', '), mono: true })
    rows.push({ label: 'Subject', value: e.subject })
    rows.push({ label: 'Delivery', value: e.status })
    if (e.error) rows.push({ label: 'Error', value: e.error })
    if (e.templateId) rows.push({ label: 'Template', value: e.templateId, mono: true })
    rows.push({ label: 'Message ID', value: e.id, mono: true })
  }

  if (h) {
    if (h.fromStatus) rows.push({ label: 'From', value: STATUS_LABELS[h.fromStatus] ?? h.fromStatus })
    rows.push({ label: 'To', value: STATUS_LABELS[h.toStatus] ?? h.toStatus })
    if (h.actorEmail) rows.push({ label: 'Account', value: h.actorEmail, mono: true })
    if (h.actorRole) rows.push({ label: 'Role', value: ROLE_LABELS[h.actorRole] ?? h.actorRole })
    if (h.note) rows.push({ label: 'Note', value: h.note })
  }

  if (a) {
    rows.push({ label: 'Action', value: a.action, mono: true })
    if (!h && a.actor_email) rows.push({ label: 'Account', value: a.actor_email, mono: true })
    if (!h && a.actor_role) rows.push({ label: 'Role', value: ROLE_LABELS[a.actor_role] ?? a.actor_role })
    if (a.source_ip) rows.push({ label: 'Source IP', value: a.source_ip, mono: true })
  }

  rows.push({ label: 'Recorded', value: new Date(item.at).toISOString(), mono: true })

  return (
    <div className="space-y-3">
      <table className="w-full border-collapse text-[12px]">
        <caption className="sr-only">Recorded values for this entry</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line/50 last:border-0">
              <th
                scope="row"
                className="w-[8.5rem] py-1.5 pr-3 text-left align-top font-medium text-faint"
              >
                {r.label}
              </th>
              <td
                className={`min-w-0 break-words py-1.5 align-top text-muted ${
                  r.mono ? 'mono text-[11px]' : ''
                }`}
              >
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {(a?.before != null || a?.after != null) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {a?.before != null && <ChangeBlock label="Before" value={a.before} />}
          {a?.after != null && <ChangeBlock label="After" value={a.after} />}
        </div>
      )}

      {e && (
        e.bodyHtml ? (
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
              Message as sent
            </p>
            {/* Our own rendered template, not requester input. */}
            <RichTextPreview html={e.bodyHtml} className="max-h-80 text-[12px]" />
          </div>
        ) : (
          <p className="text-[11.5px] text-faint">
            The body was not retained for this message. Only messages sent after
            body retention was enabled can be replayed here.
          </p>
        )
      )}
    </div>
  )
}
