// Logic smoke test: run conditional visibility + validation against all 12
// real schemas. Node 22: node --experimental-strip-types scripts/smoke.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { isVisible } from '../src/lib/conditional.ts'
import { validateForm } from '../src/lib/validation.ts'

const dir = new URL('../public/form-schema/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !['manifest.json', 'countries.json'].includes(f))
const id = (s) => s

let failures = 0
for (const f of files) {
  const schema = JSON.parse(readFileSync(new URL(f, dir), 'utf-8'))

  // 1. Empty form must produce at least one required-field error.
  const errs = validateForm(schema.components, {}, id)
  const requiredCount = errs.length

  // 2. Conditional fields referencing selectboxes/select keys resolve without throwing.
  let condChecked = 0
  const walk = (cs, values) => {
    for (const c of cs ?? []) {
      if (c?.conditional?.when) {
        isVisible(c, values)
        condChecked++
      }
      walk(c.components, values)
      for (const col of c.columns ?? []) walk(col.components, values)
    }
  }
  walk(schema.components, {})
  walk(schema.components, { ticket_type: { other: true }, user_type: 'other' })

  const ok = requiredCount > 0
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}: requiredErrors=${requiredCount} conditionals=${condChecked}`)
}

// 3. Targeted: eur-1 "Other (please specify)" appears only when user_type=other.
const eur1 = JSON.parse(readFileSync(new URL('eur-1.json', dir), 'utf-8'))
const findByKey = (cs, key) => {
  for (const c of cs ?? []) {
    if (c.key === key && c.conditional?.when) return c
    const hit = findByKey(c.components, key) ?? (c.columns ?? []).map((col) => findByKey(col.components, key)).find(Boolean)
    if (hit) return hit
  }
  return null
}
const other = findByKey(eur1.components, 'other_please_specify')
if (other) {
  const hidden = isVisible(other, { user_type: 'consumer' })
  const shown = isVisible(other, { [other.conditional.when]: other.conditional.eq })
  const pass = !hidden && shown
  if (!pass) failures++
  console.log(`${pass ? 'ok  ' : 'FAIL'} eur-1 conditional other_please_specify (when=${other.conditional.when} eq=${other.conditional.eq})`)
} else {
  console.log('note: eur-1 other_please_specify has no conditional')
}

process.exit(failures ? 1 : 0)
