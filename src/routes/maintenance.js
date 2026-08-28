'use strict';

// Maintenance — service / repair records for trucks & trailers. Staff-only.

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const KINDS = ['service', 'repair', 'inspection', 'tire', 'other'];
const STATUSES = ['scheduled', 'in_progress', 'completed'];
const COLS = ['truck_id', 'trailer_id', 'kind', 'description', 'vendor', 'cost', 'odometer', 'service_date', 'next_due_date', 'status'];

function values(b) {
  return {
    truck_id: intOrNull(b.truck_id), trailer_id: intOrNull(b.trailer_id),
    kind: KINDS.includes(b.kind) ? b.kind : 'service', description: clip(b.description, 500), vendor: clip(b.vendor, 160),
    cost: num(b.cost), odometer: intOrNull(b.odometer), service_date: date(b.service_date) || new Date().toISOString().slice(0, 10), next_due_date: date(b.next_due_date),
    status: STATUSES.includes(b.status) ? b.status : 'completed',
  };
}
async function pickers() {
  const [trucks] = await pool.query('SELECT id, number FROM trucks WHERE active ORDER BY number');
  const [trailers] = await pool.query('SELECT id, number FROM trailers WHERE active ORDER BY number');
  return { trucks, trailers };
}

router.get('/maintenance', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const where = status ? 'WHERE m.status = ?' : '';
  const params = status ? [status] : [];
  const [rows] = await pool.query(
    `SELECT m.*, tk.number AS truck_number, tr.number AS trailer_number
       FROM maintenance_records m LEFT JOIN trucks tk ON tk.id=m.truck_id LEFT JOIN trailers tr ON tr.id=m.trailer_id
       ${where} ORDER BY m.service_date DESC, m.id DESC LIMIT 400`, params);
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('scheduled','in_progress'))::int AS open,
            COUNT(*) FILTER (WHERE next_due_date IS NOT NULL AND next_due_date <= CURRENT_DATE + 14)::int AS due_soon,
            COALESCE(SUM(cost),0) AS total_cost FROM maintenance_records`);
  res.render('maintenance', { user: req.session.user, rows, counts, filter: { status } });
});
router.get('/maintenance/new', async (req, res) => {
  const p = await pickers();
  res.render('maintenance-form', { user: req.session.user, rec: { status: 'completed', kind: 'service' }, ...p, kinds: KINDS, statuses: STATUSES, csrfToken: req.csrfToken(), isNew: true });
});
router.post('/maintenance', async (req, res) => {
  const v = values(req.body || {});
  await pool.query(`INSERT INTO maintenance_records (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map((k) => v[k]));
  res.redirect('/admin/maintenance');
});
router.get('/maintenance/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM maintenance_records WHERE id=? LIMIT 1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  const p = await pickers();
  res.render('maintenance-form', { user: req.session.user, rec: rows[0], ...p, kinds: KINDS, statuses: STATUSES, csrfToken: req.csrfToken(), isNew: false });
});
router.post('/maintenance/:id', async (req, res) => {
  const v = values(req.body || {});
  await pool.query(`UPDATE maintenance_records SET ${COLS.map((k) => k + '=?').join(', ')} WHERE id=?`, [...COLS.map((k) => v[k]), req.params.id]);
  res.redirect('/admin/maintenance');
});
router.post('/maintenance/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM maintenance_records WHERE id=?', [req.params.id]);
  res.redirect('/admin/maintenance');
});

module.exports = router;
