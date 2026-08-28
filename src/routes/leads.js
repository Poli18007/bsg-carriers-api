'use strict';

// Public lead intake — POST /leads.
// Receives the contact and carrier-onboarding forms from bsgcarriers.com.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { validateLead } = require('../lib/validate');
const { notify } = require('../lib/notify');

const router = express.Router();

// Per-IP rate limit. Generous enough for a person who mistypes and resubmits a
// few times, tight enough to stop a script hammering the endpoint.
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many submissions from this connection. Please try again shortly, or call us.' },
});

router.post('/leads', limiter, async (req, res) => {
  const declaredType = (req.body && (req.body.type || req.body.subject)) || '';
  const result = validateLead(req.body || {}, declaredType);

  // Honeypot hit: answer 200/ok so the bot learns nothing, but store nothing.
  if (!result.ok && result.code === 'spam') {
    return res.json({ ok: true });
  }
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 45);
  const ua = (req.get('user-agent') || '').slice(0, 400);
  const sourcePage = (req.body.source_page || req.get('referer') || '').toString().slice(0, 255);
  const c = result.columns;

  try {
    const [ins] = await pool.query(
      `INSERT INTO submissions
        (type, full_name, company, email, phone, mc_number, dot_number, equipment, message, data, source_page, ip, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        result.type, c.full_name, c.company, c.email, c.phone, c.mc_number, c.dot_number,
        c.equipment, c.message, JSON.stringify(result.data), sourcePage, ip, ua,
      ]
    );

    const sub = { id: ins.insertId, type: result.type, data: result.data, columns: c };
    notify(sub); // fire-and-forget; lead is already safely stored

    return res.json({ ok: true });
  } catch (err) {
    // The submission was NOT stored — tell the client honestly so its fail-closed
    // path shows the call-us message rather than a false success.
    console.error('[leads] insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'We could not save that just now. Please call or email us.' });
  }
});

module.exports = router;
