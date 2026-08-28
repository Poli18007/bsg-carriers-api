'use strict';

// Single shared MySQL connection pool, configured from the environment.
//
// A pool (not a single connection) because Passenger may run a few request
// handlers concurrently, and a dropped idle connection on shared hosting should
// not take the app down — the pool reconnects transparently.

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL || 5), // modest — shared hosting caps connections
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
});

// Fail fast with a clear message if the DB is unreachable at startup, rather
// than surfacing a cryptic error on the first request.
async function ping() {
  const conn = await pool.getConnection();
  try { await conn.query('SELECT 1'); } finally { conn.release(); }
}

module.exports = { pool, ping };
