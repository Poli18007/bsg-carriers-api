'use strict';

// Public load board — staff manage the curated list of available loads shown
// on the marketing site. Read-only JSON is served from app.js (/loadboard).

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const STATUSES = ['active', 'booked', 'hidden'];
const COLS = ['origin', 'destination', 'rate', 'equipment', 'miles', 'weight', 'pickup_date', 'notes', 'live_unload', 'status', 'sort'];

function values(b) {
  return {
    origin: clip(b.origin, 160), destination: clip(b.destination, 160),
    rate: num(b.rate), equipment: clip(b.equipment, 60), miles: intOrNull(b.miles),
    weight: clip(b.weight, 60), pickup_date: date(b.pickup_date), notes: clip(b.notes, 300),
    live_unload: b.live_unload === '1' || b.live_unload === 'on', status: STATUSES.includes(b.status) ? b.status : 'active',
    sort: intOrNull(b.sort) || 0,
  };
}

router.get('/loadboard', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM board_loads ORDER BY (status=\'active\') DESC, sort, created_at DESC');
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='active')::int AS active,
            COUNT(*) FILTER (WHERE status='booked')::int AS booked,
            COUNT(*)::int AS total FROM board_loads`);
  res.render('loadboard', { user: req.session.user, rows, counts });
});

router.get('/loadboard/new', (req, res) => {
  res.render('loadboard-form', { user: req.session.user, rec: { status: 'active', live_unload: false }, statuses: STATUSES, csrfToken: req.csrfToken(), isNew: true });
});
router.post('/loadboard', async (req, res) => {
  const v = values(req.body || {});
  if (!v.origin || !v.destination) return res.redirect('/admin/loadboard/new');
  await pool.query(`INSERT INTO board_loads (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map((k) => v[k]));
  res.redirect('/admin/loadboard');
});
router.get('/loadboard/:id/edit', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM board_loads WHERE id=? LIMIT 1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  res.render('loadboard-form', { user: req.session.user, rec: rows[0], statuses: STATUSES, csrfToken: req.csrfToken(), isNew: false });
});
router.post('/loadboard/:id', async (req, res) => {
  const v = values(req.body || {});
  await pool.query(`UPDATE board_loads SET ${COLS.map((k) => k + '=?').join(', ')}, updated_at=now() WHERE id=?`, [...COLS.map((k) => v[k]), req.params.id]);
  res.redirect('/admin/loadboard');
});
router.post('/loadboard/:id/status', async (req, res) => {
  const status = STATUSES.includes(req.body.status) ? req.body.status : null;
  if (status) await pool.query('UPDATE board_loads SET status=?, updated_at=now() WHERE id=?', [status, req.params.id]);
  res.redirect('/admin/loadboard');
});
router.post('/loadboard/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM board_loads WHERE id=?', [req.params.id]);
  res.redirect('/admin/loadboard');
});

module.exports = router;
