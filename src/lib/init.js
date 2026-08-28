'use strict';

// One-time, idempotent database bootstrap that runs on every app start.
//
// Shared PaaS hosting gives no shell to run migrations by hand, so the app
// installs itself: it applies schema.sql (every statement is IF NOT EXISTS) and
// ensures the first admin account exists from env vars. Safe to run on every
// boot — nothing is dropped or duplicated.

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function initDatabase() {
  const schemaPath = path.join(__dirname, '..', '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // A dedicated connection with multipleStatements just for the schema — the
  // request-serving pool keeps that off for safety. Our own SQL, not user input.
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  try {
    await conn.query(sql);
    console.log('[init] schema applied');

    // Seed / refresh the first admin from env. Upsert means "forgot the
    // password?" is fixed by changing ADMIN_PASSWORD and restarting.
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const name = (process.env.ADMIN_NAME || 'BSG Admin').trim();
    const password = process.env.ADMIN_PASSWORD || '';
    if (email && password) {
      if (password.length < 8) {
        console.warn('[init] ADMIN_PASSWORD too short — admin not seeded');
      } else {
        const hash = await bcrypt.hash(password, 12);
        await conn.query(
          `INSERT INTO staff_users (email, name, password_hash, role, active)
           VALUES (?,?,?,'admin',1)
           ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash), role='admin', active=1`,
          [email, name, hash]
        );
        console.log('[init] admin account ensured:', email);
      }
    } else {
      console.log('[init] no ADMIN_EMAIL/ADMIN_PASSWORD set — skipping admin seed');
    }
  } finally {
    await conn.end();
  }
}

module.exports = { initDatabase };
