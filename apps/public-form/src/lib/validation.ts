import type { Component, FormValues } from '../types'
import { isVisible } from './conditional.ts'

export interface FieldError {
  key: string
  label: string
  message: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') {
    // selectboxes: at least one option true
    return !Object.values(value as Record<string, unknown>).some(Boolean)
  }
  return false
}

function num(v: number | string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const INPUT_TYPES = new Set([
  'textfield', 'dsrtextfield', 'textarea', 'select', 'dsrselect',
  'dsrselectboxes', 'checkbox', 'radio', 'dsrradio', 'email', 'dsremail',
  'dsrphoneNumber', 'dsrdatetime', 'file', 'datagrid',
])

function validateOne(
  c: Component,
  value: unknown,
  t: (s: string | undefined) => string,
): string | null {
  const v = c.validate ?? {}
  if (v.required && isEmpty(value)) {
    return t(v.customMessage) || `${t(c.label) || c.key} is required`
  }
  if (isEmpty(value)) return null

  if (typeof value === 'string') {
    const max = num(v.maxLength)
    const min = num(v.minLength)
    if (max !== undefined && value.length > max) return `Maximum ${max} characters`
    if (min !== undefined && value.length < min) return `Minimum ${min} characters`
    if (v.pattern && v.pattern !== '') {
      try {
        if (!new RegExp(`^(?:${v.pattern})$`).test(value)) {
          return t(v.customMessage) || 'Invalid format'
        }
      } catch {
        /* bad pattern in source schema — skip, server re-checks */
      }
    }
    if ((c.type === 'email' || c.type === 'dsremail') && !EMAIL_RE.test(value)) {
      return 'Enter a valid email address'
    }

    const dateError = validateDate(c, value)
    if (dateError) return dateError
  }
  return null
}

/** Field keys and labels that mean a date of birth across the 12 forms. */
const DOB_HINTS = /(^|_)(dob|birth|nacimiento|nascimento|naissance|geburt)/i

function looksLikeDob(c: Component): boolean {
  return DOB_HINTS.test(c.key ?? '') || DOB_HINTS.test(c.label ?? '')
}

/**
 * Dates, and dates of birth in particular.
 *
 * A birth date in the future or three centuries ago is a typo, not a request,
 * and catching it at entry avoids a case that has to be closed as unverifiable.
 * The check is skipped for anything that does not parse as a date so free-text
 * fields are unaffected.
 */
function validateDate(c: Component, value: string): string | null {
  const isDateField =
    c.type === 'datetime' ||
    c.type === 'dsrdatetime' ||
    c.type === 'date' ||
    looksLikeDob(c)
  if (!isDateField) return null

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    // Only complain when the value plausibly meant to be a date.
    return /\d{4}|\d{1,2}[/-]\d{1,2}/.test(value) ? 'Enter a valid date' : null
  }

  const now = new Date()
  if (looksLikeDob(c)) {
    if (parsed > now) return 'A date of birth cannot be in the future'
    const age = (now.getTime() - parsed.getTime()) / (365.25 * 24 * 3600 * 1000)
    if (age > 120) return 'Check the date of birth — it appears to be over 120 years ago'
    if (age < 0.0027) return 'Check the date of birth'
  } else {
    // A general date field 200 years out is a mistyped year.
    const years = Math.abs(now.getTime() - parsed.getTime()) / (365.25 * 24 * 3600 * 1000)
    if (years > 200) return 'Check the date — the year looks wrong'
  }
  return null
}

/** Validate all visible input components. Mirrors what the server re-checks. */
export function validateForm(
  components: Component[],
  values: FormValues,
  t: (s: string | undefined) => string,
): FieldError[] {
  const errors: FieldError[] = []

  const walk = (list: Component[], scope: FormValues) => {
    for (const c of list) {
      if (!isVisible(c, scope, components)) continue
      if (c.type === 'columns') {
        for (const col of c.columns ?? []) walk(col.components ?? [], scope)
        continue
      }
      if (c.type === 'datagrid') {
        const rows = (scope[c.key] as FormValues[] | undefined) ?? []
        const err = validateOne(c, rows, t)
        if (err) errors.push({ key: c.key, label: t(c.label) || c.key, message: err })
        rows.forEach((row) => walk(c.components ?? [], { ...scope, ...row }))
        continue
      }
      if (c.components) {
        walk(c.components, scope)
      }
      if (!INPUT_TYPES.has(c.type)) continue
      const err = validateOne(c, scope[c.key], t)
      if (err) errors.push({ key: c.key, label: t(c.label) || c.key, message: err })
    }
  }

  walk(components, values)
  return errors
}
