'use strict';

// Admin dashboard — server-rendered EJS, session-protected, individual accounts.
// Mounted at /admin.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { verifyLogin, requireLogin, requireRole, sessionUser, hashPassword, findByEmail } = require('../lib/auth');
const { carrierEmail } = require('../lib/notify');

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
  req.session = null; // cookie-session: clearing the object drops the cookie
  res.redirect('/admin/login');
});

// Everything below requires a signed-in staff member.
router.use(requireLogin);

// --- Ops dashboard (home) ---------------------------------------------------
router.get('/', async (req, res) => {
  const [[loadCounts]] = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE bc.category IN ('active','in_transit'))::int AS active,
            COUNT(*) FILTER (WHERE bc.category='in_transit')::int AS in_transit,
            COUNT(*) FILTER (WHERE bc.category='delivered')::int AS delivered,
            COALESCE(SUM(l.rate) FILTER (WHERE bc.category IN ('active','in_transit')),0) AS active_rate
       FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id`);
  const [[carrierCounts]] = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='pending')::int AS pending FROM carriers`);
  const [[fleet]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM trucks WHERE active AND in_service)::int AS trucks,
            (SELECT COUNT(*) FROM trailers WHERE active)::int AS trailers,
            (SELECT COUNT(*) FROM customers)::int AS customers,
            (SELECT COUNT(*) FROM submissions WHERE status='new')::int AS new_leads`);
  const [board] = await pool.query("SELECT id FROM boards WHERE kind='loads' LIMIT 1");
  const [columns] = await pool.query(
    `SELECT bc.id, bc.name, bc.color, (SELECT COUNT(*) FROM loads l WHERE l.column_id=bc.id)::int AS n
       FROM board_columns bc WHERE bc.board_id = ? ORDER BY bc.sort, bc.id`, [board[0] ? board[0].id : 0]);
  const [recentLoads] = await pool.query(
    `SELECT l.id, l.ref, l.customer, l.origin, l.destination, l.rate, bc.name AS col_name, bc.color AS col_color
       FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id ORDER BY l.updated_at DESC, l.id DESC LIMIT 6`);
  const [activity] = await pool.query(
    `SELECT e.body, e.kind, e.created_at, e.staff_email, l.id AS load_id, l.ref
       FROM load_events e JOIN loads l ON l.id=e.load_id ORDER BY e.created_at DESC LIMIT 8`);
  res.render('home', { user: req.session.user, loadCounts, carrierCounts, fleet, columns, recentLoads, activity });
});

// --- Leads: list + search ---------------------------------------------------
router.get('/leads', async (req, res) => {
  const type = ['contact', 'onboarding'].includes(req.query.type) ? req.query.type : '';
  const status = ['new', 'read', 'archived'].includes(req.query.status) ? req.query.status : '';
  const q = (req.query.q || '').toString().trim().slice(0, 100);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const { where, params } = buildFilter({ type, status, q });
  const [[{ total }]] = await pool.query(`SELECT COUNT(*)::int AS total FROM submissions ${where}`, params);
  const [rows] = await pool.query(
    `SELECT id, type, status, full_name, company, email, phone, created_at
       FROM submissions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
  );
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='new')::int AS new_count,
            COUNT(*) FILTER (WHERE type='onboarding')::int AS onboarding_count FROM submissions`
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
  await pool.query('UPDATE staff_users SET active = NOT active WHERE id = ?', [req.params.id]);
  res.redirect('/admin/users');
});

// --- Carriers (Phase 2 portal) ----------------------------------------------
const CARRIER_STATUSES = ['pending', 'under_review', 'needs_info', 'approved', 'rejected'];

router.get('/carriers', async (req, res) => {
  const status = CARRIER_STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = (req.query.q || '').toString().trim().slice(0, 100);
  const clauses = [];
  const params = [];
  if (status) { clauses.push('c.status = ?'); params.push(status); }
  if (q) {
    clauses.push('(c.company_name LIKE ? OR c.email LIKE ? OR c.mc_number LIKE ? OR c.contact_name LIKE ?)');
    const like = '%' + q + '%';
    params.push(like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const [rows] = await pool.query(
    `SELECT c.id, c.company_name, c.contact_name, c.email, c.mc_number, c.status, c.created_at,
            (SELECT COUNT(*) FROM carrier_documents d WHERE d.carrier_id = c.id)::int AS doc_count
       FROM carriers c ${where} ORDER BY c.created_at DESC LIMIT 200`, params
  );
  const [[counts]] = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='pending')::int AS pending,
            COUNT(*) FILTER (WHERE status='approved')::int AS approved FROM carriers`
  );
  res.render('carriers', { user: req.session.user, rows, counts, filter: { status, q } });
});

router.get('/carriers/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM carriers WHERE id = ? LIMIT 1', [req.params.id]);
  const carrier = rows[0];
  if (!carrier) return res.status(404).send('Not found');
  const [docs] = await pool.query(
    'SELECT id, doc_type, filename, mime_type, size_bytes, review, uploaded_at FROM carrier_documents WHERE carrier_id = ? ORDER BY uploaded_at DESC',
    [carrier.id]
  );
  const [drivers] = await pool.query('SELECT * FROM drivers WHERE carrier_id = ? ORDER BY active DESC, name', [carrier.id]);
  res.render('carrier', { user: req.session.user, carrier, docs, drivers, statuses: CARRIER_STATUSES, csrfToken: req.csrfToken() });
});

// Staff download of any carrier document.
router.get('/carriers/:id/documents/:docId', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT filename, mime_type, content FROM carrier_documents WHERE id = ? AND carrier_id = ? LIMIT 1',
    [req.params.docId, req.params.id]
  );
  const doc = rows[0];
  if (!doc) return res.status(404).send('Not found');
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
  res.send(doc.content);
});

router.post('/carriers/:id/documents/:docId/review', async (req, res) => {
  const review = ['pending', 'accepted', 'rejected'].includes(req.body.review) ? req.body.review : null;
  if (review) await pool.query('UPDATE carrier_documents SET review = ? WHERE id = ? AND carrier_id = ?', [review, req.params.docId, req.params.id]);
  res.redirect('/admin/carriers/' + encodeURIComponent(req.params.id));
});

router.post('/carriers/:id/status', async (req, res) => {
  const status = CARRIER_STATUSES.includes(req.body.status) ? req.body.status : null;
  const notes = (req.body.staff_notes || '').toString().slice(0, 4000);
  if (!status) return res.status(400).send('Bad status');
  const [rows] = await pool.query(
    'UPDATE carriers SET status = ?, staff_notes = ? WHERE id = ? RETURNING email, company_name', [status, notes, req.params.id]
  );
  // Tell the carrier their status moved (best-effort).
  const c = rows[0];
  if (c) {
    const label = status.replace('_', ' ');
    carrierEmail(c.email, `Your BSG Carriers onboarding — ${label}`, [
      `Hi ${c.company_name},`,
      `Your onboarding status is now: ${label}.`,
      notes ? `Note from our team: ${notes}` : 'Sign in to your carrier portal for details.',
      'Portal: ' + (process.env.PORTAL_URL || 'https://bsg-carriers-api.vercel.app/portal'),
    ]);
  }
  res.redirect('/admin/carriers/' + encodeURIComponent(req.params.id));
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
