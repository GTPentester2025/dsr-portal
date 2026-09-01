import { useCallback, useEffect, useState } from 'react'
import { api, atLeast, ZONES, type CaseGroup, type GroupMember, type Me } from '../lib/api'
import {
  Alert, Button, Card, Chip, EmptyState, Field, Modal, PageHeader, Select,
  Skeleton, Switch, TextInput, Textarea,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'

/** A member row mid-edit. Only `name`/`email` are sent; the rest is local. */
interface MemberDraft {
  name: string
  email: string
}

export function GroupsPage({ me }: { me: Me }) {
  const toast = useToast()
  const [groups, setGroups] = useState<CaseGroup[] | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<CaseGroup | null>(null)

  const reload = useCallback(() => {
    api.get<CaseGroup[]>('/internal/groups')
      .then(setGroups)
      .catch((e) => {
        setErr((e as Error).message)
        setGroups([])
      })
  }, [])
  useEffect(reload, [reload])

  const toggleActive = async (g: CaseGroup, active: boolean) => {
    try {
      await api.patch(`/internal/groups/${g.id}`, { active })
      toast.success(active ? 'Group activated' : 'Group deactivated', g.name)
      reload()
    } catch (e) {
      toast.error('Update failed', (e as Error).message)
    }
  }

  return (
    <>
      <PageHeader
        title="Groups"
        subtitle="People outside the portal — HR, Legal, Security — a case can be sent to for help. They get an emailed link, accept it, and upload documents back. They never get a portal login."
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Add group</Button>}
      />

      {err && <div className="mb-4"><Alert tone="error">{err}</Alert></div>}

      {!groups ? (
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon="users"
            title="No groups yet"
            hint="A group is a set of people outside the portal — HR, Legal, Security — you can send a case to for help."
            action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Add group</Button>}
          />
        </Card>
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <Card
              key={g.id}
              className={g.active ? undefined : 'opacity-70'}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{g.name}</span>
                  <Chip tone="brand">{g.zone_id}</Chip>
                </span>
              }
              subtitle={`${g.members.length} member${g.members.length === 1 ? '' : 's'}`}
              actions={
                <>
                  <Button variant="ghost" icon="edit" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)} />
                  <Switch
                    checked={g.active}
                    label={`Active status for ${g.name}`}
                    onChange={(v) => void toggleActive(g, v)}
                  />
                </>
              }
            >
              <div className="space-y-3">
                {!g.active && (
                  <Chip tone="warning" icon="alert">Inactive — not offered when sending a case</Chip>
                )}

                {g.default_message ? (
                  <p className="line-clamp-3 text-[12px] italic leading-relaxed text-muted">
                    &ldquo;{g.default_message}&rdquo;
                  </p>
                ) : (
                  <p className="text-[12px] text-faint">No default message set.</p>
                )}

                {g.members.length === 0 ? (
                  <p className="flex items-center gap-1.5 text-[12px] text-danger">
                    <Icon name="alert" size={12} />
                    No members — this group cannot be sent a case.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {g.members.map((m) => (
                      <li key={m.id ?? m.email} className="flex items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sunken text-[9px] font-semibold text-muted">
                          {m.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
                        </span>
                        <span className="min-w-0 truncate text-[12px]">
                          <span className="text-ink">{m.name}</span>{' '}
                          <span className="text-faint">{m.email}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating && (
        <GroupFormModal
          me={me}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            reload()
          }}
        />
      )}
      {editing && (
        <GroupFormModal
          me={me}
          group={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
    </>
  )
}

/* ------------------------------- form modal ------------------------------- */

/**
 * Create and edit share one form: the fields are the same, and the only
 * difference is where the zone comes from and which HTTP verb ships it.
 *
 * The zone picker is shown only to someone who actually has a choice — a zone
 * manager or approver has theirs pinned server-side regardless of what the
 * body says, so offering a picker there would just be a control that lies.
 * Editing never touches the zone at all: it is set once, at creation, and the
 * PATCH route does not accept it.
 */
function GroupFormModal({
  me,
  group,
  onClose,
  onSaved,
}: {
  me: Me
  group?: CaseGroup
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const canChooseZone = atLeast(me.role, 'admin')
  const [name, setName] = useState(group?.name ?? '')
  const [zoneId, setZoneId] = useState(group?.zone_id ?? me.zoneId ?? ZONES[0])
  const [message, setMessage] = useState(group?.default_message ?? '')
  const [members, setMembers] = useState<MemberDraft[]>(
    group && group.members.length > 0
      ? group.members.map((m) => ({ name: m.name, email: m.email }))
      : [{ name: '', email: '' }],
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const validMembers = members.filter((m) => m.email.trim())
  const canSave = name.trim().length > 0 && validMembers.length > 0

  const setMember = (i: number, patch: Partial<MemberDraft>) =>
    setMembers((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const removeMember = (i: number) =>
    setMembers((rows) => rows.filter((_, j) => j !== i))

  const save = async () => {
    setBusy(true)
    setErr('')
    const body = {
      name: name.trim(),
      defaultMessage: message,
      members: validMembers.map((m) => ({ name: m.name.trim() || m.email.trim(), email: m.email.trim() })) as GroupMember[],
    }
    try {
      if (group) {
        await api.patch(`/internal/groups/${group.id}`, body)
        toast.success('Group updated', name.trim())
      } else {
        await api.post('/internal/groups', canChooseZone ? { ...body, zoneId } : body)
        toast.success('Group added', name.trim())
      }
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={group ? `Edit ${group.name}` : 'Add a group'}
      description="A standing list of people outside the portal a case can be sent to."
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-4">
        {err && <Alert tone="error">{err}</Alert>}

        <div className={`grid grid-cols-1 gap-4 ${canChooseZone && !group ? 'sm:grid-cols-2' : ''}`}>
          <Field label="Group name" required htmlFor="g-name">
            <TextInput
              id="g-name"
              value={name}
              placeholder="HR"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {canChooseZone && !group && (
            <Field label="Zone" htmlFor="g-zone">
              <Select id="g-zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            </Field>
          )}
        </div>

        {group && (
          <p className="flex items-center gap-1.5 text-[12px] text-faint">
            <Icon name="globe" size={12} />
            Zone <Chip>{group.zone_id}</Chip> — set when the group was created and not changeable here.
          </p>
        )}

        <Field
          label="Default message"
          htmlFor="g-msg"
          hint="Pre-fills the message when a case is sent to this group — worth writing well, since it's what tells them what you need. For example: “HR: please confirm this person's employment dates and attach the relevant record.”"
        >
          <Textarea
            id="g-msg"
            rows={3}
            value={message}
            placeholder="HR: please confirm this person's employment dates and attach the relevant record."
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">
            Members<span className="ml-0.5 text-danger">*</span>
          </p>
          <div className="space-y-2">
            {members.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <TextInput
                  value={m.name}
                  placeholder="Full name"
                  aria-label={`Member ${i + 1} name`}
                  onChange={(e) => setMember(i, { name: e.target.value })}
                  className="flex-1"
                />
                <TextInput
                  type="email"
                  value={m.email}
                  placeholder="person@company.com"
                  aria-label={`Member ${i + 1} email`}
                  onChange={(e) => setMember(i, { email: e.target.value })}
                  className="flex-[1.2]"
                />
                <Button
                  variant="ghost"
                  icon="x"
                  aria-label={`Remove member ${i + 1}`}
                  onClick={() => removeMember(i)}
                />
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            icon="plus"
            className="mt-2"
            onClick={() => setMembers((rows) => [...rows, { name: '', email: '' }])}
          >
            Add member
          </Button>
          {validMembers.length === 0 && (
            <p role="alert" className="mt-1.5 flex items-center gap-1 text-[11px] text-danger">
              <Icon name="alert" size={12} />
              A group needs at least one member with an email address before it can be saved — an empty group cannot be sent a case.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!canSave} onClick={save}>
            {group ? 'Save changes' : 'Add group'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
