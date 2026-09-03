import { useState } from 'react'
import { api, type CaseDeletionSummary, type CaseDetail } from '../../lib/api'
import { Alert, Button, Field, Modal, Select, Textarea, TextInput } from '../ui'
import { useToast } from '../Toast'

/**
 * Destroying a case, behind a typed confirmation and a stated reason.
 *
 * The reason is not ceremony. A deleted request is a hole in a compliance
 * record, and the only thing that makes one explicable a year later is
 * somebody having written down at the time why they made it. The server
 * refuses a blank or perfunctory one.
 */
export function DeleteCaseModal({ c, onClose }: { c: CaseDetail; onClose: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const confirmed = typed.trim().toUpperCase() === c.caseRef.toUpperCase()

  const purge = async () => {
    setBusy(true)
    setErr('')
    try {
      const s = await api.del<CaseDeletionSummary>(`/internal/cases/${c.id}`, { reason })
      const rows = Object.values(s.removed).reduce((a, b) => a + b, 0)
      toast.success(
        `${s.caseRef} deleted`,
        `${rows} record${rows === 1 ? '' : 's'} and ${s.filesRemoved} file${s.filesRemoved === 1 ? '' : 's'} removed`,
      )
      location.hash = '#/cases'
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Delete ${c.caseRef}?`}
      description="This cannot be undone."
      onClose={onClose}
    >
      <div className="space-y-4">
        <Alert tone="error" title="What this destroys">
          The request and everything belonging to it — the answers the requester gave, the
          timeline, comments, correspondence, any delegation, the SLA clock, and the uploaded
          files themselves, deleted from storage rather than merely unlinked.
        </Alert>
        <Alert tone="info" title="What survives">
          The audit log. Every entry recording what was done to this case stays, including this
          deletion and the reason you give below — that record is what an investigation reads,
          and nothing in the console can remove it.
        </Alert>
        <p className="text-[13px] text-muted">
          Deleting a case is not the same as erasing the person. Earlier audit entries can
          contain their email address, and those are kept.
        </p>

        <Field
          label="Why is this case being deleted?"
          hint="Recorded permanently. Write what somebody reading it in a year would need."
          htmlFor="delete-reason"
        >
          <Textarea
            id="delete-reason"
            rows={3}
            value={reason}
            placeholder="Duplicate of DSR-SAZ-2026-00042, submitted twice by the same person."
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>

        <Field
          label={`Type ${c.caseRef} to confirm`}
          error={err || undefined}
          htmlFor="delete-confirm"
        >
          <TextInput
            id="delete-confirm"
            value={typed}
            autoComplete="off"
            placeholder={c.caseRef}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!confirmed || reason.trim().length < 10}
            onClick={purge}
          >
            Delete permanently
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Push the response deadline out, with a justification for the audit trail. */
export function ExtendModal({
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
