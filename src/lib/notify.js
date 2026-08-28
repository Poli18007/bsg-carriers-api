'use strict';

// New-lead notifications: email (cPanel SMTP) and Slack (incoming webhook).
//
// Both are best-effort and fire AFTER the submission is already saved, so a mail
// outage or a bad webhook never costs BSG the lead — it just costs the alert,
// and every attempt is written to notifications_log for diagnosis.

const nodemailer = require('nodemailer');
const { pool } = require('../db');

let transporter = null;
function mailer() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function logDelivery(submissionId, channel, ok, detail) {
  try {
    await pool.query(
      'INSERT INTO notifications_log (submission_id, channel, ok, detail) VALUES (?,?,?,?)',
      [submissionId, channel, ok ? 1 : 0, (detail || '').slice(0, 500)]
    );
  } catch (_) { /* logging must never throw into the request path */ }
}

const TITLES = {
  contact: 'New contact enquiry',
  onboarding: 'New carrier onboarding application',
};

// Ordered, human-readable lines for the email/Slack body, from the raw data.
function lines(sub) {
  const d = sub.data || {};
  const order = [
    'Full name', 'Company name', 'Phone', 'Phone number', 'Email', 'Email address',
    'MC number', 'DOT number', 'Truck / equipment type', 'Number of trucks',
    'Current location', 'Preferred lanes', 'Reason', 'How did you hear about us?',
    'Message', 'Additional message', 'Authority and insurance confirmed',
  ];
  const seen = new Set();
  const out = [];
  for (const k of order) {
    if (d[k] != null && String(d[k]).trim() !== '') { out.push([k, String(d[k])]); seen.add(k); }
  }
  for (const [k, v] of Object.entries(d)) {
    if (!seen.has(k) && v != null && String(v).trim() !== '') out.push([k, String(v)]);
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendEmail(sub) {
  const t = mailer();
  if (!t) { await logDelivery(sub.id, 'email', false, 'SMTP not configured'); return; }
  const title = TITLES[sub.type] || 'New website submission';
  const rows = lines(sub).map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:4px 0">${esc(v)}</td></tr>`).join('');
  const adminUrl = process.env.ADMIN_URL || '';
  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;color:#111">` +
    `<h2 style="margin:0 0 4px">${esc(title)}</h2>` +
    `<div style="color:#888;margin-bottom:12px">via bsgcarriers.com · #${sub.id}</div>` +
    `<table style="border-collapse:collapse">${rows}</table>` +
    (adminUrl ? `<p style="margin-top:16px"><a href="${esc(adminUrl)}">Open in the dashboard →</a></p>` : '') +
    `</div>`;
  const text = `${title} (#${sub.id})\n\n` + lines(sub).map(([k, v]) => `${k}: ${v}`).join('\n');

  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: process.env.MAIL_TO,
      replyTo: sub.columns && sub.columns.email ? sub.columns.email : undefined,
      subject: `${title} — ${sub.columns && sub.columns.full_name ? sub.columns.full_name : 'website'}`,
      text, html,
    });
    await logDelivery(sub.id, 'email', true, 'sent');
  } catch (err) {
    await logDelivery(sub.id, 'email', false, err.message);
  }
}

async function sendSlack(sub) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return; // Slack is optional; silence, not an error row.
  const title = TITLES[sub.type] || 'New website submission';
  const fields = lines(sub).slice(0, 12).map(([k, v]) => `*${k}:* ${v}`).join('\n');
  const body = {
    text: `${title} (#${sub.id})`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title } },
      { type: 'section', text: { type: 'mrkdwn', text: fields || '_no fields_' } },
    ],
  };
  if (process.env.ADMIN_URL) {
    body.blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${process.env.ADMIN_URL}|Open dashboard> · #${sub.id}` }] });
  }
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await logDelivery(sub.id, 'slack', res.ok, res.ok ? 'sent' : `HTTP ${res.status}`);
  } catch (err) {
    await logDelivery(sub.id, 'slack', false, err.message);
  }
}

// Fire both without blocking the caller's response.
function notify(sub) {
  Promise.allSettled([sendEmail(sub), sendSlack(sub)]).catch(() => {});
}

// --- Carrier-portal notifications ------------------------------------------
// Generic staff alert (email to MAIL_TO + Slack), used for portal events like a
// new carrier registration or a document upload. `fields` is [[label, value]].
async function staffAlert(title, fields) {
  const rowsHtml = (fields || []).map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:4px 0">${esc(v)}</td></tr>`).join('');
  const t = mailer();
  if (t) {
    try {
      await t.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: process.env.MAIL_TO,
        subject: title,
        text: title + '\n\n' + (fields || []).map(([k, v]) => `${k}: ${v}`).join('\n'),
        html: `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;color:#111">` +
          `<h2 style="margin:0 0 12px">${esc(title)}</h2><table style="border-collapse:collapse">${rowsHtml}</table>` +
          (process.env.ADMIN_URL ? `<p style="margin-top:16px"><a href="${esc(process.env.ADMIN_URL)}/carriers">Open carriers →</a></p>` : '') +
          `</div>`,
      });
    } catch (_) { /* best-effort */ }
  }
  const url = process.env.SLACK_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: title,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: title } },
            { type: 'section', text: { type: 'mrkdwn', text: (fields || []).map(([k, v]) => `*${k}:* ${v}`).join('\n') || '_no detail_' } },
          ],
        }),
      });
    } catch (_) { /* best-effort */ }
  }
}

// Email a carrier directly — used when staff change their onboarding status.
async function carrierEmail(to, subject, paragraphs) {
  const t = mailer();
  if (!t || !to) return;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;color:#111;line-height:1.5">` +
    (paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('') +
    `<p style="color:#888;margin-top:20px">BSG Carriers — U.S. Truck Dispatching</p></div>`;
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to, subject,
      text: (paragraphs || []).join('\n\n') + '\n\nBSG Carriers',
      html,
    });
  } catch (_) { /* best-effort */ }
}

module.exports = { notify, sendEmail, sendSlack, staffAlert, carrierEmail };
