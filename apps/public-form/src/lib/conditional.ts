import type { Component, FormValues } from '../types'

/**
 * form.io simple conditional: { show, when, eq }.
 *
 * `eq` usually holds the option's *value*, but some source forms store its
 * *label* instead — Mexico gates its unsubscribe-channel dropdown on
 * "Unsubscribe" while the option's value is "opt-out". Matching only on value
 * left that field permanently hidden, so the section looked broken. Both are
 * accepted, which is what the original renderer does.
 */
export function isVisible(
  component: Component,
  values: FormValues,
  /** The whole tree, so `eq` can be resolved against the source field's labels. */
  allComponents?: Component[],
): boolean {
  if (component.hidden) return false
  const cond = component.conditional
  if (!cond || !cond.when) return true

  const show = String(cond.show) === 'true'
  const actual = values[cond.when]
  const wanted = String(cond.eq)

  // The values that should satisfy this condition: the literal `eq`, plus the
  // value of any option on the source field whose label equals `eq`.
  const accepted = new Set([wanted])
  if (allComponents) {
    const source = findByKey(allComponents, cond.when)
    for (const option of source?.data?.values ?? source?.values ?? []) {
      if (option?.label !== undefined && String(option.label).trim() === wanted.trim()) {
        accepted.add(String(option.value))
      }
    }
  }

  let matches: boolean
  if (Array.isArray(actual)) {
    matches = actual.map(String).some((v) => accepted.has(v))
  } else if (actual !== null && typeof actual === 'object') {
    // selectboxes value shape: { optionValue: boolean }
    const map = actual as Record<string, unknown>
    matches = [...accepted].some((v) => Boolean(map[v]))
  } else {
    matches = accepted.has(String(actual ?? ''))
  }
  return matches === show
}

function findByKey(components: Component[], key: string): Component | undefined {
  for (const c of components) {
    if (c.key === key) return c
    const nested = findByKey(c.components ?? [], key)
    if (nested) return nested
    for (const col of c.columns ?? []) {
      const inColumn = findByKey(col.components ?? [], key)
      if (inColumn) return inColumn
    }
  }
  return undefined
}

/**
 * A choice field with no options cannot be answered.
 *
 * Mexico's source carries an empty radio group alongside the real dropdown;
 * rendering it produced a visible control with nothing in it, which is what
 * made the section look broken.
 */
export function hasNoOptions(component: Component): boolean {
  const CHOICE = ['radio', 'select', 'selectboxes', 'dsrselect', 'dsrselectboxes']
  if (!CHOICE.includes(component.type)) return false
  // A select backed by a remote list (countries) legitimately has none inline.
  if (component.dataSrc && component.dataSrc !== 'values') return false
  const options = component.data?.values ?? component.values ?? []
  return options.length === 0
}
