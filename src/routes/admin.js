'use strict';

// Admin dashboard — server-rendered EJS, session-protected, individual accounts.
// Mounted at /admin.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { verifyLogin, requireLogin, requireRole, sessionUser, hashPassword, findByEmail } = require('../lib/auth');

const router = express.Router();

const PAGE_SIZE = 25;

// Throttle login attempts to blunt password guessing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Wait a few minutes and try again.',
});

// --- Auth -------------------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin');
  res.render('login', { error: null, csrfToken: req.csrfToken() });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const user = await verifyLogin(email, password);
    if (!user) return res.status(401).render('login', { error: 'Wrong email or password.', csrfToken: req.csrfToken() });
    req.session.user = sessionUser(user);
    res.redirect('/admin');
  } catch (err) {
    console.error('[admin] login error:', err.message);
    res.status(500).render('login', { error: 'Something went wrong. Try again.', csrfToken: req.csrfToken() });
  }
});

router.post('/logout', requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Everything below requires a signed-in staff member.
router.use(requireLogin);

// --- Dashboard: list + search ----------------------------------------------
router.get('/', async (req, res) => {
  const type = ['contact', 'onboarding'].includes(req.query.type) ? req.query.type : '';
  const status = ['new', 'read', 'archived'].includes(req.query.status) ? req.query.status : '';
  const q = (req.query.q || '').toString().trim().slice(0, 100);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const { where, params } = buildFilter({ type, status, q });
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM submissions ${where}`, params);
  const [rows] = await pool.query(
    `SELECT id, type, status, full_name, company, email, phone, created_at
       FROM submissions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
  );
  const [[counts]] = await pool.query(
    `SELECT SUM(status='new') AS new_count, SUM(type='onboarding') AS onboarding_count FROM submissions`
  );

  res.render('dashboard', {
    user: req.session.user, rows, total, page, pageSize: PAGE_SIZE,
    filter: { type, status, q }, counts, qs: req.originalUrl,
  });
});

// --- One submission ---------------------------------------------------------
router.get('/leads/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM submissions WHERE id = ? LIMIT 1', [req.params.id]);
  const sub = rows[0];
  if (!sub) return res.status(404).send('Not found');
  // Auto-mark a `new` lead as `read` when a staff member opens it.
  if (sub.status === 'new') {
    await pool.query('UPDATE submissions SET status = ? WHERE id = ?', ['read', sub.id]);
    sub.status = 'read';
  }
  const data = typeof sub.data === 'string' ? safeJson(sub.data) : sub.data;
  res.render('lead', { user: req.session.user, sub, data, csrfToken: req.csrfToken() });
});

router.post('/leads/:id/status', async (req, res) => {
  const status = ['new', 'read', 'archived'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).send('Bad status');
  await pool.query('UPDATE submissions SET status = ? WHERE id = ?', [status, req.params.id]);
  res.redirect('/admin/leads/' + encodeURIComponent(req.params.id));
});

// --- CSV export -------------------------------------------------------------
router.get('/leads.csv', async (req, res) => {
  const type = ['contact', 'onboarding'].includes(req.query.type) ? req.query.type : '';
  const status = ['new', 'read', 'archived'].includes(req.query.status) ? req.query.status : '';
  const q = (req.query.q || '').toString().trim().slice(0, 100);
  const { where, params } = buildFilter({ type, status, q });
  const [rows] = await pool.query(
    `SELECT id, type, status, created_at, full_name, company, email, phone,
            mc_number, dot_number, equipment, message
       FROM submissions ${where} ORDER BY created_at DESC LIMIT 5000`, params
  );
  const cols = ['id', 'type', 'status', 'created_at', 'full_name', 'company', 'email',
    'phone', 'mc_number', 'dot_number', 'equipment', 'message'];
  const csv = [cols.join(',')]
    .concat(rows.map(r => cols.map(k => csvCell(r[k])).join(',')))
    .join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bsg-leads-${today()}.csv"`);
  res.send(csv);
});

// --- Staff user management (admin role only) --------------------------------
router.get('/users', requireRole('admin'), async (req, res) => {
  const [users] = await pool.query(
    'SELECT id, email, name, role, active, created_at, last_login FROM staff_users ORDER BY created_at'
  );
  res.render('users', { user: req.session.user, users, csrfToken: req.csrfToken(), notice: req.query.notice || null, error: null });
});

router.post('/users', requireRole('admin'), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 160);
  const role = req.body.role === 'admin' ? 'admin' : 'staff';
  const password = String(req.body.password || '');
  try {
    if (!email || !name || password.length < 10) {
      const [users] = await pool.query('SELECT id, email, name, role, active, created_at, last_login FROM staff_users ORDER BY created_at');
      return res.status(400).render('users', { user: req.session.user, users, csrfToken: req.csrfToken(), notice: null, error: 'Name, email and a 10+ character password are required.' });
    }
    if (await findByEmail(email)) {
      const [users] = await pool.query('SELECT id, email, name, role, active, created_at, last_login FROM staff_users ORDER BY created_at');
      return res.status(400).render('users', { user: req.session.user, users, csrfToken: req.csrfToken(), notice: null, error: 'That email already has an account.' });
    }
    await pool.query('INSERT INTO staff_users (email, name, password_hash, role) VALUES (?,?,?,?)',
      [email, name, await hashPassword(password), role]);
    res.redirect('/admin/users?notice=' + encodeURIComponent('Added ' + email));
  } catch (err) {
    console.error('[admin] add user error:', err.message);
    res.status(500).send('Could not add the user.');
  }
});

router.post('/users/:id/toggle', requireRole('admin'), async (req, res) => {
  // Never let an admin disable themselves and get locked out.
  if (Number(req.params.id) === req.session.user.id) return res.redirect('/admin/users');
  await pool.query('UPDATE staff_users SET active = 1 - active WHERE id = ?', [req.params.id]);
  res.redirect('/admin/users');
});

// --- helpers ----------------------------------------------------------------
function buildFilter({ type, status, q }) {
  const clauses = [];
  const params = [];
  if (type) { clauses.push('type = ?'); params.push(type); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (q) {
    clauses.push('(full_name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ? OR message LIKE ?)');
    const like = '%' + q + '%';
    params.push(like, like, like, like, like);
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}
function csvCell(v) {
  if (v == null) return '';
  const s = String(v instanceof Date ? v.toISOString() : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function today() { return new Date().toISOString().slice(0, 10); }

module.exports = router;
