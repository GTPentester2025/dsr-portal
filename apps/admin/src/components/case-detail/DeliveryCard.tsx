import { useState } from 'react'
import { api, type CaseDetail } from '../../lib/api'
import { Button, Card, Chip, Field, Modal, Textarea } from '../ui'
import { useToast } from '../Toast'

/**
 * What happened after the decision: whether the answer reached the requester,
 * and where the case sits in its appeal window.
 *
 * Kept out of the status lattice on purpose. Closing a case and getting the
 * outcome report in front of the person who asked are different events, and a
 * closed case can still be appealable — folding either into `status` would
 * have meant new states for the SLA engine and the dashboard to disagree over.
 */
export function DeliveryCard({
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

  const act = async (path: string, label: string, body?: unknown, busyKey?: string) => {
    setBusy(busyKey ?? path)
    try {
      await api.post(`/internal/cases/${c.id}/${path}`, body)
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

  // An appeal that is still being considered can be decided from here. The
  // endpoint existed with no way to reach it from any screen.
  const appealUndecided =
    c.isAppeal && (c.appealStatus === 'requested' || c.appealStatus === 'under_review')

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
              <Chip tone="neutral" icon="clock">
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
              {appealUndecided && (
                <>
                  <Button
                    variant="secondary"
                    icon="checkCircle"
                    loading={busy === 'appeal-upheld'}
                    onClick={() =>
                      void act('appeal/decide', 'Appeal recorded as upheld', { status: 'upheld' }, 'appeal-upheld')
                    }
                  >
                    Uphold appeal
                  </Button>
                  <Button
                    variant="secondary"
                    icon="x"
                    loading={busy === 'appeal-rejected'}
                    onClick={() =>
                      void act('appeal/decide', 'Appeal recorded as rejected', { status: 'rejected' }, 'appeal-rejected')
                    }
                  >
                    Reject appeal
                  </Button>
                </>
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
