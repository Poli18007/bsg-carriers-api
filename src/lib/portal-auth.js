'use strict';

// Carrier portal authentication — a separate audience from staff_users, with
// its own table and its own session key (req.session.carrier). Reuses bcryptjs.

const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

async function findByEmail(email) {
  const [rows] = await pool.query(
    'SELECT * FROM carriers WHERE email = ? LIMIT 1', [String(email).trim().toLowerCase()]
  );
  return rows[0] || null;
}

async function getCarrier(id) {
  const [rows] = await pool.query('SELECT * FROM carriers WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

// Same constant-time-ish shape as staff auth: always run a compare so a missing
// account and a wrong password are indistinguishable by timing.
const DUMMY = '$2a$12$0000000000000000000000000000000000000000000000000000';
async function verifyLogin(email, plain) {
  const c = await findByEmail(email);
  const hash = c ? c.password_hash : DUMMY;
  const match = await bcrypt.compare(String(plain || ''), hash);
  if (!c || !match) return null;
  pool.query('UPDATE carriers SET last_login = NOW() WHERE id = ?', [c.id]).catch(() => {});
  return c;
}

// Require a signed-in carrier for portal pages.
function requireCarrier(req, res, next) {
  if (req.session && req.session.carrier) return next();
  return res.redirect('/portal/login');
}

// Safe subset kept in the session cookie.
function sessionCarrier(c) {
  return { id: c.id, email: c.email, company_name: c.company_name };
}

module.exports = { hashPassword, verifyLogin, findByEmail, getCarrier, requireCarrier, sessionCarrier };
