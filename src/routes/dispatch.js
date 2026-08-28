'use strict';

// Dispatch operations (Phase 3) — brokers, loads and the dispatch board.
// Staff-only; mounted under /admin (shares the session + CSRF middleware).

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

const LOAD_STATUSES = ['available', 'booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled'];
// Statuses that count as "active" work on the board's headline tiles.
const ACTIVE = ['booked', 'dispatched', 'in_transit'];

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// ---- Brokers ---------------------------------------------------------------
router.get('/brokers', async (req, res) => {
  const q = (req.query.q || '').toString().trim().slice(0, 100);
  const where = q ? 'WHERE name LIKE ? OR contact_name LIKE ? OR mc_number LIKE ?' : '';
  const params = q ? ['%' + q + '%', '%' + q + '%', '%' + q + '%'] : [];
  const [rows] = await pool.query(
    `SELECT b.*, (SELECT COUNT(*) FROM loads l WHERE l.broker_id = b.id)::int AS load_count
       FROM brokers b ${where} ORDER BY b.name LIMIT 300`, params
  );
  res.render('brokers', { user: req.session.user, rows, q });
});

router.get('/brokers/new', (req, res) => {
  res.render('broker-form', { user: req.session.user, broker: {}, csrfToken: req.csrfToken(), isNew: true });
});

router.post('/brokers', async (req, res) => {
  const b = req.body || {};
  if (!clip(b.name, 200)) return res.status(400).render('broker-form', { user: req.session.user, broker: b, csrfToken: req.csrfToken(), isNew: true, error: 'Broker name is required.' });
  await pool.query(
    'INSERT INTO brokers (name, contact_name, phone, email, mc_number, notes) VALUES (?,?,?,?,?,?)',
    [clip(b.name, 200), clip(b.contact_name, 160), clip(b.phone, 60), clip(b.email, 200), clip(b.mc_number, 40), clip(b.notes, 2000)]
  );
  res.redirect('/admin/brokers');
});

router.get('/brokers/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM brokers WHERE id = ? LIMIT 1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  res.render('broker-form', { user: req.session.user, broker: rows[0], csrfToken: req.csrfToken(), isNew: false });
});

router.post('/brokers/:id', async (req, res) => {
  const b = req.body || {};
  await pool.query(
    'UPDATE brokers SET name = ?, contact_name = ?, phone = ?, email = ?, mc_number = ?, notes = ? WHERE id = ?',
    [clip(b.name, 200) || 'Unnamed broker', clip(b.contact_name, 160), clip(b.phone, 60), clip(b.email, 200), clip(b.mc_number, 40), clip(b.notes, 2000), req.params.id]
  );
  res.redirect('/admin/brokers');
});

// ---- Loads / dispatch board ------------------------------------------------
router.get('/loads', async (req, res) => {
  const status = LOAD_STATUSES.includes(req.query.status) ? req.query.status : '';
  const carrier = req.query.carrier ? parseInt(req.query.carrier, 10) : null;
  const q = (req.query.q || '').toString().trim().slice(0, 100);

  const clauses = [];
  const params = [];
  if (status) { clauses.push('l.status = ?'); params.push(status); }
  else { clauses.push("l.status <> 'cancelled'"); }         // board hides cancelled unless asked
  if (carrier) { clauses.push('l.carrier_id = ?'); params.push(carrier); }
  if (q) {
    clauses.push('(l.ref LIKE ? OR l.origin LIKE ? OR l.destination LIKE ? OR b.name LIKE ? OR c.company_name LIKE ?)');
    const like = '%' + q + '%';
    params.push(like, like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const [rows] = await pool.query(
    `SELECT l.*, b.name AS broker_name, c.company_name AS carrier_name
       FROM loads l
       LEFT JOIN brokers b ON b.id = l.broker_id
       LEFT JOIN carriers c ON c.id = l.carrier_id
       ${where} ORDER BY l.pickup_date NULLS LAST, l.id DESC LIMIT 300`, params
  );
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = ANY(?))::int AS active,
            COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
            COALESCE(SUM(rate) FILTER (WHERE status = ANY(?)),0) AS active_rate
       FROM loads`, [ACTIVE, ACTIVE]
  );
  res.render('loads', { user: req.session.user, rows, counts, filter: { status, carrier, q }, statuses: LOAD_STATUSES });
});

async function formData() {
  const [brokers] = await pool.query('SELECT id, name FROM brokers ORDER BY name');
  const [carriers] = await pool.query("SELECT id, company_name FROM carriers WHERE status <> 'rejected' ORDER BY company_name");
  return { brokers, carriers };
}

router.get('/loads/new', async (req, res) => {
  const { brokers, carriers } = await formData();
  res.render('load-form', { user: req.session.user, load: { status: 'booked' }, brokers, carriers, statuses: LOAD_STATUSES, csrfToken: req.csrfToken(), isNew: true });
});

function loadValues(b) {
  return [
    clip(b.ref, 60), b.broker_id ? parseInt(b.broker_id, 10) : null, b.carrier_id ? parseInt(b.carrier_id, 10) : null,
    clip(b.origin, 160), clip(b.destination, 160), date(b.pickup_date), date(b.delivery_date),
    clip(b.commodity, 160), clip(b.weight, 40), clip(b.equipment, 80), num(b.rate),
    LOAD_STATUSES.includes(b.status) ? b.status : 'booked', clip(b.notes, 4000),
  ];
}

router.post('/loads', async (req, res) => {
  const v = loadValues(req.body || {});
  await pool.query(
    `INSERT INTO loads (ref, broker_id, carrier_id, origin, destination, pickup_date, delivery_date,
       commodity, weight, equipment, rate, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    v
  );
  res.redirect('/admin/loads');
});

router.get('/loads/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM loads WHERE id = ? LIMIT 1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  const { brokers, carriers } = await formData();
  res.render('load-form', { user: req.session.user, load: rows[0], brokers, carriers, statuses: LOAD_STATUSES, csrfToken: req.csrfToken(), isNew: false });
});

router.post('/loads/:id', async (req, res) => {
  const v = loadValues(req.body || {});
  await pool.query(
    `UPDATE loads SET ref=?, broker_id=?, carrier_id=?, origin=?, destination=?, pickup_date=?, delivery_date=?,
       commodity=?, weight=?, equipment=?, rate=?, status=?, notes=?, updated_at=now() WHERE id=?`,
    [...v, req.params.id]
  );
  res.redirect('/admin/loads/' + encodeURIComponent(req.params.id));
});

// Quick status change from the board.
router.post('/loads/:id/status', async (req, res) => {
  const status = LOAD_STATUSES.includes(req.body.status) ? req.body.status : null;
  if (status) await pool.query('UPDATE loads SET status = ?, updated_at = now() WHERE id = ?', [status, req.params.id]);
  res.redirect(req.get('referer') && req.get('referer').includes('/loads/') ? req.get('referer') : '/admin/loads');
});

module.exports = router;
