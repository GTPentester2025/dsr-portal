import { useEffect, useState } from 'react'
import { api, type CaseDelegation, type CaseDetail, type CaseGroup } from '../lib/api'
import { Alert, Button, Card, Chip, EmptyState, Field, Modal, Select, Textarea } from './ui'
import { useToast } from './Toast'

const STAGE_TONE: Record<CaseDelegation['stage'], 'brand' | 'positive' | 'neutral'> = {
  sent: 'brand',
  accepted: 'positive',
  closed: 'neutral',
}

/**
 * Handing part of a case to people outside the portal — HR, Legal — who have
 * no login of their own. They get an emailed link, one of them accepts it,
 * and documents come back as attachments on the case.
 *
 * The server allows only one open (non-closed) delegation per case, so this
 * card either offers to start one or shows the one in flight — never both.
 * A partial unique index enforces that at the database level (at most one
 * non-closed delegation per case), so `.find(d => d.stage !== 'closed')`
 * below is guaranteed to find at most one match regardless of `delegations`
 * order.
 */
export function DelegationCard({
  c,
  canAct,
  reload,
}: {
  c: CaseDetail
  canAct: boolean
  reload: () => void
}) {
  const toast = useToast()
  const [sending, setSending] = useState(false)
  const [closing, setClosing] = useState(false)

  // An imported case was decided by another system; nothing here is ever
  // sent anywhere about it, and the server refuses the attempt regardless.
  if (c.source === 'import') return null

  const delegations = c.delegations ?? []
  const open = delegations.find((d) => d.stage !== 'closed')
  const closed = delegations.filter((d) => d.stage === 'closed')

  // Nothing has ever happened here and there is nothing to offer — leave the
  // page to the cards that do have something to show.
  if (delegations.length === 0 && !canAct) return null

  const closeDelegation = async () => {
    if (!open) return
    setClosing(true)
    try {
      await api.post(`/internal/cases/${c.id}/delegations/${open.id}/close`)
      toast.success('Delegation closed', open.group_name)
      reload()
    } catch (e) {
      toast.error('Could not close this', (e as Error).message)
    } finally {
      setClosing(false)
    }
  }

  return (
    <>
      <Card
        title="Sent to a group"
        subtitle="Hand this case to people outside the portal — HR, Legal — for documents you can't get yourself."
      >
        <div className="space-y-3">
          {open ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-ink">{open.group_name}</span>
                <Chip tone={STAGE_TONE[open.stage]}>
                  {open.stage === 'accepted' ? `Accepted by ${open.accepted_by}` : 'Sent'}
                </Chip>
              </div>
              {open.note && <p className="text-[12.5px] leading-relaxed text-muted">{open.note}</p>}
              <p className="text-[11px] text-faint">
                Sent {new Date(open.created_at).toLocaleString()}
                {open.accepted_at && ` · accepted ${new Date(open.accepted_at).toLocaleString()}`}
              </p>
              {canAct && (
                <div className="border-t border-line pt-3">
                  <Button variant="secondary" icon="checkCircle" loading={closing} onClick={() => void closeDelegation()}>
                    Done with {open.group_name}
                  </Button>
                </div>
              )}
            </div>
          ) : canAct ? (
            <div className="border-t border-line pt-3 first:border-t-0 first:pt-0">
              <Button variant="primary" icon="send" onClick={() => setSending(true)}>
                Send to a group
              </Button>
            </div>
          ) : null}

          {closed.length > 0 && (
            <div className={`space-y-2 ${open || canAct ? 'border-t border-line pt-3' : ''}`}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
                Previously sent
              </p>
              {closed.map((d) => (
                <div key={d.id} className="rounded-lg border border-line/70 bg-sunken/40 px-3 py-2.5 opacity-75">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-medium text-ink">{d.group_name}</span>
                    <Chip tone={STAGE_TONE[d.stage]}>Closed</Chip>
                  </div>
                  {d.note && <p className="mt-1 text-[12px] leading-relaxed text-muted">{d.note}</p>}
                  <p className="mt-1 text-[11px] text-faint">
                    Sent {new Date(d.created_at).toLocaleDateString()}
                    {d.accepted_by && ` · accepted by ${d.accepted_by}`}
                    {d.closed_at && ` · closed ${new Date(d.closed_at).toLocaleDateString()}`}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {sending && (
        <SendToGroupModal
          caseId={c.id}
          onClose={() => setSending(false)}
          onSent={(groupName) => {
            setSending(false)
            toast.success('Sent to a group', groupName)
            reload()
          }}
        />
      )}
    </>
  )
}

/**
 * The group picker's note is pre-filled from that group's default message —
 * the main convenience of the feature, since it is what tells the group what
 * is needed without the approver retyping it every time. Changing the group
 * refills it; nothing forces the approver to keep it as written.
 */
function SendToGroupModal({
  caseId,
  onClose,
  onSent,
}: {
  caseId: string
  onClose: () => void
  onSent: (groupName: string) => void
}) {
  const [groups, setGroups] = useState<CaseGroup[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [groupId, setGroupId] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<CaseGroup[]>('/internal/groups')
      .then((rows) => {
        const active = rows.filter((g) => g.active)
        setGroups(active)
        if (active.length === 1) {
          setGroupId(active[0].id)
          setNote(active[0].default_message ?? '')
        }
      })
      .catch((e) => setLoadErr((e as Error).message))
  }, [])

  const chooseGroup = (id: string) => {
    setGroupId(id)
    setNote(groups?.find((g) => g.id === id)?.default_message ?? '')
  }

  const send = async () => {
    setBusy(true)
    setErr('')
    try {
      await api.post(`/internal/cases/${caseId}/delegate`, { groupId, note })
      onSent(groups?.find((g) => g.id === groupId)?.name ?? 'the group')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Send to a group"
      description="They get an emailed link to accept and upload documents back — no portal login needed."
      onClose={onClose}
    >
      <div className="space-y-4">
        {err && <Alert tone="error">{err}</Alert>}

        {loadErr ? (
          <Alert tone="error">{loadErr}</Alert>
        ) : groups === null ? (
          <p className="text-[12.5px] text-muted">Loading groups…</p>
        ) : groups.length === 0 ? (
          <EmptyState
            icon="users"
            title="No active groups"
            hint="Add or activate a group on the Groups page before sending a case."
          />
        ) : (
          <>
            <Field label="Group" required htmlFor="dg-group">
              <Select id="dg-group" value={groupId} onChange={(e) => chooseGroup(e.target.value)}>
                <option value="">Choose a group…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </Select>
            </Field>

            <Field
              label="Note"
              hint="Sent with the invite email. Pre-filled from the group's default message; edit as needed."
              htmlFor="dg-note"
            >
              <Textarea id="dg-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="send"
            loading={busy}
            disabled={!groupId || !groups || groups.length === 0}
            onClick={() => void send()}
          >
            Send
          </Button>
        </div>
      </div>
    </Modal>
  )
}
