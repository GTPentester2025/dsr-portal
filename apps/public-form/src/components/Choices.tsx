import { useEffect, useMemo, useRef, useState } from 'react'
import type { Component, Country, OptionValue } from '../types'
import { loadCountries } from '../lib/api'
import { useT } from '../lib/i18n'

/**
 * Replicates the choices.js select DOM the reference form renders, so the
 * vendored stylesheets style it identically (underline single-select with a
 * clear button and a searchable dropdown).
 */
export function ChoicesSelect({ component, value, onChange }: {
  component: Component
  value: unknown
  onChange: (v: unknown) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [countries, setCountries] = useState<Country[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // form.io marks these with `multiple`; the stored value is then an array.
  // Ignoring it meant a question that should accept several channels only ever
  // kept the last one picked.
  const isMulti = component.multiple === true
  const selectedValues: string[] = isMulti
    ? Array.isArray(value)
      ? (value as unknown[]).map(String)
      : value
        ? [String(value)]
        : []
    : []

  const toggle = (optionValue: string) => {
    if (!isMulti) {
      onChange(optionValue)
      setOpen(false)
      return
    }
    // Selecting an already-chosen option removes it, as a chip would.
    const next = selectedValues.includes(optionValue)
      ? selectedValues.filter((v) => v !== optionValue)
      : [...selectedValues, optionValue]
    onChange(next)
    // The list stays open so several can be picked in one pass.
  }

  const isCountrySrc =
    component.dataSrc === 'url' && (component.data?.url ?? '').includes('countries')

  useEffect(() => {
    if (isCountrySrc) loadCountries().then(setCountries).catch(() => setCountries([]))
  }, [isCountrySrc])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    if (open) searchRef.current?.focus()
    else setSearch('')
  }, [open])

  const options: OptionValue[] = useMemo(() => {
    const raw = isCountrySrc
      ? (countries ?? []).map((c) => ({ label: c.cn, value: c.cn }))
      : (component.data?.values ?? []).filter((o) => o.label !== '' || o.value !== '')
    const q = search.trim().toLowerCase()
    return q ? raw.filter((o) => t(o.label).toLowerCase().includes(q)) : raw
  }, [isCountrySrc, countries, component.data, search, t])

  const selected = (isCountrySrc
    ? (countries ?? []).map((c) => ({ label: c.cn, value: c.cn }))
    : component.data?.values ?? []
  ).find((o) => o.value === value)

  return (
    <div
      ref={rootRef}
      className="choices form-group formio-choices"
      data-type="select-one"
      role="combobox"
      aria-expanded={open}
      dir="ltr"
    >
      <div
        className="form-control"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) }
        }}
      >
        <select
          className="form-control choices__input is-hidden"
          aria-label={component.label ? `${component.label} search` : 'Search options'}
          id={component.key}
          value={(value as string) ?? ''}
          onChange={() => undefined}
          tabIndex={-1}
          aria-hidden
        >
          <option value="">{selected ? t(selected.label) : ''}</option>
        </select>
        <div className="choices__list choices__list--single">
          {isMulti ? (
            selectedValues.length === 0 ? (
              <div className="choices__item choices__item--selectable choices__placeholder">
                {component.placeholder ? t(component.placeholder) : ' '}
              </div>
            ) : (
              selectedValues.map((v) => {
                const picked = options.find((o) => String(o.value) === v)
                return (
                  <div key={v} className="choices__item choices__item--selectable">
                    {picked ? t(picked.label) : v}
                    <button
                      type="button"
                      className="choices__button"
                      aria-label="Remove item"
                      onClick={(e) => { e.stopPropagation(); toggle(v) }}
                    >
                      Remove item
                    </button>
                  </div>
                )
              })
            )
          ) : (
            <div className={`choices__item choices__item--selectable${selected ? '' : ' choices__placeholder'}`}>
              {selected ? t(selected.label) : (component.placeholder ? t(component.placeholder) : ' ')}
              {selected && (
                <button
                  type="button"
                  className="choices__button"
                  aria-label="Remove item"
                  onClick={(e) => { e.stopPropagation(); onChange('') }}
                >
                  Remove item
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div
        className={`choices__list choices__list--dropdown${open ? ' is-active' : ''}`}
        aria-expanded={open}
      >
        <input
          ref={searchRef}
          type="text"
          className="choices__input choices__input--cloned"
          aria-label={component.label ? `${component.label} search` : 'Search options'}
          placeholder=""
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="choices__list" role="listbox">
          {options.map((o, i) => (
            <div
              key={o.value + i}
              className={`choices__item choices__item--choice choices__item--selectable${i === 0 ? ' is-highlighted' : ''}`}
              role="option"
              aria-selected={isMulti ? selectedValues.includes(String(o.value)) : undefined}
              onClick={() => toggle(String(o.value))}
            >
              {t(o.label)}
            </div>
          ))}
          {options.length === 0 && (
            <div className="choices__item choices__item--choice has-no-choices">
              No choices to choose from
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
