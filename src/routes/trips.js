'use strict';

// Trips — a truck/driver's route covering one or more loads. A trip is a
// planning + tracking layer over loads: its waypoints and delivery timeline are
// built from the pickups/deliveries of the loads assigned to it (ordered by
// stop_seq). Staff-only, mounted under /admin.

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const STATUSES = ['planned', 'dispatched', 'in_transit', 'completed', 'cancelled'];
const ACTIVE = ['planned', 'dispatched', 'in_transit'];

function tripValues(b) {
  return {
    name: clip(b.name, 120), truck_id: intOrNull(b.truck_id), driver_id: intOrNull(b.driver_id),
    carrier_id: intOrNull(b.carrier_id), status: STATUSES.includes(b.status) ? b.status : 'planned',
    start_date: date(b.start_date), end_date: date(b.end_date), notes: clip(b.notes, 2000),
  };
}
const TRIP_COLS = ['name', 'truck_id', 'driver_id', 'carrier_id', 'status', 'start_date', 'end_date', 'notes'];

async function pickers() {
  const [trucks] = await pool.query('SELECT id, number FROM trucks WHERE active ORDER BY number');
  const [drivers] = await pool.query('SELECT d.id, d.name, c.company_name FROM drivers d JOIN carriers c ON c.id=d.carrier_id WHERE d.active ORDER BY c.company_name, d.name');
  const [carriers] = await pool.query("SELECT id, company_name FROM carriers WHERE status <> 'rejected' ORDER BY company_name");
  return { trucks, drivers, carriers };
}

// ---- List ------------------------------------------------------------------
router.get('/trips', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const where = status ? 'WHERE t.status = ?' : '';
  const params = status ? [status] : [];
  const [rows] = await pool.query(
    `SELECT t.*, tk.number AS truck_number, d.name AS driver_name, c.company_name AS carrier_name,
            (SELECT COUNT(*) FROM loads l WHERE l.trip_id=t.id)::int AS load_count,
            (SELECT COALESCE(SUM(l.rate),0) FROM loads l WHERE l.trip_id=t.id) AS revenue
       FROM trips t
       LEFT JOIN trucks tk ON tk.id=t.truck_id LEFT JOIN drivers d ON d.id=t.driver_id
       LEFT JOIN carriers c ON c.id=t.carrier_id ${where} ORDER BY t.seq DESC LIMIT 300`, params);
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('planned','dispatched','in_transit'))::int AS active,
            COUNT(*) FILTER (WHERE status='completed')::int AS completed FROM trips`);
  res.render('trips', { user: req.session.user, rows, counts, filter: { status } });
});

// ---- New -------------------------------------------------------------------
router.get('/trips/new', async (req, res) => {
  const p = await pickers();
  res.render('trip-form', { user: req.session.user, trip: { status: 'planned' }, ...p, statuses: STATUSES, csrfToken: req.csrfToken(), isNew: true });
});
router.post('/trips', async (req, res) => {
  const v = tripValues(req.body || {});
  const [[seqRow]] = await pool.query('SELECT COALESCE(MAX(seq),100)+1 AS seq FROM trips');
  const [rows] = await pool.query(
    `INSERT INTO trips (seq, ${TRIP_COLS.join(',')}) VALUES (?, ${TRIP_COLS.map(() => '?').join(',')}) RETURNING id`,
    [seqRow.seq, ...TRIP_COLS.map((k) => v[k])]);
  res.redirect('/admin/trips/' + rows[0].id);
});

// ---- Detail ----------------------------------------------------------------
router.get('/trips/:id', async (req, res) => {
  const [[trip]] = await pool.query(
    `SELECT t.*, tk.number AS truck_number, d.name AS driver_name, d.phone AS driver_phone, c.company_name AS carrier_name
       FROM trips t LEFT JOIN trucks tk ON tk.id=t.truck_id LEFT JOIN drivers d ON d.id=t.driver_id
       LEFT JOIN carriers c ON c.id=t.carrier_id WHERE t.id=? LIMIT 1`, [req.params.id]);
  if (!trip) return res.status(404).send('Not found');
  const [loads] = await pool.query(
    `SELECT l.*, bc.name AS col_name, bc.color AS col_color
       FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id
       WHERE l.trip_id=? ORDER BY l.stop_seq NULLS LAST, l.pickup_date NULLS LAST, l.id`, [req.params.id]);
  // Loads not yet on any trip — candidates to add.
  const [available] = await pool.query(
    `SELECT id, ref, origin, destination FROM loads WHERE trip_id IS NULL ORDER BY id DESC LIMIT 200`);
  const [[agg]] = await pool.query(
    'SELECT COALESCE(SUM(rate),0) AS revenue, COALESCE(SUM(miles),0)::int AS miles FROM loads WHERE trip_id=?', [req.params.id]);
  const [events] = await pool.query(
    `SELECT e.*, l.ref FROM load_events e JOIN loads l ON l.id=e.load_id WHERE l.trip_id=? ORDER BY e.created_at DESC LIMIT 60`, [req.params.id]);
  const p = await pickers();
  res.render('trip', { user: req.session.user, trip, loads, available, agg, events, ...p, statuses: STATUSES, csrfToken: req.csrfToken() });
});

router.post('/trips/:id', async (req, res) => {
  const v = tripValues(req.body || {});
  await pool.query(`UPDATE trips SET ${TRIP_COLS.map((k) => k + '=?').join(', ')}, updated_at=now() WHERE id=?`,
    [...TRIP_COLS.map((k) => v[k]), req.params.id]);
  res.redirect('/admin/trips/' + encodeURIComponent(req.params.id));
});
router.post('/trips/:id/status', async (req, res) => {
  const status = STATUSES.includes(req.body.status) ? req.body.status : null;
  if (status) await pool.query('UPDATE trips SET status=?, updated_at=now() WHERE id=?', [status, req.params.id]);
  res.redirect('/admin/trips/' + encodeURIComponent(req.params.id));
});

// Add a load to the trip (appended to the end of the route).
router.post('/trips/:id/loads', async (req, res) => {
  const loadId = intOrNull(req.body.load_id);
  if (loadId) {
    const [[m]] = await pool.query('SELECT COALESCE(MAX(stop_seq),0)+1 AS n FROM loads WHERE trip_id=?', [req.params.id]);
    await pool.query('UPDATE loads SET trip_id=?, stop_seq=? WHERE id=?', [req.params.id, m.n, loadId]);
  }
  res.redirect('/admin/trips/' + encodeURIComponent(req.params.id));
});
router.post('/trips/:id/loads/:loadId/remove', async (req, res) => {
  await pool.query('UPDATE loads SET trip_id=NULL, stop_seq=NULL WHERE id=? AND trip_id=?', [req.params.loadId, req.params.id]);
  res.redirect('/admin/trips/' + encodeURIComponent(req.params.id));
});
// Reorder a load within the trip by swapping stop_seq with its neighbour.
router.post('/trips/:id/loads/:loadId/move', async (req, res) => {
  const dir = req.body.dir === 'up' ? 'up' : 'down';
  const [[cur]] = await pool.query('SELECT id, stop_seq FROM loads WHERE id=? AND trip_id=?', [req.params.loadId, req.params.id]);
  if (cur && cur.stop_seq != null) {
    const cmp = dir === 'up' ? '<' : '>';
    const order = dir === 'up' ? 'DESC' : 'ASC';
    const [[nb]] = await pool.query(`SELECT id, stop_seq FROM loads WHERE trip_id=? AND stop_seq ${cmp} ? ORDER BY stop_seq ${order} LIMIT 1`, [req.params.id, cur.stop_seq]);
    if (nb) {
      await pool.query('UPDATE loads SET stop_seq=? WHERE id=?', [nb.stop_seq, cur.id]);
      await pool.query('UPDATE loads SET stop_seq=? WHERE id=?', [cur.stop_seq, nb.id]);
    }
  }
  res.redirect('/admin/trips/' + encodeURIComponent(req.params.id));
});

router.post('/trips/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM trips WHERE id=?', [req.params.id]); // loads.trip_id -> NULL via FK
  res.redirect('/admin/trips');
});

module.exports = router;
