'use strict';

// Expenses — company / load / trip / truck costs. Staff-only, mounted /admin.

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const CATEGORIES = ['fuel', 'tolls', 'repair', 'insurance', 'permit', 'lumper', 'office', 'misc', 'other'];
const COLS = ['category', 'amount', 'description', 'expense_date', 'load_id', 'trip_id', 'truck_id', 'carrier_id'];

function values(b) {
  return {
    category: CATEGORIES.includes(b.category) ? b.category : 'other', amount: Math.round(num(b.amount) * 100) / 100,
    description: clip(b.description, 300), expense_date: date(b.expense_date) || new Date().toISOString().slice(0, 10),
    load_id: intOrNull(b.load_id), trip_id: intOrNull(b.trip_id), truck_id: intOrNull(b.truck_id), carrier_id: intOrNull(b.carrier_id),
  };
}
async function pickers() {
  const [trucks] = await pool.query('SELECT id, number FROM trucks WHERE active ORDER BY number');
  const [trips] = await pool.query("SELECT id, seq, name FROM trips WHERE status <> 'cancelled' ORDER BY seq DESC LIMIT 100");
  const [carriers] = await pool.query("SELECT id, company_name FROM carriers WHERE status <> 'rejected' ORDER BY company_name");
  return { trucks, trips, carriers };
}

router.get('/expenses', async (req, res) => {
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : '';
  const where = category ? 'WHERE e.category = ?' : '';
  const params = category ? [category] : [];
  const [rows] = await pool.query(
    `SELECT e.*, tk.number AS truck_number, t.seq AS trip_seq, l.ref AS load_ref, c.company_name AS carrier_name
       FROM expenses e LEFT JOIN trucks tk ON tk.id=e.truck_id LEFT JOIN trips t ON t.id=e.trip_id
       LEFT JOIN loads l ON l.id=e.load_id LEFT JOIN carriers c ON c.id=e.carrier_id
       ${where} ORDER BY e.expense_date DESC, e.id DESC LIMIT 400`, params);
  const [[counts]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total,
            COALESCE(SUM(amount) FILTER (WHERE expense_date >= date_trunc('month', CURRENT_DATE)),0) AS this_month FROM expenses`);
  const [byCat] = await pool.query('SELECT category, COALESCE(SUM(amount),0) AS total FROM expenses GROUP BY category ORDER BY total DESC');
  res.render('expenses', { user: req.session.user, rows, counts, byCat, filter: { category }, categories: CATEGORIES });
});
router.get('/expenses/new', async (req, res) => {
  const p = await pickers();
  res.render('expense-form', { user: req.session.user, expense: {}, ...p, categories: CATEGORIES, csrfToken: req.csrfToken(), isNew: true });
});
router.post('/expenses', async (req, res) => {
  const v = values(req.body || {});
  await pool.query(`INSERT INTO expenses (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map((k) => v[k]));
  res.redirect('/admin/expenses');
});
router.get('/expenses/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM expenses WHERE id=? LIMIT 1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  const p = await pickers();
  res.render('expense-form', { user: req.session.user, expense: rows[0], ...p, categories: CATEGORIES, csrfToken: req.csrfToken(), isNew: false });
});
router.post('/expenses/:id', async (req, res) => {
  const v = values(req.body || {});
  await pool.query(`UPDATE expenses SET ${COLS.map((k) => k + '=?').join(', ')} WHERE id=?`, [...COLS.map((k) => v[k]), req.params.id]);
  res.redirect('/admin/expenses');
});
router.post('/expenses/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM expenses WHERE id=?', [req.params.id]);
  res.redirect('/admin/expenses');
});

module.exports = router;
