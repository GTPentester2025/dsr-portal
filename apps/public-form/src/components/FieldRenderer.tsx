import { useRef } from 'react'
import type { Component, FormValues } from '../types'
import { hasNoOptions, isVisible } from '../lib/conditional'
import { useT } from '../lib/i18n'
import { ChoicesSelect } from './Choices'

/**
 * Renders the verbatim form.io component tree with the exact DOM structure
 * and class names the reference renderer produces, so the vendored
 * stylesheets apply identically.
 *
 * Fidelity notes mirrored from the live DOM:
 *  - hidden components stay mounted with visibility:hidden;position:absolute
 *  - wrapper: .form-group.has-feedback.formio-component.formio-component-{type}.formio-component-{key} [required]
 *  - labels: .control-label with .field-required for the red asterisk
 */

export interface RendererProps {
  components: Component[]
  values: FormValues
  errors: Record<string, string>
  onChange: (key: string, value: unknown) => void
  rootValues?: FormValues
  afterField?: Record<string, React.ReactNode>
  /** Rendered in place of the schema's submit button component. */
  submitButton?: React.ReactNode
}

const HIDDEN_STYLE: React.CSSProperties = { visibility: 'hidden', position: 'absolute' }

function wrapperClass(c: Component, extra = ''): string {
  const custom = (c.customClass ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((tok) => (/^[mp][tblrxy]?-\d$/.test(tok) ? [tok] : [tok, `formio-component-${tok}`]))
    .join(' ')
  const required = c.validate?.required ? ' required' : ''
  return `form-group has-feedback formio-component formio-component-${c.type} formio-component-${c.key} ${custom}${required}${extra ? ' ' + extra : ''}`
}

function Label({ c, htmlFor }: { c: Component; htmlFor?: string }) {
  const t = useT()
  if (c.hideLabel || !c.label) return null
  return (
    <label
      className={`control-label${c.validate?.required ? ' field-required' : ''}`}
      htmlFor={htmlFor ?? c.key}
    >
      {t(c.label)}
      {c.tooltip ? (
        <>
          {' '}
          <i className="glyphicon glyphicon-question-sign text-muted" title={t(c.tooltip)} />
        </>
      ) : null}
    </label>
  )
}

function FieldErrors({ error }: { error?: string }) {
  if (!error) return null
  return (
    <div className="formio-errors invalid-feedback" style={{ display: 'block' }}>
      <div className="form-text error">{error}</div>
    </div>
  )
}

interface LeafProps {
  c: Component
  value: unknown
  error?: string
  onChange: (v: unknown) => void
}

function maskPlaceholder(mask: string | undefined): string {
  if (!mask) return ''
  return mask.replace(/[9a*]/g, '_')
}

function TextInput({ c, value, error, onChange }: LeafProps) {
  const t = useT()
  const type = c.type === 'email' || c.type === 'dsremail' ? 'email' : 'text'
  const max = Number(c.validate?.maxLength) || undefined
  const placeholder = t(c.placeholder) || maskPlaceholder(c.inputMask)
  const numericMask = Boolean(c.inputMask && /^[^a*]*$/.test(c.inputMask.replace(/9/g, '')))
  return (
    <>
      <input
        className="form-control"
        type={type}
        id={c.key}
        name={`data[${c.key}]`}
        placeholder={placeholder}
        pattern={c.inputMask && numericMask ? '\\d*' : undefined}
        maxLength={max}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {c.description && <div className="help-block">{t(c.description)}</div>}
      <FieldErrors error={error} />
    </>
  )
}

function TextAreaInput({ c, value, error, onChange }: LeafProps) {
  const t = useT()
  const max = Number(c.validate?.maxLength) || undefined
  return (
    <>
      <textarea
        className="form-control"
        id={c.key}
        name={`data[${c.key}]`}
        rows={c.rows ?? 3}
        placeholder={t(c.placeholder)}
        maxLength={max}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {c.description && <div className="help-block">{t(c.description)}</div>}
      <FieldErrors error={error} />
    </>
  )
}

function SelectBoxes({ c, value, error, onChange }: LeafProps) {
  const t = useT()
  const current = (value as Record<string, boolean>) ?? {}
  return (
    <>
      <Label c={c} />
      <div className="form-group">
        {(c.values ?? []).map((o) => (
          <div key={o.value} className="form-check form-check-inline checkbox-inline">
            <label className="control-label form-check-label" htmlFor={`${c.key}-${o.value}`}>
              <input
                className="form-check-input"
                type="checkbox"
                id={`${c.key}-${o.value}`}
                checked={Boolean(current[o.value])}
                onChange={(e) => onChange({ ...current, [o.value]: e.target.checked })}
              />
              <span>{t(o.label)}</span>
            </label>
          </div>
        ))}
      </div>
      <FieldErrors error={error} />
    </>
  )
}

function RadioInput({ c, value, error, onChange }: LeafProps) {
  const t = useT()
  return (
    <>
      <Label c={c} />
      <div className="form-group">
        {(c.values ?? []).map((o) => (
          <div key={o.value} className={c.inline ? 'form-check form-check-inline radio-inline' : 'form-check radio'} role="none">
            <label className="control-label form-check-label" htmlFor={`${c.key}-${o.value}`}>
              <input
                className="form-check-input"
                type="radio"
                id={`${c.key}-${o.value}`}
                name={`data[${c.key}]`}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              <span>{t(o.label)}</span>
            </label>
          </div>
        ))}
      </div>
      <FieldErrors error={error} />
    </>
  )
}

function CheckboxInput({ c, value, error, onChange }: LeafProps) {
  const t = useT()
  return (
    <>
      <label
        className={`control-label form-check-label${c.validate?.required ? ' field-required' : ''}`}
        htmlFor={`${c.key}-input`}
      >
        <input
          className="form-check-input"
          type="checkbox"
          id={`${c.key}-input`}
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{t(c.label)}</span>
      </label>
      {c.description && <div className="help-block">{t(c.description)}</div>}
      <FieldErrors error={error} />
    </>
  )
}

interface PickedFile { name: string; size: number; type: string }

function parseSize(s: string | undefined): number {
  const m = /^(\d+)\s*(KB|MB|GB)?$/i.exec(s ?? '')
  if (!m) return Infinity
  const mult = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2]?.toUpperCase() ?? ''] ?? 1
  return Number(m[1]) * mult
}

function FileInput({ c, value, error, onChange }: LeafProps) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const files = (value as PickedFile[]) ?? []
  const maxFiles = c.maxFiles ?? 10
  const maxSize = parseSize(c.fileMaxSize)

  const pick = (list: FileList | null) => {
    if (!list) return
    const next = [...files]
    for (const f of Array.from(list)) {
      if (next.length >= maxFiles) break
      if (f.size > maxSize) continue
      next.push({ name: f.name, size: f.size, type: f.type })
    }
    onChange(next)
  }

  return (
    <>
      <Label c={c} />
      <div>
        <FieldErrors error={error} />
        <ul className="list-group list-group-striped">
          <li className="list-group-item list-group-header hidden-xs hidden-sm">
            <div className="row">
              <div className="col-md-1"></div>
              <div className="col-md-9"><strong>{t('File Name')}</strong></div>
              <div className="col-md-2"><strong>{t('Size')}</strong></div>
            </div>
          </li>
          {files.map((f, i) => (
            <li key={i} className="list-group-item">
              <div className="row">
                <div className="col-md-1">
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); onChange(files.filter((_, j) => j !== i)) }}
                    aria-label="Remove"
                  >
                    <i className="glyphicon glyphicon-remove" />
                  </a>
                </div>
                <div className="col-md-9">{f.name}</div>
                <div className="col-md-2">{Math.round(f.size / 1024)} KB</div>
              </div>
            </li>
          ))}
        </ul>
        <input
          ref={inputRef}
          type="file"
          multiple={maxFiles > 1}
          style={{ opacity: 0, position: 'absolute' }}
          tabIndex={-1}
          onChange={(e) => { pick(e.target.files); e.target.value = '' }}
        />
        <div>
          <div className="fileSelector">
            <i className="glyphicon glyphicon-cloud-upload" /> {t('Drop files to attach, or')}{' '}
            <a
              href="#"
              className="browse"
              role="button"
              onClick={(e) => { e.preventDefault(); inputRef.current?.click() }}
            >
              {t('browse')}
            </a>
          </div>
        </div>
        {c.description && <div className="help-block">{t(c.description)}</div>}
      </div>
    </>
  )
}

function DateTimeInput({ c, value, error, onChange }: LeafProps) {
  const t = useT()
  const nativeRef = useRef<HTMLInputElement>(null)
  const fmt = (c.format || 'dd-MM-yyyy').replace(/y+/g, 'yyyy')
  const toDisplay = (iso: string) => {
    const [y, m, d] = iso.split('-')
    return fmt.replace('dd', d).replace('MM', m).replace('yyyy', y)
  }
  return (
    <>
      <div className="input-group">
        <input
          className="form-control form-control input"
          type="text"
          placeholder={t(c.placeholder) || fmt}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
        <span
          className="input-group-addon input-group-append"
          style={{ cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          onClick={() => {
            const el = nativeRef.current
            if (el && 'showPicker' in el) (el as HTMLInputElement & { showPicker: () => void }).showPicker()
          }}
        >
          <span className="input-group-text"><i className="glyphicon glyphicon-calendar" /></span>
        </span>
        <input
          ref={nativeRef}
          type="date"
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
          tabIndex={-1}
          onChange={(e) => { if (e.target.value) onChange(toDisplay(e.target.value)) }}
        />
      </div>
      {c.description && <div className="help-block">{t(c.description)}</div>}
      <FieldErrors error={error} />
    </>
  )
}

function DataGrid({ c, values, errors, onChange, rootValues }: {
  c: Component
  values: FormValues
  errors: Record<string, string>
  onChange: (key: string, value: unknown) => void
  rootValues?: FormValues
}) {
  const t = useT()
  const rows = (values[c.key] as FormValues[] | undefined) ?? [{}]
  const setRows = (next: FormValues[]) => onChange(c.key, next)
  const cols = (c.components ?? []).filter((x) => x.key)

  return (
    <>
      <Label c={c} />
      <table className="table datagrid-table table-bordered form-group formio-data-grid">
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col.key} className={col.validate?.required ? 'field-required' : ''}>
                {t(col.label)}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map((col) => (
                <td key={col.key}>
                  <Field
                    c={{ ...col, hideLabel: true }}
                    values={row}
                    errors={errors}
                    rootValues={{ ...(rootValues ?? values), ...row }}
                    onChange={(k, v) => {
                      const next = rows.slice()
                      next[i] = { ...next[i], [k]: v }
                      setRows(next)
                    }}
                  />
                </td>
              ))}
              <td className="formio-remove-column">
                <button
                  type="button"
                  className="btn btn-default btn-secondary formio-button-remove-row"
                  onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{}])}
                >
                  <i className="glyphicon glyphicon-remove-circle" />
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={cols.length + 1}>
              <button
                type="button"
                className="btn btn-primary formio-button-add-row"
                onClick={() => setRows([...rows, {}])}
              >
                <i className="glyphicon glyphicon-plus" /> {t(c.addAnother || 'Add Another')}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <FieldErrors error={errors[c.key]} />
    </>
  )
}

/** HTML content comes from our own vendored schema files, not user input. */
function HtmlElement({ c }: { c: Component }) {
  const t = useT()
  const Tag = (c.tag && /^[a-z][a-z0-9]*$/.test(c.tag) ? c.tag : 'div') as
    keyof React.JSX.IntrinsicElements
  return (
    <div
      className={`formio-component formio-component-htmlelement formio-component-${c.key} ${c.customClass ?? ''}`}
      data-preview-key={c.key || undefined}
    >
      <Tag className={c.className} dangerouslySetInnerHTML={{ __html: t(c.content) }} />
    </div>
  )
}

function Field({ c, values, errors, onChange, rootValues, afterField, submitButton }: {
  c: Component
  values: FormValues
  errors: Record<string, string>
  onChange: (key: string, value: unknown) => void
  rootValues?: FormValues
  afterField?: Record<string, React.ReactNode>
  submitButton?: React.ReactNode
}) {
  const condScope = rootValues ? { ...rootValues, ...values } : values
  const visible = isVisible(c, condScope, allComponents) && !hasNoOptions(c)
  const hiddenProps = visible ? {} : { style: HIDDEN_STYLE, hidden: true as const }
  const extra = visible ? afterField?.[c.key] : null

  switch (c.type) {
    case 'columns':
      return (
        <div className={`row formio-component formio-component-columns formio-component-columns ${c.customClass ?? ''}`} {...hiddenProps}>
          {(c.columns ?? []).map((col, ci) => (
            <div
              key={ci}
              className={`col col-sm-${Math.min((col as { width?: number }).width || 6, 12)} col-sm-offset-0 col-sm-push-0 col-sm-pull-0`}
            >
              {(col.components ?? []).map((cc, i) => (
                <Field key={cc.key || i} c={cc} values={values} errors={errors} onChange={onChange} rootValues={rootValues} afterField={afterField} submitButton={submitButton} />
              ))}
            </div>
          ))}
        </div>
      )
    case 'htmlelement':
    case 'content':
      return visible ? <HtmlElement c={c} /> : <div {...hiddenProps} />
    case 'button':
      return submitButton ? <>{submitButton}</> : null
    default:
      break
  }

  const leaf = { c, value: values[c.key], error: errors[c.key], onChange: (v: unknown) => onChange(c.key, v) }

  let body: React.ReactNode
  let extraWrapper = ''
  switch (c.type) {
    case 'textfield':
    case 'dsrtextfield':
    case 'email':
    case 'dsremail':
    case 'dsrphoneNumber':
      body = <><Label c={c} /><TextInput {...leaf} /></>
      break
    case 'dsrdatetime':
      body = <><Label c={c} /><DateTimeInput {...leaf} /></>
      break
    case 'textarea':
      body = <><Label c={c} /><TextAreaInput {...leaf} /></>
      break
    case 'select':
    case 'dsrselect':
      body = (
        <>
          <Label c={c} />
          <ChoicesSelect component={c} value={values[c.key]} onChange={leaf.onChange} />
          <FieldErrors error={errors[c.key]} />
        </>
      )
      break
    case 'dsrselectboxes':
      body = <SelectBoxes {...leaf} />
      break
    case 'radio':
    case 'dsrradio':
      body = <RadioInput {...leaf} />
      break
    case 'checkbox':
      body = <CheckboxInput {...leaf} />
      extraWrapper = ' form-check checkbox'
      break
    case 'file':
      body = <FileInput {...leaf} />
      break
    case 'datagrid':
      body = <DataGrid c={c} values={values} errors={errors} onChange={onChange} rootValues={rootValues} />
      break
    default:
      if (c.components) {
        body = (c.components ?? []).map((cc, i) => (
          <Field key={cc.key || i} c={cc} values={values} errors={errors} onChange={onChange} rootValues={rootValues} afterField={afterField} submitButton={submitButton} />
        ))
      } else {
        return null
      }
  }

  return (
    <div
      className={wrapperClass(c, extraWrapper.trim())}
      // Read by the builder's preview bridge to resolve a click to a component.
      // Inert outside the iframe.
      data-preview-key={c.key || undefined}
      {...hiddenProps}
    >
      {body}
      {extra}
    </div>
  )
}

/**
 * The whole tree, for conditionals that reference another field's options.
 * Held at module scope rather than threaded through every renderer branch,
 * which would touch a lot of code that has nothing to do with visibility.
 */
let allComponents: Component[] = []

export function FieldTree(props: RendererProps) {
  allComponents = props.components

  return (
    <div>
      {props.components.map((c, i) => (
        <Field
          key={c.key || i}
          c={c}
          values={props.values}
          errors={props.errors}
          onChange={props.onChange}
          rootValues={props.rootValues}
          afterField={props.afterField}
          submitButton={props.submitButton}
        />
      ))}
    </div>
  )
}
