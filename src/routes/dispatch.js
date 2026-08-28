'use strict';

// Dispatch operations (Phase 3 + 3.1) — brokers, drivers, loads, the dispatch
// board (table + kanban), per-load documents, accessorials and a check-call
// timeline. Staff-only; mounted under /admin.

const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();
router.use(requireLogin);

const LOAD_STATUSES = ['available', 'booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled'];
const KANBAN_COLUMNS = ['booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid'];
const ACTIVE = ['booked', 'dispatched', 'in_transit'];

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const lane = (city, st) => [clip(city, 80), clip(st, 20)].filter(Boolean).join(', ') || null;

const MAX_FILE = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 1 } });
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

async function logEvent(loadId, email, kind, body) {
  try { await pool.query('INSERT INTO load_events (load_id, staff_email, kind, body) VALUES (?,?,?,?)', [loadId, email || null, kind, body]); }
  catch (_) { /* timeline logging must never break the request */ }
}

// Board + editable-column helpers.
async function getBoard(kind) {
  const [rows] = await pool.query('SELECT * FROM boards WHERE kind = ? LIMIT 1', [kind]);
  return rows[0] || null;
}
async function getColumns(boardId) {
  const [rows] = await pool.query('SELECT * FROM board_columns WHERE board_id = ? ORDER BY sort, id', [boardId]);
  return rows;
}
const CATEGORIES = ['active', 'in_transit', 'delivered', 'done', 'yard', 'other'];

// ---- Column management (per board) -----------------------------------------
router.get('/boards/:id/columns', async (req, res) => {
  const [brows] = await pool.query('SELECT * FROM boards WHERE id = ? LIMIT 1', [req.params.id]);
  if (!brows[0]) return res.status(404).send('Not found');
  const columns = await getColumns(brows[0].id);
  res.render('columns', { user: req.session.user, board: brows[0], columns, categories: CATEGORIES, csrfToken: req.csrfToken() });
});
router.post('/boards/:id/columns', async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 80);
  if (name) {
    const [[m]] = await pool.query('SELECT COALESCE(MAX(sort),-1)+1 AS n FROM board_columns WHERE board_id = ?', [req.params.id]);
    await pool.query('INSERT INTO board_columns (board_id, name, sort, color, category) VALUES (?,?,?,?,?) ON CONFLICT (board_id, name) DO NOTHING',
      [req.params.id, name, m.n, (req.body.color || '#9a9ba3').slice(0, 20), CATEGORIES.includes(req.body.category) ? req.body.category : 'other']);
  }
  res.redirect('/admin/boards/' + req.params.id + '/columns');
});
router.post('/columns/:id', async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 80);
  await pool.query('UPDATE board_columns SET name = COALESCE(NULLIF(?,\'\'), name), color = ?, category = ? WHERE id = ?',
    [name, (req.body.color || '#9a9ba3').slice(0, 20), CATEGORIES.includes(req.body.category) ? req.body.category : 'other', req.params.id]);
  const [[c]] = await pool.query('SELECT board_id FROM board_columns WHERE id = ?', [req.params.id]);
  res.redirect('/admin/boards/' + (c ? c.board_id : '') + '/columns');
});
// Reorder by swapping sort with the neighbour in the given direction.
router.post('/columns/:id/move', async (req, res) => {
  const dir = req.body.dir === 'up' ? 'up' : 'down';
  const [[c]] = await pool.query('SELECT id, board_id, sort FROM board_columns WHERE id = ?', [req.params.id]);
  if (c) {
    const cmp = dir === 'up' ? '<' : '>';
    const order = dir === 'up' ? 'DESC' : 'ASC';
    const [[nb]] = await pool.query(`SELECT id, sort FROM board_columns WHERE board_id = ? AND sort ${cmp} ? ORDER BY sort ${order} LIMIT 1`, [c.board_id, c.sort]);
    if (nb) {
      await pool.query('UPDATE board_columns SET sort = ? WHERE id = ?', [nb.sort, c.id]);
      await pool.query('UPDATE board_columns SET sort = ? WHERE id = ?', [c.sort, nb.id]);
    }
    return res.redirect('/admin/boards/' + c.board_id + '/columns');
  }
  res.redirect('/admin/loads');
});
// Delete a column, moving its cards to another column on the same board first.
router.post('/columns/:id/delete', async (req, res) => {
  const [[c]] = await pool.query('SELECT id, board_id FROM board_columns WHERE id = ?', [req.params.id]);
  if (c) {
    const [[fallback]] = await pool.query('SELECT id FROM board_columns WHERE board_id = ? AND id <> ? ORDER BY sort, id LIMIT 1', [c.board_id, c.id]);
    if (fallback) {
      await pool.query('UPDATE loads SET column_id = ? WHERE column_id = ?', [fallback.id, c.id]);
      await pool.query('DELETE FROM board_columns WHERE id = ?', [c.id]);
    }
    return res.redirect('/admin/boards/' + c.board_id + '/columns');
  }
  res.redirect('/admin/loads');
});

// ---- Brokers ---------------------------------------------------------------
router.get('/brokers', async (req, res) => {
  const q = (req.query.q || '').toString().trim().slice(0, 100);
  const where = q ? 'WHERE name LIKE ? OR contact_name LIKE ? OR mc_number LIKE ?' : '';
  const params = q ? ['%' + q + '%', '%' + q + '%', '%' + q + '%'] : [];
  const [rows] = await pool.query(
    `SELECT b.*, (SELECT COUNT(*) FROM loads l WHERE l.broker_id = b.id)::int AS load_count
       FROM brokers b ${where} ORDER BY b.name LIMIT 300`, params);
  res.render('brokers', { user: req.session.user, rows, q });
});
router.get('/brokers/new', (req, res) => res.render('broker-form', { user: req.session.user, broker: {}, csrfToken: req.csrfToken(), isNew: true }));
router.post('/brokers', async (req, res) => {
  const b = req.body || {};
  if (!clip(b.name, 200)) return res.status(400).render('broker-form', { user: req.session.user, broker: b, csrfToken: req.csrfToken(), isNew: true, error: 'Broker name is required.' });
  await pool.query('INSERT INTO brokers (name, contact_name, phone, email, mc_number, notes) VALUES (?,?,?,?,?,?)',
    [clip(b.name, 200), clip(b.contact_name, 160), clip(b.phone, 60), clip(b.email, 200), clip(b.mc_number, 40), clip(b.notes, 2000)]);
  res.redirect('/admin/brokers');
});
router.get('/brokers/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM brokers WHERE id = ? LIMIT 1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  res.render('broker-form', { user: req.session.user, broker: rows[0], csrfToken: req.csrfToken(), isNew: false });
});
router.post('/brokers/:id', async (req, res) => {
  const b = req.body || {};
  await pool.query('UPDATE brokers SET name=?, contact_name=?, phone=?, email=?, mc_number=?, notes=? WHERE id=?',
    [clip(b.name, 200) || 'Unnamed broker', clip(b.contact_name, 160), clip(b.phone, 60), clip(b.email, 200), clip(b.mc_number, 40), clip(b.notes, 2000), req.params.id]);
  res.redirect('/admin/brokers');
});

// ---- Drivers (managed on the carrier detail page) --------------------------
router.post('/carriers/:id/drivers', async (req, res) => {
  const d = req.body || {};
  if (clip(d.name, 160)) {
    await pool.query('INSERT INTO drivers (carrier_id, name, phone, email, cdl_number, cdl_state) VALUES (?,?,?,?,?,?)',
      [req.params.id, clip(d.name, 160), clip(d.phone, 60), clip(d.email, 200), clip(d.cdl_number, 40), clip(d.cdl_state, 10)]);
  }
  res.redirect('/admin/carriers/' + encodeURIComponent(req.params.id));
});
router.post('/drivers/:id/remove', async (req, res) => {
  const [rows] = await pool.query('SELECT carrier_id FROM drivers WHERE id = ?', [req.params.id]);
  await pool.query('UPDATE drivers SET active = NOT active WHERE id = ?', [req.params.id]);
  res.redirect('/admin/carriers/' + encodeURIComponent(rows[0] ? rows[0].carrier_id : ''));
});

// ---- Loads: board (table) --------------------------------------------------
router.get('/loads', async (req, res) => {
  const board = await getBoard('loads');
  const columns = await getColumns(board.id);
  const colId = intOrNull(req.query.column);
  const carrier = intOrNull(req.query.carrier);
  const label = intOrNull(req.query.label);
  const q = (req.query.q || '').toString().trim().slice(0, 100);
  const clauses = [];
  const params = [];
  if (colId) { clauses.push('l.column_id = ?'); params.push(colId); }
  if (carrier) { clauses.push('l.carrier_id = ?'); params.push(carrier); }
  if (label) { clauses.push('l.label_id = ?'); params.push(label); }
  if (q) {
    clauses.push('(l.ref LIKE ? OR l.customer LIKE ? OR l.origin LIKE ? OR l.destination LIKE ? OR b.name LIKE ? OR c.company_name LIKE ?)');
    const like = '%' + q + '%'; params.push(like, like, like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const [rows] = await pool.query(
    `SELECT l.*, b.name AS broker_name, c.company_name AS carrier_name,
            bc.name AS col_name, bc.color AS col_color, lb.name AS label_name, lb.color AS label_color
       FROM loads l
       LEFT JOIN brokers b ON b.id=l.broker_id LEFT JOIN carriers c ON c.id=l.carrier_id
       LEFT JOIN board_columns bc ON bc.id=l.column_id LEFT JOIN labels lb ON lb.id=l.label_id
       ${where} ORDER BY bc.sort NULLS LAST, l.pickup_date NULLS LAST, l.id DESC LIMIT 400`, params);
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE bc.category IN ('active','in_transit'))::int AS active,
            COUNT(*) FILTER (WHERE bc.category='in_transit')::int AS in_transit,
            COUNT(*) FILTER (WHERE bc.category='delivered')::int AS delivered,
            COALESCE(SUM(l.rate) FILTER (WHERE bc.category IN ('active','in_transit')),0) AS active_rate
       FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id`);
  const [labels] = await pool.query('SELECT id, name, color FROM labels ORDER BY sort, id');
  res.render('loads', { user: req.session.user, board, columns, labels, rows, counts, filter: { column: colId, carrier, label, q } });
});

// ---- Loads: kanban ---------------------------------------------------------
router.get('/board', async (req, res) => {
  const board = await getBoard('loads');
  const columns = await getColumns(board.id);
  const [rows] = await pool.query(
    `SELECT l.id, l.ref, l.customer, l.origin, l.destination, l.rate, l.column_id, l.pickup_date,
            c.company_name AS carrier_name, lb.name AS label_name, lb.color AS label_color
       FROM loads l LEFT JOIN carriers c ON c.id=l.carrier_id LEFT JOIN labels lb ON lb.id=l.label_id
       ORDER BY l.pickup_date NULLS LAST, l.id DESC LIMIT 500`);
  const byCol = {}; columns.forEach((c) => { byCol[c.id] = []; });
  rows.forEach((l) => { if (byCol[l.column_id]) byCol[l.column_id].push(l); });
  res.render('board', { user: req.session.user, board, columns, byCol, csrfToken: req.csrfToken() });
});

// Move a load to a column (kanban drag, quick buttons). Logs a timeline event.
router.post('/loads/:id/column', async (req, res) => {
  const colId = intOrNull(req.body.column_id);
  if (colId) {
    await pool.query('UPDATE loads SET column_id = ?, updated_at = now() WHERE id = ?', [colId, req.params.id]);
    const [[c]] = await pool.query('SELECT name FROM board_columns WHERE id = ?', [colId]);
    await logEvent(req.params.id, req.session.user.email, 'status', 'Moved → ' + (c ? c.name : 'column'));
  }
  if (req.get('x-requested-with') === 'fetch') return res.json({ ok: true });
  const ref = req.get('referer') || '';
  res.redirect(ref.includes('/loads/') || ref.includes('/board') ? ref : '/admin/loads');
});

async function formData() {
  const [brokers] = await pool.query('SELECT id, name FROM brokers ORDER BY name');
  const [carriers] = await pool.query("SELECT id, company_name FROM carriers WHERE status <> 'rejected' ORDER BY company_name");
  const [drivers] = await pool.query(
    `SELECT d.id, d.name, d.carrier_id, c.company_name FROM drivers d JOIN carriers c ON c.id=d.carrier_id
       WHERE d.active ORDER BY c.company_name, d.name`);
  const board = await getBoard('loads');
  const [columns] = await pool.query('SELECT id, name FROM board_columns WHERE board_id = ? ORDER BY sort, id', [board.id]);
  const [labels] = await pool.query('SELECT id, name, color FROM labels ORDER BY sort, id');
  const [dispatchers] = await pool.query('SELECT id, name FROM staff_users WHERE active ORDER BY name');
  return { brokers, carriers, drivers, columns, labels, dispatchers };
}

function loadValues(b) {
  return {
    ref: clip(b.ref, 60), broker_id: intOrNull(b.broker_id), carrier_id: intOrNull(b.carrier_id), driver_id: intOrNull(b.driver_id),
    column_id: intOrNull(b.column_id), label_id: intOrNull(b.label_id), dispatcher_id: intOrNull(b.dispatcher_id),
    customer: clip(b.customer, 200), pu_number: clip(b.pu_number, 60),
    origin: lane(b.pickup_city, b.pickup_state), destination: lane(b.delivery_city, b.delivery_state),
    pickup_name: clip(b.pickup_name, 200), pickup_address: clip(b.pickup_address, 255), pickup_city: clip(b.pickup_city, 80),
    pickup_state: clip(b.pickup_state, 20), pickup_zip: clip(b.pickup_zip, 20), pickup_appt: clip(b.pickup_appt, 60),
    pickup_ref: clip(b.pickup_ref, 80), pickup_instructions: clip(b.pickup_instructions, 1000),
    delivery_name: clip(b.delivery_name, 200), delivery_address: clip(b.delivery_address, 255), delivery_city: clip(b.delivery_city, 80),
    delivery_state: clip(b.delivery_state, 20), delivery_zip: clip(b.delivery_zip, 20), delivery_appt: clip(b.delivery_appt, 60),
    delivery_ref: clip(b.delivery_ref, 80), delivery_instructions: clip(b.delivery_instructions, 1000),
    commodity: clip(b.commodity, 160), weight: clip(b.weight, 40), equipment: clip(b.equipment, 80),
    miles: intOrNull(b.miles), rate: num(b.rate), status: LOAD_STATUSES.includes(b.status) ? b.status : 'booked', notes: clip(b.notes, 4000),
  };
}
const LOAD_COLS = ['ref', 'broker_id', 'carrier_id', 'driver_id', 'column_id', 'label_id', 'dispatcher_id', 'customer', 'pu_number',
  'origin', 'destination', 'pickup_name', 'pickup_address', 'pickup_city',
  'pickup_state', 'pickup_zip', 'pickup_appt', 'pickup_ref', 'pickup_instructions', 'delivery_name', 'delivery_address', 'delivery_city',
  'delivery_state', 'delivery_zip', 'delivery_appt', 'delivery_ref', 'delivery_instructions', 'commodity', 'weight', 'equipment', 'miles', 'rate', 'status', 'notes'];

router.get('/loads/new', async (req, res) => {
  const fd = await formData();
  res.render('load-form', { user: req.session.user, load: { status: 'booked' }, ...fd, statuses: LOAD_STATUSES, csrfToken: req.csrfToken(), isNew: true, docs: [], accessorials: [], events: [], owed: null });
});

router.post('/loads', async (req, res) => {
  const v = loadValues(req.body || {});
  if (!v.column_id) {
    const board = await getBoard('loads');
    const [[first]] = await pool.query('SELECT id FROM board_columns WHERE board_id = ? ORDER BY sort, id LIMIT 1', [board.id]);
    v.column_id = first ? first.id : null;
  }
  const [rows] = await pool.query(
    `INSERT INTO loads (${LOAD_COLS.join(',')}) VALUES (${LOAD_COLS.map(() => '?').join(',')}) RETURNING id`,
    LOAD_COLS.map((k) => v[k]));
  await logEvent(rows[0].id, req.session.user.email, 'status', 'Load created');
  res.redirect('/admin/loads/' + rows[0].id);
});

router.get('/loads/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM loads WHERE id = ? LIMIT 1', [req.params.id]);
  const load = rows[0];
  if (!load) return res.status(404).send('Not found');
  const fd = await formData();
  const [docs] = await pool.query('SELECT id, doc_type, filename, size_bytes, uploaded_at FROM load_documents WHERE load_id=? ORDER BY uploaded_at DESC', [load.id]);
  const [accessorials] = await pool.query('SELECT * FROM load_accessorials WHERE load_id=? ORDER BY id', [load.id]);
  const [events] = await pool.query('SELECT * FROM load_events WHERE load_id=? ORDER BY created_at DESC LIMIT 100', [load.id]);
  const [[owedRow]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS acc FROM load_accessorials WHERE load_id=?', [load.id]);
  const owed = (Number(load.rate) || 0) + (Number(owedRow.acc) || 0);
  res.render('load-form', { user: req.session.user, load, ...fd, statuses: LOAD_STATUSES, csrfToken: req.csrfToken(), isNew: false, docs, accessorials, events, owed });
});

router.post('/loads/:id', async (req, res) => {
  const v = loadValues(req.body || {});
  await pool.query(
    `UPDATE loads SET ${LOAD_COLS.map((k) => k + '=?').join(', ')}, updated_at=now() WHERE id=?`,
    [...LOAD_COLS.map((k) => v[k]), req.params.id]);
  res.redirect('/admin/loads/' + encodeURIComponent(req.params.id));
});

// Status change (from board card, kanban drag, or detail). Logs a timeline event.
router.post('/loads/:id/status', async (req, res) => {
  const status = LOAD_STATUSES.includes(req.body.status) ? req.body.status : null;
  if (status) {
    await pool.query('UPDATE loads SET status=?, updated_at=now() WHERE id=?', [status, req.params.id]);
    await logEvent(req.params.id, req.session.user.email, 'status', 'Status → ' + status.replace('_', ' '));
  }
  if (req.get('x-requested-with') === 'fetch') return res.json({ ok: true, status });
  const ref = req.get('referer') || '';
  res.redirect(ref.includes('/loads/') || ref.includes('/board') ? ref : '/admin/loads');
});

// ---- Load documents --------------------------------------------------------
router.post('/loads/:id/documents', (req, res) => {
  upload.single('document')(req, res, async (err) => {
    if (err) return res.redirect('/admin/loads/' + req.params.id);
    const f = req.file;
    const docType = ['rate_con', 'bol', 'pod', 'other'].includes(req.body.doc_type) ? req.body.doc_type : 'other';
    if (f && ALLOWED_MIME.has(f.mimetype)) {
      await pool.query('INSERT INTO load_documents (load_id, doc_type, filename, mime_type, size_bytes, content) VALUES (?,?,?,?,?,?)',
        [req.params.id, docType, f.originalname.slice(0, 255), f.mimetype, f.size, f.buffer]);
      await logEvent(req.params.id, req.session.user.email, 'note', 'Uploaded ' + docType.replace('_', ' ') + ': ' + f.originalname);
    }
    res.redirect('/admin/loads/' + req.params.id);
  });
});
router.get('/loads/:id/documents/:docId', async (req, res) => {
  const [rows] = await pool.query('SELECT filename, mime_type, content FROM load_documents WHERE id=? AND load_id=? LIMIT 1', [req.params.docId, req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  res.setHeader('Content-Type', rows[0].mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].filename.replace(/"/g, '')}"`);
  res.send(rows[0].content);
});
router.post('/loads/:id/documents/:docId/delete', async (req, res) => {
  await pool.query('DELETE FROM load_documents WHERE id=? AND load_id=?', [req.params.docId, req.params.id]);
  res.redirect('/admin/loads/' + req.params.id);
});

// ---- Accessorials ----------------------------------------------------------
router.post('/loads/:id/accessorials', async (req, res) => {
  const kind = ['detention', 'layover', 'tonu', 'lumper', 'fuel', 'other'].includes(req.body.kind) ? req.body.kind : 'other';
  const amount = num(req.body.amount) || 0;
  await pool.query('INSERT INTO load_accessorials (load_id, kind, amount, notes) VALUES (?,?,?,?)', [req.params.id, kind, amount, clip(req.body.notes, 500)]);
  await logEvent(req.params.id, req.session.user.email, 'note', `Accessorial: ${kind} $${amount.toFixed(2)}`);
  res.redirect('/admin/loads/' + req.params.id);
});
router.post('/loads/:id/accessorials/:accId/delete', async (req, res) => {
  await pool.query('DELETE FROM load_accessorials WHERE id=? AND load_id=?', [req.params.accId, req.params.id]);
  res.redirect('/admin/loads/' + req.params.id);
});

// ---- Timeline (check calls / notes) ----------------------------------------
router.post('/loads/:id/events', async (req, res) => {
  const kind = req.body.kind === 'check_call' ? 'check_call' : 'note';
  const body = clip(req.body.body, 1000);
  if (body) await logEvent(req.params.id, req.session.user.email, kind, body);
  res.redirect('/admin/loads/' + req.params.id);
});

module.exports = router;
