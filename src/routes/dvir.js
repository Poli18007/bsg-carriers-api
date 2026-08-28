'use strict';

// DVIR — driver vehicle inspection reports (pre-trip / post-trip). A safety
// checklist a driver completes before/after a run; defects flag a unit for
// maintenance. Staff-only, mounted under /admin.

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const KINDS = ['pre_trip', 'post_trip'];
const STATUSES = ['draft', 'submitted', 'reviewed', 'cleared'];

// The standard component checklist a driver inspects.
const CHECKLIST = [
  'Brakes', 'Parking brake', 'Steering', 'Lights & reflectors', 'Tires', 'Wheels & rims',
  'Horn', 'Windshield & wipers', 'Mirrors', 'Coupling devices', 'Emergency equipment',
  'Fluid levels', 'Air lines & hoses', 'Suspension', 'Exhaust', 'Frame & body',
  'Trailer doors', 'Load securement',
];

async function pickers() {
  const [trucks] = await pool.query('SELECT id, number FROM trucks WHERE active ORDER BY number');
  const [trailers] = await pool.query('SELECT id, number FROM trailers WHERE active ORDER BY number');
  const [drivers] = await pool.query('SELECT d.id, d.name, c.company_name FROM drivers d JOIN carriers c ON c.id=d.carrier_id WHERE d.active ORDER BY c.company_name, d.name');
  const [trips] = await pool.query("SELECT id, seq, name FROM trips WHERE status <> 'completed' AND status <> 'cancelled' ORDER BY seq DESC");
  return { trucks, trailers, drivers, trips };
}
const defectCount = (s) => (s ? s.split('\n').filter((x) => x.trim()).length : 0);

// ---- List ------------------------------------------------------------------
router.get('/dvir', async (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : '';
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = (req.query.q || '').toString().trim().slice(0, 80);
  const clauses = [], params = [];
  if (kind) { clauses.push('r.kind = ?'); params.push(kind); }
  if (status) { clauses.push('r.status = ?'); params.push(status); }
  if (q) { clauses.push('(tk.number LIKE ? OR d.name LIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const [rows] = await pool.query(
    `SELECT r.*, tk.number AS truck_number, d.name AS driver_name
       FROM dvir_reports r LEFT JOIN trucks tk ON tk.id=r.truck_id LEFT JOIN drivers d ON d.id=r.driver_id
       ${where} ORDER BY r.inspected_at DESC LIMIT 300`, params);
  rows.forEach((r) => { r.defects = defectCount(r.defect_items); });
  const [[counts]] = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE defect_items IS NOT NULL AND defect_items <> '')::int AS with_defects,
            COUNT(*) FILTER (WHERE status IN ('draft','submitted'))::int AS open FROM dvir_reports`);
  res.render('dvir', { user: req.session.user, rows, counts, filter: { kind, status, q } });
});

// ---- New -------------------------------------------------------------------
router.get('/dvir/new', async (req, res) => {
  const p = await pickers();
  res.render('dvir-form', { user: req.session.user, report: { kind: 'pre_trip', satisfactory: true }, checklist: CHECKLIST, defects: [], ...p, statuses: STATUSES, csrfToken: req.csrfToken(), isNew: true });
});
router.post('/dvir', async (req, res) => {
  const b = req.body || {};
  const defects = [].concat(b.defect || []).map((x) => String(x).slice(0, 60)).filter(Boolean);
  // Any defect means the vehicle isn't satisfactory; with none, honour the driver's declaration.
  const satisfactory = defects.length ? false : (b.satisfactory !== '0');
  const [rows] = await pool.query(
    `INSERT INTO dvir_reports (kind, truck_id, trailer_id, driver_id, trip_id, odometer, location, defect_items, remarks, satisfactory, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [KINDS.includes(b.kind) ? b.kind : 'pre_trip', intOrNull(b.truck_id), intOrNull(b.trailer_id), intOrNull(b.driver_id),
     intOrNull(b.trip_id), intOrNull(b.odometer), clip(b.location, 160), defects.join('\n') || null, clip(b.remarks, 2000),
     satisfactory, STATUSES.includes(b.status) ? b.status : 'submitted']);
  res.redirect('/admin/dvir/' + rows[0].id);
});

// ---- Detail ----------------------------------------------------------------
router.get('/dvir/:id', async (req, res) => {
  const [[report]] = await pool.query(
    `SELECT r.*, tk.number AS truck_number, tr.number AS trailer_number, d.name AS driver_name, t.seq AS trip_seq
       FROM dvir_reports r LEFT JOIN trucks tk ON tk.id=r.truck_id LEFT JOIN trailers tr ON tr.id=r.trailer_id
       LEFT JOIN drivers d ON d.id=r.driver_id LEFT JOIN trips t ON t.id=r.trip_id WHERE r.id=? LIMIT 1`, [req.params.id]);
  if (!report) return res.status(404).send('Not found');
  const defects = report.defect_items ? report.defect_items.split('\n').filter((x) => x.trim()) : [];
  res.render('dvir-form', { user: req.session.user, report, checklist: CHECKLIST, defects, statuses: STATUSES, csrfToken: req.csrfToken(), isNew: false, trucks: [], trailers: [], drivers: [], trips: [] });
});
router.post('/dvir/:id/status', async (req, res) => {
  const status = STATUSES.includes(req.body.status) ? req.body.status : null;
  if (status) await pool.query('UPDATE dvir_reports SET status=? WHERE id=?', [status, req.params.id]);
  res.redirect('/admin/dvir/' + encodeURIComponent(req.params.id));
});
router.post('/dvir/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM dvir_reports WHERE id=?', [req.params.id]);
  res.redirect('/admin/dvir');
});

module.exports = router;
