// Import/refresh form schemas into form_versions (idempotent).
// Usage: node scripts/import-forms.mjs
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaDir = join(dirname(root), 'form-schema');
const url = process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr';

const client = new pg.Client(url);
await client.connect();

const files = readdirSync(schemaDir).filter(
  (f) => f.endsWith('.json') && !['manifest.json', 'countries.json'].includes(f),
);
for (const f of files) {
  const doc = JSON.parse(readFileSync(join(schemaDir, f), 'utf-8'));
  const res = await client.query(
    `INSERT INTO form_versions (form_key, zone_id, version, schema)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (form_key, version) DO UPDATE SET schema = EXCLUDED.schema
     RETURNING id`,
    [doc.key, doc.zone, doc.source.version, JSON.stringify(doc)],
  );
  console.log(`${doc.key} v${doc.source.version} -> ${res.rows[0].id}`);
}
await client.end();
