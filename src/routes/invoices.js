'use strict';

// Billing — dispatch-fee invoices BSG issues to carriers. Staff-only, mounted
// under /admin. An invoice is a set of line items (usually one per load, the
// dispatch fee = a % of the linehaul) plus recorded payments; the balance is
// SUM(lines) − SUM(payments).

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');
const { carrierEmail } = require('../lib/notify');

const router = express.Router();
router.use(requireLogin);

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Totals for one invoice.
async function totals(invoiceId) {
  const [[t]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM invoice_lines WHERE invoice_id=?', [invoiceId]);
  const [[p]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_payments WHERE invoice_id=?', [invoiceId]);
  const total = Number(t.total) || 0, paid = Number(p.paid) || 0;
  return { total, paid, balance: round2(total - paid) };
}

// ---- List ------------------------------------------------------------------
router.get('/invoices', async (req, res) => {
  const status = ['draft', 'sent', 'paid', 'void'].includes(req.query.status) ? req.query.status : '';
  const where = status ? 'WHERE i.status = ?' : '';
  const params = status ? [status] : [];
  const [rows] = await pool.query(
    `SELECT i.*, c.company_name AS carrier_name,
            (SELECT COALESCE(SUM(amount),0) FROM invoice_lines il WHERE il.invoice_id=i.id) AS total,
            (SELECT COALESCE(SUM(amount),0) FROM invoice_payments pm WHERE pm.invoice_id=i.id) AS paid
       FROM invoices i LEFT JOIN carriers c ON c.id=i.carrier_id ${where} ORDER BY i.seq DESC LIMIT 300`, params);
  rows.forEach((r) => { r.total = Number(r.total) || 0; r.paid = Number(r.paid) || 0; r.balance = round2(r.total - r.paid); });
  const [[counts]] = await pool.query(
    `SELECT COALESCE(SUM(t.total - t.paid) FILTER (WHERE i.status IN ('draft','sent')),0) AS outstanding,
            COALESCE(SUM(t.paid),0) AS collected,
            COUNT(*) FILTER (WHERE i.status='sent')::int AS sent_count
       FROM invoices i
       JOIN LATERAL (
         SELECT COALESCE((SELECT SUM(amount) FROM invoice_lines il WHERE il.invoice_id=i.id),0) AS total,
                COALESCE((SELECT SUM(amount) FROM invoice_payments pm WHERE pm.invoice_id=i.id),0) AS paid
       ) t ON true`);
  res.render('invoices', { user: req.session.user, rows, counts, filter: { status } });
});

// ---- New (pick a carrier, then their uninvoiced loads) ---------------------
router.get('/invoices/new', async (req, res) => {
  const carrierId = intOrNull(req.query.carrier);
  const [carriers] = await pool.query("SELECT id, company_name, dispatch_fee_pct FROM carriers WHERE status <> 'rejected' ORDER BY company_name");
  let carrier = null, loads = [];
  if (carrierId) {
    const [[c]] = await pool.query('SELECT id, company_name, dispatch_fee_pct FROM carriers WHERE id=? LIMIT 1', [carrierId]);
    carrier = c || null;
    if (carrier) {
      const [rows] = await pool.query(
        `SELECT l.id, l.ref, l.customer, l.origin, l.destination, l.rate
           FROM loads l
          WHERE l.carrier_id=? AND l.id NOT IN (SELECT load_id FROM invoice_lines WHERE load_id IS NOT NULL)
          ORDER BY l.id DESC LIMIT 200`, [carrierId]);
      loads = rows;
    }
  }
  res.render('invoice-form', { user: req.session.user, carriers, carrier, loads, csrfToken: req.csrfToken() });
});

// ---- Create ----------------------------------------------------------------
router.post('/invoices', async (req, res) => {
  const b = req.body || {};
  const carrierId = intOrNull(b.carrier_id);
  const fee = num(b.fee_pct);
  const [[c]] = carrierId ? await pool.query('SELECT company_name FROM carriers WHERE id=?', [carrierId]) : [[null]];
  const [[seqRow]] = await pool.query('SELECT COALESCE(MAX(seq),1000)+1 AS seq FROM invoices');
  const [ins] = await pool.query(
    `INSERT INTO invoices (seq, carrier_id, bill_to, status, issue_date, due_date, notes)
     VALUES (?,?,?, 'draft', CURRENT_DATE, ?, ?) RETURNING id`,
    [seqRow.seq, carrierId, (c && c.company_name) || clip(b.bill_to, 200), date(b.due_date), clip(b.notes, 2000)]);
  const invoiceId = ins[0].id;

  const loadIds = [].concat(b.load_id || []).map((x) => intOrNull(x)).filter(Boolean);
  if (loadIds.length) {
    const [loads] = await pool.query(`SELECT id, ref, origin, destination, rate FROM loads WHERE id = ANY(?)`, [loadIds]);
    for (const l of loads) {
      const amount = round2((Number(l.rate) || 0) * fee / 100);
      const desc = `Dispatch fee ${fee}% — load ${l.ref || ('#' + l.id)} (${l.origin || '?'} → ${l.destination || '?'})`;
      await pool.query('INSERT INTO invoice_lines (invoice_id, load_id, description, amount) VALUES (?,?,?,?)', [invoiceId, l.id, desc, amount]);
    }
  }
  res.redirect('/admin/invoices/' + invoiceId);
});

// ---- Detail ----------------------------------------------------------------
async function renderDetail(req, res, invoiceId) {
  const [[inv]] = await pool.query(
    `SELECT i.*, c.company_name AS carrier_name, c.email AS carrier_email, c.contact_name AS carrier_contact
       FROM invoices i LEFT JOIN carriers c ON c.id=i.carrier_id WHERE i.id=? LIMIT 1`, [invoiceId]);
  if (!inv) return res.status(404).send('Not found');
  const [lines] = await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY id', [invoiceId]);
  const [payments] = await pool.query('SELECT * FROM invoice_payments WHERE invoice_id=? ORDER BY paid_at, id', [invoiceId]);
  const t = await totals(invoiceId);
  res.render('invoice', { user: req.session.user, inv, lines, payments, t, csrfToken: req.csrfToken(), msg: req.query.msg || null });
}
router.get('/invoices/:id', (req, res) => renderDetail(req, res, req.params.id));

router.post('/invoices/:id', async (req, res) => {
  const b = req.body || {};
  const status = ['draft', 'sent', 'paid', 'void'].includes(b.status) ? b.status : 'draft';
  await pool.query('UPDATE invoices SET status=?, issue_date=COALESCE(?::date,issue_date), due_date=?::date, bill_to=?, notes=?, updated_at=now() WHERE id=?',
    [status, date(b.issue_date), date(b.due_date), clip(b.bill_to, 200), clip(b.notes, 2000), req.params.id]);
  res.redirect('/admin/invoices/' + encodeURIComponent(req.params.id));
});

router.post('/invoices/:id/status', async (req, res) => {
  const status = ['draft', 'sent', 'paid', 'void'].includes(req.body.status) ? req.body.status : null;
  if (status) await pool.query('UPDATE invoices SET status=?, updated_at=now() WHERE id=?', [status, req.params.id]);
  res.redirect('/admin/invoices/' + encodeURIComponent(req.params.id));
});

router.post('/invoices/:id/lines', async (req, res) => {
  const desc = clip(req.body.description, 300);
  if (desc) await pool.query('INSERT INTO invoice_lines (invoice_id, load_id, description, amount) VALUES (?,?,?,?)',
    [req.params.id, intOrNull(req.body.load_id), desc, round2(num(req.body.amount))]);
  res.redirect('/admin/invoices/' + encodeURIComponent(req.params.id));
});
router.post('/invoices/:id/lines/:lineId/delete', async (req, res) => {
  await pool.query('DELETE FROM invoice_lines WHERE id=? AND invoice_id=?', [req.params.lineId, req.params.id]);
  res.redirect('/admin/invoices/' + encodeURIComponent(req.params.id));
});

router.post('/invoices/:id/payments', async (req, res) => {
  const amount = round2(num(req.body.amount));
  if (amount) {
    await pool.query('INSERT INTO invoice_payments (invoice_id, amount, method, paid_at, notes) VALUES (?,?,?,COALESCE(?::date,CURRENT_DATE),?)',
      [req.params.id, amount, clip(req.body.method, 40), date(req.body.paid_at), clip(req.body.notes, 300)]);
    // Auto-mark paid once the balance is cleared (unless voided).
    const t = await totals(req.params.id);
    if (t.balance <= 0) await pool.query("UPDATE invoices SET status='paid', updated_at=now() WHERE id=? AND status<>'void'", [req.params.id]);
  }
  res.redirect('/admin/invoices/' + encodeURIComponent(req.params.id));
});
router.post('/invoices/:id/payments/:payId/delete', async (req, res) => {
  await pool.query('DELETE FROM invoice_payments WHERE id=? AND invoice_id=?', [req.params.payId, req.params.id]);
  res.redirect('/admin/invoices/' + encodeURIComponent(req.params.id));
});

router.post('/invoices/:id/delete', async (req, res) => {
  // Drafts can be deleted outright; anything issued is voided to keep the trail.
  const [[inv]] = await pool.query('SELECT status FROM invoices WHERE id=?', [req.params.id]);
  if (inv && inv.status === 'draft') await pool.query('DELETE FROM invoices WHERE id=?', [req.params.id]);
  else await pool.query("UPDATE invoices SET status='void', updated_at=now() WHERE id=?", [req.params.id]);
  res.redirect('/admin/invoices');
});

// ---- Send the invoice to the owner-op (carrier) by email -------------------
const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
router.post('/invoices/:id/send', async (req, res) => {
  const [[inv]] = await pool.query(
    'SELECT i.seq, c.email, c.company_name FROM invoices i LEFT JOIN carriers c ON c.id=i.carrier_id WHERE i.id=? LIMIT 1', [req.params.id]);
  if (!inv || !inv.email) return res.redirect('/admin/invoices/' + encodeURIComponent(req.params.id) + '?msg=nocarrier');
  const t = await totals(req.params.id);
  const portal = (process.env.PORTAL_URL || 'https://bsg-carriers-api.vercel.app/portal').replace(/\/$/, '');
  carrierEmail(inv.email, `Invoice BSG-${inv.seq} from BSG Carriers`, [
    `Hi ${inv.company_name},`,
    `Your dispatch-fee invoice BSG-${inv.seq} is ready — total ${fmt(t.total)}, balance due ${fmt(t.balance)}.`,
    `View or print it in your owner-op portal: ${portal}/invoices/${req.params.id}`,
    'Thank you for partnering with BSG Carriers.',
  ]);
  await pool.query("UPDATE invoices SET status='sent', updated_at=now() WHERE id=? AND status<>'void'", [req.params.id]);
  res.redirect('/admin/invoices/' + encodeURIComponent(req.params.id) + '?msg=sent');
});

// ---- Printable invoice (standalone page, no admin shell) -------------------
router.get('/invoices/:id/print', async (req, res) => {
  const [[inv]] = await pool.query(
    `SELECT i.*, c.company_name AS carrier_name, c.email AS carrier_email, c.contact_name AS carrier_contact, c.mc_number
       FROM invoices i LEFT JOIN carriers c ON c.id=i.carrier_id WHERE i.id=? LIMIT 1`, [req.params.id]);
  if (!inv) return res.status(404).send('Not found');
  const [lines] = await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY id', [req.params.id]);
  const t = await totals(req.params.id);
  res.render('invoice-print', { inv, lines, t });
});

module.exports = router;
