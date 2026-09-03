'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const SECRET = process.env.DRIVER_JWT_SECRET || process.env.SESSION_SECRET || 'dev-driver-secret-change-me';

const hashPassword = (p) => bcrypt.hash(p, 12);
const verifyPassword = (p, h) => (h ? bcrypt.compare(p, h) : Promise.resolve(false));
const signToken = (d) => jwt.sign({ sub: d.id, name: d.name }, SECRET, { expiresIn: '30d' });

async function requireDriver(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(m[1], SECRET);
    const [rows] = await pool.query('SELECT id, name, phone, email, carrier_id, app_active FROM drivers WHERE id=? LIMIT 1', [payload.sub]);
    const d = rows[0];
    if (!d || !d.app_active) return res.status(401).json({ error: 'Account inactive' });
    req.driver = d; next();
  } catch (e) { return res.status(401).json({ error: 'Session expired — sign in again' }); }
}
module.exports = { hashPassword, verifyPassword, signToken, requireDriver };
