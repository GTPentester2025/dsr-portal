import { useCallback, useEffect, useState } from 'react'
import {
  api, atLeast,
  type CaseDetail, type Me, type UserRow, type WorkflowTransitions,
} from '../lib/api'
import { urgencyOf } from '../lib/sla'
import { Alert, Button, Card, Chip, Skeleton, StatusBadge } from '../components/ui'
import { Icon } from '../components/Icon'
import { Attachments } from '../components/Attachments'
import { CaseShare } from '../components/CaseShare'
import { DelegationCard } from '../components/DelegationCard'
import { useToast } from '../components/Toast'
import { SlaCard } from '../components/case-detail/SlaCard'
import { SubmissionTable } from '../components/case-detail/SubmissionTable'
import { ActivityStream } from '../components/case-detail/ActivityStream'
import { ReplyComposer } from '../components/case-detail/ReplyComposer'
import { CaseProperties } from '../components/case-detail/CaseProperties'
import { DeliveryCard } from '../components/case-detail/DeliveryCard'
import { CommentsCard } from '../components/case-detail/CommentsCard'
import { DeleteCaseModal, ExtendModal } from '../components/case-detail/modals'

/**
 * The surrounding queue, left behind by the case list so this page can walk
 * it. Session-scoped: it describes the view the operator came from, not any
 * durable state.
 */
function readNav(caseId: string): { prev: string | null; next: string | null } {
  try {
    const raw = sessionStorage.getItem('dsr-case-nav')
    if (!raw) return { prev: null, next: null }
    const ids: string[] = JSON.parse(raw).ids ?? []
    const i = ids.indexOf(caseId)
    if (i === -1) return { prev: null, next: null }
    return { prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null }
  } catch {
    return { prev: null, next: null }
  }
}

export function CaseDetailPage({ me, caseId }: { me: Me; caseId: string }) {
  const toast = useToast()
  const [c, setC] = useState<CaseDetail | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'' | 'extend'>('')
  const [deleting, setDeleting] = useState(false)
  // The reply composer lives in the page, not a dialog, so its open state does
  // too — the header button scrolls to it rather than covering the record.
  const [replyOpen, setReplyOpen] = useState(false)
  // A set, not a single key: comparing two entries side by side is the common
  // reason to open one at all.
  const [openEntries, setOpenEntries] = useState<Set<string>>(() => new Set())
  // Fetched once and shared: the properties rail assigns from it and the
  // composer offers ownership transfer from it. A 403 (approvers cannot list
  // users) leaves it null and both fall back gracefully.
  const [people, setPeople] = useState<UserRow[] | null>(null)
  // The workflow as data, so the status control offers only legal moves.
  const [workflow, setWorkflow] = useState<WorkflowTransitions | null>(null)

  const reload = useCallback(() => {
    api.get<CaseDetail>(`/internal/cases/${caseId}`).then(setC).catch((e) => setError(String(e)))
  }, [caseId])
  useEffect(reload, [reload])

  useEffect(() => {
    api.get<WorkflowTransitions>('/internal/workflow/transitions')
      .then(setWorkflow)
      .catch(() => setWorkflow(null))
  }, [])

  const [watchBusy, setWatchBusy] = useState(false)
  const nav = readNav(caseId)

  const toggleWatch = async () => {
    setWatchBusy(true)
    try {
      await api.post(`/internal/cases/${caseId}/${c?.amWatching ? 'unwatch' : 'watch'}`)
      reload()
    } catch (e) {
      toast.error('That did not work', (e as Error).message)
    } finally {
      setWatchBusy(false)
    }
  }

  const zoneId = c?.zoneId
  const auditor = me.role === 'auditor'
  useEffect(() => {
    if (!zoneId || auditor) return
    api.get<UserRow[]>(`/internal/admin/users?zone=${zoneId}`)
      .then((rows) => setPeople(rows.filter((u) => u.active && u.zone_id === zoneId)))
      .catch(() => setPeople(null))
  }, [zoneId, auditor])

  if (error) return <Alert tone="error" title="Could not load this case">{error}</Alert>
  if (!c) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-80" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Skeleton className="h-96" />
          <Skeleton className="h-72" />
        </div>
      </div>
    )
  }

  // An imported case is a record of something another system already handled.
  // Nothing in the workflow applies to it and nothing is ever sent about it,
  // so every control that would act on it is withheld — the server refuses
  // these too, this only stops an operator being offered them.
  const imported = c.source === 'import'
  const canAct = me.role !== 'auditor' && c.status !== 'closed' && !imported

  const urgency = urgencyOf(c.status, c.slaClock?.dueAt ?? c.dueAt)

  return (
    <>
      <div className="mb-5">
        <div className="mb-3 flex items-center gap-3">
          <a href="#/cases" className="inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors hover:text-ink">
            <Icon name="chevronLeft" size={13} /> All cases
          </a>
          {(nav.prev || nav.next) && (
            <span className="ml-auto flex items-center gap-1">
              <NavLink id={nav.prev} label="Previous case" icon="chevronLeft" />
              <NavLink id={nav.next} label="Next case" icon="chevronRight" />
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="mono text-[19px] font-semibold tracking-tight text-ink">{c.caseRef}</h1>
          <Chip>{c.zoneId}</Chip>
          <StatusBadge status={c.status} />
          {imported && (
            <Chip tone="neutral" icon="upload">
              Imported{c.externalId ? ` · ${c.externalId}` : ''}
            </Chip>
          )}
          {c.pendingOn && (
            <Chip
              tone={c.pendingParty === 'customer' ? 'warning' : 'brand'}
              icon={c.pendingParty === 'customer' ? 'clock' : 'users'}
            >
              Pending on {c.pendingOn}
              {c.pendingParty === 'internal' && ' (internal)'}
            </Chip>
          )}
          {urgency.daysLeft !== null && c.status !== 'closed' && (
            <Chip tone={urgency.tone} icon={urgency.overdue ? 'alert' : 'clock'}>
              {urgency.text}
            </Chip>
          )}

          {/* Export is always available: an auditor and a closed case still need it. */}
          <div className="ml-auto flex flex-wrap gap-2">
            {me.role !== 'auditor' && (
              <Button
                variant={c.amWatching ? 'secondary' : 'ghost'}
                icon={c.amWatching ? 'eye' : 'eyeOff'}
                loading={watchBusy}
                onClick={() => void toggleWatch()}
                aria-pressed={c.amWatching}
                title={
                  c.amWatching
                    ? 'You are emailed when this case moves. Click to stop.'
                    : 'Get an email when this case moves — status changes, replies, notes.'
                }
              >
                {c.amWatching ? 'Watching' : 'Watch'}
                {(c.watchers?.length ?? 0) > 0 && ` (${c.watchers!.length})`}
              </Button>
            )}
            <CaseShare c={c} onSent={reload} />
            {atLeast(me.role, 'admin') && (
              <Button
                variant="ghost"
                icon="trash"
                className="text-danger hover:bg-danger/10"
                onClick={() => setDeleting(true)}
              >
                Delete case
              </Button>
            )}
          </div>

          {canAct && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon="clock" onClick={() => setModal('extend')}>Extend SLA</Button>
              <Button
                variant="primary"
                icon="send"
                onClick={() => {
                  setReplyOpen(true)
                  document.getElementById('reply')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }}
              >
                Send response
              </Button>
            </div>
          )}
        </div>
      </div>

      {imported && (
        <div className="mx-auto mb-4 max-w-6xl">
          <Alert tone="info" title="Imported record — not worked here">
            This case was brought in from another system, which received and answered it. It is
            kept so it can be found, exported and audited. Nothing is ever sent to the requester
            about it, and its status is whatever the export said
            {c.sourceStatus ? <> — <span className="mono">{c.sourceStatus}</span></> : null}, changing
            only by uploading a newer export on the{' '}
            <a href="#/migration" className="font-medium underline">Migration</a> page.
          </Alert>
        </div>
      )}

      {/* minmax(0,1fr) rather than an implicit track: a grid track's automatic
          minimum is its content, which let a long SLA line push the whole page
          sideways on a phone. */}
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4">
          <SlaCard c={c} canAct={canAct} reload={reload} />

          <Card
            title="Submission"
            subtitle={`${c.formKey} · schema v${c.formVersion ?? '—'} · ${c.fields.length + 1} fields`}
            bleed
          >
            <SubmissionTable c={c} />

            {c.status === 'closed' && (
              <div className="border-t border-line px-4 py-3.5">
                <p className="text-[13px] font-medium text-ink">
                  Outcome: <span className="mono">{c.outcomeCode}</span>
                </p>
                {c.closureNote && <p className="mt-1 text-[13px] text-muted">{c.closureNote}</p>}
              </div>
            )}
          </Card>

          <DeliveryCard c={c} canAct={canAct} reload={reload} />

          <DelegationCard c={c} canAct={canAct} reload={reload} />

          <Card title="Files" subtitle="Everything held against this case">
            <Attachments caseId={caseId} canUpload={canAct} onChanged={reload} />
          </Card>

          <CommentsCard c={c} canComment={me.role !== 'auditor'} reload={reload} />

          <Card title="Activity" subtitle="Newest first · select a row for the full record" bleed>
            <ActivityStream
              history={c.history}
              emails={c.emails}
              activity={c.activity ?? []}
              openKeys={openEntries}
              onToggle={(k) =>
                setOpenEntries((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(k)) next.add(k)
                  return next
                })
              }
              onToggleAll={(keys) =>
                setOpenEntries((prev) => (prev.size > 0 ? new Set() : new Set(keys)))
              }
            />
          </Card>

          {canAct && (
            <div id="reply" className="scroll-mt-20">
              <ReplyComposer
                caseId={caseId}
                zone={c.zoneId}
                requesterEmail={c.requesterEmail}
                approverEmails={c.approverEmails ?? []}
                people={people}
                currentAssigneeId={c.assigneeId}
                open={replyOpen}
                onOpenChange={setReplyOpen}
                onSent={(assignWarning) => {
                  if (assignWarning) {
                    toast.error('Sent, but ownership was not transferred', assignWarning)
                  } else {
                    toast.success('Response sent')
                  }
                  reload()
                }}
              />
            </div>
          )}
        </div>

        <CaseProperties
          c={c}
          me={me}
          canAct={canAct}
          people={people}
          workflow={workflow}
          onExtend={() => setModal('extend')}
          reload={reload}
        />
      </div>

      {modal === 'extend' && (
        <ExtendModal
          caseId={c.id}
          dueAt={c.dueAt}
          onClose={() => setModal('')}
          onDone={() => { setModal(''); toast.success('Deadline extended'); reload() }}
        />
      )}

      {deleting && <DeleteCaseModal c={c} onClose={() => setDeleting(false)} />}
    </>
  )
}

/** Prev/next within the queue the operator came from. Disabled at the ends. */
function NavLink({ id, label, icon }: { id: string | null; label: string; icon: string }) {
  if (!id) {
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-md text-line" aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
    )
  }
  return (
    <a
      href={`#/cases/${id}`}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-sunken hover:text-ink"
    >
      <Icon name={icon} size={14} />
    </a>
  )
}
