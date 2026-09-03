'use strict';

// Public load board — staff manage the curated list of available loads shown
// on the marketing site. Read-only JSON is served from app.js (/loadboard).

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');
const { staffAlert } = require('../lib/notify');

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

// --- Load requests queue (first dispatcher to accept wins) ------------------
router.get('/load-requests', async (req, res) => {
  const [pending] = await pool.query(
    `SELECT *, EXTRACT(EPOCH FROM (now()-created_at))::int AS age_s
       FROM load_requests WHERE status='pending' ORDER BY created_at DESC LIMIT 100`);
  const [recent] = await pool.query(
    `SELECT *, EXTRACT(EPOCH FROM (now()-accepted_at))::int AS ago_s
       FROM load_requests WHERE status='accepted' ORDER BY accepted_at DESC LIMIT 12`);
  res.render('load-requests', { user: req.session.user, pending, recent, csrfToken: req.csrfToken(), msg: req.query.msg || null });
});

// Poll feed for the live "pop-up" — pending requests + count.
router.get('/load-requests/feed', async (req, res) => {
  try {
    const [pending] = await pool.query(
      `SELECT id, carrier_company, carrier_phone, origin, destination, rate, live_unload,
              EXTRACT(EPOCH FROM (now()-created_at))::int AS age_s
         FROM load_requests WHERE status='pending' ORDER BY created_at DESC LIMIT 100`);
    res.set('Cache-Control', 'no-store');
    res.json({ count: pending.length, pending });
  } catch (e) { res.status(500).json({ count: 0, pending: [] }); }
});

// Atomic claim: only the first dispatcher whose UPDATE flips it from 'pending'
// wins; concurrent clicks affect 0 rows and are told it's already taken.
router.post('/load-requests/:id/accept', async (req, res) => {
  const me = req.session.user;
  const back = (m) => res.redirect('/admin/load-requests?msg=' + encodeURIComponent(m));
  try {
    const [claimed] = await pool.query(
      `UPDATE load_requests SET status='accepted', accepted_by=?, accepted_by_name=?, accepted_at=now()
         WHERE id=? AND status='pending'
       RETURNING board_load_id, carrier_company, carrier_email, carrier_phone, origin, destination, rate`,
      [me.id, me.name, req.params.id]);
    if (claimed.length) {
      const r = claimed[0];
      if (r.board_load_id) {
        await pool.query("UPDATE board_loads SET status='booked', updated_at=now() WHERE id=? AND status='active'", [r.board_load_id]);
        await pool.query("UPDATE load_requests SET status='closed' WHERE board_load_id=? AND status='pending'", [r.board_load_id]);
      }
      staffAlert('Load request accepted', [
        ['Dispatcher', me.name], ['Carrier', r.carrier_company || '—'],
        ['Contact', (r.carrier_email || '') + (r.carrier_phone ? (' · ' + r.carrier_phone) : '')],
        ['Lane', (r.origin || '?') + ' → ' + (r.destination || '?')],
      ]);
      return back('✓ You got it — ' + (r.carrier_company || 'carrier') + ': ' + (r.origin || '?') + ' → ' + (r.destination || '?') + '. Reach out to confirm.');
    }
    const [[cur]] = await pool.query('SELECT accepted_by_name FROM load_requests WHERE id=?', [req.params.id]);
    return back('Already taken' + (cur && cur.accepted_by_name ? (' by ' + cur.accepted_by_name) : '') + '.');
  } catch (e) { console.error('[load-requests accept] error:', e.message); return back('Something went wrong — try again.'); }
});

module.exports = router;
