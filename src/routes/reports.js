'use strict';

// Reports — operational + financial analytics over loads, carriers, customers,
// expenses and invoices. Read-only; staff-only, mounted /admin.

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

router.get('/reports', async (req, res) => {
  const [byMonth] = await pool.query(
    `SELECT to_char(date_trunc('month', COALESCE(pickup_date, created_at::date)), 'Mon YY') AS label,
            date_trunc('month', COALESCE(pickup_date, created_at::date)) AS m,
            COALESCE(SUM(rate),0) AS revenue, COUNT(*)::int AS loads
       FROM loads
      WHERE COALESCE(pickup_date, created_at::date) >= (date_trunc('month', CURRENT_DATE) - interval '5 months')
      GROUP BY m ORDER BY m`);
  const [topCarriers] = await pool.query(
    `SELECT c.company_name AS name, COUNT(l.id)::int AS loads, COALESCE(SUM(l.rate),0) AS revenue
       FROM loads l JOIN carriers c ON c.id=l.carrier_id GROUP BY c.company_name ORDER BY revenue DESC LIMIT 8`);
  const [topCustomers] = await pool.query(
    `SELECT COALESCE(cu.name, l.customer) AS name, COUNT(l.id)::int AS loads, COALESCE(SUM(l.rate),0) AS revenue
       FROM loads l LEFT JOIN customers cu ON cu.id=l.customer_id
      WHERE COALESCE(cu.name, l.customer) IS NOT NULL AND COALESCE(cu.name, l.customer) <> ''
      GROUP BY COALESCE(cu.name, l.customer) ORDER BY revenue DESC LIMIT 8`);
  const [byColumn] = await pool.query(
    `SELECT bc.name, bc.color, COUNT(l.id)::int AS n FROM board_columns bc
       LEFT JOIN loads l ON l.column_id=bc.id
       JOIN boards b ON b.id=bc.board_id AND b.kind='loads'
      GROUP BY bc.id, bc.name, bc.color, bc.sort ORDER BY bc.sort`);
  const [expenseCat] = await pool.query(
    `SELECT category AS name, COALESCE(SUM(amount),0) AS total FROM expenses GROUP BY category ORDER BY total DESC`);
  const [[totals]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM loads)::int AS loads,
            (SELECT COALESCE(SUM(rate),0) FROM loads) AS load_revenue,
            (SELECT COALESCE(SUM(amount),0) FROM expenses) AS expenses,
            (SELECT COALESCE(SUM(il.amount),0) FROM invoice_lines il) AS billed,
            (SELECT COALESCE(SUM(p.amount),0) FROM invoice_payments p) AS collected,
            (SELECT COUNT(*) FROM trips)::int AS trips`);
  totals.outstanding = Number(totals.billed) - Number(totals.collected);
  res.render('reports', { user: req.session.user, byMonth, topCarriers, topCustomers, byColumn, expenseCat, totals });
});

module.exports = router;
