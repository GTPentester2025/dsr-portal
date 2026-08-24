import { useEffect, useState } from 'react'
import { useDraftId } from '../lib/draft'
import type { Component, Country, OptionValue } from '../types'
import { loadCountries } from '../lib/api'
import { useT } from '../lib/i18n'

export interface InputProps {
  component: Component
  value: unknown
  onChange: (value: unknown) => void
  error?: string
}

const inputCls =
  'w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-ink focus:outline-none focus:ring-2 focus:ring-brand-soft ' +
  'disabled:bg-gray-100'

export function Label({ component }: { component: Component }) {
  const t = useT()
  if (component.hideLabel || !component.label) return null
  return (
    <label className="mb-1 block text-sm font-medium text-gray-800">
      {t(component.label)}
      {component.validate?.required && <span className="ml-0.5 text-red-600">*</span>}
    </label>
  )
}

export function Description({ component }: { component: Component }) {
  const t = useT()
  if (!component.description) return null
  return <p className="mt-1 text-xs text-gray-500">{t(component.description)}</p>
}

export function ErrorText({ error }: { error?: string }) {
  if (!error) return null
  return <p className="mt-1 text-xs text-red-600">{error}</p>
}

export function TextInput({ component, value, onChange, error }: InputProps) {
  const t = useT()
  const type =
    component.type === 'email' || component.type === 'dsremail'
      ? 'email'
      : component.type === 'dsrphoneNumber'
        ? 'tel'
        : 'text'
  const max = Number(component.validate?.maxLength) || undefined
  return (
    <div>
      <Label component={component} />
      <input
        type={type}
        className={inputCls}
        value={(value as string) ?? ''}
        placeholder={t(component.placeholder)}
        maxLength={max}
        disabled={component.disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <Description component={component} />
      <ErrorText error={error} />
    </div>
  )
}

export function TextAreaInput({ component, value, onChange, error }: InputProps) {
  const t = useT()
  const max = Number(component.validate?.maxLength) || undefined
  const val = (value as string) ?? ''
  return (
    <div>
      <Label component={component} />
      <textarea
        className={inputCls}
        rows={component.rows ?? 3}
        value={val}
        placeholder={t(component.placeholder)}
        maxLength={max}
        onChange={(e) => onChange(e.target.value)}
      />
      {component.showCharCount && max && (
        <p className="mt-0.5 text-right text-xs text-gray-400">
          {val.length}/{max}
        </p>
      )}
      <Description component={component} />
      <ErrorText error={error} />
    </div>
  )
}

export function DateInput({ component, value, onChange, error }: InputProps) {
  return (
    <div>
      <Label component={component} />
      <input
        type="date"
        className={inputCls}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      <Description component={component} />
      <ErrorText error={error} />
    </div>
  )
}

export function SelectInput({ component, value, onChange, error }: InputProps) {
  const t = useT()
  const [countries, setCountries] = useState<Country[] | null>(null)
  const isCountrySrc =
    component.dataSrc === 'url' && (component.data?.url ?? '').includes('countries')

  useEffect(() => {
    if (isCountrySrc) loadCountries().then(setCountries).catch(() => setCountries([]))
  }, [isCountrySrc])

  const options: OptionValue[] = isCountrySrc
    ? (countries ?? []).map((c) => ({ label: c.cn, value: c.cn }))
    : (component.data?.values ?? []).filter((o) => o.label !== '' || o.value !== '')

  return (
    <div>
      <Label component={component} />
      <select
        className={inputCls}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t(component.placeholder) || '--'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.label)}
          </option>
        ))}
      </select>
      <Description component={component} />
      <ErrorText error={error} />
    </div>
  )
}

/** Multi-checkbox; value shape is form.io's { [optionValue]: boolean }. */
export function SelectBoxesInput({ component, value, onChange, error }: InputProps) {
  const t = useT()
  const current = (value as Record<string, boolean>) ?? {}
  return (
    <div>
      <Label component={component} />
      <div className="mt-1 grid gap-1.5">
        {(component.values ?? []).map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm text-gray-800">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300"
              checked={Boolean(current[o.value])}
              onChange={(e) => onChange({ ...current, [o.value]: e.target.checked })}
            />
            {t(o.label)}
          </label>
        ))}
      </div>
      <Description component={component} />
      <ErrorText error={error} />
    </div>
  )
}

export function RadioInput({ component, value, onChange, error }: InputProps) {
  const t = useT()
  return (
    <div>
      <Label component={component} />
      <div className={component.inline ? 'flex flex-wrap gap-4' : 'grid gap-1.5'}>
        {(component.values ?? []).map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm text-gray-800">
            <input
              type="radio"
              className="h-4 w-4 border-gray-300"
              name={component.key}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {t(o.label)}
          </label>
        ))}
      </div>
      <Description component={component} />
      <ErrorText error={error} />
    </div>
  )
}

export function CheckboxInput({ component, value, onChange, error }: InputProps) {
  const t = useT()
  return (
    <div>
      <label className="flex items-start gap-2 text-sm text-gray-800">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-gray-300"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {t(component.label)}
          {component.validate?.required && <span className="ml-0.5 text-red-600">*</span>}
        </span>
      </label>
      <Description component={component} />
      <ErrorText error={error} />
    </div>
  )
}

interface PickedFile {
  name: string
  size: number
  type: string
  /** Server-side attachment id once uploaded. */
  id?: string
}

/** Mirrors the server's allow-list so a rejection is caught before upload. */
const ACCEPTED = /^(application\/pdf|image\/(png|jpe?g|webp|heic))$/i

function parseSize(s: string | undefined): number {
  const m = /^(\d+)\s*(KB|MB|GB)?$/i.exec(s ?? '')
  if (!m) return Infinity
  const mult = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2]?.toUpperCase() ?? ''] ?? 1
  return Number(m[1]) * mult
}

/** Phase 1: client-side file picker only; upload wiring lands with the API. */
export function FileInput({ component, value, onChange, error }: InputProps) {
  const draftId = useDraftId()
  const t = useT()
  const files = (value as PickedFile[]) ?? []
  const maxFiles = component.maxFiles ?? 10
  const maxSize = parseSize(component.fileMaxSize)
  const [localError, setLocalError] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = async (list: FileList | null) => {
    if (!list) return
    setLocalError('')

    if (!draftId) {
      setLocalError('Enter your email address first, then attach files.')
      return
    }

    const next = [...files]
    for (const f of Array.from(list)) {
      if (next.length >= maxFiles) {
        setLocalError(`Maximum ${maxFiles} files`)
        break
      }
      if (f.size > maxSize) {
        setLocalError(`"${f.name}" exceeds ${component.fileMaxSize}`)
        continue
      }
      if (!ACCEPTED.test(f.type)) {
        setLocalError(`"${f.name}" is not a PDF or an image`)
        continue
      }

      setBusy(true)
      try {
        const form = new FormData()
        form.append('file', f)
        const res = await fetch(`/public/drafts/${draftId}/attachments`, {
          method: 'POST',
          credentials: 'same-origin',
          body: form,
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.message ?? 'Upload failed')
        // Keep the server's id so the file can be tied to the case on submit.
        next.push({ id: data.id, name: data.name, size: data.size, type: data.type })
      } catch (err) {
        setLocalError((err as Error).message)
      } finally {
        setBusy(false)
      }
    }
    onChange(next)
  }

  return (
    <div>
      <Label component={component} />
      <input
        type="file"
        id={component.key}
        aria-label={component.label || 'Attach files'}
        multiple={maxFiles > 1}
        accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,application/pdf,image/png,image/jpeg,image/webp,image/heic"
        disabled={busy}
        className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-sm file:border file:border-ink file:bg-brand file:px-3 file:py-1.5 file:text-sm file:font-semibold file:uppercase file:tracking-wide file:text-on-brand hover:file:bg-brand-hover"
        onChange={(e) => {
          pick(e.target.files)
          e.target.value = ''
        }}
      />
      {busy && <p className="mt-1 text-xs text-gray-500">Uploading…</p>}
      {component.fileMaxSize && (
        <p className="mt-0.5 text-xs text-gray-400">
          {t('Max')} {component.fileMaxSize} · {maxFiles} {t('files')}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-gray-600">
              <span className="truncate">{f.name}</span>
              <span className="text-gray-400">({Math.round(f.size / 1024)} KB)</span>
              <button
                type="button"
                className="text-red-500 hover:underline"
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                {t('Remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Description component={component} />
      <ErrorText error={localError || error} />
    </div>
  )
}
