import { useCallback, useEffect, useState } from 'react'
import { api, ZONES, type Me, type UserRow, atLeast } from '../lib/api'
import {
  Alert, Button, Card, Chip, Field, Modal, PageHeader, Select, Switch, Table,
  Td, Th, Tr, TextInput,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { ExportButton } from '../components/ExportButton'
import { useToast } from '../components/Toast'
import { ResetPasswordModal } from '../components/PasswordReset'

interface AssignCfg {
  zone_id: string
  strategy: string
  escalation_email: string | null
  escalation_after_minutes: number
}

const STRATEGY_HELP: Record<string, string> = {
  round_robin: 'Rotates evenly through available members.',
  least_open: 'Picks whoever has the fewest open cases.',
  weighted: 'Balances by capacity weight.',
  manual: 'New cases wait in a queue for manual pickup.',
}

/** Escalation delay is stored in minutes; show it in whichever unit fits. */
type DelayUnit = 'minutes' | 'hours' | 'days'
const DELAY_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 }

function splitDelay(totalMinutes: number): { value: number; unit: DelayUnit } {
  if (totalMinutes % 1440 === 0) return { value: totalMinutes / 1440, unit: 'days' }
  if (totalMinutes % 60 === 0) return { value: totalMinutes / 60, unit: 'hours' }
  return { value: totalMinutes, unit: 'minutes' }
}

export function TeamPage({ me }: { me: Me }) {
  const toast = useToast()
  const [resetting, setResetting] = useState<{ id: string; name: string; email: string } | null>(null)
  const [deleting, setDeleting] = useState<UserRow | null>(null)
  const [users, setUsers] = useState<UserRow[]>([])
  const [cfg, setCfg] = useState<AssignCfg[]>([])
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState({ email: '', name: '', role: 'approver', zoneId: me.zoneId ?? 'EUR' })
  const [busy, setBusy] = useState(false)
  // Returned exactly once by the create call. Held in state so the person who
  // added the account can pass it on before it becomes unrecoverable.
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null)

  const reload = useCallback(() => {
    api.get<UserRow[]>('/internal/admin/users').then(setUsers).catch((e) => setErr(String(e)))
    api.get<AssignCfg[]>('/internal/admin/assignment-config').then(setCfg).catch(() => setCfg([]))
  }, [])
  useEffect(reload, [reload])

  const patchUser = async (id: string, body: Record<string, unknown>, label: string) => {
    try {
      await api.patch(`/internal/admin/users/${id}`, body)
      toast.success(label)
      reload()
    } catch (e) {
      toast.error('Update failed', (e as Error).message)
    }
  }

  const isOoo = (u: UserRow) => {
    if (!u.ooo_from || !u.ooo_to) return false
    const now = Date.now()
    return new Date(u.ooo_from).getTime() <= now && now <= new Date(u.ooo_to).getTime()
  }

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Roster, escalation contacts and out-of-office windows. Every approver works every case in their zone."
        actions={<ExportButton href="/internal/admin/users/export.csv" />}
      />

      {issued && (
        <div className="mb-5">
          <Alert tone="warning" title="One-time password — shown once">
            <p className="mb-2.5">
              Give this to <strong>{issued.email}</strong> out of band. It cannot
              be shown again, and they must choose a new password before the
              console will let them do anything.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="mono rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink">
                {issued.password}
              </code>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(issued.password)
                  toast.success('Copied')
                }}
              >
                Copy
              </Button>
              <Button variant="ghost" onClick={() => setIssued(null)}>Dismiss</Button>
            </div>
          </Alert>
        </div>
      )}

      {err && <div className="mb-4"><Alert tone="error">{err}</Alert></div>}

      <div className="stagger grid gap-4 sm:grid-cols-3">
        {cfg.map((c) => {
          const locked = me.role === 'zone_manager' && me.zoneId !== c.zone_id
          return (
            <Card
              key={c.zone_id}
              title={<span className="flex items-center gap-2">Zone <Chip tone="brand">{c.zone_id}</Chip></span>}
            >
              <div className="space-y-4">
                <Field label="Assignment strategy" hint={STRATEGY_HELP[c.strategy]} htmlFor={`s-${c.zone_id}`}>
                  <Select
                    id={`s-${c.zone_id}`}
                    value={c.strategy}
                    disabled={locked}
                    onChange={async (e) => {
                      try {
                        await api.patch(`/internal/admin/assignment-config/${c.zone_id}`, { strategy: e.target.value })
                        toast.success(`${c.zone_id} strategy updated`)
                        reload()
                      } catch (er) {
                        toast.error('Update failed', (er as Error).message)
                      }
                    }}
                  >
                    <option value="round_robin">Round robin</option>
                    <option value="least_open">Least open cases</option>
                    <option value="weighted">Weighted by capacity</option>
                    <option value="manual">Manual queue</option>
                  </Select>
                </Field>

                <Field label="Escalation contact" hint="Notified when a case goes unacknowledged. Falls back to this zone's managers if empty." htmlFor={`e-${c.zone_id}`}>
                  <TextInput
                    id={`e-${c.zone_id}`}
                    type="email"
                    placeholder="escalations@company.com"
                    defaultValue={c.escalation_email ?? ''}
                    disabled={locked}
                    onBlur={async (e) => {
                      if (e.target.value === (c.escalation_email ?? '')) return
                      try {
                        await api.patch(`/internal/admin/assignment-config/${c.zone_id}`, { escalationEmail: e.target.value })
                        toast.success(`${c.zone_id} escalation contact saved`)
                        reload()
                      } catch (er) {
                        toast.error('Update failed', (er as Error).message)
                      }
                    }}
                  />
                </Field>

                <Field
                  label="Escalate unassigned after"
                  hint="How long a case may sit with no assignee before the contact above is emailed."
                  htmlFor={`ed-${c.zone_id}`}
                >
                  <div className="flex gap-2">
                    <TextInput
                      id={`ed-${c.zone_id}`}
                      type="number"
                      min={1}
                      className="flex-1"
                      disabled={locked}
                      defaultValue={splitDelay(c.escalation_after_minutes).value}
                      onBlur={async (e) => {
                        const value = Number(e.target.value)
                        const unit = splitDelay(c.escalation_after_minutes).unit
                        if (!value || value * DELAY_MINUTES[unit] === c.escalation_after_minutes) return
                        try {
                          await api.patch(`/internal/admin/assignment-config/${c.zone_id}`, {
                            escalationAfterValue: value,
                            escalationAfterUnit: unit,
                          })
                          toast.success(`${c.zone_id} escalation delay saved`)
                          reload()
                        } catch (er) {
                          toast.error('Update failed', (er as Error).message)
                        }
                      }}
                    />
                    <div className="w-[116px] shrink-0">
                      <Select
                        aria-label="Escalation delay unit"
                        disabled={locked}
                        value={splitDelay(c.escalation_after_minutes).unit}
                        onChange={async (e) => {
                          const unit = e.target.value as DelayUnit
                          const value = splitDelay(c.escalation_after_minutes).value
                          try {
                            await api.patch(`/internal/admin/assignment-config/${c.zone_id}`, {
                              escalationAfterValue: value,
                              escalationAfterUnit: unit,
                            })
                            toast.success(`${c.zone_id} escalation delay saved`)
                            reload()
                          } catch (er) {
                            toast.error('Update failed', (er as Error).message)
                          }
                        }}
                      >
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </Select>
                    </div>
                  </div>
                </Field>
              </div>
            </Card>
          )
        })}
      </div>

      <div className="mt-5">
        <Card title="Add a team member" subtitle="Members sign in with SSO once wired; break-glass passwords are set from the server CLI.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
            <Field label="Email" required htmlFor="n-email">
              <TextInput id="n-email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="person@company.com" />
            </Field>
            <Field label="Full name" required htmlFor="n-name">
              <TextInput id="n-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Alex Moreno" />
            </Field>
            <Field label="Role" htmlFor="n-role">
              <Select id="n-role" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                <option value="approver">Approver</option>
                <option value="zone_manager">Zone manager</option>
                {atLeast(me.role, 'admin') && <option value="auditor">Auditor</option>}
                {atLeast(me.role, 'admin') && <option value="admin">Administrator</option>}
              </Select>
            </Field>
            <Field label="Zone" htmlFor="n-zone">
              <Select
                id="n-zone"
                value={draft.zoneId}
                disabled={me.role === 'zone_manager' || ['admin', 'auditor'].includes(draft.role)}
                onChange={(e) => setDraft({ ...draft, zoneId: e.target.value })}
              >
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            </Field>
            <Button
              variant="primary"
              icon="userPlus"
              loading={busy}
              disabled={!draft.email || !draft.name}
              onClick={async () => {
                setBusy(true)
                try {
                  const created = await api.post<{ temporaryPassword?: string }>(
                    '/internal/admin/users',
                    {
                      email: draft.email,
                      name: draft.name,
                      role: draft.role,
                      zoneId: ['admin', 'auditor'].includes(draft.role) ? undefined : draft.zoneId,
                    },
                  )
                  if (created?.temporaryPassword) {
                    setIssued({ email: draft.email, password: created.temporaryPassword })
                  }
                  toast.success('Team member added', draft.email)
                  setDraft({ ...draft, email: '', name: '' })
                  reload()
                } catch (e) {
                  toast.error('Could not add member', (e as Error).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Add member
            </Button>
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <Card title="Roster" subtitle={`${users.length} member${users.length === 1 ? '' : 's'}`} bleed>
          <Table
            head={
              <>
                <Th>Member</Th><Th>Role</Th><Th>Zone</Th><Th>Capacity</Th>
                <Th>Out of office until</Th><Th className="text-right">Active</Th>
              </>
            }
          >
            {users.map((u) => (
              <Tr key={u.id}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sunken text-[10px] font-semibold text-muted">
                      {u.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">{u.name}</p>
                      <p className="truncate text-[11px] text-faint">{u.email}</p>
                    </div>
                    {isOoo(u) && <Chip tone="warning" icon="clock">Away</Chip>}
                    {u.has_password === false && (
                      <Chip tone="danger" icon="key">No sign-in</Chip>
                    )}
                  </div>
                </Td>
                <Td className="text-[12px] capitalize text-muted">{u.role.replace('_', ' ')}</Td>
                <Td>{u.zone_id ? <Chip>{u.zone_id}</Chip> : <span className="text-[12px] text-faint">Global</span>}</Td>
                <Td>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    defaultValue={u.capacity_weight}
                    aria-label={`Capacity weight for ${u.name}`}
                    className="mono min-h-8 w-16 rounded-lg border border-line bg-surface px-2 text-[12px] text-ink"
                    onBlur={(e) => {
                      const v = Number(e.target.value)
                      if (v !== u.capacity_weight && v >= 1) void patchUser(u.id, { capacityWeight: v }, 'Capacity updated')
                    }}
                  />
                </Td>
                <Td>
                  <input
                    type="date"
                    defaultValue={u.ooo_to ? u.ooo_to.slice(0, 10) : ''}
                    aria-label={`Out of office end date for ${u.name}`}
                    className="mono min-h-8 rounded-lg border border-line bg-surface px-2 text-[12px] text-ink"
                    onBlur={(e) => {
                      const v = e.target.value
                      void patchUser(
                        u.id,
                        v
                          ? { oooFrom: new Date().toISOString(), oooTo: new Date(`${v}T23:59:59`).toISOString() }
                          : { oooFrom: null, oooTo: null },
                        v ? 'Out-of-office set' : 'Out-of-office cleared',
                      )
                    }}
                  />
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-1">
                    {me.role === 'super_admin' && (
                      <Button
                        variant="ghost"
                        icon="key"
                        aria-label={`Reset password for ${u.name}`}
                        onClick={() => setResetting({ id: u.id, name: u.name, email: u.email })}
                      >
                        Reset
                      </Button>
                    )}
                    <Switch
                      checked={u.active}
                      label={`Active status for ${u.name}`}
                      onChange={(v) => void patchUser(u.id, { active: v }, v ? 'Member activated' : 'Member deactivated')}
                    />
                    {me.role === 'super_admin' && u.id !== me.id && (
                      <Button
                        variant="ghost"
                        icon="trash"
                        aria-label={`Permanently delete ${u.name}`}
                        title="Permanently delete this account"
                        className="text-danger hover:bg-danger/10"
                        onClick={() => setDeleting(u)}
                      />
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </Table>
          <p className="flex items-center gap-1.5 border-t border-line px-4 py-3 text-[11px] text-faint">
            <Icon name="info" size={12} />
            Inactive members and anyone inside an out-of-office window are skipped by auto-assignment.
            Deactivating keeps the account; deleting erases it while leaving their name on the
            work they did.
          </p>
        </Card>
      </div>

      {resetting && (
        <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />
      )}

      {deleting && (
        <DeleteUserModal
          user={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            reload()
          }}
        />
      )}
    </>
  )
}

/**
 * Permanent deletion, behind a typed confirmation.
 *
 * Deactivating is the reversible option and is one click away in the same row,
 * so this dialog's job is to make sure the irreversible one was chosen on
 * purpose — and to say plainly what survives, because "delete the user" and
 * "delete their audit trail" are different things and only the first happens.
 */
function DeleteUserModal({
  user,
  onClose,
  onDeleted,
}: {
  user: UserRow
  onClose: () => void
  onDeleted: () => void
}) {
  const toast = useToast()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const confirmed = typed.trim().toLowerCase() === user.email.trim().toLowerCase()

  const remove = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await api.del<{ openCasesUnassigned: number }>(`/internal/admin/users/${user.id}`)
      toast.success(
        `${user.name} deleted`,
        res.openCasesUnassigned
          ? `${res.openCasesUnassigned} open case(s) are now unassigned`
          : undefined,
      )
      onDeleted()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Permanently delete ${user.name}?`}
      description="This cannot be undone."
      onClose={onClose}
    >
      <div className="space-y-4">
        <Alert tone="error" title="What this removes">
          The account, its password, and every session it has open. They will no longer
          appear in the team list, be assignable, or be able to sign in. This cannot be
          undone — there is no way to restore the account afterwards.
        </Alert>
        <Alert tone="info" title="What it keeps">
          The record of what they did. <strong>{user.name}</strong> stays named against every
          audit entry, case timeline entry, comment and file they touched — those are the
          case file and the audit trail, and neither is worth much if it cannot say who
          acted.
        </Alert>
        <p className="text-[13px] text-muted">
          Any open cases assigned to them become unassigned, and a note saying so is added to
          each one&rsquo;s timeline.
        </p>

        <Field
          label={`Type ${user.email} to confirm`}
          error={err || undefined}
          htmlFor="confirm-delete-user"
        >
          <TextInput
            id="confirm-delete-user"
            value={typed}
            autoComplete="off"
            placeholder={user.email}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!confirmed} onClick={remove}>
            Delete permanently
          </Button>
        </div>
      </div>
    </Modal>
  )
}
