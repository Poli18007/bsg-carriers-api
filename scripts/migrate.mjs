// Apply schema.sql to the Postgres in DATABASE_URL, and seed the admin from env.
// Idempotent — run it after provisioning the DB and any time the schema changes.
//
//   DATABASE_URL=postgres://… ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/migrate.mjs
//
// (Locally, values can come from a .env file.)

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});
await client.connect();

await client.query(sql);
console.log('✓ schema applied');

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const name = (process.env.ADMIN_NAME || 'BSG Admin').trim();
const password = process.env.ADMIN_PASSWORD || '';
if (email && password && password.length >= 8) {
  const hash = await bcrypt.hash(password, 12);
  await client.query(
    `INSERT INTO staff_users (email, name, password_hash, role, active)
     VALUES ($1,$2,$3,'admin',true)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = 'admin', active = true`,
    [email, name, hash]
  );
  console.log('✓ admin account ensured:', email);
} else {
  console.log('· no admin seeded (set ADMIN_EMAIL and an 8+ char ADMIN_PASSWORD)');
}

const [{ rows: tables }] = [await client.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
)];
console.log('tables:', tables.map((r) => r.table_name).join(', '));

await client.end();
