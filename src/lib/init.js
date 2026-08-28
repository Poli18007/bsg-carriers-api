'use strict';

// Idempotent database bootstrap: apply schema.sql and ensure the first admin
// exists. On serverless this is NOT run per-request — it runs once via
// scripts/migrate.mjs (and on local dev at startup). Safe to run repeatedly.

const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { pg } = require('../db');

async function initDatabase() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');

  // node-postgres runs multiple semicolon-separated statements in one call when
  // there are no bound parameters (simple query protocol) — exactly what a
  // schema file needs.
  await pg.query(sql);
  console.log('[init] schema applied');

  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const name = (process.env.ADMIN_NAME || 'BSG Admin').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (email && password) {
    if (password.length < 8) {
      console.warn('[init] ADMIN_PASSWORD too short — admin not seeded');
    } else {
      const hash = await bcrypt.hash(password, 12);
      await pg.query(
        `INSERT INTO staff_users (email, name, password_hash, role, active)
         VALUES ($1,$2,$3,'admin',true)
         ON CONFLICT (email) DO UPDATE
           SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = 'admin', active = true`,
        [email, name, hash]
      );
      console.log('[init] admin account ensured:', email);
    }
  } else {
    console.log('[init] no ADMIN_EMAIL/ADMIN_PASSWORD set — skipping admin seed');
  }
}

module.exports = { initDatabase };
