import { Chip } from './ui'

/**
 * Presents a submitted form value the way a caseworker expects to read it.
 *
 * Form.io stores selections as objects and repeating sections as arrays, which
 * were being dumped as raw JSON — readable to a developer, not to someone
 * answering a statutory request. Each shape gets the presentation that fits it:
 * selections become chips, repeating sections become tables, everything else
 * becomes text.
 */

/** `first_name` and `dobBrazil` both become "First name" / "Dob brazil". */
export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/

function formatScalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const text = String(value)
  if (ISO_DATE.test(text)) {
    const d = new Date(text)
    if (!Number.isNaN(d.getTime())) {
      // Date-only values must not gain a spurious midnight time.
      return text.length <= 10 ? d.toLocaleDateString() : d.toLocaleString()
    }
  }
  return text
}

/** A checkbox group: `{access: true, erasure: false}` — only the chosen matter. */
function isSelectionMap(v: Record<string, unknown>): boolean {
  const values = Object.values(v)
  return values.length > 0 && values.every((x) => typeof x === 'boolean')
}

export function FieldValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-faint">—</span>
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-faint">None</span>

    // A repeating section: one row per entry, one column per field.
    if (value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      const rows = value as Record<string, unknown>[]
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
      return (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line">
                {columns.map((col) => (
                  <th key={col} className="px-1 py-1.5 text-left font-medium text-faint">
                    {humaniseKey(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {columns.map((col) => (
                    <td key={col} className="px-1 py-1.5 align-top text-ink">
                      {formatScalar(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    return <span className="text-ink">{value.map((v) => formatScalar(v)).join(', ')}</span>
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>

    if (isSelectionMap(obj)) {
      const chosen = Object.entries(obj).filter(([, v]) => v === true).map(([k]) => k)
      if (chosen.length === 0) return <span className="text-faint">None selected</span>
      return (
        <span className="flex flex-wrap gap-1">
          {chosen.map((k) => (
            <Chip key={k}>{humaniseKey(k)}</Chip>
          ))}
        </span>
      )
    }

    // Any other object: a small label/value table rather than a JSON blob.
    const entries = Object.entries(obj)
    return (
      <dl className="space-y-0.5">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2 text-[12px]">
            <dt className="shrink-0 text-faint">{humaniseKey(k)}</dt>
            <dd className="min-w-0 break-words text-ink">{formatScalar(v)}</dd>
          </div>
        ))}
      </dl>
    )
  }

  return <span className="text-ink">{formatScalar(value)}</span>
}
