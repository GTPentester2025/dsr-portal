import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the deployment scripts point.
 *
 * The address of a live portal is not source: published, it hands anyone the
 * exact host, layout and roles of a system holding identity documents. It
 * lives in deploy/.target.env, which is gitignored, and the tracked scripts
 * read it from there.
 *
 * Order: an explicit environment variable wins, then .target.env, then
 * nothing — and "nothing" is a clear error rather than a silent default.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, '.target.env');

function fromFile() {
  if (!existsSync(FILE)) return {};
  const out = {};
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const file = fromFile();

/** The portal's public base URL, e.g. https://privacy.example.com */
export function portalBase() {
  const base = process.env.BASE ?? file.PORTAL_BASE;
  if (!base) {
    console.error(
      'No target. Set BASE=https://your-host, or create deploy/.target.env\n' +
      'from deploy/target.example.env.',
    );
    process.exit(1);
  }
  return base.replace(/\/$/, '');
}

/** The ssh destination, e.g. root@203.0.113.10 */
export function sshHost() {
  const host = process.env.HOST ?? file.DEPLOY_HOST;
  if (!host) {
    console.error('No ssh target. Set HOST=root@your-server or create deploy/.target.env.');
    process.exit(1);
  }
  return host;
}
