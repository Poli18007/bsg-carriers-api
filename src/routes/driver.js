'use strict';

// Driver app API — token-based (JWT), consumed by the React Native app.
// Mounted at /api/driver. Auth: phone/email + password, or SMS one-time code.

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { hashPassword, verifyPassword, signToken, requireDriver } = require('../lib/driver-auth');
const { sendSms, smsConfigured } = require('../lib/sms');
const { staffAlert } = require('../lib/notify');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/heic', 'application/pdf']);
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const last10 = (s) => digits(s).slice(-10);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const pub = (d) => ({ id: d.id, name: d.name, phone: d.phone, email: d.email });

// --- Auth: password ---------------------------------------------------------
router.post('/login', authLimiter, async (req, res) => {
  try {
    const login = String(req.body.login || '').trim();
    const password = String(req.body.password || '');
    if (!login || !password) return res.status(400).json({ error: 'Enter your phone/email and password.' });
    const [rows] = await pool.query(
      "SELECT id, name, phone, email, password_hash, app_active FROM drivers WHERE (LOWER(email)=LOWER(?) OR RIGHT(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=?) LIMIT 1",
      [login, last10(login)]);
    const d = rows[0];
    if (!d || !d.app_active || !(await verifyPassword(password, d.password_hash))) return res.status(401).json({ error: 'Wrong phone/email or password.' });
    await pool.query('UPDATE drivers SET last_login=now() WHERE id=?', [d.id]);
    res.json({ token: signToken(d), driver: pub(d) });
  } catch (e) { console.error('[driver login]', e.message); res.status(500).json({ error: 'Something went wrong.' }); }
});

// --- Auth: SMS one-time code -------------------------------------------------
router.post('/otp/request', authLimiter, async (req, res) => {
  try {
    const phone = last10(req.body.phone);
    if (phone.length < 10) return res.status(400).json({ error: 'Enter a valid mobile number.' });
    const [rows] = await pool.query("SELECT id, phone FROM drivers WHERE RIGHT(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=? AND app_active LIMIT 1", [phone]);
    const d = rows[0];
    // Always respond OK (don't reveal which numbers exist), but only send if known.
    if (d) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeHash = await bcrypt.hash(code, 8);
      await pool.query("INSERT INTO driver_otps (phone, code_hash, expires_at) VALUES (?, ?, now() + interval '10 minutes')", [phone, codeHash]);
      const r = await sendSms(d.phone || phone, 'Your BSG Carriers code is ' + code + '. Expires in 10 minutes.');
      const out = { ok: true };
      if (!r.configured) out.devCode = code; // dev fallback until Twilio is configured
      return res.json(out);
    }
    res.json({ ok: true });
  } catch (e) { console.error('[driver otp request]', e.message); res.status(500).json({ error: 'Could not send a code.' }); }
});

router.post('/otp/verify', authLimiter, async (req, res) => {
  try {
    const phone = last10(req.body.phone);
    const code = String(req.body.code || '').trim();
    const [otps] = await pool.query("SELECT id, code_hash, attempts FROM driver_otps WHERE phone=? AND used=false AND expires_at>now() ORDER BY created_at DESC LIMIT 1", [phone]);
    const otp = otps[0];
    if (!otp || otp.attempts >= 5) return res.status(401).json({ error: 'Code expired — request a new one.' });
    const ok = await bcrypt.compare(code, otp.code_hash);
    if (!ok) { await pool.query('UPDATE driver_otps SET attempts=attempts+1 WHERE id=?', [otp.id]); return res.status(401).json({ error: 'Wrong code.' }); }
    await pool.query('UPDATE driver_otps SET used=true WHERE id=?', [otp.id]);
    const [rows] = await pool.query("SELECT id, name, phone, email, app_active FROM drivers WHERE RIGHT(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=? AND app_active LIMIT 1", [phone]);
    const d = rows[0];
    if (!d) return res.status(401).json({ error: 'No driver account for that number.' });
    await pool.query('UPDATE drivers SET last_login=now() WHERE id=?', [d.id]);
    res.json({ token: signToken(d), driver: pub(d) });
  } catch (e) { console.error('[driver otp verify]', e.message); res.status(500).json({ error: 'Something went wrong.' }); }
});

// --- Everything below needs a valid driver token ----------------------------
router.get('/me', requireDriver, (req, res) => res.json({ driver: pub(req.driver) }));

router.post('/push-token', requireDriver, async (req, res) => {
  const token = String(req.body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'No token' });
  await pool.query(
    `INSERT INTO driver_push_tokens (driver_id, token, platform, updated_at) VALUES (?,?,?,now())
     ON CONFLICT (driver_id, token) DO UPDATE SET platform=EXCLUDED.platform, updated_at=now()`,
    [req.driver.id, token, String(req.body.platform || '').slice(0, 20) || null]);
  res.json({ ok: true });
});

// Loads assigned to this driver.
router.get('/loads', requireDriver, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.id, l.ref, l.origin, l.destination, l.pickup_date, l.delivery_date, l.rate,
            bc.name AS status, bc.category
       FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id
      WHERE l.driver_id=? AND l.status<>'cancelled'
      ORDER BY (bc.category IN ('active','in_transit')) DESC, l.pickup_date NULLS LAST, l.id DESC LIMIT 100`,
    [req.driver.id]);
  res.json({ loads: rows });
});

router.get('/loads/:id', requireDriver, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.*, bc.name AS status_name, bc.category, b.name AS broker_name, c.company_name AS carrier_name,
            su.name AS dispatcher_name
       FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id
       LEFT JOIN brokers b ON b.id=l.broker_id LEFT JOIN carriers c ON c.id=l.carrier_id
       LEFT JOIN staff_users su ON su.id=l.dispatcher_id
      WHERE l.id=? AND l.driver_id=? LIMIT 1`, [req.params.id, req.driver.id]);
  const load = rows[0];
  if (!load) return res.status(404).json({ error: 'Load not found' });
  delete load.content; // safety
  const [docs] = await pool.query("SELECT id, doc_type, filename, uploaded_at FROM load_documents WHERE load_id=? ORDER BY uploaded_at DESC", [load.id]);
  res.json({ load, documents: docs });
});

// Driver posts a status / check-call (shows in the dispatch timeline).
const DRIVER_STATUSES = ['Arrived at pickup', 'Loaded', 'In transit', 'Arrived at delivery', 'Delivered', 'Delayed'];
router.post('/loads/:id/status', requireDriver, async (req, res) => {
  const [own] = await pool.query('SELECT id, ref FROM loads WHERE id=? AND driver_id=? LIMIT 1', [req.params.id, req.driver.id]);
  if (!own.length) return res.status(404).json({ error: 'Load not found' });
  const status = DRIVER_STATUSES.includes(req.body.status) ? req.body.status : String(req.body.status || '').slice(0, 80);
  if (!status) return res.status(400).json({ error: 'No status' });
  const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
  const where = (Number.isFinite(lat) && Number.isFinite(lng)) ? ` @ ${lat.toFixed(4)},${lng.toFixed(4)}` : '';
  await pool.query('INSERT INTO load_events (load_id, kind, body, staff_email) VALUES (?,?,?,?)',
    [req.params.id, 'check_call', `[Driver ${req.driver.name}] ${status}${where}`, req.driver.email || null]);
  staffAlert('Driver check-call', [['Driver', req.driver.name], ['Load', own[0].ref || ('#' + own[0].id)], ['Update', status]]);
  res.json({ ok: true });
});

// Driver uploads a BOL/POD photo.
router.post('/loads/:id/documents', requireDriver, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo too large (max 8 MB).' : 'Upload failed.' });
    try {
      const [own] = await pool.query('SELECT id FROM loads WHERE id=? AND driver_id=? LIMIT 1', [req.params.id, req.driver.id]);
      if (!own.length) return res.status(404).json({ error: 'Load not found' });
      const f = req.file;
      if (!f) return res.status(400).json({ error: 'No photo' });
      if (!ALLOWED_MIME.has(f.mimetype)) return res.status(400).json({ error: 'Only JPG, PNG or PDF.' });
      const docType = ['bol', 'pod'].includes(req.body.doc_type) ? req.body.doc_type : 'other';
      await pool.query('INSERT INTO load_documents (load_id, doc_type, filename, mime_type, size_bytes, content) VALUES (?,?,?,?,?,?)',
        [req.params.id, docType, (f.originalname || (docType + '.jpg')).slice(0, 255), f.mimetype, f.size, f.buffer]);
      staffAlert('Driver uploaded a document', [['Driver', req.driver.name], ['Load', req.params.id], ['Type', docType.toUpperCase()]]);
      res.json({ ok: true });
    } catch (e) { console.error('[driver upload]', e.message); res.status(500).json({ error: 'Could not save the photo.' }); }
  });
});

// Driver submits a DVIR (pre/post-trip inspection).
router.post('/dvir', requireDriver, async (req, res) => {
  try {
    const b = req.body || {};
    const kind = b.kind === 'post_trip' ? 'post_trip' : 'pre_trip';
    const satisfactory = !(b.satisfactory === false || b.satisfactory === 'false');
    const defects = Array.isArray(b.defect_items) ? b.defect_items.join('\n') : (b.defect_items ? String(b.defect_items).slice(0, 2000) : null);
    const odometer = parseInt(b.odometer, 10); const odo = Number.isFinite(odometer) ? odometer : null;
    await pool.query(
      `INSERT INTO dvir_reports (kind, driver_id, odometer, location, defect_items, remarks, satisfactory, status)
       VALUES (?,?,?,?,?,?,?, 'submitted')`,
      [kind, req.driver.id, odo, (b.location ? String(b.location).slice(0, 160) : null), defects, (b.remarks ? String(b.remarks).slice(0, 1000) : null), satisfactory]);
    staffAlert('Driver submitted a DVIR', [['Driver', req.driver.name], ['Type', kind.replace('_', ' ')], ['Condition', satisfactory ? 'Satisfactory' : 'DEFECTS NOTED']]);
    res.json({ ok: true });
  } catch (e) { console.error('[driver dvir]', e.message); res.status(500).json({ error: 'Could not save the inspection.' }); }
});

module.exports = router;
