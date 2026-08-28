// Load schema.sql into the configured database.
//
//   node scripts/init-db.mjs
//
// Reads DB creds from the environment (or a local .env). Every statement in
// schema.sql is idempotent (IF NOT EXISTS), so this is safe to re-run.
//
// On cPanel you can instead paste schema.sql into phpMyAdmin — this script is
// the convenience path for local dev where no mysql client is installed.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import mysql from 'mysql2/promise';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  multipleStatements: true,
});

await conn.query(sql);
const [tables] = await conn.query('SHOW TABLES');
console.log('✓ schema loaded. Tables:', tables.map(r => Object.values(r)[0]).join(', '));
await conn.end();
