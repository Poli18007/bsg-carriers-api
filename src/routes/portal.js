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

// --- Dashboard --------------------------------------------------------------
router.get('/', async (req, res) => {
  const carrier = await getCarrier(req.session.carrier.id);
  if (!carrier) { req.session = null; return res.redirect('/portal/login'); }
  const [docs] = await pool.query(
    'SELECT id, doc_type, filename, size_bytes, review, uploaded_at FROM carrier_documents WHERE carrier_id = ? ORDER BY uploaded_at DESC',
    [carrier.id]
  );
  res.render('portal/dashboard', { carrier, docs, docTypes: DOC_TYPES, csrfToken: req.csrfToken(), notice: req.query.notice || null, error: req.query.error || null });
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
      await pool.query(
        'INSERT INTO carrier_documents (carrier_id, doc_type, filename, mime_type, size_bytes, content) VALUES (?,?,?,?,?,?)',
        [req.session.carrier.id, docType, f.originalname.slice(0, 255), f.mimetype, f.size, f.buffer]
      );
      staffAlert('Carrier document uploaded', [
        ['Company', req.session.carrier.company_name], ['Email', req.session.carrier.email],
        ['Document', DOC_TYPES.find((t) => t.key === docType)?.label || docType], ['File', f.originalname],
      ]);
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

module.exports = router;
