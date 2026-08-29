import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type ConnectionStatus,
  type DiagnosticReport,
  type SettingDef,
  type SettingsPayload,
  type SettingValue,
} from '../lib/api'
import {
  Alert,
  Button,
  Card,
  Chip,
  Field,
  PageHeader,
  PasswordInput,
  Select,
  Skeleton,
  Tabs,
  TextInput,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'

const SOURCE_LABEL: Record<SettingValue['source'], string> = {
  database: 'Saved here',
  environment: 'From environment',
  default: 'Default',
  unset: 'Not set',
}

export function SettingsPage() {
  const toast = useToast()
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [group, setGroup] = useState('email')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conn, setConn] = useState<ConnectionStatus | null>(null)
  const [probing, setProbing] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [sending, setSending] = useState(false)
  const [diag, setDiag] = useState<DiagnosticReport | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)

  const load = useCallback(() => {
    api
      .get<SettingsPayload>('/internal/admin/settings')
      .then(setPayload)
      .catch((e) => setError((e as Error).message))
  }, [])
  useEffect(load, [load])

  const values = useMemo(() => {
    const m: Record<string, SettingValue> = {}
    for (const v of payload?.values ?? []) m[v.key] = v
    return m
  }, [payload])

  /** Draft value if edited, otherwise the saved one. */
  const current = (key: string) => draft[key] ?? values[key]?.value ?? ''
  const dirty = Object.keys(draft).length > 0

  // Warn before losing unsaved edits on navigation away.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  /** Every condition must hold for the field to render. */
  const visible = (f: SettingDef) =>
    !f.visibleWhen || f.visibleWhen.every((c) => c.equals.includes(current(c.key)))

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const res = await api.put<SettingsPayload & { updated: string[] }>(
        '/internal/admin/settings',
        { values: draft },
      )
      setPayload((p) => (p ? { ...p, values: res.values } : p))
      setDraft({})
      toast.success('Settings saved', `${res.updated.length} value${res.updated.length === 1 ? '' : 's'} updated.`)
      setConn(null)
      setDiag(null)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.error('Could not save settings', msg)
    } finally {
      setSaving(false)
    }
  }

  const probe = async () => {
    setProbing(true)
    setConn(null)
    try {
      setConn(await api.post<ConnectionStatus>('/internal/admin/settings/email/verify'))
    } catch (e) {
      setConn({ ok: false, provider: 'unknown', detail: (e as Error).message })
    } finally {
      setProbing(false)
    }
  }

  const runDiagnostics = async () => {
    setDiagnosing(true)
    setDiag(null)
    try {
      setDiag(await api.post<DiagnosticReport>('/internal/admin/settings/email/diagnose'))
    } catch (e) {
      toast.error('Diagnostics failed', (e as Error).message)
    } finally {
      setDiagnosing(false)
    }
  }

  const sendTest = async () => {
    setSending(true)
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(
        '/internal/admin/settings/email/test-send',
        { to: testTo },
      )
      if (r.ok) toast.success('Test email sent', `Delivered to ${testTo}.`)
      else toast.error('Test email failed', r.error)
    } catch (e) {
      toast.error('Test email failed', (e as Error).message)
    } finally {
      setSending(false)
    }
  }

  if (error && !payload) return <Alert tone="error" title="Could not load settings">{error}</Alert>

  if (!payload) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Runtime configuration for the portal" />
        <div className="space-y-3">
          <Skeleton className="h-9 w-80" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    )
  }

  const groupFields = payload.fields.filter((f) => f.group === group)
  const activeGroup = payload.groups.find((g) => g.id === group)

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Changes apply immediately across the portal — no redeploy or restart."
        actions={
          <>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft({})}>
                Discard
              </Button>
            )}
            <Button variant="primary" icon="check" loading={saving} disabled={!dirty} onClick={save}>
              {dirty ? `Save ${Object.keys(draft).length} change${Object.keys(draft).length === 1 ? '' : 's'}` : 'Saved'}
            </Button>
          </>
        }
      />

      <div className="mb-5 min-w-0 max-w-full overflow-hidden">
        <Tabs
          tabs={payload.groups.map((g) => ({ id: g.id, label: g.label, icon: g.icon }))}
          active={group}
          onChange={setGroup}
        />
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="error" title="Save rejected">{error}</Alert>
        </div>
      )}

      <div className="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card title={activeGroup?.label} subtitle={activeGroup?.description}>
          <div className="grid gap-5 sm:grid-cols-2">
            {groupFields.map((f) => {
              if (!visible(f)) return null
              const v = values[f.key]
              const edited = f.key in draft
              const set = (val: string) =>
                setDraft((d) => {
                  const next = { ...d }
                  // Dropping the key when it matches the saved value keeps the
                  // dirty count honest.
                  if (!f.secret && val === (v?.value ?? '')) delete next[f.key]
                  else next[f.key] = val
                  return next
                })

              return (
                <div key={f.key} className={f.type === 'select' || f.type === 'number' ? '' : 'sm:col-span-2'}>
                  <Field
                    label={f.label}
                    hint={f.help}
                    htmlFor={f.key}
                  >
                    {f.type === 'select' ? (
                      <Select id={f.key} value={current(f.key)} onChange={(e) => set(e.target.value)} disabled={f.envOnly}>
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </Select>
                    ) : f.type === 'password' ? (
                      <PasswordInput
                        id={f.key}
                        isSet={v?.isSet && !edited}
                        value={draft[f.key] ?? ''}
                        placeholder={f.placeholder}
                        onChange={(e) => set(e.target.value)}
                        disabled={f.envOnly}
                      />
                    ) : (
                      <TextInput
                        id={f.key}
                        type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text'}
                        inputMode={f.type === 'number' ? 'numeric' : undefined}
                        min={f.min}
                        max={f.max}
                        value={current(f.key)}
                        placeholder={f.placeholder}
                        onChange={(e) => set(e.target.value)}
                        disabled={f.envOnly}
                      />
                    )}
                  </Field>
                  <div className="mt-1.5 flex items-center gap-2">
                    {edited ? (
                      <Chip tone="brand" icon="edit">Unsaved</Chip>
                    ) : (
                      <Chip tone={v?.source === 'unset' ? 'neutral' : 'neutral'}>
                        {SOURCE_LABEL[v?.source ?? 'unset']}
                      </Chip>
                    )}
                    {f.secret && v?.isSet && !edited && <Chip tone="positive" icon="key">Encrypted</Chip>}
                    {f.envOnly && (
                      <span className="text-faint">Set in /opt/dsr/server/.env</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        {/* --------------------------- side rail --------------------------- */}
        <div className="space-y-4">
          {group === 'email' && (
            <>
              <Card title="Connection check" subtitle="Probe the active provider without sending mail.">
                <Button variant="secondary" icon="refresh" loading={probing} onClick={probe} className="w-full">
                  Test connection
                </Button>
                {conn && (
                  <div className="mt-3">
                    <Alert tone={conn.ok ? 'success' : 'error'} title={conn.ok ? 'Connected' : 'Not connected'}>
                      <p className="mono break-words text-[11px]">{conn.provider}</p>
                      <p className="mt-0.5 break-words">{conn.detail}</p>
                    </Alert>
                  </div>
                )}
                {dirty && (
                  <p className="mt-2 text-[11px] text-warning">
                    Save your changes first — the check uses the stored configuration.
                  </p>
                )}
              </Card>

              <Card
                title="Connection diagnostics"
                subtitle="Checks DNS, the port, encryption and the login one stage at a time."
              >
                <Button
                  variant="secondary"
                  icon="database"
                  loading={diagnosing}
                  onClick={runDiagnostics}
                  className="w-full"
                >
                  Run diagnostics
                </Button>

                {diag && !diag.applicable && (
                  <div className="mt-3">
                    <Alert tone="info" title="Not applicable">{diag.reason}</Alert>
                  </div>
                )}

                {diag?.applicable && (
                  <ol className="mt-3 space-y-2">
                    {diag.steps.map((st) => (
                      <li
                        key={st.step}
                        className="rounded-lg border p-2.5"
                        style={{
                          borderColor: st.ok
                            ? 'color-mix(in srgb, var(--t-positive) 30%, transparent)'
                            : 'color-mix(in srgb, var(--t-danger) 30%, transparent)',
                          background: st.ok
                            ? 'color-mix(in srgb, var(--t-positive) 6%, transparent)'
                            : 'color-mix(in srgb, var(--t-danger) 6%, transparent)',
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <Icon
                            name={st.ok ? 'checkCircle' : 'alert'}
                            size={14}
                            className="mt-0.5 shrink-0"
                            style={{ color: st.ok ? 'var(--t-positive)' : 'var(--t-danger)' }}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center justify-between gap-2 text-[12px] font-medium text-ink">
                              {st.step}
                              <span className="mono shrink-0 text-[10px] text-faint">{st.ms}ms</span>
                            </p>
                            <p className="mt-0.5 break-words text-[11px] leading-relaxed text-muted">{st.detail}</p>
                            {!st.ok && st.hint && (
                              <p className="mt-1 break-words text-[11px] leading-relaxed text-warning">{st.hint}</p>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                    {diag.steps.length > 0 && diag.ok && (
                      <li className="pt-1 text-center text-[11px] text-positive">
                        All stages passed - this server can reach the provider.
                      </li>
                    )}
                  </ol>
                )}
              </Card>

              <Card title="Send a test email" subtitle="Delivers a real message through the active provider.">
                <div className="space-y-2.5">
                  <TextInput
                    type="email"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder="you@company.com"
                    aria-label="Test recipient"
                  />
                  <Button
                    variant="secondary"
                    icon="send"
                    loading={sending}
                    disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(testTo)}
                    onClick={sendTest}
                    className="w-full"
                  >
                    Send test
                  </Button>
                </div>
              </Card>

            </>
          )}

          <Card title="How configuration resolves">
            <ul className="space-y-2.5 text-[12px] leading-relaxed text-muted">
              <li className="flex gap-2">
                <Icon name="database" size={13} className="mt-0.5 shrink-0 text-brand-ink" />
                <span><strong className="text-ink">Saved here</strong> wins over everything else.</span>
              </li>
              <li className="flex gap-2">
                <Icon name="globe" size={13} className="mt-0.5 shrink-0 text-faint" />
                <span><strong className="text-ink">Environment</strong> applies when nothing is saved.</span>
              </li>
              <li className="flex gap-2">
                <Icon name="key" size={13} className="mt-0.5 shrink-0 text-positive" />
                <span>Secrets are <strong className="text-ink">encrypted</strong> and never sent back to the browser.</span>
              </li>
              <li className="flex gap-2">
                <Icon name="shield" size={13} className="mt-0.5 shrink-0 text-faint" />
                <span>Every change is written to the audit log with values redacted.</span>
              </li>
            </ul>
            <p className="mt-3 border-t border-line pt-3 text-[11px] text-faint">
              Clear a field and save to remove the stored value and fall back to the environment.
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}
