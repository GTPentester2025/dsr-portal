import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  api, OUTCOME_CODES, STATUS_LABELS,
  type CaseDetail, type Me, type Template, type UserRow,
} from '../lib/api'
import {
  Alert, Button, Card, Chip, EmptyState, Field, Modal, Select, Skeleton, StatusBadge,
  Table, Td, Textarea, TextInput, Th, Tr,
} from '../components/ui'
import { RichTextEditor, RichTextPreview } from '../components/RichText'
import { Icon } from '../components/Icon'
import { Attachments } from '../components/Attachments'
import { FieldValue, humaniseKey } from '../components/FieldValue'
import { CaseShare } from '../components/CaseShare'
import { useToast } from '../components/Toast'

export function CaseDetailPage({ me, caseId }: { me: Me; caseId: string }) {
  const toast = useToast()
  const [c, setC] = useState<CaseDetail | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'' | 'extend'>('')
  // The reply composer lives in the page, not a dialog, so its open state does
  // too — the header button scrolls to it rather than covering the record.
  const [replyOpen, setReplyOpen] = useState(false)
  // A set, not a single key: comparing two entries side by side is the common
  // reason to open one at all.
  const [openEntries, setOpenEntries] = useState<Set<string>>(() => new Set())

  const reload = useCallback(() => {
    api.get<CaseDetail>(`/internal/cases/${caseId}`).then(setC).catch((e) => setError(String(e)))
  }, [caseId])
  useEffect(reload, [reload])

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

  const due = c.slaClock ? new Date(c.slaClock.dueAt) : c.dueAt ? new Date(c.dueAt) : null
  const daysLeft = due ? Math.ceil((due.getTime() - Date.now()) / 86400000) : null
  // An imported case is a record of something another system already handled.
  // Nothing in the workflow applies to it and nothing is ever sent about it,
  // so every control that would act on it is withheld — the server refuses
  // these too, this only stops an operator being offered them.
  const imported = c.source === 'import'
  const canAct = me.role !== 'auditor' && c.status !== 'closed' && !imported

  const slaTone =
    daysLeft === null ? 'neutral' : daysLeft < 0 ? 'danger' : daysLeft <= 3 ? 'warning' : 'positive'

  return (
    <>
      <div className="mb-5">
        <a href="#/cases" className="mb-3 inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors hover:text-ink">
          <Icon name="chevronLeft" size={13} /> All cases
        </a>

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
          {daysLeft !== null && c.status !== 'closed' && (
            <Chip tone={slaTone} icon={daysLeft < 0 ? 'alert' : 'clock'}>
              {daysLeft < 0 ? `${-daysLeft}d overdue` : daysLeft === 0 ? 'Due today' : `${daysLeft}d to SLA`}
            </Chip>
          )}

          {/* Export is always available: an auditor and a closed case still need it. */}
          <div className="ml-auto flex flex-wrap gap-2">
            <CaseShare c={c} onSent={reload} />
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

      {/* minmax(0,1fr) rather than an implicit track: a grid track's automatic
          minimum is its content, which let a long SLA line push the whole page
          sideways on a phone. */}
      {imported && (
        <div className="mx-auto mb-4 max-w-6xl">
          <Alert tone="info" title="Imported record — not worked here">
            This case was brought in from another system, which received and answered it. It is
            kept so it can be found, exported and audited. Nothing is ever sent to the requester
            about it, and its status changes only by uploading a newer export on the{' '}
            <a href="#/migration" className="font-medium underline">Migration</a> page.
          </Alert>
        </div>
      )}

      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4">
          {c.slaClock && (
            <Card>
              <SlaProgress clock={c.slaClock} status={c.status} />
              {c.slaClock.extensionJustification && (
                <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-muted">
                  <span className="font-medium text-ink">Extension: </span>
                  {c.slaClock.extensionJustification}
                </p>
              )}
            </Card>
          )}
        {/* ---------------------------- submission --------------------------- */}
        <Card
          title="Submission"
          subtitle={`${c.formKey} · schema v${(c as unknown as { formVersion?: number }).formVersion ?? '—'} · ${c.fields.length + 1} fields`}
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

        <Card title="Files" subtitle="Everything held against this case">
          <Attachments caseId={caseId} canUpload={canAct} onChanged={reload} />
        </Card>

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
                open={replyOpen}
                onOpenChange={setReplyOpen}
                onSent={() => { toast.success('Response sent'); reload() }}
              />
            </div>
          )}

        </div>

        <CaseProperties
          c={c}
          me={me}
          canAct={canAct}
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

    </>
  )
}

/* -------------------------------- modals --------------------------------- */


/** Split a comma or semicolon separated address line into addresses. */
const addrs = (line: string) =>
  line.split(/[,;]/).map((a) => a.trim()).filter(Boolean)

/**
 * Reply composer, at the foot of the thread rather than in a modal.
 *
 * A reply is written *against* what is on screen — the submission and the
 * previous messages — so covering them with a dialog is the wrong shape. It
 * stays collapsed to a single line until invoked, which keeps the page's
 * centre of gravity on the record.
 */
function ReplyComposer({
  caseId,
  zone,
  requesterEmail,
  approverEmails,
  open,
  onOpenChange,
  onSent,
}: {
  caseId: string
  zone: string
  requesterEmail: string
  approverEmails: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent: () => void
}) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [templateId, setTemplateId] = useState('')
  const [to, setTo] = useState(requesterEmail)
  // The zone's approvers are copied by default so the team keeps a record of
  // what went out; either line can be cleared before sending.
  const [cc, setCc] = useState(approverEmails.join(', '))
  const [bcc, setBcc] = useState('')
  const [showCopies, setShowCopies] = useState(approverEmails.length > 0)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<Template[]>(`/internal/templates?zone=${zone}`)
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [zone])

  useEffect(() => {
    // The editor is a contentEditable node, not an input, so reach it by id.
    if (open) document.getElementById('body')?.focus()
  }, [open])

  // The case (and with it the approver list) resolves after first paint, so
  // seed Cc once rather than fighting the user's edits afterwards.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || approverEmails.length === 0) return
    seeded.current = true
    setCc(approverEmails.join(', '))
    setShowCopies(true)
  }, [approverEmails])

  const loadDraft = async (id: string) => {
    setTemplateId(id)
    if (!id) return
    try {
      const d = await api.get<{ to: string; subject: string; body: string }>(
        `/internal/cases/${caseId}/draft-email?templateId=${id}`,
      )
      setTo(d.to)
      setSubject(d.subject)
      setBody(d.body)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const discard = () => {
    setTemplateId('')
    setTo(requesterEmail)
    setCc(approverEmails.join(', '))
    setBcc('')
    setSubject('')
    setBody('')
    setErr('')
    onOpenChange(false)
  }

  const send = async () => {
    setBusy(true)
    setErr('')
    try {
      await api.post(`/internal/cases/${caseId}/send-email`, {
        to: addrs(to),
        cc: addrs(cc),
        bcc: addrs(bcc),
        subject,
        body,
        templateId: templateId || undefined,
      })
      discard()
      onSent()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const dirty = body.trim() !== '' || subject.trim() !== ''

  if (!open) {
    return (
      <Card bleed>
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-sunken/60"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand">
            <Icon name="send" size={13} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">Write a reply</span>
            <span className="block truncate text-[11.5px] text-muted">
              To {requesterEmail}
              {approverEmails.length > 0 && ` · cc ${approverEmails.length} approver${approverEmails.length > 1 ? 's' : ''}`}
              {' · from the configured privacy mailbox'}
            </span>
          </span>
        </button>
      </Card>
    )
  }

  return (
    <Card
      title="Reply"
      subtitle="Sent from the configured privacy mailbox and recorded on this case"
    >
      <div className="space-y-3.5">
        {err && <Alert tone="error">{err}</Alert>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_minmax(0,15rem)]">
          <Field label="To" required hint="Comma-separated for several recipients." htmlFor="to">
            <TextInput id="to" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Subject" required htmlFor="subject">
            <TextInput id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Template" hint="Fills the fields; edit before sending." htmlFor="tpl">
            <Select id="tpl" value={templateId} onChange={(e) => void loadDraft(e.target.value)}>
              <option value="">Blank message…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>
              ))}
            </Select>
          </Field>
        </div>

        {showCopies ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Cc"
              hint={approverEmails.length > 0 ? 'Defaults to the zone approvers.' : undefined}
              htmlFor="cc"
            >
              <TextInput id="cc" value={cc} onChange={(e) => setCc(e.target.value)} />
            </Field>
            <Field label="Bcc" hint="Hidden from every other recipient." htmlFor="bcc">
              <TextInput id="bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} />
            </Field>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCopies(true)}
            className="cursor-pointer text-[12px] font-medium text-muted transition-colors hover:text-ink"
          >
            Add Cc or Bcc
          </button>
        )}

        <Field
          label="Message"
          required
          hint="Format with the toolbar; switch to HTML only if you need the markup."
          htmlFor="body"
        >
          <RichTextEditor
            id="body"
            minHeight={220}
            ariaLabel="Reply body"
            value={body}
            onChange={setBody}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
          <Button
            variant="primary"
            icon="send"
            loading={busy}
            disabled={!to || !subject || !body}
            onClick={() => void send()}
          >
            Send
          </Button>
          <span className="text-[11.5px] text-faint">
            The message is stored against the case and can be replayed from Activity.
          </span>
          <div className="ml-auto">
            <Button
              variant="ghost"
              icon="x"
              onClick={discard}
              aria-label={dirty ? 'Discard this draft' : 'Close the composer'}
            >
              {dirty ? 'Discard' : 'Close'}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super administrator',
  admin: 'Administrator',
  zone_manager: 'Zone manager',
  approver: 'Approver',
  auditor: 'Auditor',
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

/** Push the response deadline out, with a justification for the audit trail. */
function ExtendModal({
  caseId,
  dueAt,
  onClose,
  onDone,
}: {
  caseId: string
  dueAt: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [value, setValue] = useState(7)
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days'>('days')
  const [justification, setJustification] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const projected = dueAt
    ? new Date(
        new Date(dueAt).getTime() +
          value * { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[unit],
      )
    : null

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await api.post(`/internal/cases/${caseId}/sla/extend`, { value, unit, justification })
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Extend the response deadline" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Extend by" required htmlFor="ex-value">
            <div className="flex gap-2">
              <TextInput
                id="ex-value"
                type="number"
                min={1}
                className="flex-1"
                value={value}
                onChange={(e) => setValue(Math.max(1, Number(e.target.value)))}
              />
              <div className="w-[116px] shrink-0">
                <Select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </Select>
              </div>
            </div>
          </Field>

          <Field label="New deadline" hint="Calculated from the current deadline.">
            <p className="mono flex min-h-9 items-center rounded-lg border border-line bg-sunken px-3 text-[12px] text-ink">
              {projected ? projected.toLocaleString() : 'No clock on this case'}
            </p>
          </Field>
        </div>

        <Field
          label="Justification"
          required
          hint="Recorded on the timeline and in the audit log. Regulators expect a stated reason."
          htmlFor="ex-why"
        >
          <Textarea
            id="ex-why"
            rows={3}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="Complexity of the request requires additional time to collate records."
          />
        </Field>

        {err && <Alert tone="error">{err}</Alert>}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="clock" loading={busy} disabled={!justification.trim()} onClick={submit}>
            Extend deadline
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * How much of the window is gone, and how long is left.
 *
 * Two dates required mental arithmetic to answer the only question that
 * matters on this screen, so the bar and the remaining time lead instead.
 */
function SlaProgress({
  clock,
  status,
}: {
  clock: { state: string; dueAt: string; startedAt: string; pausedTotalSecs: number }
  status: string
}) {
  const start = new Date(clock.startedAt).getTime()
  const due = new Date(clock.dueAt).getTime()
  const now = Date.now()
  const total = Math.max(1, due - start)
  const used = Math.min(1, Math.max(0, (now - start) / total))
  const remainingMs = due - now
  const breached = remainingMs < 0 || clock.state === 'breached'
  const closed = status === 'closed' || clock.state === 'stopped'

  const tone = closed
    ? 'var(--t-faint)'
    : breached
      ? 'var(--t-danger)'
      : used > 0.75
        ? 'var(--t-warning)'
        : 'var(--t-positive)'

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Icon name="clock" size={15} style={{ color: tone }} className="shrink-0" />
      <p className="text-[13.5px] font-semibold" style={{ color: tone }}>
        {closed ? 'Clock stopped' : breached ? `Overdue by ${humanise(-remainingMs)}` : `${humanise(remainingMs)} left`}
      </p>

      {/* min-w-0 lets the bar shrink below its basis; without it the row is
          wider than the card on a phone and pushes the page sideways. */}
      <div className="h-1.5 min-w-0 flex-1 basis-32 overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${used * 100}%`, background: tone, transitionTimingFunction: 'var(--ease-out-expo)' }}
        />
      </div>

      <span className="mono text-[11px] text-faint">{Math.round(used * 100)}% used</span>
      <span className="mono text-[11px] text-faint">
        due {new Date(clock.dueAt).toLocaleString()}
      </span>
    </div>
  )
}

/** "3 days", "5 hours", "12 minutes" — the largest unit that is not zero. */
function humanise(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

type HistoryEntry = CaseDetail['history'][number]
type EmailEntry = CaseDetail['emails'][number]
type AuditEntry = NonNullable<CaseDetail['activity']>[number]

/* ------------------------------ submission -------------------------------- */

/**
 * The submitted form, as a record rather than a prose block.
 *
 * A table is the honest shape here: every row is the same pair of things, the
 * reader scans down one column, and the storage column makes it visible which
 * answers are held encrypted without relying on an icon's colour alone.
 */
function SubmissionTable({ c }: { c: CaseDetail }) {
  return (
    <Table
      caption={`Fields submitted on case ${c.caseRef}`}
      head={
        <>
          <Th className="w-[13rem]">Field</Th>
          <Th>Value</Th>
          <Th className="w-[7.5rem]">Storage</Th>
        </>
      }
    >
      <Tr>
        <Td className="align-top">
          <span className="text-[12.5px] text-muted">Requester</span>
        </Td>
        <Td className="align-top">
          <p className="font-medium text-ink">{c.requesterName || 'Not provided'}</p>
          <p className="break-all text-[12.5px] text-muted">{c.requesterEmail}</p>
        </Td>
        <Td className="align-top">
          <StorageTag encrypted />
        </Td>
      </Tr>

      {c.fields.map((f) => (
        <Tr key={f.key}>
          <Td className="align-top">
            <span className="block text-[12.5px] text-muted">{humaniseKey(f.key)}</span>
            {/* The raw key is what appears in exports and the form schema, so
                it is shown rather than hidden behind a tooltip. */}
            <span className="mono block text-[10.5px] text-faint">{f.key}</span>
          </Td>
          <Td className="min-w-0 break-words align-top text-ink">
            <FieldValue value={f.value} />
          </Td>
          <Td className="align-top">
            <StorageTag encrypted={f.encrypted} />
          </Td>
        </Tr>
      ))}
    </Table>
  )
}

/** Icon plus word: colour alone must not carry the distinction. */
function StorageTag({ encrypted }: { encrypted: boolean }) {
  if (!encrypted) return <span className="text-[11.5px] text-faint">Plain</span>
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-positive">
      <Icon name="key" size={11} className="shrink-0" />
      Encrypted
    </span>
  )
}

/* -------------------------------- activity -------------------------------- */

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
function ActivityStream({
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

/* ------------------------------ side rail --------------------------------- */

/** One label/value line in the rail. */
function RailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11.5px] text-faint">{label}</span>
      <span className="min-w-0 break-words text-right text-[12.5px] text-ink">{children}</span>
    </div>
  )
}

const fmtDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString() : '—'

/**
 * Details, requester and editable properties, beside the record.
 *
 * The status control is the same workflow as the old dialog, not a plain
 * dropdown: extending still demands a justification and a new date, and
 * closing still demands an outcome code and a note. Those are the Article
 * 12(3) paper trail, so Update stays disabled until they are supplied.
 */
function CaseProperties({
  c,
  me,
  canAct,
  onExtend,
  reload,
}: {
  c: CaseDetail
  me: Me
  canAct: boolean
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
  const [people, setPeople] = useState<UserRow[] | null>(null)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  // Listing users is admin/zone_manager only, while assigning is open to
  // approvers too. A 403 here is expected, not an error worth showing.
  useEffect(() => {
    if (!canAct) return
    api.get<UserRow[]>(`/internal/admin/users?zone=${c.zoneId}`)
      .then((rows) => setPeople(rows.filter((u) => u.active && u.zone_id === c.zoneId)))
      .catch(() => setPeople(null))
  }, [c.zoneId, canAct])

  const statusChanged = status !== '' && status !== c.status
  const assigneeChanged = assignee !== (c.assigneeId ?? '')
  const needsExtend = status === 'extended'
  const needsClosure = status === 'closed'
  const ready =
    (statusChanged || assigneeChanged) &&
    (!needsExtend || (justification.trim() !== '' && newDueDate !== '')) &&
    (!needsClosure || closureNote.trim() !== '')

  const update = async () => {
    setBusy(true)
    setErr('')
    try {
      if (assigneeChanged) {
        await api.post(`/internal/cases/${c.id}/assign`, { assigneeId: assignee })
      }
      if (statusChanged) {
        const r = await api.post<{ notice?: string }>(`/internal/cases/${c.id}/status`, {
          toStatus: status,
          note,
          justification,
          newDueDate: newDueDate ? new Date(newDueDate).toISOString() : undefined,
          outcomeCode: needsClosure ? outcomeCode : undefined,
          closureNote: needsClosure ? closureNote : undefined,
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
  const daysLeft = due ? Math.ceil((new Date(due).getTime() - Date.now()) / 86400000) : null
  const urgency =
    c.status === 'closed' ? { tone: 'neutral' as const, text: 'Closed' }
    : daysLeft === null ? { tone: 'neutral' as const, text: 'No deadline' }
    : daysLeft < 0 ? { tone: 'danger' as const, text: `${-daysLeft}d overdue` }
    : daysLeft <= 3 ? { tone: 'warning' as const, text: `Due in ${daysLeft}d` }
    : { tone: 'positive' as const, text: 'On track' }

  const assigneeName =
    people?.find((p) => p.id === (c.assigneeId ?? ''))?.name
    ?? (c.assigneeId ? 'Assigned' : 'Unassigned')

  return (
    <aside className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 lg:sticky lg:top-20">
      <Card title="Details">
        <div className="divide-y divide-line">
          <RailRow label="Case ID"><span className="mono">{c.caseRef}</span></RailRow>
          <RailRow label="Zone">{c.zoneId}</RailRow>
          <RailRow label="Request type">{c.requestTypes.join(', ') || '—'}</RailRow>
          <RailRow label="Form"><span className="mono text-[11.5px]">{c.formKey}</span></RailRow>
          <RailRow label="Submitted">{fmtDate(c.createdAt)}</RailRow>
          <RailRow label="Response due">{fmtDate(due)}</RailRow>
          <RailRow label="Urgency">
            <Chip tone={urgency.tone} icon={urgency.tone === 'danger' ? 'alert' : 'clock'}>
              {urgency.text}
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
                {Object.entries(STATUS_LABELS)
                  .filter(([k]) => k === c.status || k !== 'overdue')
                  .map(([k, v]) => <option key={k} value={k}>{v}</option>)}
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
 * What happened after the decision: whether the answer reached the requester,
 * and where the case sits in its appeal window.
 *
 * Kept out of the status lattice on purpose. Closing a case and getting the
 * outcome report in front of the person who asked are different events, and a
 * closed case can still be appealable — folding either into `status` would
 * have meant new states for the SLA engine and the dashboard to disagree over.
 */
function DeliveryCard({
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
  const [appealing, setAppealing] = useState(false)

  // Nothing to show or do until a case is decided, unless it is itself an
  // appeal — that is worth surfacing from the moment it is raised.
  // Delivery and appeals are workflow: an imported case's belong to the system
  // that handled it, and the facts it carries are already shown above.
  if (c.source === 'import') return null
  if (c.status !== 'closed' && !c.isAppeal) return null

  const act = async (path: string, label: string) => {
    setBusy(path)
    try {
      await api.post(`/internal/cases/${c.id}/${path}`)
      toast.success(label)
      reload()
    } catch (e) {
      toast.error('That did not work', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const appealOpen =
    Boolean(c.canBeAppealed) &&
    (!c.canAppealUntil || new Date(c.canAppealUntil) > new Date())

  return (
    <>
      <Card
        title="Outcome delivery"
        subtitle="Sending the answer is a separate event from closing the case."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {c.isAppeal && <Chip tone="brand" icon="refresh">This case is an appeal</Chip>}
            {c.reportAccessedAt ? (
              <Chip tone="positive" icon="checkCircle">
                Read by the data subject · {String(c.reportAccessedAt).slice(0, 10)}
              </Chip>
            ) : c.reportPublishedAt ? (
              <Chip tone="brand" icon="send">
                Published · {String(c.reportPublishedAt).slice(0, 10)}
              </Chip>
            ) : (
              <Chip tone="warning" icon="alert">Report not yet sent</Chip>
            )}
            {c.appealStatus && (
              <Chip tone={c.appealStatus === 'rejected' ? 'danger' : 'brand'}>
                Appeal {c.appealStatus.replace('_', ' ')}
              </Chip>
            )}
            {c.canAppealUntil && (
              <Chip tone={appealOpen ? 'neutral' : 'neutral'} icon="clock">
                {appealOpen ? 'Appealable until' : 'Appeal window closed'}{' '}
                {String(c.canAppealUntil).slice(0, 10)}
              </Chip>
            )}
            {c.completedAfterDeadline === true && (
              <Chip tone="danger" icon="alert">Completed after the deadline</Chip>
            )}
          </div>

          {canAct && (
            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              {!c.reportPublishedAt && (
                <Button
                  icon="send"
                  loading={busy === 'report/publish'}
                  onClick={() => void act('report/publish', 'Report recorded as published')}
                >
                  Report published
                </Button>
              )}
              {c.reportPublishedAt && !c.reportAccessedAt && (
                <Button
                  icon="eye"
                  loading={busy === 'report/accessed'}
                  onClick={() => void act('report/accessed', 'Report recorded as read')}
                >
                  Confirmed read by subject
                </Button>
              )}
              {appealOpen && !c.isAppeal && (
                <Button variant="secondary" icon="refresh" onClick={() => setAppealing(true)}>
                  Raise an appeal
                </Button>
              )}
            </div>
          )}

          {!c.canBeAppealed && c.status === 'closed' && (
            <p className="text-[11px] text-faint">
              Appeals are not offered for this zone and request type. Set an appeal window on
              the SLA policy to enable them.
            </p>
          )}
        </div>
      </Card>

      {appealing && (
        <AppealModal caseId={c.id} caseRef={c.caseRef} onClose={() => setAppealing(false)} />
      )}
    </>
  )
}

/**
 * An appeal becomes its own case rather than reopening the original.
 *
 * Reopening would erase the response time of the request being appealed and
 * leave the appeal itself invisible to the SLA engine — the two need separate
 * clocks, and a regulator asks about both.
 */
function AppealModal({
  caseId,
  caseRef,
  onClose,
}: {
  caseId: string
  caseRef: string
  onClose: () => void
}) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await api.post<{ caseRef: string; id: string }>(
        `/internal/cases/${caseId}/appeal`,
        { reason },
      )
      toast.success(`Appeal raised as ${res.caseRef}`)
      onClose()
      location.hash = `#/cases/${res.id}`
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Appeal ${caseRef}`}
      description="Creates a linked case with its own deadline. The original is marked as under appeal."
      onClose={onClose}
    >
      <div className="space-y-4">
        <Field
          label="Why is the outcome being appealed?"
          hint="Recorded on the new case's timeline and on the original."
          error={err || undefined}
          htmlFor="appeal-reason"
        >
          <Textarea
            id="appeal-reason"
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <p className="text-[12px] text-muted">
          The requester's details and every answer they gave are copied to the appeal, so it can
          be judged against what was originally asked.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!reason.trim()} onClick={submit}>
            Raise appeal
          </Button>
        </div>
      </div>
    </Modal>
  )
}
