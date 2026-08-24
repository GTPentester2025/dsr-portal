/**
 * Helpers for editing a form.io component tree.
 *
 * Components nest through `components` and through `columns[].components`,
 * so every node is addressed by a path of segments rather than a single index.
 */

export interface Component {
  key?: string
  type: string
  label?: string
  placeholder?: string
  description?: string
  tooltip?: string
  hideLabel?: boolean
  customClass?: string
  content?: string
  tag?: string
  inline?: boolean
  rows?: number
  multiple?: boolean
  maxFiles?: number
  fileMaxSize?: string
  addAnother?: string
  dataSrc?: string
  data?: { values?: { label: string; value: string }[]; url?: string }
  values?: { label: string; value: string; shortcut?: string }[]
  validate?: {
    required?: boolean
    maxLength?: number | string
    minLength?: number | string
    pattern?: string
    customMessage?: string
  }
  conditional?: { show?: string | boolean; when?: string; eq?: string }
  columns?: { width?: number; components?: Component[] }[]
  components?: Component[]
  [k: string]: unknown
}

/** One step down the tree: into `components`, or into a specific column. */
export type Segment = { kind: 'child'; index: number } | { kind: 'column'; column: number; index: number }
export type Path = Segment[]

export const FIELD_TYPES = new Set([
  'dsrtextfield', 'textfield', 'dsremail', 'email', 'textarea',
  'dsrselect', 'select', 'dsrselectboxes', 'dsrradio', 'radio',
  'checkbox', 'dsrphoneNumber', 'dsrdatetime', 'file', 'datagrid',
])

export const TYPE_LABEL: Record<string, string> = {
  dsrtextfield: 'Short text', textfield: 'Short text',
  dsremail: 'Email', email: 'Email',
  textarea: 'Long text',
  dsrselect: 'Dropdown', select: 'Dropdown',
  dsrselectboxes: 'Checkboxes',
  dsrradio: 'Radio buttons', radio: 'Radio buttons',
  checkbox: 'Checkbox',
  dsrphoneNumber: 'Phone',
  dsrdatetime: 'Date',
  file: 'File upload',
  datagrid: 'Repeating table',
  htmlelement: 'Text block', content: 'Text block',
  columns: 'Column layout',
  button: 'Submit button',
}

export const TYPE_ICON: Record<string, string> = {
  dsrtextfield: 'edit', textfield: 'edit',
  dsremail: 'mail', email: 'mail',
  textarea: 'file',
  dsrselect: 'chevronDown', select: 'chevronDown',
  dsrselectboxes: 'checkCircle',
  dsrradio: 'checkCircle', radio: 'checkCircle',
  checkbox: 'check',
  dsrphoneNumber: 'inbox',
  dsrdatetime: 'clock',
  file: 'download',
  datagrid: 'grid',
  htmlelement: 'file', content: 'file',
  columns: 'panelLeft',
  button: 'send',
}

export const isField = (c: Component) => FIELD_TYPES.has(c.type)

export interface FlatNode {
  node: Component
  path: Path
  depth: number
  /** Human label for the branch this node sits on, e.g. "Column 2". */
  branch?: string
}

/** Depth-first walk producing a render-ready list with paths and depth. */
export function flatten(components: Component[], base: Path = [], depth = 0): FlatNode[] {
  const out: FlatNode[] = []
  components.forEach((node, index) => {
    const path: Path = [...base, { kind: 'child', index }]
    out.push({ node, path, depth })
    if (node.type === 'columns') {
      node.columns?.forEach((col, column) => {
        col.components?.forEach((child, i) => {
          const childPath: Path = [...path, { kind: 'column', column, index: i }]
          out.push({ node: child, path: childPath, depth: depth + 1, branch: `Column ${column + 1}` })
          if (child.components?.length) {
            out.push(...flatten(child.components, childPath, depth + 2))
          }
        })
      })
    } else if (node.components?.length && node.type !== 'datagrid') {
      out.push(...flatten(node.components, path, depth + 1))
    }
  })
  return out
}

/** Siblings array that a path's final segment indexes into. */
function siblingsOf(root: Component[], path: Path): Component[] | null {
  let list: Component[] = root
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]
    const node = seg.kind === 'child' ? list[seg.index] : list[seg.index]
    if (!node) return null
    if (seg.kind === 'child') {
      const next = path[i + 1]
      if (next.kind === 'column') {
        const col = node.columns?.[next.column]
        if (!col?.components) return null
        list = col.components
      } else {
        if (!node.components) return null
        list = node.components
      }
    } else {
      if (!node.components) return null
      list = node.components
    }
  }
  return list
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export function getAt(root: Component[], path: Path): Component | null {
  const siblings = siblingsOf(root, path)
  return siblings?.[path[path.length - 1].index] ?? null
}

export function updateAt(root: Component[], path: Path, patch: Partial<Component>): Component[] {
  const next = clone(root)
  const siblings = siblingsOf(next, path)
  if (!siblings) return root
  const i = path[path.length - 1].index
  siblings[i] = { ...siblings[i], ...patch }
  return next
}

export function removeAt(root: Component[], path: Path): Component[] {
  const next = clone(root)
  const siblings = siblingsOf(next, path)
  if (!siblings) return root
  siblings.splice(path[path.length - 1].index, 1)
  return next
}

/** Move a node up or down within its own siblings. */
export function moveAt(root: Component[], path: Path, direction: -1 | 1): Component[] {
  const next = clone(root)
  const siblings = siblingsOf(next, path)
  if (!siblings) return root
  const i = path[path.length - 1].index
  const j = i + direction
  if (j < 0 || j >= siblings.length) return root
  ;[siblings[i], siblings[j]] = [siblings[j], siblings[i]]
  return next
}

export function appendRoot(root: Component[], node: Component): Component[] {
  const next = clone(root)
  // Keep the submit button last so the new field lands above it.
  const submitAt = next.findIndex((c) => c.type === 'button')
  if (submitAt >= 0) next.splice(submitAt, 0, node)
  else next.push(node)
  return next
}

export const samePath = (a: Path | null, b: Path | null): boolean =>
  !!a && !!b && JSON.stringify(a) === JSON.stringify(b)

/** Every field key in the tree, used for uniqueness and conditional pickers. */
export function collectKeys(root: Component[]): { key: string; label: string; type: string }[] {
  return flatten(root)
    .filter((n) => isField(n.node) && n.node.key)
    .map((n) => ({ key: n.node.key!, label: n.node.label ?? n.node.key!, type: n.node.type }))
}

function uniqueKey(root: Component[], base: string): string {
  const taken = new Set(collectKeys(root).map((k) => k.key))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/** A sensible starting component for each palette entry. */
export function newComponent(type: string, root: Component[]): Component {
  const base: Component = {
    type,
    key: uniqueKey(root, type.replace(/^dsr/, '').toLowerCase() || 'field'),
    label: TYPE_LABEL[type] ?? 'New field',
    input: true,
    validate: { required: false },
    conditional: { show: '', when: '', eq: '' },
  }

  switch (type) {
    case 'dsrselect':
    case 'select':
      return { ...base, dataSrc: 'values', data: { values: [{ label: 'Option one', value: 'option_one' }] } }
    case 'dsrselectboxes':
    case 'dsrradio':
    case 'radio':
      return { ...base, values: [{ label: 'Option one', value: 'option_one' }], inline: false }
    case 'textarea':
      return { ...base, rows: 3 }
    case 'file':
      return { ...base, key: uniqueKey(root, 'attachments'), multiple: true, maxFiles: 3, fileMaxSize: '10MB' }
    case 'checkbox':
      return { ...base, label: 'I agree to the terms' }
    case 'htmlelement':
      return {
        type: 'htmlelement',
        key: uniqueKey(root, 'text_block'),
        tag: 'div',
        input: false,
        content: '<p>Explanatory text for the requester.</p>',
      }
    default:
      return base
  }
}
