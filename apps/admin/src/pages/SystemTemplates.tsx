import { useCallback, useEffect, useState } from 'react'
import { api, type SystemTemplate } from '../lib/api'
import { Alert, Button, Card, Chip, Field, TextInput } from '../components/ui'
import { RichTextEditor, RichTextPreview } from '../components/RichText'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'

/**
 * The messages the portal sends on its own: verification, acknowledgement,
 * assignment, reminders, escalations.
 *
 * Each ships with a built-in default. Editing stores an override; Reset drops
 * it. Variables are validated server-side before a save is accepted, because a
 * template referencing an unknown one would throw at send time and silently
 * stop, for example, every verification email.
 */
export function SystemTemplates() {
  const toast = useToast()
  const [items, setItems] = useState<SystemTemplate[]>([])
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ subject: string; html: string }>({ subject: '', html: '' })
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const reload = useCallback(() => {
    api
      .get<SystemTemplate[]>('/internal/admin/system-templates')
      .then(setItems)
      .catch((e) => setErr((e as Error).message))
  }, [])
  useEffect(reload, [reload])

  const open = (t: SystemTemplate) => {
    setOpenKey(t.key)
    setDraft({ subject: t.subject, html: t.html })
    setPreview(null)
    setErr('')
  }

  const active = items.find((t) => t.key === openKey) ?? null
  const changed =
    active !== null && (draft.subject !== active.subject || draft.html !== active.html)

  const save = async () => {
    if (!active) return
    setBusy(true)
    setErr('')
    try {
      await api.put(`/internal/admin/system-templates/${active.key}`, draft)
      toast.success('Template saved', active.label)
      setOpenKey(null)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const reset = async (t: SystemTemplate) => {
    if (!window.confirm(`Restore the built-in text for “${t.label}”? Your changes are discarded.`)) {
      return
    }
    try {
      await api.del(`/internal/admin/system-templates/${t.key}`)
      toast.success('Restored the built-in text', t.label)
      setOpenKey(null)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const runPreview = async () => {
    if (!active) return
    setErr('')
    try {
      setPreview(
        await api.post<{ subject: string; html: string }>(
          `/internal/admin/system-templates/${active.key}/preview`,
          draft,
        ),
      )
    } catch (e) {
      setErr((e as Error).message)
      setPreview(null)
    }
  }

  return (
    <>
      {err && <div className="mb-4"><Alert tone="error" title="Could not save">{err}</Alert></div>}

      {active && (
        <div className="mb-5">
          <Card
            title={`Editing “${active.label}”`}
            subtitle={active.description}
            actions={
              active.customised && (
                <Button variant="ghost" icon="refresh" onClick={() => reset(active)}>
                  Restore default
                </Button>
              )
            }
          >
            <div className="space-y-4">
              <Field label="Subject" required htmlFor="s-subject">
                <TextInput
                  id="s-subject"
                  value={draft.subject}
                  onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                />
              </Field>

              <Field
                label="Body"
                required
                hint="Format with the toolbar; switch to HTML only if you need the markup."
                htmlFor="s-html"
              >
                <RichTextEditor
                  id="s-html"
                  minHeight={260}
                  ariaLabel="Notification body"
                  value={draft.html}
                  onChange={(html) => setDraft({ ...draft, html })}
                />
              </Field>

              <div>
                <p className="mb-1.5 text-[11px] font-medium text-muted">
                  Variables this message can use — anything else is rejected
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {active.variables.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, html: `${d.html}{{${v}}}` }))}
                      className="mono cursor-pointer rounded-md border border-line bg-sunken px-2 py-1 text-[11px] text-muted transition-colors duration-150 hover:border-brand-ink hover:text-brand-ink"
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              </div>

              {preview && (
                <div className="rounded-lg border border-line bg-sunken/40 p-3">
                  <p className="mb-2 text-[11px] font-medium text-muted">
                    Preview with sample values
                  </p>
                  <p className="mb-2 text-[13px] font-medium text-ink">{preview.subject}</p>
                  <RichTextPreview html={preview.html} />
                </div>
              )}

              <div className="flex justify-end gap-2 border-t border-line pt-4">
                <Button variant="ghost" onClick={() => setOpenKey(null)}>Cancel</Button>
                <Button variant="secondary" icon="eye" onClick={runPreview}>Preview</Button>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!changed || !draft.subject.trim() || !draft.html.trim()}
                  onClick={save}
                >
                  Save
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((t) => (
          <Card key={t.key} title={t.label} subtitle={t.description}>
            <div className="flex items-center gap-2">
              {t.customised ? (
                <Chip tone="warning" icon="edit">Customised</Chip>
              ) : (
                <Chip>Built-in</Chip>
              )}
              <span className="mono text-[10.5px] text-faint">{t.key}</span>
              <div className="ml-auto">
                <Button variant="secondary" icon="edit" onClick={() => open(t)}>
                  Edit
                </Button>
              </div>
            </div>
            <p className="mt-3 line-clamp-2 text-[12px] leading-relaxed text-muted">
              <span className="font-medium text-ink">Subject: </span>
              {t.subject}
            </p>
            {t.updatedAt && (
              <p className="mt-2 flex items-center gap-1 text-[11px] text-faint">
                <Icon name="clock" size={11} />
                Changed {new Date(t.updatedAt).toLocaleString()}
              </p>
            )}
          </Card>
        ))}
      </div>
    </>
  )
}
