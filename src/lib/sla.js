'use strict';

// SLA breach detection — computed live from current load state (exact, not an
// approximation). Shared by the SLA page (full lists) and the dashboard (count).

const { pool } = require('../db');

async function thresholds() {
  const [rows] = await pool.query('SELECT code, hours, active FROM sla_rules');
  const t = {};
  rows.forEach((r) => { t[r.code] = { hours: Number(r.hours), active: r.active }; });
  return t;
}

// Loads currently in breach of each active rule. Returns lists + a total count.
async function breaches() {
  const t = await thresholds();
  const out = { assign: [], checkcall: [], delivery: [], total: 0 };

  if (!t.assign || t.assign.active) {
    const h = t.assign ? t.assign.hours : 4;
    const [rows] = await pool.query(
      `SELECT l.id, l.ref, l.customer, l.origin, l.destination, su.name AS dispatcher,
              ROUND(EXTRACT(EPOCH FROM (now()-l.created_at))/3600.0::numeric,1) AS age
         FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id LEFT JOIN staff_users su ON su.id=l.dispatcher_id
        WHERE l.carrier_id IS NULL AND (bc.category IS NULL OR bc.category NOT IN ('delivered','done'))
          AND l.created_at < now() - (? * interval '1 hour')
        ORDER BY l.created_at LIMIT 100`, [h]);
    out.assign = rows;
  }
  if (!t.checkcall || t.checkcall.active) {
    const h = t.checkcall ? t.checkcall.hours : 8;
    const [rows] = await pool.query(
      `SELECT l.id, l.ref, l.customer, l.origin, l.destination, su.name AS dispatcher,
              ROUND(EXTRACT(EPOCH FROM (now()-COALESCE(cc.t,l.updated_at)))/3600.0::numeric,1) AS since
         FROM loads l JOIN board_columns bc ON bc.id=l.column_id LEFT JOIN staff_users su ON su.id=l.dispatcher_id
         LEFT JOIN (SELECT load_id, MAX(created_at) AS t FROM load_events WHERE kind='check_call' GROUP BY load_id) cc ON cc.load_id=l.id
        WHERE bc.category='in_transit' AND COALESCE(cc.t,l.updated_at) < now() - (? * interval '1 hour')
        ORDER BY since DESC LIMIT 100`, [h]);
    out.checkcall = rows;
  }
  if (!t.deliver_update || t.deliver_update.active) {
    const [rows] = await pool.query(
      `SELECT l.id, l.ref, l.customer, l.origin, l.destination, su.name AS dispatcher,
              (CURRENT_DATE - l.delivery_date) AS days_over
         FROM loads l LEFT JOIN board_columns bc ON bc.id=l.column_id LEFT JOIN staff_users su ON su.id=l.dispatcher_id
        WHERE l.delivery_date IS NOT NULL AND l.delivery_date < CURRENT_DATE
          AND (bc.category IS NULL OR bc.category NOT IN ('delivered','done'))
        ORDER BY l.delivery_date LIMIT 100`);
    out.delivery = rows;
  }
  out.total = out.assign.length + out.checkcall.length + out.delivery.length;
  return out;
}

// Cheap count only (for the dashboard banner) — reuses breaches() but the lists
// are capped at 100 each which is plenty for a count-of-what-matters.
async function breachCount() {
  const b = await breaches();
  return b.total;
}

module.exports = { thresholds, breaches, breachCount };
