import { useCallback, useEffect, useState } from 'react'
import { api, ZONES, type Me } from '../lib/api'
import {
  Alert, Button, Card, Chip, Field, Modal, Select, Skeleton, Switch,
  Table, Td, Th, Tr, TextInput,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'

interface Policy {
  id: string
  zone_id: string
  request_type: string
  target_minutes: number
  business_days: boolean
  timezone: string
  holidays: string[]
  pause_allowed: boolean
  extension_allowed_days: number
  /** Days after closure in which the requester may appeal. 0 => no appeals. */
  appeal_window_days: number
  reminder_thresholds: number[]
  escalation_threshold: number
}

interface RequestType { value: string; label: string }

const TIMEZONES = [
  'UTC', 'Europe/Brussels', 'Europe/London', 'Europe/Madrid',
  'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Santiago',
  'America/Bogota', 'America/Mexico_City', 'America/Lima', 'America/El_Salvador',
]

/**
 * Minutes are the stored unit. These helpers keep the editor showing whichever
 * unit the number was naturally expressed in, so a 30-day policy does not
 * appear as 43200 minutes.
 */
type Unit = 'minutes' | 'hours' | 'days'
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 }

function splitDuration(totalMinutes: number): { value: number; unit: Unit } {
  if (totalMinutes % 1440 === 0) return { value: totalMinutes / 1440, unit: 'days' }
  if (totalMinutes % 60 === 0) return { value: totalMinutes / 60, unit: 'hours' }
  return { value: totalMinutes, unit: 'minutes' }
}

function formatDuration(totalMinutes: number): string {
  const { value, unit } = splitDuration(totalMinutes)
  return `${value} ${value === 1 ? unit.slice(0, -1) : unit}`
}

const blank = (zone: string): Partial<Policy> => ({
  zone_id: zone,
  request_type: 'access',
  target_minutes: 30 * 1440,
  business_days: false,
  timezone: 'UTC',
  holidays: [],
  pause_allowed: false,
  extension_allowed_days: 0,
  appeal_window_days: 0,
  reminder_thresholds: [0.75, 0.9, 1],
  escalation_threshold: 0.9,
})

export function SlaPolicies({ me }: { me: Me }) {
  const toast = useToast()
  const [policies, setPolicies] = useState<Policy[] | null>(null)
  const [types, setTypes] = useState<RequestType[]>([])
  const [editing, setEditing] = useState<Partial<Policy> | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api
      .get<{ policies: Policy[]; requestTypes: RequestType[] }>('/internal/sla-policies')
      .then((r) => { setPolicies(r.policies); setTypes(r.requestTypes) })
      .catch((e) => setErr(String(e)))
  }, [])
  useEffect(load, [load])

  // Derived from the stored minutes so the input and the unit dropdown stay in
  // step no matter which one the user changes.
  const { value: targetValue, unit: targetUnit } = splitDuration(
    editing?.target_minutes ?? 30 * 1440,
  )

  const save = async () => {
    if (!editing) return
    setBusy(true)
    setErr('')
    try {
      await api.put(`/internal/sla-policies/${editing.zone_id}/${editing.request_type}`, {
        targetValue: targetValue,
        targetUnit: targetUnit,
        businessDays: Boolean(editing.business_days),
        timezone: editing.timezone,
        holidays: editing.holidays ?? [],
        pauseAllowed: Boolean(editing.pause_allowed),
        extensionAllowedDays: Number(editing.extension_allowed_days ?? 0),
        appealWindowDays: Number(editing.appeal_window_days ?? 0),
        reminderThresholds: editing.reminder_thresholds ?? [0.75, 0.9, 1],
        escalationThreshold: Number(editing.escalation_threshold ?? 0.9),
      })
      toast.success('SLA policy saved', `${editing.zone_id} · ${editing.request_type}`)
      setEditing(null)
      load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: Policy) => {
    if (!confirm(`Remove the ${p.request_type} policy for ${p.zone_id}? The zone fallback will apply instead.`)) return
    try {
      await api.del(`/internal/sla-policies/${p.zone_id}/${p.request_type}`)
      toast.success('Policy removed')
      load()
    } catch (e) {
      toast.error('Could not remove policy', (e as Error).message)
    }
  }

  const zonesAllowed = me.role === 'zone_manager' && me.zoneId ? [me.zoneId] : [...ZONES]
  const label = (v: string) => types.find((t) => t.value === v)?.label ?? v

  if (!policies) {
    return <Card bleed><div className="space-y-2 p-4">{[0,1,2].map((i) => <Skeleton key={i} className="h-10" />)}</div></Card>
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          The engine picks the most specific policy: request type first, then the zone fallback.
        </p>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => { setIsNew(true); setEditing(blank(zonesAllowed[0])) }}
        >
          Add policy
        </Button>
      </div>

      {err && <div className="mb-4"><Alert tone="error">{err}</Alert></div>}

      <Card bleed>
        <Table
          head={
            <>
              <Th>Zone</Th><Th>Request type</Th><Th>Target</Th><Th>Calendar</Th>
              <Th>Extension</Th><Th>Appeals</Th><Th>Pause</Th><Th>Reminders</Th><Th />
            </>
          }
        >
          {policies.map((p) => (
            <Tr key={p.id}>
              <Td><Chip>{p.zone_id}</Chip></Td>
              <Td>
                {p.request_type === '*' ? (
                  <span className="text-[12px] font-medium text-ink">Zone fallback</span>
                ) : (
                  <span className="text-[13px] text-ink">{label(p.request_type)}</span>
                )}
              </Td>
              <Td><span className="mono text-[12px] font-medium text-ink">{formatDuration(p.target_minutes)}</span></Td>
              <Td className="text-[12px] text-muted">
                {p.business_days ? 'Business days' : 'Calendar days'}
                <span className="mono ml-1 text-[11px] text-faint">{p.timezone}</span>
              </Td>
              <Td className="text-[12px] text-muted">
                {p.extension_allowed_days > 0 ? `+${p.extension_allowed_days} days` : 'Not allowed'}
              </Td>
              <Td className="text-[12px] text-muted">
                {p.appeal_window_days > 0 ? `${p.appeal_window_days} days` : 'Not offered'}
              </Td>
              <Td>
                {p.pause_allowed
                  ? <Chip tone="positive" icon="check">Allowed</Chip>
                  : <Chip>Not allowed</Chip>}
              </Td>
              <Td className="mono text-[11px] text-muted">
                {(p.reminder_thresholds ?? []).map((t) => `${Math.round(t * 100)}%`).join(' · ')}
              </Td>
              <Td className="text-right">
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" icon="edit" aria-label="Edit policy"
                    onClick={() => { setIsNew(false); setEditing({ ...p }) }} />
                  {p.request_type !== '*' && (
                    <Button variant="ghost" icon="x" aria-label="Remove policy" onClick={() => void remove(p)} />
                  )}
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
        <p className="flex items-center gap-1.5 border-t border-line px-4 py-3 text-[11px] text-faint">
          <Icon name="info" size={12} />
          The clock starts at verified submission. Pausing is only offered where the regime permits stopping it.
        </p>
      </Card>

      {editing && (
        <Modal
          title={isNew ? 'New SLA policy' : `${editing.zone_id} · ${label(editing.request_type ?? '')}`}
          description="Applies to cases created after saving."
          onClose={() => setEditing(null)}
          size="lg"
        >
          <div className="space-y-4">
            {err && <Alert tone="error">{err}</Alert>}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Zone" htmlFor="p-zone">
                <Select
                  id="p-zone" value={editing.zone_id} disabled={!isNew}
                  onChange={(e) => setEditing({ ...editing, zone_id: e.target.value })}
                >
                  {zonesAllowed.map((z) => <option key={z} value={z}>{z}</option>)}
                </Select>
              </Field>
              <Field label="Request type" hint="Choose the fallback to cover every type in the zone." htmlFor="p-type">
                <Select
                  id="p-type" value={editing.request_type} disabled={!isNew}
                  onChange={(e) => setEditing({ ...editing, request_type: e.target.value })}
                >
                  {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Response deadline"
                hint="Statutory time to respond. Use minutes or hours to rehearse the workflow."
                htmlFor="p-target"
              >
                <div className="flex gap-2">
                  <TextInput
                    id="p-target" type="number" min={1} value={targetValue}
                    className="flex-1"
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        target_minutes: Math.max(1, Number(e.target.value)) * UNIT_MINUTES[targetUnit],
                      })
                    }
                  />
                  {/* Select renders its own wrapper, so the width belongs out
                      here where the flex item actually is. */}
                  <div className="w-[116px] shrink-0">
                    <Select
                      aria-label="Deadline unit"
                      value={targetUnit}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          target_minutes: targetValue * UNIT_MINUTES[e.target.value as Unit],
                        })
                      }
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </Select>
                  </div>
                </div>
              </Field>
              <Field label="Extension allowance" hint="Extra days permitted, 0 to forbid." htmlFor="p-ext">
                <TextInput
                  id="p-ext" type="number" min={0} max={365} value={editing.extension_allowed_days ?? 0}
                  onChange={(e) => setEditing({ ...editing, extension_allowed_days: Number(e.target.value) })}
                />
              </Field>
              <Field
                label="Appeal window"
                hint="Days after closure in which the requester may appeal. 0 means appeals are not offered."
                htmlFor="p-appeal"
              >
                <TextInput
                  id="p-appeal" type="number" min={0} max={365} value={editing.appeal_window_days ?? 0}
                  onChange={(e) => setEditing({ ...editing, appeal_window_days: Number(e.target.value) })}
                />
              </Field>
              <Field label="Timezone" hint="Used for business-day maths." htmlFor="p-tz">
                <Select
                  id="p-tz" value={editing.timezone ?? 'UTC'}
                  onChange={(e) => setEditing({ ...editing, timezone: e.target.value })}
                >
                  {TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink">Count business days only</p>
                  <p className="mt-0.5 text-[11px] text-faint">Weekends and listed holidays are skipped.</p>
                </div>
                <Switch
                  checked={Boolean(editing.business_days)} label="Count business days only"
                  onChange={(v) => setEditing({ ...editing, business_days: v })}
                />
              </div>
              <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink">Allow pausing the clock</p>
                  <p className="mt-0.5 text-[11px] text-faint">Only where the regime permits stopping it.</p>
                </div>
                <Switch
                  checked={Boolean(editing.pause_allowed)} label="Allow pausing the clock"
                  onChange={(v) => setEditing({ ...editing, pause_allowed: v })}
                />
              </div>
            </div>

            <Field
              label="Reminder points"
              hint="Percentages of the deadline at which the assignee is reminded, comma separated."
              htmlFor="p-rem"
            >
              <TextInput
                id="p-rem"
                value={(editing.reminder_thresholds ?? []).map((t) => Math.round(t * 100)).join(', ')}
                placeholder="75, 90, 100"
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    reminder_thresholds: e.target.value
                      .split(',')
                      .map((v) => Number(v.trim()) / 100)
                      .filter((n) => Number.isFinite(n) && n > 0),
                  })
                }
              />
            </Field>

            <Field
              label="Public holidays"
              hint="ISO dates, comma separated. Only used when counting business days."
              htmlFor="p-hol"
            >
              <TextInput
                id="p-hol"
                value={(editing.holidays ?? []).join(', ')}
                placeholder="2026-12-25, 2026-12-26"
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    holidays: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                  })
                }
              />
            </Field>

            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={save}>Save policy</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
