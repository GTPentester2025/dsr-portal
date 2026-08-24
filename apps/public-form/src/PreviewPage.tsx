import { useEffect, useMemo, useState } from 'react'
import type { Component, FormSchema, FormValues } from './types'
import { loadForm } from './lib/api'
import { I18nProvider, makeTranslator } from './lib/i18n'
import { FieldTree } from './components/FieldRenderer'
import { keyFromEventTarget, onEditorMessage, toEditor, watchHeight } from './lib/preview'

/**
 * The form builder's live canvas.
 *
 * This renders through the same FieldTree the public form uses, against the
 * same vendored stylesheets, so the builder shows the real thing rather than an
 * approximation that drifts. It starts from the published schema so the frame
 * is never blank, then follows the editor's working draft.
 *
 * Nothing here submits: no verification, no draft creation, no network writes.
 * A preview that could file a request would be a liability.
 */
export function PreviewPage({ formKey }: { formKey: string }) {
  const [schema, setSchema] = useState<FormSchema | null>(null)
  const [values, setValues] = useState<FormValues>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')

  // Seed from the published version so the canvas has content immediately.
  useEffect(() => {
    let live = true
    loadForm(formKey)
      .then((s) => { if (live) setSchema(s) })
      .catch((e) => { if (live) setError(String((e as Error).message ?? e)) })
    return () => { live = false }
  }, [formKey])

  // Follow the editor.
  useEffect(() => {
    const off = onEditorMessage((msg) => {
      if (msg.type === 'dsr-preview:schema') {
        setSchema(msg.schema)
        setError('')
      } else if (msg.type === 'dsr-preview:select') {
        setSelected(msg.key)
      }
    })
    toEditor({ type: 'dsr-preview:ready' })
    return off
  }, [])

  useEffect(() => watchHeight(), [])

  // Defaults from the schema, so selects show their preselected option exactly
  // as a requester would first see them.
  useEffect(() => {
    if (!schema) return
    const defaults: FormValues = {}
    const walk = (cs: Component[]) => {
      for (const c of cs) {
        if (c.key && c.defaultValue !== undefined && c.defaultValue !== null && c.defaultValue !== '') {
          defaults[c.key] = c.defaultValue
        }
        if (c.components) walk(c.components)
        for (const col of c.columns ?? []) walk(col.components ?? [])
      }
    }
    walk(schema.components ?? [])
    setValues((v) => ({ ...defaults, ...v }))
  }, [schema])

  const t = useMemo(
    () => makeTranslator(schema?.i18n ?? {}, schema?.defaultLanguage ?? 'en'),
    [schema],
  )

  if (error) {
    return <div style={{ padding: 24, fontFamily: 'system-ui', color: '#b4232c' }}>{error}</div>
  }
  if (!schema) {
    return <div style={{ padding: 24, fontFamily: 'system-ui', color: '#6b7280' }}>Loading preview…</div>
  }

  return (
    <I18nProvider value={t}>
      {/* Selection outline and click affordance live only in the preview. */}
      <style>{`
        [data-preview-key] { position: relative; }
        body.dsr-preview [data-preview-key]:hover {
          outline: 1px dashed rgba(10, 10, 10, .45);
          outline-offset: 2px;
          cursor: pointer;
        }
        body.dsr-preview [data-preview-selected="true"] {
          outline: 2px solid #0a0a0a;
          box-shadow: 0 0 0 4px rgba(245, 224, 3, .45);
          outline-offset: 2px;
          border-radius: 3px;
        }
        @media (prefers-reduced-motion: no-preference) {
          body.dsr-preview [data-preview-selected="true"] { transition: outline-color .15s ease-out; }
        }
      `}</style>
      <div
        className="formio-form"
        style={{ padding: '24px 20px', maxWidth: 760, margin: '0 auto' }}
        onClickCapture={(e) => {
          // Capture so a click selects the field instead of toggling a
          // checkbox or opening a dropdown inside the canvas.
          const key = keyFromEventTarget(e.target)
          if (!key) return
          e.preventDefault()
          e.stopPropagation()
          setSelected(key)
          toEditor({ type: 'dsr-preview:click', key })
        }}
      >
        <FieldTree
          components={schema.components ?? []}
          values={values}
          errors={{}}
          onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
          rootValues={values}
          submitButton={null}
        />
      </div>
      <SelectionMarker selected={selected} />
    </I18nProvider>
  )
}

/**
 * Applies the selection attribute in the DOM. Doing it here rather than
 * threading a prop through every renderer branch keeps the public renderer free
 * of preview-only concerns.
 */
function SelectionMarker({ selected }: { selected: string | null }) {
  useEffect(() => {
    document.body.classList.add('dsr-preview')
    return () => document.body.classList.remove('dsr-preview')
  }, [])

  useEffect(() => {
    const previous = document.querySelectorAll('[data-preview-selected="true"]')
    previous.forEach((el) => el.removeAttribute('data-preview-selected'))
    if (!selected) return
    const el = document.querySelector(`[data-preview-key="${CSS.escape(selected)}"]`)
    if (!el) return
    el.setAttribute('data-preview-selected', 'true')
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  return null
}
