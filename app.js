'use strict';

// BSG Carriers API — Express app.
//
// Runs two ways from this one file:
//   * Vercel (serverless): this module is imported by api/index.js and the app
//     is invoked per request. No app.listen(), and the DB is migrated once via
//     scripts/migrate.mjs — never per request.
//   * Local / a persistent host: `node app.js` connects, applies the schema and
//     listens on PORT.

// dotenv is only for local dev. On Vercel every value comes from the project's
// Environment Variables, so a missing .env here is expected and must not throw.
try { require('dotenv').config(); } catch (_) {}

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const cookieSession = require('cookie-session');
const path = require('path');

const { ping } = require('./src/db');
const { initDatabase } = require('./src/lib/init');
const leadsRouter = require('./src/routes/leads');
const adminRouter = require('./src/routes/admin');
const dispatchRouter = require('./src/routes/dispatch');
const invoicesRouter = require('./src/routes/invoices');
const tripsRouter = require('./src/routes/trips');
const dvirRouter = require('./src/routes/dvir');
const expensesRouter = require('./src/routes/expenses');
const maintenanceRouter = require('./src/routes/maintenance');
const reportsRouter = require('./src/routes/reports');
const portalRouter = require('./src/routes/portal');

const app = express();
const PROD = process.env.NODE_ENV === 'production';
const SERVERLESS = !!process.env.VERCEL;

// Behind a proxy (Vercel's edge), so the real client IP and the https flag are
// in forwarded headers — needed for secure cookies and per-IP rate limiting.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
// Two candidate view roots so it resolves whether the bundler roots the function
// at the app file's dir (__dirname) or the project cwd — Express tries each.
app.set('views', [path.join(__dirname, 'views'), path.join(process.cwd(), 'views')]);

app.use(helmet({
  contentSecurityPolicy: false, // admin pages use small inline styles; not worth a nonce pipeline for an internal tool
}));

// Body parsers: the forms post either urlencoded or multipart/FormData; JSON is
// accepted too. (FormData without files serialises fine through urlencoded when
// the client sends it that way; the frontend change posts application/x-www-form-urlencoded.)
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser());

// --- Public API: /leads -----------------------------------------------------
// CORS only for the public endpoint, locked to the marketing site's origin.
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use('/leads', cors({
  origin(origin, cb) {
    // Reflect the CORS header only for the configured site origin(s); requests
    // with no Origin (curl, server-to-server) are allowed through too. A
    // disallowed browser origin gets no header (so the browser blocks the
    // response) rather than a 500 — CORS is defense-in-depth here; the real
    // guards are the honeypot, rate limit and validation, which a non-browser
    // client cannot bypass anyway.
    cb(null, !origin || allowed.includes(origin));
  },
  methods: ['POST'],
}));
app.use(leadsRouter);

// --- Sessions + admin -------------------------------------------------------
// Cookie-based sessions (signed, no server-side store) — the right fit for
// serverless, where there is no shared memory and a DB-backed store would mean
// a round trip on every request. The admin session holds only {id,email,name,
// role} + a CSRF token, far under the 4KB cookie limit.
const sessionMw = cookieSession({
  name: 'bsg.sid',
  keys: [process.env.SESSION_SECRET || 'dev-insecure-secret-change-me'],
  httpOnly: true,
  secure: PROD,          // https-only in production
  sameSite: 'lax',
  maxAge: 8 * 60 * 60 * 1000, // 8h working session
});

// Lightweight session-based CSRF for the admin forms (csurf is deprecated).
// Not applied to /leads: that endpoint is cross-origin by design and is guarded
// by CORS + honeypot + rate limiting instead.
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  req.csrfToken = () => req.session.csrf;
  // Make the token and the signed-in user available to every EJS view (the
  // shared header renders a logout form and the nav on all admin pages).
  res.locals.csrfToken = req.session.csrf;
  res.locals.user = req.session.user || null;
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    // Body for urlencoded forms, query for multipart uploads (whose body isn't
    // parsed until multer runs inside the route, after this check), or a header.
    const token = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
    if (token !== req.session.csrf) return res.status(403).send('Invalid form token — reload and try again.');
  }
  next();
}

app.use('/admin', sessionMw, csrf, adminRouter);
app.use('/admin', sessionMw, csrf, dispatchRouter); // brokers, loads, dispatch board
app.use('/admin', sessionMw, csrf, invoicesRouter); // dispatch-fee invoices
app.use('/admin', sessionMw, csrf, tripsRouter);    // trips (multi-load routes)
app.use('/admin', sessionMw, csrf, dvirRouter);     // DVIR inspection reports
app.use('/admin', sessionMw, csrf, expensesRouter); // expenses
app.use('/admin', sessionMw, csrf, maintenanceRouter); // fleet maintenance
app.use('/admin', sessionMw, csrf, reportsRouter);  // analytics
app.use('/portal', sessionMw, csrf, portalRouter);

// --- Brand asset ------------------------------------------------------------
// The compact BSG logo, embedded (src/lib/brand.js) and served here so the
// portal and admin can show real branding without a static-file pipeline.
const { LOGO_PNG_B64, FAVICON_PNG_B64 } = require('./src/lib/brand');
const LOGO_BUF = Buffer.from(LOGO_PNG_B64, 'base64');
const FAVICON_BUF = Buffer.from(FAVICON_PNG_B64, 'base64');
const sendPng = (buf) => (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(buf);
};
app.get('/brand/logo.png', sendPng(LOGO_BUF));
app.get('/brand/favicon.png', sendPng(FAVICON_BUF));
// Browsers auto-request /favicon.ico; a PNG body is fine here.
app.get('/favicon.ico', sendPng(FAVICON_BUF));

// --- Health + root ----------------------------------------------------------
app.get('/health', async (req, res) => {
  try { await ping(); res.json({ ok: true, ts: new Date().toISOString() }); }
  catch (err) { res.status(500).json({ ok: false, error: 'db_unreachable' }); }
});

// Root returns 200 (not a redirect) so the platform's health check on "/" reads
// cleanly. Humans are still sent to the dashboard via a meta-refresh, which is
// not an HTTP redirect and so does not trip the "app is redirecting" warning.
app.get('/', (req, res) => {
  res.status(200).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>BSG Carriers API</title>' +
    '<meta http-equiv="refresh" content="0; url=/admin">' +
    '<body style="font-family:system-ui;background:#0e0f12;color:#e9e9ec;padding:40px">' +
    'BSG Carriers API. <a style="color:#DCB555" href="/admin">Open the admin dashboard →</a></body>'
  );
});

// 404 + error handler
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

// --- Start ------------------------------------------------------------------
const PORT = process.env.PORT || 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connect + self-install with a few retries: on a cold platform the DB can
// briefly refuse the first connection, and we do NOT want the app to end up
// listening with no tables (up but broken). Retry, then give up and listen
// anyway so the logs are reachable.
async function bootDatabase() {
  const attempts = 5;
  for (let i = 1; i <= attempts; i++) {
    try {
      await ping();
      console.log('[db] connected');
      await initDatabase();
      return true;
    } catch (err) {
      console.error(`[startup] db/init attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await sleep(2000 * i);
    }
  }
  console.error('[startup] giving up on db/init for now — listening anyway; restart once the DB is reachable.');
  return false;
}

async function start() {
  await bootDatabase();
  app.listen(PORT, () => console.log(`BSG Carriers API listening on ${PORT} (${PROD ? 'production' : 'development'})`));
}

// On Vercel the app is invoked per request (api/index.js) — never listen, and
// never migrate per request. Anywhere else, boot + listen.
if (!SERVERLESS) start();

module.exports = app;
