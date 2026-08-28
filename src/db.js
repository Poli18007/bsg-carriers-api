'use strict';

// PostgreSQL connection pool with a thin mysql2-compatibility shim.
//
// The app was written against mysql2/promise (`?` placeholders, `const [rows] =
// await pool.query(...)`). Rather than rewrite every call site, this wrapper:
//   * rewrites `?` placeholders to Postgres `$1, $2, …`
//   * returns `[rows, fields]` so `const [rows] = await pool.query(sql, params)`
//     keeps working
// INSERTs that need the new id use `RETURNING id` and read rows[0].id (see the
// route code), which is Postgres-native.

const { Pool } = require('pg');

// Neon and most hosted Postgres require TLS. `rejectUnauthorized:false` accepts
// their managed certs without bundling a CA. DATABASE_URL is provided by the
// host (Vercel/Neon) or .env locally.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL || 3),           // small — serverless invocations are short
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

// `?` -> `$n`. Naive on purpose: our SQL never contains a literal `?`, only
// placeholders, so a positional replace is safe and cheap.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function query(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return [res.rows, res.fields];
}

async function ping() {
  const res = await pool.query('SELECT 1');
  return res.rowCount;
}

// `pool` exposes the mysql2-shaped `.query`; `pg` is the raw pg Pool if needed.
module.exports = { pool: { query }, pg: pool, ping };
