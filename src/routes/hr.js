'use strict';

// People & performance (HR): team overview, per-person scorecards, attendance
// timesheets and targets. Admin/manager only (guarded by the 'team' section).

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');
const perms = require('../lib/perms');

const router = express.Router();
router.use(requireLogin);

const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const canEdit = (role) => role === 'admin' || role === 'manager' || role === 'staff';

// --- Team overview ----------------------------------------------------------
router.get('/team', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.role, u.title, u.active,
         (SELECT COUNT(*) FROM loads l WHERE l.dispatcher_id=u.id AND l.created_at >= date_trunc('week',now()))::int AS loads_wk,
         (SELECT COALESCE(SUM(rate),0) FROM loads l WHERE l.dispatcher_id=u.id AND l.created_at >= date_trunc('week',now())) AS revenue_wk,
         ROUND((SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s.logout_at,s.last_seen_at)-s.login_at)))/3600.0,0)
                  FROM staff_sessions s WHERE s.staff_id=u.id AND s.login_at >= date_trunc('week',now()))::numeric,1) AS hours_wk,
         EXISTS(SELECT 1 FROM staff_sessions s2 WHERE s2.staff_id=u.id AND s2.logout_at IS NULL AND s2.last_seen_at > now() - interval '10 minutes') AS online,
         (SELECT MAX(last_seen_at) FROM staff_sessions s3 WHERE s3.staff_id=u.id) AS last_seen
       FROM staff_users u WHERE u.active ORDER BY (u.role='dispatcher') DESC, u.name`);
    const [[tot]] = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE logout_at IS NULL AND last_seen_at > now() - interval '10 minutes')::int AS online_now
         FROM staff_sessions`);
    res.render('team', { user: req.session.user, rows, onlineNow: tot.online_now });
  } catch (e) { console.error('[hr team] error:', e.message); res.status(500).send('Could not load the team page.'); }
});

// --- Person scorecard + timesheet + targets --------------------------------
router.get('/team/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [urows] = await pool.query('SELECT id, name, email, role, title, phone, hired_at, active FROM staff_users WHERE id=? LIMIT 1', [id]);
    const person = urows[0];
    if (!person) return res.status(404).send('Not found');
    const period = req.query.period === 'month' ? 'month' : 'week';
    const start = `date_trunc('${period}', now())`; // period is whitelisted above

    const [[loads]] = await pool.query(
      `SELECT COUNT(*)::int AS handled, COALESCE(SUM(rate),0) AS revenue
         FROM loads WHERE dispatcher_id=? AND created_at >= ${start}`, [id]);
    const [[ot]] = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE bc.category IN ('delivered','done') AND l.delivery_date IS NOT NULL)::int AS delivered,
              COUNT(*) FILTER (WHERE bc.category IN ('delivered','done') AND l.delivery_date IS NOT NULL AND l.updated_at::date <= l.delivery_date)::int AS ontime
         FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id
        WHERE l.dispatcher_id=? AND l.updated_at >= ${start}`, [id]);
    const [[resp]] = await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (fe.first_evt - l.created_at))/3600.0)::numeric,1) AS avg_hrs
         FROM loads l JOIN (SELECT load_id, MIN(created_at) first_evt FROM load_events WHERE kind='status' GROUP BY load_id) fe ON fe.load_id=l.id
        WHERE l.dispatcher_id=? AND l.created_at >= ${start}`, [id]);
    const [[hrs]] = await pool.query(
      `SELECT ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(logout_at,last_seen_at)-login_at))/3600.0),0)::numeric,1) AS hours,
              COUNT(*)::int AS sessions
         FROM staff_sessions WHERE staff_id=? AND login_at >= ${start}`, [id]);
    const ontimePct = ot.delivered ? Math.round((ot.ontime / ot.delivered) * 100) : null;

    const [daily] = await pool.query(
      `SELECT login_at::date AS d, ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(logout_at,last_seen_at)-login_at))/3600.0)::numeric,2) AS hours, COUNT(*)::int AS sessions
         FROM staff_sessions WHERE staff_id=? AND login_at >= current_date - 13 GROUP BY login_at::date ORDER BY d DESC`, [id]);
    const [sessions] = await pool.query(
      `SELECT login_at, last_seen_at, logout_at, ended_reason,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(logout_at,last_seen_at)-login_at))/3600.0::numeric,2) AS hours
         FROM staff_sessions WHERE staff_id=? ORDER BY login_at DESC LIMIT 20`, [id]);
    const [trows] = await pool.query('SELECT metric, period, target FROM staff_targets WHERE staff_id=?', [id]);
    const targets = {};
    trows.forEach((t) => { targets[t.metric + ':' + t.period] = Number(t.target); });
    // Goals that line up with the scorecard's period (week -> weekly target).
    const tperiod = period === 'month' ? 'monthly' : 'weekly';
    const pick = (m) => (targets[m + ':' + tperiod] == null ? null : targets[m + ':' + tperiod]);
    const goals = { loads: pick('loads'), ontime_pct: pick('ontime_pct'), revenue: pick('revenue'), hours: pick('hours') };

    const scard = {
      period,
      handled: loads.handled, revenue: Number(loads.revenue),
      delivered: ot.delivered, ontimePct,
      respHrs: resp.avg_hrs == null ? null : Number(resp.avg_hrs),
      hours: Number(hrs.hours), sessions: hrs.sessions,
    };
    res.render('team-detail', {
      user: req.session.user, person, scard, goals, tperiod, daily, sessions,
      canEdit: canEdit(req.session.user.role), csrfToken: req.csrfToken(),
      msg: req.query.msg || null,
    });
  } catch (e) { console.error('[hr detail] error:', e.message); res.status(500).send('Could not load this person.'); }
});

// --- Save targets -----------------------------------------------------------
router.post('/team/:id/targets', async (req, res) => {
  if (!canEdit(req.session.user.role)) return res.status(403).render('403', { user: req.session.user, reason: 'section', section: 'team' });
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const period = b.period === 'monthly' ? 'monthly' : 'weekly';
  try {
    for (const metric of ['loads', 'ontime_pct', 'revenue', 'hours']) {
      const v = num(b[metric]);
      if (v == null) {
        await pool.query('DELETE FROM staff_targets WHERE staff_id=? AND metric=? AND period=?', [id, metric, period]);
      } else {
        await pool.query(
          `INSERT INTO staff_targets (staff_id, metric, period, target, updated_at) VALUES (?,?,?,?,now())
           ON CONFLICT (staff_id, metric, period) DO UPDATE SET target=EXCLUDED.target, updated_at=now()`,
          [id, metric, period, v]);
      }
    }
    res.redirect(`/admin/team/${id}?period=${period === 'monthly' ? 'month' : 'week'}&msg=targets`);
  } catch (e) { console.error('[hr targets] error:', e.message); res.redirect(`/admin/team/${id}?msg=err`); }
});

// --- Save HR profile fields -------------------------------------------------
router.post('/team/:id/profile', async (req, res) => {
  if (!canEdit(req.session.user.role)) return res.status(403).render('403', { user: req.session.user, reason: 'section', section: 'team' });
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    await pool.query('UPDATE staff_users SET title=?, phone=?, hired_at=? WHERE id=?',
      [clip(b.title, 80), clip(b.phone, 40), date(b.hired_at), id]);
    res.redirect(`/admin/team/${id}?msg=profile`);
  } catch (e) { console.error('[hr profile] error:', e.message); res.redirect(`/admin/team/${id}?msg=err`); }
});

module.exports = router;
