// Seed (or reset) a staff account. Run once to create the first admin, since the
// UI for adding staff itself requires being logged in as an admin.
//
//   node scripts/create-admin.mjs "Jane Doe" jane@bsgcarriers.com 'a-strong-password' admin
//
// Re-running with an existing email UPDATES that account's name, password and
// role — handy for a password reset from the shell.
//
// Reads DB creds from the environment (or a local .env). On cPanel, open the
// app's Terminal / "Run JS script" with the env already loaded, or run it once
// locally against the same DB.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

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

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

const hash = await bcrypt.hash(password, 12);
const lc = email.trim().toLowerCase();

await conn.query(
  `INSERT INTO staff_users (email, name, password_hash, role, active)
   VALUES (?,?,?,?,1)
   ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash), role=VALUES(role), active=1`,
  [lc, name, hash, role]
);

console.log(`✓ ${role} account ready: ${lc}`);
await conn.end();
