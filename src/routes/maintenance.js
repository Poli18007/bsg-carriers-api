'use strict';

// Maintenance — service / repair records for trucks & trailers. Staff-only.

const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const KINDS = ['service', 'repair', 'inspection', 'tire', 'other'];
const STATUSES = ['scheduled', 'in_progress', 'completed'];
const COLS = ['truck_id', 'trailer_id', 'kind', 'description', 'vendor', 'cost', 'odometer', 'service_date', 'next_due_date', 'status'];

function values(b) {
  return {
    truck_id: intOrNull(b.truck_id), trailer_id: intOrNull(b.trailer_id),
    kind: KINDS.includes(b.kind) ? b.kind : 'service', description: clip(b.description, 500), vendor: clip(b.vendor, 160),
    cost: num(b.cost), odometer: intOrNull(b.odometer), service_date: date(b.service_date) || new Date().toISOString().slice(0, 10), next_due_date: date(b.next_due_date),
    status: STATUSES.includes(b.status) ? b.status : 'completed',
  };
}
async function pickers() {
  const [trucks] = await pool.query('SELECT id, number FROM trucks WHERE active ORDER BY number');
  const [trailers] = await pool.query('SELECT id, number FROM trailers WHERE active ORDER BY number');
  return { trucks, trailers };
}

// --- "Search for repairs": live, keyless roadside shop search via OpenStreetMap
// (Nominatim for geocoding, Overpass for nearby POIs). No API key or billing.
const OSM_UA = 'BSG-Carriers-Dispatch/1.0 (https://bsgcarriers.com; info@bsgcarriers.com)';
async function fetchJson(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal, headers: { 'User-Agent': OSM_UA, Accept: 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function geocode(q) {
  // Bias to the US first (so "Ontario, CA" is California, not Canada), then fall
  // back to a global lookup for cross-border runs (type "…, Canada" / a city).
  const j = await fetchJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=' + encodeURIComponent(q), {}, 8000);
  if (Array.isArray(j) && j.length) return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name };
  const j2 = await fetchJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q), {}, 8000);
  if (!Array.isArray(j2) || !j2.length) return null;
  return { lat: +j2[0].lat, lng: +j2[0].lon, label: j2[0].display_name };
}
function milesBetween(aLat, aLng, bLat, bLng) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// The public Overpass instances get busy (503/504) — try several in turn, and
// give each enough time to actually finish (a too-short timeout was aborting
// healthy-but-slow queries before they answered).
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
async function overpass(query) {
  // Ask every mirror at once and take the first that answers — so a slow/busy
  // instance never holds up the response; the fastest healthy one wins.
  const body = 'data=' + encodeURIComponent(query);
  const attempts = OVERPASS_ENDPOINTS.map((url) =>
    fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 16000));
  return Promise.any(attempts); // rejects (AggregateError) only if all mirrors fail
}
async function searchRepairs(lat, lng, radiusMeters) {
  const around = `(around:${radiusMeters},${lat},${lng})`;
  // Lean query — the three repair-relevant shop types only — so it completes
  // fast even on a large radius and is far less likely to be throttled.
  const query = `[out:json][timeout:25];(` +
    `nwr${around}[shop=car_repair];nwr${around}[shop=tyres];nwr${around}[shop=truck_repair];` +
    `);out center tags 120;`;
  const j = await overpass(query);
  const out = (j.elements || []).map((el) => {
    const t = el.tags || {};
    const plat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const plng = el.lon != null ? el.lon : (el.center && el.center.lon);
    const truck = t.shop === 'truck_repair' || t.hgv === 'yes' || t['service:vehicle:truck'] === 'yes' || /\b(truck|diesel|semi|hgv|lorry|fleet)\b/i.test(t.name || '');
    const cat = t.shop === 'tyres' ? 'Tyre shop' : (t.shop === 'truck_repair' ? 'Truck repair' : (t.shop === 'car_parts' ? 'Parts / repair' : 'Mechanic'));
    return {
      name: t.name || null, cat, truck,
      addr: [t['addr:housenumber'], t['addr:street'], t['addr:city'], t['addr:state']].filter(Boolean).join(' ') || null,
      phone: t.phone || t['contact:phone'] || t['contact:mobile'] || null,
      website: t.website || t['contact:website'] || null,
      hours: t.opening_hours || null, lat: plat, lng: plng,
      dist: (plat != null && plng != null) ? milesBetween(lat, lng, plat, plng) : null,
    };
    // A breakdown needs a shop you can call — keep only named shops with a phone.
  }).filter((x) => x.lat != null && x.lng != null && x.name && x.phone);
  out.sort((a, b) => (a.dist == null ? 1e9 : a.dist) - (b.dist == null ? 1e9 : b.dist));
  return out;
}

router.get('/maintenance/repairs', async (req, res) => {
  const q = (req.query.q || '').toString().trim().slice(0, 200);
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radiusMi = [10, 25, 50].includes(parseInt(req.query.radius, 10)) ? parseInt(req.query.radius, 10) : 25;
  const truckOnly = req.query.truck === '1';
  let center = null, results = null, error = null, searched = false, truckFellBack = false;
  try {
    if (Number.isFinite(lat) && Number.isFinite(lng)) center = { lat, lng, label: 'Your current location' };
    else if (q) { center = await geocode(q); if (!center) error = "Couldn't find that location. Try “city, state”, a ZIP, or use your current location."; }
    if (center) {
      const found = await searchRepairs(center.lat, center.lng, radiusMi * 1609);
      // Truck-capable is a preference, not a dead-end: OSM rarely tags a shop as
      // truck-specific, so if none match we still show all repair shops (with a
      // note) rather than leaving a broken-down driver with nothing.
      if (truckOnly) {
        const tk = found.filter((r) => r.truck);
        if (tk.length) { results = tk; }
        else { results = found; truckFellBack = found.length > 0; }
      } else { results = found; }
      searched = true;
    }
  } catch (e) {
    console.error('[repairs] search error:', e.message, e.cause && e.cause.code);
    error = 'The free map service is busy right now. Try again in a moment — and it helps to search a nearby town or ZIP (rather than a highway name) and a smaller radius.';
  }
  res.render('repairs', { user: req.session.user, q, radiusMi, truckOnly, truckFellBack, center, results, error, searched, csrfToken: req.csrfToken() });
});

router.get('/maintenance', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const where = status ? 'WHERE m.status = ?' : '';
  const params = status ? [status] : [];
  const [rows] = await pool.query(
    `SELECT m.*, tk.number AS truck_number, tr.number AS trailer_number
       FROM maintenance_records m LEFT JOIN trucks tk ON tk.id=m.truck_id LEFT JOIN trailers tr ON tr.id=m.trailer_id
       ${where} ORDER BY m.service_date DESC, m.id DESC LIMIT 400`, params);
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('scheduled','in_progress'))::int AS open,
            COUNT(*) FILTER (WHERE next_due_date IS NOT NULL AND next_due_date <= CURRENT_DATE + 14)::int AS due_soon,
            COALESCE(SUM(cost),0) AS total_cost FROM maintenance_records`);
  res.render('maintenance', { user: req.session.user, rows, counts, filter: { status } });
});
router.get('/maintenance/new', async (req, res) => {
  const p = await pickers();
  res.render('maintenance-form', { user: req.session.user, rec: { status: 'completed', kind: 'service' }, ...p, kinds: KINDS, statuses: STATUSES, csrfToken: req.csrfToken(), isNew: true });
});
router.post('/maintenance', async (req, res) => {
  const v = values(req.body || {});
  await pool.query(`INSERT INTO maintenance_records (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map((k) => v[k]));
  res.redirect('/admin/maintenance');
});
router.get('/maintenance/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM maintenance_records WHERE id=? LIMIT 1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  const p = await pickers();
  res.render('maintenance-form', { user: req.session.user, rec: rows[0], ...p, kinds: KINDS, statuses: STATUSES, csrfToken: req.csrfToken(), isNew: false });
});
router.post('/maintenance/:id', async (req, res) => {
  const v = values(req.body || {});
  await pool.query(`UPDATE maintenance_records SET ${COLS.map((k) => k + '=?').join(', ')} WHERE id=?`, [...COLS.map((k) => v[k]), req.params.id]);
  res.redirect('/admin/maintenance');
});
router.post('/maintenance/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM maintenance_records WHERE id=?', [req.params.id]);
  res.redirect('/admin/maintenance');
});

module.exports = router;
