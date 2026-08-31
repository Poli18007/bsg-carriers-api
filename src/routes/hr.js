'use strict';

// People & performance (HR): team overview, per-person scorecards, attendance
// timesheets, targets, SLAs and leave/PTO.
//   /team*  — management views (admin/manager, 'team' section)
//   /leave  — leave approvals (admin/manager)
//   /sla    — SLA thresholds + compliance (admin/manager)
//   /me/*   — self-service (any signed-in staff): own scorecard + own leave

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');
const sla = require('../lib/sla');

const router = express.Router();
router.use(requireLogin);

const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const canEdit = (role) => role === 'admin' || role === 'manager' || role === 'staff';
const showMoneyFor = (role) => role === 'admin' || role === 'manager' || role === 'billing' || role === 'staff';
const LEAVE_KINDS = ['pto', 'sick', 'unpaid', 'other'];

// --- Shared scorecard + timesheet builders ---------------------------------
// Core metrics over an arbitrary [lo,hi) window. lo/hi are SQL expressions the
// caller builds from a whitelisted period — never user input.
async function coreMetrics(id, lo, hi) {
  const [[l]] = await pool.query(
    `SELECT COUNT(*)::int AS handled, COALESCE(SUM(rate),0) AS revenue
       FROM loads WHERE dispatcher_id=? AND created_at >= ${lo} AND created_at < ${hi}`, [id]);
  const [[o]] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE bc.category IN ('delivered','done') AND l.delivery_date IS NOT NULL)::int AS delivered,
            COUNT(*) FILTER (WHERE bc.category IN ('delivered','done') AND l.delivery_date IS NOT NULL AND l.updated_at::date <= l.delivery_date)::int AS ontime
       FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id
      WHERE l.dispatcher_id=? AND l.updated_at >= ${lo} AND l.updated_at < ${hi}`, [id]);
  const [[h]] = await pool.query(
    `SELECT ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(logout_at,last_seen_at)-login_at))/3600.0),0)::numeric,1) AS hours,
            COUNT(*)::int AS sessions
       FROM staff_sessions WHERE staff_id=? AND login_at >= ${lo} AND login_at < ${hi}`, [id]);
  return { handled: l.handled, revenue: Number(l.revenue), ontimePct: o.delivered ? Math.round((o.ontime / o.delivered) * 100) : null, hours: Number(h.hours), sessions: h.sessions };
}
async function scorecardFor(id, period) {
  const startExpr = `date_trunc('${period}', now())`;             // period whitelisted by caller
  const perExpr = period === 'month' ? "interval '1 month'" : "interval '7 days'";
  // Current period-to-date vs the same elapsed span one period ago (fair compare).
  const cur = await coreMetrics(id, startExpr, 'now()');
  const prev = await coreMetrics(id, `${startExpr} - ${perExpr}`, `now() - ${perExpr}`);
  const [[resp]] = await pool.query(
    `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (fe.first_evt - l.created_at))/3600.0)::numeric,1) AS avg_hrs
       FROM loads l JOIN (SELECT load_id, MIN(created_at) first_evt FROM load_events WHERE kind='status' GROUP BY load_id) fe ON fe.load_id=l.id
      WHERE l.dispatcher_id=? AND l.created_at >= ${startExpr}`, [id]);
  const [trows] = await pool.query('SELECT metric, period, target FROM staff_targets WHERE staff_id=?', [id]);
  const targets = {};
  trows.forEach((t) => { targets[t.metric + ':' + t.period] = Number(t.target); });
  const tperiod = period === 'month' ? 'monthly' : 'weekly';
  const pick = (m) => (targets[m + ':' + tperiod] == null ? null : targets[m + ':' + tperiod]);
  const goals = { loads: pick('loads'), ontime_pct: pick('ontime_pct'), revenue: pick('revenue'), hours: pick('hours') };
  const deltas = {
    loads: cur.handled - prev.handled,
    revenue: cur.revenue - prev.revenue,
    hours: Number((cur.hours - prev.hours).toFixed(1)),
    ontimePct: (cur.ontimePct == null || prev.ontimePct == null) ? null : cur.ontimePct - prev.ontimePct,
  };
  // 8-week sparkline series (loads + hours), zero-filled via generate_series.
  const [spark] = await pool.query(
    `WITH weeks AS (SELECT generate_series(date_trunc('week',now()) - interval '7 weeks', date_trunc('week',now()), interval '1 week') wk)
       SELECT to_char(w.wk,'MM/DD') AS label,
         (SELECT COUNT(*) FROM loads l WHERE l.dispatcher_id=? AND date_trunc('week',l.created_at)=w.wk)::int AS loads,
         ROUND(COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(s.logout_at,s.last_seen_at)-s.login_at))/3600.0)
                           FROM staff_sessions s WHERE s.staff_id=? AND date_trunc('week',s.login_at)=w.wk),0)::numeric,1) AS hours
       FROM weeks w ORDER BY w.wk`, [id, id]);
  const scard = {
    period, handled: cur.handled, revenue: cur.revenue, ontimePct: cur.ontimePct,
    respHrs: resp.avg_hrs == null ? null : Number(resp.avg_hrs),
    hours: cur.hours, sessions: cur.sessions, deltas,
  };
  return { scard, goals, tperiod, spark };
}
async function timesheetFor(id) {
  const [daily] = await pool.query(
    `SELECT login_at::date AS d, ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(logout_at,last_seen_at)-login_at))/3600.0)::numeric,2) AS hours, COUNT(*)::int AS sessions
       FROM staff_sessions WHERE staff_id=? AND login_at >= current_date - 13 GROUP BY login_at::date ORDER BY d DESC`, [id]);
  const [sessions] = await pool.query(
    `SELECT login_at, last_seen_at, logout_at, ended_reason,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(logout_at,last_seen_at)-login_at))/3600.0::numeric,2) AS hours
       FROM staff_sessions WHERE staff_id=? ORDER BY login_at DESC LIMIT 20`, [id]);
  return { daily, sessions };
}

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
      `SELECT COUNT(*) FILTER (WHERE logout_at IS NULL AND last_seen_at > now() - interval '10 minutes')::int AS online_now FROM staff_sessions`);
    const [[pend]] = await pool.query("SELECT COUNT(*)::int AS n FROM leave_requests WHERE status='pending'");
    res.render('team', { user: req.session.user, rows, onlineNow: tot.online_now, pendingLeave: pend.n });
  } catch (e) { console.error('[hr team] error:', e.message); res.status(500).send('Could not load the team page.'); }
});

// --- Person scorecard (management view) ------------------------------------
router.get('/team/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [urows] = await pool.query('SELECT id, name, email, role, title, phone, hired_at, active FROM staff_users WHERE id=? LIMIT 1', [id]);
    const person = urows[0];
    if (!person) return res.status(404).send('Not found');
    const period = req.query.period === 'month' ? 'month' : 'week';
    const { scard, goals, tperiod, spark } = await scorecardFor(id, period);
    const { daily, sessions } = await timesheetFor(id);
    res.render('team-detail', {
      user: req.session.user, person, scard, goals, tperiod, spark, daily, sessions,
      canEdit: canEdit(req.session.user.role), showMoney: true, self: false,
      csrfToken: req.csrfToken(), msg: req.query.msg || null,
    });
  } catch (e) { console.error('[hr detail] error:', e.message); res.status(500).send('Could not load this person.'); }
});

// --- Self-service scorecard (any staff, incl. dispatchers) ------------------
router.get('/me/performance', async (req, res) => {
  try {
    const id = req.session.user.id;
    const [urows] = await pool.query('SELECT id, name, email, role, title, phone, hired_at, active FROM staff_users WHERE id=? LIMIT 1', [id]);
    const person = urows[0];
    const period = req.query.period === 'month' ? 'month' : 'week';
    const { scard, goals, tperiod, spark } = await scorecardFor(id, period);
    const { daily, sessions } = await timesheetFor(id);
    res.render('team-detail', {
      user: req.session.user, person, scard, goals, tperiod, spark, daily, sessions,
      canEdit: false, showMoney: showMoneyFor(req.session.user.role), self: true,
      csrfToken: req.csrfToken(), msg: req.query.msg || null,
    });
  } catch (e) { console.error('[hr me] error:', e.message); res.status(500).send('Could not load your performance.'); }
});

// --- Targets & HR profile (management) -------------------------------------
router.post('/team/:id/targets', async (req, res) => {
  if (!canEdit(req.session.user.role)) return res.status(403).render('403', { user: req.session.user, reason: 'section', section: 'team' });
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const period = b.period === 'monthly' ? 'monthly' : 'weekly';
  try {
    for (const metric of ['loads', 'ontime_pct', 'revenue', 'hours']) {
      const v = num(b[metric]);
      if (v == null) await pool.query('DELETE FROM staff_targets WHERE staff_id=? AND metric=? AND period=?', [id, metric, period]);
      else await pool.query(
        `INSERT INTO staff_targets (staff_id, metric, period, target, updated_at) VALUES (?,?,?,?,now())
         ON CONFLICT (staff_id, metric, period) DO UPDATE SET target=EXCLUDED.target, updated_at=now()`, [id, metric, period, v]);
    }
    res.redirect(`/admin/team/${id}?period=${period === 'monthly' ? 'month' : 'week'}&msg=targets`);
  } catch (e) { console.error('[hr targets] error:', e.message); res.redirect(`/admin/team/${id}?msg=err`); }
});
router.post('/team/:id/profile', async (req, res) => {
  if (!canEdit(req.session.user.role)) return res.status(403).render('403', { user: req.session.user, reason: 'section', section: 'team' });
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    await pool.query('UPDATE staff_users SET title=?, phone=?, hired_at=? WHERE id=?', [clip(b.title, 80), clip(b.phone, 40), date(b.hired_at), id]);
    res.redirect(`/admin/team/${id}?msg=profile`);
  } catch (e) { console.error('[hr profile] error:', e.message); res.redirect(`/admin/team/${id}?msg=err`); }
});

// --- Leave / PTO — management list + decisions ------------------------------
router.get('/leave', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT lr.*, u.name AS staff_name, u.role AS staff_role, du.name AS decided_name,
              (lr.end_date - lr.start_date + 1) AS days
         FROM leave_requests lr JOIN staff_users u ON u.id=lr.staff_id
         LEFT JOIN staff_users du ON du.id=lr.decided_by
        ORDER BY (lr.status='pending') DESC, lr.start_date DESC LIMIT 200`);
    res.render('leave', { user: req.session.user, rows, canEdit: canEdit(req.session.user.role), csrfToken: req.csrfToken(), msg: req.query.msg || null });
  } catch (e) { console.error('[hr leave] error:', e.message); res.status(500).send('Could not load leave requests.'); }
});
router.post('/leave/:id/decide', async (req, res) => {
  if (!canEdit(req.session.user.role)) return res.status(403).render('403', { user: req.session.user, reason: 'section', section: 'team' });
  const status = req.body.decision === 'approved' ? 'approved' : (req.body.decision === 'denied' ? 'denied' : null);
  if (!status) return res.redirect('/admin/leave?msg=err');
  try {
    await pool.query('UPDATE leave_requests SET status=?, decided_by=?, decided_at=now() WHERE id=?', [status, req.session.user.id, parseInt(req.params.id, 10)]);
    res.redirect('/admin/leave?msg=' + status);
  } catch (e) { console.error('[hr decide] error:', e.message); res.redirect('/admin/leave?msg=err'); }
});

// --- Leave / PTO — self-service (any staff) ---------------------------------
router.get('/me/leave', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT *, (end_date - start_date + 1) AS days FROM leave_requests WHERE staff_id=? ORDER BY start_date DESC LIMIT 50`, [req.session.user.id]);
    res.render('my-leave', { user: req.session.user, rows, csrfToken: req.csrfToken(), msg: req.query.msg || null });
  } catch (e) { console.error('[hr myleave] error:', e.message); res.status(500).send('Could not load your time off.'); }
});
router.post('/me/leave', async (req, res) => {
  const b = req.body || {};
  const kind = LEAVE_KINDS.includes(b.kind) ? b.kind : 'pto';
  const start = date(b.start_date), end = date(b.end_date);
  if (!start || !end || end < start) return res.redirect('/admin/me/leave?msg=err');
  try {
    await pool.query('INSERT INTO leave_requests (staff_id, kind, start_date, end_date, note) VALUES (?,?,?,?,?)',
      [req.session.user.id, kind, start, end, clip(b.note, 300)]);
    res.redirect('/admin/me/leave?msg=requested');
  } catch (e) { console.error('[hr myleave post] error:', e.message); res.redirect('/admin/me/leave?msg=err'); }
});

// --- SLAs — thresholds + compliance ----------------------------------------
router.get('/sla', async (req, res) => {
  try {
    const [rules] = await pool.query('SELECT * FROM sla_rules ORDER BY id');
    const byCode = {}; rules.forEach((r) => { byCode[r.code] = r; });
    const hrsOf = (code, dflt) => (byCode[code] ? Number(byCode[code].hours) : dflt);
    // Compliance over the last 30 days (team-wide), best-effort from load events.
    const [[assign]] = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (fe.first_evt - l.created_at))/3600.0 <= ?)::int AS ok
         FROM loads l JOIN (SELECT load_id, MIN(created_at) first_evt FROM load_events WHERE kind='status' GROUP BY load_id) fe ON fe.load_id=l.id
        WHERE l.created_at >= now() - interval '30 days'`, [hrsOf('assign', 4)]);
    const [[cc]] = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM load_events e WHERE e.load_id=l.id AND e.kind='check_call' AND e.created_at > now() - (? * interval '1 hour')))::int AS ok
         FROM loads l JOIN board_columns bc ON bc.id=l.column_id WHERE bc.category='in_transit'`, [hrsOf('checkcall', 8)]);
    const [[dv]] = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE l.delivery_date IS NOT NULL)::int AS total,
              COUNT(*) FILTER (WHERE l.delivery_date IS NOT NULL AND l.updated_at::date <= l.delivery_date)::int AS ok
         FROM loads l JOIN board_columns bc ON bc.id=l.column_id
        WHERE bc.category IN ('delivered','done') AND l.updated_at >= now() - interval '30 days'`);
    const compliance = {
      assign: { ...assign, label: 'Carrier assigned in time', desc: `First action within ${hrsOf('assign', 4)}h of a new load` },
      checkcall: { ...cc, label: 'Check-call cadence', desc: `In-transit loads with a check-call in the last ${hrsOf('checkcall', 8)}h` },
      deliver_update: { ...dv, label: 'Delivered on time', desc: 'Marked delivered by the delivery date' },
    };
    const live = await sla.breaches();
    res.render('sla', { user: req.session.user, rules, compliance, live, canEdit: canEdit(req.session.user.role), csrfToken: req.csrfToken(), msg: req.query.msg || null });
  } catch (e) { console.error('[hr sla] error:', e.message); res.status(500).send('Could not load SLAs.'); }
});
router.post('/sla/:id', async (req, res) => {
  if (!canEdit(req.session.user.role)) return res.status(403).render('403', { user: req.session.user, reason: 'section', section: 'team' });
  const hours = num(req.body.hours);
  const active = req.body.active === '1' || req.body.active === 'on';
  try {
    if (hours != null) await pool.query('UPDATE sla_rules SET hours=?, active=? WHERE id=?', [hours, active, parseInt(req.params.id, 10)]);
    res.redirect('/admin/sla?msg=saved');
  } catch (e) { console.error('[hr sla post] error:', e.message); res.redirect('/admin/sla?msg=err'); }
});

module.exports = router;
