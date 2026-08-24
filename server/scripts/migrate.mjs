// Apply drizzle SQL migrations in order, tracking what has run.
//
// Used on the server instead of drizzle-kit so deployment needs no dev
// dependencies and no network access. Idempotent and safe to re-run.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = join(root, 'drizzle')
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const client = new pg.Client(url)
await client.connect()

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`)

const applied = new Set(
  (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
)

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
let ran = 0

for (const file of files) {
  if (applied.has(file)) continue
  const sql = readFileSync(join(dir, file), 'utf-8')
  // drizzle separates statements with this marker; DO blocks contain
  // semicolons, so splitting on ';' would corrupt them.
  const statements = sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)

  await client.query('BEGIN')
  try {
    for (const stmt of statements) await client.query(stmt)
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    await client.query('COMMIT')
    console.log(`applied ${file} (${statements.length} statements)`)
    ran++
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(`FAILED ${file}: ${err.message}`)
    await client.end()
    process.exit(1)
  }
}

console.log(ran === 0 ? 'schema already up to date' : `applied ${ran} migration(s)`)
await client.end()
