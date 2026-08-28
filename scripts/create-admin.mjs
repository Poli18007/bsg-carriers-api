// Seed or reset a staff account (Postgres). Useful for a password reset outside
// the env-driven seed.
//
//   DATABASE_URL=postgres://… node scripts/create-admin.mjs "Jane Doe" jane@bsgcarriers.com 'password' admin
//
// Re-running with an existing email updates that account.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const [, , name, email, password, roleArg] = process.argv;
const role = roleArg === 'staff' ? 'staff' : 'admin';

if (!name || !email || !password) {
  console.error('Usage: node scripts/create-admin.mjs "<name>" <email> <password> [admin|staff]');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});
await client.connect();

const hash = await bcrypt.hash(password, 12);
await client.query(
  `INSERT INTO staff_users (email, name, password_hash, role, active)
   VALUES ($1,$2,$3,$4,true)
   ON CONFLICT (email) DO UPDATE
     SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true`,
  [email.trim().toLowerCase(), name, hash, role]
);

console.log(`✓ ${role} account ready: ${email.trim().toLowerCase()}`);
await client.end();
