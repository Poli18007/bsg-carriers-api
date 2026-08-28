'use strict';

// Admin authentication: individual staff accounts, bcryptjs password hashes,
// DB-backed sessions. bcryptjs is pure JS so it installs cleanly on shared
// hosting with no compiler.

const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

async function findByEmail(email) {
  const [rows] = await pool.query(
    'SELECT * FROM staff_users WHERE email = ? LIMIT 1', [String(email).trim().toLowerCase()]
  );
  return rows[0] || null;
}

// Returns the user on success, or null. Constant-ish work either way: always run
// a bcrypt compare (against a dummy hash when the user is absent) so a missing
// account and a wrong password take the same time and cannot be distinguished.
const DUMMY = '$2a$12$0000000000000000000000000000000000000000000000000000';
async function verifyLogin(email, plain) {
  const user = await findByEmail(email);
  const hash = user && user.active ? user.password_hash : DUMMY;
  const match = await bcrypt.compare(String(plain || ''), hash);
  if (!user || !user.active || !match) return null;
  pool.query('UPDATE staff_users SET last_login = NOW() WHERE id = ?', [user.id]).catch(() => {});
  return user;
}

// Middleware: require any logged-in staff member.
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }
  return res.redirect('/admin/login');
}

// Middleware factory: require a specific role (e.g. 'admin' for user management).
function requireRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.user && req.session.user.role === role) return next();
    return res.status(403).send('Forbidden — this action needs the ' + role + ' role.');
  };
}

// The safe subset of a user record to keep in the session.
function sessionUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

module.exports = { hashPassword, verifyLogin, findByEmail, requireLogin, requireRole, sessionUser };
