'use strict';

// Settings — self-service account (change your own password) plus admin config
// (load labels, board columns) and a reference of what each role can access.
// Mounted /admin; the section is open to any signed-in user, admin bits gated.

const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole, verifyLogin, hashPassword } = require('../lib/auth');
const perms = require('../lib/perms');

const router = express.Router();
router.use(requireLogin);

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

router.get('/settings', async (req, res) => {
  const [labels] = await pool.query('SELECT * FROM labels ORDER BY sort, id');
  const [boards] = await pool.query('SELECT id, name, kind FROM boards ORDER BY sort');
  res.render('settings', {
    user: req.session.user, labels, boards, roles: perms.ROLES, roleSections: perms.ROLE_SECTIONS,
    csrfToken: req.csrfToken(), notice: req.query.notice || null, error: req.query.error || null,
  });
});

// Change your own password.
router.post('/settings/password', async (req, res) => {
  const cur = String(req.body.current_password || '');
  const npw = String(req.body.new_password || '');
  const conf = String(req.body.confirm_password || '');
  const back = (msg, ok) => res.redirect('/admin/settings?' + (ok ? 'notice=' : 'error=') + encodeURIComponent(msg));
  if (npw.length < 10) return back('New password must be at least 10 characters.');
  if (npw !== conf) return back('The new passwords do not match.');
  const ok = await verifyLogin(req.session.user.email, cur);
  if (!ok) return back('Your current password is incorrect.');
  await pool.query('UPDATE staff_users SET password_hash = ? WHERE id = ?', [await hashPassword(npw), req.session.user.id]);
  back('Password updated.', true);
});

// Load labels (admin only) — add / edit / delete. Deleting a label leaves loads
// intact (their label_id is set null by the FK).
router.post('/settings/labels', requireRole('admin'), async (req, res) => {
  const name = clip(req.body.name, 80);
  if (name) {
    const [[m]] = await pool.query('SELECT COALESCE(MAX(sort),-1)+1 AS n FROM labels');
    await pool.query('INSERT INTO labels (name, color, sort) VALUES (?,?,?) ON CONFLICT (name) DO NOTHING',
      [name, (req.body.color || '#DCB555').slice(0, 20), m.n]);
  }
  res.redirect('/admin/settings');
});
router.post('/settings/labels/:id', requireRole('admin'), async (req, res) => {
  await pool.query("UPDATE labels SET name = COALESCE(NULLIF(?,''), name), color = ? WHERE id = ?",
    [clip(req.body.name, 80), (req.body.color || '#DCB555').slice(0, 20), req.params.id]);
  res.redirect('/admin/settings');
});
router.post('/settings/labels/:id/delete', requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM labels WHERE id = ?', [req.params.id]);
  res.redirect('/admin/settings');
});

module.exports = router;
