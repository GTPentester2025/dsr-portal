import { useState } from 'react'
import {
  api, OUTCOME_CODES, STATUS_LABELS,
  type CaseDetail, type Me, type UserRow, type WorkflowTransitions,
} from '../../lib/api'
import { fmtDate, fmtDateTime, urgencyOf } from '../../lib/sla'
import { Alert, Button, Card, Chip, Field, Select, StatusBadge, Textarea, TextInput } from '../ui'
import { Icon } from '../Icon'
import { useToast } from '../Toast'

/** One label/value line in the rail. */
export function RailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11.5px] text-faint">{label}</span>
      <span className="min-w-0 break-words text-right text-[12.5px] text-ink">{children}</span>
    </div>
  )
}

/**
 * Details, requester and editable properties, beside the record.
 *
 * The status control offers only the moves the transition table allows from
 * the case's current state — "Illegal transition" used to be something an
 * operator discovered after writing a closure note. Extending still demands a
 * justification and a new date, and closing still demands an outcome code and
 * a note: that is the Article 12(3) paper trail, so Update stays disabled
 * until they are supplied.
 */
export function CaseProperties({
  c,
  me,
  canAct,
  people,
  workflow,
  onExtend,
  reload,
}: {
  c: CaseDetail
  me: Me
  canAct: boolean
  people: UserRow[] | null
  workflow: WorkflowTransitions | null
  onExtend: () => void
  reload: () => void
}) {
  const toast = useToast()
  const [status, setStatus] = useState('')
  const [assignee, setAssignee] = useState(c.assigneeId ?? '')
  const [note, setNote] = useState('')
  const [justification, setJustification] = useState('')
  const [newDueDate, setNewDueDate] = useState('')
  const [outcomeCode, setOutcomeCode] = useState('fulfilled')
  const [closureNote, setClosureNote] = useState('')
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const statusChanged = status !== '' && status !== c.status
  const assigneeChanged = assignee !== (c.assigneeId ?? '')
  const needsExtend = status === 'extended'
  const needsClosure = status === 'closed'
  const ready =
    (statusChanged || assigneeChanged) &&
    (!needsExtend || (justification.trim() !== '' && newDueDate !== '')) &&
    (!needsClosure || closureNote.trim() !== '')

  // Targets the server would accept from here. Without the table (still
  // loading, or the request failed) every status is offered and the server
  // remains the judge — the old behaviour, not a lockout.
  const legalTargets = (() => {
    if (!workflow) return null
    const allowed = new Set(
      workflow.transitions.filter((t) => t.from === c.status).map((t) => t.to),
    )
    for (const s of workflow.systemOnly) allowed.delete(s)
    return allowed
  })()

  const statusOptions = Object.entries(STATUS_LABELS).filter(
    ([k]) => k === c.status || (legalTargets ? legalTargets.has(k) : k !== 'overdue'),
  )

  const update = async () => {
    setBusy(true)
    setErr('')
    try {
      if (assigneeChanged) {
        await api.post(`/internal/cases/${c.id}/assign`, {
          assigneeId: assignee,
          reason: c.assigneeId ? note || 'Reassigned from the case screen' : undefined,
          expectedUpdatedAt: c.updatedAt,
        })
      }
      if (statusChanged) {
        const r = await api.post<{ notice?: string }>(`/internal/cases/${c.id}/status`, {
          toStatus: status,
          note,
          justification,
          newDueDate: newDueDate ? new Date(newDueDate).toISOString() : undefined,
          outcomeCode: needsClosure ? outcomeCode : undefined,
          closureNote: needsClosure ? closureNote : undefined,
          // Guard against the assign call above having just touched the case:
          // only send the stale-check when this is a pure status change.
          expectedUpdatedAt: assigneeChanged ? undefined : c.updatedAt,
        })
        if (r?.notice) {
          setNotice(r.notice)
          reload()
          return
        }
      }
      toast.success('Case updated')
      setStatus('')
      setNote('')
      setJustification('')
      setNewDueDate('')
      setClosureNote('')
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const due = c.slaClock ? c.slaClock.dueAt : c.dueAt
  const urgency = urgencyOf(c.status, due)
  const urgencyText =
    urgency.daysLeft === null
      ? urgency.text
      : urgency.overdue
        ? urgency.text
        : urgency.atRisk
          ? `Due in ${urgency.daysLeft}d`
          : 'On track'

  const assigneeName =
    people?.find((p) => p.id === (c.assigneeId ?? ''))?.name
    ?? c.assigneeName
    ?? (c.assigneeId ? 'Assigned' : 'Unassigned')

  return (
    <aside className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 lg:sticky lg:top-20">
      <Card title="Details">
        <div className="divide-y divide-line">
          <RailRow label="Case ID"><span className="mono">{c.caseRef}</span></RailRow>
          <RailRow label="Zone">{c.zoneId}</RailRow>
          <RailRow label="Request type">{c.requestTypes.join(', ') || '—'}</RailRow>
          <RailRow label="Form"><span className="mono text-[11.5px]">{c.formKey}</span></RailRow>
          <RailRow label="Submitted">{fmtDateTime(c.createdAt)}</RailRow>
          <RailRow label="Response due">{fmtDateTime(due)}</RailRow>
          <RailRow label="Urgency">
            <Chip tone={urgency.tone} icon={urgency.tone === 'danger' ? 'alert' : 'clock'}>
              {urgencyText}
            </Chip>
          </RailRow>
        </div>
      </Card>

      <Card title="Requester">
        <div className="divide-y divide-line">
          <RailRow label="Name">{c.requesterName || 'Not provided'}</RailRow>
          <RailRow label="Email">
            <span className="break-all">{c.requesterEmail}</span>
          </RailRow>
          <RailRow label="Country">{c.country || '—'}</RailRow>
        </div>
      </Card>

      <RelatedCases c={c} />

      <WorkingCard c={c} canAct={canAct} reload={reload} />

      <Card title="Properties" subtitle={canAct ? undefined : 'Read-only on a closed case'}>
        {!canAct ? (
          <div className="divide-y divide-line">
            <RailRow label="Status"><StatusBadge status={c.status} /></RailRow>
            <RailRow label="Assignee">{assigneeName}</RailRow>
          </div>
        ) : notice ? (
          <div className="space-y-3">
            <Alert tone="warning" title="Action required">{notice}</Alert>
            <Button variant="primary" className="w-full" onClick={() => { setNotice(''); setStatus('') }}>
              Understood
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {err && <Alert tone="error">{err}</Alert>}

            <Field label="Status" htmlFor="p-status">
              <Select id="p-status" value={status || c.status} onChange={(e) => setStatus(e.target.value)}>
                {!Object.keys(STATUS_LABELS).includes(c.status) && (
                  <option value={c.status}>{c.status}</option>
                )}
                {statusOptions.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>

            {needsExtend && (
              <>
                <Field
                  label="Justification"
                  required
                  hint="Communicated to the data subject under GDPR Article 12(3)."
                  htmlFor="p-just"
                >
                  <TextInput id="p-just" value={justification} onChange={(e) => setJustification(e.target.value)} />
                </Field>
                <Field label="New due date" required htmlFor="p-due">
                  <TextInput id="p-due" type="date" value={newDueDate} onChange={(e) => setNewDueDate(e.target.value)} />
                </Field>
              </>
            )}

            {needsClosure && (
              <>
                <Field label="Outcome" required htmlFor="p-out">
                  <Select id="p-out" value={outcomeCode} onChange={(e) => setOutcomeCode(e.target.value)}>
                    {OUTCOME_CODES.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
                  </Select>
                </Field>
                <Field label="Closure note" required htmlFor="p-close">
                  <Textarea id="p-close" rows={3} value={closureNote} onChange={(e) => setClosureNote(e.target.value)} />
                </Field>
              </>
            )}

            <Field
              label="Assign to"
              hint={people ? undefined : 'Listing the team needs a manager role.'}
              htmlFor="p-assignee"
            >
              {people ? (
                <Select id="p-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">Unassigned</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.role.replace(/_/g, ' ')})</option>
                  ))}
                </Select>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{assigneeName}</span>
                  {assignee !== me.id && (
                    <Button variant="secondary" onClick={() => setAssignee(me.id)}>Assign to me</Button>
                  )}
                </div>
              )}
            </Field>

            <Field label="Internal note" hint="Optional. Recorded on the timeline." htmlFor="p-note">
              <TextInput id="p-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>

            <Button
              variant="primary"
              className="w-full"
              loading={busy}
              disabled={!ready}
              onClick={() => void update()}
            >
              Update
            </Button>

            <button
              type="button"
              onClick={onExtend}
              className="w-full cursor-pointer text-center text-[12px] font-medium text-muted transition-colors hover:text-ink"
            >
              Extend the SLA clock instead
            </button>
          </div>
        )}
      </Card>
    </aside>
  )
}

/**
 * How the team is working the case: priority, tags, and the operator's own
 * follow-up date. None of it touches the workflow or the SLA clock — the
 * deadline belongs to the regulator, these belong to the queue.
 */
function WorkingCard({
  c,
  canAct,
  reload,
}: {
  c: CaseDetail
  canAct: boolean
  reload: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const tags = c.tags ?? []
  const priority = c.priority ?? 'normal'
  const snoozed = c.snoozedUntil && new Date(c.snoozedUntil) > new Date()

  const act = async (key: string, path: string, body: unknown, done: string) => {
    setBusy(key)
    try {
      await api.post(`/internal/cases/${c.id}/${path}`, body)
      toast.success(done)
      reload()
    } catch (e) {
      toast.error('That did not work', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const addTag = () => {
    const t = tagDraft.trim().toLowerCase()
    if (!t || tags.includes(t)) { setTagDraft(''); return }
    void act('tags', 'tags', { tags: [...tags, t] }, `Tagged ${t}`)
    setTagDraft('')
  }

  if (!canAct && priority === 'normal' && tags.length === 0 && !snoozed) return null

  return (
    <Card title="Working">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-faint">Priority</span>
          {canAct ? (
            <button
              type="button"
              disabled={busy === 'priority'}
              onClick={() =>
                void act(
                  'priority',
                  'priority',
                  { priority: priority === 'high' ? 'normal' : 'high' },
                  priority === 'high' ? 'Priority back to normal' : 'Marked high priority',
                )
              }
              className="cursor-pointer"
              aria-pressed={priority === 'high'}
            >
              <Chip tone={priority === 'high' ? 'danger' : 'neutral'} icon={priority === 'high' ? 'alert' : undefined}>
                {priority === 'high' ? 'High — click to clear' : 'Normal — click to raise'}
              </Chip>
            </button>
          ) : (
            <Chip tone={priority === 'high' ? 'danger' : 'neutral'}>{priority}</Chip>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[11.5px] text-faint">Tags</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-[11.5px] text-ink ring-1 ring-line">
                {t}
                {canAct && (
                  <button
                    type="button"
                    aria-label={`Remove tag ${t}`}
                    onClick={() => void act('tags', 'tags', { tags: tags.filter((x) => x !== t) }, `Removed ${t}`)}
                    className="cursor-pointer text-faint hover:text-danger"
                  >
                    <Icon name="x" size={10} />
                  </button>
                )}
              </span>
            ))}
            {tags.length === 0 && !canAct && <span className="text-[11.5px] text-faint">None</span>}
            {canAct && (
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                onBlur={() => tagDraft.trim() && addTag()}
                placeholder="add tag ⏎"
                aria-label="Add a tag"
                className="w-20 rounded-md border border-dashed border-line bg-transparent px-1.5 py-0.5 text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-brand-ink"
              />
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-faint">Follow-up</span>
          {snoozed ? (
            <span className="flex items-center gap-1.5">
              <Chip tone="brand" icon="clock">until {fmtDate(c.snoozedUntil)}</Chip>
              {canAct && (
                <button
                  type="button"
                  onClick={() => void act('snooze', 'snooze', { until: null }, 'Snooze cleared')}
                  className="cursor-pointer text-[11.5px] font-medium text-muted hover:text-ink"
                >
                  Clear
                </button>
              )}
            </span>
          ) : canAct ? (
            <input
              type="date"
              aria-label="Snooze until"
              min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
              onChange={(e) => {
                if (e.target.value) {
                  void act('snooze', 'snooze', { until: new Date(`${e.target.value}T09:00:00`).toISOString() }, 'Snoozed')
                }
              }}
              className="rounded-md border border-line bg-transparent px-1.5 py-0.5 text-[11.5px] text-ink outline-none focus:border-brand-ink"
            />
          ) : (
            <span className="text-[11.5px] text-faint">—</span>
          )}
        </div>
        <p className="text-[10.5px] leading-snug text-faint">
          Snoozing hides the case behind the list's “hide snoozed” filter. The SLA clock is not
          affected.
        </p>
      </div>
    </Card>
  )
}

/**
 * The appeal pair and every other case this requester has, as links.
 *
 * The appeal linkage existed only as prose in a timeline note; the requester
 * match is what lets an operator spot a duplicate before working — or
 * deleting — the wrong case.
 */
function RelatedCases({ c }: { c: CaseDetail }) {
  const related = c.relatedCases ?? []
  const appeals = c.appeals ?? []
  if (!c.appealOf && appeals.length === 0 && related.length === 0) return null

  return (
    <Card
      title="Related cases"
      subtitle={related.length > 0 ? 'Same requester email' : undefined}
    >
      <div className="space-y-1">
        {c.appealOf && (
          <RelatedRow
            id={c.appealOf.id}
            label={c.appealOf.case_ref}
            detail="This case appeals it"
            icon="refresh"
          />
        )}
        {appeals.map((a) => (
          <RelatedRow key={a.id} id={a.id} label={a.case_ref} detail="Appeal of this case" icon="refresh" />
        ))}
        {related
          .filter((r) => r.id !== c.appealOf?.id && !appeals.some((a) => a.id === r.id))
          .map((r) => (
            <RelatedRow
              key={r.id}
              id={r.id}
              label={r.case_ref}
              detail={`${STATUS_LABELS[r.status] ?? r.status} · ${fmtDate(r.created_at)}${r.is_appeal ? ' · appeal' : ''}${r.source === 'import' ? ' · imported' : ''}`}
              icon="file"
            />
          ))}
      </div>
    </Card>
  )
}

function RelatedRow({
  id,
  label,
  detail,
  icon,
}: {
  id: string
  label: string
  detail: string
  icon: string
}) {
  return (
    <a
      href={`#/cases/${id}`}
      className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-sunken/60"
    >
      <Icon name={icon} size={12} className="shrink-0 text-faint" />
      <span className="mono min-w-0 truncate text-[12px] font-medium text-brand-ink group-hover:underline">
        {label}
      </span>
      <span className="min-w-0 truncate text-[11px] text-faint">{detail}</span>
      <Icon name="arrowUpRight" size={11} className="ml-auto shrink-0 text-faint" />
    </a>
  )
}
