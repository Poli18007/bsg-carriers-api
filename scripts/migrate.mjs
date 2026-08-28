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

// --- Seed the two boards, their columns, and the load labels ----------------
// Idempotent: ON CONFLICT DO NOTHING everywhere, so renames/edits made in the
// app are never overwritten on a later migrate.
async function seedBoard(name, kind, sort, columns) {
  await client.query('INSERT INTO boards (name, kind, sort) VALUES ($1,$2,$3) ON CONFLICT (kind) DO NOTHING', [name, kind, sort]);
  const { rows } = await client.query('SELECT id FROM boards WHERE kind = $1', [kind]);
  const boardId = rows[0].id;
  for (let i = 0; i < columns.length; i++) {
    const [cname, color, category] = columns[i];
    await client.query(
      'INSERT INTO board_columns (board_id, name, sort, color, category) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (board_id, name) DO NOTHING',
      [boardId, cname, i, color, category]
    );
  }
  return boardId;
}

// Brand palette is gold + black; positive states read as gold, not green.
const GOLD = '#DCB555', BLUE = '#7fb0e0', GREEN = '#DCB555', GREY = '#9a9ba3', PURPLE = '#b0a0e0';
const loadsBoard = await seedBoard('Loads', 'loads', 1, [
  ['Trucks', GREY, 'other'], ['Tendered', GOLD, 'active'], ['Ready', GOLD, 'active'],
  ['Assigned', BLUE, 'active'], ['Akal Yard', GREY, 'yard'], ['In Transit', BLUE, 'in_transit'],
  ['Delivered', GREEN, 'delivered'],
]);
await seedBoard('Trailers', 'trailers', 2, [
  ['In Transit', BLUE, 'in_transit'], ['Owner Op', GREY, 'other'], ['Lodi Yard', GREY, 'yard'],
  ['Akal Yard', GREY, 'yard'], ['San Diego', GREY, 'yard'], ['Buena Park', GREY, 'yard'],
  ['CO Run', PURPLE, 'other'], ['PA Run', PURPLE, 'other'], ['TN Exemplis', PURPLE, 'other'],
  ['NJ Exemplis', PURPLE, 'other'], ['NC Exemplis', PURPLE, 'other'], ['OH Exemplis', PURPLE, 'other'],
  ['MN Exemplis', PURPLE, 'other'], ['FL Exemplis', PURPLE, 'other'],
]);

const LABELS = [
  ['KLF Truck', '#e0a94f'], ['Owner Op', '#7fb0e0'], ['Exemplis OB', '#e6d27a'],
  ['Backhaul', '#e08aa0'], ['CA Local', '#8fb0c0'], ['Other CA OB', '#c9c9c9'],
];
for (let i = 0; i < LABELS.length; i++) {
  await client.query('INSERT INTO labels (name, color, sort) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING', [LABELS[i][0], LABELS[i][1], i]);
}

// Place any load that has no column yet onto the Loads board, mapping its old
// fixed status to the closest column.
const STATUS_TO_COLUMN = { available: 'Tendered', booked: 'Tendered', dispatched: 'Assigned', in_transit: 'In Transit', delivered: 'Delivered', invoiced: 'Delivered', paid: 'Delivered', cancelled: 'Tendered' };
const { rows: cols } = await client.query('SELECT id, name FROM board_columns WHERE board_id = $1', [loadsBoard]);
const colByName = Object.fromEntries(cols.map((c) => [c.name, c.id]));
for (const [status, colName] of Object.entries(STATUS_TO_COLUMN)) {
  await client.query('UPDATE loads SET column_id = $1 WHERE column_id IS NULL AND status = $2', [colByName[colName], status]);
}
// Retire the old green seed colors (brand is gold + black). Only touches rows
// still on the original green defaults — a color a user picked is left alone.
await client.query("UPDATE board_columns SET color = '#DCB555' WHERE color = '#4caf7d'");
await client.query("UPDATE labels SET color = '#8fb0c0' WHERE color = '#7fd0a0'");
console.log('✓ boards, columns and labels seeded');

const [{ rows: tables }] = [await client.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
)];
console.log('tables:', tables.map((r) => r.table_name).join(', '));

await client.end();
