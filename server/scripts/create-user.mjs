// Create or update an internal user (break-glass credentials).
// Usage: node scripts/create-user.mjs <email> <name> <role> [zone] [password]
//   role: admin | zone_manager | approver | auditor
//   zone: EUR | SAZ | MAZ   (omit for admin/auditor)
// Password read from DSR_USER_PASSWORD env if not passed as arg.
import pg from 'pg';
import argon2 from 'argon2';

const [email, name, role, zone, passwordArg] = process.argv.slice(2);
const password = passwordArg ?? process.env.DSR_USER_PASSWORD;
if (!email || !name || !role || !password) {
  console.error('usage: create-user.mjs <email> <name> <role> [zone] [password]');
  process.exit(1);
}
if (password.length < 14 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
  console.error('password policy: >=14 chars, upper+lower+digit');
  process.exit(1);
}

const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });
const client = new pg.Client(process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr');
await client.connect();
const res = await client.query(
  `INSERT INTO users (email, name, role, zone_id, password_hash, is_break_glass)
   VALUES ($1, $2, $3, $4, $5, true)
   ON CONFLICT (email) DO UPDATE
     SET name = $2, role = $3, zone_id = $4, password_hash = $5, active = true
   RETURNING id`,
  [email.toLowerCase(), name, role, zone || null, hash],
);
console.log(`user ${email} (${role}${zone ? ', ' + zone : ''}) -> ${res.rows[0].id}`);
await client.end();
