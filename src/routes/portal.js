'use strict';

// Carrier onboarding portal — carrier-facing routes, mounted at /portal.
// Carriers register, sign in, complete their profile, upload onboarding
// documents (stored in Postgres), and see their status.

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { pool } = require('../db');
const { hashPassword, verifyLogin, findByEmail, getCarrier, requireCarrier, sessionCarrier } = require('../lib/portal-auth');
const { staffAlert } = require('../lib/notify');

const router = express.Router();

// Files are held in memory then written to Postgres as bytea. 4 MB cap keeps a
// multipart request comfortably under the serverless body limit and the DB row
// small; onboarding PDFs/scans are well within it.
const MAX_FILE = 4 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, files: 1 },
});
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const DOC_TYPES = [
  { key: 'coi', label: 'Insurance certificate (COI)' },
  { key: 'authority', label: 'Operating authority (MC letter)' },
  { key: 'w9', label: 'W-9' },
];

const regLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false });

// --- Register ---------------------------------------------------------------
router.get('/register', (req, res) => {
  if (req.session.carrier) return res.redirect('/portal');
  res.render('portal/register', { error: null, values: {}, csrfToken: req.csrfToken() });
});

const registerSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
  company_name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(60).optional().or(z.literal('')),
  mc_number: z.string().trim().max(40).optional().or(z.literal('')),
  dot_number: z.string().trim().max(40).optional().or(z.literal('')),
  equipment: z.string().trim().max(120).optional().or(z.literal('')),
  num_trucks: z.string().trim().max(20).optional().or(z.literal('')),
  preferred_lanes: z.string().trim().max(255).optional().or(z.literal('')),
  current_location: z.string().trim().max(160).optional().or(z.literal('')),
});

router.post('/register', regLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body || {});
  const back = (msg) => res.status(400).render('portal/register', { error: msg, values: req.body || {}, csrfToken: req.csrfToken() });
  if (!parsed.success) return back(parsed.error.issues[0].message);
  const d = parsed.data;
  try {
    if (await findByEmail(d.email)) return back('An account with that email already exists — sign in instead.');
    const hash = await hashPassword(d.password);
    const [rows] = await pool.query(
      `INSERT INTO carriers (email, password_hash, company_name, contact_name, phone, mc_number,
        dot_number, equipment, num_trucks, preferred_lanes, current_location)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [d.email.toLowerCase(), hash, d.company_name, d.contact_name || null, d.phone || null,
       d.mc_number || null, d.dot_number || null, d.equipment || null, d.num_trucks || null,
       d.preferred_lanes || null, d.current_location || null]
    );
    const carrier = await getCarrier(rows[0].id);
    req.session.carrier = sessionCarrier(carrier);
    staffAlert('New carrier registration', [
      ['Company', d.company_name], ['Contact', d.contact_name || '—'], ['Email', d.email],
      ['Phone', d.phone || '—'], ['MC', d.mc_number || '—'], ['DOT', d.dot_number || '—'],
      ['Equipment', d.equipment || '—'],
    ]);
    res.redirect('/portal');
  } catch (err) {
    console.error('[portal] register error:', err.message);
    back('Something went wrong creating your account. Please try again.');
  }
});

// --- Login / logout ---------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.session.carrier) return res.redirect('/portal');
  res.render('portal/login', { error: null, csrfToken: req.csrfToken() });
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const carrier = await verifyLogin(req.body.email, req.body.password);
    if (!carrier) return res.status(401).render('portal/login', { error: 'Wrong email or password.', csrfToken: req.csrfToken() });
    req.session.carrier = sessionCarrier(carrier);
    res.redirect('/portal');
  } catch (err) {
    console.error('[portal] login error:', err.message);
    res.status(500).render('portal/login', { error: 'Something went wrong. Try again.', csrfToken: req.csrfToken() });
  }
});

router.post('/logout', requireCarrier, (req, res) => {
  req.session = null;
  res.redirect('/portal/login');
});

// Everything below requires a signed-in carrier.
router.use(requireCarrier);

// --- Home: stats dashboard for approved carriers, onboarding wizard otherwise
router.get('/', async (req, res) => {
  const carrier = await getCarrier(req.session.carrier.id);
  if (!carrier) { req.session = null; return res.redirect('/portal/login'); }
  const [docs] = await pool.query(
    'SELECT id, doc_type, filename, size_bytes, review, uploaded_at, expires_at, renewal_requested_at FROM carrier_documents WHERE carrier_id = ? ORDER BY uploaded_at DESC',
    [carrier.id]
  );
  const byType = {};
  docs.forEach((d) => { if (!byType[d.doc_type]) byType[d.doc_type] = d; });
  const checklist = DOC_TYPES.map((t) => ({ key: t.key, label: t.label, doc: byType[t.key] || null }));
  // Documents BSG has asked the owner-op to renew (re-upload a current copy).
  const renewals = checklist.filter((c) => c.doc && c.doc.renewal_requested_at).map((c) => c.label);
  const approved = carrier.status === 'approved';

  // Approved carriers get a real dashboard: their loads + account at a glance.
  if (approved) {
    try {
      const [[ls]] = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE bc.category IN ('active','in_transit'))::int AS active,
                COUNT(*) FILTER (WHERE bc.category='in_transit')::int AS in_transit,
                COUNT(*) FILTER (WHERE bc.category='delivered')::int AS delivered,
                COALESCE(SUM(l.rate) FILTER (WHERE bc.category IN ('active','in_transit')),0) AS active_value
           FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id
          WHERE l.carrier_id=? AND l.status<>'cancelled'`, [carrier.id]);
      const [[io]] = await pool.query(
        `SELECT COALESCE(SUM(t.total),0) AS billed, COALESCE(SUM(t.paid),0) AS paid FROM (
            SELECT (SELECT COALESCE(SUM(amount),0) FROM invoice_lines il WHERE il.invoice_id=i.id) AS total,
                   (SELECT COALESCE(SUM(amount),0) FROM invoice_payments p WHERE p.invoice_id=i.id) AS paid
              FROM invoices i WHERE i.carrier_id=? AND i.status IN ('sent','paid')) t`, [carrier.id]);
      const [upcoming] = await pool.query(
        `SELECT l.id, l.ref, l.origin, l.destination, l.pickup_date, l.delivery_date, l.rate, l.status,
                bc.name AS col_name, bc.color AS col_color, bc.category
           FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id
          WHERE l.carrier_id=? AND l.status<>'cancelled'
          ORDER BY (bc.category IN ('active','in_transit')) DESC, l.pickup_date NULLS LAST, l.id DESC LIMIT 6`, [carrier.id]);
      const outstanding = Math.max(0, Math.round((Number(io.billed) - Number(io.paid)) * 100) / 100);
      const stats = { total: ls.total, active: ls.active, in_transit: ls.in_transit, delivered: ls.delivered, active_value: Number(ls.active_value), outstanding };
      const soon = new Date(); soon.setDate(soon.getDate() + 30);
      const docsExpiring = checklist.filter((c) => c.doc && c.doc.expires_at && new Date(c.doc.expires_at) <= soon).map((c) => c.label);
      const docsApproved = checklist.filter((c) => c.doc && c.doc.review === 'accepted').length;
      return res.render('portal/dashboard', {
        carrier, stats, upcoming, renewals, docsExpiring,
        docsApproved, docsTotal: checklist.length,
        csrfToken: req.csrfToken(), notice: req.query.notice || null, error: req.query.error || null,
      });
    } catch (e) {
      console.error('[portal] dashboard error:', e.message);
      // fall through to the onboarding view rather than hanging the request
    }
  }

  // Not yet approved — guided onboarding wizard (step state derived from data).
  const docsDone = checklist.every((c) => c.doc);
  const profileDone = !!(carrier.mc_number && carrier.dot_number && carrier.equipment);
  const inReview = carrier.status === 'under_review' || carrier.status === 'needs_info';
  const steps = [
    { n: 1, label: 'Account', state: 'done' },
    { n: 2, label: 'Company details', state: profileDone ? 'done' : 'current' },
    { n: 3, label: 'Documents', state: docsDone ? 'done' : (profileDone ? 'current' : 'todo') },
    { n: 4, label: 'Review', state: approved ? 'done' : (docsDone ? 'current' : 'todo') },
  ];
  const doneCount = steps.filter((s) => s.state === 'done').length;
  res.render('portal/onboarding', {
    carrier, docs, docTypes: DOC_TYPES, checklist, steps, renewals,
    progress: Math.round((doneCount / steps.length) * 100),
    profileDone, docsDone, approved, inReview,
    csrfToken: req.csrfToken(), notice: req.query.notice || null, error: req.query.error || null,
  });
});

// --- Documents management (approved carriers keep their paperwork current) ---
router.get('/documents', async (req, res) => {
  const carrier = await getCarrier(req.session.carrier.id);
  if (!carrier) { req.session = null; return res.redirect('/portal/login'); }
  const [docs] = await pool.query(
    `SELECT id, doc_type, filename, size_bytes, review, uploaded_at, expires_at, renewal_requested_at,
            (expires_at IS NOT NULL AND expires_at < CURRENT_DATE) AS expired,
            (expires_at IS NOT NULL AND expires_at >= CURRENT_DATE AND expires_at <= CURRENT_DATE + 30) AS expiring
       FROM carrier_documents WHERE carrier_id=? ORDER BY uploaded_at DESC`, [carrier.id]);
  const byType = {};
  docs.forEach((d) => { if (!byType[d.doc_type]) byType[d.doc_type] = d; });
  const checklist = DOC_TYPES.map((t) => ({ key: t.key, label: t.label, doc: byType[t.key] || null }));
  res.render('portal/documents', { carrier, checklist, csrfToken: req.csrfToken(), notice: req.query.notice || null, error: req.query.error || null });
});

// --- Profile ----------------------------------------------------------------
router.get('/profile', async (req, res) => {
  const carrier = await getCarrier(req.session.carrier.id);
  res.render('portal/profile', { carrier, csrfToken: req.csrfToken(), notice: null });
});

router.post('/profile', async (req, res) => {
  const b = req.body || {};
  const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null) || null;
  await pool.query(
    `UPDATE carriers SET company_name = ?, contact_name = ?, phone = ?, mc_number = ?, dot_number = ?,
       equipment = ?, num_trucks = ?, preferred_lanes = ?, current_location = ? WHERE id = ?`,
    [clip(b.company_name, 200) || req.session.carrier.company_name, clip(b.contact_name, 160), clip(b.phone, 60),
     clip(b.mc_number, 40), clip(b.dot_number, 40), clip(b.equipment, 120), clip(b.num_trucks, 20),
     clip(b.preferred_lanes, 255), clip(b.current_location, 160), req.session.carrier.id]
  );
  const carrier = await getCarrier(req.session.carrier.id);
  req.session.carrier = sessionCarrier(carrier);
  res.render('portal/profile', { carrier, csrfToken: req.csrfToken(), notice: 'Profile saved.' });
});

// --- Documents --------------------------------------------------------------
// multer runs first; a rejected file (size/type) is handled below.
router.post('/documents', (req, res) => {
  upload.single('document')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 4 MB).' : 'Upload failed.';
      return res.redirect('/portal?error=' + encodeURIComponent(msg));
    }
    try {
      const docType = ['coi', 'authority', 'w9', 'other'].includes(req.body.doc_type) ? req.body.doc_type : 'other';
      const f = req.file;
      if (!f) return res.redirect('/portal?error=' + encodeURIComponent('Please choose a file.'));
      if (!ALLOWED_MIME.has(f.mimetype)) return res.redirect('/portal?error=' + encodeURIComponent('Only PDF, JPG or PNG files are accepted.'));
      const [ins] = await pool.query(
        'INSERT INTO carrier_documents (carrier_id, doc_type, filename, mime_type, size_bytes, content) VALUES (?,?,?,?,?,?) RETURNING id',
        [req.session.carrier.id, docType, f.originalname.slice(0, 255), f.mimetype, f.size, f.buffer]
      );
      // A fresh upload satisfies any renewal request for this document type.
      await pool.query('UPDATE carrier_documents SET renewal_requested_at = NULL WHERE carrier_id = ? AND doc_type = ? AND id <> ?',
        [req.session.carrier.id, docType, ins[0].id]);
      staffAlert('Carrier document uploaded', [
        ['Company', req.session.carrier.company_name], ['Email', req.session.carrier.email],
        ['Document', DOC_TYPES.find((t) => t.key === docType)?.label || docType], ['File', f.originalname],
      ]);
      // When all three required documents are in, advance a still-pending carrier
      // to 'under review' automatically — that's the "submitted for review" step.
      const [have] = await pool.query(
        "SELECT COUNT(DISTINCT doc_type)::int AS n FROM carrier_documents WHERE carrier_id=? AND doc_type IN ('coi','authority','w9')",
        [req.session.carrier.id]);
      if (have[0] && have[0].n >= 3) {
        const [adv] = await pool.query("UPDATE carriers SET status='under_review' WHERE id=? AND status='pending' RETURNING id", [req.session.carrier.id]);
        if (adv.length) staffAlert('Carrier ready for review', [['Company', req.session.carrier.company_name], ['Email', req.session.carrier.email]]);
      }
      res.redirect('/portal?notice=' + encodeURIComponent('Document uploaded.'));
    } catch (e) {
      console.error('[portal] upload error:', e.message);
      res.redirect('/portal?error=' + encodeURIComponent('Could not save the document.'));
    }
  });
});

// Download own document only.
router.get('/documents/:id', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT filename, mime_type, content FROM carrier_documents WHERE id = ? AND carrier_id = ? LIMIT 1',
    [req.params.id, req.session.carrier.id]
  );
  const doc = rows[0];
  if (!doc) return res.status(404).send('Not found');
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
  res.send(doc.content);
});

router.post('/documents/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM carrier_documents WHERE id = ? AND carrier_id = ?', [req.params.id, req.session.carrier.id]);
  res.redirect('/portal?notice=' + encodeURIComponent('Document removed.'));
});

// --- Loads assigned to this carrier ----------------------------------------
router.get('/loads', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.id, l.ref, l.origin, l.destination, l.pickup_date, l.delivery_date, l.rate, l.status,
            bc.name AS col_name, bc.color AS col_color
       FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id
       WHERE l.carrier_id = ? AND l.status <> 'cancelled' ORDER BY l.pickup_date NULLS LAST, l.id DESC LIMIT 200`,
    [req.session.carrier.id]
  );
  res.render('portal/loads', { carrier: { ...req.session.carrier }, rows, csrfToken: req.csrfToken() });
});

router.get('/loads/:id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.*, bc.name AS col_name, bc.color AS col_color FROM loads l
       LEFT JOIN board_columns bc ON bc.id=l.column_id WHERE l.id = ? AND l.carrier_id = ? LIMIT 1`,
    [req.params.id, req.session.carrier.id]);
  const load = rows[0];
  if (!load) return res.status(404).send('Not found');
  // Carriers only ever see the rate confirmation, not internal BOL/POD notes.
  const [docs] = await pool.query("SELECT id, filename, uploaded_at FROM load_documents WHERE load_id = ? AND doc_type = 'rate_con' ORDER BY uploaded_at DESC", [load.id]);
  res.render('portal/load', { carrier: { ...req.session.carrier }, load, docs, csrfToken: req.csrfToken() });
});

router.get('/loads/:id/documents/:docId', async (req, res) => {
  // Only a rate_con on a load that belongs to this carrier.
  const [rows] = await pool.query(
    `SELECT d.filename, d.mime_type, d.content FROM load_documents d JOIN loads l ON l.id = d.load_id
       WHERE d.id = ? AND l.id = ? AND l.carrier_id = ? AND d.doc_type = 'rate_con' LIMIT 1`,
    [req.params.docId, req.params.id, req.session.carrier.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  res.setHeader('Content-Type', rows[0].mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].filename.replace(/"/g, '')}"`);
  res.send(rows[0].content);
});

// --- Invoices the owner-op has been issued -----------------------------------
// Only invoices that have actually been issued (not drafts / voided) are shown.
router.get('/invoices', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT i.*,
            (SELECT COALESCE(SUM(amount),0) FROM invoice_lines il WHERE il.invoice_id=i.id) AS total,
            (SELECT COALESCE(SUM(amount),0) FROM invoice_payments p WHERE p.invoice_id=i.id) AS paid
       FROM invoices i
      WHERE i.carrier_id = ? AND i.status IN ('sent','paid') ORDER BY i.seq DESC LIMIT 200`,
    [req.session.carrier.id]);
  rows.forEach((r) => { r.total = Number(r.total) || 0; r.paid = Number(r.paid) || 0; r.balance = Math.round((r.total - r.paid) * 100) / 100; });
  res.render('portal/invoices', { carrier: { ...req.session.carrier }, rows, csrfToken: req.csrfToken() });
});

router.get('/invoices/:id', async (req, res) => {
  const [[inv]] = await pool.query(
    `SELECT i.*, c.company_name AS carrier_name, c.email AS carrier_email, c.contact_name AS carrier_contact, c.mc_number
       FROM invoices i LEFT JOIN carriers c ON c.id=i.carrier_id
      WHERE i.id = ? AND i.carrier_id = ? AND i.status IN ('sent','paid') LIMIT 1`,
    [req.params.id, req.session.carrier.id]);
  if (!inv) return res.status(404).send('Not found');
  const [lines] = await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY id', [inv.id]);
  const [[tot]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM invoice_lines WHERE invoice_id=?', [inv.id]);
  const [[pd]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_payments WHERE invoice_id=?', [inv.id]);
  const total = Number(tot.total) || 0, paid = Number(pd.paid) || 0;
  res.render('invoice-print', { inv, lines, t: { total, paid, balance: Math.round((total - paid) * 100) / 100 } });
});

module.exports = router;
