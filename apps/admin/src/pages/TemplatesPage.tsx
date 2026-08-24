import { useCallback, useEffect, useState } from 'react'
import { api, ZONES, type Me, type Template, atLeast } from '../lib/api'
import {
  Alert, Button, Card, Chip, EmptyState, Field, PageHeader, Select, Table,
  Tabs, Td, Th, Tr, TextInput,
} from '../components/ui'
import { RichTextEditor, RichTextPreview } from '../components/RichText'
import { useToast } from '../components/Toast'
import { SystemTemplates } from './SystemTemplates'

const VARIABLES = [
  'case_ref', 'requester_name', 'requester_email', 'zone',
  'request_type', 'submission_date', 'due_date', 'assignee_name',
]

/** Mirrors TEMPLATE_CATEGORIES on the server, which validates on save. */
const CATEGORIES = [
  { value: 'acknowledgement', label: 'Acknowledgement', hint: 'Sent on receipt' },
  { value: 'follow-up', label: 'Follow-up', hint: 'Sent while the case is open' },
  { value: 'outcome', label: 'Outcome', hint: 'Sent to close the case' },
  { value: 'custom', label: 'Custom', hint: 'Anything else' },
]

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
)

export function TemplatesPage({ me }: { me: Me }) {
  const toast = useToast()
  const [items, setItems] = useState<Template[]>([])
  const [editing, setEditing] = useState<Partial<Template> | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'replies' | 'system'>('replies')
  const [filter, setFilter] = useState('all')
  const canEdit = atLeast(me.role, 'zone_manager')

  const reload = useCallback(() => {
    api.get<Template[]>('/internal/templates').then(setItems).catch((e) => setErr(String(e)))
  }, [])
  useEffect(reload, [reload])

  const save = async () => {
    if (!editing) return
    setBusy(true)
    setErr('')
    try {
      await api.post('/internal/templates', {
        id: editing.id,
        name: editing.name,
        subject: editing.subject,
        body: editing.body,
        zoneId: editing.zone_id || null,
        requestType: editing.request_type || null,
        category: editing.category || 'outcome',
      })
      toast.success(editing.id ? 'New version saved' : 'Template created')
      setEditing(null)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const visible = filter === 'all' ? items : items.filter((t) => t.category === filter)

  const insertVariable = (v: string) => {
    setEditing((prev) => ({ ...prev, body: `${prev?.body ?? ''}{{${v}}}` }))
  }

  return (
    <>
      <PageHeader
        title="Templates"
        subtitle="Replies your team sends, and the messages the portal sends on its own."
        actions={
          canEdit && tab === 'replies' && (
            <Button variant="primary" icon="plus" onClick={() => setEditing({ category: 'outcome' })}>
              New template
            </Button>
          )
        }
      />

      <div className="mb-5">
        <Tabs
          tabs={[
            { id: 'replies', label: 'Reply templates', icon: 'mail', badge: items.length },
            { id: 'system', label: 'System notifications', icon: 'send' },
          ]}
          active={tab}
          onChange={(t) => setTab(t as typeof tab)}
        />
      </div>

      {tab === 'system' && <SystemTemplates />}

      {tab === 'replies' && (
        <>
      {err && <div className="mb-4"><Alert tone="error">{err}</Alert></div>}

      {editing && (
        <div className="mb-5">
          <Card
            title={editing.id ? `Editing “${editing.name}”` : 'New template'}
            subtitle={editing.id ? `Saving creates version ${(editing.version ?? 1) + 1}` : undefined}
          >
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Name" required htmlFor="t-name">
                  <TextInput id="t-name" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                </Field>
                <Field label="Zone" hint="Blank applies to every zone." htmlFor="t-zone">
                  <Select id="t-zone" value={editing.zone_id ?? ''} onChange={(e) => setEditing({ ...editing, zone_id: e.target.value || null })}>
                    <option value="">All zones</option>
                    {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                  </Select>
                </Field>
                <Field label="Request type" hint="Blank applies to any type." htmlFor="t-type">
                  <TextInput id="t-type" value={editing.request_type ?? ''} onChange={(e) => setEditing({ ...editing, request_type: e.target.value || null })} />
                </Field>
              </div>

              <Field
                label="Category"
                hint="Groups the library by where the message sits in a case's life."
                htmlFor="t-cat"
              >
                <Select
                  id="t-cat"
                  value={editing.category ?? 'outcome'}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{`${c.label} — ${c.hint}`}</option>
                  ))}
                </Select>
              </Field>

              <Field label="Subject" required htmlFor="t-subject">
                <TextInput id="t-subject" value={editing.subject ?? ''} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
              </Field>

              <div className="grid gap-4 lg:grid-cols-2">
                <Field
                   label="Body"
                   required
                   hint="Format with the toolbar; switch to HTML only if you need the markup."
                   htmlFor="t-body"
                 >
                  <RichTextEditor
                    id="t-body"
                    minHeight={320}
                    ariaLabel="Template body"
                    value={editing.body ?? ''}
                    onChange={(html) => setEditing({ ...editing, body: html })}
                  />
                </Field>

                <div className="min-w-0">
                  <p className="mb-1.5 text-xs font-medium text-muted">
                    Preview
                    <span className="ml-1.5 font-normal text-faint">
                      with sample values, as the recipient sees it
                    </span>
                  </p>
                  <div className="h-[21rem] overflow-y-auto rounded-lg border border-line bg-surface p-4">
                    <p className="mb-3 border-b border-line pb-2 text-[13px] font-semibold text-ink">
                      {fillSample(editing.subject ?? '') || <span className="text-faint">No subject</span>}
                    </p>
                    {editing.body ? (
                      /* Our own template text, not requester input. */
                      <RichTextPreview html={fillSample(editing.body)} />
                    ) : (
                      <p className="text-[13px] text-faint">Start typing to see the message.</p>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[11px] font-medium text-muted">Insert a variable</p>
                <div className="flex flex-wrap gap-1.5">
                  {VARIABLES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => insertVariable(v)}
                      className="mono cursor-pointer rounded-md border border-line bg-sunken px-2 py-1 text-[11px] text-muted transition-colors hover:border-brand-ink hover:text-brand-ink"
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-line pt-4">
                <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!editing.name || !editing.subject || !editing.body}
                  onClick={save}
                >
                  {editing.id ? 'Save new version' : 'Create template'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {items.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium text-muted">Show</span>
          {[{ value: 'all', label: 'All' }, ...CATEGORIES].map((c) => {
            const n = c.value === 'all' ? items.length : items.filter((t) => t.category === c.value).length
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setFilter(c.value)}
                aria-pressed={filter === c.value}
                className={`cursor-pointer rounded-md border px-2.5 py-1 text-[12px] transition-colors duration-150 ${
                  filter === c.value
                    ? 'border-brand-ink bg-brand-soft text-brand-ink'
                    : 'border-line text-muted hover:border-brand-ink/40 hover:text-ink'
                }`}
              >
                {c.label}
                <span className="mono ml-1.5 text-[10.5px] opacity-70">{n}</span>
              </button>
            )
          })}
        </div>
      )}

      <Card bleed>
        {visible.length === 0 ? (
          <EmptyState
            icon="file"
            title="No templates yet"
            hint={canEdit
              ? 'Create reusable replies so agents answer consistently across zones.'
              : 'Ask a zone manager to add templates for your zone.'}
            action={canEdit ? <Button variant="secondary" icon="plus" onClick={() => setEditing({})}>New template</Button> : undefined}
          />
        ) : (
          <Table
            head={<><Th>Name</Th><Th>Category</Th><Th>Zone</Th><Th>Request type</Th><Th>Subject</Th><Th>Version</Th>{canEdit && <Th />}</>}
          >
            {visible.map((t) => (
              <Tr key={t.id}>
                <Td className="font-medium text-ink">{t.name}</Td>
                <Td><Chip>{CATEGORY_LABEL[t.category] ?? t.category}</Chip></Td>
                <Td>{t.zone_id ? <Chip>{t.zone_id}</Chip> : <span className="text-[12px] text-faint">All</span>}</Td>
                <Td className="text-[12px] text-muted">{t.request_type ?? 'Any'}</Td>
                <Td className="max-w-xs truncate text-muted">{t.subject}</Td>
                <Td><span className="mono text-[12px] text-muted">v{t.version}</span></Td>
                {canEdit && (
                  <Td className="text-right">
                    <Button
                      variant="secondary"
                      icon="edit"
                      onClick={() => {
                        setEditing(t)
                        // The editor opens above the table; bring it into view.
                        window.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                      aria-label={`Edit ${t.name}`}
                    >
                      Edit
                    </Button>
                  </Td>
                )}
              </Tr>
            ))}
          </Table>
        )}
      </Card>
        </>
      )}
    </>
  )
}

/** The same placeholder values the server uses when previewing a template. */
const SAMPLE: Record<string, string> = {
  case_ref: 'DSR-EUR-2026-00147',
  requester_name: 'Anna Weber',
  requester_email: 'anna.weber@example.com',
  zone: 'EUR',
  request_type: 'access',
  submission_date: '18 August 2026',
  due_date: '17 September 2026',
  assignee_name: 'Privacy Team',
}

function fillSample(text: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => SAMPLE[key] ?? `{{${key}}}`)
}
