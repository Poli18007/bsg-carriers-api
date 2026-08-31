'use strict';

// Role-based access. Each role can see a set of nav "sections"; a middleware
// maps the request path to a section and blocks a role that isn't allowed it.
// The `viewer` role is read-only: it may open allowed sections but not POST
// (except to sign out or change its own password).

const { pool } = require('../db');

// Roles offered in the Staff picker, with a one-line description.
const ROLES = [
  { key: 'admin', label: 'Admin', blurb: 'Full access — everything, plus staff and settings.' },
  { key: 'manager', label: 'Manager', blurb: 'Everything except managing staff accounts.' },
  { key: 'dispatcher', label: 'Dispatcher', blurb: 'Loads, boards, trips, fleet and partners — no billing.' },
  { key: 'billing', label: 'Billing', blurb: 'Invoices, expenses and reports (plus viewing dispatch).' },
  { key: 'viewer', label: 'Viewer', blurb: 'Read-only across the whole system.' },
];
const ROLE_KEYS = ROLES.map((r) => r.key);
const VALID_ROLES = ROLE_KEYS.concat('staff'); // 'staff' kept as a legacy alias of manager

// Which sections each role may open.
const ROLE_SECTIONS = {
  admin: ['dispatch', 'fleet', 'partners', 'billing', 'reports', 'inbox', 'team', 'staff'],
  manager: ['dispatch', 'fleet', 'partners', 'billing', 'reports', 'inbox', 'team'],
  staff: ['dispatch', 'fleet', 'partners', 'billing', 'reports', 'inbox', 'team'], // legacy
  dispatcher: ['dispatch', 'fleet', 'partners', 'inbox'],
  billing: ['dispatch', 'billing', 'reports', 'partners'],
  viewer: ['dispatch', 'fleet', 'partners', 'billing', 'reports', 'inbox'],
};

// First path segment under /admin -> section. Anything not listed (settings,
// login, logout, brand, health) is allowed for any signed-in user.
const SECTION_OF = {
  '': 'dispatch', loads: 'dispatch', board: 'dispatch', boards: 'dispatch', columns: 'dispatch', trailers: 'dispatch', trips: 'dispatch',
  trucks: 'fleet', maintenance: 'fleet', dvir: 'fleet',
  carriers: 'partners', customers: 'partners', brokers: 'partners', drivers: 'partners',
  invoices: 'billing', expenses: 'billing',
  reports: 'reports',
  team: 'team', leave: 'team', sla: 'team',
  leads: 'inbox',
  users: 'staff',
  'delete-requests': 'staff',
};

const sectionsFor = (role) => ROLE_SECTIONS[role] || ROLE_SECTIONS.viewer;
const can = (role, section) => sectionsFor(role).includes(section);
const readOnly = (role) => role === 'viewer';
// Carrier onboarding approval (approve/reject docs, set status, request
// renewals) is limited to admins and managers. Everyone else is read-only.
const canApprove = (role) => role === 'admin' || role === 'manager' || role === 'staff';

// Segments a read-only user may still POST to (self-service).
const SELF_SERVICE = ['logout', 'settings'];
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

const IDLE_MS = 20 * 60 * 1000; // a gap longer than this closes the session

async function guard(req, res, next) {
  const user = req.session && req.session.user;
  if (user) {
    res.locals.sections = sectionsFor(user.role);
    res.locals.role = user.role;
    res.locals.readOnly = readOnly(user.role);
    // Attendance heartbeat — throttled to once/min via a session marker so the
    // several guard passes per request don't each hit the DB. If the last beat
    // was longer than the idle window ago, close the stale session and open a
    // fresh one so long away-gaps aren't counted as worked time.
    if (user.sid) {
      const now = Date.now();
      const last = req.session.hbAt || 0;
      if (now - last > 60000) {
        req.session.hbAt = now;
        try {
          if (now - last > IDLE_MS) {
            await pool.query("UPDATE staff_sessions SET logout_at=last_seen_at, ended_reason='idle' WHERE id=? AND logout_at IS NULL", [user.sid]);
            const [ins] = await pool.query('INSERT INTO staff_sessions (staff_id) VALUES (?) RETURNING id', [user.id]);
            req.session.user.sid = ins[0].id;
          } else {
            await pool.query('UPDATE staff_sessions SET last_seen_at=now() WHERE id=? AND logout_at IS NULL', [user.sid]);
          }
        } catch (_) { /* attendance is best-effort; never block the request */ }
      }
    }
    // Pending-delete-request badge for admins, fetched once per request.
    if (user.role === 'admin' && res.locals.deleteRequests === undefined) {
      try { const [r] = await pool.query('SELECT COUNT(*)::int AS n FROM loads WHERE delete_requested_by IS NOT NULL'); res.locals.deleteRequests = r[0].n; }
      catch (_) { res.locals.deleteRequests = 0; }
    }
  }
  if (!user) return next(); // requireLogin downstream handles the redirect

  const seg = (req.path.split('/')[1] || '').toLowerCase();
  const section = SECTION_OF[seg];
  if (section && !can(user.role, section)) {
    return res.status(403).render('403', { user, reason: 'section', section });
  }
  if (readOnly(user.role) && MUTATING.includes(req.method) && !SELF_SERVICE.includes(seg)) {
    return res.status(403).render('403', { user, reason: 'readonly', section });
  }
  next();
}

module.exports = { ROLES, ROLE_KEYS, VALID_ROLES, ROLE_SECTIONS, sectionsFor, can, readOnly, canApprove, guard };
