import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import {
  Alert, Button, Card, Chip, Field, Modal, Select, Skeleton, Switch, Tabs,
  Textarea, TextInput,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { FormPreview } from '../components/FormPreview'
import { useToast } from '../components/Toast'
import {
  TYPE_ICON, TYPE_LABEL, appendRoot, collectKeys, flatten, getAt, isField,
  moveAt, newComponent, removeAt, samePath, updateAt,
  type Component, type Path,
} from '../lib/formTree'

interface PaletteEntry { type: string; label: string; icon: string; description: string }

interface WorkflowSettings {
  responseDurationDays: number
  businessDays: boolean
  allowExtension: boolean
  extensionDurationDays: number
  reminderDays: number
  emailVerificationExpiryHours: number
  attachmentsEnabled: boolean
  attachmentsMandatory: boolean
  attachmentDescription: string
  maxRequestsAllowed: number
  minDaysBetweenRequests: number
  allowParallelRequests: boolean
}

interface FormDoc {
  key: string
  zone: string
  name: string
  components: Component[]
  display: Record<string, string>
  languages: string[]
  defaultLanguage: string
  workflow: WorkflowSettings
  [k: string]: unknown
}

export function FormEditorPage({ formKey }: { formKey: string }) {
  const toast = useToast()
  const [doc, setDoc] = useState<FormDoc | null>(null)
  const [version, setVersion] = useState(0)
  const [palette, setPalette] = useState<PaletteEntry[]>([])
  const [history, setHistory] = useState<{ version: number; at: string }[]>([])
  const [tab, setTab] = useState<'fields' | 'content' | 'workflow' | 'versions'>('fields')
  const [selected, setSelected] = useState<Path | null>(null)
  const [dirty, setDirty] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [issues, setIssues] = useState<string[]>([])
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [showPreview, setShowPreview] = useState(true)

  const load = useCallback(() => {
    api
      .get<{ version: number; schema: FormDoc }>(`/internal/forms/${formKey}`)
      .then((r) => { setDoc(r.schema); setVersion(r.version); setDirty(false) })
      .catch((e) => setError((e as Error).message))
    api.get<{ palette: PaletteEntry[] }>('/internal/forms/palette').then((r) => setPalette(r.palette)).catch(() => undefined)
    api.get<{ version: number; at: string }[]>(`/internal/forms/${formKey}/history`).then(setHistory).catch(() => undefined)
  }, [formKey])
  useEffect(load, [load])

  // The canvas identifies components by key; the tree identifies them by
  // path. These two conversions are what let a click in either place select in
  // the other.
  const selectedKey = useMemo(() => {
    if (!selected || !doc) return null
    const node = getAt(doc.components, selected)
    return node?.key ?? null
  }, [selected, doc])

  const selectByKey = useCallback(
    (key: string) => {
      if (!doc) return
      const hit = flatten(doc.components).find((n) => n.node.key === key)
      if (hit) setSelected(hit.path)
    },
    [doc],
  )

  // Guard against losing edits by navigating away.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const nodes = useMemo(() => (doc ? flatten(doc.components) : []), [doc])
  const current = useMemo(
    () => (doc && selected ? getAt(doc.components, selected) : null),
    [doc, selected],
  )
  const fieldKeys = useMemo(() => (doc ? collectKeys(doc.components) : []), [doc])

  const mutate = (components: Component[]) => {
    setDoc((d) => (d ? { ...d, components } : d))
    setDirty(true)
    setIssues([])
  }

  const patchSelected = (patch: Partial<Component>) => {
    if (!doc || !selected) return
    mutate(updateAt(doc.components, selected, patch))
  }

  const publish = async () => {
    if (!doc) return
    setPublishing(true)
    setIssues([])
    setError('')
    try {
      const r = await api.put<{ version: number }>(`/internal/forms/${formKey}`, {
        components: doc.components,
        display: doc.display,
        name: doc.name,
        workflow: doc.workflow,
      })
      setVersion(r.version)
      setDirty(false)
      toast.success('Form published', `Now live as version ${r.version}.`)
      api.get<{ version: number; at: string }[]>(`/internal/forms/${formKey}/history`).then(setHistory).catch(() => undefined)
    } catch (e) {
      const err = e as Error & { issues?: string[] }
      if (Array.isArray(err.issues)) setIssues(err.issues)
      else setError(err.message)
      toast.error('Could not publish', err.issues?.length ? `${err.issues.length} problem(s) found` : err.message)
    } finally {
      setPublishing(false)
    }
  }

  if (error && !doc) return <Alert tone="error" title="Could not load this form">{error}</Alert>
  if (!doc) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>
      </div>
    )
  }

  return (
    <>
      <div className="mb-5">
        <a href="#/forms" className="mb-3 inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors hover:text-ink">
          <Icon name="chevronLeft" size={13} /> Forms
        </a>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">{doc.name}</h1>
          <Chip>{doc.zone}</Chip>
          <Chip>v{version}</Chip>
          {dirty && <Chip tone="warning" icon="edit">Unpublished changes</Chip>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant={showPreview ? 'primary' : 'secondary'}
              icon="monitor"
              onClick={() => setShowPreview((v) => !v)}
              aria-pressed={showPreview}
            >
              {showPreview ? 'Hide preview' : 'Show preview'}
            </Button>
            <Button
              variant="secondary"
              icon="arrowUpRight"
              onClick={() => window.open(`/#/form/${formKey}`, '_blank', 'noopener')}
            >
              Open live form
            </Button>
            <Button variant="primary" icon="check" loading={publishing} disabled={!dirty} onClick={publish}>
              {dirty ? 'Publish changes' : 'Published'}
            </Button>
          </div>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="mb-4">
          <Alert tone="error" title="Fix these before publishing">
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {issues.map((i) => <li key={i}>{i}</li>)}
            </ul>
          </Alert>
        </div>
      )}
      {error && <div className="mb-4"><Alert tone="error">{error}</Alert></div>}

      <div className="mb-5">
        <Tabs
          tabs={[
            { id: 'fields', label: 'Fields', icon: 'grid', badge: nodes.filter((n) => isField(n.node)).length },
            { id: 'content', label: 'Page content', icon: 'file' },
            { id: 'workflow', label: 'Workflow & SLA', icon: 'clock' },
            { id: 'versions', label: 'Versions', icon: 'refresh' },
          ]}
          active={tab}
          onChange={(t) => setTab(t as typeof tab)}
        />
      </div>

      {tab === 'fields' && (
        <div
          className={`grid items-start gap-4 ${
            showPreview
              ? 'xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,360px)]'
              : 'lg:grid-cols-[1fr_380px]'
          }`}
        >
          <Card
            title="Form structure"
            subtitle="Select a component to edit it. Order here is the order requesters see."
            actions={<Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>Add field</Button>}
            bleed
          >
            <ul className="divide-y divide-line">
              {nodes.map((n) => {
                const on = samePath(selected, n.path)
                const field = isField(n.node)
                return (
                  <li key={JSON.stringify(n.path)}>
                    <div
                      className={`flex items-center gap-2 px-3 py-2 transition-colors ${on ? 'bg-brand-soft' : 'hover:bg-sunken/60'}`}
                      style={{ paddingLeft: `${12 + n.depth * 18}px` }}
                    >
                      <button
                        onClick={() => setSelected(n.path)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
                      >
                        <Icon
                          name={TYPE_ICON[n.node.type] ?? 'edit'}
                          size={14}
                          className={on ? 'text-brand-ink' : 'text-faint'}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] text-ink">
                            {n.node.label || (n.node.type === 'htmlelement' ? 'Text block' : n.node.key) || TYPE_LABEL[n.node.type]}
                          </span>
                          <span className="mono block truncate text-[10px] text-faint">
                            {TYPE_LABEL[n.node.type] ?? n.node.type}
                            {field && n.node.key ? ` · ${n.node.key}` : ''}
                            {n.branch ? ` · ${n.branch}` : ''}
                          </span>
                        </span>
                        {n.node.validate?.required && <Chip tone="danger">Required</Chip>}
                        {n.node.conditional?.when && <Chip icon="filter">Conditional</Chip>}
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => mutate(moveAt(doc.components, n.path, -1))}
                          aria-label="Move up"
                          className="cursor-pointer rounded p-1 text-faint hover:bg-sunken hover:text-ink"
                        >
                          <Icon name="chevronsUpDown" size={12} />
                        </button>
                        <button
                          onClick={() => {
                            if (!confirm(`Remove "${n.node.label || n.node.key}" from the form?`)) return
                            mutate(removeAt(doc.components, n.path))
                            if (samePath(selected, n.path)) setSelected(null)
                          }}
                          aria-label="Remove component"
                          className="cursor-pointer rounded p-1 text-faint hover:bg-danger/10 hover:text-danger"
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>

          {showPreview && (
            <FormPreview
              formKey={formKey}
              schema={doc}
              selectedKey={selectedKey}
              onSelect={selectByKey}
            />
          )}

          <Card title={current ? 'Component settings' : 'Nothing selected'}>
            {!current ? (
              <p className="py-8 text-center text-[13px] text-faint">
                {showPreview
                  ? 'Click a field in the preview, or pick one on the left, to edit it.'
                  : 'Pick a component on the left to edit its label, help text, options and visibility.'}
              </p>
            ) : (
              <ComponentEditor
                component={current}
                fieldKeys={fieldKeys.filter((k) => k.key !== current.key)}
                onChange={patchSelected}
              />
            )}
          </Card>
        </div>
      )}

      {tab === 'content' && (
        <ContentEditor
          doc={doc}
          onChange={(display) => { setDoc({ ...doc, display }); setDirty(true) }}
          onName={(name) => { setDoc({ ...doc, name }); setDirty(true) }}
        />
      )}

      {tab === 'workflow' && (
        <WorkflowEditor
          workflow={doc.workflow}
          onChange={(workflow) => { setDoc({ ...doc, workflow }); setDirty(true) }}
        />
      )}

      {tab === 'versions' && (
        <Card title="Version history" subtitle="Restoring republishes an older definition as the newest version." bleed>
          <ul className="divide-y divide-line">
            {history.map((h) => (
              <li key={h.version} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div>
                  <p className="text-[13px] text-ink">
                    Version <span className="mono">{h.version}</span>
                    {h.version === version && <Chip tone="positive" icon="check">Live</Chip>}
                  </p>
                  <p className="mono text-[11px] text-faint">{new Date(h.at).toLocaleString()}</p>
                </div>
                {h.version !== version && (
                  <Button
                    variant="secondary"
                    icon="refresh"
                    onClick={async () => {
                      if (!confirm(`Restore version ${h.version}? This publishes it as a new version.`)) return
                      try {
                        await api.post(`/internal/forms/${formKey}/restore/${h.version}`)
                        toast.success('Version restored')
                        load()
                      } catch (e) {
                        toast.error('Restore failed', (e as Error).message)
                      }
                    }}
                  >
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {adding && (
        <Modal title="Add a field" description="It is added just above the submit button." onClose={() => setAdding(false)} size="lg">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {palette.map((p) => (
              <button
                key={p.type}
                onClick={() => {
                  const next = appendRoot(doc.components, newComponent(p.type, doc.components))
                  mutate(next)
                  setAdding(false)
                  // Select the component that was just added.
                  const added = flatten(next).find((n) => n.node === next[next.findIndex((c) => c.type === p.type)])
                  if (added) setSelected(added.path)
                }}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-3 text-left transition-colors hover:border-brand-ink hover:bg-brand-soft"
              >
                <span className="mt-0.5 text-brand-ink"><Icon name={p.icon} size={15} /></span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">{p.label}</span>
                  <span className="block text-[11px] text-faint">{p.description}</span>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}

/* ---------------------------- component editor ---------------------------- */

function ComponentEditor({
  component,
  fieldKeys,
  onChange,
}: {
  component: Component
  fieldKeys: { key: string; label: string }[]
  onChange: (patch: Partial<Component>) => void
}) {
  const field = isField(component)
  const hasOptions = ['dsrselectboxes', 'dsrradio', 'radio'].includes(component.type)
  const hasDataValues = ['dsrselect', 'select'].includes(component.type) && component.dataSrc !== 'url'
  const options = hasOptions ? component.values ?? [] : component.data?.values ?? []

  const setOptions = (values: { label: string; value: string }[]) =>
    hasOptions ? onChange({ values }) : onChange({ data: { ...(component.data ?? {}), values } })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg bg-sunken px-3 py-2">
        <Icon name={TYPE_ICON[component.type] ?? 'edit'} size={14} className="text-brand-ink" />
        <span className="text-[12px] font-medium text-ink">{TYPE_LABEL[component.type] ?? component.type}</span>
      </div>

      {component.type === 'htmlelement' || component.type === 'content' ? (
        <Field label="Content" hint="HTML is supported. Shown to requesters as-is." htmlFor="c-content">
          <Textarea
            id="c-content" rows={6} className="mono text-[12px]"
            value={component.content ?? ''}
            onChange={(e) => onChange({ content: e.target.value })}
          />
        </Field>
      ) : (
        <>
          <Field label="Label" hint="The question the requester reads." htmlFor="c-label">
            <TextInput id="c-label" value={component.label ?? ''} onChange={(e) => onChange({ label: e.target.value })} />
          </Field>

          {field && (
            <Field
              label="Field name"
              hint="Stored with the case. Changing it on a live form breaks reporting continuity."
              htmlFor="c-key"
            >
              <TextInput
                id="c-key" className="mono" value={component.key ?? ''}
                onChange={(e) => onChange({ key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })}
              />
            </Field>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Placeholder" htmlFor="c-ph">
              <TextInput id="c-ph" value={component.placeholder ?? ''} onChange={(e) => onChange({ placeholder: e.target.value })} />
            </Field>
            <Field label="Help text" hint="Shown under the field." htmlFor="c-desc">
              <TextInput id="c-desc" value={component.description ?? ''} onChange={(e) => onChange({ description: e.target.value })} />
            </Field>
          </div>

          {field && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
              <div>
                <p className="text-[13px] font-medium text-ink">Required</p>
                <p className="mt-0.5 text-[11px] text-faint">Enforced again on the server at submission.</p>
              </div>
              <Switch
                checked={Boolean(component.validate?.required)}
                label="Required field"
                onChange={(v) => onChange({ validate: { ...(component.validate ?? {}), required: v } })}
              />
            </div>
          )}

          {(hasOptions || hasDataValues) && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">Options</p>
              <div className="space-y-2">
                {options.map((o, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <TextInput
                      value={o.label} placeholder="Label shown"
                      onChange={(e) => {
                        const next = [...options]
                        next[i] = { ...next[i], label: e.target.value }
                        setOptions(next)
                      }}
                    />
                    <TextInput
                      className="mono w-36" value={o.value} placeholder="stored_value"
                      onChange={(e) => {
                        const next = [...options]
                        next[i] = { ...next[i], value: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') }
                        setOptions(next)
                      }}
                    />
                    <Button
                      variant="ghost" icon="x" aria-label="Remove option"
                      onClick={() => setOptions(options.filter((_, j) => j !== i))}
                    />
                  </div>
                ))}
                <Button
                  variant="secondary" icon="plus"
                  onClick={() => setOptions([...options, { label: 'New option', value: `option_${options.length + 1}` }])}
                >
                  Add option
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-line p-3">
            <p className="mb-2 text-[13px] font-medium text-ink">Visibility</p>
            <p className="mb-3 text-[11px] text-faint">
              Leave blank to always show. Otherwise this component appears only when the chosen field holds the given value.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Depends on field" htmlFor="c-when">
                <Select
                  id="c-when"
                  value={component.conditional?.when ?? ''}
                  onChange={(e) =>
                    onChange({
                      conditional: {
                        ...(component.conditional ?? {}),
                        when: e.target.value,
                        show: e.target.value ? 'true' : '',
                      },
                    })
                  }
                >
                  <option value="">Always visible</option>
                  {fieldKeys.map((k) => <option key={k.key} value={k.key}>{k.label} ({k.key})</option>)}
                </Select>
              </Field>
              <Field label="Equals value" hint="The stored value, not the label." htmlFor="c-eq">
                <TextInput
                  id="c-eq" className="mono"
                  disabled={!component.conditional?.when}
                  value={component.conditional?.eq ?? ''}
                  onChange={(e) => onChange({ conditional: { ...(component.conditional ?? {}), eq: e.target.value } })}
                />
              </Field>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ----------------------------- content editor ----------------------------- */

function ContentEditor({
  doc,
  onChange,
  onName,
}: {
  doc: FormDoc
  onChange: (display: Record<string, string>) => void
  onName: (name: string) => void
}) {
  const set = (k: string, v: string) => onChange({ ...doc.display, [k]: v })
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <Card title="Headline and introduction" subtitle="HTML is supported. This is the copy above the fields.">
        <div className="space-y-4">
          <Field label="Internal name" hint="Shown in this console only." htmlFor="d-name">
            <TextInput id="d-name" value={doc.name} onChange={(e) => onName(e.target.value)} />
          </Field>
          <Field label="Page heading" htmlFor="d-header">
            <Textarea id="d-header" rows={3} className="mono text-[12px]" value={doc.display.header ?? ''} onChange={(e) => set('header', e.target.value)} />
          </Field>
          <Field label="Introduction" hint="Legal copy here is shown verbatim to the data subject." htmlFor="d-body">
            <Textarea id="d-body" rows={10} className="mono text-[12px]" value={doc.display.body ?? ''} onChange={(e) => set('body', e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card title="Section titles and notices">
        <div className="space-y-4">
          <Field label="Fields section heading" htmlFor="d-heading">
            <TextInput id="d-heading" value={doc.display.headingFormContent ?? ''} onChange={(e) => set('headingFormContent', e.target.value)} />
          </Field>
          <Field label="Duplicate-request notice heading" htmlFor="d-rth">
            <TextInput id="d-rth" value={doc.display.restrictionsTextHeading ?? ''} onChange={(e) => set('restrictionsTextHeading', e.target.value)} />
          </Field>
          <Field
            label="Duplicate-request notice"
            hint="Shown when someone submits again inside the repeat window."
            htmlFor="d-rt"
          >
            <Textarea id="d-rt" rows={6} className="mono text-[12px]" value={doc.display.restrictionsText ?? ''} onChange={(e) => set('restrictionsText', e.target.value)} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Page background" htmlFor="d-bg">
              <TextInput id="d-bg" className="mono" value={doc.display.bgColor ?? ''} onChange={(e) => set('bgColor', e.target.value)} />
            </Field>
            <Field label="Button text colour" htmlFor="d-tc">
              <TextInput id="d-tc" className="mono" value={doc.display.textColor ?? ''} onChange={(e) => set('textColor', e.target.value)} />
            </Field>
          </div>
        </div>
      </Card>
    </div>
  )
}

/* ---------------------------- workflow editor ----------------------------- */

function WorkflowEditor({
  workflow,
  onChange,
}: {
  workflow: WorkflowSettings
  onChange: (w: WorkflowSettings) => void
}) {
  const set = <K extends keyof WorkflowSettings>(k: K, v: WorkflowSettings[K]) =>
    onChange({ ...workflow, [k]: v })

  const Toggle = ({ k, title, hint }: { k: keyof WorkflowSettings; title: string; hint: string }) => (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-faint">{hint}</p>
      </div>
      <Switch checked={Boolean(workflow[k])} label={title} onChange={(v) => set(k, v as never)} />
    </div>
  )

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <Card title="Response deadline" subtitle="Defaults for cases created from this form.">
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Response duration" hint="Days to respond." htmlFor="w-days">
              <TextInput id="w-days" type="number" min={1} max={365} value={workflow.responseDurationDays}
                onChange={(e) => set('responseDurationDays', Number(e.target.value))} />
            </Field>
            <Field label="Reminder lead time" hint="Days before the deadline to nudge the assignee." htmlFor="w-rem">
              <TextInput id="w-rem" type="number" min={0} max={90} value={workflow.reminderDays}
                onChange={(e) => set('reminderDays', Number(e.target.value))} />
            </Field>
          </div>
          <Toggle k="businessDays" title="Count business days only" hint="Weekends and zone holidays are skipped." />
          <Toggle k="allowExtension" title="Allow extensions" hint="Agents may extend with a recorded justification." />
          {workflow.allowExtension && (
            <Field label="Extension allowance" hint="Additional days permitted." htmlFor="w-ext">
              <TextInput id="w-ext" type="number" min={0} max={365} value={workflow.extensionDurationDays}
                onChange={(e) => set('extensionDurationDays', Number(e.target.value))} />
            </Field>
          )}
        </div>
      </Card>

      <Card title="Submission rules" subtitle="Limits applied to the public form.">
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Verification link lifetime" hint="Hours before the magic link expires." htmlFor="w-exp">
              <TextInput id="w-exp" type="number" min={1} max={168} value={workflow.emailVerificationExpiryHours}
                onChange={(e) => set('emailVerificationExpiryHours', Number(e.target.value))} />
            </Field>
            <Field label="Maximum open requests" hint="Per requester." htmlFor="w-max">
              <TextInput id="w-max" type="number" min={1} max={100} value={workflow.maxRequestsAllowed}
                onChange={(e) => set('maxRequestsAllowed', Number(e.target.value))} />
            </Field>
          </div>
          <Field label="Cooling-off period" hint="Days a requester must wait before filing the same type again. 0 disables it." htmlFor="w-min">
            <TextInput id="w-min" type="number" min={0} max={365} value={workflow.minDaysBetweenRequests}
              onChange={(e) => set('minDaysBetweenRequests', Number(e.target.value))} />
          </Field>
          <Toggle k="allowParallelRequests" title="Allow parallel requests" hint="A requester may have several open cases at once." />
        </div>
      </Card>

      <Card title="Identity documents" subtitle="Attachments requested alongside the form." className="lg:col-span-2">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <Toggle k="attachmentsEnabled" title="Offer file upload" hint="Adds an upload control to the form." />
            {workflow.attachmentsEnabled && (
              <Toggle k="attachmentsMandatory" title="Require at least one file" hint="Submission is blocked without a document." />
            )}
          </div>
          {workflow.attachmentsEnabled && (
            <Field label="Upload instructions" hint="Tells the requester exactly what to attach." htmlFor="w-att">
              <Textarea id="w-att" rows={4} value={workflow.attachmentDescription}
                onChange={(e) => set('attachmentDescription', e.target.value)} />
            </Field>
          )}
        </div>
      </Card>
    </div>
  )
}
