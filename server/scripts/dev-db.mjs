// Local dev Postgres via embedded-postgres (no Docker on this machine).
// Usage: node scripts/dev-db.mjs        — start (blocks; Ctrl-C to stop)
import EmbeddedPostgres from 'embedded-postgres';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, '.pgdata');
const fresh = !existsSync(dataDir);
mkdirSync(dataDir, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'dsr',
  password: 'dsr',
  port: 5433,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('dsr');
console.log('dev postgres ready on 127.0.0.1:5433 (db=dsr user=dsr)');

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
