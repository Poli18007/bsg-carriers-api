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
  admin: ['dispatch', 'fleet', 'partners', 'billing', 'reports', 'inbox', 'staff'],
  manager: ['dispatch', 'fleet', 'partners', 'billing', 'reports', 'inbox'],
  staff: ['dispatch', 'fleet', 'partners', 'billing', 'reports', 'inbox'], // legacy
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
  leads: 'inbox',
  users: 'staff',
  'delete-requests': 'staff',
};

const sectionsFor = (role) => ROLE_SECTIONS[role] || ROLE_SECTIONS.viewer;
const can = (role, section) => sectionsFor(role).includes(section);
const readOnly = (role) => role === 'viewer';

// Segments a read-only user may still POST to (self-service).
const SELF_SERVICE = ['logout', 'settings'];
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

async function guard(req, res, next) {
  const user = req.session && req.session.user;
  if (user) {
    res.locals.sections = sectionsFor(user.role);
    res.locals.role = user.role;
    res.locals.readOnly = readOnly(user.role);
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

module.exports = { ROLES, ROLE_KEYS, VALID_ROLES, ROLE_SECTIONS, sectionsFor, can, readOnly, guard };
