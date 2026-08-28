'use strict';

// Server-side validation for the public /leads endpoint.
//
// The browser forms already validate, but a public endpoint must assume the
// browser was bypassed. Everything here runs regardless of what the client did:
// the honeypot, length caps (so a giant paste cannot bloat the DB or an email),
// and a light shape check that still accepts the two different form field sets.

const { z } = require('zod');

// Generous caps — long enough for any real answer, short enough to stop abuse.
const short = z.string().trim().max(200).optional().or(z.literal(''));
const line = z.string().trim().max(400).optional().or(z.literal(''));
const long = z.string().trim().max(5000).optional().or(z.literal(''));

// The forms post human-readable field names (e.g. "Full name", "MC number") —
// see FormKit / the form components. We accept those verbatim and also tolerate
// their absence, because contact and onboarding submit different subsets.
const leadSchema = z.object({
  'Full name': short,
  'Company name': short,
  'Email': z.string().trim().max(200).email().optional().or(z.literal('')),
  'Email address': z.string().trim().max(200).email().optional().or(z.literal('')),
  'Phone': short,
  'Phone number': short,
  'Reason': line,
  'Message': long,
  'MC number': short,
  'DOT number': short,
  'Truck / equipment type': short,
  'Number of trucks': short,
  'Current location': short,
  'Preferred lanes': line,
  'How did you hear about us?': line,
  'Additional message': long,
  'Authority and insurance confirmed': short,
}).passthrough(); // keep any extra field the form adds later, still capped below

// Fields we never store even if posted — control values, not lead data.
const DROP = new Set(['botcheck', 'access_key', 'subject', 'from_name', 'type']);

const MAX_FIELDS = 40;
const MAX_VALUE = 5000;

/**
 * Validate and normalise a raw form body.
 * @returns {{ok:true, type, data}} | {ok:false, code, error}
 */
function validateLead(body, declaredType) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'bad_request', error: 'Missing form data.' };
  }

  // Honeypot: a real person never fills the hidden `botcheck` field. Treat any
  // value as a bot and reject — but with a 200-shaped success upstream so the
  // bot gets no signal it was caught (handled in the route).
  if (typeof body.botcheck === 'string' && body.botcheck.trim() !== '') {
    return { ok: false, code: 'spam', error: 'Rejected.' };
  }

  if (Object.keys(body).length > MAX_FIELDS) {
    return { ok: false, code: 'bad_request', error: 'Too many fields.' };
  }
  for (const v of Object.values(body)) {
    if (typeof v === 'string' && v.length > MAX_VALUE) {
      return { ok: false, code: 'bad_request', error: 'A field is too long.' };
    }
  }

  const parsed = leadSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, code: 'invalid', error: firstIssue(parsed.error) };
  }

  // Onboarding is identified by the fields only it carries; otherwise contact.
  const type = normaliseType(declaredType, body);

  // A submission must carry at least a name or an email or a phone, or it is noise.
  const name = pick(body, 'Full name');
  const email = pick(body, 'Email', 'Email address');
  const phone = pick(body, 'Phone', 'Phone number');
  if (!name && !email && !phone) {
    return { ok: false, code: 'invalid', error: 'Please add a name, email or phone.' };
  }

  const data = {};
  for (const [k, v] of Object.entries(body)) {
    if (DROP.has(k)) continue;
    data[k] = typeof v === 'string' ? v.trim() : v;
  }

  return {
    ok: true,
    type,
    data,
    columns: {
      full_name: name || null,
      company: pick(body, 'Company name') || null,
      email: email || null,
      phone: phone || null,
      mc_number: pick(body, 'MC number') || null,
      dot_number: pick(body, 'DOT number') || null,
      equipment: pick(body, 'Truck / equipment type') || null,
      message: pick(body, 'Message', 'Additional message') || null,
    },
  };
}

function normaliseType(declared, body) {
  const d = String(declared || '').toLowerCase();
  if (d.includes('onboard') || d.includes('carrier onboarding')) return 'onboarding';
  if (d === 'contact' || d.includes('contact') || d.includes('enquiry')) return 'contact';
  // Fall back to field-shape: MC/DOT means an onboarding application.
  if (pick(body, 'MC number') || pick(body, 'DOT number')) return 'onboarding';
  return 'contact';
}

function pick(body, ...keys) {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

function firstIssue(err) {
  const i = err.issues && err.issues[0];
  if (!i) return 'Please check the form and try again.';
  const field = i.path && i.path.length ? i.path.join(' ') + ': ' : '';
  return field + i.message;
}

module.exports = { validateLead };
