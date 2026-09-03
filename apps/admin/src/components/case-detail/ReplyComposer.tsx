import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Template, type UserRow } from '../../lib/api'
import { Alert, Button, Card, Field, Select, TextInput } from '../ui'
import { RichTextEditor } from '../RichText'
import { Icon } from '../Icon'

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
 *
 * Ownership can be transferred as part of the send: writing to a colleague
 * about a case very often means the case is now theirs, and doing the
 * reassignment as a second errand on another card is how it gets forgotten.
 * When a recipient address matches a portal user, that user is suggested.
 */
export function ReplyComposer({
  caseId,
  zone,
  requesterEmail,
  approverEmails,
  people,
  currentAssigneeId,
  open,
  onOpenChange,
  onSent,
}: {
  caseId: string
  zone: string
  requesterEmail: string
  approverEmails: string[]
  /** Assignable users in the case's zone; null when the caller may not list them. */
  people: UserRow[] | null
  currentAssigneeId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent: (warning?: string) => void
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
  const [assignToId, setAssignToId] = useState('')
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

  // A half-written statutory response must survive a refresh. Local to this
  // browser on purpose: a draft is one person's unfinished thought, not case
  // record — nothing lands on the case until Send.
  const draftKey = `dsr-draft-${caseId}`
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    try {
      const raw = localStorage.getItem(draftKey)
      if (!raw) return
      const d = JSON.parse(raw)
      if (!d.subject && !d.body) return
      setTo(d.to ?? requesterEmail)
      setCc(d.cc ?? '')
      setBcc(d.bcc ?? '')
      setSubject(d.subject ?? '')
      setBody(d.body ?? '')
      if (d.cc || d.bcc) setShowCopies(true)
      seeded.current = true
      onOpenChange(true)
    } catch {
      /* a corrupt draft is not worth an error */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      if (subject.trim() || body.trim()) {
        localStorage.setItem(draftKey, JSON.stringify({ to, cc, bcc, subject, body }))
      } else {
        localStorage.removeItem(draftKey)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [draftKey, open, to, cc, bcc, subject, body])

  // A recipient who is also a portal user, and not already the owner: the
  // person this message is most plausibly handing the case to.
  const suggested = useMemo(() => {
    if (!people) return null
    const rcpts = new Set([...addrs(to), ...addrs(cc)].map((a) => a.toLowerCase()))
    return (
      people.find(
        (p) => rcpts.has(p.email.toLowerCase()) && p.id !== (currentAssigneeId ?? ''),
      ) ?? null
    )
  }, [people, to, cc, currentAssigneeId])

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
    localStorage.removeItem(draftKey)
    setTemplateId('')
    setTo(requesterEmail)
    setCc(approverEmails.join(', '))
    setBcc('')
    setSubject('')
    setBody('')
    setAssignToId('')
    setErr('')
    onOpenChange(false)
  }

  const send = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api.post<{ ok: boolean; assignWarning?: string }>(
        `/internal/cases/${caseId}/send-email`,
        {
          to: addrs(to),
          cc: addrs(cc),
          bcc: addrs(bcc),
          subject,
          body,
          templateId: templateId || undefined,
          assignToId: assignToId || undefined,
        },
      )
      discard()
      onSent(r?.assignWarning)
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

        {people && people.length > 0 && (
          <Field
            label="Ownership"
            hint="Optional. Hands the case to a colleague as part of this send — recorded as a reassignment."
            htmlFor="assign-with-send"
          >
            <div className="space-y-1.5">
              <Select
                id="assign-with-send"
                value={assignToId}
                onChange={(e) => setAssignToId(e.target.value)}
              >
                <option value="">Keep the current owner</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.id === (currentAssigneeId ?? '')}>
                    Transfer to {p.name}
                    {p.id === (currentAssigneeId ?? '') ? ' (current owner)' : ''}
                  </option>
                ))}
              </Select>
              {suggested && assignToId === '' && (
                <button
                  type="button"
                  onClick={() => setAssignToId(suggested.id)}
                  className="flex cursor-pointer items-center gap-1.5 text-[12px] font-medium text-brand-ink transition-colors hover:underline"
                >
                  <Icon name="userPlus" size={12} />
                  You are writing to {suggested.name} — transfer ownership to them?
                </button>
              )}
            </div>
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
          <Button
            variant="primary"
            icon="send"
            loading={busy}
            disabled={!to || !subject || !body}
            onClick={() => void send()}
          >
            {assignToId ? 'Send and transfer' : 'Send'}
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
